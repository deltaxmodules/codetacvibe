// What the live window shows (phase L3), worked out from the files only: the
// newest prompt of the Diff's log (prompts.json), the events of its session
// (events.mjs) and their sentences (rules.mjs). Nothing here comes from the
// assistant's reasoning, a command's output, code or tokens (V8): the events
// do not hold them.
//
//   status   idle | working | waiting (asks for you) | problem (a failure being fixed) | done | interrupted
//   title    "Building:" — the first words of the prompt, by rule (no AI)
//   now      the step in progress: the assistant's task, or the area worked on (steps.mjs); before any step, the newest action
//   detail   the smaller line under it: the newest action and its file or command
//   next     the tasks not started yet (only with a task list)
//   done     the finished steps
//   actions  one line per finished action, repeats merged (the view the steps are compared with; L4b's details)
//   notice   the yellow band (waiting) or the quiet line (problem)
import { basename } from 'node:path';
import { readConfig } from '../structure/config.mjs';
import { listPrompts, readPrompt } from '../diff/prompts.mjs';
import { diffFolder } from '../diff/archive.mjs';
import { readSession } from './events.mjs';
import { translateSession } from './rules.mjs';
import { groupSteps } from './steps.mjs';

export const STATE_VERSION = 1;
export const DEFAULT_MIN_INTERVAL = 1500;
const TITLE_WORDS = 8;
const DONE_LIMIT = 30;

// "Add Google login and keep the users in the database. Use next-auth." → "Add Google login and keep the users in…".
export function promptTitle(text) {
  const first = String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const words = first.replace(/[.!?:;,]+$/, '').split(' ').filter(Boolean);
  return words.length > TITLE_WORDS ? `${words.slice(0, TITLE_WORDS).join(' ')}…` : words.join(' ');
}

const placeOf = event => {
  const input = event.input ?? {};
  if (input.file) return input.file;
  if (input.command) return input.command.length > 60 ? `${input.command.slice(0, 60)}…` : input.command;
  if (input.url) return input.url;
  return '';
};
const PLANNING = new Set(['task-create', 'task-start', 'task-done', 'task-update', 'task-read', 'todo', 'plan-mode', 'skill']);

// The rows of one prompt: its events (by its id and its continuations), translated with the whole session for the tasks' names.
export function promptRows(root, prompt) {
  if (!prompt) return [];
  const ids = new Set([prompt.id, ...(prompt.continuations ?? [])].filter(Boolean));
  return translateSession(readSession(root, prompt.session)).filter(row => ids.has(row.event.prompt));
}

// The plan's address for a step: the first file it touched that is inside the project (L4b). By area, the
// step's own files (a shell line that wrote files of several areas gives each step those of its area).
const inside = path => !/^(\/|~|\.\.)/.test(path);
const planFile = ({ actions, paths }) => (paths
  ? paths.find(inside)
  : actions.flatMap(item => item.files).find(file => file.change !== 'removed' && inside(file.path))?.path) ?? null;

