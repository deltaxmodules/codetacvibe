import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { classifyHttp, describeSql, safePath, aiResponseDetails, redisKeyPattern, describeRedis, redisResult } from '../src/boundaries.mjs';

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

test('IA por http/https (axios, SDKs antigos): tokens e excertos, respostas comprimidas, sem chaves', () => {
  const { events, stdout } = project({ 'entry.mjs': `import http from 'node:http';
import zlib from 'node:zlib';
const answer = JSON.stringify({ choices: [{ message: { content: 'Total: 12 euros.' } }], usage: { prompt_tokens: 21, completion_tokens: 5 } });
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const { stream } = JSON.parse(body);
    if (stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"type":"content_block_delta","delta":{"text":"Bom "}}\\n\\n');
      setTimeout(() => res.end('data: {"type":"content_block_delta","delta":{"text":"dia"}}\\n\\ndata: {"type":"message_delta","usage":{"input_tokens":9,"output_tokens":2}}\\n\\n'), 20);
    } else if (req.headers['x-enc'] === 'br') {
      res.setHeader('content-encoding', 'br'); res.end(zlib.brotliCompressSync(answer));
    } else {
      res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(answer));
    }
  });
}).listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  function post(path, payload, headers = {}) {
    return new Promise((ok, fail) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
        headers: { authorization: 'Bearer sk-proj-segredo987654', 'content-type': 'application/json', ...headers } }, res => {
        const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => ok(Buffer.concat(parts)));
      });
      req.on('error', fail);
      const text = JSON.stringify(payload);
      req.write(text.slice(0, 10)); req.end(text.slice(10));
    });
  }
  async function viaHttp() {
    const raw = await post('/v1/chat/completions', { model: 'gpt-http', messages: [{ role: 'user', content: 'Soma a fatura de ana@example.com' }] });
    return JSON.parse(zlib.gunzipSync(raw)).choices[0].message.content;
  }
  async function viaHttpBrotli() {
    const raw = await post('/v1/chat/completions', { model: 'gpt-br', messages: [{ role: 'user', content: 'Outra' }] }, { 'x-enc': 'br' });
    return JSON.parse(zlib.brotliDecompressSync(raw)).usage.prompt_tokens;
  }
  async function viaHttpStream() {
    return (await post('/v1/messages', { model: 'claude-teste', stream: true, messages: [{ role: 'user', content: 'Saúda' }] })).toString();
  }
  async function viaFetchGzip() {
    const r = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'gpt-fetch', messages: [{ role: 'user', content: 'Via fetch' }] }) });
    return (await r.json()).usage.completion_tokens;
  }
  console.log(JSON.stringify([await viaHttp(), await viaHttpBrotli(), (await viaHttpStream()).includes('dia'), await viaFetchGzip()]));
  server.close();
});` });
  assert.deepEqual(JSON.parse(stdout), ['Total: 12 euros.', 21, true, 5]);
  const calls = events.filter(e => e.type === 'boundary' && e.kind === 'ia');
  assert.equal(calls.length, 4);
  const ends = calls.map(call => events.find(e => e.type === 'boundary-end' && e.id === call.id));
  assert.deepEqual([calls[0].library, ends[0].model, ends[0].usage, ends[0].answerExcerpt, ends[0].status],
    ['http', 'gpt-http', { input: 21, output: 5 }, 'Total: 12 euros.', 200]);
  assert.equal(ends[0].promptExcerpt, 'Soma a fatura de a***@e***');
  assert.deepEqual([ends[1].model, ends[1].usage], ['gpt-br', { input: 21, output: 5 }]);
  assert.deepEqual([ends[2].model, ends[2].usage, ends[2].answerExcerpt, ends[2].stream], ['claude-teste', { input: 9, output: 2 }, 'Bom dia', true]);
  assert.ok(ends[2].durationNs >= 15e6, 'a chamada em streaming acaba com o corpo, não com os cabeçalhos');
  assert.deepEqual([calls[3].library, ends[3].model, ends[3].usage], ['fetch', 'gpt-fetch', { input: 21, output: 5 }]);
  assert.ok(!JSON.stringify(events).includes('segredo987654'));
});

