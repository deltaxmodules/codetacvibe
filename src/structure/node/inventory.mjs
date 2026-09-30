// Inventory of a project folder (phase 1, step 3): every file, with its
// language, size, lines and content hash. Git decides what belongs to the
// project when the folder is in a repository (tracked and untracked, not
// ignored); otherwise the folder is walked with its .gitignore files. .env*
// files always count (configuration, and where variables are defined).
// Dependencies and build output never do. An incremental cache, outside the
// project, keeps the hash and lines of files that did not change.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { dataDirectory } from '../../home.mjs';

export const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.vercel',
  '.svelte-kit', '.nuxt', '.output', '.cache', '.parcel-cache', '.vite',
  // Python (phase 11): bytecode, tool caches and virtual environments (any folder with a pyvenv.cfg is one too).
  '__pycache__', '.venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.eggs', '.ipynb_checkpoints']);
const skippedName = name => SKIPPED_FOLDERS.has(name) || name.endsWith('.egg-info');
const CACHE_VERSION = 1;

export function languageOf(path) {
  const name = basename(path);
  if (name.startsWith('.env')) return 'dotenv';
  if (name.endsWith('.d.ts')) return 'ts';
  return { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.json': 'json',
    '.html': 'html', '.css': 'css', '.scss': 'css', '.sql': 'sql', '.md': 'markdown', '.mdx': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
    '.vue': 'vue', '.svelte': 'svelte', '.py': 'python', '.prisma': 'prisma', '.graphql': 'graphql', '.sh': 'shell' }[extname(path).toLowerCase()] ?? 'other';
}

const skipped = path => path.split('/').some(skippedName);

const isVirtualEnvironment = folder => { try { return lstatSync(join(folder, 'pyvenv.cfg')).isFile(); } catch { return false; } };

// A .gitignore glob as a regular expression: "**/" any folders, "/**" all
// below, "*" and "?" within one path segment.
export function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const rest = pattern.slice(index);
    if (rest.startsWith('**/')) { source += '(?:.*/)?'; index += 2; }
    else if (rest === '/**') { source += '/.*'; break; }
    else if (rest.startsWith('**')) { source += '.*'; index += 1; }
    else if (pattern[index] === '*') source += '[^/]*';
    else if (pattern[index] === '?') source += '[^/]';
    else source += pattern[index].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

// A .gitignore line as a test on a path relative to the file's folder. A
// pattern with a slash (other than at the end) is anchored to that folder.
function gitignoreRule(line) {
  let pattern = line.replace(/\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  const folderOnly = pattern.endsWith('/');
  if (folderOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  const regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globSource(pattern.replace(/^\//, ''))}(?:/.*)?$`);
  return { negated, test: (path, isFolder) => (folderOnly && !isFolder ? false : regex.test(path)) };
}

// Walks a folder that is not in a git repository, honouring .gitignore files.
function walk(root) {
  const files = [];
  const visit = (dir, rules) => {
    const here = [...rules];
    try {
      for (const line of readFileSync(join(root, dir, '.gitignore'), 'utf8').split('\n')) {
        const rule = gitignoreRule(line);
        if (rule) here.push({ ...rule, base: dir });
      }
    } catch {}
    const ignored = (path, isFolder) => {
      let result = false;
      for (const rule of here) {
        const local = rule.base ? (path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : null) : path;
        if (local != null && rule.test(local, isFolder)) result = !rule.negated;
      }
      return result;
    };
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skippedName(entry.name) && !isVirtualEnvironment(join(root, path)) && !ignored(path, true)) visit(path, here);
      } else if (entry.isFile() && (entry.name.startsWith('.env') || !ignored(path, false))) files.push(path);
    }
  };
  visit('', []);
  return files;
}

// .env* files anywhere in the project, even when git ignores them.
function envFiles(root) {
  const found = [];
  const visit = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink() && !skippedName(entry.name) && !isVirtualEnvironment(join(root, path))) visit(path);
      else if (entry.isFile() && entry.name.startsWith('.env')) found.push(path);
    }
  };
  visit('');
  return found;
}

function gitFiles(root) {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (inside !== 'true') return null;
    return execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
      .split('\0').filter(Boolean);
  } catch { return null; }
}

// Paths of the project's files, relative, with forward slashes, sorted.
// ignored(path) → true leaves a file out (the project's "ignore" setting).
export function listFiles(root, { ignored = null } = {}) {
  const listed = gitFiles(root);
  const source = listed ? 'git' : 'walk';
  const paths = new Set([...(listed ?? walk(root)), ...envFiles(root)]);
  // Virtual environments tracked by git (a pyvenv.cfg in the list): none of their files counts.
  const environments = [...paths].filter(path => path === 'pyvenv.cfg' || path.endsWith('/pyvenv.cfg')).map(path => path.slice(0, -'pyvenv.cfg'.length));
  const files = [...paths].filter(path => {
    if (skipped(path) || ignored?.(path) || environments.some(folder => path.startsWith(folder))) return false;
    try { return lstatSync(join(root, path)).isFile(); } catch { return false; }
  }).sort();
  return { files, source };
}

function cachePath(root) {
  return join(dataDirectory(), 'structure', 'cache', `${createHash('sha256').update(root).digest('hex').slice(0, 32)}.json`);
}

function readCache(root) {
  try {
    const cache = JSON.parse(readFileSync(cachePath(root), 'utf8'));
    return cache.version === CACHE_VERSION ? cache.files : {};
  } catch { return {}; }
}

function writeCache(root, files) {
  const path = cachePath(root);
  try {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: CACHE_VERSION, files }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch {}
}

// Lines as an editor counts them; binary files (a NUL byte early on) have none.
function countLines(buffer) {
  if (!buffer.length || buffer.subarray(0, 8000).includes(0)) return 0;
  let lines = 0;
  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) lines++;
  return buffer.at(-1) === 10 ? lines : lines + 1;
}

// The inventory: [{ path, language, size, lines, hash }] plus how many files
// were read and how many came from the cache.
export function inventory(root, { cache = true, ignored = null } = {}) {
  const { files, source } = listFiles(root, { ignored });
  const previous = cache ? readCache(root) : {};
  const next = {};
  const items = [];
  let read = 0;
  for (const path of files) {
    const stat = lstatSync(join(root, path));
    const known = previous[path];
    let entry;
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) entry = known;
    else {
      const buffer = readFileSync(join(root, path));
      entry = { size: buffer.length, mtimeMs: stat.mtimeMs, hash: createHash('sha256').update(buffer).digest('hex'), lines: countLines(buffer) };
      read++;
    }
    next[path] = entry;
    items.push({ path, language: languageOf(path), size: entry.size, lines: entry.lines, hash: entry.hash });
  }
  // Rewritten only when something changed (a read with nothing new is common in watch mode).
  const previousPaths = Object.keys(previous);
  if (cache && (read || previousPaths.length !== files.length || previousPaths.some(path => !(path in next)))) writeCache(root, next);
  return { files: items, source, read, cached: files.length - read };
}
