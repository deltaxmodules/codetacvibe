// The Request layer of the Diff (phase D4): what the prompt asked for, and
// what the AI did besides. The AI only reads the prompt: it writes it as a
// prediction in the terms of «Predict before you ask» (predict.mjs: files
// added, changed or removed, blocks that come to depend on others, new
// services), choosing from the project as it was just before the prompt. The
// comparison with what really changed is made by the rules (comparePrediction),
// never by the AI: "You asked" (predicted and changed), "The AI also did"
// (changed, not asked: outside the request), "Asked, not done".
//
// The interpretation is marked as one and can be edited by the user; an edit
// replaces it and the comparison is made again. It is kept in CodeTAC's data
// folder (<diff folder>/requests/<n>.json), never in the project, and goes
// with its prompt (retention, prompts.mjs).
//
// Sending: on request only, through the Privacy switch «requests» (and «No
// AI»), after a preview of the exact text; the text is the prompt as it was
// stored (already redacted), redacted again, with the paths of the project's
// files and the names of the blocks and services. Never code.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from '../redact.mjs';
import { readConfig, LAYERS } from '../structure/config.mjs';
import { diffGraphs } from '../structure/diff.mjs';
import { PREDICTION_VERSION, cleanPrediction, comparePrediction, normalPath, predictionChoices } from '../structure/predict.mjs';
import { serviceCatalogue } from '../structure/services.mjs';
import { TEXT, t } from '../structure/text.mjs';
import { diffFolder, writeWhole } from './archive.mjs';
import { readMomentGraph } from './moments.mjs';
import { readPrompt } from './prompts.mjs';

export const REQUEST_VERSION = 1;
// How many file paths go in the request (a large project is cut, and the request says so).
export const MAX_FILES = 800;
const MAX_REQUEST_BYTES = 256 * 1024;
const R = TEXT.ai.request;
export const SYSTEM = R.system;

const list = { type: 'array', items: { type: 'string' } };
export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files', 'dependsOn', 'services', 'note'],
  properties: {
    files: { type: 'object', additionalProperties: false, required: ['added', 'changed', 'removed'], properties: { added: list, changed: list, removed: list } },
    dependsOn: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: { from: { type: 'string', enum: LAYERS }, to: { type: 'string', enum: LAYERS } } } },
    services: list,
    note: { type: 'string' },
  },
};

const requestFile = (root, n) => join(diffFolder(root), 'requests', `${n}.json`);

// What the AI may choose from: the project just before the prompt.
export function requestChoices(root, graph) {
  return predictionChoices(graph, serviceCatalogue(readConfig(root).services).services);
}

// The exact request: { system, text, hash }. `prompt` is the stored prompt (its text is redacted already).
export function interpretationRequest(prompt, graph, choices) {
  // The redactor cuts at 10 KB by default: the paths of a large project would be lost without a word.
  const redact = createRedactor(process.env, MAX_REQUEST_BYTES);
  const types = graph.project?.types ?? [];
  const files = choices.files.slice(0, MAX_FILES);
  const lines = [
    t('ai.suggest.types', { types: types.length ? types.join(', ') : t('ai.suggest.notRecognised') }),
    '',
    R.prompt,
    `«${prompt.text}»`,
    '',
    choices.files.length > files.length ? t('ai.request.filesCut', { count: files.length, total: choices.files.length }) : R.files,
    ...files.map(path => `- ${path}`),
    '',
    R.blocks,
    ...choices.blocks.map(block => `- ${block.id.slice(6)}: ${block.name}`),
    '',
    R.services,
    choices.services.join(', '),
  ];
  const text = redact(lines.join('\n'));
  return { system: SYSTEM, text, hash: createHash('sha256').update(`${REQUEST_VERSION}\n${SYSTEM}\n${text}`).digest('hex').slice(0, 32) };
}

// The interpretation, kept only in the project's terms: a file that changes
// or goes must be a file of the project; a new one must not be (a path that
// exists is a change); a service must be one of the choices (by its name).
// Null when the answer is not an object; nothing left is an empty prediction (with the note).
export function checkInterpretation(answer, choices) {
  const prediction = cleanPrediction(answer);
  if (!prediction) return answer && typeof answer === 'object' ? emptyPrediction(answer.note) : null;
  const existing = new Set(choices.files);
  const added = [];
  const changed = new Set(prediction.files.changed.filter(path => existing.has(path)));
  for (const path of prediction.files.added) {
    if (existing.has(path)) changed.add(path);
    else if (/^[\w@.[\]()+-][\w@.[\]()+ /-]*$/.test(path) && !path.split('/').includes('..')) added.push(path);
  }
  const names = new Map(choices.services.map(name => [name.toLowerCase(), name]));
  return cleanPrediction({
    files: { added, changed: [...changed], removed: prediction.files.removed.filter(path => existing.has(path)) },
    dependsOn: prediction.dependsOn,
    services: prediction.services.map(name => names.get(name.toLowerCase())).filter(Boolean),
    note: prediction.note,
  }) ?? emptyPrediction(prediction.note);
}

