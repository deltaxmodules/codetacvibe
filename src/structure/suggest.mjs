// AI suggestions for the files the rules leave Unknown (phase 1, step 7).
// Optional and only on request: the model receives the path of each Unknown
// file and the signatures of its exports (names, kinds, parameter names),
// never the body of the code. The user sees exactly what will be sent before
// it is sent. Answers are checked (only the paths sent, only real blocks) and
// kept outside the project, tied to the file's content hash: a changed file
// loses its suggestion. In the plan they are labelled as suggestions, and the
// rules and the user's reclassifications always win over them.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { createRedactor } from '../redact.mjs';
import { LAYERS } from './config.mjs';
import { TEXT, t } from './text.mjs';

const VERSION = 1;
const MAX_FILES = 60;
// The instructions and the meaning of each block live in text/en.json (ai.suggest).
export const SYSTEM = [
  TEXT.ai.suggest.system,
  ...Object.entries(TEXT.ai.suggest.blocks).map(([block, meaning]) => `- ${block}: ${meaning}`),
].join('\n');

export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'block', 'reason'],
    properties: { path: { type: 'string' }, block: { type: 'string', enum: LAYERS }, reason: { type: 'string' } } } } },
};

function signature(item) {
  const name = item.name === 'default' ? `default${item.local ? ` (${item.local})` : ''}` : item.name;
  if (item.kind === 'function') return `function ${name}(${(item.params ?? []).join(', ')})`;
  return `${item.kind === 'reexport' ? 're-export' : item.kind === 'binding' ? 'export' : item.kind} ${name}`;
}

// The exact text sent to the model, and the files it covers. `files` are the
// Unknown files: [{ path, hash, exports }].
export function suggestionRequest(files, { types = [] } = {}) {
  const chosen = files.slice(0, MAX_FILES);
  const redact = createRedactor();
  const lines = [t('ai.suggest.types', { types: types.length ? types.join(', ') : t('ai.suggest.notRecognised') }), '', t('ai.suggest.files')];
  for (const file of chosen) {
    const exports = (file.exports ?? []).map(signature);
    lines.push(`- ${file.path}: ${exports.length ? exports.join('; ') : t('ai.suggest.exportsNothing')}`);
  }
  return { text: redact(lines.join('\n')), files: chosen, left: files.length - chosen.length };
}

// Keeps only answers about the files sent, with a real block.
export function checkAnswer(answer, sent) {
  const paths = new Map(sent.map(file => [file.path, file]));
  const result = [];
  for (const item of Array.isArray(answer?.files) ? answer.files : []) {
    const file = paths.get(item?.path);
    if (!file || !LAYERS.includes(item.block) || result.some(other => other.path === item.path)) continue;
    result.push({ path: file.path, hash: file.hash, block: item.block, reason: String(item.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) });
  }
  return result;
}

function storePath(root) {
  return join(dataDirectory(), 'structure', 'suggestions', `${createHash('sha256').update(root).digest('hex').slice(0, 32)}.json`);
}

// Suggestions saved for a project: { path: { hash, block, reason, provider, model } }.
export function readSuggestions(root) {
  try {
    const saved = JSON.parse(readFileSync(storePath(root), 'utf8'));
    return saved.version === VERSION ? saved.files : {};
  } catch { return {}; }
}

export function saveSuggestions(root, suggestions, { provider, model }) {
  const files = { ...readSuggestions(root) };
  for (const item of suggestions) files[item.path] = { hash: item.hash, block: item.block, reason: item.reason, provider, model };
  const path = storePath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify({ version: VERSION, files }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// Asks the model. `complete(config, system, user, schema)` is the AI layer's
// call (injected in tests). Returns the checked suggestions.
export async function askSuggestions({ config, request, complete }) {
  const answer = await complete(config, SYSTEM, request.text, SCHEMA);
  return checkAnswer(answer, request.files);
}
