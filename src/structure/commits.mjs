// The structure of a commit (phase 9, step 5): the project folder as it was in
// that commit, read from a temporary copy made with `git archive` (outside the
// project, removed at the end). Nothing in the user's work changes: no
// checkout, no worktree, no stash; GIT_OPTIONAL_LOCKS=0 keeps even `git
// status`-like reads from touching the index. The copy is read without the
// incremental cache, so nothing of it is left in CodeTAC's data folder.
//
// Two things the commit does not hold are taken from the folder as it is now,
// so both sides are read by the same rules and only the code differs:
// codetac.structure.json (the user's layers and reclassifications) and the
// .env files (git ignores them; only their variable names are read).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readProject } from './readers.mjs';
import { CONFIG_FILE } from './config.mjs';

const ARCHIVE_LIMIT = 1024 * 1024 * 1024;

function git(root, args, options = {}) {
  return spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: ARCHIVE_LIMIT, ...options });
}
const text = result => (result.status === 0 ? String(result.stdout).trim() : null);

// The full hash and the subject of a commit, or { error }.
export function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\s\0]/.test(ref)) return { error: `${ref} is not a commit.` };
  if (text(git(root, ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })) !== 'true') return { error: 'The project folder is not in a git repository: compare with snapshots instead (codetac structure --snapshot).' };
  const commit = text(git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' }));
  if (!commit) return { error: `There is no commit ${ref} in this repository.` };
  const [date, ...subject] = (text(git(root, ['log', '-1', '--format=%cI%x09%s', commit], { encoding: 'utf8' })) ?? '').split('\t');
  return { commit, date: date || null, subject: subject.join('\t').slice(0, 120) };
}

// The latest commits that touched the project folder (for the panel's picker).
export function recentCommits(root, count = 15) {
  const out = text(git(root, ['log', `-${count}`, '--format=%H%x09%cI%x09%s', '--', '.'], { encoding: 'utf8' }));
  if (!out) return [];
  return out.split('\n').map(line => {
    const [commit, date, ...subject] = line.split('\t');
    return { commit, date, subject: subject.join('\t').slice(0, 120) };
  });
}

// Reads the project folder as it was in a commit. Returns { graph, commit,
// date, subject, problems } or { error }. The temporary copy is always removed.
export async function readCommit(root, ref) {
  const real = realpathSync(root);
  const found = resolveCommit(real, ref);
  if (found.error) return found;
  // The project may be a folder inside the repository (a monorepo package).
  const prefix = text(git(real, ['rev-parse', '--show-prefix'], { encoding: 'utf8' })) ?? '';
  const tree = prefix ? `${found.commit}:${prefix.replace(/\/$/, '')}` : found.commit;
  const copy = mkdtempSync(join(tmpdir(), 'codetac-commit-'));
  try {
    chmodSync(copy, 0o700);
    // From the top of the repository: run inside a subfolder, git archive
    // keeps only that subfolder of the tree it is given (and gives nothing).
    const top = text(git(real, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })) ?? real;
    const archive = git(top, ['archive', '--format=tar', tree]);
    if (archive.status !== 0) return { error: `git archive failed: ${String(archive.stderr).trim().slice(0, 200) || `code ${archive.status}`}` };
    const unpack = spawnSync('tar', ['-xf', '-', '-C', copy], { input: archive.stdout, maxBuffer: ARCHIVE_LIMIT });
    if (unpack.status !== 0) return { error: `The copy of the commit could not be unpacked: ${String(unpack.stderr).trim().slice(0, 200)}` };
    for (const path of sharedFiles(real)) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      copyFileSync(join(real, path), join(copy, path));
    }
    const { graph, problems } = await readProject(copy, { cache: false });
    // The copy's folder name is temporary: the project keeps its own name.
    if (graph.project.name === basename(copy)) graph.project.name = basename(real);
    return { graph, ...found, problems };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

// The files taken from the folder as it is now: the configuration and the
// .env files at the root of the project and of its packages.
function sharedFiles(root) {
  const list = [];
  if (existsSync(join(root, CONFIG_FILE))) list.push(CONFIG_FILE);
  const envFiles = text(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', '.env', '.env.*', '*/.env', '*/.env.*'], { encoding: 'utf8' }));
  for (const path of (envFiles ?? '').split('\n').filter(Boolean)) {
    if (/(^|\/)\.env(\.[\w.-]+)?$/.test(path) && !path.split('/').some(part => part === 'node_modules')) list.push(path);
  }
  return list;
}

// One side of a comparison: 'now' (the folder as it is), a snapshot id
// ('latest' for the newest), or a commit (any name git knows: a hash, HEAD~2,
// a branch or a tag). Returns { graph, point, problems } or { error }; point
// describes it without the graph: { type: 'now' | 'snapshot' | 'commit', … }.
export const SNAPSHOT_ID = /^(commit|content)-[0-9a-f]{12}$/;
export async function readPoint(root, ref, { readSnapshot, current = null } = {}) {
  if (ref === 'now') {
    const { graph, problems } = current ?? await readProject(root);
    return { graph, point: { type: 'now' }, problems };
  }
  if (ref === 'latest' || SNAPSHOT_ID.test(ref)) {
    const snapshot = readSnapshot(root, ref);
    if (!snapshot) return { error: ref === 'latest' ? 'There is no snapshot of this project yet.' : `There is no snapshot ${ref} of this project.`, missing: ref };
    const { graph, ...about } = snapshot;
    return { graph, point: { type: 'snapshot', ...about }, problems: [] };
  }
  const read = await readCommit(root, ref);
  if (read.error) return read;
  return { graph: read.graph, point: { type: 'commit', ref, commit: read.commit, date: read.date, subject: read.subject }, problems: read.problems };
}
