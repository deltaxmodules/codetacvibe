// Edges of the graph (phase 2): imports between project files (with the
// names each import takes, phase 8), and the
// aggregated edges between blocks derived from them. Every edge carries the
// file and line that prove it; an aggregated edge counts the links it stands
// for and keeps the first proofs (sorted), so a large project stays small.
const MAX_AGGREGATED_PROOFS = 20;
const byProof = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// One `imports` edge per pair of project files, with a proof per import line.
// A file importing itself is left out.
export function importEdges(modules) {
  const edges = new Map();
  for (const [path, module] of modules) {
    for (const item of module.imports) {
      if (!item.target || item.target === path) continue;
      const id = `imports:file:${path}->file:${item.target}`;
      if (!edges.has(id)) edges.set(id, { id, kind: 'imports', from: `file:${path}`, to: `file:${item.target}`, origin: 'static', proof: [], names: new Set() });
      const edge = edges.get(id);
      if (!edge.proof.some(entry => entry.line === item.line)) edge.proof.push({ file: path, line: item.line });
      // The names taken (phase 8, unused exports); require() and import() take them all.
      for (const name of item.names?.length ? item.names : ['*']) edge.names.add(name);
    }
  }
  return [...edges.values()].map(edge => ({ ...edge, proof: edge.proof.sort(byProof), names: [...edge.names].sort() }));
}

// Edges between blocks: one per kind and pair of different blocks, counting the
// file-level edges behind it. `blockOf` maps a node id to its block id (or null).
export function blockEdges(edges, blockOf) {
  const aggregated = new Map();
  for (const edge of edges) {
    const from = blockOf(edge.from);
    const to = blockOf(edge.to);
    if (!from || !to || from === to) continue;
    const id = `${edge.kind}:${from}->${to}`;
    if (!aggregated.has(id)) aggregated.set(id, { id, kind: edge.kind, from, to, origin: 'static', count: 0, proof: [] });
    const item = aggregated.get(id);
    item.count += 1;
    item.proof.push(...edge.proof);
  }
  return [...aggregated.values()].map(item => ({ ...item, proof: item.proof.sort(byProof).slice(0, MAX_AGGREGATED_PROOFS) }));
}
