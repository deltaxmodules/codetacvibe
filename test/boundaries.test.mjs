import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { classifyHttp, describeSql, safePath, aiResponseDetails } from '../src/boundaries.mjs';

// Runs an entry file inside a temporary project and returns the recorded events.
function project(files, entry = 'entry.mjs', env = {}) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const result = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), join(dir, entry)], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label, ...env }, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const events = readdirSync(resolve('.codetac', label)).flatMap(file =>
    readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return { events, stdout: result.stdout, dir };
}

test('pedido HTTP é uma unidade: funções, fetch e SQLite ligados ao mesmo requestId, pela ordem', () => {
  const { events } = project({ 'entry.mjs': `import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec("create table invoices (id integer primary key, total real)");
function save(total) { return db.prepare('insert into invoices (total) values (?)').run(total); }
async function notify() { const r = await fetch('http://127.0.0.1:' + server.address().port + '/ping?token=abc'); return r.status; }
async function handler(req, res) {
  if (req.url.startsWith('/ping')) { res.end('pong'); return; }
  save(42);
  await notify();
  res.end('ok');
}
const server = http.createServer(handler).listen(0, '127.0.0.1', async () => {
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/invoices?secret=xyz');
  console.log(await response.text());
  server.close();
});` });
  const requests = events.filter(e => e.type === 'request');
  const main = requests.find(e => e.path === '/invoices');
  assert.ok(main, 'pedido principal gravado');
  assert.deepEqual(main.queryKeys, ['secret']);
  assert.equal(events.find(e => e.type === 'request-end' && e.requestId === main.requestId).status, 200);
  const mine = events.filter(e => e.requestId === main.requestId);
  const sequence = mine.filter(e => ['enter', 'boundary'].includes(e.type))
    .map(e => e.type === 'enter' ? e.function : `${e.kind}:${e.operation ?? e.method}`);
  assert.deepEqual(sequence, ['handler', 'save', 'base-de-dados:INSERT', 'notify', 'http:GET']);
  const insert = mine.find(e => e.type === 'boundary' && e.kind === 'base-de-dados');
  assert.deepEqual(insert.tables, ['invoices']);
  assert.equal(insert.parentId, mine.find(e => e.function === 'save').id);
  assert.equal(events.find(e => e.type === 'boundary-end' && e.id === insert.id).affectedRows, 1);
  const call = mine.find(e => e.type === 'boundary' && e.kind === 'http');
  assert.equal(call.path, '/ping');
  assert.equal(events.find(e => e.type === 'boundary-end' && e.id === call.id).status, 200);
  assert.ok(!JSON.stringify(events).includes('xyz') && !JSON.stringify(events).includes('abc'));
});

