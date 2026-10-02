// The file archive of the Diff (phase D1, step 2): a copy of the project's
// files at a moment (just before a prompt, just after it), kept outside the
// project in CodeTAC's data folder, <data>/diff/<project>/. Files are stored
// by content (objects/<2>/<hash>.gz), so a file that did not change between
// moments is stored once. A moment is a manifest: every file's path, content
// hash, size and date. The previous moment's manifest is the cache: a file
// with the same size and date is not read again, so a moment of a project
// whose files did not change costs a listing and one lstat per file.
//
// What is archived is what the plan reads: the files git lists (tracked and
// untracked, not ignored) or, without git, the folder walked with its
// .gitignore files; never dependencies nor build output (listFiles). Two
// exceptions:
//   - .env* files: only their variable names are kept ("KEY=" lines), never a
//     value, so the plan of a moment still knows the variables and the archive
//     holds no secret;
//   - .claude/settings.local.json: where the hooks are installed (D1, step 5),
//     not the user's code.
//   - keys of known shapes written in the code are masked (maskedCode).
// Files over 2 MB are listed with their hash but not copied.
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dataDirectory } from '../home.mjs';
import { listFiles } from '../structure/node/inventory.mjs';
import { KEY_PREFIX, KEY_SHAPES } from '../structure/node/modules.mjs';
import { t } from '../structure/text.mjs';

export const ARCHIVE_VERSION = 1;
export const MAX_STORED_SIZE = 2 * 1024 * 1024;
const LEFT_OUT = new Set(['.claude/settings.local.json']);
export const MOMENT_ID = /^m-[0-9a-f]{16}$/;

export const isEnvFile = path => basename(path).startsWith('.env');

// The folder of a project's Diff data (prompts, moments, objects).
export function diffFolder(root) {
  return join(dataDirectory(), 'diff', createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 32));
}

// Written whole or not at all: a half-written file would be read as broken.
export function writeWhole(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

// A .env file as only its variable names: "KEY=" per line, nothing else.
export function envNames(buffer) {
  const names = [];
  for (const line of buffer.toString('utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line);
    if (match) names.push(`${match[1]}=`);
  }
  return Buffer.from(names.length ? `${names.join('\n')}\n` : '');
}

// A text file with the keys of known shapes written in it (Stripe, AWS,
// GitHub…, modules.mjs) masked: the prefix and the length stay, every letter
// and digit after them becomes X, so the plan of the moment still finds a key
// of that kind on that line, but the archive holds no value. A JWT keeps its
// header and payload (the plan reads the role) and loses its signature; a
// private key block keeps its first and last lines. Returns null when nothing
// was masked (or the file is binary).
const X = text => text.replace(/[0-9A-Za-z]/g, 'X');
export function maskedCode(buffer) {
  if (buffer.subarray(0, 8000).includes(0)) return null;
  const text = buffer.toString('utf8');
  let masked = text;
  for (const [kind, shape] of KEY_SHAPES) {
    if (kind === 'private-key') continue;
    masked = masked.replace(new RegExp(shape.source, 'g'), match => {
      const prefix = match.match(KEY_PREFIX)?.[0] ?? '';
      return prefix + X(match.slice(prefix.length));
    });
  }
  masked = masked.replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g, (match, begin, body, end) => begin + X(body) + end);
  masked = masked.replace(/\b(eyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.)([0-9A-Za-z_-]{8,})/g, (match, start, signature) => start + X(signature));
  return masked === text ? null : Buffer.from(masked);
}

const hashOf = buffer => createHash('sha256').update(buffer).digest('hex');
const objectPath = (folder, hash) => join(folder, 'objects', hash.slice(0, 2), `${hash}.gz`);
const momentPath = (folder, id) => join(folder, 'moments', `${id}.json.gz`);

export function readMoment(root, id, folder = diffFolder(root)) {
  if (!MOMENT_ID.test(id ?? '')) return null;
  try {
    const moment = JSON.parse(gunzipSync(readFileSync(momentPath(folder, id))).toString('utf8'));
    return moment?.version === ARCHIVE_VERSION && moment.id === id ? moment : null;
  } catch { return null; }
}

function latestMoment(folder) {
  try {
    const { id } = JSON.parse(readFileSync(join(folder, 'latest.json'), 'utf8'));
    return id;
  } catch { return null; }
}

// Archives the project as it is now. Returns { moment: { id, createdAt, files
// (count) }, read (files read), stored (objects written), ms }. The same
// contents archived twice give the same moment id.
export function archiveMoment(root, { now = new Date() } = {}) {
  const started = Date.now();
  const real = realpathSync(root);
  const folder = diffFolder(real);
  const previous = readMoment(real, latestMoment(folder), folder);
  const known = previous?.files ?? {};
  const knownHashes = new Set(Object.values(known).map(entry => entry[0]));
  const { files: paths } = listFiles(real);
  const files = {};
  let read = 0;
  let stored = 0;
  for (const path of paths) {
    if (LEFT_OUT.has(path)) continue;
    let stat;
    try { stat = lstatSync(join(real, path)); } catch { continue; }
    if (!stat.isFile()) continue;
    const before = known[path];
    const env = isEnvFile(path);
    if (before && before[1] === stat.size && before[2] === stat.mtimeMs) { files[path] = before; continue; }
    let buffer;
    try { buffer = readFileSync(join(real, path)); } catch { continue; }
    read++;
    // A .env keeps only its names, and a file with keys written in it is
    // masked; both keep the hash of their real content (as the plan's graph
    // and the snapshots do), so a moment compares with the folder now.
    const large = !env && buffer.length > MAX_STORED_SIZE;
    const kept = env ? envNames(buffer) : large ? null : maskedCode(buffer);
    const realHash = kept ? hashOf(buffer) : null;
    if (kept) buffer = kept;
    const hash = hashOf(buffer);
    // [hash, size on disk, date on disk, flag, real hash]: "names" for a .env
    // (only its names were kept), "masked" (keys masked), "large" (not copied).
    const flag = env ? 'names' : large ? 'large' : kept ? 'masked' : null;
    files[path] = realHash ? [hash, stat.size, stat.mtimeMs, flag, realHash] : flag ? [hash, stat.size, stat.mtimeMs, flag] : [hash, stat.size, stat.mtimeMs];
    if (flag === 'large' || knownHashes.has(hash)) continue;
    const target = objectPath(folder, hash);
    try { lstatSync(target); continue; } catch {}
    writeWhole(target, gzipSync(buffer, { level: 1 }));
    knownHashes.add(hash);
    stored++;
  }
  const id = `m-${hashOf(Object.keys(files).sort().map(path => `${path}\0${files[path][4] ?? files[path][0]}`).join('\n')).slice(0, 16)}`;
  const createdAt = now.toISOString();
  // An unchanged project gives the moment it already has (only the cache of dates may differ: rewritten then).
  const same = previous?.id === id ? previous : readMoment(real, id, folder);
  if (!same || Object.keys(files).some(path => same.files[path]?.[2] !== files[path][2])) {
    writeWhole(momentPath(folder, id), gzipSync(JSON.stringify({ version: ARCHIVE_VERSION, id, createdAt: same?.createdAt ?? createdAt, files })));
  }
  writeWhole(join(folder, 'latest.json'), `${JSON.stringify({ id })}\n`);
  // Which project this folder is (the panel finds it without a recording, phase D3).
  const about = join(folder, 'project.json');
  try { lstatSync(about); } catch { writeWhole(about, `${JSON.stringify({ root: real, name: basename(real) })}\n`); }
  return { moment: { id, createdAt, files: Object.keys(files).length }, read, stored, ms: Date.now() - started };
}

// The content of one archived file, or null (not stored: a large file, or gone).
export function readArchived(root, hash, folder = diffFolder(root)) {
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) return null;
  try { return gunzipSync(readFileSync(objectPath(folder, hash))); } catch { return null; }
}

