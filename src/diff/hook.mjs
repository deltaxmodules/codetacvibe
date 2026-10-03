// `codetac hook <event> --project <folder>` (phase D1, step 4): what the
// Claude Code hooks run (installed by `codetac hooks install`, step 5). It
// reads the event's JSON from stdin and opens or closes a prompt in the log
// (prompts.mjs). Two rules above all:
//   - it never gets in the way of the prompt: whatever goes wrong, it prints
//     nothing and exits with 0 (Claude Code adds what a UserPromptSubmit hook
//     prints to the prompt, and blocks the prompt on exit code 2). An error is
//     written to <data>/diff/<project>/errors.log;
//   - it is quick: UserPromptSubmit holds the prompt back while it runs
//     (docs/diff/ensaio-hooks.md), so it only archives files, with the cache.
// The panel is not called: it reads the log itself when asked (phase D3).
// Live mode (phase L1): Stop and SessionEnd also move the events that
// capture.sh kept for each tool use into the session's log (ingest), and
// `codetac hook Capture` keeps an event where there is no sh (Windows).
// When a prompt ends, a process of its own, not waited for, reads the plans of
// its two moments, so the bar's badge and the report are ready at once
// (phase D3; 4.5 s for 10 000 files, out of the prompt's way).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { diffFolder } from './archive.mjs';
import { endSession, startPrompt, stopPrompt } from './prompts.mjs';
import { ingest, spoolEvent } from '../live/events.mjs';
import { t } from '../structure/text.mjs';

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd'];
const STDIN_LIMIT = 4 * 1024 * 1024;
const ERRORS_LIMIT = 256 * 1024;

function readStdin() {
  try {
    const text = readFileSync(0, 'utf8');
    return text.length > STDIN_LIMIT ? text.slice(0, STDIN_LIMIT) : text;
  } catch { return ''; }
}

// The project: the folder written in the hook when it was installed; without
// it, the folder Claude Code was opened in.
function projectOf(project, input, env) {
  for (const candidate of [project, env.CLAUDE_PROJECT_DIR, input?.cwd]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try { if (statSync(candidate).isDirectory()) return realpathSync(candidate); } catch {}
  }
  return null;
}

function logError(root, event, error) {
  try {
    const folder = root ? diffFolder(root) : join(dataDirectory(), 'diff');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, 'errors.log');
    let size = 0;
    try { size = statSync(path).size; } catch {}
    if (size > ERRORS_LIMIT) return;
    const message = String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ').slice(0, 600);
    appendFileSync(path, `${new Date().toISOString()} ${event} ${message}\n`, { mode: 0o600 });
  } catch {}
}

// Runs one event. Returns what happened (for the tests); never throws.
export function runHook(event, { project = null, stdin = null, env = process.env, now = new Date(), warm = true } = {}) {
  let root = null;
  try {
    const text = stdin ?? readStdin();
    root = projectOf(project, null, env);
    let input = {};
    try { input = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error(t('prompts.hookNotJson', { count: text.length })); }
    root ??= projectOf(null, input, env);
    if (!root) throw new Error(t('prompts.hookNoProject'));
    if (event === 'Capture') return spoolEvent(root, text);
    const id = typeof input.prompt_id === 'string' ? input.prompt_id : null;
    const session = typeof input.session_id === 'string' ? input.session_id : null;
    if (event === 'UserPromptSubmit') return startPrompt(root, { id, session, text: typeof input.prompt === 'string' ? input.prompt : '', now, env });
    if (event === 'Stop') {
      const result = stopPrompt(root, { id, session, background: input.background_tasks ?? [], now });
      gather(root, env, event);
      if (result.prompt?.status === 'done' && warm) prepare(root, result.prompt.n);
      return result;
    }
    if (event === 'SessionEnd') {
      const result = endSession(root, { session, now });
      gather(root, env, event);
      return result;
    }
    throw new Error(t('prompts.hookUnknownEvent', { event: String(event).slice(0, 40) }));
  } catch (error) {
    logError(root, event, error);
    return { error: String(error?.message ?? error) };
  }
}

// The live mode's events, out of the waiting folder; a failure is logged and
// leaves them there for the next time.
function gather(root, env, event) {
  try { ingest(root, { env }); } catch (error) { logError(root, `${event} (live)`, error); }
}

function prepare(root, n) {
  try {
    const child = spawn(process.execPath, [new URL('../cli.mjs', import.meta.url).pathname, 'hook', 'Prepare', '--project', root, '--prompt', String(n)],
      { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch {}
}

// `codetac hook Prepare --project <folder> --prompt <n>`: the plans of a prompt's moments, kept.
export async function prepareReport(project, n) {
  let root = null;
  try {
    root = realpathSync(project);
    const { promptReport } = await import('./report.mjs');
    const report = await promptReport(root, n);
    if (report.error) throw new Error(report.error);
  } catch (error) { logError(root, 'Prepare', error); }
}
