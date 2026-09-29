import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestRequest, digestAction, isDevToolRequest } from '../src/digest.mjs';
import { boundarySentence } from '../src/sentences.mjs';
import { validateSentence, tablesInCode, createPurposes, loadConfig, answerQuestion } from '../src/ai.mjs';
import { cookieNames } from '../src/runtime.mjs';
import { openStore, commonFolder } from '../src/store.mjs';
import { crossOrigin } from '../src/runtime.mjs';

// A request dossier as the store builds it: flat steps with parentId.
let counter = 0;
function fn(name, parentId, extra = {}) {
  return { id: `p:${++counter}`, parentId, type: 'function', function: name, file: `/app/src/${name}.ts`, line: 1, endLine: 4,
    durationMs: 0.2, error: false, finished: true, ...extra };
}
function db(parentId, operation, table, result = {}, extra = {}) {
  return { id: `p:b${++counter}`, parentId, type: 'boundary', kind: 'base-de-dados', library: 'mysql2', operation, tables: [table],
    sql: `${operation} ${table}`, result, durationMs: 1, error: false, finished: true, ...extra };
}
const dossier = (steps, extra = {}) => ({ root: '/app', request: { run: 'r', method: 'POST', path: '/api/login', status: 200, durationMs: 5, cookies: [] }, steps, ...extra });

test('preparação da base (M14): comandos de estrutura seguidos ficam numa linha que se pode abrir', () => {
  const route = fn('POST', null);
  const setup = fn('ensureSchema', route.id);
  const steps = [route, setup,
    db(setup.id, 'CREATE', 'schools', { affectedRows: 0 }, { sql: 'CREATE TABLE IF NOT EXISTS schools (id int)' }),
    db(setup.id, 'ALTER', 'schools', {}, { error: true }),
    db(setup.id, 'ALTER', 'schools', {}, { error: true }),
    db(setup.id, 'INSERT', 'settings', { affectedRows: 0 }),
    db(setup.id, 'CREATE', 'sessions', { affectedRows: 0 }),
    db(route.id, 'SELECT', 'schools', { rows: 1 }),
    db(route.id, 'INSERT', 'sessions', { affectedRows: 1 })];
  const view = digestRequest(dossier(steps));
  const group = view.nodes[0].children[0].children[0];
  assert.equal(group.type, 'group');
  assert.equal(group.group, 'preparacao-bd');
  assert.equal(group.count, 5);
  assert.equal(group.children.length, 5, 'os passos originais ficam no grupo');
  assert.match(group.sentence, /^Database setup: 5 commands \(2 CREATE, 2 ALTER, 1 INSERT\) on 3 tables · 2 failed without stopping the function$/);
  assert.equal(group.children[0].purpose.text, 'Creates table schools if it does not exist');
  // The route's sentence: an INSERT that changed no rows is not a change.
  assert.equal(view.nodes[0].purpose.text,
    'Runs 4 database structure commands · reads schools · adds to sessions · tries to write to settings without changing rows · calls ensureSchema');
  assert.equal(view.lines.total, 9);
  assert.equal(view.lines.visible, 5);
  const effects = view.effects.items.map(item => item.text);
  assert.deepEqual(effects, ['INSERT on settings changed no rows', '1 row added to sessions',
    '4 database structure commands (2 without error, 2 failed); the recording does not show whether they changed the database']);
  assert.equal(view.effects.lasting, 2);
});

test('repetições e funções auxiliares seguidas são agrupadas; uma função isolada fica', () => {
  const route = fn('GET', null);
  const steps = [route,
    ...[1, 2, 3].map(() => fn('toJSON', route.id, { file: '/app/src/model.ts', line: 10 })),
    fn('slugToId', route.id, { durationMs: 2 }),
    fn('a', route.id), fn('b', route.id),
    db(route.id, 'SELECT', 'monitor', { rows: 30 }),
    fn('lonely', route.id)];
  const view = digestRequest(dossier(steps));
  const kids = view.nodes[0].children;
  assert.deepEqual(kids.map(item => item.type === 'group' ? item.group : item.function ?? item.kind),
    ['repeticao', 'auxiliares', 'base-de-dados', 'lonely']);
  assert.equal(kids[0].count, 3);
  assert.match(kids[0].sentence, /— 3 times in a row$/);
  assert.equal(kids[1].sentence, '3 helper functions with no boundaries: slugToId, a and b');
  assert.equal(kids[3].purpose.text, 'Internal work: no boundary observed');
});

