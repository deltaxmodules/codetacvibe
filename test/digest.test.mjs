import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestRequest, digestAction, isDevToolRequest } from '../src/digest.mjs';
import { boundarySentence } from '../src/sentences.mjs';
import { validateSentence, portuguese, tablesInCode, createPurposes, loadConfig } from '../src/ai.mjs';
import { cookieNames } from '../src/runtime.mjs';
import { openStore } from '../src/store.mjs';

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
  assert.match(group.sentence, /^Preparação da base de dados: 5 comandos \(2 CREATE, 2 ALTER, 1 INSERT\) em 3 tabelas · 2 falharam sem interromper a função$/);
  assert.equal(group.children[0].purpose.text, 'Cria a tabela schools se ainda não existir');
  // The route's sentence: an INSERT that changed no rows is not a change.
  assert.equal(view.nodes[0].purpose.text,
    'Executa 4 comandos de estrutura da base de dados · lê schools · acrescenta a sessions · tenta escrever em settings sem alterar linhas · chama ensureSchema');
  assert.equal(view.lines.total, 9);
  assert.equal(view.lines.visible, 5);
  const effects = view.effects.items.map(item => item.text);
  assert.deepEqual(effects, ['INSERT em settings sem linhas alteradas', '1 linha acrescentada em sessions',
    '4 comandos de estrutura da base de dados (2 sem erro, 2 falharam); a gravação não indica se alteraram a base']);
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
  assert.match(kids[0].sentence, /— 3 vezes seguidas$/);
  assert.equal(kids[1].sentence, '3 funções auxiliares sem fronteiras: slugToId, a e b');
  assert.equal(kids[3].purpose.text, 'Trabalho interno: nenhuma fronteira observada');
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
  assert.equal(kids[1].sentence, 'O mesmo conjunto de 2 passos repetido 3 vezes: lê heartbeat e stat · chama getCalculator');
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
  assert.match(view.nodes[0].purpose.text, /chama handler e c$/);
});

test('frases das fronteiras e resumo dos efeitos, em português e em inglês', () => {
  assert.equal(boundarySentence({ kind: 'base-de-dados', operation: 'UPDATE', tables: ['students'], result: { affectedRows: 0 } }, 'pt-PT'),
    'Tenta alterar students; nenhuma linha alterada');
  assert.equal(boundarySentence({ kind: 'email', to: ['j***@m***.com'], subject: 'Login', result: {} }, 'pt-PT'), 'Envia um email para j***@m***.com «Login»');
  assert.equal(boundarySentence({ kind: 'http', method: 'GET', host: 'api.x.com', path: '/v1', result: { status: 500 }, error: true }, 'en'),
    'Calls api.x.com: GET /v1 (status 500) — failed');
  assert.equal(boundarySentence({ kind: 'ficheiros', provider: 'S3', operation: 'escrita', bucket: 'fotos', bytes: 10, result: {} }, 'pt-PT'),
    'Escrita de ficheiro: S3 fotos (10 bytes)');
  const mail = { id: 'm', type: 'boundary', kind: 'email', to: ['a***@b***.pt'], subject: 'Olá', result: {} };
  const view = digestRequest(dossier([mail], { request: { run: 'r', method: 'POST', path: '/x', status: 200, cookies: [{ name: 'sid', cleared: false }, { name: 'old', cleared: true }] } }), { lang: 'en' });
  assert.deepEqual(view.effects.items.map(item => item.text), ['Email sent to a***@b***.pt “Olá”', 'Cookies stored in the browser: sid', 'Cookies deleted in the browser: old']);
  const none = digestRequest(dossier([db(null, 'SELECT', 'user', { rows: 1 })]));
  assert.equal(none.effects.lasting, 0);
  assert.equal(none.effects.none, 'Nenhum efeito permanente observado.');
});

test('ação: pedidos da ferramenta de desenvolvimento agrupados (M8) e resumo de uma linha', () => {
  assert.ok(isDevToolRequest('/_next/static/webpack/abc.webpack.hot-update.json'));
  assert.ok(isDevToolRequest('/@vite/client'));
  assert.ok(!isDevToolRequest('/api/items'));
  const server = dossier([db(null, 'INSERT', 'item', { affectedRows: 1 })], { request: { run: 'r', method: 'POST', path: '/api/items', status: 201, cookies: [] } });
  const action = digestAction({ label: 'botão «Add»', timeline: [
    { type: 'trigger', trigger: { event: 'click' } },
    { type: 'request', browser: { method: 'GET', path: '/_next/static/webpack/a.hot-update.json', sameOrigin: true }, server: [] },
    { type: 'request', browser: { method: 'GET', path: '/_next/static/webpack/b.hot-update.json', sameOrigin: true }, server: [] },
    { type: 'request', browser: { method: 'POST', path: '/api/items', status: 201, sameOrigin: true }, server: [server] },
    { type: 'screen', screen: { added: 2 } },
  ] });
  assert.deepEqual(action.timeline.map(item => item.type), ['trigger', 'dev-group', 'request', 'screen']);
  assert.equal(action.timeline[1].sentence, '2 pedidos da ferramenta de desenvolvimento (recompilação, hot reload)');
  assert.equal(action.summary, 'Clique em botão «Add» → POST /api/items (estado 201) → altera o ecrã');
  assert.deepEqual(action.effects.items.map(item => item.text), ['1 linha acrescentada em item']);
});

