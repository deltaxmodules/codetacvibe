// `codetac structure`: the project's blocks in the terminal, and manual
// reclassification. Reading never writes into the project; only
// --reclassify does (codetac.structure.json).
import { readProject } from './readers.mjs';
import { reclassify, LAYERS, CONFIG_FILE } from './config.mjs';
import { suggestionRequest, askSuggestions, saveSuggestions, SYSTEM as SUGGEST_SYSTEM } from './suggest.mjs';
import { blocked, blockedText, guarded } from '../privacy.mjs';
import { inventory } from './node/inventory.mjs';
import { projectModules } from './node/modules.mjs';
import { describeProject } from './node/project.mjs';
import { dataDirectory } from '../home.mjs';
import { dataFindings } from './data.mjs';
import { structureSmells } from './smells.mjs';
import { readConfig } from './config.mjs';
import { DEFAULT_KEEP, listSnapshots, readSnapshot, saveSnapshot } from './snapshots.mjs';
import { diffGraphs } from './diff.mjs';
import { changeSummary } from './summary.mjs';
import { readPoint } from './commits.mjs';
import { blockId, cleanPrediction, comparePrediction } from './predict.mjs';

import { TEXT, t } from './text.mjs';

const LABELS = TEXT.layers;
const SHOWN = 8;

// Asks the model about the Unknown files, after showing exactly what will be
// sent and getting the user's consent (--yes, or a "y" at the prompt).
async function suggest(root, { yes, confirm, loadAiConfig, complete, out }) {
  const { graph } = await readProject(root);
  const unknown = graph.nodes.filter(node => node.kind === 'file' && node.block === 'block:unknown');
  if (!unknown.length) { out('Nothing is Unknown: there is nothing to ask the AI.'); out(''); return 0; }
  const config = await (loadAiConfig ?? (async () => (await import('../ai.mjs')).loadConfig({ directory: dataDirectory() })))();
  if (!config?.provider) {
    out(`No AI model is configured${config?.problem ? ` (${config.problem})` : ''}. Suggestions need one: see "AI explanations" in the README`);
    out('(CODETAC_AI_PROVIDER, CODETAC_AI_MODEL, CODETAC_AI_KEY, or a local Ollama). The plan works the same without it.');
    out('');
    return 0;
  }
  const reason = blocked('suggestions', config);
  if (reason) { out(blockedText(reason)); out(''); return 0; }
  const { files } = inventory(root);
  const modules = projectModules(root, files, { packages: describeProject(root).packages });
  const byPath = new Map(files.map(file => [file.path, file]));
  const request = suggestionRequest(unknown.map(node => ({ path: node.path, hash: byPath.get(node.path)?.hash ?? node.hash, exports: modules.get(node.path)?.exports ?? [] })),
    { types: graph.project.types });
  const where = config.local ? ', a model on this machine: nothing leaves it' : '';
  out(`This is exactly what would be sent to ${config.provider}${config.model ? ` (${config.model})` : ''}${where}. Only paths and export signatures, no code:`);
  out('-----');
  out(request.text);
  out('-----');
  out('With these fixed instructions to the model:');
  out(SUGGEST_SYSTEM);
  out('-----');
  if (request.left) out(`(${request.left} more Unknown files are left for another run.)`);
  const agreed = yes || (confirm ? await confirm('Send it? [y/N]') : false);
  if (!agreed) { out(confirm ? 'Not sent.' : 'Not sent. Run again with --yes to send it.'); out(''); return 0; }
  let suggestions;
  try { suggestions = await askSuggestions({ config, request, complete: guarded('suggestions', complete ?? (await import('../ai.mjs')).complete) }); } catch (error) {
    out(`✗ The model did not answer: ${String(error?.message ?? error).slice(0, 200)}`);
    return 1;
  }
  saveSuggestions(root, suggestions, { provider: config.provider, model: config.model ?? null });
  for (const item of suggestions) {
    out(`  ${item.path} ${item.block === 'unknown' ? 'stays Unknown' : `→ ${LABELS[item.block]} (suggested)`}: ${item.reason || 'no reason given'}`);
  }
  if (!suggestions.length) out('  The model gave no usable suggestion.');
  out('Suggestions stay marked as such. To keep one for good: codetac structure --reclassify <file> <block>');
  out('');
  return 0;
}