export function windowState(prompt, rows, { minInterval = DEFAULT_MIN_INTERVAL, project = '', projectId = null } = {}) {
  const base = { v: STATE_VERSION, project, projectId, minInterval };
  if (!prompt) return { ...base, status: 'idle', title: '', now: null, detail: null, next: [], done: [], actions: [], steps: [], grouping: null, notice: null, prompt: null };
  const done = [];
  let now = null;
  let detail = null;
  let notice = null;
  const started = new Map();
  const merge = item => {
    const last = done.at(-1);
    if (last && last.text === item.text) { last.count++; last.at = item.at; return; }
    done.push({ ...item, count: 1 });
  };
  for (const { event, sentence } of rows) {
    if (event.kind === 'start') {
      // Anything the assistant does after asking means it was answered.
      if (notice?.kind === 'waiting') notice = null;
      if (!sentence) continue;
      if (sentence.waiting) { notice = { kind: 'waiting', text: sentence.text }; continue; }
      started.set(event.id, sentence);
      if (!PLANNING.has(sentence.rule)) {
        now = { text: sentence.text, rule: sentence.rule, area: sentence.area, at: event.at };
        detail = { text: sentence.text, place: placeOf(event), at: event.at };
      } else if (sentence.rule === 'task-start') now = { text: sentence.text, rule: sentence.rule, area: sentence.area, at: event.at };
      continue;
    }
    if (event.kind === 'end') {
      if (notice?.kind === 'waiting') notice = null;
      const sentence = started.get(event.id);
      // A failed test is over when a test passes; any other failure, when the next action works.
      if (notice?.kind === 'problem' && (notice.rule !== 'fail-test' || sentence?.rule === 'cmd-test')) notice = null;
      if (sentence && !PLANNING.has(sentence.rule) && sentence.area !== 'analysis') merge({ text: sentence.text, rule: sentence.rule, area: sentence.area, at: event.at, place: placeOf(event) });
      continue;
    }
    if (event.kind === 'fail' && sentence) { notice = { kind: 'problem', text: sentence.text, rule: sentence.rule }; continue; }
    if (event.kind === 'notice' && sentence?.waiting) notice = { kind: 'waiting', text: sentence.text };
  }
  const finished = !['running', 'waiting'].includes(prompt.status);
  const grouping = groupSteps(rows);
  const run = projectId ? `project:${projectId}` : null;
  const step = item => {
    const file = planFile(item);
    return {
      key: item.key, text: item.label, status: item.status, from: item.from, count: item.actions.length,
      // The technical details (V7), opened under the step in the window.
      actions: item.actions.slice(-30).map(({ text, place, ok, tool, files }) => ({ text, place, ok, tool, files: files.slice(0, 12) })),
      plan: run && file ? `/structure?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}` : null,
    };
  };
  const steps = grouping.steps.map(step);
  if (grouping.current && !finished) now = { text: grouping.current.label, step: true, area: grouping.current.area ?? null, at: grouping.current.actions.at(-1)?.at ?? null };
  // At the end, what was in progress is done; tasks never started stay as "Next".
  const doneSteps = steps.filter(item => item.status === 'done' || (finished && item.status === 'current'));
  const nextSteps = steps.filter(item => item.status === 'pending');
  let status = finished ? (prompt.status === 'interrupted' ? 'interrupted' : 'done') : 'working';
  if (!finished && notice?.kind === 'waiting') status = 'waiting';
  else if (!finished && notice?.kind === 'problem') status = 'problem';
  if (finished) { notice = null; now = null; detail = null; }
  return {
    ...base,
    status,
    title: promptTitle(prompt.text),
    prompt: { n: prompt.n, startedAt: prompt.startedAt, endedAt: prompt.endedAt ?? null, status: prompt.status },
    // At the end of the prompt: its report in the Diff and its changes on the plan (V6).
    links: finished && run ? { diff: `/diff?run=${encodeURIComponent(run)}&n=${prompt.n}`, plan: `/structure?run=${encodeURIComponent(run)}&view=diff&snapshot=prompt-${prompt.n}` } : null,
    now,
    detail,
    grouping: grouping.mode,
    next: nextSteps,
    done: doneSteps.slice(-DONE_LIMIT),
    steps,
    actions: done.slice(-DONE_LIMIT),
    notice,
  };
}

// The state of a project's newest prompt, or of prompt n (the history, L4b).
export function liveState(root, { project = basename(root), n = 'latest' } = {}) {
  const prompt = readPrompt(root, n);
  const minInterval = Number(readConfig(root).live?.minInterval) || DEFAULT_MIN_INTERVAL;
  return windowState(prompt, promptRows(root, prompt), { minInterval, project, projectId: basename(diffFolder(root)) });
}

// The project's prompts, newest first, for the history (L4b).
export function promptHistory(root, limit = 20) {
  return listPrompts(root).slice(-limit).reverse().map(prompt => ({ n: prompt.n, title: promptTitle(prompt.text), startedAt: prompt.startedAt, status: prompt.status }));
}
