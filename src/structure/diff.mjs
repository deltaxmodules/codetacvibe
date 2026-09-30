// The difference between two graphs of the same project (phase 9, step 2):
// what was added, removed or changed in files, blocks, the arrows between
// blocks, the links between files and functions, external services,
// variables, tables (and their columns) and routes. Rules only, no AI.
//
// Without noise: a function's id holds its line (symbol:lib/a.js#run@12), so
// a line added at the top of a file would rename every function below it.
// Before comparing, a function is named by its file and name only (the
// second function of the same name in a file gets ~2, in line order); the
// arrows are renamed the same way. Proofs (file and line) never make a change
// on their own: they move with every edit. A file whose content changed is
// "changed", never removed and added; a file moved with the same content is
// "renamed".

const SYMBOL = /^symbol:(.*)#([^#@]+)@(\d+)$/;

// Fields compared for each kind of node and for arrows; everything else
// (proofs, sizes that follow the content, origin) is left out.
const NODE_FIELDS = {
  file: ['hash', 'block', 'runsOn', 'language'],
  block: ['layer'],
  symbol: ['symbolKind', 'exported', 'exportedAs'],
  service: ['name', 'category', 'destination'],
  env: ['public', 'secretLike'],
  table: ['store', 'inferred', 'source', 'rls'],
  route: [],
};
const EDGE_FIELDS = ['count', 'runsOn', 'confidence', 'operations', 'names'];
const COLUMN_FIELDS = ['type', 'primaryKey', 'nullable', 'unique', 'references'];

// The sections of a diff, in the order they are shown.
export const SECTIONS = ['files', 'blocks', 'blockEdges', 'links', 'services', 'env', 'tables', 'routes', 'symbols'];
const SECTION_OF_KIND = { file: 'files', block: 'blocks', service: 'services', env: 'env', table: 'tables', route: 'routes', symbol: 'symbols' };

// A stable id for every symbol of a graph: Map(old id → stable id).
export function stableSymbolIds(graph) {
  const groups = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== 'symbol') continue;
    const match = SYMBOL.exec(node.id);
    const base = match ? `symbol:${match[1]}#${match[2]}` : node.id;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(node);
  }
  const ids = new Map();
  for (const [base, nodes] of groups) {
    nodes.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    nodes.forEach((node, index) => ids.set(node.id, index ? `${base}~${index + 1}` : base));
  }
  return ids;
}

// Plain value comparison, independent of key order.
function same(a, b) {
  return stable(a) === stable(b);
}
function stable(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => key !== 'proof' && value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fieldChanges(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    if (!same(before[field], after[field])) changes.push({ field, before: before[field] ?? null, after: after[field] ?? null });
  }
  return changes;
}

function columnChanges(before = [], after = []) {
  const old = new Map(before.map(column => [column.name, column]));
  const now = new Map(after.map(column => [column.name, column]));
  const added = after.filter(column => !old.has(column.name)).map(column => column.name);
  const removed = before.filter(column => !now.has(column.name)).map(column => column.name);
  const changed = [];
  for (const [name, column] of now) {
    const was = old.get(name);
    if (!was) continue;
    const fields = fieldChanges(was, column, COLUMN_FIELDS);
    if (fields.length) changed.push({ name, fields });
  }
  return added.length || removed.length || changed.length ? { added, removed, changed } : null;
}

// A graph with stable ids: nodes by stable id, arrows by stable id (the kind
// and the stable ids of both ends), keeping the graph's own ids.
function index(graph) {
  const symbols = stableSymbolIds(graph);
  const rename = id => symbols.get(id) ?? id;
  const nodes = new Map();
  for (const node of graph.nodes) nodes.set(rename(node.id), node);
  const edges = new Map();
  for (const edge of graph.edges) {
    const from = rename(edge.from);
    const to = rename(edge.to);
    edges.set(`${edge.kind}:${from}->${to}`, { edge, from, to });
  }
  return { nodes, edges };
}

const emptySection = () => ({ added: [], removed: [], changed: [] });
const isBlockEdge = ({ from, to }) => from.startsWith('block:') && to.startsWith('block:');

