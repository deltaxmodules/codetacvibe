// Privacy control (StructureTAC phase 10, step 5): one place for everything
// CodeTAC can send to an AI model. Each kind of request has a switch, and a
// global «no AI» mode turns them all off. The settings live in CodeTAC's data
// folder (privacy.json) and are read again on every request, so a change made
// in the panel or in the terminal counts at once, everywhere.
//
// Every request goes through send(): it refuses what is switched off, and
// writes what is sent (the exact instructions and text) to a local log
// (ai-log.jsonl, in the same folder), which the Privacy screen shows. Nothing
// here leaves the machine; the log is never sent anywhere.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from './home.mjs';
import { t } from './structure/text.mjs';

const SETTINGS_VERSION = 1;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_LOGGED_TEXT = 20_000;

// The kinds of request, in the order of the screen. `automatic`: sent without
// a click (in the background). `defaultOn(config)`: the switch when the user
// never touched it. Purpose sentences are automatic and carry code, so with a
// model outside this computer they are off until the user turns them on
// (decision of the PO, 2026-09-30).
export const KINDS = [
  { id: 'purposes', automatic: true, defaultOn: config => Boolean(config?.local) },
  { id: 'questions', automatic: false, defaultOn: () => true },
  { id: 'suggestions', automatic: false, defaultOn: () => true },
  { id: 'explanations', automatic: false, defaultOn: () => true },
];
const IDS = new Set(KINDS.map(kind => kind.id));

export const settingsPath = () => join(dataDirectory(), 'privacy.json');
export const logPath = () => join(dataDirectory(), 'ai-log.jsonl');

function writeWhole(path, data) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

// What the user chose: { noAi, kinds: { id: true|false } } (only the switches
// they touched; the others follow their default).
export function readSettings() {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    if (saved?.version !== SETTINGS_VERSION) throw new Error();
    const kinds = {};
    for (const [id, value] of Object.entries(saved.kinds ?? {})) if (IDS.has(id) && typeof value === 'boolean') kinds[id] = value;
    return { noAi: saved.noAi === true, kinds };
  } catch { return { noAi: false, kinds: {} }; }
}

// change: { noAi?: boolean, kinds?: { id: boolean | null } } (null: back to the default).
export function writeSettings(change = {}) {
  const settings = readSettings();
  if (typeof change.noAi === 'boolean') settings.noAi = change.noAi;
  for (const [id, value] of Object.entries(change.kinds ?? {})) {
    if (!IDS.has(id)) continue;
    if (value === null) delete settings.kinds[id];
    else if (typeof value === 'boolean') settings.kinds[id] = value;
  }
  writeWhole(settingsPath(), `${JSON.stringify({ version: SETTINGS_VERSION, ...settings })}\n`);
  return settings;
}

// The state of every kind for this model: { noAi, kinds: [{ id, automatic, on, chosen, byDefault }] }.
export function privacyState(config) {
  const settings = readSettings();
  return {
    noAi: settings.noAi,
    kinds: KINDS.map(kind => {
      const byDefault = kind.defaultOn(config);
      const chosen = settings.kinds[kind.id] ?? null;
      return { id: kind.id, automatic: kind.automatic, byDefault, chosen, on: !settings.noAi && (chosen ?? byDefault) };
    }),
  };
}

// Why this kind may not be sent now (a code for the screen and the texts),
// or null when it may. The model being configured is checked elsewhere.
export function blocked(kind, config) {
  if (!IDS.has(kind)) return 'unknown-kind';
  const state = privacyState(config);
  if (state.noAi) return 'no-ai';
  const item = state.kinds.find(entry => entry.id === kind);
  if (item.on) return null;
  return item.chosen === false ? 'off' : 'off-not-local';
}

// The sentence for a reason of blocked().
export const blockedText = reason => t(`privacy.blocked.${reason}`);

export class PrivacyBlocked extends Error {
  constructor(kind, reason) {
    super(blockedText(reason));
    this.kind = kind;
    this.reason = reason;
  }
}

// The fingerprint of a request, the same the previews show.
export const requestHash = (system, text) => createHash('sha256').update(`${system}\n${text}`).digest('hex').slice(0, 32);