test('blocos repetidos (um ciclo sobre registos) ficam numa linha, com os passos por ordem', () => {
  const route = fn('GET', null);
  const steps = [route, db(route.id, 'SELECT', 'monitor', { rows: 3 })];
  for (let i = 0; i < 3; i++) {
    steps.push(db(route.id, 'SELECT', 'heartbeat', { rows: 10 }));
    const calc = fn('getCalculator', route.id, { file: '/app/src/calc.ts', line: 5, durationMs: 8 });
    steps.push(calc, db(calc.id, 'SELECT', 'stat', { rows: 0 }));
  }
  steps.push(fn('respond', route.id, { durationMs: 9 }));
  const view = digestRequest(dossier(steps));
  const kids = view.nodes[0].children;
  assert.deepEqual(kids.map(item => item.type === 'group' ? item.group : item.function ?? item.operation), ['SELECT', 'bloco', 'respond']);
  assert.equal(kids[1].count, 6);
  assert.equal(kids[1].sentence, 'The same 2 steps repeated 3 times: reads heartbeat and stat · calls getCalculator');
  assert.deepEqual(kids[1].children.map(item => item.function ?? item.tables[0]), ['heartbeat', 'getCalculator', 'heartbeat', 'getCalculator', 'heartbeat', 'getCalculator']);
});

test('código gerado pelo bundler (pastas escondidas) fica agrupado, também quando o projeto está numa pasta escondida', () => {
  const route = fn('route', null, { file: '/home/.proj/app/.next/server/route.js' });
  const steps = [route, fn('a', route.id, { file: '/home/.proj/app/.next/server/route.js' }), fn('b', route.id, { file: '/home/.proj/app/.next/server/route.js' }),
    fn('handler', route.id, { file: '/home/.proj/app/src/handler.ts' }), fn('c', route.id, { file: '/home/.proj/app/src/handler.ts', line: 20, endLine: 30, durationMs: 9 })];
  const view = digestRequest({ ...dossier(steps), root: '/home/.proj/app' });
  const kids = view.nodes[0].children;
  assert.equal(kids[0].group, 'gerado');
  assert.equal(kids[0].count, 2);
  assert.equal(kids[1].function, 'handler');
  // The route's callees exclude generated code but include the project's.
  assert.match(view.nodes[0].purpose.text, /calls handler and c$/);
});

test('frases das fronteiras e resumo dos efeitos', () => {
  assert.equal(boundarySentence({ kind: 'base-de-dados', operation: 'UPDATE', tables: ['students'], result: { affectedRows: 0 } }),
    'Tries to change students; no rows changed');
  assert.equal(boundarySentence({ kind: 'email', to: ['j***@m***.com'], subject: 'Login', result: {} }), 'Sends an email to j***@m***.com “Login”');
  assert.equal(boundarySentence({ kind: 'http', method: 'GET', host: 'api.x.com', path: '/v1', result: { status: 500 }, error: true }),
    'Calls api.x.com: GET /v1 (status 500) — failed');
  assert.equal(boundarySentence({ kind: 'ficheiros', provider: 'S3', operation: 'escrita', bucket: 'fotos', bytes: 10, result: {} }),
    'File write: S3 fotos (10 bytes)');
  const mail = { id: 'm', type: 'boundary', kind: 'email', to: ['a***@b***.pt'], subject: 'Olá', result: {} };
  const view = digestRequest(dossier([mail], { request: { run: 'r', method: 'POST', path: '/x', status: 200, cookies: [{ name: 'sid', cleared: false }, { name: 'old', cleared: true }] } }));
  assert.deepEqual(view.effects.items.map(item => item.text), ['Email sent to a***@b***.pt “Olá”', 'Cookies stored in the browser: sid', 'Cookies deleted in the browser: old']);
  const none = digestRequest(dossier([db(null, 'SELECT', 'user', { rows: 1 })]));
  assert.equal(none.effects.lasting, 0);
  assert.equal(none.effects.none, 'No lasting effect observed.');
});

