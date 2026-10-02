// The plan of an archived moment (phase D1, step 6): the files of the moment
// written into a temporary folder (outside the project, removed at the end)
// and read there without the incremental cache, as a commit is read
// (commits.mjs). The moment holds the project's codetac.structure.json as it
// was, and its .env files with only their variable names, so both sides of a
// comparison are read by the same rules.
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readProject } from '../structure/readers.mjs';
import { t } from '../structure/text.mjs';
import { diffFolder, materialize, readMoment, writeWhole } from './archive.mjs';
import { readPrompt } from './prompts.mjs';

export const PROMPT_POINT = /^prompt-(\d+)(-after)?$/;

// The plan of a moment never changes, so it is kept (graphs/<id>.json.gz, phase
// D3) while the reader is the same: the key is CodeTAC's version and the size
// and date of the reader's files, so a changed reader reads it again.
let readerKey = null;
function currentReaderKey() {
  if (readerKey) return readerKey;
  const hash = createHash('sha256');
  const visit = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'text' && entry.name !== '__pycache__') visit(path); continue; }
      const stat = statSync(path);
      hash.update(`${path}\0${stat.size}\0${stat.mtimeMs}\n`);
    }
  };
  try {
    hash.update(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    visit(new URL('../structure/', import.meta.url).pathname);
  } catch {}
  return (readerKey = hash.digest('hex').slice(0, 16));
}
const graphCache = (folder, id) => join(folder, 'graphs', `${id}.json.gz`);

// Returns { graph, missing: [files listed but not stored], problems } or { error }.
export async function readMomentGraph(root, id, { cache = true } = {}) {
  const real = realpathSync(root);
  if (!readMoment(real, id)) return { error: t('prompts.noMoment', { id }) };
  const folder = diffFolder(real);
  if (cache) {
    try {
      const kept = JSON.parse(gunzipSync(readFileSync(graphCache(folder, id))).toString('utf8'));
      if (kept.key === currentReaderKey()) return { graph: kept.graph, missing: kept.missing, problems: kept.problems };
    } catch {}
  }
  const read = await readFresh(real, id);
  if (cache && !read.error) {
    try { writeWhole(graphCache(folder, id), gzipSync(JSON.stringify({ key: currentReaderKey(), ...read }))); } catch {}
  }
  return read;
}

async function readFresh(real, id) {
  const copy = mkdtempSync(join(tmpdir(), 'codetac-moment-'));
  try {
    chmodSync(copy, 0o700);
    const { missing } = materialize(real, id, copy);
    const { graph, problems } = await readProject(copy, { cache: false });
    if (graph.project.name === basename(copy)) graph.project.name = basename(real);
    // The .env files were read from their names only: their boxes carry the
    // hash of their real content, as in the plan of the folder.
    const files = readMoment(real, id).files;
    for (const node of graph.nodes) if (node.kind === 'file' && files[node.path]?.[4]) node.hash = files[node.path][4];
    return { graph, missing, problems };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

// What a prompt is, for a point of comparison (without its text's full length).
export function describePrompt(prompt) {
  return { n: prompt.n, startedAt: prompt.startedAt, endedAt: prompt.endedAt ?? null, status: prompt.status, end: prompt.end ?? null,
    text: prompt.text.length > 120 ? `${prompt.text.slice(0, 119)}…` : prompt.text, ...(prompt.overlap ? { overlap: true } : {}),
    ...(prompt.undone ? { undone: prompt.undone.at } : {}) };
}

// A point "prompt-<n>" (the project just before prompt n) or
// "prompt-<n>-after" (just after it). Returns { graph, point, problems } or
// { error, missing }, as readPoint (commits.mjs).
export async function readPromptPoint(root, ref) {
  const [, n, after] = PROMPT_POINT.exec(ref) ?? [];
  const prompt = n ? readPrompt(root, Number(n)) : null;
  if (!prompt) return { error: t('prompts.noPrompt', { n: n ?? ref }), missing: ref };
  const id = after ? prompt.after : prompt.before;
  if (!id) return { error: t('prompts.noAfterYet', { n: prompt.n }), missing: ref };
  const read = await readMomentGraph(root, id);
  if (read.error) return { ...read, missing: ref };
  const problems = [...read.problems];
  if (read.missing.length) problems.push(t('prompts.notStored', { count: read.missing.length, list: read.missing.slice(0, 3).join(', ') }));
  return { graph: read.graph, point: { type: 'prompt', side: after ? 'after' : 'before', moment: id, prompt: describePrompt(prompt) }, problems };
}
