// Frases fixas, geradas só dos factos gravados (modo sem IA e base de
// comparação para as frases da IA), em inglês.
// Nenhuma frase interpreta o nome de uma função: diz o que se observou.

import { TEXT, t } from './structure/text.mjs';

// The recordings keep their values in Portuguese (kinds, operations, modes):
// they are translated only when shown (steps.labels in text/en.json).
export const LABELS = TEXT.steps.labels;
export function label(value) { return LABELS[value] ?? value; }

const list = (items, and) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
const names = (items, and, max = 4) => items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max})` : list(items, and);

function duration(ms) {
  if (ms == null) return '';
  return ms < 1 ? ms.toFixed(2) + ' ms' : ms < 1000 ? ms.toFixed(1) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

export const REDIS_LIBRARIES = new Set(['ioredis', 'redis']);
const REDIS_KEY_DELETES = new Set(['DEL', 'UNLINK', 'GETDEL', 'FLUSHDB', 'FLUSHALL', 'JSON.DEL', 'JSON.FORGET']);

// The words live in text/en.json (steps); these functions only choose and fill them.
const or = (value, key) => value || t(key);
const inParens = text => ` (${text})`;
const someRows = (n, key = 'steps.someRows') => (n == null ? t(key) : EN.rows(n));
const status = value => (value != null ? inParens(t('steps.status', { status: value })) : '');
const usage = value => (value ? ` · ${t('steps.tokens', { input: value.input ?? '?', output: value.output ?? '?' })}` : '');
const to = items => (items.length ? ` ${t('steps.to', { list: items.join(', ') })}` : '');
const quoted = text => (text ? ` ${t('steps.quoted', { text })}` : '');
const bytes = count => (count ? inParens(t('steps.bytes', { count })) : '');
const times = (n, key) => (n > 1 ? inParens(t(key, { count: n })) : '');

const EN = {
  and: t('steps.and'),
  rows: n => t('steps.rows', { count: n }),
  read: (tables, rows) => t('steps.read', { tables: or(tables, 'steps.theDatabase'), rows: rows != null ? inParens(EN.rows(rows)) : '' }),
  insert: (tables, n) => t('steps.insert', { rows: someRows(n), tables: or(tables, 'steps.aTable') }),
  update: (tables, n) => n === 0 ? t('steps.updateNone', { tables: or(tables, 'steps.aTable') }) : t('steps.update', { rows: someRows(n), tables: or(tables, 'steps.aTable') }),
  delete: (tables, n) => n === 0 ? t('steps.deleteNone', { tables: or(tables, 'steps.aTable') }) : t('steps.delete', { rows: someRows(n), tables: or(tables, 'steps.aTable') }),
  create: (tables, ifNot) => t('steps.create', { tables: tables || '', ifNot: ifNot ? ` ${t('steps.ifNotExists')}` : '' }).trim(),
  alter: tables => t('steps.alter', { tables: or(tables, 'steps.aTable') }),
  drop: tables => t('steps.drop', { tables: or(tables, 'steps.aTable') }),
  otherDb: (op, tables) => t('steps.otherDb', { op, tables: tables ? inParens(tables) : '' }),
  // Redis has keys, not tables or rows.
  redisKey: keys => t('steps.redisKey', { count: keys.includes(', ') ? 2 : 1, keys }),
  redisRead: (keys, rows) => t('steps.redisRead', { key: EN.redisKey(keys), notFound: rows === 0 ? inParens(t('steps.notFound')) : '' }),
  redisWrite: (keys, command, n) => t(n === 0 ? 'steps.redisWriteNone' : 'steps.redisWrite', { command, key: EN.redisKey(keys) }),
  redisDelete: (keys, command, n) => t(n === 0 ? 'steps.redisDeleteNone' : REDIS_KEY_DELETES.has(command) ? 'steps.redisDelete' : 'steps.redisRemove', { command, key: EN.redisKey(keys) }),
  redisOther: (command, keys) => t('steps.redisOther', { command, keys: keys ? inParens(keys) : '' }),
  failed: t('steps.failed'),
  http: (method, host, path, code) => t('steps.http', { host, method, path, status: status(code) }),
  ai: (provider, model, used) => t('steps.ai', { provider, model: model ? inParens(model) : '', usage: usage(used) }),
  email: (recipients, subject) => t('steps.email', { to: to(recipients), subject: quoted(subject) }),
  message: (recipients, provider) => t('steps.message', { provider, to: to(recipients) }),
  payment: (provider, operation, mode) => t('steps.payment', { provider, operation, mode }),
  fileRead: (where, size) => t('steps.fileRead', { where, bytes: bytes(size) }),
  fileWrite: (op, where, size) => t('steps.fileWrite', { op, where, bytes: bytes(size) }),
  auth: (provider, operation) => t('steps.auth', { provider, operation: operation ? `: ${operation}` : '' }),
  calls: items => t('steps.calls', { items }),
  noBoundary: t('steps.noBoundary'),
  opaque: t('steps.opaque'),
  templatePart: file => t('steps.templatePart', { file }),
  error: t('steps.error'),
  unfinished: t('steps.unfinished'),
  dbSetupPart: n => t('steps.dbSetupPart', { count: n }),
  readPart: tables => t('steps.readPart', { tables }),
  dbOtherPart: n => t('steps.dbOtherPart', { count: n }),
  otherBoundaryPart: n => t('steps.otherBoundaryPart', { count: n }),
  writePart: (verb, tables) => t('steps.writePart', { verb, tables }),
  writeVerbs: TEXT.steps.writeVerbs,
  idleWritePart: tables => t('steps.idleWritePart', { tables }),
  httpPart: hosts => t('steps.httpPart', { hosts }),
  aiPart: providers => t('steps.aiPart', { providers }),
  emailPart: n => t('steps.emailPart', { count: n }),
  paymentPart: providers => t('steps.paymentPart', { providers }),
  filePart: ops => t('steps.filePart', { ops }),
  authPart: providers => t('steps.authPart', { providers }),
  dbSetup: (n, counts, tables, failed, changed, parentOk) => t('steps.dbSetup', { count: n, counts, tables: t('steps.dbSetupTables', { count: tables }),
    failed: failed ? ` · ${t('steps.failedCount', { count: failed })}${parentOk ? ` ${t('steps.withoutStopping')}` : ''}` : '',
    changed: changed ? ` · ${t('steps.includesWrites', { rows: EN.rows(changed) })}` : '' }),
  repeated: (sentence, n) => t('steps.repeated', { sentence, count: n }),
  block: (count, size, what) => t('steps.block', { size, times: count, what: what ? `: ${what}` : '' }),
  helpers: (n, fns) => t('steps.helpers', { count: n, fns }),
  generated: n => t('steps.generated', { count: n }),
  devTools: n => t('steps.devTools', { count: n }),
  effects: {
    added: (n, table) => t('steps.effects.added', { rows: someRows(n, 'steps.effects.someRows'), table }),
    changed: (n, table) => t('steps.effects.changed', { rows: someRows(n, 'steps.effects.someRows'), table }),
    deleted: (n, table) => t('steps.effects.deleted', { rows: someRows(n, 'steps.effects.someRows'), table }),
    otherWrite: (op, table) => t('steps.effects.otherWrite', { op, table }),
    redisWritten: (keys, n) => t('steps.effects.redisWritten', { key: EN.redisKey(keys), times: times(n, 'steps.effects.commands') }),
    redisDeleted: (keys, command, n) => t(REDIS_KEY_DELETES.has(command) ? 'steps.effects.redisDeleted' : 'steps.effects.redisChanged', { key: EN.redisKey(keys), command, times: times(n, 'steps.effects.commands') }),
    redisNoChange: (command, keys, n) => t('steps.effects.redisNoChange', { command, key: EN.redisKey(keys), times: times(n, 'steps.effects.times') }),
    noChange: (op, table, n) => t('steps.effects.noChange', { op, table, times: times(n, 'steps.effects.times') }),
    structure: (ok, failed) => t('steps.effects.structure', { total: ok + failed, ok, failed: failed ? `, ${t('steps.failedCount', { count: failed })}` : '' }),
    email: (recipients, subject, failed) => t(failed ? 'steps.effects.emailFailed' : 'steps.effects.email', { to: to(recipients), subject: quoted(subject) }),
    message: (provider, failed) => t(failed ? 'steps.effects.messageFailed' : 'steps.effects.message', { provider }),
    payment: (provider, operation, mode) => t('steps.payment', { provider, operation, mode }),
    file: (op, where) => t('steps.effects.file', { op, where }),
    cookieSet: list => t('steps.effects.cookieSet', { names: list }),
    cookieCleared: list => t('steps.effects.cookieCleared', { names: list }),
    ai: (provider, model, used, cost) => t('steps.effects.ai', { provider, model: model ? inParens(model) : '', usage: usage(used),
      cost: cost != null ? ` · ${t('steps.effects.cost', { cost: cost.toFixed(4) })}` : '' }),
    external: (method, host, n) => t('steps.effects.external', { method, host, times: times(n, 'steps.effects.times') }),
    none: t('steps.effects.none'),
    unseen: t('steps.effects.unseen'),
  },
  action: {
    click: name => t('steps.action.click', { label: name }),
    submit: name => t('steps.action.submit', { label: name }),
    change: name => t('steps.action.change', { label: name }),
    continuation: t('steps.action.continuation'),
    request: (method, path, code) => t('steps.action.request', { method, path, status: status(code) }),
    noServer: t('steps.action.noServer'),
    screen: t('steps.action.screen'),
    noScreen: t('steps.action.noScreen'),
    navigates: path => t('steps.action.navigates', { path }),
  },
};

export function texts() { return EN; }
export { duration, names, list };

// The sentence of one boundary, from its recorded facts.
export function boundarySentence(step) {
  const say = texts();
  const r = step.result ?? {};
  const failed = step.error || r.error;
  const tables = (step.tables ?? []).join(', ');
  let text;
  switch (step.kind) {
    case 'base-de-dados': {
      const op = step.operation;
      if (REDIS_LIBRARIES.has(step.library)) {
        const command = step.command ?? op;
        text = op === 'SELECT' ? say.redisRead(tables, r.rows) : op === 'UPDATE' ? say.redisWrite(tables, command, r.affectedRows)
          : op === 'DELETE' ? say.redisDelete(tables, command, r.affectedRows) : say.redisOther(command, tables);
      } else if (op === 'SELECT' || op === 'WITH' || op === 'PRAGMA') text = say.read(tables, r.rows);
      else if (op === 'INSERT') text = say.insert(tables, r.affectedRows);
      else if (op === 'UPDATE') text = say.update(tables, r.affectedRows);
      else if (op === 'DELETE') text = say.delete(tables, r.affectedRows);
      else if (op === 'CREATE') text = say.create(tables, /\bif\s+not\s+exists\b/i.test(step.sql ?? ''));
      else if (op === 'ALTER') text = say.alter(tables);
      else if (op === 'DROP') text = say.drop(tables);
      else text = say.otherDb(op, tables);
      break;
    }
    case 'http': text = say.http(step.method ?? '', step.host ?? '', step.path ?? '', r.status); break;
    case 'ia': text = say.ai(step.provider, r.model ?? step.model, r.usage); break;
    case 'email': text = say.email(step.to ?? [], step.subject); break;
    case 'mensagem': text = say.message(step.to ?? [], step.provider ?? step.library); break;
    case 'pagamento': text = say.payment(step.provider, step.operation, label(step.mode)); break;
    case 'ficheiros': {
      const where = step.bucket ? `${step.provider} ${step.bucket}` : step.path ?? step.provider;
      text = step.operation === 'leitura' || step.operation === 'verificação' ? say.fileRead(where, r.bytes) : say.fileWrite(label(step.operation ?? '?'), where, step.bytes);
      break;
    }
    case 'autenticação': text = say.auth(step.provider ?? step.library, label(step.operation)); break;
    default: text = `${label(step.kind)}${step.operation ? `: ${label(step.operation)}` : ''}`;
  }
  return failed ? `${text} — ${say.failed}` : text;
}
