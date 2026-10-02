// The Behavior layer of a prompt (phase D5): for each action of the app run
// both before and after the prompt, what it does differently (actions.mjs),
// and its path on the plan before and after, marked added, removed, changed
// or the same. Computed when asked, never kept: running an action again after
// the prompt changes the answer. The recordings come from the panel's store
// (`recordings.actions(root)`, `recordings.dossier(actionId)`), never from the project.
import { realpathSync } from 'node:fs';
import { traceAction } from '../structure/trace.mjs';
import { t } from '../structure/text.mjs';
import { fileChanges, readMoment } from './archive.mjs';
import { aroundPrompt, compareActions, pathMarks, summarizeAction } from './actions.mjs';
import { readMomentGraph } from './moments.mjs';
import { listPrompts, readPrompt } from './prompts.mjs';
import { redoPlan } from './rerun.mjs';

const MAX_COMPARED = 20;

// The same folder, whatever the links on the way.
export function sameFolder(a, b) {
  if (!a || !b) return false;
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}

// The recordings of this computer, as the panel reads them (for codetac diff in the terminal).
export async function localRecordings() {
  const [{ openStore }, { createActionView }, { dataDirectory }] = await Promise.all([import('../store.mjs'), import('../action-view.mjs'), import('../home.mjs')]);
  const store = openStore(dataDirectory(), { keep: Number(process.env.CODETAC_KEEP || 500) });
  return recordingsOf(store, createActionView(store));
}
// The actions recorded for a project (any of its recordings), resolved like the dossiers.
export function recordingsOf(store, view) {
  return {
    actions: root => {
      store.ingest();
      return store.listRuns().filter(entry => sameFolder(store.root(entry.run), root))
        .flatMap(entry => store.listActions({ run: entry.run, limit: 500 }))
        .map(item => ({ actionId: item.actionId, at: item.at, label: item.label, page: item.page, ...(item.replay ? { replay: true } : {}) }));
    },
    dossier: id => view.resolvedAction(id),
  };
}

const brief = action => ({ actionId: action.actionId, label: action.label, page: action.page, at: action.at, ...(action.replay ? { replay: true } : {}) });

// The ids of the boxes to open so the marked nodes show on the map: a function's file, a file's block.
function boxesToOpen(graph, ids) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const open = new Set();
  for (const id of ids) {
    const node = nodes.get(id);
    const file = node?.kind === 'symbol' ? nodes.get(node.file) : node?.kind === 'file' ? node : null;
    if (!file) continue;
    if (node.kind === 'symbol') open.add(file.id);
    if (file.block) open.add(file.block);
  }
  return [...open];
}

// Returns { running } while the prompt runs, or { compared, onlyAfter, onlyBefore, sentences, latest }, or { error }.
// Each action of onlyBefore says how it can run again (rerun.mjs: by the bar, or
// by hand), only for the newest prompt: a run now, after a newer prompt, would
// also show that prompt's changes.
export async function promptBehavior(root, n, recordings) {
  const prompt = readPrompt(root, n);
  if (!prompt) return { error: t('prompts.noPrompt', { n }) };
  if (!prompt.after || !prompt.endedAt) return { running: true, compared: [], onlyAfter: [], onlyBefore: [], sentences: [] };
  const actions = recordings ? await recordings.actions(root) : [];
  const { pairs, onlyAfter, onlyBefore } = aroundPrompt(actions, prompt);
  const latest = listPrompts(root).at(-1)?.n === prompt.n;
  const result = { compared: [], onlyAfter: onlyAfter.map(brief), onlyBefore: [], sentences: [], latest };
  for (const action of onlyBefore.sort((a, b) => b.at - a.at).slice(0, MAX_COMPARED)) {
    const dossier = latest ? await recordings.dossier(action.actionId) : null;
    result.onlyBefore.push(dossier ? { ...brief(action), redo: redoPlan(dossier) } : brief(action));
  }
  if (!pairs.length) return result;
  const graphBefore = await readMomentGraph(root, prompt.before);
  const graphAfter = await readMomentGraph(root, prompt.after);
  const momentBefore = readMoment(root, prompt.before);
  const momentAfter = readMoment(root, prompt.after);
  const changes = momentBefore && momentAfter ? fileChanges(momentBefore, momentAfter) : { added: [], changed: [], removed: [] };
  const changedFiles = new Set([...changes.added, ...changes.changed, ...changes.removed]);
  const nodes = new Map([...(graphBefore.graph?.nodes ?? []), ...(graphAfter.graph?.nodes ?? [])].map(node => [node.id, node]));
  const fileOf = id => { const node = nodes.get(id); return node?.kind === 'file' ? node.path : node?.kind === 'symbol' ? nodes.get(node.file)?.path : null; };
  for (const pair of pairs.sort((a, b) => b.after.at - a.after.at).slice(0, MAX_COMPARED)) {
    const before = await recordings.dossier(pair.before.actionId);
    const after = await recordings.dossier(pair.after.actionId);
    if (!before || !after) continue;
    const sentences = compareActions(summarizeAction(before), summarizeAction(after));
    let path = null;
    if (graphBefore.graph && graphAfter.graph) {
      const marks = pathMarks(traceAction(graphBefore.graph, before).nodes, traceAction(graphAfter.graph, after).nodes, changedFiles, fileOf);
      path = { marks, open: boxesToOpen(graphAfter.graph, Object.keys(marks)).concat(boxesToOpen(graphBefore.graph, Object.keys(marks))) };
    }
    const index = result.compared.length;
    result.compared.push({ key: pair.key, label: after.label, before: brief(pair.before), after: brief(pair.after), sentences: sentences.length, path });
    for (const sentence of sentences) result.sentences.push({ ...sentence, action: index });
  }
  return result;
}
