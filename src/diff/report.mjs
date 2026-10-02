// The report of a prompt (phase D2): what changed, from the two archived
// moments around it (just before, just after; the folder now while the
// prompt runs). Layers, from the most human to the most technical:
//   sentences   the changes in the structure (summary.mjs, phase 9) and the
//               Diff's risk rules (risk.mjs), most important first, each with
//               its origin ("read": read in the code; "possibly": a heuristic)
//               and the code blocks that prove it;
//   code        the blocks of lines that changed, file by file, each with the
//               sentences it explains; the blocks no sentence explains are
//               listed apart ("other changes").
// A sentence is linked to a block when one of its proofs (file:line, in the
// version the sentence is about) falls in the lines the block shows; a
// sentence about whole files (added, removed, changed, tests), or none of
// whose proofs falls in a block, is linked to every block of the files it
// names; a sentence about blocks of the plan, to the changed files of those
// blocks. A block only "these files changed" names stays among the other
// changes: that sentence says where, not why.
// The code is what the archive holds: .env files with their variable names
// only, keys of known shapes masked (archive.mjs).
import { diffGraphs } from '../structure/diff.mjs';
import { sentenceBoxes } from '../structure/changes.mjs';
import { changeSummary, sortSentences } from '../structure/summary.mjs';
import { t } from '../structure/text.mjs';
import { archiveMoment, diffFolder, fileChanges, readArchived, readMoment } from './archive.mjs';
import { describePrompt, readMomentGraph } from './moments.mjs';
import { readPrompt } from './prompts.mjs';
import { diffLines, hunks, splitLines } from './lines.mjs';
import { promptRisks } from './risk.mjs';

const MAX_FILE_LINES = 20_000;
// Sentences about whole files: linked to every block of the files they name.
const WHOLE_FILES = new Set(['files-added', 'files-removed', 'files-renamed', 'files-changed', 'moved-block', 'runs-on', 'test-deleted', 'tests-removed']);

// A side for the risk rules: { graph, files: path → hash of the real content, read(path) }.
function sideOf(root, moment, graph, folder) {
  const files = Object.fromEntries(Object.entries(moment.files).map(([path, entry]) => [path, entry[4] ?? entry[0]]));
  const cache = new Map();
  const read = path => {
    if (!cache.has(path)) {
      const entry = moment.files[path];
      const content = entry && entry[3] !== 'large' ? readArchived(root, entry[0], folder) : null;
      cache.set(path, content && !content.subarray(0, 8000).includes(0) ? content.toString('utf8') : null);
    }
    return cache.get(path);
  };
  return { graph, files, read, entry: path => moment.files[path] ?? null };
}

// The code of one file: { path, status, hunks, note? }.
function codeOf(path, status, before, after) {
  const entryBefore = before.entry(path);
  const entryAfter = after.entry(path);
  const flags = [entryBefore?.[3], entryAfter?.[3]];
  if (flags.includes('large')) return { path, status, hunks: [], note: 'large' };
  const textBefore = status === 'added' ? '' : before.read(path);
  const textAfter = status === 'removed' ? '' : after.read(path);
  if (textBefore === null || textAfter === null) return { path, status, hunks: [], note: 'binary' };
  const linesBefore = splitLines(textBefore);
  const linesAfter = splitLines(textAfter);
  if (linesBefore.length > MAX_FILE_LINES || linesAfter.length > MAX_FILE_LINES) return { path, status, hunks: [], note: 'large' };
  const blocks = hunks(diffLines(linesBefore, linesAfter));
  // A .env whose names did not change: only values changed, and they are not kept.
  const note = flags.includes('names') ? (blocks.length ? 'names' : 'values') : flags.includes('masked') ? 'masked' : null;
  return { path, status, hunks: blocks, ...(note ? { note } : {}) };
}