test('Redis: frases de chaves, não de linhas, e efeitos agrupados por chave', () => {
  const redis = (id, operation, command, key, result) => ({ id, type: 'boundary', kind: 'base-de-dados', library: 'ioredis', operation, command, tables: [key], result });
  assert.equal(boundarySentence(redis('a', 'SELECT', 'GET', 'orders:open', { rows: 0 })), 'Reads Redis key orders:open (not found)');
  assert.equal(boundarySentence(redis('b', 'UPDATE', 'SET', 'lock:{n}', { affectedRows: 0 })), 'SET on Redis key lock:{n}; nothing stored');
  assert.equal(boundarySentence(redis('c', 'DELETE', 'LPOP', 'jobs', { affectedRows: 1 })), 'Removes items from Redis key jobs (LPOP)');
  const view = digestRequest(dossier([
    redis('d', 'UPDATE', 'HSET', 'cart:{n}', { affectedRows: 1 }), redis('e', 'UPDATE', 'EXPIRE', 'cart:{n}', { affectedRows: 1 }),
    redis('f', 'DELETE', 'DEL', 'orders:open', { affectedRows: 1 }), redis('g', 'UPDATE', 'SETNX', 'lock:{n}', { affectedRows: 0 })]));
  assert.deepEqual(view.effects.items.map(item => item.text),
    ['Redis key cart:{n} written (2 commands)', 'Redis key orders:open deleted', 'SETNX on Redis key lock:{n} changed nothing']);
  assert.equal(view.effects.lasting, 2);
});

test('ação: pedidos da ferramenta de desenvolvimento agrupados (M8) e resumo de uma linha', () => {
  assert.ok(isDevToolRequest('/_next/static/webpack/abc.webpack.hot-update.json'));
  assert.ok(isDevToolRequest('/@vite/client'));
  assert.ok(!isDevToolRequest('/api/items'));
  const server = dossier([db(null, 'INSERT', 'item', { affectedRows: 1 })], { request: { run: 'r', method: 'POST', path: '/api/items', status: 201, cookies: [] } });
  const action = digestAction({ label: 'button “Add”', timeline: [
    { type: 'trigger', trigger: { event: 'click' } },
    { type: 'request', browser: { method: 'GET', path: '/_next/static/webpack/a.hot-update.json', sameOrigin: true }, server: [] },
    { type: 'request', browser: { method: 'GET', path: '/_next/static/webpack/b.hot-update.json', sameOrigin: true }, server: [] },
    { type: 'request', browser: { method: 'POST', path: '/api/items', status: 201, sameOrigin: true }, server: [server] },
    { type: 'screen', screen: { added: 2 } },
  ] });
  assert.deepEqual(action.timeline.map(item => item.type), ['trigger', 'dev-group', 'request', 'screen']);
  assert.equal(action.timeline[1].sentence, '2 development tool requests (recompilation, hot reload)');
  assert.equal(action.summary, 'Click on button “Add” → POST /api/items (status 201) → changes the screen');
  assert.deepEqual(action.effects.items.map(item => item.text), ['1 row added to item']);
});

test('ação: pedidos de uma navegação completa (formulário que carrega a página seguinte) entram no resumo', () => {
  const post = dossier([db(null, 'INSERT', 'items', { affectedRows: 1 })], { request: { run: 'r', method: 'POST', path: '/items', status: 302, cookies: [] } });
  const get = dossier([db(null, 'SELECT', 'items', { rows: 1 })], { request: { run: 'r', method: 'GET', path: '/items', status: 200, cookies: [] } });
  const action = digestAction({ label: 'button “Add”', timeline: [
    { type: 'trigger', trigger: { event: 'click' } },
    { type: 'navigation', kind: 'page exit', path: '/items' },
    { type: 'screen', screen: {} },
    { type: 'document', page: { path: '/items' }, server: [post, get] },
    { type: 'screen', screen: { added: 3 } },
  ] });
  assert.equal(action.summary, 'Click on button “Add” → POST /items (status 302), GET /items (status 200) → goes to /items → changes the screen');
  assert.deepEqual(action.effects.items.map(item => item.text), ['1 row added to items']);
});

