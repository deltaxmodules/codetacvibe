// `codetac hooks install | uninstall | status` (phase D1, step 5): the Claude
// Code hooks that tell CodeTAC when a prompt starts and ends. They are written
// in the project's .claude/settings.local.json (the user's own settings, not
// shared through git; never .claude/settings.json), only after showing what
// will be written and the user saying yes, and next to the hooks the user
// already has, which are never removed.
//
// The only write in the project. Undone by `uninstall`: when the file is still
// as install left it, the original is put back byte for byte (or the file is
// removed when there was none, and the .claude folder when install made it);
// when the user changed it since, only CodeTAC's entries are taken out. What
// install found is kept in CodeTAC's data folder (hooks-install.json).
//
// Each command names the node and the CodeTAC that installed it and the
// project's folder, and ends with a "#codetac-diff" comment by which it is
// recognised (the shell ignores it).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { install as codetacFolder } from '../home.mjs';
import { t } from '../structure/text.mjs';
import { archiveMoment, diffFolder, writeWhole } from './archive.mjs';
import { HOOK_EVENTS } from './hook.mjs';

export const SETTINGS = '.claude/settings.local.json';
const MARK = '#codetac-diff';
const TIMEOUT = 30;

const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const sha = data => createHash('sha256').update(data).digest('hex');
const isOurs = hook => typeof hook?.command === 'string' && hook.command.includes(MARK);

// The node to write in the hooks: the one on the PATH (/opt/homebrew/bin/node,
// /usr/local/bin/node) when it is the node running now, because the real path
// of a node installed by Homebrew names its version (…/Cellar/node/26.8.1/…)
// and is gone after an upgrade; otherwise the node running now.
export function stableNode(execPath = process.execPath, path = process.env.PATH ?? '') {
  let running;
  try { running = realpathSync(execPath); } catch { return execPath; }
  for (const folder of path.split(delimiter).filter(Boolean)) {
    const candidate = join(folder, 'node');
    try { if (realpathSync(candidate) === running) return candidate; } catch {}
  }
  return execPath;
}

export function hookCommand(root, event, { node = stableNode(), cli = join(codetacFolder, 'src', 'cli.mjs') } = {}) {
  return `${quote(node)} ${quote(cli)} hook ${event} --project ${quote(root)} ${MARK}`;
}

// The settings file as it is: { bytes (null when there is none), settings } or { error }.
function readSettings(root) {
  const path = join(root, SETTINGS);
  if (!existsSync(path)) return { bytes: null, settings: {} };
  const bytes = readFileSync(path);
  let settings;
  try { settings = JSON.parse(bytes.toString('utf8') || '{}'); } catch { return { error: t('hooks.notJson', { file: SETTINGS }) }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { error: t('hooks.notObject', { file: SETTINGS }) };
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) return { error: t('hooks.badHooks', { file: SETTINGS }) };
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) if (!Array.isArray(groups)) return { error: t('hooks.badEvent', { file: SETTINGS, event }) };
  return { bytes, settings };
}

// The settings without CodeTAC's entries (the user's hooks stay as they are).
function withoutOurs(settings) {
  const copy = structuredClone(settings);
  if (!copy.hooks) return copy;
  for (const [event, groups] of Object.entries(copy.hooks)) {
    const kept = groups.map(group => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter(hook => !isOurs(hook)) } : group))
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
    if (kept.length) copy.hooks[event] = kept; else delete copy.hooks[event];
  }
  if (!Object.keys(copy.hooks).length) delete copy.hooks;
  return copy;
}

function ourCommands(settings) {
  const found = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) for (const hook of group?.hooks ?? []) if (isOurs(hook)) found[event] = hook.command;
  }
  return found;
}

const stateFile = root => join(diffFolder(root), 'hooks-install.json');
function readState(root) {
  try { return JSON.parse(readFileSync(stateFile(root), 'utf8')); } catch { return null; }
}

// git must not share the file: it holds the folders of this computer.
function sharedByGit(root) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (inside.status !== 0) return false;
  const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', SETTINGS], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return ignored.status !== 0;
}

export function hooksStatus(root) {
  root = realpathSync(root);
  const read = readSettings(root);
  if (read.error) return { error: read.error };
  const commands = ourCommands(read.settings);
  const expected = Object.fromEntries(HOOK_EVENTS.map(event => [event, hookCommand(root, event)]));
  const installed = HOOK_EVENTS.filter(event => commands[event]);
  return { installed, current: installed.length === HOOK_EVENTS.length && HOOK_EVENTS.every(event => commands[event] === expected[event]), commands, expected };
}

