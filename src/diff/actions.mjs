// The Behavior layer of the Diff (phase D5): what an action of the app does
// differently after a prompt, from two recordings of it, with no new run. The
// last time the action ran before the prompt is compared with the first time
// it ran after it: the server requests it made (and how they answered), the
// functions of the project that ran, what it did outside the code (database,
// outside services, AI, email, payments, files) and its errors. Every
// sentence says it was observed; nothing is guessed.
//
// "The same action" across recordings: the page it started on (numbers and
// ids taken out) and what was clicked, as the dossier names it (actionLabel).
import { isAbsolute, relative, sep } from 'node:path';
import { isDevToolRequest } from '../digest.mjs';
import { label as display } from '../sentences.mjs';
import { t } from '../structure/text.mjs';

const MAX_LIST = 5;
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'MERGE']);
const STRUCTURE = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE']);
const READS = new Set(['SELECT', 'WITH', 'PRAGMA']);

// A path with its ids taken out: /users/42/edit → /users/:id/edit.
export function normalPath(path) {
  const clean = String(path ?? '').split('?')[0].split('#')[0] || '/';
  return clean.split('/').map(part => (/^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)
    || /^[0-9a-f]{16,}$/i.test(part) ? ':id' : part)).join('/');
}
// The key of an action: its page and what was clicked.
export const actionKey = action => `${normalPath(action.page ?? '/')} · ${action.label ?? ''}`;

const list = items => {
  const unique = [...new Set(items)];
  return unique.length <= MAX_LIST ? unique.join(', ') : t('diff.more', { list: unique.slice(0, MAX_LIST).join(', '), more: unique.length - MAX_LIST });
};

// What one boundary step is, as a key and a phrase (the verb phrase after «now also»).
function boundaryOf(step) {
  const tables = (step.tables ?? []).join(', ') || t('behavior.theDatabase');
  switch (step.kind) {
    case 'base-de-dados': {
      const op = String(step.operation ?? '').toUpperCase();
      if (READS.has(op)) return { key: `db:read:${tables}`, text: t('behavior.dbRead', { tables }), weight: 'info' };
      if (STRUCTURE.has(op)) return { key: `db:structure:${op}:${tables}`, text: t('behavior.dbStructure', { operation: op, tables }), weight: 'warning' };
      if (WRITES.has(op)) return { key: `db:write:${op}:${tables}`, text: t('behavior.dbWrite', { operation: op, tables }), weight: 'warning' };
      return { key: `db:other:${op}:${tables}`, text: t('behavior.dbOther', { operation: op || '?', tables }), weight: 'info' };
    }
    case 'http':
      if (step.local) return null;
      return { key: `http:${step.host}`, text: t('behavior.http', { host: step.host ?? '?' }), weight: 'warning' };
    case 'ia': return { key: `ai:${step.provider}`, text: t('behavior.ai', { provider: step.provider ?? '?' }), weight: 'warning' };
    case 'email': return { key: `email:${step.provider ?? step.library}`, text: t('behavior.email', { provider: step.provider ?? step.library ?? '?' }), weight: 'warning' };
    case 'mensagem': return { key: `message:${step.provider ?? step.library}`, text: t('behavior.message', { provider: step.provider ?? step.library ?? '?' }), weight: 'warning' };
    case 'pagamento': return { key: `pay:${step.provider}:${step.mode ?? ''}`, text: t('behavior.payment', { provider: step.provider ?? '?', mode: display(step.mode ?? '') }), weight: 'warning' };
    case 'ficheiros': {
      const where = step.bucket ? `${step.provider} ${step.bucket}` : step.provider ?? step.path ?? '?';
      if (step.operation === 'leitura' || step.operation === 'verificação') return { key: `file:read:${where}`, text: t('behavior.fileRead', { where }), weight: 'info' };
      return { key: `file:${step.operation}:${where}`, text: t('behavior.fileWrite', { operation: display(step.operation ?? '?'), where }), weight: 'warning' };
    }
    case 'autenticação': return { key: `auth:${step.provider ?? step.library}`, text: t('behavior.auth', { provider: step.provider ?? step.library ?? '?' }), weight: 'info' };
    default: return { key: `${step.kind}:${step.operation ?? ''}`, text: t('behavior.otherKind', { kind: display(step.kind ?? '?'), operation: display(step.operation ?? '') }).trim(), weight: 'info' };
  }
}

// What an action did, from its dossier (store.actionDossier, resolved).
// { label, page, requests, functions, boundaries, errors }: maps by key.
export function summarizeAction(dossier) {
  const root = dossier.root;
  const where = file => {
    if (!file) return null;
    if (!root || !isAbsolute(file)) return file;
    const rel = relative(root, file);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : null;
  };
  const requests = new Map();
  const functions = new Map();
  const boundaries = new Map();
  const errors = new Map();
  const servers = dossier.timeline.flatMap(item => item.server ?? []);
  for (const server of servers) {
    const request = server?.request;
    if (!request || isDevToolRequest(request.path)) continue;
    const key = `${request.method} ${normalPath(request.path)}`;
    if (!requests.has(key)) requests.set(key, { key, status: request.status ?? null, proof: [] });
    for (const step of server.steps ?? []) {
      if (step.type === 'function') {
        const file = where(step.file);
        if (!file) continue;
        const fn = step.function || t('behavior.anonymous');
        const id = `${file}#${fn}`;
        if (!functions.has(id)) functions.set(id, { key: id, file, function: fn, line: step.line ?? 1 });
        if (step.error) errors.set(`fn:${id}`, { key: `fn:${id}`, text: t('behavior.errorIn', { function: fn, file }), proof: [{ file, line: step.line ?? 1 }] });
        continue;
      }
      const boundary = boundaryOf(step);
      if (!boundary) continue;
      if (!boundaries.has(boundary.key)) boundaries.set(boundary.key, { ...boundary, count: 0 });
      boundaries.get(boundary.key).count++;
      if (step.error || step.result?.error) errors.set(`b:${boundary.key}`, { key: `b:${boundary.key}`, text: t('behavior.errorAt', { what: boundary.text }) });
    }
  }
  // Calls the browser makes to other hosts (not the app's own API).
  for (const mark of dossier.marks ?? []) {
    if (!mark.key?.startsWith('browser:')) continue;
    const host = mark.key.slice(8);
    boundaries.set(`browser:${host}`, { key: `browser:${host}`, text: t('behavior.browserCall', { host }), weight: 'warning', count: mark.count });
  }
  const first = dossier.timeline.find(item => item.type === 'trigger' || item.page);
  return { label: dossier.label, page: first?.page?.path ?? '/', requests, functions, boundaries, errors };
}