test('passo opaco: frase própria, nunca agrupado como auxiliar trivial; marca depois da resposta mantida', () => {
  const route = fn('create_note', null);
  const opaque = fn('request validation (not observable)', null, { file: null, line: null, endLine: null, opaque: true, durationMs: 0.1 });
  const other = fn('request validation (not observable)', null, { file: null, line: null, endLine: null, opaque: true, durationMs: 0.1 });
  const record = fn('record', null, { afterResponse: true });
  const steps = [opaque, other, route, record, db(record.id, 'INSERT', 'audit', { affectedRows: 1 }, { afterResponse: true })];
  const view = digestRequest(dossier(steps));
  const [first] = view.nodes;
  assert.equal(first.type, 'group', 'dois iguais seguidos: repetição, não auxiliares');
  assert.equal(first.group, 'repeticao');
  assert.equal(first.children[0].purpose.text, 'Not observable: runs in compiled or generated code that CodeTAC cannot see into');
  const single = digestRequest(dossier([opaque, route])).nodes;
  assert.deepEqual(single.map(node => node.type), ['function', 'function']);
  assert.ok(view.nodes.find(node => node.function === 'record').afterResponse);
  assert.deepEqual(view.effects.items.map(item => item.text), ['1 row added to audit']);
});

test('templates: frase fixa diz que monta HTML; template opaco diz que não é observável', () => {
  const view = fn('list_view', null, { file: '/app/app.py' });
  const page = fn('template items.html', view.id, { file: '/app/templates/items.html', line: 1, endLine: 1, mapped: true });
  const base = fn('template base.html', page.id, { file: '/app/templates/base.html', line: 1, endLine: 5, mapped: true });
  const block = fn('block content (items.html)', base.id, { file: '/app/templates/items.html', line: 2, endLine: 5, mapped: true });
  const unmapped = fn('template erro.html', view.id, { file: '/app/templates/erro.html', line: null, endLine: null, opaque: true });
  const nodes = digestRequest(dossier([view, page, base, block, unmapped])).nodes;
  const texts = [];
  (function walk(list) { for (const node of list) { texts.push(`${node.function}: ${node.purpose.text}`); walk(node.children ?? []); } })(nodes);
  assert.deepEqual(texts.slice(1), [
    'template items.html: Renders HTML from items.html · calls template base.html',
    'template base.html: Renders HTML from base.html · calls block content (items.html)',
    'block content (items.html): Renders HTML from items.html',
    'template erro.html: Not observable: runs in compiled or generated code that CodeTAC cannot see into',
  ]);
});

test('validação das frases da IA: nada que não esteja nos factos', () => {
  const read = [{ kind: 'base-de-dados', operation: 'SELECT', tables: ['user'] }];
  const facts = { boundaries: read, allowedWords: new Set(['finduser', 'user']), knownTables: new Set(['user', 'item', 'audit_log']), knownHosts: new Set(['api.github.com']) };
  assert.equal(validateSentence('Looks up the user in the database.', facts), null);
  assert.equal(validateSentence('Returns the requested item.', facts), null, 'palavra comum igual a uma tabela');
  assert.match(validateSentence('Reads the table item.', facts), /table item/);
  assert.match(validateSentence('Logs the entry in audit_log.', facts), /audit_log/);
  assert.match(validateSentence('Saves the user.', facts), /no write observed/);
  assert.equal(validateSentence('Stores the token in a cookie.', facts), null);
  assert.match(validateSentence('Sends a welcome email.', facts), /email/);
  assert.equal(validateSentence('Finds the user by the email given.', facts), null, 'email como dado, não como envio');
  assert.equal(validateSentence('Changes the screen without talking to the server or the database.', { ...facts, boundaries: [] }), null, 'negação');
  assert.match(validateSentence('Reads the database.', { ...facts, boundaries: [] }), /database/);
  assert.match(validateSentence('Charges the payment.', facts), /Charges|payment/);
  assert.match(validateSentence('Checks with api.github.com.', facts), /api\.github\.com/);
  assert.match(validateSentence('Validates the token; otherwise rejects the request.', facts), /branch/);
  assert.match(validateSentence('Calls sendWelcomeMail.', facts), /sendWelcomeMail/);
  assert.match(validateSentence('', facts), /empty/);
  assert.deepEqual(tablesInCode("db.query('INSERT INTO audit_log (a) VALUES (?)'); knex.from(`users`)"), ['audit_log']);
});

