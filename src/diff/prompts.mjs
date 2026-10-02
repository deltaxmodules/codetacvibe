// The prompt log of the Diff (phase D1, step 3): each prompt given to the
// coding assistant, with its number, session, times, text (redacted before
// it is saved) and the archived moments just before and just after it
// (archive.mjs). Kept in <data>/diff/<project>/prompts.json, never in the
// project.
//
// When a prompt ends (docs/diff/ensaio-hooks.md, the test of the Claude Code
// hooks):
//   - Stop with no background task running: the prompt is done;
//   - Stop while subagents still run in the background: the prompt waits
//     ("waiting"); their end comes as a new UserPromptSubmit whose text starts
//     with <task-notification>, which continues the same prompt, and the next
//     Stop with nothing running closes it;
//   - an interruption gives no Stop: the next prompt of the same session, or
//     the end of the session, closes it ("interrupted").
// Two sessions working in the same project at the same time cannot tell their
// changes apart: both prompts are marked "overlap".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from '../redact.mjs';
import { readConfig } from '../structure/config.mjs';
import { archiveMoment, collect, diffFolder, isEnvFile, withLock, writeWhole } from './archive.mjs';
import { collectInterpretations } from './request.mjs';
import { listFiles } from '../structure/node/inventory.mjs';
import { maskKeys } from '../structure/node/modules.mjs';

export const PROMPTS_VERSION = 1;
export const DEFAULT_KEEP = 50;
// Retention runs once the log is this many prompts over the limit, so most hooks skip it.
const COLLECT_SLACK = 10;
const TEXT_LIMIT = 4 * 1024;
const OPEN = new Set(['running', 'waiting']);
const NOTIFICATION = /^\s*<task-notification>/;

const logPath = root => join(diffFolder(root), 'prompts.json');

export function readLog(root) {
  try {
    const log = JSON.parse(readFileSync(logPath(root), 'utf8'));
    if (log?.version === PROMPTS_VERSION && Array.isArray(log.prompts)) return log;
  } catch {}
  return { version: PROMPTS_VERSION, prompts: [] };
}
export const writeLog = (root, log) => writeWhole(logPath(root), `${JSON.stringify(log)}\n`);

// The prompts, oldest first.
export const listPrompts = root => readLog(root).prompts;
// One prompt by its number, or the newest with 'latest'.
export function readPrompt(root, n = 'latest') {
  const prompts = listPrompts(root);
  return n === 'latest' ? prompts.at(-1) ?? null : prompts.find(prompt => prompt.n === Number(n)) ?? null;
}

