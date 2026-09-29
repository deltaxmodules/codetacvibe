// The card of a block (phase 3): what it is for, who uses it, what it uses,
// the data it touches, its largest files and its entry points. Every line is a
// fact read from the graph, with the files and lines that prove it; nothing
// here is guessed or written by an AI. The `names` of a card are every name its
// facts mention: an AI explanation may only cite those (explain.mjs).
import { t } from './text.mjs';

const MAX_PROOFS = 12;
const MAX_LISTED = 8;
const DATA_KINDS = new Set(['reads', 'writes', 'sends-data-to', 'uses-secret']);
const LINK_KINDS = new Set(['imports', 'calls']);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byProof = (a, b) => byText(a.file, b.file) || a.line - b.line;
const listed = (items, max = MAX_LISTED) => (items.length > max ? t('card.list', { items: items.slice(0, max).join(', '), more: items.length - max }) : items.join(', '));
const KINDS = new Set(['function', 'component', 'class', 'variable']);
const kindCount = (kind, count) => t(`card.kinds.${KINDS.has(kind) ? kind : 'any'}`, { count, kind });
const uniqueProofs = list => [...new Map(list.map(item => [`${item.file}:${item.line}${item.note ? `:${item.note}` : ''}`, item])).values()].sort(byProof).slice(0, MAX_PROOFS);