test('mysql2 carregado de node_modules e dentro de um bundle com source map', () => {
  const connection = `const { EventEmitter } = require('node:events');
class BaseConnection {
  query(sql, values, cb) {
    const command = new EventEmitter();
    command.onResult = cb;
    setTimeout(() => { command.onResult(null, [{ id: 1 }, { id: 2 }]); command.emit('end'); }, 1);
    return command;
  }
}
module.exports = BaseConnection;
`;
  const direct = project({
    'node_modules/mysql2/lib/base/connection.js': connection,
    'entry.cjs': `const Connection = require('./node_modules/mysql2/lib/base/connection.js');
function load(email) { return new Promise(ok => new Connection().query("select * from users where email = 'jorge@example.com' and id = ?", [email], (e, rows) => ok(rows.length))); }
load('x').then(n => console.log(n));`,
  }, 'entry.cjs');
  assert.equal(direct.stdout.trim(), '2');
  const boundary = direct.events.find(e => e.type === 'boundary');
  assert.equal(boundary.library, 'mysql2');
  assert.equal(boundary.sql, "select * from users where email = '?' and id = ?");
  // The query runs inside the Promise executor arrow, itself called by load.
  const executor = direct.events.find(e => e.id === boundary.parentId);
  assert.equal(executor.function, '<anonymous>');
  assert.equal(executor.parentId, direct.events.find(e => e.function === 'load').id);
  assert.equal(direct.events.find(e => e.type === 'boundary-end').rows, 2);
  assert.ok(!JSON.stringify(direct.events).includes('jorge@example.com'));

  // Bundle: the library code arrives inside eval, mapped to node_modules.
  const dir = resolve('.codetac', `bundle-${randomUUID()}`);
  mkdirSync(join(dir, 'node_modules/mysql2/lib/base'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/mysql2/lib/base/connection.js'), connection);
  const map = { version: 3, sources: [join(dir, 'node_modules/mysql2/lib/base/connection.js')], names: [],
    mappings: connection.split('\n').map((_, index) => index === 0 ? 'AAAA' : 'AACA').join(';') };
  const inner = `${connection}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
  const bundled = project({ 'bundle.cjs': `const module1 = { exports: {} };
(function (module, exports, require) { eval(${JSON.stringify(inner)}); })(module1, module1.exports, require);
new module1.exports().query('update invoices set paid = 1', [], (e, rows) => console.log('done'));` }, 'bundle.cjs');
  assert.equal(bundled.stdout.trim(), 'done');
  const update = bundled.events.find(e => e.type === 'boundary');
  assert.equal(update?.operation, 'UPDATE');
  assert.deepEqual(update.tables, ['invoices']);
});

test('nodemailer: email com destinatário mascarado, assunto e resultado', () => {
  const { events } = project({
    'node_modules/nodemailer/lib/mailer/index.js': `class Mail {
  sendMail(data, callback = null) {
    if (!callback) return new Promise(ok => setTimeout(() => ok({ accepted: [data.to], rejected: [] }), 1));
    setTimeout(() => callback(null, { accepted: [data.to], rejected: [] }), 1);
  }
}
module.exports = Mail;`,
    'entry.cjs': `const Mail = require('./node_modules/nodemailer/lib/mailer/index.js');
async function sendInvoice() { await new Mail().sendMail({ to: 'cliente@example.com', subject: 'Fatura 12', text: 'segredo' }); }
sendInvoice().then(() => new Mail().sendMail({ to: 'b@example.com', subject: 'Cb' }, () => console.log('cb')));`,
  }, 'entry.cjs');
  const mails = events.filter(e => e.type === 'boundary' && e.kind === 'email');
  assert.equal(mails.length, 2);
  assert.deepEqual(mails[0].to, ['c***@e***']);
  assert.equal(mails[0].subject, 'Fatura 12');
  assert.equal(events.filter(e => e.type === 'boundary-end').length, 2);
  assert.ok(!JSON.stringify(events).includes('segredo') && !JSON.stringify(events).includes('cliente@example.com'));
});

test('classificação de serviços externos sem gravar cabeçalhos nem valores', () => {
  const openai = classifyHttp({ method: 'POST', url: 'https://api.openai.com/v1/responses', headers: { authorization: 'Bearer sk-proj-xyz' },
    body: JSON.stringify({ model: 'gpt-5', input: 'olá' }), client: 'fetch' });
  assert.equal(openai.kind, 'ia');
  assert.equal(openai.model, 'gpt-5');
  assert.ok(!JSON.stringify(openai).includes('sk-proj') && !JSON.stringify(openai).includes('olá'));
  const stripe = classifyHttp({ method: 'POST', url: 'https://api.stripe.com/v1/payment_intents', headers: { authorization: 'Bearer sk_test_123' },
    body: 'amount=1999&currency=eur', client: 'fetch' });
  assert.deepEqual([stripe.kind, stripe.mode, stripe.amount, stripe.currency], ['pagamento', 'teste', '1999', 'eur']);
  const s3 = classifyHttp({ method: 'PUT', url: 'https://bucket-x.s3.eu-west-1.amazonaws.com/faturas/a.pdf', client: 'http',
    headers: { authorization: 'AWS4-HMAC-SHA256 Credential=...', 'content-length': '2048' }, body: null });
  assert.deepEqual([s3.kind, s3.bucket, s3.operation, s3.bytes], ['ficheiros', 'bucket-x', 'escrita', 2048]);
  const presigned = classifyHttp({ method: 'GET', url: 'https://storage.example.app/fotos/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123',
    headers: {}, body: null, client: 'fetch' });
  assert.deepEqual([presigned.kind, presigned.bucket, presigned.operation], ['ficheiros', 'fotos', 'leitura']);
  assert.ok(!JSON.stringify(presigned).includes('abc123'));
  const supabase = classifyHttp({ method: 'PATCH', url: 'https://abc.supabase.co/rest/v1/invoices?id=eq.5', headers: {}, body: null, client: 'fetch' });
  assert.deepEqual([supabase.kind, supabase.operation, supabase.tables], ['base-de-dados', 'UPDATE', ['invoices']]);
  const mail = classifyHttp({ method: 'POST', url: 'https://api.resend.com/emails', headers: {}, client: 'fetch',
    body: JSON.stringify({ to: ['ana@example.com'], subject: 'Olá' }) });
  assert.deepEqual([mail.kind, mail.provider, mail.subject], ['email', 'Resend', 'Olá']);
  assert.equal(classifyHttp({ method: 'GET', url: 'https://api.example.com/x', headers: {}, client: 'fetch' }).kind, 'http');
});

test('SQL e caminhos gravados sem valores', () => {
  assert.equal(describeSql("SELECT * FROM users WHERE password = 'hunter2' AND id = ?").sql, "SELECT * FROM users WHERE password = '?' AND id = ?");
  assert.deepEqual(describeSql('insert into `student_sessions` (token) values (?)').tables, ['student_sessions']);
  assert.equal(safePath('/verify/eyJhbGciOiJIUzI1NiJ9abc123/x'), '/verify/[REDACTED]/x');
  assert.equal(safePath('/api/aluno/individual-tests'), '/api/aluno/individual-tests');
});

test('IA: modelo, tokens e excertos (JSON e streaming), sem chaves', () => {
  const { events } = project({ 'entry.mjs': `import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (JSON.parse(body).stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"Olá "}}]}\\n\\n');
      res.write('data: {"choices":[{"delta":{"content":"mundo"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\\n\\n');
      res.end('data: [DONE]\\n\\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output_text: 'Fatura de 12 euros.', usage: { input_tokens: 30, output_tokens: 6 } }));
    }
  });
}).listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  async function summarize() {
    const r = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer sk-proj-segredo123456' },
      body: JSON.stringify({ model: 'gpt-teste', input: 'Resume a fatura do cliente ana@example.com' }) });
    return (await r.json()).output_text;
  }
  async function chat() {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'llama-local', stream: true, messages: [{ role: 'user', content: 'Diz olá' }] }) });
    return r.text();
  }
  console.log(await summarize(), (await chat()).length > 0);
  server.close();
});` });
  const calls = events.filter(e => e.type === 'boundary' && e.kind === 'ia');
  assert.equal(calls.length, 2);
  const ends = calls.map(call => events.find(e => e.type === 'boundary-end' && e.id === call.id));
  assert.deepEqual([ends[0].usage, ends[0].answerExcerpt], [{ input: 30, output: 6 }, 'Fatura de 12 euros.']);
  assert.equal(ends[0].model, 'gpt-teste');
  assert.equal(ends[0].promptExcerpt, 'Resume a fatura do cliente a***@e***');
  assert.deepEqual([ends[1].usage, ends[1].answerExcerpt, ends[1].model], [{ input: 7, output: 2 }, 'Olá mundo', 'llama-local']);
  assert.equal(calls[1].provider, 'local model');
  assert.ok(!JSON.stringify(events).includes('segredo123456'));
});

test('IA: formatos Anthropic e Google', () => {
  assert.deepEqual(aiResponseDetails(JSON.stringify({ content: [{ type: 'text', text: 'Olá' }], usage: { input_tokens: 3, output_tokens: 1 } })),
    { usage: { input: 3, output: 1 }, answerExcerpt: 'Olá' });
  assert.deepEqual(aiResponseDetails(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Oi' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } })),
    { usage: { input: 4, output: 1 }, answerExcerpt: 'Oi' });
});

test('ficheiros: operações do código do projeto num pedido; bibliotecas e arranque ficam de fora', () => {
  const { events } = project({
    'node_modules/lib-x/index.js': `const fs = require('node:fs'); exports.touch = file => fs.writeFileSync(file, 'x');`,
    'entry.mjs': `import http from 'node:http';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const lib = createRequire(import.meta.url)('./node_modules/lib-x/index.js');