function link(sentences, files, blockOf, nodeProofs) {
  const blocks = files.flatMap(file => file.hunks.map((hunk, index) => ({ file: file.path, index, hunk })));
  blocks.forEach((block, id) => { block.id = id; block.hunk.id = id; block.hunk.sentences = []; });
  const inside = (block, proof, side) => {
    if (block.file !== proof.file) return false;
    const range = side === 'before' ? block.hunk.before : block.hunk.after;
    return proof.line >= range.start && proof.line < range.start + Math.max(range.count, 1);
  };
  sentences.forEach((sentence, index) => {
    const hits = proofs => blocks.filter(block => proofs.some(proof => inside(block, proof, sentence.side)));
    let linked = WHOLE_FILES.has(sentence.kind) ? [] : hits(sentence.proof);
    // A sentence shows the first proof of each thing; the things it is about have all of theirs
    // (a route mounted in one file and declared in another).
    if (!linked.length && !WHOLE_FILES.has(sentence.kind)) linked = hits(sentence.ids.flatMap(id => nodeProofs(id, sentence.side)));
    if (!linked.length) {
      const named = new Set([...sentence.proof.map(proof => proof.file), ...sentence.ids.filter(id => id.startsWith('file:')).map(id => id.slice(5))]);
      linked = blocks.filter(block => named.has(block.file));
    }
    // About blocks of the plan ("Logic no longer depends on External"), proven
    // in a file that did not change: the changes of the files of those blocks.
    if (!linked.length) {
      const layers = new Set(sentence.ids.filter(id => id.startsWith('block:')));
      linked = blocks.filter(block => layers.has(blockOf(block.file)));
    }
    sentence.blocks = linked.map(block => block.id);
    for (const block of linked) block.hunk.sentences.push(index);
  });
  // "These files changed" says where, not why: a block only it names is still among the other changes.
  return blocks.filter(block => block.hunk.sentences.every(index => sentences[index].kind === 'files-changed')).map(block => block.id);
}

// Returns the report, or { error }.
export async function promptReport(root, n = 'latest') {
  const prompt = readPrompt(root, n);
  if (!prompt) return { error: t('prompts.noPrompt', { n }) };
  const folder = diffFolder(root);
  const afterId = prompt.after ?? archiveMoment(root).moment.id;
  const momentBefore = readMoment(root, prompt.before, folder);
  const momentAfter = readMoment(root, afterId, folder);
  if (!momentBefore || !momentAfter) return { error: t('prompts.cli.archiveGone', { n: prompt.n }) };
  const graphBefore = await readMomentGraph(root, prompt.before);
  const graphAfter = await readMomentGraph(root, afterId);
  for (const side of [graphBefore, graphAfter]) if (side.error) return { error: side.error };
  const before = sideOf(root, momentBefore, graphBefore.graph, folder);
  const after = sideOf(root, momentAfter, graphAfter.graph, folder);
  const diff = diffGraphs(before.graph, after.graph);
  // Each with the boxes of the plan it is about (boxes, target), for the report's map.
  const sentences = sentenceBoxes(before.graph, after.graph, sortSentences([
    ...changeSummary(diff, before.graph, after.graph).map(sentence => ({ ...sentence, origin: 'read' })),
    ...promptRisks(diff, before, after),
  ]), diff);
  const changes = fileChanges(momentBefore, momentAfter);
  const files = [
    ...changes.added.map(path => codeOf(path, 'added', before, after)),
    ...changes.changed.map(path => codeOf(path, 'changed', before, after)),
    ...changes.removed.map(path => codeOf(path, 'removed', before, after)),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const layerOf = new Map([...before.graph.nodes, ...after.graph.nodes].filter(node => node.kind === 'file').map(node => [node.path, node.block]));
  const nodes = { before: new Map(before.graph.nodes.map(node => [node.id, node])), after: new Map(after.graph.nodes.map(node => [node.id, node])) };
  const unexplained = link(sentences, files, path => layerOf.get(path) ?? null, (id, side) => nodes[side === 'before' ? 'before' : 'after'].get(id)?.proof ?? []);
  const missing = [...new Set([...graphBefore.missing, ...graphAfter.missing])];
  return {
    prompt: { ...describePrompt(prompt), text: prompt.text },
    running: !prompt.after,
    moments: { before: prompt.before, after: afterId },
    files: changes,
    sentences,
    code: { files, unexplained },
    missing,
    problems: [...graphBefore.problems, ...graphAfter.problems],
  };
}
