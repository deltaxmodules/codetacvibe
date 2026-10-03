// The event log of the live mode (phase L1): what the coding assistant does,
// tool by tool, kept outside the project in <data>/live/<project>/.
//
// How an event gets here (docs/live/ensaio-captura.md, option 3):
//   - the Claude Code hooks of each tool use run capture.sh, which only puts
//     the event's JSON, as it came, in a file of its own in spool/ (no node,
//     no measurable delay to the agent);
//   - ingest(), run by the Stop and SessionEnd hooks (and, from L3, by the
//     panel), reads spool/ in the order the files were written, keeps only
//     what the live window needs, redacted, appends it to
//     sessions/<session>.jsonl (append only) and removes the raw files.
// What is never kept: the content written to files, the old and new text of
// an edit, what a command printed, what a file read held. The window shows
// none of it (V8), and the rules of L2 do not need it.
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../home.mjs';
import { readConfig } from '../structure/config.mjs';
import { withLock } from '../diff/archive.mjs';
import { DEFAULT_KEEP, projectRedactor } from '../diff/prompts.mjs';

export const EVENTS_VERSION = 1;
// The hooks that run capture.sh. Matched for every tool: the tools that do not
// matter to the window are left out by ingest().
// PermissionRequest comes the moment the assistant asks; the Notification "permission_prompt" only some
// seconds later (seen in the interactive test of L3: about 6 s), so the yellow band uses both.
export const LIVE_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest'];
export const CAPTURE_SCRIPT = fileURLToPath(new URL('./capture.sh', import.meta.url));
const KIND = { PreToolUse: 'start', PostToolUse: 'end', PostToolUseFailure: 'fail', Notification: 'notice', PermissionRequest: 'notice' };
// Tools that say nothing about what is built.
const SILENT = new Set(['ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const SPOOL_LIMIT = 4 * 1024 * 1024;
const SHORT = 200;
const COMMAND = 600;

export function liveFolder(root) {
  return join(dataDirectory(), 'live', createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 32));
}
export const spoolFolder = root => join(liveFolder(root), 'spool');
const sessionsFolder = root => join(liveFolder(root), 'sessions');
const safeName = session => String(session ?? 'unknown').replace(/[^\w.-]/g, '_').slice(0, 80) || 'unknown';
export const sessionPath = (root, session) => join(sessionsFolder(root), `${safeName(session)}.jsonl`);

// Writes one raw event in spool/, as capture.sh does (used where there is no
// sh, as on Windows: `codetac hook Capture`).
export function spoolEvent(root, text) {
  const folder = spoolFolder(root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(folder, `${name}.tmp`), text, { mode: 0o600 });
  // rename keeps the date the event was written, which orders it.
  renameSync(join(folder, `${name}.tmp`), join(folder, `${name}.json`));
  return { spooled: `${name}.json` };
}

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

// The body of each heredoc ("cat > a.ts <<'EOF' … EOF") taken out of a shell line: it is the content written.
export function withoutHeredocs(command) {
  const lines = String(command).split('\n');
  const out = [];
  let until = null;
  for (const line of lines) {
    if (until) { if (line.trim() === until) { until = null; out.push(line); } continue; }
    out.push(line);
    const open = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (open) { until = open[2]; out.push('…'); }
  }
  return out.join('\n');
}

// The files a shell line removes: rm, rmdir, git rm (no wildcards).
export function shellDeletes(command) {
  const found = [];
  for (const segment of withoutHeredocs(command).split(/&&|\|\||;|\n|\|/)) {
    const parts = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const args = parts[0] === 'git' && parts[1] === 'rm' ? parts.slice(2) : ['rm', 'rmdir'].includes(parts[0]) ? parts.slice(1) : [];
    for (const arg of args) {
      const clean = arg.replace(/^(['"])(.*)\1$/, '$2');
      if (!clean.startsWith('-') && !/[*?$]/.test(clean) && !found.includes(clean)) found.push(clean);
    }
  }
  return found;
}

// The commands of a shell line, split on && || ; | and new lines outside quotes
// (sed -i '' "s|a|b|" file keeps its script whole).
function shellSegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\' && i + 1 < text.length) { current += char + text[++i]; continue; }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && text[i + 1] === '&')) {
      segments.push(current);
      current = '';
      if (text[i + 1] === char) i++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

// The files a shell line writes: redirections (> file, >> file, &> file), tee, cp and mv (the target),
// sed -i and touch. /dev/null and the streams (&1, &2) are not files. Paths as written in the line.
export function shellWrites(command) {
  const text = withoutHeredocs(command).replace(/\\\n/g, ' ');
  const found = [];
  const add = path => { const clean = path.replace(/^(['"])(.*)\1$/, '$2'); if (clean && !/^\/dev\/|^&|^\$|[*?]/.test(clean) && !found.includes(clean)) found.push(clean); };
  for (const match of text.matchAll(/(?:^|[\s;&|(])(?:\d?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) add(match[1]);
  for (const segment of shellSegments(text)) {
    const parts = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const args = parts.slice(1).filter(part => !part.startsWith('-') && !/^(\d?[<>]|&>)/.test(part));
    if (parts[0] === 'tee') args.forEach(add);
    if ((parts[0] === 'cp' || parts[0] === 'mv') && args.length >= 2) add(args.at(-1));
    if (parts[0] === 'touch') args.forEach(add);
    if (parts[0] === 'sed' && parts.some(part => /^-i/.test(part)) && args.length >= 2) add(args.at(-1));
  }
  return found;
}

// The tool input, kept to what names the action: paths, commands, task names.
function compactInput(tool, input, { redact, path }) {
  const text = (value, limit = SHORT) => (typeof value === 'string' && value ? cut(redact(value), limit) : undefined);
  const file = value => (typeof value === 'string' && value ? path(value) : undefined);
  switch (tool) {
    case 'Write': case 'Edit': case 'MultiEdit': case 'Read': return { file: file(input.file_path) };
    case 'NotebookEdit': return { file: file(input.notebook_path) };
    case 'Grep': return { pattern: text(input.pattern), path: file(input.path), glob: text(input.glob) };
    case 'Glob': return { pattern: text(input.pattern), path: file(input.path) };
    case 'Bash': case 'PowerShell': {
      // What a heredoc writes is code: it is never kept. The files the line writes are.
      const command = typeof input.command === 'string' ? input.command : '';
      const writes = shellWrites(command).map(file).filter(Boolean).slice(0, 30);
      const deletes = shellDeletes(command).map(file).filter(Boolean).slice(0, 30);
      return { command: text(withoutHeredocs(command), COMMAND), description: text(input.description), background: input.run_in_background === true || undefined,
        writes: writes.length ? writes : undefined, deletes: deletes.length ? deletes : undefined };
    }
    case 'TaskCreate': return { subject: text(input.subject), description: text(input.description) };
    case 'TaskUpdate': return { task: text(String(input.taskId ?? '')), status: text(input.status), subject: text(input.subject) };
    case 'TodoWrite': return { todos: Array.isArray(input.todos) ? input.todos.slice(0, 50).map(todo => ({ content: text(todo?.content), status: text(todo?.status) })) : undefined };
    case 'WebFetch': { let url; try { const parsed = new URL(input.url); url = `${parsed.origin}${parsed.pathname}`; } catch {} return { url: text(url) }; }
    case 'WebSearch': return { query: text(input.query) };
    case 'Task': case 'Agent': return { description: text(input.description), agent: text(input.subagent_type) };
    default: return {};
  }
}

// What the tool gave back, kept to its outcome.
function compactResult(tool, response) {
  if (!response || typeof response !== 'object') return {};
  if (tool === 'Write') return { change: response.type === 'create' ? 'created' : 'changed' };
  if (tool === 'Bash' || tool === 'PowerShell') return { interrupted: response.interrupted === true || undefined, background: typeof response.backgroundTaskId === 'string' || undefined };
  if (tool === 'TaskCreate') return { task: response.task?.id != null ? String(response.task.id) : undefined };
  if (tool === 'TaskUpdate') return { from: response.statusChange?.from, to: response.statusChange?.to };
  return {};
}

const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && !(typeof value === 'object' && value && !Array.isArray(value) && !Object.keys(value).length)));

// The real path of a file that may not exist yet (a Write before it runs):
// the part that exists, resolved (symbolic links, /var → /private/var on
// macOS), plus the rest.
function realish(path) {
  let head = path;
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch {}
    const parent = dirname(head);
    if (parent === head) return path;
    rest.unshift(basename(head));
    head = parent;
  }
}

// One raw hook event → the event kept, or null when it does not matter.
export function compactEvent(raw, { at, redact, root }) {
  const kind = KIND[raw?.hook_event_name];
  if (!kind) return null;
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  if (tool && SILENT.has(tool)) return null;
  const path = value => {
    const absolute = realish(isAbsolute(value) ? value : join(root, value));
    const inside = relative(root, absolute);
    return redact(inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : value);
  };
  const event = {
    v: EVENTS_VERSION,
    at,
    kind,
    prompt: typeof raw.prompt_id === 'string' ? raw.prompt_id : undefined,
    session: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    agent: typeof raw.agent_id === 'string' ? raw.agent_id : undefined,
    agentType: typeof raw.agent_type === 'string' ? raw.agent_type : undefined,
    tool,
    id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
  };
  if (raw.hook_event_name === 'PermissionRequest') return clean({ ...event, notice: 'permission_request' });
  if (kind === 'notice') return clean({ ...event, notice: typeof raw.notification_type === 'string' ? raw.notification_type : undefined, message: typeof raw.message === 'string' ? cut(redact(raw.message), SHORT) : undefined });
  event.input = clean(compactInput(tool, raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {}, { redact, path }));
  if (kind === 'end') event.result = clean({ ok: true, ...compactResult(tool, raw.tool_response) });
  if (kind === 'fail') {
    const error = typeof raw.error === 'string' ? raw.error : '';
    const exit = /^\s*Exit code (\d+)/.exec(error);
    event.result = clean({ ok: false, exit: exit ? Number(exit[1]) : undefined, interrupted: raw.is_interrupt === true || undefined });
  }
  if (typeof raw.duration_ms === 'number') event.ms = raw.duration_ms;
  return clean(event);
}

// The raw files in spool/, in the order they were written.
function waiting(root) {
  const folder = spoolFolder(root);
  let names = [];
  try { names = readdirSync(folder).filter(name => name.endsWith('.json')); } catch { return []; }
  const files = [];
  for (const name of names) {
    try { files.push({ path: join(folder, name), name, time: statSync(join(folder, name), { bigint: true }).mtimeNs }); } catch {}
  }
  return files.sort((a, b) => (a.time === b.time ? a.name.localeCompare(b.name) : a.time < b.time ? -1 : 1));
}

// Moves what spool/ holds into the sessions' logs. Returns { added, dropped }.
export function ingest(root, { env = process.env } = {}) {
  root = realpathSync(root);
  if (!waiting(root).length) return { added: 0, dropped: 0 };
  return withLock(root, () => {
    const files = waiting(root);
    const redact = projectRedactor(root, env, 2 * COMMAND);
    const lines = new Map();
    let added = 0;
    let dropped = 0;
    for (const file of files) {
      let event = null;
      try {
        if (lstatSync(file.path).size <= SPOOL_LIMIT) {
          const raw = JSON.parse(readFileSync(file.path, 'utf8'));
          event = compactEvent(raw, { at: new Date(Number(file.time / 1_000_000n)).toISOString(), redact, root });
        }
      } catch {}
      if (event) {
        const path = sessionPath(root, event.session);
        if (!lines.has(path)) lines.set(path, []);
        lines.get(path).push(JSON.stringify(event));
        added++;
      } else dropped++;
    }
    if (lines.size) mkdirSync(sessionsFolder(root), { recursive: true, mode: 0o700 });
    for (const [path, list] of lines) appendFileSync(path, `${list.join('\n')}\n`, { mode: 0o600 });
    // Removed only once their events are written: a failure above keeps them for the next time.
    for (const file of files) rmSync(file.path, { force: true });
    retain(root);
    return { added, dropped };
  });
}

// The events of a session, oldest first.
export function readSession(root, session) {
  let text = '';
  try { text = readFileSync(sessionPath(root, session), 'utf8'); } catch { return []; }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const event = JSON.parse(line); if (event?.v === EVENTS_VERSION) events.push(event); } catch {}
  }
  return events;
}

// The events of a prompt of the Diff's log (its id, and the ids of the
// subagents' notifications that continued it).
export function promptEvents(root, prompt) {
  if (!prompt) return [];
  const ids = new Set([prompt.id, ...(prompt.continuations ?? [])].filter(Boolean));
  return readSession(root, prompt.session).filter(event => ids.has(event.prompt));
}

// Keeps the logs of the newest sessions (diff.keep in codetac.structure.json).
function retain(root) {
  const keep = readConfig(root).diff?.keep ?? DEFAULT_KEEP;
  let names = [];
  try { names = readdirSync(sessionsFolder(root)).filter(name => name.endsWith('.jsonl')); } catch { return; }
  if (names.length <= keep) return;
  const dated = names.map(name => ({ name, time: statSync(join(sessionsFolder(root), name)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (const { name } of dated.slice(keep)) rmSync(join(sessionsFolder(root), name), { force: true });
}
