import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openStore, actionLabel } from '../src/store.mjs';
import { tagPosition } from '../src/page.mjs';

// Runs a server script inside a temporary project; the script makes its own
// requests and prints JSON results. Returns the output and the recorded events.
function project(source, env = {}) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.mjs'), source);
  const result = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), join(dir, 'entry.mjs')], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label, ...env }, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const events = readdirSync(resolve('.codetac', label)).flatMap(file =>
    readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return { output: JSON.parse(result.stdout.trim().split('\n').at(-1)), events, label };
}

// node:http is used for the requests: fetch sets its own sec-fetch-* headers.
const server = body => `import http from 'node:http';
import zlib from 'node:zlib';
function get(url, headers = {}, method = 'GET', body) {
  return new Promise((ok, fail) => {
    const request = http.request(url, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => ok({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', fail);
    request.end(body);
  });
}
${body}
const server = http.createServer(handler).listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const results = {};
  try { await run(base, results); } finally { server.close(); }
  console.log(JSON.stringify(results));
});`;

test('página HTML recebe o script, com ou sem Content-Length, em partes e por writeHead', () => {
  const { output } = project(server(`
function handler(req, res) {
  const html = '<!doctype html><html><head><title>t</title></head><body><button>ok</button></body></html>';
  if (req.url === '/length') { res.setHeader('content-type', 'text/html'); res.setHeader('content-length', Buffer.byteLength(html)); res.setHeader('etag', '"x"'); res.end(html); }
  else if (req.url === '/chunks') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '9999' }); res.write('<!doctype html><html><he'); res.write('ad lang="pt">'); setTimeout(() => res.end('<body>x</body></html>'), 20); }
  else if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end('{"a":"<head>"}'); }
  else if (req.url === '/gzip') { res.setHeader('content-type', 'text/html'); res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync('<head>')); }
  else if (req.url === '/fragment') { res.setHeader('content-type', 'text/html'); res.end('<li>item</li>'); }
  else { res.statusCode = 404; res.end('nada'); }
}
async function run(base, results) {
  const doc = { 'sec-fetch-dest': 'document', 'accept-encoding': 'gzip' };
  for (const path of ['/length', '/chunks', '/json', '/gzip', '/fragment']) {
    const response = await get(base + path, doc);
    const body = response.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(response.body) : response.body;
    results[path] = { body: body.toString(), length: response.headers['content-length'] ?? null, etag: response.headers.etag ?? null };
  }
  results.api = (await get(base + '/length', { 'sec-fetch-dest': 'empty' })).body.toString();
  const script = await get(base + '/__codetac/bar.js');
  results.script = { status: script.status, type: script.headers['content-type'], start: script.body.toString().slice(0, 40) };
}`));
  const tag = '<script src="/__codetac/bar.js" data-codetac=""></script>';
  assert.equal(output['/length'].body, `<!doctype html><html><head>${tag}<title>t</title></head><body><button>ok</button></body></html>`);
  assert.equal(output['/length'].length, null);
  assert.equal(output['/length'].etag, null);
  assert.equal(output['/chunks'].body, `<!doctype html><html><head lang="pt">${tag}<body>x</body></html>`);
  assert.equal(output['/json'].body, '{"a":"<head>"}');
  assert.equal(output['/gzip'].body, '<head>');
  assert.equal(output['/fragment'].body, '<li>item</li>');
  assert.ok(!output.api.includes('__codetac'), 'pedidos que não são documentos ficam intactos');
  assert.equal(output.script.status, 200);
  assert.match(output.script.type, /javascript/);
  assert.match(output.script.start, /^window\.__CODETAC_CONFIG__=/);
});

test('CODETAC_PAGE=0 desliga a injeção', () => {
  const { output } = project(server(`
function handler(req, res) { res.setHeader('content-type', 'text/html'); res.end('<html><head></head></html>'); }
async function run(base, results) { results.body = (await get(base + '/', { 'sec-fetch-dest': 'document' })).body.toString(); }`), { CODETAC_PAGE: '0' });
  assert.equal(output.body, '<html><head></head></html>');
});

