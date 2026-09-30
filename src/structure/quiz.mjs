// The structure quiz (phase 10, step 3): multiple-choice questions made by
// rules from the graph — which block writes to a table, which file sends data
// to a service, which block another depends on, where a route is defined,
// which variable a file reads. The right answer and its proof come from the
// graph, and so do the other choices: each is something of the same kind that
// the graph says is NOT the answer. No AI.
//
// Every question is checked before it is asked (checkQuestion): the answer is
// worked out again from the graph's edges, by code separate from the one that
// made the question, and a question where not exactly one choice is true is
// dropped. The test runs the check on every fixture.
//
// Results (how many asked and right, per kind) stay on the machine, in
// CodeTAC's data folder (<data>/structure/quiz/<project>.json), never in the
// project and never in a request to the AI.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { t } from './text.mjs';

export const KINDS = ['writes-table', 'sends-to', 'depends-on', 'route-file', 'reads-env'];
export const DEFAULT_QUESTIONS = 10;
const MAX_CHOICES = 4;
const MAX_PROOF = 5;
// A file choice is a file of code: a JSON or SQL file as the «other» choice
// would give the answer away.
const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'python']);
const RESULTS_VERSION = 1;
const MAX_RECENT = 50;

const hash = text => createHash('sha256').update(text).digest('hex');
// Stable order that depends on the round: the same graph and round give the
// same quiz; «New questions» asks for the next round.
const shuffled = (items, seed) => items.map(item => [hash(`${seed}\n${item}`), item])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
// n items of the pool that are not left out, stable for the seed. A large
// pool (10 000 files) is not shuffled whole: places in it are drawn by hash.
function pick(pool, leftOut, n, seed) {
  if (pool.length > 64) {
    const picked = new Set();
    for (let draw = 0; picked.size < n && draw < n * 20; draw++) {
      const item = pool[Number.parseInt(hash(`${seed}\n${draw}`).slice(0, 12), 16) % pool.length];
      if (!leftOut.has(item)) picked.add(item);
    }
    if (picked.size === n) return [...picked];
  }
  return shuffled(pool.filter(item => !leftOut.has(item)), seed).slice(0, n);
}

// Who is behind an edge's end, in the graph's own terms.
function index(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const fileOf = id => {
    const node = nodes.get(id);
    if (node?.kind === 'file') return node;
    if (node?.kind === 'symbol') return nodes.get(node.file) ?? null;
    return null;
  };
  return { nodes, fileOf };
}

// For each kind: the subjects that can be asked about, with the true and false
// choices of each (ids of nodes) and the proof of the true ones.
function candidates(graph, kind) {
  const { nodes, fileOf } = index(graph);
  const all = kindName => graph.nodes.filter(node => node.kind === kindName);
  const grouped = (edgeKinds, to, from) => {
    const map = new Map();
    for (const edge of graph.edges) {
      if (!edgeKinds.includes(edge.kind)) continue;
      const subject = to(edge);
      const answer = subject && from(edge);
      if (!answer) continue;
      if (!map.has(subject)) map.set(subject, new Map());
      const proofs = map.get(subject);
      proofs.set(answer, [...(proofs.get(answer) ?? []), ...edge.proof]);
    }
    return map;
  };
  // Not the answer: every other one of the pool (and never the subject).
  const make = (map, pool) => {
    const inPool = new Set(pool);
    return [...map].map(([subject, proofs]) => {
      const leftOut = new Set([...proofs.keys(), subject]);
      return { subject, right: [...proofs.keys()], pool, leftOut, others: pool.length - [...leftOut].filter(id => inPool.has(id)).length, proofs };
    });
  };
  const files = all('file').filter(node => CODE.has(node.language)).map(node => node.id);
  const blocks = all('block').map(node => node.id);
  if (kind === 'writes-table') {
    return make(grouped(['writes'], edge => nodes.get(edge.to)?.kind === 'table' ? edge.to : null, edge => fileOf(edge.from)?.block ?? null), blocks);
  }
  if (kind === 'sends-to') {
    return make(grouped(['sends-data-to'], edge => nodes.get(edge.to)?.kind === 'service' ? edge.to : null, edge => fileOf(edge.from)?.id ?? null), files);
  }
  if (kind === 'depends-on') {
    return make(grouped(['imports', 'calls'], edge => edge.from !== edge.to && nodes.get(edge.from)?.kind === 'block' && nodes.get(edge.to)?.kind === 'block' ? edge.from : null,
      edge => edge.to), blocks);
  }
  if (kind === 'route-file') {
    return make(grouped(['exposes'], edge => nodes.get(edge.to)?.kind === 'route' ? edge.to : null, edge => fileOf(edge.from)?.id ?? null), files);
  }
  if (kind === 'reads-env') {
    return make(grouped(['reads', 'uses-secret'], edge => nodes.get(edge.to)?.kind === 'env' ? fileOf(edge.from)?.id ?? null : null, edge => edge.to), all('env').map(node => node.id));
  }
  return [];
}

// The name shown for a node: a file by its path, the rest by name.
const label = (nodes, id) => nodes.get(id)?.path ?? nodes.get(id)?.name ?? id;

