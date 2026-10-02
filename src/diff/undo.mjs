// Undoing a whole prompt (phase D6, step 3): the project's files go back to
// the moment archived just before the prompt; redoing it puts back the moment
// just after it. Both are previewed (what is put back, what is removed, what
// CodeTAC cannot write) and done only when confirmed with the preview's
// fingerprint, so what is done is exactly what was shown.
//
// Refused, never merged:
//   - while a prompt runs (its files are still changing);
//   - when a newer prompt exists (undoing this one would undo it too);
//   - when the files changed since the prompt ended (by hand or otherwise):
//     the project must be exactly the moment being left.
// The moment being left is already archived (the prompt's "after", or the one
// written by the undo), so redo always has it to go back to.
//
// Never written, only listed: .env files (only their names are archived),
// files with keys masked in the archive, files over 2 MB (not copied), links
// and paths outside the project. A file is left alone when either moment has
// it in one of those forms, so undo and redo stay each other's opposite.
// What is not archived is not touched either: ignored files (node_modules, a
// build folder), so dependencies a prompt installed stay installed.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { t } from '../structure/text.mjs';
import { archiveMoment, fileChanges, readArchived, readMoment, withLock } from './archive.mjs';
import { readLog, writeLog } from './prompts.mjs';

const OPEN = new Set(['running', 'waiting']);
const DEPENDENCIES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|uv\.lock)$/;
const safePath = path => !path.startsWith('/') && !path.split('/').includes('..') && !path.split('/').includes('');