const dir = new URL('./', import.meta.url);
await writeFile(new URL('arranque.txt', dir), 'fora de pedido');
async function upload(req, res) {
  await writeFile(new URL('fatura.pdf', dir), Buffer.alloc(2048));
  const data = await readFile(new URL('fatura.pdf', dir));
  lib.touch(new URL('lib.txt', dir));
  await rm(new URL('fatura.pdf', dir));
  res.end(String(data.length));
}
const server = http.createServer(upload).listen(0, '127.0.0.1', async () => {
  console.log(await (await fetch('http://127.0.0.1:' + server.address().port + '/upload')).text());
  server.close();
});` });
  const files = events.filter(e => e.type === 'boundary' && e.kind === 'ficheiros');
  assert.deepEqual(files.map(e => [e.operation, e.path, e.bytes]), [['escrita', 'fatura.pdf', 2048], ['leitura', 'fatura.pdf', undefined], ['remoção', 'fatura.pdf', undefined]]);
  assert.ok(files.every(e => e.requestId));
  const read = events.find(e => e.type === 'boundary-end' && e.id === files[1].id);
  assert.equal(read.bytes, 2048);
});

test('autenticação NextAuth: sessão presente ou ausente, sem conteúdo', () => {
  const { events } = project({
    'node_modules/next-auth/next/index.js': `async function getServerSession(options) { return options.logged ? { user: { email: 'ana@example.com' } } : null; }