export async function installHooks(root, { yes = false, confirm = null, out = text => process.stdout.write(`${text}\n`), node, cli } = {}) {
  root = realpathSync(root);
  const read = readSettings(root);
  if (read.error) { out(`✗ ${read.error}`); out(`  ${t('hooks.fixFirst')}`); return 2; }
  const commands = Object.fromEntries(HOOK_EVENTS.map(event => [event, hookCommand(root, event, { node, cli })]));
  const found = ourCommands(read.settings);
  if (HOOK_EVENTS.every(event => found[event] === commands[event])) { out(t('hooks.already', { file: SETTINGS })); return 0; }
  const next = withoutOurs(read.settings);
  next.hooks ??= {};
  for (const event of HOOK_EVENTS) (next.hooks[event] ??= []).push({ hooks: [{ type: 'command', command: commands[event], timeout: TIMEOUT }] });
  const others = Object.values(withoutOurs(read.settings).hooks ?? {}).reduce((sum, groups) => sum + groups.length, 0);
  out(t(read.bytes ? 'hooks.willChange' : 'hooks.willCreate', { file: SETTINGS }));
  for (const event of HOOK_EVENTS) out(`  ${event}: ${commands[event]}`);
  if (others) out(`  ${t('hooks.keepsOthers', { count: others })}`);
  if (/\/_npx\//.test(cli ?? codetacFolder)) out(`  ! ${t('hooks.npx')}`);
  out(`  ${t('hooks.what')}`);
  if (!yes) {
    if (!confirm) { out(`  ${t('hooks.needsYes')}`); return 2; }
    if (!(await confirm(t('hooks.confirm', { file: SETTINGS })))) { out(t('hooks.cancelled')); return 1; }
  }
  const createdFolder = !existsSync(join(root, '.claude'));
  if (createdFolder) mkdirSync(join(root, '.claude'));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  // What the file was is kept once, from the first install: a second install keeps it.
  const earlier = readState(root);
  const original = earlier && earlier.written === (read.bytes ? sha(read.bytes) : null) ? earlier
    : { original: read.bytes ? read.bytes.toString('base64') : null, createdFolder };
  // Written in place: the file keeps its permissions.
  writeFileSync(join(root, SETTINGS), text);
  writeWhole(stateFile(root), `${JSON.stringify({ ...original, written: sha(Buffer.from(text)), at: new Date().toISOString() })}\n`);
  out(t('hooks.installed', { file: SETTINGS }));
  // A first archive now: the first prompt then finds the cache warm (10 000
  // files: 1.8 s the first time, 0.2 s after).
  try { out(`  ${t('hooks.warmed', { count: archiveMoment(root).moment.files })}`); } catch {}
  if (sharedByGit(root)) out(`  ! ${t('hooks.notIgnored', { file: SETTINGS })}`);
  out(`  ${t('hooks.next')}`);
  return 0;
}

export async function uninstallHooks(root, { yes = false, confirm = null, out = text => process.stdout.write(`${text}\n`) } = {}) {
  root = realpathSync(root);
  const read = readSettings(root);
  if (read.error) { out(`✗ ${read.error}`); return 2; }
  if (!Object.keys(ourCommands(read.settings)).length) { out(t('hooks.none', { file: SETTINGS })); rmSync(stateFile(root), { force: true }); return 0; }
  const state = readState(root);
  const untouched = state && read.bytes && state.written === sha(read.bytes);
  out(t(untouched ? (state.original === null ? 'hooks.willRemoveFile' : 'hooks.willRestore') : 'hooks.willTakeOut', { file: SETTINGS }));
  if (!yes) {
    if (!confirm) { out(`  ${t('hooks.needsYes')}`); return 2; }
    if (!(await confirm(t('hooks.confirmRemove', { file: SETTINGS })))) { out(t('hooks.cancelled')); return 1; }
  }
  const path = join(root, SETTINGS);
  if (untouched && state.original === null) {
    rmSync(path, { force: true });
    if (state.createdFolder) { try { if (!readdirSync(join(root, '.claude')).length) rmdirSync(join(root, '.claude')); } catch {} }
  } else if (untouched) writeFileSync(path, Buffer.from(state.original, 'base64'));
  else writeFileSync(path, `${JSON.stringify(withoutOurs(read.settings), null, 2)}\n`);
  rmSync(stateFile(root), { force: true });
  out(t('hooks.removed'));
  return 0;
}

export async function hooksCommand(root, action, options = {}) {
  const out = options.out ?? (text => process.stdout.write(`${text}\n`));
  if (action === 'install') return installHooks(root, options);
  if (action === 'uninstall') return uninstallHooks(root, options);
  const status = hooksStatus(realpathSync(root));
  if (status.error) { out(`✗ ${status.error}`); return 2; }
  if (!status.installed.length) out(t('hooks.statusNone'));
  else if (status.current) out(t('hooks.statusOn', { file: SETTINGS }));
  else out(t('hooks.statusOld', { file: SETTINGS }));
  return 0;
}
