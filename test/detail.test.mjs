import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { preview } from '../src/runtime.mjs';
import { transform } from '../src/transform.mjs';

function project(source) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.mjs'), source);
  const result = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), join(dir, 'entry.mjs')], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label }, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const events = readdirSync(resolve('.codetac', label)).filter(file => file.endsWith('.jsonl')).flatMap(file =>
    readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return { events, label, dir };
}

test('detalhe a pedido, sem reiniciar: valores, linhas executadas e erro só da função pedida', () => {
  const { events } = project(`import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const self = fileURLToPath(import.meta.url);
function price({ quantity, unit = 2 }, discount, ...rest) {
  let total = quantity * unit;
  if (discount) {
    total -= discount;
  } else {
    total += 1;
  }
  return { total, token: 'segredo-abc', email: 'ana@example.com' };
}
function other(value) { return value + 1; }
function hashPassword(password, salt) { return 'hash-' + password + salt; }
async function slow(ms) { await new Promise(ok => setTimeout(ok, ms)); return 'feito'; }
function broken() { throw new Error('não há stock'); }
const short = n => n * 2;
async function handler(req, res) {
  const result = price({ quantity: 3 }, 1, 'x');
  other(1);
  await slow(5);
  short(4);
  hashPassword('palavra-muito-secreta', 'sal');
  try { broken(); } catch {}
  res.end(JSON.stringify(result));
}
const server = http.createServer(handler).listen(0, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  await (await fetch(url)).text();
  // Detail requested while the application runs.
  writeFileSync(join(process.cwd(), '.codetac', process.env.CODETAC_RUN, 'detalhe.json'), JSON.stringify({
    functions: [{ file: self, line: 6, function: 'price' }, { file: self, line: 16, function: 'hashPassword' }, { file: self, line: 17, function: 'slow' }, { file: self, line: 18 }, { file: self, line: 19, function: 'short' }] }));
  await new Promise(ok => setTimeout(ok, 1200));
  await (await fetch(url)).text();
  server.close();
});
`);
  const requests = events.filter(event => event.type === 'request').map(event => event.requestId);
  assert.equal(requests.length, 2);
  const details = events.filter(event => event.type === 'detail');
  assert.ok(details.every(event => event.requestId === requests[1]), 'só depois do pedido de detalhe');
  const names = new Map(events.filter(event => event.type === 'enter').map(event => [event.id, event.function]));
  const by = name => details.find(event => names.get(event.id) === name);
  assert.deepEqual(details.map(event => names.get(event.id)).sort(), ['broken', 'hashPassword', 'price', 'short', 'slow']);
  assert.equal(by('other'), undefined, 'as outras funções não gravam valores');

  const price = by('price');
  assert.deepEqual(price.args, [{ name: 'quantity', value: 3 }, { name: 'unit', value: 2 }, { name: 'discount', value: 1 }, { name: 'rest', value: ['x'] }]);
  assert.deepEqual(price.returned, { total: 5, token: '[REDACTED]', email: 'a***@e***' });
  // Lines 7, 8, 9 and 13 ran; the else branch (11) did not.
  assert.deepEqual(price.lines, [7, 8, 9, 13]);
  assert.equal(by('slow').returned, 'feito');
  assert.deepEqual(by('broken').threw, { $tipo: 'erro', nome: 'Error', mensagem: 'não há stock' });
  assert.deepEqual(by('short').args, [{ name: 'n', value: 4 }]);
  assert.equal(by('short').returned, 8);
  assert.deepEqual(by('short').lines, [19]);
  assert.deepEqual(by('hashPassword').args, [{ name: 'password', value: '[REDACTED]' }, { name: 'salt', value: 'sal' }]);
  assert.equal(by('hashPassword').returned, '[REDACTED]');
  assert.ok(!JSON.stringify(events).includes('palavra-muito-secreta'));
  assert.ok(!JSON.stringify(events).includes('segredo-abc'));
});