test('IA por fetch com resposta comprimida (gzip, br, deflate): tokens e excertos', () => {
  const { events, stdout } = project({ 'entry.mjs': `import http from 'node:http';
import zlib from 'node:zlib';
const answer = JSON.stringify({ choices: [{ message: { content: 'Total: 12 euros.' } }], usage: { prompt_tokens: 21, completion_tokens: 5 } });
const encoders = { gzip: zlib.gzipSync, br: zlib.brotliCompressSync, deflate: zlib.deflateSync };
const server = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    const encoding = req.headers['x-enc'];
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-encoding', encoding);
    res.end(encoders[encoding](answer));
  });
}).listen(0, '127.0.0.1', async () => {
  const results = [];
  for (const encoding of Object.keys(encoders)) {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer sk-proj-segredo555444', 'x-enc': encoding },
      body: JSON.stringify({ model: 'gpt-' + encoding, messages: [{ role: 'user', content: 'Soma a fatura' }] }) });
    results.push((await r.json()).usage.completion_tokens);
  }
  console.log(JSON.stringify(results));
  server.close();
});` });
  assert.deepEqual(JSON.parse(stdout), [5, 5, 5]);
  const calls = events.filter(e => e.type === 'boundary' && e.kind === 'ia');
  assert.equal(calls.length, 3);
  const ends = calls.map(call => events.find(e => e.type === 'boundary-end' && e.id === call.id));
  assert.deepEqual(ends.map(end => [end.model, end.usage, end.answerExcerpt]), ['gzip', 'br', 'deflate'].map(encoding =>
    [`gpt-${encoding}`, { input: 21, output: 5 }, 'Total: 12 euros.']));
  assert.ok(!JSON.stringify(events).includes('segredo555444'));
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

test('MongoDB: cada comando do driver é uma fronteira, com coleção e nomes dos filtros, sem valores', () => {
  const execute = `class Find { get commandName() { return 'find'; } constructor(filter) { this.ns = { collection: 'users' }; this.filter = filter; } }
class Insert { get commandName() { return 'insert'; } constructor() { this.ns = { collection: 'users' }; } }
class EndSessions { get commandName() { return 'endSessions'; } }
async function executeOperation(client, operation) {
  await new Promise(ok => setTimeout(ok, 1));
  if (operation.commandName === 'find') return { length: 3 };
  if (operation.commandName === 'insert') return { acknowledged: true, insertedId: 'x' };
  return { ok: 1 };
}
module.exports = { executeOperation, Find, Insert, EndSessions };
`;
  const { events, stdout } = project({
    'node_modules/mongodb/lib/operations/execute_operation.js': execute,
    'entry.cjs': `const m = require('./node_modules/mongodb/lib/operations/execute_operation.js');
async function signup() {
  const found = await m.executeOperation({}, new m.Find({ email: 'jorge@example.com', age: { $gt: 18 } }));
  await m.executeOperation({}, new m.Insert());
  await m.executeOperation({}, new m.EndSessions());
  return found.length;
}
signup().then(n => console.log(n));`,
  }, 'entry.cjs');
  assert.equal(stdout.trim(), '3');
  const boundaries = events.filter(e => e.type === 'boundary');
  assert.deepEqual(boundaries.map(b => [b.library, b.operation, b.command, b.tables]),
    [['mongodb', 'SELECT', 'find', ['users']], ['mongodb', 'INSERT', 'insert', ['users']]]);
  assert.deepEqual(boundaries[0].filterKeys, ['email', 'age']);
  assert.equal(boundaries[0].sql, 'users.find({ email: …, age: … })');
  assert.equal(boundaries[0].parentId, events.find(e => e.function === 'signup').id);
  const ends = Object.fromEntries(events.filter(e => e.type === 'boundary-end').map(e => [e.id, e]));
  assert.equal(ends[boundaries[0].id].rows, 3);
  assert.equal(ends[boundaries[1].id].affectedRows, 1);
  assert.ok(!JSON.stringify(events).includes('jorge@example.com'));
});

test('Prisma com o motor nativo: cada operação do cliente é uma fronteira; com adaptador, não (o SQL já aparece)', () => {
  const runtimeFile = `module.exports = function operation(method, model, value) {
  return globalThis.PRISMA_INSTRUMENTATION.helper.runInChildSpan({ name: 'operation', attributes: { method, model, name: model + '.' + method } }, async () => value);
};
`;
  const { events } = project({
    'node_modules/@prisma/client/runtime/library.js': runtimeFile,
    'node_modules/@prisma/client/runtime/client.js': runtimeFile,
    'entry.cjs': `const native = require('./node_modules/@prisma/client/runtime/library.js');
const adapter = require('./node_modules/@prisma/client/runtime/client.js');
async function checkout() {
  await native('findMany', 'Invoice', [{ id: 1 }, { id: 2 }]);
  await native('updateMany', 'Invoice', { count: 3 });
  await native('create', 'Payment', { id: 9, card: '4242' });
  await adapter('create', 'Payment', { id: 10 });
}
checkout();`,
  }, 'entry.cjs');
  const boundaries = events.filter(e => e.type === 'boundary');
  assert.deepEqual(boundaries.map(b => [b.library, b.operation, b.tables[0], b.sql]),
    [['prisma', 'SELECT', 'Invoice', 'Invoice.findMany(…)'], ['prisma', 'UPDATE', 'Invoice', 'Invoice.updateMany(…)'], ['prisma', 'INSERT', 'Payment', 'Payment.create(…)']]);
  const ends = boundaries.map(b => events.find(e => e.type === 'boundary-end' && e.id === b.id));
  assert.deepEqual(ends.map(e => e.rows ?? e.affectedRows), [2, 3, 1]);
  assert.equal(boundaries[0].parentId, events.find(e => e.function === 'checkout').id);
  assert.ok(!JSON.stringify(events).includes('4242'));
});

test('postgres.js: a query é uma fronteira quando é enviada, uma só vez, sem valores; as internas não contam', () => {
  const query = `class Query extends Promise {
  constructor(strings, args, handler) { let resolve, reject; super((a, b) => { resolve = a; reject = b; });
    Object.assign(this, { strings, args, handler, executed: false, resolve, reject }); }
  static get [Symbol.species]() { return Promise; }
  async handle() { !this.executed && (this.executed = true) && await 1 && this.handler(this); }
  then() { this.handle(); return super.then.apply(this, arguments); }
  catch() { this.handle(); return super.catch.apply(this, arguments); }
}
module.exports = { Query };
`;
  const { events, stdout } = project({
    'node_modules/postgres/cjs/src/query.js': query,
    'entry.cjs': `const { Query } = require('./node_modules/postgres/cjs/src/query.js');
function handler(q) { setTimeout(() => {
  const text = q.strings.join('?');
  if (text.startsWith('select')) { const rows = [{ id: 1 }, { id: 2 }]; rows.command = 'SELECT'; rows.count = 2; q.resolve(rows); }
  else { const rows = []; rows.command = 'UPDATE'; rows.count = 3; q.resolve(rows); }
}, 1); }
function execute(q) { handler(q); }
const sql = (strings, ...args) => new Query(strings, args, handler);
async function settle(customer) {
  await new Query(['select b.oid from pg_type'], [], execute);
  const open = sql\`select id from orders where customer = \${customer} and total > \${10}\`;
  open.catch(() => {});
  const rows = await open;
  const changed = await sql\`update orders set status = 'paid' where customer = \${customer}\`;
  return rows.length + changed.count;
}
settle('Cliente-Secreto-771').then(n => console.log(n));`,
  }, 'entry.cjs');
  assert.equal(stdout.trim(), '5');
  const boundaries = events.filter(e => e.type === 'boundary');
  assert.deepEqual(boundaries.map(b => [b.library, b.operation, b.tables, b.sql]), [
    ['postgres', 'SELECT', ['orders'], 'select id from orders where customer = $1 and total > $2'],
    ['postgres', 'UPDATE', ['orders'], "update orders set status = '?' where customer = $1"]]);
  assert.equal(boundaries[0].parentId, events.find(e => e.function === 'settle').id);
  const ends = Object.fromEntries(events.filter(e => e.type === 'boundary-end').map(e => [e.id, e]));
  assert.deepEqual([ends[boundaries[0].id].rows, ends[boundaries[1].id].affectedRows], [2, 3]);
  assert.ok(!JSON.stringify(events).includes('Cliente-Secreto-771'));
});

test('Redis (ioredis e node-redis): comando e padrão da chave, sem valores; comandos internos e reenvios não contam', () => {
  const ioredis = `class Redis {
  constructor() { this.queue = []; }
  sendCommand(command) {
    if (!this.ready) { this.queue.push(command); return command.promise; }
    setTimeout(() => command.resolve(command.reply), 1);
    return command.promise;
  }
  connect() { this.ready = true; for (const command of this.queue.splice(0)) this.sendCommand(command); }
}
class Command {
  constructor(name, args, reply) { this.name = name; this.args = args; this.reply = reply;
    this.promise = new Promise(ok => { this.resolve = ok; }); }
  getKeys() { return ['auth', 'info'].includes(this.name) ? [] : [this.args[0]]; }
}
module.exports = { Redis, Command };
`;
  const queue = `class RedisCommandsQueue {
  addCommand(args, options) { return new Promise(ok => setTimeout(() => ok(args[0] === 'DEL' ? 1 : args[0] === 'GET' ? null : 'OK'), 1)); }
}
module.exports = { RedisCommandsQueue };
`;
  const { events, stdout } = project({
    'node_modules/ioredis/built/Redis.js': ioredis,
    'node_modules/@redis/client/dist/lib/client/commands-queue.js': queue,
    'entry.cjs': `const { Redis, Command } = require('./node_modules/ioredis/built/Redis.js');
const { RedisCommandsQueue } = require('./node_modules/@redis/client/dist/lib/client/commands-queue.js');
const cache = new Redis();
const queue = new RedisCommandsQueue();
async function checkout() {
  const hset = cache.sendCommand(new Command('hset', ['cart:1042', 'email', 'ana@example.com'], 2));
  cache.connect();
  await hset;
  await cache.sendCommand(new Command('auth', ['palavra-passe-redis-99'], 'OK'));
  await queue.addCommand(['HELLO', '3', 'AUTH', 'default', 'palavra-passe-redis-99']);
  await queue.addCommand(['SET', 'session:9f8e7d6c5b4a32100123abcd', '{"user":"ana"}', 'EX', '60']);
  const removed = await queue.addCommand(['DEL', 'session:9f8e7d6c5b4a32100123abcd', 'cart:1042']);
  const cached = await queue.addCommand(['GET', 'user:ana@example.com:profile']);
  return removed + String(cached);
}
checkout().then(v => console.log(v));`,
  }, 'entry.cjs');
  assert.equal(stdout.trim(), '1null');
  const boundaries = events.filter(e => e.type === 'boundary');
  assert.deepEqual(boundaries.map(b => [b.library, b.operation, b.command, b.tables]), [
    ['ioredis', 'UPDATE', 'HSET', ['cart:{n}']],
    // The secret redaction (Annex B) also covers "session:" followed by a value.
    ['redis', 'UPDATE', 'SET', ['session:[REDACTED]']],
    ['redis', 'DELETE', 'DEL', ['session:[REDACTED]', 'cart:{n}']],
    ['redis', 'SELECT', 'GET', ['user:{email}:profile']]]);
  assert.equal(boundaries[0].parentId, events.find(e => e.function === 'checkout').id);
  const ends = Object.fromEntries(events.filter(e => e.type === 'boundary-end').map(e => [e.id, e]));
  assert.deepEqual(boundaries.map(b => ends[b.id].affectedRows ?? ends[b.id].rows), [1, 1, 1, 0]);
  const text = JSON.stringify(events);
  for (const value of ['palavra-passe-redis-99', 'ana@example.com', '9f8e7d6c5b4a32100123abcd', '"user"']) assert.ok(!text.includes(value), value);
});

test('Redis: padrões das chaves, chaves por comando e resultados', () => {
  assert.equal(redisKeyPattern('orders:open'), 'orders:open');
  assert.equal(redisKeyPattern('rate:2026:127'), 'rate:{n}:{n}');
  assert.equal(redisKeyPattern(Buffer.from('bull:emails:0b6c3f1e-8d2a-4c11-9f00-12ab34cd56ef')), 'bull:emails:{id}');
  assert.equal(redisKeyPattern('token:eyJhbGciOiJIUzI1NiJ9abc123'), 'token:{id}');
  assert.deepEqual(describeRedis('mset', ['a:1', 'x', 'b:2', 'y']).tables, ['a:{n}', 'b:{n}']);
  assert.deepEqual(describeRedis('EVAL', ['return 1', '2', 'lock:7', 'queue', 'arg']).tables, ['lock:{n}', 'queue']);
  assert.deepEqual(describeRedis('BLPOP', ['jobs', 'retry', '5']).tables, ['jobs', 'retry']);
  assert.deepEqual([describeRedis('PING', []).operation, describeRedis('PING', []).tables], ['PING', []]);
  assert.equal(describeRedis('client', ['setinfo', 'lib-name', 'x']), describeRedis('AUTH', ['x']));
  assert.deepEqual(redisResult(describeRedis('SET', ['k', 'v', 'NX']), null), { affectedRows: 0 });
  assert.deepEqual(redisResult(describeRedis('SETNX', ['k', 'v']), 0), { affectedRows: 0 });
  assert.deepEqual(redisResult(describeRedis('HSET', ['k', 'f', 'v']), 0), { affectedRows: 1 });
  assert.deepEqual(redisResult(describeRedis('DEL', ['a', 'b']), 2), { affectedRows: 2 });
  assert.deepEqual(redisResult(describeRedis('LPOP', ['q']), null), { affectedRows: 0 });
  assert.deepEqual(redisResult(describeRedis('EXISTS', ['a']), 0), { rows: 0 });
  assert.deepEqual(redisResult(describeRedis('HGETALL', ['h']), { a: '1' }), { rows: 1 });
});