exports.getServerSession = getServerSession;`,
    'entry.cjs': `const { getServerSession } = require('./node_modules/next-auth/next/index.js');
async function page() { return [await getServerSession({ logged: true }), await getServerSession({ logged: false })]; }
page().then(r => console.log(r.length));`,
  }, 'entry.cjs');
  const checks = events.filter(e => e.type === 'boundary' && e.kind === 'autenticação');
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map(check => events.find(e => e.type === 'boundary-end' && e.id === check.id).sessao), ['presente', 'ausente']);
  assert.ok(!JSON.stringify(events).includes('ana@example.com'));
});

test('os lotes do próprio CodeTAC, esvaziados a meio de um pedido, não aparecem como escrita de ficheiros', () => {
  // Enough calls inside one request to fill a batch (256 KB) before it ends.
  const { events } = project({ 'entry.mjs': `import http from 'node:http';
function tiny(n) { return n + 1; }
function handler(req, res) { let total = 0; for (let i = 0; i < 4000; i++) total = tiny(total); res.end(String(total)); }
const server = http.createServer(handler).listen(0, '127.0.0.1', async () => {
  console.log(await (await fetch('http://127.0.0.1:' + server.address().port + '/')).text());
  server.close();
});
` });
  assert.ok(events.filter(event => event.type === 'enter').length >= 4000);
  assert.deepEqual(events.filter(event => event.type === 'boundary' && event.kind === 'ficheiros'), []);
});
