// The «Changes» view (phase 9, step 4): the plan with what was added,
// removed or changed since a snapshot marked on it, and the sentences of the
// summary. The plan is drawn from the union of both versions (the graph of
// now plus what was removed), so a removed file still has its box, marked as
// removed. Nothing is stored; all comes from the two graphs.
import { planView } from './plan.mjs';
import { diffGraphs, stableSymbolIds, SECTIONS } from './diff.mjs';
import { changeSummary } from './summary.mjs';
import { comparePrediction } from './predict.mjs';

const BOXED = new Set(['block', 'file', 'symbol', 'route']);

// The graph of now, plus the nodes and links that were removed. Returns
// { graph, status: Map(id → added | removed | changed | moved), edgeStatus }.
export function unionGraph(before, after, diff) {
  const nodes = new Map(after.nodes.map(node => [node.id, node]));
  // A stable id (symbol:a.js#f) → the id of now (symbol:a.js#f@14).
  const now = new Map([...stableSymbolIds(after)].map(([id, stable]) => [stable, id]));
  const current = stable => now.get(stable) ?? (nodes.has(stable) ? stable : null);
  const status = new Map();
  const edgeStatus = new Map();
  for (const section of SECTIONS) {
    for (const item of diff[section].added) (item.from ? edgeStatus : status).set(item.id, 'added');
    for (const item of diff[section].changed) if (!item.before.from) status.set(item.id, 'changed');
  }
  for (const item of diff.files.renamed) status.set(item.node.id, 'moved');
  const added = [];
  for (const section of SECTIONS) {
    for (const item of diff[section].removed) {
      if (item.from || nodes.has(item.id)) continue;
      const { stableId, ...node } = item;
      nodes.set(node.id, node);
      added.push(node);
      status.set(node.id, 'removed');
    }
  }
  const edges = [...after.edges];
  for (const section of ['blockEdges', 'links']) {
    for (const item of diff[section].removed) {
      const { stableId, fromStable, toStable, ...edge } = item;
      const from = current(fromStable) ?? edge.from;
      const to = current(toStable) ?? edge.to;
      const id = `removed:${edge.id}`;
      edges.push({ ...edge, id, from, to });
      edgeStatus.set(id, 'removed');
    }
  }
  return { graph: { ...after, nodes: [...after.nodes, ...added], edges }, status, edgeStatus };
}

// changesView(before, after, { expanded, prediction }) → { total, counts, sentences, plan, touchedBlocks, prediction? }
// (prediction: the one saved with the snapshot, compared with what changed — phase 10)
// Each sentence also has boxes (the ids of the plan it is about, with their
// file and block, for the filter) and target { id, open } (what to open and
// light to show it).
// The boxes of the plan each sentence is about (phase D3: the Diff's report
// lights them on its map): sentences with boxes and target added. The union
// of the two graphs, so what was removed has its box too.
export function sentenceBoxes(before, after, sentences, diff = diffGraphs(before, after)) {
  const { graph } = unionGraph(before, after, diff);
  return describe(graph, sentences).described;
}

function describe(graph, sentences) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const routeFile = new Map();
  for (const edge of graph.edges) if (edge.kind === 'exposes' && nodes.get(edge.to)?.kind === 'route' && !routeFile.has(edge.to)) routeFile.set(edge.to, edge.from);
  const fileOf = node => (node.kind === 'file' ? node.id : node.kind === 'symbol' ? node.file : node.kind === 'route' ? routeFile.get(node.id) : null);
  // A node, its file and its block: the boxes that stand for it at each level.
  const chain = id => {
    const node = nodes.get(id);
    if (!node || !BOXED.has(node.kind)) return [];
    if (node.kind === 'block') return [id];
    const file = nodes.get(fileOf(node));
    if (!file) return [];
    return node.kind === 'file' ? [file.block, id] : [file.block, file.id, id];
  };
  const described = sentences.map(sentence => {
    const boxes = new Set();
    let target = null;
    for (const id of sentence.ids) {
      const ids = chain(id);
      for (const box of ids) boxes.add(box);
      if (!target && ids.length) target = { id: ids[ids.length - 1], open: ids.slice(0, -1) };
    }
    return { ...sentence, boxes: [...boxes], target };
  });
  return { nodes, chain, described };
}

export function changesView(before, after, { expanded = [], prediction = null } = {}) {
  const diff = diffGraphs(before, after);
  const sentences = changeSummary(diff, before, after);
  const { graph, status, edgeStatus } = unionGraph(before, after, diff);
  const { nodes, chain, described } = describe(graph, sentences);
  // Boxes with something changed inside (a function of a file, a file of a block).
  const inside = new Set();
  const touch = id => { for (const box of chain(id).slice(0, -1)) inside.add(box); };
  for (const id of status.keys()) touch(id);
  const edgeById = new Map(graph.edges.map(edge => [edge.id, edge]));
  for (const id of edgeStatus.keys()) {
    const edge = edgeById.get(id);
    if (!edge) continue;
    for (const end of [edge.from, edge.to]) { touch(end); if (nodes.get(end)?.kind === 'file' || nodes.get(end)?.kind === 'symbol') inside.add(chain(end)[0]); }
  }
  const plan = planView(graph, { expanded, edgeStatus });
  for (const box of plan.boxes) {
    const change = status.get(box.id) ?? (inside.has(box.id) ? 'inside' : null);
    if (change) box.change = change;
  }
  const counts = { alert: 0, warning: 0, info: 0, touching: 0 };
  for (const sentence of sentences) { counts[sentence.severity] += 1; if (sentence.touches.length) counts.touching += 1; }
  const touchedBlocks = plan.boxes.filter(box => box.kind === 'block' && box.change).map(box => box.id);
  return { total: diff.total, counts, sentences: described, plan, touchedBlocks,
    ...(prediction ? { prediction: { ...comparePrediction(prediction, diff, before, after), predicted: prediction } } : {}) };
}
