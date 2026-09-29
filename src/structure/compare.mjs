// Compares the graph a reader produced with the expected one (the fixtures'
// expected-structure.json) and lists the differences in plain sentences.
// Nodes are matched by id (the id conventions are part of the contract), edges
// by kind, from and to. Aggregated edges between blocks are derived, so they
// are not compared. Proofs: every expected proof must be there; extra proofs
// are listed as notes, not failures.

const FIELDS = {
  file: ['block', 'runsOn', 'language', 'size', 'lines', 'hash'],
  symbol: ['file', 'symbolKind', 'line', 'exported', 'key'],
  block: ['layer'],
  service: ['category', 'destination'],
  table: ['store', 'inferred', 'source', 'columns', 'rls'],
  env: ['public', 'secretLike'],
  route: ['method', 'path'],
};
const EDGE_FIELDS = ['runsOn', 'confidence'];

// What each phase compares: the node kinds and edge kinds it produces (an
// edge also needs both of its ends in scope). Each scope includes the ones
// before it; `all` is everything.
const PLAN = { nodes: ['file', 'block', 'symbol', 'route'], edges: ['imports', 'exposes', 'calls'] };
const LEAKS = { nodes: [...PLAN.nodes, 'service'], edges: [...PLAN.edges, 'sends-data-to'] };
const SECRETS = { nodes: [...LEAKS.nodes, 'env'], edges: [...LEAKS.edges, 'reads', 'uses-secret'] };
const DATA = { nodes: [...SECRETS.nodes, 'table'], edges: [...SECRETS.edges, 'writes'] };
export const SCOPES = {
  inventory: { nodes: ['file', 'block'], edges: [] },
  plan: PLAN,
  leaks: LEAKS,
  secrets: SECRETS,
  data: DATA,
  all: { nodes: DATA.nodes, edges: [...DATA.edges, 'observed'] },
};

function inScope(graph, scope) {
  const nodes = (graph?.nodes ?? []).filter(node => scope.nodes.includes(node.kind));
  const ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: (graph?.edges ?? []).filter(edge => scope.edges.includes(edge.kind) && ids.has(edge.from) && ids.has(edge.to)) };
}

const show = value => (value === undefined ? '(none)' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const proofKey = proof => `${proof.file}:${proof.line}`;
const edgeKey = edge => `${edge.kind} ${edge.from} → ${edge.to}`;
const isBlockEdge = (edge, nodes) => nodes.get(edge.from)?.kind === 'block' && nodes.get(edge.to)?.kind === 'block';

function proofs(where, expected, actual, failures, notes) {
  const got = new Set((actual ?? []).map(proofKey));
  const wanted = new Set((expected ?? []).map(proofKey));
  for (const key of wanted) if (!got.has(key)) failures.push(`${where}: proof ${key} is missing.`);
  for (const key of got) if (!wanted.has(key)) notes.push(`${where}: extra proof ${key}.`);
}

export function compareGraphs(expectedGraph, actualGraph, { scope = 'all' } = {}) {
  if (!SCOPES[scope]) throw new Error(`Unknown scope ${scope}. Known: ${Object.keys(SCOPES).join(', ')}`);
  const expected = inScope(expectedGraph, SCOPES[scope]);
  const actual = inScope(actualGraph, SCOPES[scope]);
  const failures = [];
  const notes = [];
  const wantedNodes = new Map(expected.nodes.map(node => [node.id, node]));
  const gotNodes = new Map((actual?.nodes ?? []).map(node => [node.id, node]));

  for (const [id, want] of wantedNodes) {
    const got = gotNodes.get(id);
    const label = want.kind === 'file' ? want.path : id;
    if (!got) { failures.push(`Missing ${want.kind}: ${label}.`); continue; }
    if (got.kind !== want.kind) { failures.push(`${label}: is a ${got.kind}, expected a ${want.kind}.`); continue; }
    for (const field of FIELDS[want.kind] ?? []) {
      if (show(got[field]) === show(want[field])) continue;
      const rule = want.kind === 'file' && field === 'block' && got.rule ? ` (rule ${got.rule})` : '';
      failures.push(`${label}: ${field} is ${show(got[field])}${rule}, expected ${show(want[field])}.`);
    }
    proofs(label, want.proof, got.proof, failures, notes);
  }
  for (const [id, got] of gotNodes) {
    if (!wantedNodes.has(id)) failures.push(`Unexpected ${got.kind}: ${got.kind === 'file' ? got.path : id}.`);
  }

  const wantedEdges = new Map(expected.edges.filter(edge => !isBlockEdge(edge, wantedNodes)).map(edge => [edgeKey(edge), edge]));
  const gotEdges = new Map((actual?.edges ?? []).filter(edge => !isBlockEdge(edge, gotNodes)).map(edge => [edgeKey(edge), edge]));
  for (const [key, want] of wantedEdges) {
    const got = gotEdges.get(key);
    if (!got) { failures.push(`Missing edge: ${key}.`); continue; }
    for (const field of EDGE_FIELDS) {
      if (show(got[field]) !== show(want[field])) failures.push(`Edge ${key}: ${field} is ${show(got[field])}, expected ${show(want[field])}.`);
    }
    proofs(`Edge ${key}`, want.proof, got.proof, failures, notes);
  }
  for (const key of gotEdges.keys()) if (!wantedEdges.has(key)) failures.push(`Unexpected edge: ${key}.`);

  const files = [...gotNodes.values()].filter(node => node.kind === 'file');
  const unknown = files.filter(node => node.block === 'block:unknown').length;
  return { failures, notes, unknownShare: files.length ? unknown / files.length : 0 };
}
