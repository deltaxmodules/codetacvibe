// Snapshots of the structure (phase 9, step 1): the graph of a moment, kept
// to compare with later ("what changed in the architecture after this prompt
// or this commit?"). They live in CodeTAC's data folder,
// <data>/structure/snapshots/<project>/, never in the project. A snapshot is
// named by the commit when the working tree is clean, or by a hash of the
// files' contents when there are changes not committed (or no git), so saving
// twice the same state gives one snapshot, not two. (A clean tree whose
// ignored files, such as .env, changed since its commit was saved is named by
// the contents.) The newest 20 of each
// project are kept (snapshots.keep in codetac.structure.json).
//
// Each snapshot is two files: <id>.json, what it is (small, so the list is
// quick), and <id>.graph.json.gz, the graph, compressed (a project of 10 000
// files: 13.6 MB of JSON, 1.1 MB compressed).
//
// A snapshot can carry a prediction of what the next change will do (phase
// 10, step 2): <id>.prediction.json beside it (predict.mjs).
//
// Saving a new snapshot carries over the changes against the newest one that
// the user has not reviewed yet (comprehension debt, review.mjs).
//
// Git is only read, never changed: GIT_OPTIONAL_LOCKS=0 stops `git status`
// from refreshing the index, so the .git folder is not touched.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { readProject } from './readers.mjs';
import { readConfig } from './config.mjs';
import { readPrediction, removePrediction, writePrediction } from './predict.mjs';
import { carryUnreviewed, changeSentences } from './review.mjs';

export const SNAPSHOT_VERSION = 1;
export const DEFAULT_KEEP = 20;
const LABEL_LENGTH = 80;

export function snapshotFolder(root) {
  return join(dataDirectory(), 'structure', 'snapshots', createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 32));
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 ? result.stdout : null;
}

// The commit of the project folder and whether the folder (only it, not the
// rest of a monorepo) has changes not committed; null without git.
export function gitState(root) {
  const commit = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
  if (!commit) return null;
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal', '--', '.']);
  if (status === null) return null;
  return { commit, dirty: status.trim() !== '' };
}

// The hash of what the graph was read from: every file's path and content
// hash (the graph holds both), so an unchanged project gives the same hash.
export function contentHash(graph) {
  const files = graph.nodes.filter(node => node.kind === 'file').map(node => `${node.path}\0${node.hash}`).sort();
  return createHash('sha256').update(files.join('\n')).digest('hex');
}

function cleanLabel(label) {
  if (label === null || label === undefined) return null;
  const text = String(label).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_LENGTH);
  return text || null;
}

// What a snapshot is (without its graph), or null.
function readSnapshotFile(path) {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    return snapshot?.version === SNAPSHOT_VERSION && typeof snapshot.id === 'string' && !snapshot.graph ? snapshot : null;
  } catch { return null; }
}
const graphPath = (folder, id) => join(folder, `${id}.graph.json.gz`);
// Written whole or not at all: a half-written file would be read as broken.
function writeWhole(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

// The project's snapshots, newest first, without their graphs.
export function listSnapshots(root) {
  const folder = snapshotFolder(root);
  let names = [];
  try { names = readdirSync(folder).filter(name => /^(commit|content)-[0-9a-f]{12}\.json$/.test(name)); } catch { return []; }
  const list = [];
  for (const name of names) {
    const snapshot = readSnapshotFile(join(folder, name));
    if (snapshot) list.push(snapshot);
  }
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
}

// One snapshot, with its graph: by id, or the newest with "latest".
export function readSnapshot(root, id = 'latest') {
  const wanted = id === 'latest' ? listSnapshots(root)[0]?.id : id;
  if (!wanted || !/^(commit|content)-[0-9a-f]{12}$/.test(wanted)) return null;
  const folder = snapshotFolder(root);
  const snapshot = readSnapshotFile(join(folder, `${wanted}.json`));
  if (!snapshot) return null;
  let graph;
  try { graph = JSON.parse(gunzipSync(readFileSync(graphPath(folder, wanted))).toString('utf8')); } catch { return null; }
  return { ...snapshot, graph, prediction: snapshot.predicted ? readPrediction(folder, wanted) : null };
}

// Saves the structure as it is now. Returns { snapshot (without the graph),
// replaced, removed: [ids dropped by the retention], problems }. The same
// state saved again replaces the earlier snapshot (a new date, and the new
// label if one is given; otherwise the old label stays). A prediction
// (already cleaned by cleanPrediction) replaces the earlier one; without one,
// the earlier prediction stays.
export async function saveSnapshot(root, { label = null, graph = null, prediction = null, now = new Date() } = {}) {
  const problems = [];
  if (!graph) {
    const read = await readProject(root);
    graph = read.graph;
    problems.push(...read.problems);
  }
  const state = gitState(root);
  const content = contentHash(graph);
  const folder = snapshotFolder(root);
  // A clean tree is named by its commit, unless that commit was already saved
  // with other contents: files git ignores but the plan reads (the .env
  // files) changed since. Then it is named by the contents, so the earlier
  // snapshot is not replaced by a different structure.
  const byCommitId = state && !state.dirty ? `commit-${state.commit.slice(0, 12)}` : null;
  const sameCommit = byCommitId ? readSnapshotFile(join(folder, `${byCommitId}.json`)) : null;
  const byCommit = Boolean(byCommitId) && (!sameCommit || sameCommit.contentHash === content);
  const id = byCommit ? byCommitId : `content-${content.slice(0, 12)}`;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${id}.json`);
  const earlier = readSnapshotFile(path);
  const files = graph.nodes.filter(node => node.kind === 'file').length;
  const snapshot = {
    version: SNAPSHOT_VERSION,
    id,
    createdAt: now.toISOString(),
    label: cleanLabel(label) ?? earlier?.label ?? null,
    source: byCommit ? 'commit' : 'content',
    commit: state?.commit ?? null,
    dirty: state ? state.dirty : null,
    contentHash: content,
    project: graph.project.name,
    files,
    predicted: Boolean(prediction) || Boolean(earlier?.predicted),
  };
  // Phase 10, step 4: the changes not reviewed against the newest snapshot
  // keep counting after this one becomes the point of comparison.
  const newest = listSnapshots(root)[0];
  if (newest && newest.id !== id) {
    try {
      const before = readSnapshot(root, newest.id);
      if (before) carryUnreviewed(root, { from: newest.id, sentences: changeSentences(before.graph, graph), at: now.toISOString() });
    } catch (error) { problems.push(`The changes not reviewed could not be carried over: ${error.message}`); }
  }
  // The graph first: a snapshot is listed only once its graph is there.
  writeWhole(graphPath(folder, id), gzipSync(JSON.stringify(graph)));
  if (prediction) writePrediction(folder, id, { ...prediction, createdAt: snapshot.createdAt });
  writeWhole(path, `${JSON.stringify(snapshot)}\n`);
  const keep = readConfig(root).snapshots?.keep ?? DEFAULT_KEEP;
  const removed = [];
  for (const old of listSnapshots(root).slice(keep)) {
    rmSync(join(folder, `${old.id}.json`), { force: true });
    rmSync(graphPath(folder, old.id), { force: true });
    removePrediction(folder, old.id);
    removed.push(old.id);
  }
  return { snapshot, replaced: Boolean(earlier), removed, problems };
}