// quizQuestions(graph, { round, count }) → [{
//   id, kind, subject, text, choices: [{ id, text }], answer (index), proof
// }], each already checked against the graph.
export function quizQuestions(graph, { round = 0, count = DEFAULT_QUESTIONS } = {}) {
  const { nodes } = index(graph);
  const seed = `round ${round}`;
  const byKind = new Map();
  for (const kind of KINDS) {
    const items = new Map(candidates(graph, kind).filter(item => item.right.length && item.others > 0).map(item => [item.subject, item]));
    byKind.set(kind, shuffled([...items.keys()], `${seed}\n${kind}`).map(subject => items.get(subject)));
  }
  // One of each kind in turn, so a project with many tables does not ask
  // only about tables.
  const questions = [];
  const kinds = shuffled(KINDS, seed);
  while (questions.length < count && kinds.some(kind => byKind.get(kind).length)) {
    for (const kind of kinds) {
      const item = byKind.get(kind).shift();
      if (!item || questions.length >= count) continue;
      const right = shuffled(item.right, `${seed}\n${item.subject}\nright`)[0];
      const wrong = pick(item.pool, item.leftOut, Math.min(MAX_CHOICES - 1, item.others), `${seed}\n${item.subject}\nwrong`);
      const ids = shuffled([right, ...wrong], `${seed}\n${item.subject}\norder`);
      const question = {
        id: hash(`${kind}\n${item.subject}\n${ids.join('\n')}`).slice(0, 16),
        kind,
        subject: item.subject,
        text: t(`quiz.question.${kind}`, { subject: label(nodes, item.subject) }),
        choices: ids.map(id => ({ id, text: label(nodes, id) })),
        answer: ids.indexOf(right),
        proof: item.proofs.get(right).slice(0, MAX_PROOF),
      };
      if (checkQuestion(graph, question).ok) questions.push(question);
    }
  }
  return questions;
}

// Is this choice true for this question? Worked out from the edges again,
// without the tables quizQuestions used.
export function isTrue(graph, kind, subject, choice) {
  const byId = new Map(graph.nodes.map(item => [item.id, item]));
  const node = id => byId.get(id);
  const fileId = id => { const item = node(id); return item?.kind === 'file' ? item.id : item?.kind === 'symbol' ? item.file : null; };
  const edges = kinds => graph.edges.filter(edge => kinds.includes(edge.kind));
  switch (kind) {
    case 'writes-table': return edges(['writes']).some(edge => edge.to === subject && node(fileId(edge.from))?.block === choice);
    case 'sends-to': return edges(['sends-data-to']).some(edge => edge.to === subject && fileId(edge.from) === choice);
    case 'depends-on': return edges(['imports', 'calls']).some(edge => edge.from === subject && edge.to === choice);
    case 'route-file': return edges(['exposes']).some(edge => edge.to === subject && fileId(edge.from) === choice);
    case 'reads-env': return edges(['reads', 'uses-secret']).some(edge => edge.to === choice && fileId(edge.from) === subject);
    default: return false;
  }
}

// checkQuestion(graph, question) → { ok, problems }: exactly one choice is
// true, it is the answer, and the proof points to a line of the project.
export function checkQuestion(graph, question) {
  const problems = [];
  const truth = question.choices.map(choice => isTrue(graph, question.kind, question.subject, choice.id));
  if (truth.filter(Boolean).length !== 1) problems.push(`${truth.filter(Boolean).length} true choices`);
  if (!truth[question.answer]) problems.push('the answer is not true');
  if (question.choices.length < 2) problems.push('fewer than two choices');
  if (!question.proof?.length || question.proof.some(proof => !proof.file || !(proof.line > 0))) problems.push('no proof');
  const files = new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.path));
  if (question.proof?.some(proof => !files.has(proof.file) && !graph.nodes.some(node => node.proof?.some(item => item.file === proof.file)))) problems.push('proof outside the graph');
  return { ok: !problems.length, problems };
}

// What the page gets: the questions without their answers (they come back
// one by one, when the user answers).
export const withoutAnswers = questions => questions.map(({ answer: _answer, proof: _proof, ...question }) => question);

// The results on this machine.
export function resultsPath(root) {
  return join(dataDirectory(), 'structure', 'quiz', `${hash(realpathSync(root)).slice(0, 32)}.json`);
}
const emptyResults = () => ({ version: RESULTS_VERSION, answered: 0, right: 0, byKind: {}, recent: [] });
export function readResults(root) {
  try {
    const results = JSON.parse(readFileSync(resultsPath(root), 'utf8'));
    return results?.version === RESULTS_VERSION ? results : emptyResults();
  } catch { return emptyResults(); }
}
export function recordAnswer(root, { kind, right, at = new Date().toISOString() }) {
  const results = readResults(root);
  results.answered += 1;
  if (right) results.right += 1;
  const tally = results.byKind[kind] ?? { answered: 0, right: 0 };
  results.byKind[kind] = { answered: tally.answered + 1, right: tally.right + (right ? 1 : 0) };
  results.recent = [{ at, kind, right }, ...results.recent].slice(0, MAX_RECENT);
  const path = resultsPath(root);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(results)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return results;
}

// answerQuestion(graph, root, { round, id, choice }) → the verdict with the
// right answer and its proof, recorded; null when the question is not in this
// round of this graph any more (the project changed).
export function answerQuestion(graph, root, { round = 0, id, choice }) {
  const question = quizQuestions(graph, { round }).find(item => item.id === id);
  if (!question || !Number.isInteger(choice) || choice < 0 || choice >= question.choices.length) return null;
  const right = choice === question.answer;
  const results = recordAnswer(root, { kind: question.kind, right });
  return { id, right, answer: question.answer, proof: question.proof, results };
}