// Writes one request to the local log. Bounded: past 8 MB, the older half goes.
export function logSend({ kind, config, system, text, at = new Date().toISOString() }) {
  const path = logPath();
  const entry = { at, kind, provider: config?.provider ?? null, model: config?.model ?? null, local: Boolean(config?.local),
    hash: requestHash(system, text), chars: system.length + text.length,
    system: system.slice(0, MAX_LOGGED_TEXT), text: text.slice(0, MAX_LOGGED_TEXT), cut: system.length > MAX_LOGGED_TEXT || text.length > MAX_LOGGED_TEXT };
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  let size = 0;
  try { size = statSync(path).size; } catch {}
  if (size > MAX_LOG_BYTES) {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    writeWhole(path, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
  }
  return entry;
}

// The log, newest first.
export function readLog({ limit = 100 } = {}) {
  let lines = [];
  try { lines = readFileSync(logPath(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const entries = [];
  for (const line of lines.slice(-limit).reverse()) { try { entries.push(JSON.parse(line)); } catch {} }
  return entries;
}
export function clearLog() {
  rmSync(logPath(), { force: true });
}

// A request of one kind: refused when switched off, logged, then sent with
// `complete(config, system, text, schema)` (the AI layer's call).
export async function send(kind, complete, config, system, text, schema) {
  const reason = blocked(kind, config);
  if (reason) throw new PrivacyBlocked(kind, reason);
  logSend({ kind, config, system, text });
  return complete(config, system, text, schema);
}

// send() for one kind, with the signature of complete().
export const guarded = (kind, complete) => (config, system, text, schema) => send(kind, complete, config, system, text, schema);

// `codetac privacy`: the same screen in the terminal. options: { noAi: true|false|undefined,
// on: [kind], off: [kind], reset: [kind], log: number|null, clearLog }.
export function privacyCommand(options, { config, out = text => process.stdout.write(`${text}\n`) }) {
  const wrong = [...(options.on ?? []), ...(options.off ?? []), ...(options.reset ?? [])].filter(id => !IDS.has(id));
  if (wrong.length) { out(`Unknown kind: ${wrong.join(', ')}. Kinds: ${[...IDS].join(', ')}.`); return 2; }
  const kinds = {};
  for (const id of options.on ?? []) kinds[id] = true;
  for (const id of options.off ?? []) kinds[id] = false;
  for (const id of options.reset ?? []) kinds[id] = null;
  if (typeof options.noAi === 'boolean' || Object.keys(kinds).length) writeSettings({ noAi: options.noAi, kinds });
  if (options.clearLog) { clearLog(); out(t('privacy.cli.cleared')); }
  const state = privacyState(config);
  out(config?.provider ? `${t('privacy.page.modelActive', { model: config.model || config.provider, provider: config.provider })}. ${config.local ? t('privacy.page.modelLocal') : t('privacy.page.modelRemote')}`
    : t('privacy.page.modelNone'));
  out(state.noAi ? t('privacy.cli.noAiOn') : t('privacy.cli.noAiOff'));
  for (const kind of state.kinds) {
    const why = kind.chosen === null ? (kind.byDefault ? t('privacy.page.byDefaultOn') : t('privacy.page.byDefaultOff')) : t('privacy.page.yourChoice');
    out(`  ${kind.on ? 'on ' : 'off'}  ${kind.id.padEnd(13)} ${t(`privacy.kinds.${kind.id}.name`)} — ${why}`);
    out(`       ${t(`privacy.kinds.${kind.id}.carries`)}`);
  }
  if (options.log) {
    const log = readLog({ limit: options.log });
    out('');
    out(log.length ? t('privacy.cli.logTitle', { count: log.length }) : t('privacy.page.logEmpty'));
    for (const entry of log) {
      out(`--- ${entry.at} · ${entry.kind} · ${entry.model ?? entry.provider ?? ''}${entry.local ? ` · ${t('privacy.page.local')}` : ''}`);
      out(entry.text);
    }
  } else out(t('privacy.cli.hint', { path: logPath() }));
  return 0;
}
