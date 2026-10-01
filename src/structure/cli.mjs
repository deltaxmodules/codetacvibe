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
  if (!unknown.length) { out(t('cli.suggest.nothingUnknown')); out(''); return 0; }
  const config = await (loadAiConfig ?? (async () => (await import('../ai.mjs')).loadConfig({ directory: dataDirectory() })))();
  if (!config?.provider) {
    out(t('cli.suggest.noModel', { problem: config?.problem ? ` (${config.problem})` : '' }));
    out(t('cli.suggest.noModelHow'));
    out('');
    return 0;
  }
  const reason = blocked('suggestions', config);
  if (reason) { out(blockedText(reason)); out(''); return 0; }
  const { files } = inventory(root);
  const modules = projectModules(root, files, { packages: describeProject(root).packages });
  const byPath = new Map(files.map(file => [file.path, file]));
  // Python files (phase 11): no exports in Python; their public symbols of the graph instead (def name, class Name).
  const pythonExports = node => graph.nodes.filter(item => item.kind === 'symbol' && item.file === node.id && item.exported)
    .map(item => ({ kind: item.symbolKind === 'function' ? 'def' : item.symbolKind, name: item.name }));
  const request = suggestionRequest(unknown.map(node => ({ path: node.path, hash: byPath.get(node.path)?.hash ?? node.hash,
    exports: node.language === 'python' ? pythonExports(node) : modules.get(node.path)?.exports ?? [] })), { types: graph.project.types });
  const where = config.local ? t('cli.suggest.local') : '';
  out(t('cli.suggest.exactly', { provider: config.provider, model: config.model ? ` (${config.model})` : '', where }));
  out('-----');
  out(request.text);
  out('-----');
  out(t('cli.suggest.instructions'));
  out(SUGGEST_SYSTEM);
  out('-----');
  if (request.left) out(t('cli.suggest.left', { count: request.left }));
  const agreed = yes || (confirm ? await confirm(t('cli.suggest.ask')) : false);
  if (!agreed) { out(t(confirm ? 'cli.suggest.notSent' : 'cli.suggest.notSentYes')); out(''); return 0; }
  let suggestions;
  try { suggestions = await askSuggestions({ config, request, complete: guarded('suggestions', complete ?? (await import('../ai.mjs')).complete) }); } catch (error) {
    out(t('cli.suggest.noAnswer', { error: String(error?.message ?? error).slice(0, 200) }));
    return 1;
  }
  saveSuggestions(root, suggestions, { provider: config.provider, model: config.model ?? null });
  for (const item of suggestions) {
    out(`  ${item.path} ${item.block === 'unknown' ? t('cli.suggest.staysUnknown') : t('cli.suggest.suggested', { block: LABELS[item.block] })}: ${item.reason || t('cli.suggest.noReason')}`);
  }
  if (!suggestions.length) out(`  ${t('cli.suggest.none')}`);
  out(t('cli.suggest.keep'));
  out('');
  return 0;
}

const describeSnapshot = item => `${item.id}  ${item.createdAt.replace('T', ' ').slice(0, 16)} UTC  ${item.source === 'commit' ? t('cli.snapshot.commit', { commit: item.commit.slice(0, 12) })
  : item.commit ? t('cli.snapshot.onTop', { commit: item.commit.slice(0, 12) }) : t('cli.snapshot.noGit')}  ${t('cli.snapshot.files', { count: item.files })}${item.label ? `  "${item.label}"` : ''}`;

// Phase 10, step 2: what the user expects the next change to do, asked in the
// terminal before the snapshot is saved. Null when nothing was predicted.
async function askPrediction(graph, { ask, out }) {
  const paths = new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.path));
  out(t('cli.predict.intro'));
  out(t('cli.predict.separate'));
  const files = {};
  for (const [list, question] of ['added', 'changed', 'removed'].map(list => [list, t(`cli.predict.questions.${list}`)])) {
    files[list] = String(await ask(question) ?? '');
  }
  out(t('cli.predict.blocks', { list: LAYERS.map(layer => `${layer} (${LABELS[layer]})`).join(', ') }));
  const pairs = String(await ask(t('cli.predict.pairs')) ?? '');
  const services = String(await ask(t('cli.predict.services')) ?? '');
  const prediction = cleanPrediction({ files, dependsOn: pairs, services });
  const unknownBlocks = pairs.split(',').flatMap(item => item.split(/\s*(?:->|→)\s*/)).map(item => item.trim()).filter(item => item && !blockId(item));
  if (unknownBlocks.length) out(`  ! ${t('cli.predict.notBlock', { list: [...new Set(unknownBlocks)].join(', ') })}`);
  const missing = [...(prediction?.files.changed ?? []), ...(prediction?.files.removed ?? [])].filter(path => !paths.has(path));
  if (missing.length) out(`  ! ${t('cli.predict.notInProject', { list: missing.join(', ') })}`);
  const already = (prediction?.files.added ?? []).filter(path => paths.has(path));
  if (already.length) out(`  ! ${t('cli.predict.already', { list: already.join(', ') })}`);
  return prediction;
}

