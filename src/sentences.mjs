// Frases fixas, geradas só dos factos gravados (modo sem IA e base de
// comparação para as frases da IA), em inglês.
// Nenhuma frase interpreta o nome de uma função: diz o que se observou.

// The recordings keep their values in Portuguese (kinds, operations, modes):
// they are translated only when shown.
export const LABELS = {
  'base-de-dados': 'database', ia: 'AI', mensagem: 'message', pagamento: 'payment', ficheiros: 'files', 'autenticação': 'authentication',
  leitura: 'read', escrita: 'write', 'remoção': 'delete', 'cópia': 'copy', 'mudança de nome': 'rename', 'criação de pasta': 'create folder',
  'verificação': 'check', 'verificação de sessão': 'session check', teste: 'test', 'produção': 'live', desconhecido: 'unknown',
  'SMTP/transporte': 'SMTP/transport', presente: 'present', ausente: 'absent', '(descritor)': '(descriptor)',
  minimo: 'minimal', 'modelo local': 'local model',
  // Recorded by the page bar before 0.3.0.
  'saída da página': 'page exit', 'endereço mudou': 'address changed', 'endereço substituído': 'address replaced',
  'recuar/avançar': 'back/forward', 'ligação interna': 'in-page link', 'tempo máximo': 'time limit', 'sem atividade': 'idle', 'navegação': 'navigation',
};
export function label(value) { return LABELS[value] ?? value; }