// The values of the project's .env files, so a key pasted into a prompt is
// hidden. Every value counts, whatever its variable's name (SUPABASE_SERVICE_ROLE_KEY
// names no "secret"): each is given to the redactor under a name it hides.
function projectEnv(root) {
  const values = {};
  let paths = [];
  try { paths = listFiles(root).files.filter(isEnvFile); } catch {}
  for (const path of paths) {
    let text = '';
    try { text = readFileSync(join(root, path), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
      if (match) values[`PROJECT_SECRET_${Object.keys(values).length}`] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return values;
}

// The keys of known shapes (Stripe, AWS, GitHub…, as the plan masks them in
// code excerpts), then the values of the environment and of the project's .env.
export function redactPrompt(root, text, env = process.env) {
  return createRedactor({ ...env, ...projectEnv(root) }, TEXT_LIMIT)(maskKeys(String(text ?? '')));
}

const openIn = (log, session) => log.prompts.filter(prompt => OPEN.has(prompt.status) && (session === undefined || prompt.session === session));
const findPrompt = (log, id) => (id ? log.prompts.find(prompt => prompt.id === id || prompt.continuations?.includes(id)) : null);

function close(prompt, { after, status, end, at }) {
  prompt.after = after;
  prompt.status = status;
  prompt.end = end;
  prompt.endedAt = at;
}

// UserPromptSubmit. Returns { prompt, archive } for a new prompt, { continued }
// for a subagent's notification, or { ignored }.
export function startPrompt(root, { id = null, session = null, text = '', tool = 'claude-code', now = new Date(), env = process.env } = {}) {
  return withLock(root, () => {
    const log = readLog(root);
    const at = now.toISOString();
    if (NOTIFICATION.test(text)) {
      const open = openIn(log, session).at(-1);
      if (!open) return { ignored: 'notification' };
      open.status = 'running';
      if (id && id !== open.id) open.continuations = [...new Set([...(open.continuations ?? []), id])];
      writeLog(root, log);
      return { continued: open.n };
    }
    if (id && findPrompt(log, id)) return { ignored: 'known' };
    const archive = archiveMoment(root, { now });
    // A prompt of this session left running was interrupted: it ends where
    // this one begins. One waiting for its background work ends too, but that
    // work may still change files during this prompt: both overlap.
    let overlap = false;
    for (const prompt of openIn(log, session)) {
      const waiting = prompt.status === 'waiting';
      close(prompt, { after: archive.moment.id, status: waiting ? 'done' : 'interrupted', end: 'next-prompt', at });
      if (waiting) { delete prompt.waitingFor; prompt.overlap = true; overlap = true; }
    }
    const others = openIn(log).filter(prompt => prompt.session !== session);
    for (const prompt of others) prompt.overlap = true;
    const prompt = {
      n: (log.prompts.at(-1)?.n ?? 0) + 1,
      id, session, tool,
      startedAt: at,
      text: redactPrompt(root, text, env),
      before: archive.moment.id,
      after: null,
      status: 'running',
      ...(others.length || overlap ? { overlap: true } : {}),
    };
    log.prompts.push(prompt);
    writeLog(root, log);
    return { prompt, archive };
  });
}

// Stop. background: the tasks Claude Code still runs (background_tasks).
export function stopPrompt(root, { id = null, session = null, background = [], now = new Date() } = {}) {
  return withLock(root, () => {
    const log = readLog(root);
    const prompt = findPrompt(log, id) ?? openIn(log, session).at(-1);
    if (!prompt || !OPEN.has(prompt.status)) return { ignored: prompt ? 'closed' : 'unknown' };
    const archive = archiveMoment(root, { now });
    const running = (Array.isArray(background) ? background : []).filter(task => task?.status === 'running').length;
    if (running) {
      // The files so far; the prompt ends when the background work does.
      prompt.after = archive.moment.id;
      prompt.status = 'waiting';
      prompt.waitingFor = running;
    } else {
      delete prompt.waitingFor;
      close(prompt, { after: archive.moment.id, status: 'done', end: 'stop', at: now.toISOString() });
    }
    const removed = retain(root, log);
    writeLog(root, log);
    return { prompt, archive, removed };
  });
}

// SessionEnd: what the session left open ends here.
export function endSession(root, { session = null, now = new Date() } = {}) {
  return withLock(root, () => {
    const log = readLog(root);
    const open = openIn(log, session);
    if (!open.length) return { ignored: 'nothing-open' };
    const archive = archiveMoment(root, { now });
    for (const prompt of open) close(prompt, { after: archive.moment.id, status: 'interrupted', end: 'session-end', at: now.toISOString() });
    writeLog(root, log);
    return { closed: open.map(prompt => prompt.n), archive };
  });
}

// Keeps the newest prompts (diff.keep in codetac.structure.json) and the
// moments they use, plus the newest moment (the cache of the next one).
function retain(root, log) {
  const keep = readConfig(root).diff?.keep ?? DEFAULT_KEEP;
  if (log.prompts.length <= keep + COLLECT_SLACK) return null;
  log.prompts = log.prompts.slice(-keep);
  collectInterpretations(root, log.prompts.map(prompt => prompt.n));
  const moments = new Set(log.prompts.flatMap(prompt => [prompt.before, prompt.after]).filter(Boolean));
  try { moments.add(JSON.parse(readFileSync(join(diffFolder(root), 'latest.json'), 'utf8')).id); } catch {}
  return collect(root, [...moments]);
}