// The sentences of what changed between two runs of the same action.
// Each: { kind, severity, text, origin: 'observed', proof }.
export function compareActions(before, after) {
  const name = after.label ?? before.label;
  const out = [];
  const add = (kind, severity, text, proof = []) => out.push({ kind, severity, text, origin: 'observed', proof, touches: [] });
  const added = (a, b) => [...b.values()].filter(item => !a.has(item.key));
  for (const item of added(before.errors, after.errors)) add('observed-error', 'alert', t('behavior.nowFails', { action: name, what: item.text }), item.proof ?? []);
  for (const item of added(after.errors, before.errors)) add('observed-error-gone', 'info', t('behavior.noLongerFails', { action: name, what: item.text }), item.proof ?? []);
  for (const [key, request] of after.requests) {
    const old = before.requests.get(key);
    if (old && old.status !== request.status && request.status != null && old.status != null) {
      add('observed-status', request.status >= 400 ? 'alert' : 'info', t('behavior.status', { action: name, request: key, after: request.status, before: old.status }));
    }
  }
  for (const item of added(before.boundaries, after.boundaries)) {
    const touches = item.key.startsWith('db:') || item.key.startsWith('file:') || item.key.startsWith('auth:') ? [] : ['leaks'];
    out.push({ kind: 'observed-new', severity: item.weight, text: t('behavior.nowAlso', { action: name, what: item.text }), origin: 'observed', proof: [], touches });
  }
  for (const item of added(after.boundaries, before.boundaries)) add('observed-gone', 'info', t('behavior.noLonger', { action: name, what: item.text }));
  const newRequests = added(before.requests, after.requests).map(item => item.key);
  if (newRequests.length) add('observed-requests', 'info', t('behavior.newRequests', { action: name, count: newRequests.length, list: list(newRequests) }));
  const goneRequests = added(after.requests, before.requests).map(item => item.key);
  if (goneRequests.length) add('observed-requests-gone', 'info', t('behavior.goneRequests', { action: name, count: goneRequests.length, list: list(goneRequests) }));
  const newFunctions = added(before.functions, after.functions);
  if (newFunctions.length) add('observed-functions', 'info', t('behavior.newFunctions', { action: name, count: newFunctions.length, list: list(newFunctions.map(item => `${item.function} (${item.file})`)) }),
    newFunctions.slice(0, MAX_LIST).map(item => ({ file: item.file, line: item.line })));
  const goneFunctions = added(after.functions, before.functions);
  if (goneFunctions.length) add('observed-functions-gone', 'info', t('behavior.goneFunctions', { action: name, count: goneFunctions.length, list: list(goneFunctions.map(item => `${item.function} (${item.file})`)) }));
  const order = { alert: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// The path of an action on the plan, before and after: { id: added|removed|changed|same }.
// `changedFiles`: the paths of the files the prompt changed (a node on both paths
// in one of them is "changed"). `fileOf(id)`: the path of the file of a node.
export function pathMarks(nodesBefore, nodesAfter, changedFiles, fileOf) {
  const before = new Set(nodesBefore);
  const after = new Set(nodesAfter);
  const marks = {};
  for (const id of after) marks[id] = before.has(id) ? (changedFiles.has(fileOf(id)) ? 'changed' : 'same') : 'added';
  for (const id of before) if (!after.has(id)) marks[id] = 'removed';
  return marks;
}

// The actions of a project around a prompt: the last run of each before it
// started and the first run of each after it ended. `actions`: [{ actionId, at,
// label, page }] (any order). Returns { pairs: [{ key, before, after }],
// onlyAfter: [action], onlyBefore: [action] }.
export function aroundPrompt(actions, prompt) {
  const start = Date.parse(prompt.startedAt);
  const end = prompt.endedAt ? Date.parse(prompt.endedAt) : null;
  const before = new Map();
  const after = new Map();
  for (const action of [...actions].sort((a, b) => a.at - b.at)) {
    const key = actionKey(action);
    if (action.at < start) before.set(key, action);
    else if (end !== null && action.at > end && !after.has(key)) after.set(key, action);
  }
  const pairs = [];
  const onlyAfter = [];
  for (const [key, action] of after) (before.has(key) ? pairs.push({ key, before: before.get(key), after: action }) : onlyAfter.push(action));
  const onlyBefore = [...before].filter(([key]) => !after.has(key)).map(([, action]) => action);
  return { pairs, onlyAfter, onlyBefore };
}