test('validação das frases da IA: nada que não esteja nos factos', () => {
  const read = [{ kind: 'base-de-dados', operation: 'SELECT', tables: ['user'] }];
  const facts = { boundaries: read, allowedWords: new Set(['finduser', 'user']), knownTables: new Set(['user', 'item', 'audit_log']), knownHosts: new Set(['api.github.com']) };
  assert.equal(validateSentence('Procura o utilizador na base de dados.', facts), null);
  assert.equal(validateSentence('Devolve o item pedido.', facts), null, 'palavra comum igual a uma tabela');
  assert.match(validateSentence('Lê a tabela item.', facts), /tabela item/);
  assert.match(validateSentence('Regista a entrada em audit_log.', facts), /audit_log|Regista/);
  assert.match(validateSentence('Guarda o utilizador.', facts), /sem nenhuma escrita/);
  assert.equal(validateSentence('Guarda o token num cookie.', facts), null);
  assert.match(validateSentence('Envia um email de boas-vindas.', facts), /email/);
  assert.equal(validateSentence('Procura o utilizador pelo email fornecido.', facts), null, 'email como dado, não como envio');
  assert.equal(validateSentence('Altera o ecrã sem interação com o servidor ou base de dados.', { ...facts, boundaries: [] }), null, 'negação');
  assert.match(validateSentence('Lê a base de dados.', { ...facts, boundaries: [] }), /base de dados/);
  assert.match(validateSentence('Cobra o pagamento.', facts), /pagamento/);
  assert.match(validateSentence('Confirma com api.github.com.', facts), /api\.github\.com/);
  assert.match(validateSentence('Valida o token; caso contrário rejeita o pedido.', facts), /ramo/);
  assert.match(validateSentence('Chama sendWelcomeMail.', facts), /sendWelcomeMail/);
  assert.match(validateSentence('', facts), /vazia/);
  assert.deepEqual(tablesInCode("db.query('INSERT INTO audit_log (a) VALUES (?)'); knex.from(`users`)"), ['audit_log']);
});

test('português de Portugal: formas do Brasil substituídas com o género certo', () => {
  assert.equal(portuguese('Busca um usuário no banco de dados e retorna o status da requisição.', 'pt-PT'),
    'Procura um utilizador na base de dados e devolve o estado do pedido.');
  assert.equal(portuguese('Associa à requisição a tela.', 'pt-PT'), 'Associa ao pedido o ecrã.');
  assert.equal(portuguese('Returns the status.', 'en'), 'Returns the status.');
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

test('IA: sem fornecedor não há chamadas; com um fornecedor falso, frases validadas, repetidas pedidas uma vez e guardadas', async () => {
  const none = await loadConfig({ env: { CODETAC_AI_PROVIDER: 'nenhum' } });
  assert.equal(none.provider, null);
  assert.equal((await loadConfig({ env: { CODETAC_AI_PROVIDER: 'anthropic' } })).problem, 'Falta a chave da Anthropic (CODETAC_AI_KEY).');
  assert.equal((await loadConfig({ env: { CODETAC_AI_PROVIDER: 'ollama', CODETAC_AI_URL: 'http://127.0.0.1:9' } })).provider, null);

  // A fake OpenAI-compatible server: records what it receives.
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      const request = JSON.parse(body);
      received.push(request);
      const user = request.messages.at(-1).content;
      const answer = user.includes('Função: save')
        ? { finalidade: 'Grava o utilizador e envia um email de boas-vindas.', fronteiras: [{ id: 'b1', finalidade: 'Regista o novo utilizador.' }] }
        : { finalidade: 'Converte o utilizador para JSON.', fronteiras: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const config = await loadConfig({ env: { CODETAC_AI_PROVIDER: 'compativel', CODETAC_AI_MODEL: 'falso', CODETAC_AI_URL: `http://127.0.0.1:${server.address().port}`,
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
  // "envia um email" is not in the facts: the sentence is rejected.
  assert.equal(result.purposes[route.id].source, 'factos');
  assert.match(result.purposes[route.id].rejected, /email/);
  // The boundary sentence is valid (an INSERT was observed).
  assert.equal(result.purposes[steps[1].id].text, 'Regista o novo utilizador.');
  // toJSON twice with the same code and facts: asked once, both get it.
  assert.equal(result.purposes[steps[2].id].text, 'Converte o utilizador para JSON.');
  assert.deepEqual(result.purposes[steps[4].id], result.purposes[steps[2].id]);
  assert.equal(received.length, 3);
  // Secrets never leave: the code is redacted before it is sent.
  assert.ok(!JSON.stringify(received).includes('segredo-muito-secreto'));
  assert.equal(saved.size, 3);
});