// A prompt that asks for nothing in the structure (a text change, a fix inside a function).
export function emptyPrediction(note = '') {
  const text = String(note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { version: PREDICTION_VERSION, files: { added: [], changed: [], removed: [] }, dependsOn: [], services: [], ...(text ? { note: text } : {}) };
}

// The kept interpretation of prompt n: { source: 'ai'|'user', prediction, provider, model, at, hash } or null.
export function readInterpretation(root, n) {
  try {
    const saved = JSON.parse(readFileSync(requestFile(root, n), 'utf8'));
    return saved?.version === REQUEST_VERSION ? saved : null;
  } catch { return null; }
}
export function saveInterpretation(root, n, entry) {
  writeWhole(requestFile(root, n), `${JSON.stringify({ version: REQUEST_VERSION, ...entry })}\n`);
}
export function removeInterpretation(root, n) {
  rmSync(requestFile(root, n), { force: true });
}
// Retention: the interpretations of prompts that are gone.
export function collectInterpretations(root, kept) {
  const keep = new Set(kept.map(String));
  let names = [];
  try { names = readdirSync(join(diffFolder(root), 'requests')); } catch {}
  for (const name of names) if (name.endsWith('.json') && !keep.has(name.slice(0, -5))) rmSync(join(diffFolder(root), 'requests', name), { force: true });
}

// An edit by the user: the same lists, one item per line or separated by commas.
export function editedPrediction(input, choices) {
  const prediction = cleanPrediction(input);
  if (!prediction) return emptyPrediction(input?.note);
  // The user may name a new file anywhere; a path that exists is a change.
  const existing = new Set(choices.files);
  const added = prediction.files.added.filter(path => !existing.has(path)).map(normalPath);
  const changed = [...new Set([...prediction.files.changed, ...prediction.files.added.filter(path => existing.has(path))])];
  return cleanPrediction({ ...prediction, files: { added, changed, removed: prediction.files.removed } });
}

// The graphs before and after prompt n (the folder now while it runs: no comparison then).
async function graphsOf(root, prompt) {
  if (!prompt.after) return { error: t('ai.request.running') };
  const before = await readMomentGraph(root, prompt.before);
  if (before.error) return { error: before.error };
  const after = await readMomentGraph(root, prompt.after);
  if (after.error) return { error: after.error };
  return { before: before.graph, after: after.graph };
}

// The Request layer of prompt n: { interpretation, comparison: { asked, also, notDone, outside } } or null when none.
export async function requestLayer(root, n) {
  const prompt = readPrompt(root, n);
  const interpretation = prompt ? readInterpretation(root, prompt.n) : null;
  if (!interpretation) return null;
  const graphs = await graphsOf(root, prompt);
  if (graphs.error) return { interpretation, error: graphs.error };
  const result = comparePrediction(interpretation.prediction, diffGraphs(graphs.before, graphs.after), graphs.before, graphs.after);
  return { interpretation, comparison: { asked: result.hits, also: result.missed, notDone: result.wrong, outside: result.missed.length } };
}

// Everything the preview and the send need for prompt n: { prompt, graph, choices, request } or { error }.
export async function interpretationInput(root, n) {
  const prompt = readPrompt(root, n);
  if (!prompt) return { error: t('prompts.noPrompt', { n }) };
  if (!prompt.text.trim()) return { error: t('ai.request.noText') };
  const before = await readMomentGraph(root, prompt.before);
  if (before.error) return { error: before.error };
  const choices = requestChoices(root, before.graph);
  return { prompt, graph: before.graph, choices, request: interpretationRequest(prompt, before.graph, choices) };
}

// Asks the model and keeps the checked interpretation. `complete(config, system,
// text, schema)` is the AI layer's call, through Privacy (guarded('requests', …)).
export async function interpretPrompt({ root, n, config, complete, hash = null }) {
  const input = await interpretationInput(root, n);
  if (input.error) return input;
  if (hash && hash !== input.request.hash) return { error: t('service.factsChanged'), changed: true };
  const answer = await complete(config, input.request.system, input.request.text, SCHEMA);
  const entry = { source: 'ai', provider: config?.provider ?? null, model: config?.model ?? null, at: new Date().toISOString(), hash: input.request.hash,
    prediction: checkInterpretation(answer, input.choices) ?? emptyPrediction(answer?.note) };
  saveInterpretation(root, input.prompt.n, entry);
  return { interpretation: entry };
}
