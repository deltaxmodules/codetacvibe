// `codetac structure`: the project's blocks in the terminal, and manual
// reclassification. Reading never writes into the project; only
// --reclassify does (codetac.structure.json).
import { readProject } from './readers.mjs';
import { reclassify, LAYERS, CONFIG_FILE } from './config.mjs';
import { suggestionRequest, askSuggestions, saveSuggestions } from './suggest.mjs';
import { inventory } from './node/inventory.mjs';
import { projectModules } from './node/modules.mjs';
import { describeProject } from './node/project.mjs';
import { dataDirectory } from '../home.mjs';
import { dataFindings } from './data.mjs';
import { structureSmells } from './smells.mjs';
import { readConfig } from './config.mjs';

import { TEXT } from './text.mjs';

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
  if (request.left) out(`(${request.left} more Unknown files are left for another run.)`);
  const agreed = yes || (confirm ? await confirm('Send it? [y/N]') : false);
  if (!agreed) { out(confirm ? 'Not sent.' : 'Not sent. Run again with --yes to send it.'); out(''); return 0; }
  let suggestions;
  try { suggestions = await askSuggestions({ config, request, complete: complete ?? (await import('../ai.mjs')).complete }); } catch (error) {
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

export async function structureCommand(root, { reclassify: change = null, suggest: wantsSuggestions = false, yes = false, confirm = null,
  loadAiConfig = null, complete = null, out = text => process.stdout.write(`${text}\n`) } = {}) {
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