const describeSnapshot = item => `${item.id}  ${item.createdAt.replace('T', ' ').slice(0, 16)} UTC  ${item.source === 'commit' ? `commit ${item.commit.slice(0, 12)}`
  : item.commit ? `changes on top of commit ${item.commit.slice(0, 12)}` : 'no git'}  ${item.files} files${item.label ? `  "${item.label}"` : ''}`;

// Phase 10, step 2: what the user expects the next change to do, asked in the
// terminal before the snapshot is saved. Null when nothing was predicted.
async function askPrediction(graph, { ask, out }) {
  const paths = new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.path));
  out('Predict before you ask: what do you expect the change to do to the structure?');
  out('Separate items with commas; leave empty for none.');
  const files = {};
  for (const [list, question] of [['added', 'Files that will be added:'], ['changed', 'Files that will change:'], ['removed', 'Files that will be removed:']]) {
    files[list] = String(await ask(question) ?? '');
  }
  out(`Blocks: ${LAYERS.map(layer => `${layer} (${LABELS[layer]})`).join(', ')}.`);
  const pairs = String(await ask('Blocks that will start depending on another (for example "interface -> logic"):') ?? '');
  const services = String(await ask('New external services (for example Stripe, OpenAI):') ?? '');
  const prediction = cleanPrediction({ files, dependsOn: pairs, services });
  const unknownBlocks = pairs.split(',').flatMap(item => item.split(/\s*(?:->|→)\s*/)).map(item => item.trim()).filter(item => item && !blockId(item));
  if (unknownBlocks.length) out(`  ! Not a block, left out: ${[...new Set(unknownBlocks)].join(', ')}`);
  const missing = [...(prediction?.files.changed ?? []), ...(prediction?.files.removed ?? [])].filter(path => !paths.has(path));
  if (missing.length) out(`  ! Not in the project now (kept, as you wrote them): ${missing.join(', ')}`);
  const already = (prediction?.files.added ?? []).filter(path => paths.has(path));
  if (already.length) out(`  ! Already in the project (kept, as you wrote them): ${already.join(', ')}`);
  return prediction;
}

// Phase 9, step 1: saving and listing the snapshots of the structure.
async function snapshotCommand(root, { snapshot, snapshots, predict, ask, out }) {
  if (snapshot) {
    let prediction = null;
    let read = null;
    if (predict) {
      if (!ask) { out('✗ --predict asks its questions in the terminal: run it in an interactive terminal.'); out(''); return 2; }
      read = await readProject(root);
      prediction = await askPrediction(read.graph, { ask, out });
      if (!prediction) out('  Nothing predicted: the snapshot is saved without a prediction.');
    }
    const { snapshot: saved, replaced, removed, problems } = await saveSnapshot(root, { label: snapshot.label, prediction, ...(read ? { graph: read.graph } : {}) });
    out(`✓ Snapshot ${replaced ? 'updated' : 'saved'}: ${describeSnapshot(saved)}`);
    if (replaced) out('  The structure was already saved in this state; the snapshot now has the current date.');
    out(saved.source === 'commit' ? '  Named by the commit: the folder has no changes that are not committed.'
      : '  Named by a hash of the files\' contents: ' + (saved.commit ? 'the folder has changes that are not committed.' : 'the folder is not in a git repository.'));
    if (removed.length) out(`  Only the newest ${readConfig(root).snapshots.keep ?? DEFAULT_KEEP} are kept: removed ${removed.join(', ')}.`);
    for (const problem of [...problems, ...(read?.problems ?? [])]) out(`  ! ${problem}`);
    if (prediction) out('  Your prediction is saved with it. After the change: codetac structure --diff');
    out('  Snapshots are kept in CodeTAC\'s data folder, never in the project.');
    out('');
  }
  if (snapshots) {
    const list = listSnapshots(root);
    if (!list.length) out('No snapshots of this project yet. To save one: codetac structure --snapshot [label]');
    else {
      out(`Snapshots of this project (${list.length}, newest first):`);
      for (const item of list) out(`  ${describeSnapshot(item)}`);
    }
    out('');
  }
  return 0;
}

