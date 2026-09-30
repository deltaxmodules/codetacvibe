// «Predict before you ask» (phase 10, step 2): before asking the AI for a
// change, the user saves a snapshot with what they expect to change — files
// added, changed or removed, blocks that come to depend on other blocks, new
// external services. Afterwards, the diff of phase 9 is compared with it:
// what they got right, what changed that they did not predict, and what they
// predicted that did not change. Rules only, no AI.
//
// The prediction is kept beside its snapshot (<id>.prediction.json, in
// CodeTAC's data folder), never in the project, and removed with it.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './text.mjs';
import { LAYERS } from './config.mjs';

export const PREDICTION_VERSION = 1;
// The sentence of each kind of item, and of what happened instead to a file.
const TEXTS = { 'file-added': 'predict.file-added', 'file-changed': 'predict.file-changed', 'file-removed': 'predict.file-removed' };
const INSTEAD = { added: 'predict.instead.added', changed: 'predict.instead.changed', removed: 'predict.instead.removed' };
const MAX_ITEMS = 200;
const MAX_TEXT = 300;

export const predictionPath = (folder, id) => join(folder, `${id}.prediction.json`);

// A path as the graph writes it: forward slashes, no ./ or leading /.
export function normalPath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}
const cleanText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const unique = items => [...new Set(items.filter(Boolean))].slice(0, MAX_ITEMS);
const asList = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : []);
const layerName = layer => t(`layers.${layer}`);
// A block as a block id: block:logic, logic or its name («Logic»); null
// when it is none of the blocks.
export function blockId(value) {
  const text = cleanText(value).toLowerCase().replace(/^block:/, '');
  const layer = LAYERS.find(item => item === text || layerName(item).toLowerCase() === text);
  return layer ? `block:${layer}` : null;
}

// A prediction from what the page or the terminal sent: lists of paths, pairs
// of blocks (ids or names) and services (ids or names), cleaned and without
// repeats. Null when nothing was predicted.
export function cleanPrediction(input) {
  if (!input || typeof input !== 'object') return null;
  const files = {};
  for (const list of ['added', 'changed', 'removed']) files[list] = unique(asList(input.files?.[list]).map(normalPath)).sort();
  const dependsOn = [];
  const seen = new Set();
  // A pair: { from, to }, [from, to] or the text «interface -> logic».
  for (const item of asList(input.dependsOn)) {
    const pair = typeof item === 'string' ? item.split(/\s*(?:->|→)\s*/) : item;
    const from = blockId(Array.isArray(pair) ? pair[0] : pair?.from);
    const to = blockId(Array.isArray(pair) ? pair[1] : pair?.to);
    if (!from || !to || from === to || seen.has(`${from}\n${to}`) || dependsOn.length >= MAX_ITEMS) continue;
    seen.add(`${from}\n${to}`);
    dependsOn.push({ from, to });
  }
  const services = unique(asList(input.services).map(cleanText)).sort();
  const note = cleanText(input.note ?? '');
  const count = files.added.length + files.changed.length + files.removed.length + dependsOn.length + services.length;
  if (!count) return null;
  return { version: PREDICTION_VERSION, files, dependsOn, services, ...(note ? { note } : {}) };
}