test('ação do browser: eventos recebidos pela rota própria, pedidos ligados pelo cabeçalho e pelo cookie de navegação', () => {
  const { events, label, output } = project(server(`
function handler(req, res) { res.end('ok'); }
async function run(base, results) {
  await get(base + '/api/save', { 'x-codetac-action': 'abc123xyz.1' }, 'POST');
  await get(base + '/dashboard', { 'sec-fetch-mode': 'navigate', cookie: 'a=1; codetac_action=abc123xyz' });
  await get(base + '/other', { cookie: 'codetac_action=abc123xyz' });
  const event = { actionId: 'abc123xyz', segment: 1, origin: base, page: '/form?email=ana@example.com', startedAt: Date.now(), durationMs: 800, closedBy: 'idle',
    trigger: { event: 'click', element: { tag: 'button', text: 'Guardar', id: 'save' }, handler: { name: 'handleSave', prop: 'onClick', source: 'react' },
      component: { name: 'InvoiceForm', frames: [{ url: base + '/app.js', line: 3, column: 9 }] } },
    requests: [{ n: 1, kind: 'fetch', method: 'POST', url: base + '/api/save?token=segredo123456', sameOrigin: true, startMs: 5, durationMs: 40, status: 200,
      frames: [{ fn: 'save', url: base + '/app.js', line: 10, column: 3 }] }],
    screen: { added: 2, removed: 1, stateChanged: [{ name: 'InvoiceForm', count: 1 }] }, extra: 'ignorado' };
  results.status = (await get(base + '/__codetac/events', {}, 'POST', JSON.stringify(event))).status;
  results.big = (await get(base + '/__codetac/events', {}, 'POST', 'x'.repeat(70000))).status;
  results.foreign = (await get(base + '/__codetac/events', { origin: 'https://outro.example' }, 'POST', JSON.stringify({ ...event, actionId: 'intruso123' }))).status;
}`));
  assert.equal(output.status, 204);
  assert.equal(output.big, 413);
  assert.equal(output.foreign, 403);
  assert.ok(!events.some(event => event.actionId === 'intruso123'), 'outra origem não grava ações');
  const requests = events.filter(event => event.type === 'request');
  assert.ok(!requests.some(event => event.path.startsWith('/__codetac/')), 'as rotas próprias não chegam à aplicação');
  assert.deepEqual(requests.map(event => [event.path, event.action ?? null, event.actionRequest ?? null]),
    [['/api/save', 'abc123xyz', 1], ['/dashboard', 'abc123xyz', null], ['/other', null, null]]);
  const action = events.find(event => event.type === 'browser-action');
  assert.equal(action.trigger.handler.name, 'handleSave');
  assert.equal(action.requests[0].path, '/api/save');
  assert.deepEqual(action.requests[0].queryKeys, ['token']);
  assert.equal(action.page.path, '/form');
  assert.ok(!JSON.stringify(events).includes('segredo123456') && !JSON.stringify(events).includes('ana@example.com'));
  assert.equal(action.extra, undefined);

  // A separate store: the shared one skips test recordings.
  const directory = resolve('.codetac', `${label}-store`);
  mkdirSync(join(directory, 'gravacao'), { recursive: true });
  for (const file of readdirSync(resolve('.codetac', label))) cpSync(resolve('.codetac', label, file), join(directory, 'gravacao', file));
  const store = openStore(directory);
  store.ingest();
  const listed = store.listActions({ run: 'gravacao' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'button “Guardar”');
  assert.equal(listed[0].serverRequests, 2);
  const dossier = store.actionDossier('abc123xyz');
  assert.deepEqual(dossier.timeline.map(item => item.type), ['trigger', 'request', 'screen', 'unmatched']);
  assert.equal(dossier.timeline[1].server[0].request.path, '/api/save');
  assert.equal(dossier.timeline[3].server[0].request.path, '/dashboard');
  assert.equal(store.listRequests({ run: 'gravacao', withoutAction: true }).length, 1);
  store.close();
});

test('nome da ação a partir do elemento', () => {
  assert.equal(actionLabel({ event: 'click', element: { tag: 'a', text: 'Home' } }), 'link “Home”');
  assert.equal(actionLabel({ event: 'click', element: { tag: 'input', type: 'submit', text: 'Sign in' } }), 'button “Sign in”');
  assert.equal(actionLabel({ event: 'submit', element: { tag: 'form', name: 'login' } }), 'form “login”');
  assert.equal(actionLabel({ event: 'click', element: { tag: 'div', role: 'button', label: 'Close' } }), 'button “Close”');
  assert.equal(actionLabel({ event: 'change', element: { tag: 'input', type: 'file', label: 'Photo' } }), 'field “Photo” (file chosen)');
  assert.equal(actionLabel(null), 'continuation after navigation');
});

test('vetores de página partilhados com o captor Python (lado Node)', () => {
  const { vetores } = JSON.parse(readFileSync(resolve('test/vetores-pagina.json'), 'utf8'));
  for (const { html, posicao } of vetores) assert.equal(tagPosition(Buffer.from(html).toString('latin1'), true), posicao, html);
  assert.equal(tagPosition('<!doctype html><html><he', false), null);
});