test('cópia legível dos valores: limites, circulares, classes, sem chamar getters', () => {
  class Aluno { constructor() { this.nome = 'Ana'; } get calculado() { throw new Error('não devia ser chamado'); } }
  const circular = { a: 1 };
  circular.self = circular;
  let called = false;
  const withGetter = { get x() { called = true; return 1; } };
  const value = preview({ aluno: new Aluno(), circular, lista: Array.from({ length: 25 }, (_, i) => i), fn: function save() {},
    data: new Date(0), bytes: Buffer.from('abc'), mapa: new Map([['k', 1]]), fundo: { a: { b: { c: { d: { e: 1 } } } } }, withGetter, nada: undefined });
  assert.deepEqual(value.aluno, { $classe: 'Aluno', nome: 'Ana' });
  assert.deepEqual(value.circular, { a: 1, self: { $tipo: 'circular' } });
  assert.equal(value.lista.length, 21);
  assert.deepEqual(value.lista.at(-1), { $mais: 5 });
  assert.deepEqual(value.fn, { $tipo: 'função', nome: 'save' });
  assert.deepEqual(value.data, { $tipo: 'data', valor: '1970-01-01T00:00:00.000Z' });
  assert.deepEqual(value.bytes, { $tipo: 'Buffer', bytes: 3 });
  assert.deepEqual(value.mapa, { $tipo: 'Map', tamanho: 1, entradas: [['k', 1]] });
  assert.deepEqual(value.fundo.a.b.c, { $tipo: 'objeto', $resumido: true });
  assert.deepEqual(value.withGetter, { x: { $tipo: 'getter' } });
  assert.equal(called, false);
  assert.deepEqual(value.nada, { $tipo: 'undefined' });
});

test('objetos HTTP resumidos: sem valores de cabeçalhos, cookies nem internos', async () => {
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const { Socket } = await import('node:net');
  const request = new IncomingMessage(new Socket());
  Object.assign(request, { method: 'POST', url: '/api/items?token=abc&page=2', headers: { cookie: '__Host-auth=segredo', 'content-type': 'application/json' } });
  const response = new ServerResponse(request);
  response.statusCode = 201;
  const fetched = new Request('http://localhost/x?q=1', { method: 'PUT', headers: { authorization: 'Bearer y' } });
  const value = preview({ request, response, fetched, headers: new Headers({ cookie: 'a=b' }), socket: new Socket(), own: new (class Thing { constructor() { this._private = 1; this.visible = 2; } })() });
  assert.deepEqual(value.request, { $classe: 'IncomingMessage', metodo: 'POST', caminho: '/api/items?token=…&page=…', cabecalhos: ['cookie', 'content-type'] });
  assert.deepEqual(value.response, { $classe: 'ServerResponse', estado: 201, cabecalhos: [] });
  assert.deepEqual(value.fetched, { $classe: 'Request', metodo: 'PUT', caminho: '/x?q=…', cabecalhos: ['authorization'] });
  assert.deepEqual(value.headers, { $classe: 'Headers', nomes: ['cookie'] });
  assert.deepEqual(value.socket, { $classe: 'Socket', $resumido: true });
  assert.deepEqual(value.own, { $classe: 'Thing', visible: 2 });
  assert.ok(!JSON.stringify(value).includes('segredo') && !JSON.stringify(value).includes('Bearer'));
});

test('transformação: parâmetros ligados e marcas de linha, só nas instruções da própria função', () => {
  const source = `function f({ a, b: [c] }, d = a + 1, ...e) {
  const x = 1;
  function inner() { return 2; }
  switch (x) { case 1: go(); break; }
  if (x) go();
  return x;
}`;
  const { source: out } = transform(source, '/p/f.js', 'module', '/p', () => 0);
  assert.match(out, /\.a\(\[a,c,d,e\]\)/);
  for (const line of [2, 4, 6]) assert.ok(out.includes(`__codetac$c.l(${line})`), `linha ${line}`);
  // A statement over several lines marks all of them.
  const multi = transform('function g() {\n  const r = db\n    .run(1);\n  return r;\n}', '/p/g.js', 'module', '/p', () => 0).source;
  assert.ok(multi.includes('__codetac$c.l(2,3)') && multi.includes('__codetac$c.l(4)'));
  assert.ok(out.includes('__codetac$c.l(4);go()') || out.includes('case 1:__codetac$c&&__codetac$c.l(4);go()'), 'instrução dentro de case');
  // inner() has its own capture; the outer function does not mark its line 3 statement.
  assert.equal((out.match(/__codetac\$c\.l\(3\)/g) ?? []).length, 1);
  new Function(out.replace(/^function f/, 'return function f'));
});