// diffGraphs(before, after) → {
//   project: { typesAdded, typesRemoved },
//   files | blocks | blockEdges | links | services | env | tables | routes | symbols:
//     { added: [item], removed: [item], changed: [{ id, before, after, fields: [{ field, before, after }], columns? }] }
//     (files also have renamed: [{ from, to, node }]),
//   notes: { added, removed },
//   total: how many things changed (0: the same structure)
// }
// An item is the node or arrow as the graph has it (with its proof: the new
// graph's for what was added, the old one's for what was removed), plus its
// stable id; an arrow also has fromStable and toStable.
export function diffGraphs(before, after) {
  const old = index(before);
  const now = index(after);
  const result = { project: { typesAdded: [], typesRemoved: [] } };
  for (const section of SECTIONS) result[section] = emptySection();
  result.files.renamed = [];

  const typesBefore = new Set(before.project?.types ?? []);
  const typesAfter = new Set(after.project?.types ?? []);
  result.project.typesAdded = [...typesAfter].filter(type => !typesBefore.has(type)).sort();
  result.project.typesRemoved = [...typesBefore].filter(type => !typesAfter.has(type)).sort();

  for (const [id, node] of now.nodes) {
    const section = result[SECTION_OF_KIND[node.kind]];
    if (!section) continue;
    const was = old.nodes.get(id);
    if (!was) { section.added.push({ ...node, stableId: id }); continue; }
    const fields = fieldChanges(was, node, NODE_FIELDS[node.kind] ?? []);
    const columns = node.kind === 'table' ? columnChanges(was.columns, node.columns) : null;
    if (fields.length || columns) section.changed.push({ id: node.id, stableId: id, before: was, after: node, fields, ...(columns ? { columns } : {}) });
  }
  for (const [id, node] of old.nodes) {
    const section = result[SECTION_OF_KIND[node.kind]];
    if (section && !now.nodes.has(id)) section.removed.push({ ...node, stableId: id });
  }

  // A file removed and one added with the same content: moved (or renamed).
  const removedByHash = new Map();
  for (const file of result.files.removed) if (file.hash && !removedByHash.has(file.hash)) removedByHash.set(file.hash, file);
  result.files.added = result.files.added.filter(file => {
    const source = removedByHash.get(file.hash);
    if (!source) return true;
    removedByHash.delete(file.hash);
    result.files.renamed.push({ from: source.path, to: file.path, node: file, before: source });
    return false;
  });
  const moved = new Set(result.files.renamed.map(item => item.before.id));
  result.files.removed = result.files.removed.filter(file => !moved.has(file.id));

  for (const [id, item] of now.edges) {
    const section = result[isBlockEdge(item) ? 'blockEdges' : 'links'];
    const was = old.edges.get(id);
    if (!was) { section.added.push({ ...item.edge, stableId: id, fromStable: item.from, toStable: item.to }); continue; }
    const fields = fieldChanges(was.edge, item.edge, EDGE_FIELDS);
    if (fields.length) section.changed.push({ id: item.edge.id, stableId: id, before: was.edge, after: item.edge, fields });
  }
  for (const [id, item] of old.edges) {
    if (now.edges.has(id)) continue;
    result[isBlockEdge(item) ? 'blockEdges' : 'links'].removed.push({ ...item.edge, stableId: id, fromStable: item.from, toStable: item.to });
  }

  // Notes by what they say (and their kind), not by where.
  const noteKey = note => `${note.kind ?? ''}\n${note.message}`;
  const notesBefore = new Map((before.notes ?? []).map(note => [noteKey(note), note]));
  const notesAfter = new Map((after.notes ?? []).map(note => [noteKey(note), note]));
  result.notes = {
    added: [...notesAfter].filter(([key]) => !notesBefore.has(key)).map(([, note]) => note),
    removed: [...notesBefore].filter(([key]) => !notesAfter.has(key)).map(([, note]) => note),
  };

  const byStable = (a, b) => (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0);
  let total = result.project.typesAdded.length + result.project.typesRemoved.length + result.files.renamed.length
    + result.notes.added.length + result.notes.removed.length;
  for (const section of SECTIONS) {
    for (const list of ['added', 'removed', 'changed']) {
      result[section][list].sort(byStable);
      total += result[section][list].length;
    }
  }
  result.files.renamed.sort((a, b) => (a.to < b.to ? -1 : 1));
  result.total = total;
  return result;
}