test('cookies da resposta: só nomes, apagados reconhecidos, também por writeHead', () => {
  assert.deepEqual(cookieNames(['sid=abc; Path=/; HttpOnly', 'old=; Max-Age=0', 'x=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
    [{ name: 'sid', cleared: false }, { name: 'old', cleared: true }, { name: 'x', cleared: true }]);
  assert.deepEqual(cookieNames(undefined, [['Set-Cookie', 'a=1'], ['content-type', 'text/html']]), [{ name: 'a', cleared: false }]);
  assert.deepEqual(cookieNames(undefined, ['set-cookie', ['b=2', 'c=3']]), [{ name: 'b', cleared: false }, { name: 'c', cleared: false }]);
  assert.equal(cookieNames(undefined, null), undefined);
});

test('cookies gravados num servidor real, sem os valores', async () => {
  const { createRuntime } = await import('../src/runtime.mjs');
  const directory = resolve('.codetac', `test-${randomUUID()}`);
  const runtime = createRuntime(directory);
  // /a: setHeader; /b: raw headers given only to writeHead (not visible through getHeader).
  const server = http.createServer((req, res) => runtime.request(req, res, () => {
    if (req.url === '/a') res.setHeader('set-cookie', 'sessao=valor-secreto-123; HttpOnly');
    res.writeHead(200, req.url === '/b' ? ['Set-Cookie', 'tema=escuro', 'Content-Type', 'text/plain'] : { 'content-type': 'text/plain' });
    res.end('ok');
  }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  for (const path of ['/a', '/b']) await fetch(`http://127.0.0.1:${server.address().port}${path}`).then(response => response.text());
  await new Promise(ok => setTimeout(ok, 50));
  server.close();
  runtime.flush();
  const { readdirSync, readFileSync } = await import('node:fs');
  const text = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('');
  const ends = text.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'request-end');
  assert.deepEqual(ends.map(end => end.cookies.map(item => item.name)), [['sessao'], ['tema']]);
  assert.ok(!text.includes('valor-secreto-123') && !text.includes('escuro'));
});

test('store: abrir a base por outro caminho não duplica os eventos', () => {
  const directory = resolve('.codetac', `test-${randomUUID()}-store`);
  mkdirSync(join(directory, 'gravacao'), { recursive: true });
  const lines = [
    { type: 'request', requestId: '1:0:r1', process: '1:0', sequence: 1, method: 'GET', path: '/', at: 1 },
    { type: 'enter', requestId: '1:0:r1', process: '1:0', sequence: 2, id: '1:0:1', function: 'f', file: '/x.js', line: 1 },
    { type: 'exit', requestId: '1:0:r1', process: '1:0', sequence: 3, id: '1:0:1', durationNs: 10 },
    { type: 'request-end', requestId: '1:0:r1', process: '1:0', sequence: 4, status: 200, durationNs: 20 },
  ];
  writeFileSync(join(directory, 'gravacao', 'a.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const first = openStore(directory);
  first.ingest();
  first.close();
  const second = openStore(relative(process.cwd(), directory));
  second.ingest();
  assert.equal(second.dossier('1:0:r1').steps.length, 1);
  second.close();
});

test('store: passos gravados depois do fim do pedido, no mesmo processo, são «depois da resposta»', () => {
  const directory = resolve('.codetac', `test-${randomUUID()}-store`);
  mkdirSync(join(directory, 'gravacao'), { recursive: true });
  const lines = [
    { type: 'request', requestId: '1:0:r1', process: '1:0', sequence: 1, method: 'POST', path: '/notes', at: 1 },
    { type: 'enter', requestId: '1:0:r1', process: '1:0', sequence: 2, id: '1:0:1', function: 'create', file: '/x.py', line: 1 },
    { type: 'exit', requestId: '1:0:r1', process: '1:0', sequence: 3, id: '1:0:1', durationNs: 10 },
    { type: 'request-end', requestId: '1:0:r1', process: '1:0', sequence: 4, status: 201, durationNs: 20 },
    // Not marked by the capture (a background task after a streamed response).
    { type: 'enter', requestId: '1:0:r1', process: '1:0', sequence: 5, id: '1:0:2', parentId: null, function: 'record', file: '/x.py', line: 5 },
    { type: 'boundary', requestId: '1:0:r1', process: '1:0', sequence: 6, id: '1:0:b1', parentId: '1:0:2', kind: 'base-de-dados', operation: 'INSERT', tables: ['audit'] },
    { type: 'boundary-end', requestId: '1:0:r1', process: '1:0', sequence: 7, id: '1:0:b1', durationNs: 5, affectedRows: 1 },
    { type: 'exit', requestId: '1:0:r1', process: '1:0', sequence: 8, id: '1:0:2', durationNs: 10 },
  ];
  writeFileSync(join(directory, 'gravacao', 'a.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const store = openStore(directory);
  store.ingest();
  const steps = store.dossier('1:0:r1').steps;
  store.close();
  assert.deepEqual(steps.map(step => [step.function ?? step.operation, Boolean(step.afterResponse)]), [['create', false], ['record', true], ['INSERT', true]]);
});

test('DP3: pedido do browser para outra origem ligado como provável ao pedido que a API recebeu', () => {
  assert.deepEqual(crossOrigin('http://127.0.0.1:5173', '127.0.0.1:8000'), { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8000' });
  assert.equal(crossOrigin('http://127.0.0.1:8000', '127.0.0.1:8000'), null);
  assert.equal(crossOrigin('null', '127.0.0.1:8000'), null);
  assert.equal(crossOrigin(undefined, '127.0.0.1:8000'), null);
  assert.equal(commonFolder('/p/misto/web', '/p/misto/api'), '/p/misto');
  assert.equal(commonFolder('/p/a', '/p/a'), '/p/a');

  const directory = resolve('.codetac', `test-${randomUUID()}-store`);
  mkdirSync(join(directory, 'gravacao'), { recursive: true });
  const page = 'http://127.0.0.1:5173';
  const action = { type: 'browser-action', actionId: 'acao-dp3-1', segment: 1, origin: page, page: { path: '/' }, startedAt: 10_000, durationMs: 400,
    trigger: { event: 'click', element: { tag: 'button', text: 'Adicionar' } },
    requests: [
      { n: 1, method: 'POST', path: '/api/tasks', sameOrigin: false, host: '127.0.0.1:8000', startMs: 10, durationMs: 30, status: 201 },
      { n: 2, method: 'GET', path: '/api/tasks', sameOrigin: false, host: '127.0.0.1:8000', startMs: 50, durationMs: 20, status: 200 },
      { n: 3, method: 'GET', path: '/ext', sameOrigin: false, host: 'api.exemplo.com', startMs: 80, durationMs: 20, status: 200 },
    ] };
  const cross = { origin: page, host: '127.0.0.1:8000' };
  const request = (n, method, path, at, extra = {}) => [
    { type: 'request', requestId: `2:0:r${n}`, process: '2:0', sequence: n * 10, method, path, at, ...cross, ...extra },
    { type: 'request-end', requestId: `2:0:r${n}`, process: '2:0', sequence: n * 10 + 1, status: 200, durationNs: 1 },
  ];
  const api = [
    ...request(1, 'OPTIONS', '/api/tasks', 10_011),
    ...request(2, 'POST', '/api/tasks', 10_012),
    ...request(3, 'GET', '/api/tasks', 10_052),
    ...request(4, 'GET', '/api/tasks', 20_000),                                  // much later: another moment
    ...request(5, 'GET', '/api/tasks', 10_053, { origin: 'http://outra:1' }),    // another page
    ...request(6, 'GET', '/api/tasks', 10_054, { action: 'outra-acao-1' }),      // already linked for sure
  ];
  writeFileSync(join(directory, 'gravacao', 'browser.jsonl'), JSON.stringify({ process: '1:0', sequence: 1, ...action }) + '\n');
  writeFileSync(join(directory, 'gravacao', 'api.jsonl'), api.map(line => JSON.stringify(line)).join('\n') + '\n');
  const store = openStore(directory);
  store.ingest();
  const dossier = store.actionDossier('acao-dp3-1');
  store.close();
  const items = dossier.timeline.filter(item => item.type === 'request');
  assert.deepEqual(items.map(item => [item.browser.method, item.probable ?? false, item.server.map(part => `${part.request.method} ${part.request.requestId}`)]), [
    ['POST', true, ['OPTIONS 2:0:r1', 'POST 2:0:r2']],
    ['GET', true, ['GET 2:0:r3']],
    ['GET', false, []],
  ]);
  assert.equal(digestAction(dossier).summary.split(' → ')[1],
    'POST 127.0.0.1:8000/api/tasks (status 201), GET 127.0.0.1:8000/api/tasks (status 200), GET api.exemplo.com/ext (status 200)');
  // The app's own API is not an outside call; the real outside host still is.
  assert.deepEqual(dossier.marks.filter(mark => mark.key.startsWith('browser:')).map(mark => mark.label), ['browser call to api.exemplo.com']);
});

test('IA: sem fornecedor não há chamadas; com um fornecedor falso, frases validadas, repetidas pedidas uma vez e guardadas', async () => {
  const none = await loadConfig({ env: { CODETAC_AI_PROVIDER: 'none' } });
  assert.equal(none.provider, null);
  assert.equal((await loadConfig({ env: { CODETAC_AI_PROVIDER: 'anthropic' } })).problem, 'The Anthropic key is missing (CODETAC_AI_KEY).');
  assert.equal((await loadConfig({ env: { CODETAC_AI_PROVIDER: 'ollama', CODETAC_AI_URL: 'http://127.0.0.1:9' } })).provider, null);

  // A fake OpenAI-compatible server: records what it receives.
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      const request = JSON.parse(body);
      received.push(request);
      const user = request.messages.at(-1).content;
      const answer = user.includes('Function: save')
        ? { purpose: 'Saves the user and sends a welcome email.', boundaries: [{ id: 'b1', purpose: 'Records the new user.' }] }
        : { purpose: 'Converts the user to JSON.', boundaries: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const config = await loadConfig({ env: { CODETAC_AI_PROVIDER: 'compatible', CODETAC_AI_MODEL: 'falso', CODETAC_AI_URL: `http://127.0.0.1:${server.address().port}`,
    CODETAC_AI_KEY: 'sk-proj-nao-deve-sair-12345678' } });
  assert.equal(config.local, true);
  const saved = new Map();
  const cache = { get: key => saved.get(key) ?? null, set: (key, value) => saved.set(key, value) };
  const code = { lines: ['function save(user) {', '  const password = "segredo-muito-secreto";', '  return db.insert(user);', '}'] };
  const route = fn('save', null);
  const steps = [route, db(route.id, 'INSERT', 'users', { affectedRows: 1 }), fn('toJSON', route.id, { durationMs: 9 }), fn('other', route.id, { durationMs: 9 }), fn('toJSON', route.id, { durationMs: 9 })];
  const view = dossier(steps);
  view.digest = digestRequest(view);
  const purposes = createPurposes({ config, cache, readCode: () => code });
  purposes.status('x', async () => ({ dossiers: [view] }));
  await purposes.wait('x');
  const result = purposes.status('x');
  server.close();
  assert.ok(result.finished);
  // "sends a welcome email" is not in the facts: the sentence is rejected.
  assert.equal(result.purposes[route.id].source, 'factos');
  assert.match(result.purposes[route.id].rejected, /email/);
  // The boundary sentence is valid (an INSERT was observed).
  assert.equal(result.purposes[steps[1].id].text, 'Records the new user.');
  // toJSON twice with the same code and facts: asked once, both get it.
  assert.equal(result.purposes[steps[2].id].text, 'Converts the user to JSON.');
  assert.deepEqual(result.purposes[steps[4].id], result.purposes[steps[2].id]);
  assert.equal(received.length, 3);
  // Secrets never leave: the code is redacted before it is sent.
  assert.ok(!JSON.stringify(received).includes('segredo-muito-secreto'));
  assert.equal(saved.size, 3);
});

test('perguntas: valores gravados só para um modelo local; com a nuvem, a resposta diz que não foram enviados', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      received.push(JSON.parse(body).messages.at(-1).content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Calculates the price with the tax.', known: true }) } }] }));
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const config = await loadConfig({ env: { CODETAC_AI_PROVIDER: 'compatible', CODETAC_AI_MODEL: 'falso', CODETAC_AI_URL: `http://127.0.0.1:${server.address().port}` } });
  const step = fn('price', null, { detail: { args: [{ name: 'amount', value: 'valor-gravado-4242' }], lines: [2, 3], returned: 246 } });
  const view = dossier([step]);
  view.digest = digestRequest(view);
  const readCode = () => ({ start: 1, lines: ['def price(amount):', '    total = amount * 1.23', '    return total'] });
  const local = await answerQuestion({ config, dossier: view, stepId: step.id, question: 'What does it do?', readCode });
  const cloud = await answerQuestion({ config: { ...config, local: false }, dossier: view, stepId: step.id, question: 'What does it do?', readCode });
  server.close();
  assert.deepEqual([local.valuesSent, local.valuesWithheld], [true, false]);
  assert.deepEqual([cloud.valuesSent, cloud.valuesWithheld], [false, true]);
  assert.ok(received[0].includes('valor-gravado-4242'));
  assert.ok(!received[1].includes('valor-gravado-4242'));
  assert.match(received[1], /The recorded values are not sent to models outside this computer/);
});