// Phase 9, steps 3 and 5: what changed in the structure between two points —
// by default the newest snapshot and the folder now; a snapshot or a commit
// and now; or two of them — in sentences made by rules, the most important first.
const MARK = { alert: '!!', warning: '! ', info: '· ' };
function describePoint(point) {
  if (point.type === 'now') return 'the folder now';
  if (point.type === 'snapshot') return `snapshot ${describeSnapshot(point)}`;
  return `commit ${point.commit.slice(0, 12)}${point.ref !== point.commit && !point.commit.startsWith(point.ref) ? ` (${point.ref})` : ''}${point.date ? ` of ${point.date.slice(0, 10)}` : ''}${point.subject ? ` "${point.subject}"` : ''}`;
}
async function diffCommand(root, { points = [], out }) {
  const [fromRef, toRef] = points.length ? [points[0], points[1] ?? 'now'] : ['latest', 'now'];
  const from = await readPoint(root, fromRef, { readSnapshot });
  if (from.error) {
    out(fromRef === 'latest' && !points.length ? 'No snapshot of this project to compare with. Save one first: codetac structure --snapshot [label]' : `✗ ${from.error}`);
    if (from.missing && from.missing !== 'latest') out('  See the snapshots with: codetac structure --snapshots');
    out('');
    return points.length ? 2 : 0;
  }
  const to = await readPoint(root, toRef, { readSnapshot });
  if (to.error) { out(`✗ ${to.error}`); out(''); return 2; }
  const diff = diffGraphs(from.graph, to.graph);
  const sentences = changeSummary(diff, from.graph, to.graph);
  out(to.point.type === 'now' ? `Changes in the structure since ${describePoint(from.point)}:` : `Changes in the structure from ${describePoint(from.point)} to ${describePoint(to.point)}:`);
  if ([from, to].some(side => side.point.type === 'commit')) out('  (The commit was read from a temporary copy made with git archive, then removed; your folder and .git were not touched. codetac.structure.json and the .env files are taken from the folder now.)');
  if (!sentences.length) out(`  ${TEXT.diff.nothing}`);
  for (const sentence of sentences) {
    const touches = sentence.touches.length ? ` [${sentence.touches.join(', ')}]` : '';
    out(`  ${MARK[sentence.severity]} ${sentence.text}${touches}`);
    const proof = sentence.proof.slice(0, 3).map(item => `${item.file}:${item.line}`);
    if (proof.length) out(`       ${sentence.side === 'before' ? 'was at' : 'at'} ${proof.join(', ')}${sentence.proof.length > 3 ? ', …' : ''}`);
  }
  const alerts = sentences.filter(sentence => sentence.touches.length).length;
  if (alerts) out(`  ${t('diff.touching', { count: alerts })}`);
  if (from.point.prediction) printPrediction(comparePrediction(from.point.prediction, diff, from.graph, to.graph), out);
  for (const problem of [...from.problems, ...to.problems]) out(`  ! ${problem}`);
  out('');
  return 0;
}

// Phase 10, step 2: the prediction saved with the snapshot against what changed.
function printPrediction(result, out) {
  out('');
  out('Your prediction (saved with the snapshot):');
  if (!result.score.changed) {
    // Nothing changed yet: what was predicted is waiting, not wrong.
    out(`  ${TEXT.predict.waiting}`);
    out(`  ${TEXT.predict.predicted}:`);
    for (const item of result.wrong) out(`    · ${item.text}`);
    return;
  }
  out(`  ${t('predict.score', result.score)}`);
  for (const [list, mark, heading] of [['hits', '✓', TEXT.predict.hits], ['missed', '+', TEXT.predict.missed], ['wrong', '✗', TEXT.predict.wrong]]) {
    if (!result[list].length) continue;
    out(`  ${heading}:`);
    for (const item of result[list]) out(`    ${mark} ${item.text}${item.insteadText ? ` (${item.insteadText})` : ''}`);
  }
}