export function blockCard(graph, blockId) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const block = nodes.get(blockId);
  if (!block || block.kind !== 'block') return null;
  const files = graph.nodes.filter(node => node.kind === 'file').sort((a, b) => byText(a.path, b.path));
  const exposedBy = new Map(graph.edges.filter(edge => edge.kind === 'exposes').map(edge => [edge.to, edge.from]));
  const fileOf = node => (node.kind === 'file' ? node : node.kind === 'symbol' ? nodes.get(node.file) : node.kind === 'route' ? nodes.get(exposedBy.get(node.id)) : null);
  const blockOf = id => { const node = nodes.get(id); if (!node) return null; if (node.kind === 'block') return node.id; return fileOf(node)?.block ?? null; };
  const members = files.filter(file => file.block === blockId);
  const inside = new Set(members.map(file => file.id));
  const symbols = graph.nodes.filter(node => node.kind === 'symbol' && inside.has(node.file));
  const routes = graph.nodes.filter(node => node.kind === 'route' && inside.has(exposedBy.get(node.id)));
  const names = new Set([block.name]);
  const label = node => (node.kind === 'file' ? node.path : node.name);
  const facts = [];
  const add = (section, text, proof, mentioned = []) => {
    if (!proof.length) return;
    facts.push({ section, text, proof: uniqueProofs(proof) });
    for (const name of mentioned) names.add(name);
  };

  // What it is for: size, folders, the rules that placed its files, what it exports and exposes.
  add('purpose', t('card.size', { block: block.name, files: t('card.files', { count: members.length }) }), members.map(file => ({ file: file.path, line: 1 })));
  const folders = new Map();
  for (const file of members) {
    const folder = file.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/` : t('card.projectRoot');
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(file);
  }
  const folderList = [...folders].sort((a, b) => b[1].length - a[1].length || byText(a[0], b[0]));
  add('purpose', t('card.folders', { list: listed(folderList.map(([folder, list]) => `${folder} (${list.length})`)) }),
    folderList.map(([, list]) => ({ file: list[0].path, line: 1 })), folderList.map(([folder]) => folder));
  const rules = new Map();
  for (const file of members) { if (!rules.has(file.rule)) rules.set(file.rule, []); rules.get(file.rule).push(file); }
  const ruleList = [...rules].sort((a, b) => b[1].length - a[1].length || byText(a[0], b[0]));
  add('purpose', t('card.rules', { list: listed(ruleList.map(([rule, list]) => `${rule} (${list.length})`)) }),
    ruleList.map(([, list]) => ({ file: list[0].path, line: 1 })), ruleList.map(([rule]) => rule));
  const exported = symbols.filter(symbol => symbol.exported && symbol.name !== '<anonymous>').sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));
  if (exported.length) {
    const kinds = new Map();
    for (const symbol of exported) kinds.set(symbol.symbolKind, (kinds.get(symbol.symbolKind) ?? 0) + 1);
    add('purpose', t('card.exports', { kinds: [...kinds].map(([kind, count]) => kindCount(kind, count)).join(', '), list: listed(exported.map(symbol => symbol.name)) }),
      exported.map(symbol => ({ file: nodes.get(symbol.file).path, line: symbol.line })), exported.map(symbol => symbol.name));
  }
  if (routes.length) {
    const sorted = [...routes].sort((a, b) => byText(a.path, b.path) || byText(a.method, b.method));
    add('purpose', t('card.exposes', { routes: t('card.routes', { count: routes.length }), list: listed(sorted.map(route => route.name)) }),
      sorted.flatMap(route => route.proof.filter(proof => inside.has(`file:${proof.file}`))), sorted.map(route => route.name));
  }

  // Who uses it and what it uses: the imports and calls that cross its border.
  const crossing = { in: new Map(), out: new Map() };
  for (const edge of graph.edges) {
    if (!LINK_KINDS.has(edge.kind) || nodes.get(edge.from)?.kind === 'block') continue;
    const from = blockOf(edge.from);
    const to = blockOf(edge.to);
    if (!from || !to || from === to || (from !== blockId && to !== blockId)) continue;
    const [side, other, far, near] = to === blockId ? ['in', from, edge.from, edge.to] : ['out', to, edge.to, edge.from];
    if (!crossing[side].has(other)) crossing[side].set(other, { edges: [], far: new Map(), near: new Map(), kinds: new Map() });
    const entry = crossing[side].get(other);
    entry.edges.push(edge);
    // Each end by file (a route by its name), with the functions in it.
    for (const [end, id] of [[entry.far, far], [entry.near, near]]) {
      const node = nodes.get(id);
      const key = node.kind === 'route' ? node.name : fileOf(node)?.path ?? label(node);
      if (!end.has(key)) end.set(key, new Set());
      if (node.kind === 'symbol' && node.name !== '<anonymous>') end.get(key).add(node.name);
    }
    entry.kinds.set(edge.kind, (entry.kinds.get(edge.kind) ?? 0) + 1);
  }
  const endText = end => [...end].sort((a, b) => byText(a[0], b[0])).map(([key, fns]) => (fns.size ? `${key} (${[...fns].sort(byText).join(', ')})` : key));
  const endNames = end => [...end].flatMap(([key, fns]) => [key, ...fns]);
  const farText = entry => endText(entry.far);
  const farNames = entry => endNames(entry.far);
  const describe = kinds => [...kinds].sort((a, b) => byText(a[0], b[0])).map(([kind, count]) => t(kind === 'calls' ? 'card.calls' : 'card.imports', { count }))
    .reduce((first, second) => t('card.and', { first, second }));
  for (const [side, section] of [['in', 'usedBy'], ['out', 'uses']]) {
    const entries = [...crossing[side]].sort((a, b) => b[1].edges.length - a[1].edges.length || byText(a[0], b[0]));
    for (const [other, entry] of entries) {
      const otherName = nodes.get(other)?.name ?? other;
      const far = farText(entry);
      const near = endText(entry.near);
      const text = side === 'in'
        ? t('card.usedBy', { other: otherName, kinds: describe(entry.kinds), far: listed(far, 4), near: listed(near, 4) })
        : t('card.uses', { other: otherName, kinds: describe(entry.kinds), far: listed(far, 4), near: listed(near, 4) });
      add(section, text, entry.edges.flatMap(edge => edge.proof), [otherName, ...farNames(entry), ...endNames(entry.near)]);
    }
  }

  // The data it touches: the data and external blocks it uses, and the tables,
  // variables and services of the graph (phases 4 to 6) reached from its files.
  for (const layer of ['data', 'external']) {
    const entry = crossing.out.get(`block:${layer}`);
    if (!entry) continue;
    add('data', t(layer === 'data' ? 'card.database' : 'card.outside', { list: listed(farText(entry), 6) }),
      entry.edges.flatMap(edge => edge.proof), farNames(entry));
  }
  const touched = new Map();
  for (const edge of graph.edges) {
    if (!DATA_KINDS.has(edge.kind) || blockOf(edge.from) !== blockId) continue;
    const target = nodes.get(edge.to);
    if (!target) continue;
    const key = `${edge.kind}:${target.id}`;
    if (!touched.has(key)) touched.set(key, { kind: edge.kind, target, proof: [] });
    touched.get(key).proof.push(...edge.proof);
  }
  const verbs = { reads: 'card.reads', writes: 'card.writes', 'sends-data-to': 'card.sendsDataTo', 'uses-secret': 'card.usesSecret' };
  for (const kind of Object.keys(verbs)) {
    const list = [...touched.values()].filter(item => item.kind === kind).sort((a, b) => byText(a.target.name, b.target.name));
    if (!list.length) continue;
    add('data', t(verbs[kind], { list: listed(list.map(item => (item.target.kind === 'table' ? t('card.table', { name: item.target.name }) : item.target.kind === 'env' ? t('card.variable', { name: item.target.name }) : item.target.name))) }),
      list.flatMap(item => item.proof), list.map(item => item.target.name));
  }

  // Largest files, and the entry points: what the outside reaches first.
  const largest = [...members].sort((a, b) => b.lines - a.lines || byText(a.path, b.path)).slice(0, 3).filter(file => file.lines > 0);
  if (largest.length) add('largest', t('card.largest', { list: largest.map(file => `${file.path} (${t('card.lines', { count: file.lines })})`).join(', ') }),
    largest.map(file => ({ file: file.path, line: 1 })), largest.map(file => file.path));
  const importedFrom = new Set(graph.edges.filter(edge => edge.kind === 'imports' && nodes.get(edge.from)?.kind === 'file').map(edge => edge.to));
  const entries = [];
  for (const file of members) {
    const exposes = routes.filter(route => exposedBy.get(route.id) === file.id);
    if (exposes.length) entries.push({ file, why: t('card.whyRoutes', { routes: t('card.routes', { count: exposes.length }) }), proof: exposes.flatMap(route => route.proof.filter(proof => proof.file === file.path)) });
    else if (file.language === 'html') entries.push({ file, why: t('card.whyPage'), proof: [{ file: file.path, line: 1 }] });
    else if (/^next-.*:(convention|route|api)$|^next:middleware$|^server-entry$|^browser-entry$/.test(file.rule) && !importedFrom.has(file.id)) {
      entries.push({ file, why: t(file.rule === 'browser-entry' ? 'card.whyLoaded' : file.rule === 'server-entry' ? 'card.whyServer' : 'card.whyNext'), proof: [{ file: file.path, line: 1 }] });
    }
  }
  if (entries.length) add('entries', t('card.entries', { list: listed(entries.map(item => `${item.file.path} (${item.why})`), 6) }),
    entries.flatMap(item => item.proof), entries.map(item => item.file.path));

  // What the reader could not decide in these files.
  for (const note of graph.notes ?? []) {
    if (note.proof?.length && note.proof.every(proof => inside.has(`file:${proof.file}`))) add('notes', note.message, note.proof);
  }

  for (const file of members) names.add(file.path);
  return { id: block.id, name: block.name, layer: block.layer, files: members.length, facts, names: [...names].sort(byText) };
}
