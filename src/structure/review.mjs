// Comprehension debt (phase 10, step 4): how many structural changes the
// user has not opened yet in the Changes view. The changes are the sentences
// of the summary (phase 9) against the newest snapshot; opening one (pressing
// it) marks it reviewed and the count goes down. When a new snapshot is saved,
// the sentences not reviewed against the one before do not disappear: they
// are carried over and keep counting until they are opened.
//
// Kept on this machine only: <data>/structure/review/<project>.json. Nothing
// here goes into a request to the AI, and the panel serves it on 127.0.0.1.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from '../home.mjs';
import { diffGraphs } from './diff.mjs';
import { changeSummary } from './summary.mjs';

const REVIEW_VERSION = 1;
// Snapshots whose reviewed sentences are remembered, and sentences carried.
const MAX_SNAPSHOTS = 50;
const MAX_CARRIED = 500;
const MAX_KEYS = 200;

const hash = text => createHash('sha256').update(text).digest('hex');
// A sentence is the same change while it says the same thing: its proof
// lines may move without it becoming new to the user.
export const sentenceKey = sentence => hash(`${sentence.kind}\n${sentence.text}`).slice(0, 16);

export function reviewPath(root) {
  return join(dataDirectory(), 'structure', 'review', `${hash(realpathSync(root)).slice(0, 32)}.json`);
}
const emptyState = () => ({ version: REVIEW_VERSION, reviewed: {}, carried: [] });
export function readReview(root) {
  try {
    const state = JSON.parse(readFileSync(reviewPath(root), 'utf8'));
    return state?.version === REVIEW_VERSION && state.reviewed && Array.isArray(state.carried) ? state : emptyState();
  } catch { return emptyState(); }
}
function writeReview(root, state) {
  // The newest snapshots only (insertion order is the order they were used).
  const ids = Object.keys(state.reviewed);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SNAPSHOTS))) delete state.reviewed[id];
  state.carried = state.carried.slice(-MAX_CARRIED);
  const path = reviewPath(root);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// The sentences of what changed from a graph to another.
export const changeSentences = (before, after) => changeSummary(diffGraphs(before, after), before, after);

// reviewDebt(state, { snapshot, sentences }) → {
//   total, open: [{ key, kind, text, severity }] (against the snapshot, not reviewed),
//   carried: [{ key, kind, text, severity, from, at }] (from before a newer snapshot)
// }. Without a snapshot there is nothing to compare with: only what was carried counts.
export function reviewDebt(state, { snapshot = null, sentences = [] } = {}) {
  const reviewed = new Set(snapshot ? state.reviewed[snapshot] ?? [] : []);
  const open = snapshot ? sentences.map(sentence => ({ key: sentenceKey(sentence), kind: sentence.kind, text: sentence.text, severity: sentence.severity }))
    .filter(item => !reviewed.has(item.key)) : [];
  // A carried change said again against the newest snapshot counts once.
  const openKeys = new Set(open.map(item => item.key));
  const carried = state.carried.filter(item => !openKeys.has(item.key));
  return { total: open.length + carried.length, open, carried };
}

// Opening a change: against a snapshot (its sentence key), or a carried one.
export function markReviewed(root, { snapshot = null, keys = [] }) {
  const state = readReview(root);
  const wanted = [...new Set((Array.isArray(keys) ? keys : [keys]).map(String).filter(key => /^[0-9a-f]{16}$/.test(key)))].slice(0, MAX_KEYS);
  if (!wanted.length) return state;
  state.carried = state.carried.filter(item => !wanted.includes(item.key));
  if (snapshot && /^(commit|content)-[0-9a-f]{12}$/.test(snapshot)) {
    const list = new Set(state.reviewed[snapshot] ?? []);
    for (const key of wanted) list.add(key);
    delete state.reviewed[snapshot];
    state.reviewed[snapshot] = [...list];
  }
  writeReview(root, state);
  return state;
}

// Before a new snapshot replaces the newest one as the point of comparison:
// the changes against the newest not yet reviewed are carried over.
export function carryUnreviewed(root, { from, sentences, at = new Date().toISOString() }) {
  const state = readReview(root);
  const { open } = reviewDebt({ ...state, carried: [] }, { snapshot: from, sentences });
  const already = new Set(state.carried.map(item => item.key));
  const carried = open.filter(item => !already.has(item.key)).map(item => ({ ...item, from, at }));
  if (!carried.length) return 0;
  state.carried.push(...carried);
  writeReview(root, state);
  return carried.length;
}
