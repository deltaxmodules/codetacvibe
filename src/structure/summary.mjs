// The changes in the structure in plain sentences (phase 9, step 3), made by
// rules from the diff of two graphs (diff.mjs) and from the findings of both
// versions (import loops, secrets reaching the browser, tables without row
// level security used from the browser). No AI. Each sentence has:
//   kind       what rule made it
//   severity   alert | warning | info (the order they are shown in)
//   touches    ['leaks'] / ['secrets'] when it is about data leaving the
//              machine or about secrets (the "only leaks and secrets" filter)
//   text       the sentence (texts in text/en.json, "diff")
//   side       'after' or 'before': which version the proof and ids are of
//              (what is gone is proven by the old version)
//   proof      [{ file, line }] (at most 8)
//   ids        the graph ids it is about, to mark them on the plan
import { t } from './text.mjs';
import { exposure } from './secrets.mjs';
import { dataFindings } from './data.mjs';
import { importCycles } from './smells.mjs';

const SEVERITY = { alert: 0, warning: 1, info: 2 };
// Within a severity, the order of the rules: what matters more first.
// (route-no-auth to dependency-removed: the Diff's own rules, src/diff/risk.mjs, phase D2.)
const ORDER = ['public-secret', 'secret-in-browser', 'no-rls-browser', 'literal-key', 'new-service', 'sends-data', 'destination', 'route-no-auth',
  'dependency-added', 'test-deleted', 'tests-removed', 'new-secret-variable',
  'uses-secret', 'rls-off', 'new-cycle', 'table-gone', 'runs-on', 'depends-on', 'new-table', 'columns', 'new-write', 'new-route', 'route-gone',
  'moved-block', 'new-block', 'block-gone', 'service-gone', 'stops-sending', 'exposure-gone', 'rls-alert-gone', 'rls-on', 'cycle-gone',
  'no-longer-depends-on', 'new-variable', 'variable-gone', 'dependency-changed', 'dependency-removed', 'project-types', 'project-types-gone', 'files-added', 'files-removed', 'files-renamed',
  'files-changed'];
const MAX_LIST = 5;
const MAX_PROOF = 8;

function list(items) {
  const unique = [...new Set(items)];
  if (unique.length <= MAX_LIST) return unique.join(', ');
  return t('diff.more', { list: unique.slice(0, MAX_LIST).join(', '), more: unique.length - MAX_LIST });
}

const SYMBOL = /^symbol:(.*)#([^#@]+)@\d+$/;
// "lib/mailer.js (track)" for a function, the path for a file.
function place(id) {
  const match = SYMBOL.exec(id);
  if (match) return `${match[1]} (${match[2]})`;
  return id.startsWith('file:') ? id.slice(5) : id;
}

const layerName = id => t(`layers.${String(id).replace(/^block:/, '')}`);
const firstProofs = items => items.flatMap(item => (item.proof ?? []).slice(0, 1)).slice(0, MAX_PROOF);