export function readPrediction(folder, id) {
  try {
    const prediction = JSON.parse(readFileSync(predictionPath(folder, id), 'utf8'));
    return prediction?.version === PREDICTION_VERSION ? prediction : null;
  } catch { return null; }
}
export function writePrediction(folder, id, prediction) {
  const path = predictionPath(folder, id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(prediction)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
export function removePrediction(folder, id) {
  rmSync(predictionPath(folder, id), { force: true });
}

// What really changed, in the prediction's terms.
export function actualChanges(diff, before, after) {
  const added = [...diff.files.added.map(node => node.path), ...diff.files.renamed.map(item => item.to)];
  const removed = [...diff.files.removed.map(node => node.path), ...diff.files.renamed.map(item => item.from)];
  const changed = diff.files.changed.filter(item => item.fields.some(field => field.field === 'hash')).map(item => item.after.path);
  const pairs = graph => new Set(graph.edges.filter(edge => edge.from.startsWith('block:') && edge.to.startsWith('block:') && edge.from !== edge.to)
    .map(edge => `${edge.from}\n${edge.to}`));
  const pairsBefore = pairs(before);
  const dependsOn = [...pairs(after)].filter(key => !pairsBefore.has(key)).map(key => { const [from, to] = key.split('\n'); return { from, to }; });
  const services = diff.services.added.map(node => ({ id: node.id, name: node.name }));
  return { files: { added: unique(added).sort(), changed: unique(changed).sort(), removed: unique(removed).sort() }, dependsOn, services };
}

// comparePrediction(prediction, diff, before, after) → {
//   hits:     [{ kind, text, value }]  predicted and changed
//   missed:   [{ kind, text, value }]  changed, not predicted
//   wrong:    [{ kind, text, value, instead? }]  predicted, did not change (instead: what happened to that file)
//   score:    { hits, predicted, changed }
// }
// kind: file-added | file-changed | file-removed | depends-on | service.
export function comparePrediction(prediction, diff, before, after) {
  const actual = actualChanges(diff, before, after);
  const blockName = id => layerName(id.replace(/^block:/, ''));
  const hits = [];
  const missed = [];
  const wrong = [];
  const fileState = new Map();
  for (const list of ['added', 'changed', 'removed']) for (const path of actual.files[list]) fileState.set(path, list);
  for (const list of ['added', 'changed', 'removed']) {
    const kind = `file-${list}`;
    const predicted = new Set(prediction.files?.[list] ?? []);
    for (const path of actual.files[list]) (predicted.has(path) ? hits : missed).push({ kind, text: t(TEXTS[kind], { file: path }), value: path });
    for (const path of predicted) {
      if (fileState.get(path) === list) continue;
      const instead = fileState.get(path) ?? null;
      wrong.push({ kind, text: t(TEXTS[kind], { file: path }), value: path, ...(instead ? { instead, insteadText: t(INSTEAD[instead]) } : {}) });
    }
  }
  const pairKey = pair => `${pair.from}\n${pair.to}`;
  const predictedPairs = new Set((prediction.dependsOn ?? []).map(pairKey));
  const actualPairs = new Set(actual.dependsOn.map(pairKey));
  const dependsText = pair => t('predict.depends-on', { from: blockName(pair.from), to: blockName(pair.to) });
  for (const pair of actual.dependsOn) (predictedPairs.has(pairKey(pair)) ? hits : missed).push({ kind: 'depends-on', text: dependsText(pair), value: pair });
  for (const pair of prediction.dependsOn ?? []) if (!actualPairs.has(pairKey(pair))) wrong.push({ kind: 'depends-on', text: dependsText(pair), value: pair });
  // A service by its id (service:stripe or stripe) or its name (Stripe), any case.
  const serviceKeys = service => [service.id, service.id.replace(/^service:/, ''), service.name].map(key => String(key).toLowerCase());
  const predictedServices = (prediction.services ?? []).map(name => ({ name, key: name.toLowerCase() }));
  const matched = new Set();
  for (const service of actual.services) {
    const keys = serviceKeys(service);
    const found = predictedServices.find(item => keys.includes(item.key));
    if (found) matched.add(found.key);
    (found ? hits : missed).push({ kind: 'service', text: t('predict.service', { service: service.name }), value: service.name });
  }
  for (const item of predictedServices) if (!matched.has(item.key)) wrong.push({ kind: 'service', text: t('predict.service', { service: item.name }), value: item.name });
  const predicted = (prediction.files?.added?.length ?? 0) + (prediction.files?.changed?.length ?? 0) + (prediction.files?.removed?.length ?? 0)
    + (prediction.dependsOn?.length ?? 0) + (prediction.services?.length ?? 0);
  return { hits, missed, wrong, score: { hits: hits.length, predicted, changed: hits.length + missed.length } };
}

// What the page offers to choose from: the files and services of the graph
// now, every block (a new one is not in the graph yet), and the services of
// the catalogue.
export function predictionChoices(graph, catalogue = []) {
  const files = graph.nodes.filter(node => node.kind === 'file').map(node => node.path).sort();
  const blocks = LAYERS.map(layer => ({ id: `block:${layer}`, name: layerName(layer) }));
  const inGraph = new Set(graph.nodes.filter(node => node.kind === 'service').map(node => node.name));
  const services = [...new Set([...catalogue.map(service => service.name), ...inGraph])].sort((a, b) => a.localeCompare(b));
  return { files, blocks, services };
}