const list = (items, and) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
const names = (items, and, max = 4) => items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max})` : list(items, and);

function duration(ms) {
  if (ms == null) return '';
  return ms < 1 ? ms.toFixed(2) + ' ms' : ms < 1000 ? ms.toFixed(1) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

const EN = {
  and: 'and',
  rows: n => `${n} ${n === 1 ? 'row' : 'rows'}`,
  read: (tables, rows) => `Reads ${tables || 'the database'}${rows != null ? ` (${EN.rows(rows)})` : ''}`,
  insert: (tables, n) => `Adds ${n == null ? 'rows' : EN.rows(n)} to ${tables || 'a table'}`,
  update: (tables, n) => n === 0 ? `Tries to change ${tables || 'a table'}; no rows changed` : `Changes ${n == null ? 'rows' : EN.rows(n)} in ${tables || 'a table'}`,
  delete: (tables, n) => n === 0 ? `Tries to delete from ${tables || 'a table'}; no rows deleted` : `Deletes ${n == null ? 'rows' : EN.rows(n)} from ${tables || 'a table'}`,
  create: (tables, ifNot) => `Creates table ${tables || ''}${ifNot ? ' if it does not exist' : ''}`.trim(),
  alter: tables => `Changes the structure of ${tables || 'a table'}`,
  drop: tables => `Drops ${tables || 'a table'}`,
  otherDb: (op, tables) => `${op} command on the database${tables ? ` (${tables})` : ''}`,
  failed: 'failed',
  http: (method, host, path, status) => `Calls ${host}: ${method} ${path}${status != null ? ` (status ${status})` : ''}`,
  ai: (provider, model, usage) => `Asks ${provider} for a response${model ? ` (${model})` : ''}${usage ? ` · ${usage.input ?? '?'} + ${usage.output ?? '?'} tokens` : ''}`,
  email: (to, subject) => `Sends an email${to.length ? ` to ${to.join(', ')}` : ''}${subject ? ` “${subject}”` : ''}`,
  message: (to, provider) => `Sends a message via ${provider}${to.length ? ` to ${to.join(', ')}` : ''}`,
  payment: (provider, operation, mode) => `Payment on ${provider}: ${operation} (${mode} mode)`,
  fileRead: (where, bytes) => `Reads file ${where}${bytes ? ` (${bytes} bytes)` : ''}`,
  fileWrite: (op, where, bytes) => `File ${op}: ${where}${bytes ? ` (${bytes} bytes)` : ''}`,
  auth: (provider, operation) => `Authentication with ${provider}${operation ? `: ${operation}` : ''}`,
  calls: items => `calls ${items}`,
  noBoundary: 'Internal work: no boundary observed',
  opaque: 'Not observable: runs in compiled or generated code that CodeTAC cannot see into',
  templatePart: file => `renders HTML from ${file}`,
  error: 'ended with an error',
  unfinished: 'did not finish during the recording',
  dbSetupPart: n => `runs ${n} database structure commands`,
  readPart: tables => `reads ${tables}`,
  writePart: (verb, tables) => `${verb} ${tables}`,
  writeVerbs: { INSERT: 'adds to', UPDATE: 'changes', DELETE: 'deletes from', REPLACE: 'replaces in', UPSERT: 'adds or changes', MERGE: 'merges into' },
  idleWritePart: tables => `tries to write to ${tables} without changing rows`,
  httpPart: hosts => `calls ${hosts}`,
  aiPart: providers => `asks ${providers} for responses`,
  emailPart: n => n === 1 ? 'sends an email' : `sends ${n} emails`,
  paymentPart: providers => `makes payments on ${providers}`,
  filePart: ops => `files: ${ops}`,
  authPart: providers => `authentication with ${providers}`,
  dbSetup: (n, counts, tables, failed, changed, parentOk) => `Database setup: ${n} commands (${counts}) on ${tables} ${tables === 1 ? 'table' : 'tables'}` +
    (failed ? ` · ${failed} failed${parentOk ? ' without stopping the function' : ''}` : '') +
    (changed ? ` · includes writes that changed ${EN.rows(changed)}` : ''),
  repeated: (sentence, n) => `${sentence} — ${n} times in a row`,
  block: (times, size, what) => `The same ${size} steps repeated ${times} times${what ? `: ${what}` : ''}`,
  helpers: (n, fns) => `${n} helper functions with no boundaries: ${fns}`,
  generated: n => `${n} functions of bundler-generated code`,
  devTools: n => `${n} development tool ${n === 1 ? 'request' : 'requests'} (recompilation, hot reload)`,
  effects: {
    added: (n, table) => `${n == null ? 'Rows' : EN.rows(n)} added to ${table}`,
    changed: (n, table) => `${n == null ? 'Rows' : EN.rows(n)} changed in ${table}`,
    deleted: (n, table) => `${n == null ? 'Rows' : EN.rows(n)} deleted from ${table}`,
    otherWrite: (op, table) => `${op} on ${table}`,
    noChange: (op, table, n) => `${op} on ${table} changed no rows${n > 1 ? ` (${n} times)` : ''}`,
    structure: (ok, failed) => `${ok + failed} database structure commands (${ok} without error${failed ? `, ${failed} failed` : ''}); the recording does not show whether they changed the database`,
    email: (to, subject, failed) => `${failed ? 'Failed email attempt' : 'Email sent'}${to.length ? ` to ${to.join(', ')}` : ''}${subject ? ` “${subject}”` : ''}`,
    message: (provider, failed) => `${failed ? 'Failed message attempt' : 'Message sent'} via ${provider}`,
    payment: (provider, operation, mode) => `Payment on ${provider}: ${operation} (${mode} mode)`,
    file: (op, where) => `File: ${op} on ${where}`,
    cookieSet: names => `Cookies stored in the browser: ${names}`,
    cookieCleared: names => `Cookies deleted in the browser: ${names}`,
    ai: (provider, model, usage, cost) => `AI call to ${provider}${model ? ` (${model})` : ''}${usage ? ` · ${usage.input ?? '?'} + ${usage.output ?? '?'} tokens` : ''}${cost != null ? ` · ~US$ ${cost.toFixed(4)}` : ''}`,
    external: (method, host, n) => `External ${method} call to ${host}${n > 1 ? ` (${n} times)` : ''}`,
    none: 'No lasting effect observed.',
    unseen: 'Not observed: browser local storage and effects on unrecognised services.',
  },
  action: {
    click: label => `Click on ${label}`,
    submit: label => `Submit of ${label}`,
    change: label => `Change in ${label}`,
    continuation: 'Continuation after navigation',
    request: (method, path, status) => `${method} ${path}${status != null ? ` (status ${status})` : ''}`,
    noServer: 'no server requests',
    screen: 'changes the screen',
    noScreen: 'no visible change on screen',
    navigates: path => `goes to ${path}`,
  },
};

export function texts() { return EN; }
export { duration, names, list };

// The sentence of one boundary, from its recorded facts.
export function boundarySentence(step) {
  const t = texts();
  const r = step.result ?? {};
  const failed = step.error || r.error;
  const tables = (step.tables ?? []).join(', ');
  let text;
  switch (step.kind) {
    case 'base-de-dados': {
      const op = step.operation;
      if (op === 'SELECT' || op === 'WITH' || op === 'PRAGMA') text = t.read(tables, r.rows);
      else if (op === 'INSERT') text = t.insert(tables, r.affectedRows);
      else if (op === 'UPDATE') text = t.update(tables, r.affectedRows);
      else if (op === 'DELETE') text = t.delete(tables, r.affectedRows);
      else if (op === 'CREATE') text = t.create(tables, /\bif\s+not\s+exists\b/i.test(step.sql ?? ''));
      else if (op === 'ALTER') text = t.alter(tables);
      else if (op === 'DROP') text = t.drop(tables);
      else text = t.otherDb(op, tables);
      break;
    }
    case 'http': text = t.http(step.method ?? '', step.host ?? '', step.path ?? '', r.status); break;
    case 'ia': text = t.ai(step.provider, r.model ?? step.model, r.usage); break;
    case 'email': text = t.email(step.to ?? [], step.subject); break;
    case 'mensagem': text = t.message(step.to ?? [], step.provider ?? step.library); break;
    case 'pagamento': text = t.payment(step.provider, step.operation, label(step.mode)); break;
    case 'ficheiros': {
      const where = step.bucket ? `${step.provider} ${step.bucket}` : step.path ?? step.provider;
      text = step.operation === 'leitura' || step.operation === 'verificação' ? t.fileRead(where, r.bytes) : t.fileWrite(label(step.operation ?? '?'), where, step.bytes);
      break;
    }
    case 'autenticação': text = t.auth(step.provider ?? step.library, label(step.operation)); break;
    default: text = `${label(step.kind)}${step.operation ? `: ${label(step.operation)}` : ''}`;
  }
  return failed ? `${text} — ${t.failed}` : text;
}