export function changeSummary(diff, before, after) {
  const sentences = [];
  const add = (kind, severity, text, { touches = [], side = 'after', proof = [], ids = [] } = {}) => {
    // The same line can prove a sentence twice (the read and the variable itself).
    const places = new Set();
    proof = proof.filter(item => { const at = JSON.stringify(item); return !places.has(at) && places.add(at); });
    sentences.push({ kind, severity, touches, text, side, proof: proof.slice(0, MAX_PROOF), ids: [...new Set(ids)] });
  };
  const nodesBefore = new Map(before.nodes.map(node => [node.id, node]));
  const nodesAfter = new Map(after.nodes.map(node => [node.id, node]));
  const name = (id, nodes) => nodes.get(id)?.name ?? id.replace(/^[a-z]+:/, '');

  // Secrets that reach the browser, new and gone.
  const exposureKey = item => `${item.kind}\n${item.variable}`;
  const exposedBefore = new Map(exposure(before).map(item => [exposureKey(item), item]));
  const exposedAfter = new Map(exposure(after).map(item => [exposureKey(item), item]));
  for (const [key, item] of exposedAfter) {
    if (exposedBefore.has(key)) continue;
    // A public name puts the value in the browser even before a page imports the file.
    const text = item.kind !== 'public-secret' ? 'diff.secretInBrowser' : item.browserFiles.length ? 'diff.publicSecret' : 'diff.publicSecretNoFiles';
    add(item.kind, item.severity, t(text, { variable: item.variable, files: list(item.browserFiles) }),
      { touches: ['secrets'], proof: item.proof, ids: [`env:${item.variable}`, ...item.browserFiles.map(path => `file:${path}`)] });
  }
  const stillExposed = new Set([...exposedAfter.values()].map(item => item.variable));
  for (const [key, item] of exposedBefore) {
    if (exposedAfter.has(key) || stillExposed.has(item.variable)) continue;
    add('exposure-gone', 'info', t('diff.exposureGone', { variable: item.variable }), { touches: ['secrets'], side: 'before', proof: item.proof, ids: [`env:${item.variable}`] });
  }

  // Tables without row level security used from the browser.
  const rlsKey = item => item.table;
  const rlsBefore = new Map(dataFindings(before).filter(item => item.kind === 'no-rls-browser').map(item => [rlsKey(item), item]));
  const rlsAfter = new Map(dataFindings(after).filter(item => item.kind === 'no-rls-browser').map(item => [rlsKey(item), item]));
  for (const [key, item] of rlsAfter) {
    if (!rlsBefore.has(key)) add('no-rls-browser', 'alert', t('diff.noRlsBrowser', { table: item.table, files: list(item.browserFiles) }),
      { touches: ['leaks'], proof: item.proof, ids: [`table:${item.table}`, ...item.browserFiles.map(path => `file:${path}`)] });
  }
  for (const [key, item] of rlsBefore) {
    if (!rlsAfter.has(key)) add('rls-alert-gone', 'info', t('diff.rlsGone', { table: item.table }), { touches: ['leaks'], side: 'before', proof: item.proof, ids: [`table:${item.table}`] });
  }

  // Keys written in the code (the note never holds the value).
  for (const note of diff.notes.added) {
    if (note.kind === 'literal-key') add('literal-key', 'alert', t('diff.literalKey', { message: note.message }), { touches: ['secrets'], proof: note.proof ?? [] });
  }

  // External services: new, gone, destination changed; data sent to known ones.
  const services = diff.services;
  const senders = id => diff.links.added.filter(edge => edge.kind === 'sends-data-to' && edge.to === id).map(edge => place(edge.from));
  const serviceWithSenders = node => (senders(node.id).length ? t('diff.serviceFrom', { ...node, from: list(senders(node.id)) }) : t('diff.service', node));
  const newServiceIds = new Set(services.added.map(node => node.id));
  if (services.added.length) {
    add('new-service', 'warning', t('diff.newService', { count: services.added.length, list: list(services.added.map(serviceWithSenders)) }),
      { touches: ['leaks'], proof: firstProofs(services.added), ids: [...services.added.map(node => node.id),
        ...diff.links.added.filter(edge => edge.kind === 'sends-data-to' && newServiceIds.has(edge.to)).map(edge => edge.from)] });
  }
  if (services.removed.length) {
    add('service-gone', 'info', t('diff.serviceGone', { count: services.removed.length, list: list(services.removed.map(node => node.name)) }),
      { touches: ['leaks'], side: 'before', proof: firstProofs(services.removed), ids: services.removed.map(node => node.id) });
  }
  const destination = value => (value?.type === 'literal' ? value.host : value?.type === 'env' ? `the address in ${value.variable}` : 'an unknown address');
  for (const change of services.changed) {
    const field = change.fields.find(item => item.field === 'destination');
    if (field) add('destination', 'warning', t('diff.destination', { name: change.after.name, after: destination(field.after), before: destination(field.before) }),
      { touches: ['leaks'], proof: change.after.proof, ids: [change.id] });
  }
  const newServices = new Set(services.added.map(node => node.id));
  const goneServices = new Set(services.removed.map(node => node.id));
  for (const edge of diff.links.added) {
    if (edge.kind === 'sends-data-to' && !newServices.has(edge.to)) {
      add('sends-data', 'warning', t('diff.sendsData', { from: place(edge.from), service: name(edge.to, nodesAfter) }), { touches: ['leaks'], proof: edge.proof, ids: [edge.from, edge.to] });
    }
  }
  for (const edge of diff.links.removed) {
    if (edge.kind === 'sends-data-to' && !goneServices.has(edge.to)) {
      add('stops-sending', 'info', t('diff.stopsSending', { from: place(edge.from), service: name(edge.to, nodesBefore) }), { touches: ['leaks'], side: 'before', proof: edge.proof, ids: [edge.from, edge.to] });
    }
  }

  // Variables.
  const readers = (graph, id) => graph.edges.filter(edge => edge.to === id && (edge.kind === 'reads' || edge.kind === 'uses-secret'));
  const plainAdded = [];
  for (const node of diff.env.added) {
    if (!node.secretLike) { plainAdded.push(node); continue; }
    const edges = readers(after, node.id);
    add('new-secret-variable', 'warning', edges.length ? t('diff.newSecretVariable', { variable: node.name, files: list(edges.map(edge => place(edge.from))) }) : t('diff.newSecretVariableUnread', { variable: node.name }),
      { touches: ['secrets'], proof: [...edges.flatMap(edge => edge.proof), ...node.proof], ids: [node.id, ...edges.map(edge => edge.from)] });
  }
  if (plainAdded.length) add('new-variable', 'info', t('diff.newVariable', { count: plainAdded.length, list: list(plainAdded.map(node => node.name)) }), { proof: firstProofs(plainAdded), ids: plainAdded.map(node => node.id) });
  if (diff.env.removed.length) {
    add('variable-gone', 'info', t('diff.variableGone', { count: diff.env.removed.length, list: list(diff.env.removed.map(node => node.name)) }),
      { touches: diff.env.removed.some(node => node.secretLike) ? ['secrets'] : [], side: 'before', proof: firstProofs(diff.env.removed), ids: diff.env.removed.map(node => node.id) });
  }
  const newVariables = new Set(diff.env.added.map(node => node.id));
  for (const edge of diff.links.added) {
    if (edge.kind === 'uses-secret' && !newVariables.has(edge.to)) {
      add('uses-secret', 'warning', t('diff.usesSecret', { from: place(edge.from), variable: name(edge.to, nodesAfter) }), { touches: ['secrets'], proof: edge.proof, ids: [edge.from, edge.to] });
    }
  }

  // Import loops.
  const cycleKey = cycle => cycle.files.join('\n');
  const cyclesBefore = new Map(importCycles(before).map(cycle => [cycleKey(cycle), cycle]));
  const cyclesAfter = new Map(importCycles(after).map(cycle => [cycleKey(cycle), cycle]));
  for (const [key, cycle] of cyclesAfter) {
    if (!cyclesBefore.has(key)) add('new-cycle', 'warning', t('diff.newCycle', { files: cycle.files.join(' ↔ ') }), { proof: cycle.proof, ids: cycle.files.map(path => `file:${path}`) });
  }
  for (const [key, cycle] of cyclesBefore) {
    if (!cyclesAfter.has(key)) add('cycle-gone', 'info', t('diff.cycleGone', { files: cycle.files.join(' ↔ ') }), { side: 'before', proof: cycle.proof, ids: cycle.files.map(path => `file:${path}`) });
  }

  // Tables.
  const tables = diff.tables;
  if (tables.added.length) add('new-table', 'info', t('diff.newTable', { count: tables.added.length, list: list(tables.added.map(node => node.name)) }), { proof: firstProofs(tables.added), ids: tables.added.map(node => node.id) });
  if (tables.removed.length) add('table-gone', 'warning', t('diff.tableGone', { count: tables.removed.length, list: list(tables.removed.map(node => node.name)) }), { side: 'before', proof: firstProofs(tables.removed), ids: tables.removed.map(node => node.id) });
  for (const change of tables.changed) {
    const rls = change.fields.find(item => item.field === 'rls');
    if (rls && rls.before?.enabled !== false && rls.after?.enabled === false) add('rls-off', 'warning', t('diff.rlsOff', { table: change.after.name }), { touches: ['leaks'], proof: change.after.rls.proof, ids: [change.id] });
    if (rls && rls.before?.enabled !== true && rls.after?.enabled === true) add('rls-on', 'info', t('diff.rlsOn', { table: change.after.name }), { proof: change.after.rls.proof, ids: [change.id] });
    if (change.columns) {
      const parts = [];
      if (change.columns.added.length) parts.push(t('diff.columnsAdded', { list: list(change.columns.added) }));
      if (change.columns.removed.length) parts.push(t('diff.columnsRemoved', { list: list(change.columns.removed) }));
      if (change.columns.changed.length) parts.push(t('diff.columnsChanged', { list: list(change.columns.changed.map(column => column.name)) }));
      add('columns', 'info', t('diff.columns', { table: change.after.name, changes: parts.join('; ') }), { proof: change.after.proof, ids: [change.id] });
    }
  }
  const newTables = new Set(tables.added.map(node => node.id));
  for (const edge of diff.links.added) {
    if (edge.kind === 'writes' && !newTables.has(edge.to)) add('new-write', 'info', t('diff.newWrite', { from: place(edge.from), table: name(edge.to, nodesAfter) }), { proof: edge.proof, ids: [edge.from, edge.to] });
  }

  // Routes.
  const routes = diff.routes;
  if (routes.added.length) add('new-route', 'info', t('diff.newRoute', { count: routes.added.length, list: list(routes.added.map(node => node.name)) }), { proof: firstProofs(routes.added), ids: routes.added.map(node => node.id) });
  if (routes.removed.length) add('route-gone', 'info', t('diff.routeGone', { count: routes.removed.length, list: list(routes.removed.map(node => node.name)) }), { side: 'before', proof: firstProofs(routes.removed), ids: routes.removed.map(node => node.id) });

  // Blocks and the dependencies between them (imports or calls, by pair).
  const pairs = graph => {
    const map = new Map();
    for (const edge of graph.edges) {
      if (!edge.from.startsWith('block:') || !edge.to.startsWith('block:') || edge.from === edge.to) continue;
      const key = `${edge.from}\n${edge.to}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(edge);
    }
    return map;
  };
  const pairsBefore = pairs(before);
  const pairsAfter = pairs(after);
  for (const [key, edges] of pairsAfter) {
    if (pairsBefore.has(key)) continue;
    const [from, to] = key.split('\n');
    add('depends-on', 'info', t('diff.dependsOn', { from: layerName(from), to: layerName(to) }), { proof: edges.flatMap(edge => edge.proof), ids: [from, to] });
  }
  for (const [key, edges] of pairsBefore) {
    if (pairsAfter.has(key)) continue;
    const [from, to] = key.split('\n');
    add('no-longer-depends-on', 'info', t('diff.noLongerDependsOn', { from: layerName(from), to: layerName(to) }), { side: 'before', proof: edges.flatMap(edge => edge.proof), ids: [from, to] });
  }
  for (const node of diff.blocks.added) add('new-block', 'info', t('diff.newBlock', { block: layerName(node.id) }), { proof: node.proof, ids: [node.id] });
  for (const node of diff.blocks.removed) add('block-gone', 'info', t('diff.blockGone', { block: layerName(node.id) }), { side: 'before', proof: node.proof, ids: [node.id] });

  // Files.
  const files = diff.files;
  const changedContent = [];
  for (const change of files.changed) {
    const block = change.fields.find(item => item.field === 'block');
    if (block) add('moved-block', 'info', t('diff.movedBlock', { file: change.after.path, before: layerName(block.before), after: layerName(block.after) }), { proof: change.after.proof, ids: [change.id] });
    const runsOn = change.fields.find(item => item.field === 'runsOn');
    if (runsOn) {
      const toBrowser = ['client', 'both'].includes(runsOn.after) && !['client', 'both'].includes(runsOn.before);
      add('runs-on', toBrowser ? 'warning' : 'info', t('diff.runsOn', { file: change.after.path, after: t(`diff.runsOnPlace.${runsOn.after ?? 'unknown'}`), before: t(`diff.runsOnPlace.${runsOn.before ?? 'unknown'}`) }),
        { proof: change.after.proof, ids: [change.id] });
    }
    if (change.fields.some(item => item.field === 'hash')) changedContent.push(change.after);
  }
  if (files.added.length) add('files-added', 'info', t('diff.filesAdded', { count: files.added.length, list: list(files.added.map(node => node.path)) }), { proof: firstProofs(files.added), ids: files.added.map(node => node.id) });
  if (files.removed.length) add('files-removed', 'info', t('diff.filesRemoved', { count: files.removed.length, list: list(files.removed.map(node => node.path)) }), { side: 'before', proof: firstProofs(files.removed), ids: files.removed.map(node => node.id) });
  if (files.renamed.length) add('files-renamed', 'info', t('diff.filesRenamed', { count: files.renamed.length, list: list(files.renamed.map(item => `${item.from} → ${item.to}`)) }), { proof: firstProofs(files.renamed.map(item => item.node)), ids: files.renamed.map(item => item.node.id) });
  if (changedContent.length) add('files-changed', 'info', t('diff.filesChanged', { count: changedContent.length, list: list(changedContent.map(node => node.path)) }), { proof: firstProofs(changedContent), ids: changedContent.map(node => node.id) });

  if (diff.project.typesAdded.length) add('project-types', 'info', t('diff.projectTypes', { types: diff.project.typesAdded.join(', ') }));
  if (diff.project.typesRemoved.length) add('project-types-gone', 'info', t('diff.projectTypesGone', { types: diff.project.typesRemoved.join(', ') }), { side: 'before' });

  return sortSentences(sentences);
}

// The most important first: by severity, then by the order of the rules, then by text.
export function sortSentences(sentences) {
  return sentences.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}
