// Checks of a StructureTAC graph that JSON Schema cannot express: ids are
// unique, edges and references point to nodes that exist, and every proof
// points to a line of a file in the graph (so it can always be opened).
// Returns a list of readable problems; empty means the graph holds together.
// The shape itself is checked against graph.schema.json (by the tests and
// the structure test command).

export function checkGraph(graph) {
  const problems = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const byId = new Map();
  for (const item of [...nodes, ...edges]) {
    if (byId.has(item.id)) problems.push(`Id "${item.id}" is used more than once.`);
    else byId.set(item.id, item);
  }
  const files = new Map(nodes.filter(node => node.kind === 'file').map(node => [node.path, node]));
  const nodeSet = new Set(nodes);
  const expect = (id, kind, where) => {
    const target = byId.get(id);
    if (!target || !nodeSet.has(target)) problems.push(`${where} points to "${id}", which is not a node.`);
    else if (kind && target.kind !== kind) problems.push(`${where} points to "${id}", a ${target.kind}, not a ${kind}.`);
    return target;
  };
  const proofs = (list, where) => {
    for (const proof of list ?? []) {
      const file = files.get(proof.file);
      if (!file) problems.push(`${where}: proof file "${proof.file}" is not a file of the graph.`);
      else if (file.lines > 0 && proof.line > file.lines) problems.push(`${where}: proof line ${proof.line} is past the end of ${proof.file} (${file.lines} lines).`);
      if (proof.endLine != null && proof.endLine < proof.line) problems.push(`${where}: proof ends (line ${proof.endLine}) before it starts (line ${proof.line}).`);
    }
  };
  for (const node of nodes) {
    const where = `${node.kind} "${node.id}"`;
    proofs(node.proof, where);
    for (const column of node.kind === 'table' ? node.columns ?? [] : []) proofs(column.proof, `${where} column "${column.name}"`);
    if (node.kind === 'table' && node.rls) proofs(node.rls.proof, `${where} row level security`);
    if (node.kind === 'file') expect(node.block, 'block', `${where} (block)`);
    if (node.kind === 'symbol') {
      const file = expect(node.file, 'file', `${where} (file)`);
      if (file?.kind === 'file' && node.key !== `${file.path}#${node.name}@${node.line}`) {
        problems.push(`${where}: key "${node.key}" should be "${file.path}#${node.name}@${node.line}".`);
      }
    }
  }
  for (const edge of edges) {
    const where = `${edge.kind} edge "${edge.id}"`;
    expect(edge.from, null, `${where} (from)`);
    expect(edge.to, null, `${where} (to)`);
    proofs(edge.proof, where);
  }
  (graph?.notes ?? []).forEach((note, index) => proofs(note.proof, `note ${index + 1}`));
  return problems;
}