// Writes a moment's files into an empty folder (to read its plan, D1 step 6).
// Returns { written, missing: [paths not stored] }.
export function materialize(root, id, target) {
  const folder = diffFolder(root);
  const moment = readMoment(root, id, folder);
  if (!moment) throw new Error(t('prompts.noMoment', { id }));
  const missing = [];
  let written = 0;
  for (const [path, [hash, , , flag]] of Object.entries(moment.files)) {
    // A path from the manifest stays inside the target folder.
    if (path.startsWith('/') || path.split('/').includes('..')) { missing.push(path); continue; }
    const content = flag === 'large' ? null : readArchived(root, hash, folder);
    if (!content) { missing.push(path); continue; }
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), content);
    written++;
  }
  return { written, missing };
}

// What changed in the files between two moments: { added, removed, changed }
// (paths, sorted).
export function fileChanges(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  // A .env is compared by its real content's hash (a value changed is a change).
  const contentOf = entry => entry[4] ?? entry[0];
  for (const [path, entry] of Object.entries(after.files)) {
    if (!before.files[path]) added.push(path);
    else if (contentOf(before.files[path]) !== contentOf(entry)) changed.push(path);
  }
  for (const path of Object.keys(before.files)) if (!after.files[path]) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

// Keeps only the given moments: the other manifests, their kept plans and the
// objects no kept moment uses are removed. Returns { moments, objects } removed.
export function collect(root, keep) {
  const folder = diffFolder(root);
  const kept = new Set(keep);
  const used = new Set();
  let moments = 0;
  let names = [];
  try { names = readdirSync(join(folder, 'moments')); } catch {}
  for (const name of names) {
    const id = name.replace(/\.json\.gz$/, '');
    if (kept.has(id)) {
      const moment = readMoment(root, id, folder);
      if (moment) { for (const entry of Object.values(moment.files)) used.add(entry[0]); continue; }
    }
    // A manifest still being written has a .tmp name: never removed here.
    if (name.endsWith('.json.gz')) { rmSync(join(folder, 'moments', name), { force: true }); moments++; }
  }
  // The plans kept for moments that are gone (moments.mjs).
  let graphs = [];
  try { graphs = readdirSync(join(folder, 'graphs')); } catch {}
  for (const name of graphs) if (name.endsWith('.json.gz') && !kept.has(name.slice(0, -8))) rmSync(join(folder, 'graphs', name), { force: true });
  let objects = 0;
  let prefixes = [];
  try { prefixes = readdirSync(join(folder, 'objects')); } catch {}
  for (const prefix of prefixes) {
    for (const name of readdirSync(join(folder, 'objects', prefix))) {
      if (!name.endsWith('.gz') || used.has(name.slice(0, -3))) continue;
      rmSync(join(folder, 'objects', prefix, name), { force: true });
      objects++;
    }
  }
  return { moments, objects };
}

// A lock for the project's Diff data: hooks of the same project may run at the
// same time (a Stop and a SubagentStop). Held for a few ms; a lock older than
// 10 s is left by a process that died and is taken over.
export function withLock(root, work, { wait = 3000 } = {}) {
  const folder = diffFolder(root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, 'lock');
  const until = Date.now() + wait;
  for (;;) {
    try {
      const handle = openSync(path, 'wx', 0o600);
      writeSync(handle, String(process.pid));
      closeSync(handle);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - lstatSync(path).mtimeMs > 10_000) { rmSync(path, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(t('prompts.locked'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try { return work(); } finally { rmSync(path, { force: true }); }
}