// What going from one moment to another writes: { write, remove, skipped: [{ path, why }] }.
function switchFiles(from, to) {
  const changes = fileChanges(from, to);
  const write = [];
  const remove = [];
  const skipped = [];
  const why = path => {
    if (!safePath(path)) return 'path';
    const flags = [from.files[path]?.[3], to.files[path]?.[3]];
    if (flags.includes('names')) return 'env';
    if (flags.includes('masked')) return 'masked';
    if (flags.includes('large')) return 'large';
    return null;
  };
  for (const path of [...changes.added, ...changes.changed]) {
    const reason = why(path);
    if (reason) skipped.push({ path, why: reason });
    else write.push(path);
  }
  for (const path of changes.removed) {
    const reason = why(path);
    if (reason) skipped.push({ path, why: reason });
    else remove.push(path);
  }
  return { write: write.sort(), remove: remove.sort(), skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

// The plan of an undo ("undo") or a redo ("redo") of prompt n, from the log as
// it is; archives the folder now to compare it (outside the project). Returns
// { n, action, from, to, write, remove, skipped, dependencies, hash } or
// { refused, reason, ... }.
function planOf(root, log, n, action) {
  const prompt = log.prompts.find(item => item.n === Number(n));
  if (!prompt) return { refused: t('prompts.noPrompt', { n }), reason: 'no-prompt' };
  if (OPEN.has(prompt.status) || !prompt.after) return { refused: t('undo.running'), reason: 'running' };
  if (log.prompts.some(item => OPEN.has(item.status))) return { refused: t('undo.otherRunning'), reason: 'running' };
  const later = log.prompts.filter(item => item.n > prompt.n).map(item => item.n);
  if (later.length) return { refused: t('undo.later', { n: prompt.n, later: later.join(', ') }), reason: 'later', later };
  if (action === 'undo' && prompt.undone) return { refused: t('undo.already', { n: prompt.n }), reason: 'undone' };
  if (action === 'redo' && !prompt.undone) return { refused: t('undo.notUndone', { n: prompt.n }), reason: 'not-undone' };
  const fromId = action === 'undo' ? prompt.after : prompt.undone.moment;
  const toId = action === 'undo' ? prompt.before : prompt.after;
  const from = readMoment(root, fromId);
  const to = readMoment(root, toId);
  if (!from || !to) return { refused: t('undo.gone', { n: prompt.n }), reason: 'gone' };
  const now = archiveMoment(root).moment.id;
  if (now !== fromId) {
    const current = readMoment(root, now);
    const since = current ? fileChanges(from, current) : { added: [], changed: [], removed: [] };
    return { refused: t(action === 'undo' ? 'undo.changedSince' : 'undo.changedSinceUndo', { n: prompt.n }), reason: 'changed',
      changed: [...since.added, ...since.changed, ...since.removed].sort() };
  }
  const files = switchFiles(from, to);
  const dependencies = [...files.write, ...files.remove].some(path => DEPENDENCIES.test(path));
  const plan = { n: prompt.n, action, from: fromId, to: toId, ...files, dependencies };
  return { ...plan, hash: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

// The preview: what an undo or a redo of prompt n would do now.
export function previewSwitch(root, n, action = 'undo') {
  root = realpathSync(root);
  return withLock(root, () => planOf(root, readLog(root), n, action));
}

// Whether a path's folder is inside the project: its nearest folder that
// exists, with the links on the way followed, is the project or inside it.
function inside(root, target) {
  let folder = dirname(target);
  for (;;) {
    try { folder = realpathSync(folder); break; } catch {}
    const up = dirname(folder);
    if (up === folder) return false;
    folder = up;
  }
  return folder === root || folder.startsWith(root + sep);
}

// Writes one file as the archive has it, whole or not at all, keeping the
// mode of the file it replaces.
function writeFile(root, path, content) {
  const target = join(root, path);
  if (!inside(root, target)) return 'path';
  mkdirSync(dirname(target), { recursive: true });
  let mode;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile()) return 'link';
    mode = stat.mode & 0o7777;
  } catch {}
  const temporary = `${target}.codetac-${process.pid}.tmp`;
  writeFileSync(temporary, content, mode === undefined ? {} : { mode });
  renameSync(temporary, target);
  return null;
}

// Removes a file and the folders it leaves empty that the moment being
// restored does not have.
function removeFile(root, path, keep) {
  const target = join(root, path);
  try {
    if (!lstatSync(target).isFile()) return 'link';
  } catch { return null; }
  if (!inside(root, target)) return 'path';
  rmSync(target);
  for (let folder = dirname(path); folder !== '.' && folder !== ''; folder = dirname(folder)) {
    if (keep.has(folder)) break;
    try { if (readdirSync(join(root, folder)).length) break; rmdirSync(join(root, folder)); } catch { break; }
  }
  return null;
}

// Undo or redo prompt n, with the hash of the preview the person saw. Returns
// { n, action, written, removed, skipped, moment } or { refused, reason }.
export function applySwitch(root, n, action, hash, { now = new Date() } = {}) {
  root = realpathSync(root);
  return withLock(root, () => {
    const log = readLog(root);
    const plan = planOf(root, log, n, action);
    if (plan.refused) return plan;
    if (plan.hash !== hash) return { refused: t('undo.previewChanged'), reason: 'preview' };
    const to = readMoment(root, plan.to);
    const folders = new Set(Object.keys(to.files).flatMap(path => path.split('/').slice(0, -1).map((part, index, parts) => parts.slice(0, index + 1).join('/'))));
    const skipped = [...plan.skipped];
    let written = 0;
    let removed = 0;
    for (const path of plan.write) {
      const content = readArchived(root, to.files[path][0]);
      const problem = content ? writeFile(root, path, content) : 'gone';
      if (problem) skipped.push({ path, why: problem }); else written++;
    }
    for (const path of plan.remove) {
      const problem = removeFile(root, path, folders);
      if (problem) skipped.push({ path, why: problem }); else removed++;
    }
    const moment = archiveMoment(root, { now }).moment.id;
    const prompt = log.prompts.find(item => item.n === plan.n);
    if (action === 'undo') prompt.undone = { at: now.toISOString(), moment };
    else { delete prompt.undone; prompt.redoneAt = now.toISOString(); }
    writeLog(root, log);
    return { n: plan.n, action, written, removed, skipped, moment, dependencies: plan.dependencies, exact: moment === plan.to };
  });
}
