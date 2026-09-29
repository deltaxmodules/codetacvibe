// The floor plan of a project (phase 2, step 5): boxes laid out in layers and
// the arrows between them, for the level of detail the user opened. Pure and
// deterministic: the same graph with the same boxes open gives the same plan,
// to the pixel. The browser only draws it.
//
// Levels (semantic zoom): the project starts collapsed (one box per block);
// opening a block shows its files; opening a file shows its functions and
// routes. An arrow joins the innermost open boxes of its two ends and counts
// the links behind it.

// Rows, top to bottom. The main layers first, the supporting ones side by side
// in the last row.
export const ROWS = [['interface'], ['routes'], ['logic'], ['data'], ['external'], ['utilities', 'config', 'tests', 'unknown']];
const ARROW_KINDS = new Set(['imports', 'calls', 'sends-data-to', 'reads', 'writes', 'observed']);
const MAX_ARROW_PROOFS = 5;

const SIZE = {
  gap: 24, rowGap: 56, pad: 12, header: 32,
  block: { w: 220, h: 64 },
  file: { w: 200, h: 34 },
  item: { h: 22 },
  columns: 6,
};

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byProof = (a, b) => byText(a.file, b.file) || a.line - b.line;

// trace (phase 7): { nodes, edges, inferred, observed } of an action; the
// boxes and arrows it went through are marked lit, the observed arrows join
// the plan. covered (optional): the edge ids any action of the session went
// through, to mark the static arrows that never ran.
export function planView(graph, { expanded = [], trace = null, covered = null } = {}) {
  const open = new Set(expanded);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const files = graph.nodes.filter(node => node.kind === 'file').sort((a, b) => byText(a.path, b.path));
  const blocks = new Map(graph.nodes.filter(node => node.kind === 'block').map(node => [node.id, node]));

  // What lives inside each file: its symbols, and the routes it exposes.
  const inside = new Map(files.map(file => [file.id, []]));
  for (const node of graph.nodes) if (node.kind === 'symbol' && inside.has(node.file)) inside.get(node.file).push(node);
  const routeFile = new Map();
  for (const edge of graph.edges) {
    if (edge.kind === 'exposes' && inside.has(edge.from) && nodes.get(edge.to)?.kind === 'route' && !routeFile.has(edge.to)) {
      routeFile.set(edge.to, edge.from);
      inside.get(edge.from).push(nodes.get(edge.to));
    }
  }
  for (const list of inside.values()) list.sort((a, b) => (a.kind === 'route') - (b.kind === 'route') || (a.line ?? 0) - (b.line ?? 0) || byText(a.id, b.id));

  // The box that stands for a node at the current level.
  const fileOf = node => (node.kind === 'file' ? node.id : node.kind === 'symbol' ? node.file : node.kind === 'route' ? routeFile.get(node.id) : null);
  const visible = id => {
    const node = nodes.get(id);
    if (!node) return null;
    if (node.kind === 'block') return id;
    const fileId = fileOf(node);
    if (!fileId) return null;
    const block = nodes.get(fileId).block;
    if (!open.has(block)) return block;
    if (node.kind === 'file' || !open.has(fileId)) return fileId;
    return id;
  };

  // Boxes, row by row.
  const boxes = [];
  let y = 0;
  let width = 0;
  const rowsDone = [];
  for (const row of ROWS) {
    let x = 0;
    let rowHeight = 0;
    const firstBox = boxes.length;
    for (const layer of row) {
      const block = blocks.get(`block:${layer}`);
      if (!block) continue;
      const members = files.filter(file => file.block === block.id);
      const box = { id: block.id, kind: 'block', layer, label: block.name, count: members.length, x, y, expandable: members.length > 0, expanded: open.has(block.id) };
      if (!box.expanded) Object.assign(box, SIZE.block);
      else {
        // Files in a grid (sorted by path, so folders stay together).
        const columns = Math.max(1, Math.min(SIZE.columns, Math.ceil(Math.sqrt(members.length))));
        const children = members.map(file => {
          const items = inside.get(file.id);
          const expandedFile = open.has(file.id);
          return { id: file.id, kind: 'file', layer, label: file.name, path: file.path, parent: block.id, count: items.length,
            expandable: items.length > 0, expanded: expandedFile, w: SIZE.file.w, h: SIZE.file.h + (expandedFile ? items.length * SIZE.item.h + SIZE.pad / 2 : 0), items };
        });
        let cy = y + SIZE.header;
        let innerWidth = 0;
        for (let start = 0; start < children.length; start += columns) {
          const line = children.slice(start, start + columns);
          let cx = x + SIZE.pad;
          for (const child of line) { child.x = cx; child.y = cy; cx += child.w + SIZE.gap / 2; }
          innerWidth = Math.max(innerWidth, cx - SIZE.gap / 2 - x - SIZE.pad);
          cy += Math.max(...line.map(child => child.h)) + SIZE.gap / 2;
        }
        box.w = Math.max(SIZE.block.w, innerWidth + SIZE.pad * 2);
        box.h = Math.max(SIZE.block.h, cy - y - SIZE.gap / 2 + SIZE.pad);
        boxes.push(box);
        for (const child of children) {
          const { items, ...fileBox } = child;
          boxes.push(fileBox);
          if (!child.expanded) continue;
          items.forEach((item, index) => boxes.push({
            id: item.id, kind: item.kind, layer, parent: child.id, label: item.name,
            ...(item.kind === 'symbol' ? { symbolKind: item.symbolKind, line: item.line } : { method: item.method, path: item.path }),
            x: child.x + SIZE.pad / 2, y: child.y + SIZE.file.h + index * SIZE.item.h, w: child.w - SIZE.pad, h: SIZE.item.h - 2,
          }));
        }
        x += box.w + SIZE.gap;
        rowHeight = Math.max(rowHeight, box.h);
        continue;
      }
      boxes.push(box);
      x += box.w + SIZE.gap;
      rowHeight = Math.max(rowHeight, box.h);
    }
    if (!rowHeight) continue;
    width = Math.max(width, x - SIZE.gap);
    rowsDone.push({ firstBox, lastBox: boxes.length, width: x - SIZE.gap });
    y += rowHeight + SIZE.rowGap;
  }
  // Each row centred on the widest one.
  for (const row of rowsDone) {
    const shift = Math.floor((width - row.width) / 2);
    for (let index = row.firstBox; index < row.lastBox; index++) boxes[index].x += shift;
  }

  // Arrows between the visible boxes, from the file-level edges (the block
  // edges of the graph are the same links, already aggregated).
  const arrows = new Map();
  const litEdges = new Set(trace?.edges ?? []);
  const inferredEdges = new Set(trace?.inferred ?? []);
  const coveredEdges = covered ? new Set(covered) : null;
  for (const edge of [...graph.edges, ...(trace?.observed ?? [])]) {
    if (!ARROW_KINDS.has(edge.kind) || nodes.get(edge.from)?.kind === 'block') continue;
    const from = visible(edge.from);
    const to = visible(edge.to);
    if (!from || !to || from === to) continue;
    const id = `${from}->${to}`;
    if (!arrows.has(id)) arrows.set(id, { id, from, to, count: 0, kinds: {}, proof: [], runsOn: new Set(), certain: false, lit: false, inferred: false, ran: false });
    const arrow = arrows.get(id);
    if (litEdges.has(edge.id) || edge.kind === 'observed') arrow.lit = true;
    if (inferredEdges.has(edge.id)) arrow.inferred = true;
    if (coveredEdges?.has(edge.id) || edge.kind === 'observed') arrow.ran = true;
    arrow.count += 1;
    arrow.kinds[edge.kind] = (arrow.kinds[edge.kind] ?? 0) + 1;
    arrow.proof.push(...edge.proof);
    if (edge.runsOn) arrow.runsOn.add(edge.runsOn);
    if (edge.confidence !== 'possible') arrow.certain = true;
  }
  const arrowList = [...arrows.values()].sort((a, b) => byText(a.id, b.id)).map(({ runsOn, certain, proof, lit, inferred, ran, ...arrow }) => ({
    ...arrow,
    ...(trace ? { lit, ...(inferred && !lit ? { inferred: true } : {}) } : {}),
    ...(coveredEdges ? { ran } : {}),
    proof: [...new Map(proof.map(item => [`${item.file}:${item.line}`, item])).values()].sort(byProof).slice(0, MAX_ARROW_PROOFS),
    ...(runsOn.size ? { runsOn: [...runsOn].sort().join('+') } : {}),
    ...(certain ? {} : { confidence: 'possible' }),
  }));

  // Boxes the action went through: each lit node lights the box that stands for it.
  if (trace) {
    const litBoxes = new Set((trace.nodes ?? []).map(visible).filter(Boolean));
    for (const node of trace.nodes ?? []) {
      const fileId = fileOf(nodes.get(node) ?? {});
      if (fileId && nodes.get(fileId)) { litBoxes.add(nodes.get(fileId).block); if (open.has(nodes.get(fileId).block)) litBoxes.add(fileId); }
    }
    for (const box of boxes) box.lit = litBoxes.has(box.id);
  }
  return { width: Math.max(width, 0), height: Math.max(y - SIZE.rowGap, 0), boxes, arrows: arrowList,
    notes: (graph.notes ?? []).filter(note => note.proof?.length).map(note => ({ message: note.message, proof: note.proof, box: visible(`file:${note.proof[0].file}`) })) };
}