// Phase 9, step 1: saving and listing the snapshots of the structure.
async function snapshotCommand(root, { snapshot, snapshots, predict, ask, out }) {
  if (snapshot) {
    let prediction = null;
    let read = null;
    if (predict) {
      if (!ask) { out(t('cli.snapshot.needsTerminal')); out(''); return 2; }
      read = await readProject(root);
      prediction = await askPrediction(read.graph, { ask, out });
      if (!prediction) out(`  ${t('cli.snapshot.nothingPredicted')}`);
    }
    const { snapshot: saved, replaced, removed, problems } = await saveSnapshot(root, { label: snapshot.label, prediction, ...(read ? { graph: read.graph } : {}) });
    out(t(replaced ? 'cli.snapshot.updated' : 'cli.snapshot.saved', { snapshot: describeSnapshot(saved) }));
    if (replaced) out(`  ${t('cli.snapshot.sameState')}`);
    out(`  ${t(saved.source === 'commit' ? 'cli.snapshot.byCommit' : saved.commit ? 'cli.snapshot.byHashChanges' : 'cli.snapshot.byHashNoGit')}`);
    if (removed.length) out(`  ${t('cli.snapshot.removed', { keep: readConfig(root).snapshots.keep ?? DEFAULT_KEEP, list: removed.join(', ') })}`);
    for (const problem of [...problems, ...(read?.problems ?? [])]) out(`  ! ${problem}`);
    if (prediction) out(`  ${t('cli.snapshot.predictionSaved')}`);
    out(`  ${t('cli.snapshot.where')}`);
    out('');
  }
  if (snapshots) {
    const list = listSnapshots(root);
    if (!list.length) out(t('cli.snapshot.none'));
    else {
      out(t('cli.snapshot.list', { count: list.length }));
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
  if (point.type === 'now') return t('cli.diff.now');
  if (point.type === 'snapshot') return t('cli.diff.snapshot', { snapshot: describeSnapshot(point) });
  return t('cli.diff.commit', { commit: point.commit.slice(0, 12), ref: point.ref !== point.commit && !point.commit.startsWith(point.ref) ? ` (${point.ref})` : '',
    date: point.date ? ` ${t('cli.diff.of', { date: point.date.slice(0, 10) })}` : '', subject: point.subject ? ` "${point.subject}"` : '' });
}
async function diffCommand(root, { points = [], out }) {
  const [fromRef, toRef] = points.length ? [points[0], points[1] ?? 'now'] : ['latest', 'now'];
  const from = await readPoint(root, fromRef, { readSnapshot });
  if (from.error) {
    out(fromRef === 'latest' && !points.length ? t('cli.diff.noSnapshot') : `✗ ${from.error}`);
    if (from.missing && from.missing !== 'latest') out(`  ${t('cli.diff.seeSnapshots')}`);
    out('');
    return points.length ? 2 : 0;
  }
  const to = await readPoint(root, toRef, { readSnapshot });
  if (to.error) { out(`✗ ${to.error}`); out(''); return 2; }
  const diff = diffGraphs(from.graph, to.graph);
  const sentences = changeSummary(diff, from.graph, to.graph);
  out(to.point.type === 'now' ? t('cli.diff.since', { from: describePoint(from.point) }) : t('cli.diff.fromTo', { from: describePoint(from.point), to: describePoint(to.point) }));
  if ([from, to].some(side => side.point.type === 'commit')) out(`  ${t('cli.diff.temporaryCopy')}`);
  if (!sentences.length) out(`  ${TEXT.diff.nothing}`);
  for (const sentence of sentences) {
    const touches = sentence.touches.length ? ` [${sentence.touches.join(', ')}]` : '';
    out(`  ${MARK[sentence.severity]} ${sentence.text}${touches}`);
    const proof = sentence.proof.slice(0, 3).map(item => `${item.file}:${item.line}`);
    if (proof.length) out(`       ${t(sentence.side === 'before' ? 'cli.diff.wasAt' : 'cli.diff.at')} ${proof.join(', ')}${sentence.proof.length > 3 ? ', …' : ''}`);
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
  out(t('cli.diff.yourPrediction'));
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
    if (layer === 'auto') out(`${t('cli.reclassify.auto', { path: result.path })}${result.removed ? ` ${t('cli.reclassify.removed', { file: CONFIG_FILE })}` : ''}`);
    else out(`${t('cli.reclassify.manual', { path: result.path, block: LABELS[layer] })}${result.created ? ` ${t('cli.reclassify.created', { file: CONFIG_FILE })}` : ''}`);
    out('');
  }
  if (wantsSuggestions) {
    const code = await suggest(root, { yes, confirm, loadAiConfig, complete, out });
    if (code) return code;
  }
  const { graph, problems } = await readProject(root);
  const files = graph.nodes.filter(node => node.kind === 'file');
  out(t('cli.summary.title', { name: graph.project.name, types: graph.project.types.length ? ` (${graph.project.types.join(', ')})` : '', count: files.length }));
  for (const layer of LAYERS) {
    const inside = files.filter(node => node.block === `block:${layer}`);
    if (!inside.length) continue;
    const describe = node => `${node.path}${node.rule === 'manual' ? ` ${t('cli.summary.manual')}` : node.rule === 'ai-suggestion' ? ` ${t('cli.summary.suggested')}` : node.rule?.startsWith('config:') ? ` ${t('cli.summary.configLayers', { file: CONFIG_FILE })}` : ''}`;
    const all = layer === 'unknown';
    out(`  ${LABELS[layer]} (${inside.length}): ${inside.slice(0, all ? Infinity : SHOWN).map(describe).join(', ')}${!all && inside.length > SHOWN ? `, ${t('cli.summary.more', { count: inside.length - SHOWN })}` : ''}`);
  }
  const unknown = files.filter(node => node.block === 'block:unknown').length;
  if (files.length) out(`  ${t('cli.summary.unknown', { percent: Math.round((unknown / files.length) * 100) })}`);
  if (unknown) out(`  ${t('cli.summary.place', { layers: LAYERS.filter(layer => layer !== 'unknown').join('|') })}`);
  // The data model (phase 6) and the structure's health (phase 8), in short;
  // the panel's views have the details and the proofs.
  const tables = graph.nodes.filter(node => node.kind === 'table');
  if (tables.length) {
    const label = table => `${table.name}${table.inferred ? ` ${t('cli.summary.fromUse')}` : table.rls ? ` ${t(table.rls.enabled ? 'cli.summary.rlsOn' : 'cli.summary.rlsOff')}` : ''}`;
    out(`  ${t('cli.summary.tables', { count: tables.length, list: tables.slice(0, SHOWN).map(label).join(', ') + (tables.length > SHOWN ? `, ${t('cli.summary.more', { count: tables.length - SHOWN })}` : '') })}`);
    for (const item of dataFindings(graph)) out(`  ${item.severity === 'alert' ? '!!' : '!'} ${t(`cli.summary.data.${item.kind}`, { table: item.table })}`);
  }
  const smells = structureSmells(graph, { root, thresholds: readConfig(root).smells });
  if (smells.length) {
    const count = {};
    for (const item of smells) count[item.kind] = (count[item.kind] ?? 0) + 1;
    const possible = smells.filter(item => item.certainty === 'possible').length;
    out(`  ${t('cli.summary.health', { count: smells.length, kinds: Object.entries(count).map(([kind, n]) => `${kind} ${n}`).join(', '),
      possible: possible ? `; ${t('cli.summary.possible', { count: possible })}` : '' })}`);
  } else out(`  ${t('cli.summary.healthy')}`);
  for (const note of graph.notes ?? []) out(`  ${t('cli.summary.note', { message: note.message })}`);
  for (const problem of problems) out(`  ! ${problem}`);
  return 0;
}