export async function structureCommand(root, { reclassify: change = null, suggest: wantsSuggestions = false, yes = false, confirm = null,
  snapshot = null, snapshots = false, predict = false, ask = null, diff = null, loadAiConfig = null, complete = null, out = text => process.stdout.write(`${text}\n`) } = {}) {
  if (snapshot || snapshots) return snapshotCommand(root, { snapshot, snapshots, predict, ask, out });
  if (diff) return diffCommand(root, { points: diff.points ?? [], out });
  if (change) {
    const [file, layer] = change;
    const result = reclassify(root, file ?? '', layer ?? '');
    if (result.error) { out(`✗ ${result.error}`); return 2; }
    if (layer === 'auto') out(`✓ ${result.path} goes back to the rules.${result.removed ? ` ${CONFIG_FILE} had nothing else and was removed.` : ''}`);
    else out(`✓ ${result.path} is now in ${LABELS[layer]} (manual).${result.created ? ` Saved in ${CONFIG_FILE}, at the project root.` : ''}`);
    out('');
  }
  if (wantsSuggestions) {
    const code = await suggest(root, { yes, confirm, loadAiConfig, complete, out });
    if (code) return code;
  }
  const { graph, problems } = await readProject(root);
  const files = graph.nodes.filter(node => node.kind === 'file');
  out(`Structure of ${graph.project.name}${graph.project.types.length ? ` (${graph.project.types.join(', ')})` : ''} · ${files.length} files`);
  for (const layer of LAYERS) {
    const inside = files.filter(node => node.block === `block:${layer}`);
    if (!inside.length) continue;
    const describe = node => `${node.path}${node.rule === 'manual' ? ' (manual)' : node.rule === 'ai-suggestion' ? ' (suggested)' : node.rule?.startsWith('config:') ? ` (${CONFIG_FILE} layers)` : ''}`;
    const all = layer === 'unknown';
    out(`  ${LABELS[layer]} (${inside.length}): ${inside.slice(0, all ? Infinity : SHOWN).map(describe).join(', ')}${!all && inside.length > SHOWN ? `, … ${inside.length - SHOWN} more` : ''}`);
  }
  const unknown = files.filter(node => node.block === 'block:unknown').length;
  if (files.length) out(`  ${Math.round((unknown / files.length) * 100)}% unknown.`);
  if (unknown) out(`  To place a file yourself: codetac structure --reclassify <file> <${LAYERS.filter(layer => layer !== 'unknown').join('|')}>`);
  // The data model (phase 6) and the structure's health (phase 8), in short;
  // the panel's views have the details and the proofs.
  const tables = graph.nodes.filter(node => node.kind === 'table');
  if (tables.length) {
    const label = table => `${table.name}${table.inferred ? ' (from use)' : table.rls ? (table.rls.enabled ? ' (RLS on)' : ' (RLS off)') : ''}`;
    out(`  Tables (${tables.length}): ${tables.slice(0, SHOWN).map(label).join(', ')}${tables.length > SHOWN ? `, … ${tables.length - SHOWN} more` : ''}`);
    const DATA = { 'no-rls-browser': 'has row level security off and is used from the browser', 'used-not-defined': 'is used but no schema file defines it',
      'defined-never-used': 'is defined but no code uses it' };
    for (const item of dataFindings(graph)) out(`  ${item.severity === 'alert' ? '!!' : '!'} Table ${item.table} ${DATA[item.kind]}.`);
  }
  const smells = structureSmells(graph, { root, thresholds: readConfig(root).smells });
  if (smells.length) {
    const count = {};
    for (const item of smells) count[item.kind] = (count[item.kind] ?? 0) + 1;
    const possible = smells.filter(item => item.certainty === 'possible').length;
    out(`  Structure health: ${smells.length} thing${smells.length === 1 ? '' : 's'} to look at (${Object.entries(count).map(([kind, n]) => `${kind} ${n}`).join(', ')}${possible ? `; ${possible} only possibly` : ''}). Details in the panel: Structure → Structure health.`);
  } else out('  Structure health: nothing to point out.');
  for (const note of graph.notes ?? []) out(`  Note: ${note.message}`);
  for (const problem of problems) out(`  ! ${problem}`);
  return 0;
}
