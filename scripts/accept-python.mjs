#!/usr/bin/env node
// Python examples (fixtures/python/<name>): starts the app with the Python
// captor, makes the requests of the scenario and checks the recorded
// functions against the source.
//   node scripts/accept-python.mjs [flask-sqlite|fastapi-async|fastapi-sync|bases-de-dados|rede|servidores|websocket-lifespan…] [--reload]
// --reload also runs the development server with its reloader (flask run
// --debug, fastapi dev) on a temporary copy, changes a file and checks that
// the capture goes on in the new process and that the supervisor records
// nothing of its own.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory } from '../src/home.mjs';
import { boundarySentence } from '../src/sentences.mjs';
import { fixture, freePort, gitStatus, prepareEnvironment, root, sleep, startApp } from './lib/python-apps.mjs';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const args = process.argv.slice(2);
const reload = args.includes('--reload');
const names = args.filter(arg => !arg.startsWith('--'));
const checks = [];
let prefix = '';
const check = (label, ok, detail = '') => {
  checks.push({ scenario: prefix, label, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
function defLine(project, file, fn) {
  const lines = readFileSync(join(project, file), 'utf8').split('\n');
  return lines.findIndex(line => new RegExp(`^\\s*(async\\s+)?def ${fn}\\(`).test(line)) + 1;
}

// The function tree of a recording.
function tree(events) {
  const enters = events.filter(event => event.type === 'enter');
  const exits = new Map(events.filter(event => event.type === 'exit').map(event => [event.id, event]));
  return {
    enters, exits,
    children: id => enters.filter(event => event.parentId === id),
    named: fn => enters.filter(event => event.function === fn),
    names: id => enters.filter(event => event.parentId === id).map(event => event.function),
    duration: event => (exits.get(event?.id)?.durationNs ?? -1) / 1e6,
  };
}

function commonChecks(app, project, secrets, events) {
  const { enters, exits } = tree(events);
  const modules = events.filter(event => event.type === 'module');
  const functions = new Set(enters.map(event => `${event.file}:${event.line}:${event.function}`));
  check('cobertura', modules.length >= 3 && functions.size >= 8, `${modules.length} módulos do projeto, ${functions.size} funções diferentes observadas, ${enters.length} chamadas`);
  check('todas as funções terminaram', enters.every(event => exits.has(event.id)), enters.filter(event => !exits.has(event.id)).map(event => event.function).join(', '));
  const files = new Set(events.filter(event => event.file).map(event => event.file));
  check('nenhuma função do .venv ou das bibliotecas', [...files].every(file => file.startsWith(project + '/') && !file.includes('/.venv/')), [...files].map(file => file.slice(project.length + 1)).join(', '));
  const raw = app.raw();
  const found = Object.entries(secrets).filter(([, value]) => raw.includes(value.trim())).map(([key]) => key);
  check('0 segredos e 0 valores nas gravações', found.length === 0, `${Object.keys(secrets).length} procurados${found.length ? `; encontrados: ${found.join(', ')}` : ''}`);
  const starts = events.filter(event => event.type === 'capture-start');
  check('capture-start em nível normal', starts.length && starts.every(event => event.level === 'normal'), `Python ${starts[0]?.python}`);
  return { modules: modules.length, functions: functions.size, calls: enters.length };
}

// Every answered request is a `request` with its `request-end`, and the port
// is the one given to the server.
function requestChecks(app, events) {
  const requests = events.filter(event => event.type === 'request');
  const ends = new Map(events.filter(event => event.type === 'request-end').map(event => [event.requestId, event]));
  const seen = requests.map(event => `${event.method} ${event.path} ${ends.get(event.requestId)?.status}`).sort();
  const expected = app.answered.map(item => `${item.method} ${item.path} ${item.status}`).sort();
  check('um request/request-end por pedido, com o método, o caminho e o estado', JSON.stringify(seen) === JSON.stringify(expected), `${requests.length} pedidos`);
  const ids = new Set(requests.map(event => event.requestId));
  const enters = events.filter(event => event.type === 'enter');
  const inRequests = enters.filter(event => ids.has(event.requestId)).length;
  check('funções dentro dos pedidos levam o requestId', enters.every(event => event.requestId === null || ids.has(event.requestId)) && inRequests > 0, `${inRequests} de ${enters.length} chamadas dentro de pedidos`);
  const ports = [...new Set(events.filter(event => event.type === 'listening').map(event => event.port))];
  check('porta real pelo listening', ports.length === 1 && ports[0] === app.port, `listening: ${ports.join(', ') || 'nenhum'}; servidor: ${app.port}`);
  return requests;
}

// The panel, on a copy of the recording in a temporary data folder: one
// dossier per request, and the expected function in each.
async function panelChecks(app, expected) {
  const dossiers = new Map();
  const home = mkdtempSync(join(tmpdir(), 'ctpy-painel'));
  cpSync(app.recording, join(home, app.run), { recursive: true });
  const port = await freePort();
  const panel = spawn(process.execPath, [join(root, 'src/panel.mjs'), '--port', String(port)], {
    env: { ...process.env, CODETAC_HOME: home, CODETAC_AI_PROVIDER: 'none' }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let waited = 0; ; waited += 100) {
      try { await fetch(`${base}/api/ping`); break; } catch { if (waited > 10000) throw new Error('o painel não arrancou'); await sleep(100); }
    }
    const listed = await (await fetch(`${base}/api/requests?run=${encodeURIComponent(app.run)}&limit=500`)).json();
    for (const request of listed) dossiers.set(request.requestId, await (await fetch(`${base}/api/requests/${encodeURIComponent(request.requestId)}`)).json());
    check('painel: um dossier por pedido', listed.length === app.answered.length, `${listed.length} no painel, ${app.answered.length} feitos`);
    const missing = [];
    for (const [method, path, fn, status] of expected) {
      const request = listed.find(item => item.method === method && item.path === path && item.functions > 0 && (status == null || item.status === status));
      const dossier = request && await (await fetch(`${base}/api/requests/${encodeURIComponent(request.requestId)}`)).json();
      if (!dossier?.steps?.some(step => step.function === fn)) missing.push(`${method} ${path} → ${fn}`);
    }
    check('painel: cada dossier tem as funções do seu pedido', missing.length === 0, missing.length ? `em falta: ${missing.join('; ')}` : `${expected.length} pedidos verificados`);
  } finally {
    panel.kill();
    rmSync(home, { recursive: true, force: true });
  }
  return dossiers;
}

// The database boundaries of one request, as the panel shows them: operation,
// tables, rows, the function that made each one, its sentence.
function databaseSteps(dossier) {
  const functions = new Map(dossier.steps.filter(step => step.type === 'function').map(step => [step.id, step.function]));
  return dossier.steps.filter(step => step.type === 'boundary' && step.kind === 'base-de-dados').map(step => ({
    operation: step.operation, tables: (step.tables ?? []).join(','), library: step.library, by: functions.get(step.parentId) ?? null,
    rows: step.result?.rows, affected: step.result?.affectedRows, error: step.error || step.result?.error || false,
    sentence: boundarySentence(step),
  }));
}
// Any boundary of one request, as the panel shows it, with the function that made it.
function boundarySteps(dossier, kind) {
  const functions = new Map((dossier?.steps ?? []).filter(step => step.type === 'function').map(step => [step.id, step.function]));
  return (dossier?.steps ?? []).filter(step => step.type === 'boundary' && (!kind || step.kind === kind))
    .map(step => ({ ...step, by: functions.get(step.parentId) ?? null, sentence: boundarySentence(step) }));
}
const effectsOf = dossier => (dossier.digest?.effects?.items ?? []).map(item => item.text);
function dossierFor(dossiers, method, path, status) {
  return [...dossiers.values()].find(item => item.request.method === method && item.request.path === path && (status == null || item.request.status === status));
}
const summary = steps => steps.map(step => `${step.by}:${step.operation} ${step.tables}${step.affected != null ? ` (${step.affected})` : step.rows != null ? ` [${step.rows}]` : ''}`).join(' → ');

function afterStop(app, project, before) {
  check('git status do exemplo inalterado', gitStatus(project) === before);
  check('nenhum processo da app ficou ativo', !app.leftover());
}

// ---------------------------------------------------------------- flask-sqlite
async function flaskSqlite() {
  const project = fixture('flask-sqlite');
  const python = prepareEnvironment(project);
  const before = gitStatus(project);
  const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
  const secrets = { password: 'palavra-passe-de-ensaio', wrong: 'errada-de-proposito-77', secretKey: 'chave-local-de-ensaio-xyz', title: 'Comprar pão de ló', renamed: 'Titulo-renomeado-secreto' };
  const app = await startApp({ project, command: python, run: `py-flask-sqlite-${stamp}`,
    commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--port', String(port)],
    env: { APP_DATABASE: join(database, 'app.sqlite'), FLASK_SECRET_KEY: secrets.secretKey } });
  const statuses = {};
  const pages = {};
  try {
    statuses.form = await app.request('GET', '/');
    statuses.wrong = await app.request('POST', '/login', { form: { username: 'ana', password: secrets.wrong } });
    statuses.login = await app.request('POST', '/login', { form: { username: 'ana', password: secrets.password } });
    statuses.create = await app.request('POST', '/items', { form: { title: `  ${secrets.title}  ` } });
    statuses.list = await app.request('GET', '/items');
    statuses.rename = await app.request('POST', '/items/1/rename', { form: { title: secrets.renamed } });
    statuses.renameMissing = await app.request('POST', '/items/999/rename', { form: { title: secrets.renamed } });
    statuses.error = await app.request('GET', '/erro');
    // The bar in the page (stage 8): documents get the tag, with the length
    // adjusted; the Flask error page too; CodeTAC's own route never reaches the app.
    const document = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'accept-encoding': 'gzip, br' };
    pages.list = [await app.request('GET', '/items', { headers: document }), app.last];
    pages.error = [await app.request('GET', '/erro', { headers: document }), app.last];
    pages.bar = [await app.request('GET', '/__codetac/bar.js', { own: true }), app.last];
  } finally {
    await app.stop();
    rmSync(database, { recursive: true, force: true });
  }
  const events = app.events();
  const t = tree(events);
  const where = (event, file, fn) => event && event.file === join(project, file) && event.line === defLine(project, file, fn);
  check('estados HTTP do cenário', JSON.stringify(statuses) === JSON.stringify({ form: 200, wrong: 401, login: 302, create: 302, list: 200, rename: 204, renameMissing: 404, error: 500 }), JSON.stringify(statuses));
  const login = t.named('login').find(event => t.names(event.id).includes('authenticate'));
  const authenticate = login && t.children(login.id).find(item => item.function === 'authenticate');
  check('login → authenticate → find_user, hash_password', where(login, 'app.py', 'login') && where(authenticate, 'services/auth.py', 'authenticate')
    && JSON.stringify(t.names(authenticate.id)) === JSON.stringify(['find_user', 'hash_password']), authenticate && t.names(authenticate.id).join(', '));
  const findUser = authenticate && t.children(authenticate.id).find(item => item.function === 'find_user');
  check('find_user → connect, com as linhas do db.py', where(findUser, 'db.py', 'find_user') && t.children(findUser.id).some(item => item.function === 'connect' && where(item, 'db.py', 'connect')));
  const create = t.named('create_item')[0];
  const add = create && t.children(create.id).find(item => item.function === 'add_item');
  check('create_item → add_item → normalise, insert_item', where(create, 'app.py', 'create_item') && where(add, 'services/items.py', 'add_item')
    && JSON.stringify(t.names(add.id)) === JSON.stringify(['normalise', 'insert_item']));
  const list = t.named('list_view')[0];
  const listItems = list && t.children(list.id).find(item => item.function === 'list_items');
  check('list_view → list_items → select_items, describe', where(listItems, 'services/items.py', 'list_items')
    && t.names(listItems.id)[0] === 'select_items' && t.names(listItems.id).includes('describe'), listItems && t.names(listItems.id).join(', '));
  const broken = t.named('broken')[0];
  const describe = broken && t.children(broken.id).find(item => item.function === 'describe');
  check('erro: broken e describe com error: true', t.exits.get(broken?.id)?.error === true && t.exits.get(describe?.id)?.error === true);
  const tag = '<script src="/__codetac/bar.js" data-codetac=""></script>';
  const withTag = ([status, response], where) => status >= 200 && response.body.includes(`${where}${tag}`)
    && Number(response.headers.get('content-length')) === Buffer.byteLength(response.body) && !response.headers.get('content-encoding');
  check('barra nas páginas: lista e página de erro 500 do Flask, com o tamanho certo', withTag(pages.list, '<head>') && pages.error[0] === 500 && withTag(pages.error, '<html lang=en>'),
    `${pages.list[0]}, ${pages.error[0]}`);
  check('/__codetac/bar.js servido pela app, sem chegar ao Flask', pages.bar[0] === 200 && pages.bar[1].body.startsWith('window.__CODETAC_CONFIG__')
    && !events.some(event => event.type === 'request' && event.path.startsWith('/__codetac/')));
  check('evento page por documento', JSON.stringify(events.filter(event => event.type === 'page').map(event => event.path)) === JSON.stringify(['/items', '/erro']));
  const requests = requestChecks(app, events);
  const loginRequest = requests.find(event => event.path === '/login' && events.some(end => end.type === 'request-end' && end.requestId === event.requestId && end.status === 302));
  const loginEnd = loginRequest && events.find(event => event.type === 'request-end' && event.requestId === loginRequest.requestId);
  check('login: cookie de sessão só com o nome', loginEnd?.cookies?.length === 1 && loginEnd.cookies[0].name === 'session' && !app.raw().includes(app.jar.get('session') ?? '---'), JSON.stringify(loginEnd?.cookies));
  const dossiers = await panelChecks(app, [['POST', '/login', 'authenticate'], ['POST', '/items', 'add_item'], ['GET', '/items', 'list_items'], ['GET', '/erro', 'broken']]);
  const flows = {
    login: databaseSteps(dossierFor(dossiers, 'POST', '/login', 302)),
    create: databaseSteps(dossierFor(dossiers, 'POST', '/items')),
    list: databaseSteps(dossierFor(dossiers, 'GET', '/items')),
    rename: databaseSteps(dossierFor(dossiers, 'POST', '/items/1/rename')),
    missing: databaseSteps(dossierFor(dossiers, 'POST', '/items/999/rename')),
  };
  check('base de dados na ordem certa, dentro da função que a usa', summary(flows.login) === 'find_user:SELECT users'
    && summary(flows.create) === 'insert_item:INSERT items (1)' && summary(flows.list) === 'select_items:SELECT items'
    && summary(flows.rename) === 'rename_item:UPDATE items (1)' && summary(flows.missing) === 'rename_item:UPDATE items (0)',
  Object.entries(flows).map(([name, steps]) => `${name}: ${summary(steps)}`).join('; '));
  check('escrita sem linhas: «tenta alterar … nenhuma linha alterada»', flows.missing[0]?.sentence === 'Tries to change items; no rows changed', flows.missing[0]?.sentence);
  const createEffects = effectsOf(dossierFor(dossiers, 'POST', '/items'));
  const missingEffects = effectsOf(dossierFor(dossiers, 'POST', '/items/999/rename'));
  check('efeitos permanentes no resumo', createEffects.includes('1 linha acrescentada em items') && missingEffects.includes('UPDATE em items sem linhas alteradas')
    && effectsOf(dossierFor(dossiers, 'POST', '/items/1/rename')).includes('1 linha alterada em items'),
  `${createEffects.join(', ')} | ${missingEffects.join(', ')}`);
  const counts = commonChecks(app, project, secrets, events);
  afterStop(app, project, before);
  return { run: app.recording, statuses, ...counts };
}

// ---------------------------------------------------------------- fastapi-async
async function fastapiAsync() {
  const project = fixture('fastapi-async');
  const python = prepareEnvironment(project);
  const before = gitStatus(project);
  const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
  // The external API: a local server that answers after 40 ms.
  const external = createHttpServer((request, response) => setTimeout(() => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ city: 'Lisboa', max: 23.6 }));
  }, 40));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const secrets = { title: 'Nota confidencial de ensaio', renamed: 'Nota-renomeada-secreta', token: `tok-${randomBytes(12).toString('hex')}` };
  const app = await startApp({ project, command: python, run: `py-fastapi-async-${stamp}`, probe: '/docs',
    commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)],
    env: { APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}`, EXTERNAL_API_URL: `http://127.0.0.1:${external.address().port}`,
      EXTERNAL_API_TOKEN: secrets.token } });
  const statuses = {};
  try {
    statuses.create = await app.request('POST', '/notes', { json: { title: `  ${secrets.title}  ` } });
    statuses.list = await app.request('GET', '/notes');
    statuses.forecast = await app.request('GET', '/forecast/Lisboa');
    statuses.rename = await app.request('PATCH', '/notes/1', { json: { title: secrets.renamed } });
    statuses.renameMissing = await app.request('PATCH', '/notes/999', { json: { title: secrets.renamed } });
    // A body that fails validation (stage 9): 422, with the opaque step marked as an error.
    statuses.invalid = await app.request('POST', '/notes', { json: { titulo: secrets.title } });
    await sleep(300);
  } finally {
    await app.stop();
    external.close();
    rmSync(database, { recursive: true, force: true });
  }
  const events = app.events();
  const t = tree(events);
  const main = join(project, 'main.py');
  check('estados HTTP do cenário', JSON.stringify(statuses) === JSON.stringify({ create: 201, list: 200, forecast: 200, rename: 200, renameMissing: 404, invalid: 422 }), JSON.stringify(statuses));
  const create = t.named('create_note').find(event => event.file === main);
  const service = create && t.children(create.id).find(item => item.function === 'create_note');
  check('create_note → notes.create_note → clean_title; depois do await, summary no mesmo pai', create?.async && service?.async
    && JSON.stringify(t.names(create.id)) === JSON.stringify(['create_note', 'summary']) && JSON.stringify(t.names(service.id)) === JSON.stringify(['clean_title']),
  create && `${t.names(create.id).join(', ')} | ${service && t.names(service.id).join(', ')}`);
  const session = t.named('get_session');
  check('Depends(get_session): gerador async com uma saída por pedido', session.length >= 2 && session.every(event => event.async && t.exits.has(event.id)), `${session.length} sessões`);
  const record = t.named('record')[0];
  check('BackgroundTasks: audit.record → label', record && JSON.stringify(t.names(record.id)) === JSON.stringify(['label']));
  const forecast = t.named('forecast')[0];
  const fetchForecast = forecast && t.children(forecast.id).find(item => item.function === 'fetch_forecast');
  check('forecast → fetch_forecast → parse_forecast, com a espera da API externa na duração', fetchForecast && t.names(fetchForecast.id).includes('parse_forecast') && t.duration(fetchForecast) >= 40,
    fetchForecast ? `${t.duration(fetchForecast).toFixed(1)} ms` : '');
  const list = t.named('list_notes').find(event => event.file === main && t.names(event.id).includes('list_notes'));
  const listService = list && t.children(list.id).find(item => item.function === 'list_notes');
  check('list_notes → notes.list_notes → summary', listService && t.names(listService.id).includes('summary'));
  const lifespan = t.named('lifespan')[0];
  check('lifespan: termina no fim do servidor', lifespan && t.exits.has(lifespan.id) && t.names(lifespan.id).includes('create_tables'));
  const requests = requestChecks(app, events);
  const createRequest = requests.find(event => event.method === 'POST');
  check('BackgroundTasks: o trabalho depois da resposta fica no pedido', record && createRequest && record.requestId === createRequest.requestId);
  const dossiers = await panelChecks(app, [['POST', '/notes', 'clean_title', 201], ['GET', '/notes', 'summary'], ['GET', '/forecast/Lisboa', 'parse_forecast']]);
  const flows = {
    create: databaseSteps(dossierFor(dossiers, 'POST', '/notes', 201)),
    list: databaseSteps(dossierFor(dossiers, 'GET', '/notes', 200)),
    rename: databaseSteps(dossierFor(dossiers, 'PATCH', '/notes/1')),
    missing: databaseSteps(dossierFor(dossiers, 'PATCH', '/notes/999')),
  };
  check('SQLAlchemy async: ordem certa, dentro da função, e o INSERT do BackgroundTasks no pedido',
    summary(flows.create) === 'create_note:INSERT notes (1) → record:INSERT audit (1)' && summary(flows.list) === 'list_notes:SELECT notes'
    && summary(flows.rename) === 'rename_note:UPDATE notes (1)' && summary(flows.missing) === 'rename_note:UPDATE notes (0)',
  Object.entries(flows).map(([name, steps]) => `${name}: ${summary(steps)}`).join('; '));
  const libraries = new Set(Object.values(flows).flat().map(step => step.library));
  check('uma fronteira por comando: o SQLAlchemy, sem repetir o sqlite3 que o aiosqlite corre noutra thread', libraries.size === 1 && libraries.has('sqlalchemy/sqlite'), [...libraries].join(', '));
  check('efeitos permanentes no resumo', effectsOf(dossierFor(dossiers, 'POST', '/notes', 201)).join(',') === '1 linha acrescentada em notes,1 linha acrescentada em audit'
    && effectsOf(dossierFor(dossiers, 'PATCH', '/notes/999')).includes('UPDATE em notes sem linhas alteradas'), effectsOf(dossierFor(dossiers, 'POST', '/notes', 201)).join(', '));
  const call = boundarySteps(dossierFor(dossiers, 'GET', '/forecast/Lisboa'), 'http');
  check('chamada HTTP externa visível com o domínio e o estado, dentro de fetch_forecast', call.length === 1 && call[0].by === 'fetch_forecast'
    && call[0].library === 'httpx' && call[0].host === '127.0.0.1' && call[0].path === '/forecast' && call[0].result?.status === 200
    && JSON.stringify(call[0].queryKeys) === '["city"]', call.map(step => `${step.by}: ${step.sentence}`).join('; '));
  // Stage 9: the validation of the body as an opaque step, and the work after the response marked.
  const validation = 'request validation (not observable)';
  const opaqueOf = (method, path, status) => (dossierFor(dossiers, method, path, status)?.steps ?? []).filter(step => step.function === validation);
  const opaqueSteps = { create: opaqueOf('POST', '/notes', 201), invalid: opaqueOf('POST', '/notes', 422), rename: opaqueOf('PATCH', '/notes/1'),
    list: opaqueOf('GET', '/notes', 200), forecast: opaqueOf('GET', '/forecast/Lisboa') };
  check('corpo validado: passo opaco “request validation (not observable)”, antes do endpoint, com erro no 422',
    opaqueSteps.create.length === 1 && opaqueSteps.rename.length === 1 && opaqueSteps.invalid.length === 1 && !opaqueSteps.list.length && !opaqueSteps.forecast.length
    && opaqueSteps.create[0].opaque && opaqueSteps.create[0].file == null && !opaqueSteps.create[0].error && opaqueSteps.invalid[0].error
    && opaqueSteps.create[0].sequence < (dossierFor(dossiers, 'POST', '/notes', 201).steps.find(step => step.function === 'create_note')?.sequence ?? 0),
  Object.entries(opaqueSteps).map(([name, steps]) => `${name}: ${steps.length}${steps[0]?.error ? ' (erro)' : ''}`).join(', '));
  const created = dossierFor(dossiers, 'POST', '/notes', 201);
  const after = created.steps.filter(step => step.afterResponse).map(step => step.function ?? `${step.operation} ${(step.tables ?? []).join(',')}`);
  check('BackgroundTasks marcado afterResponse (funções e fronteira), e só ele', JSON.stringify(after) === JSON.stringify(['record', 'label', 'INSERT audit']),
    after.join(', '));
  const raw = app.raw();
  check('sem cabeçalhos: nem o nome nem o valor do Authorization', !raw.includes(secrets.token) && !/authorization/i.test(raw));
  const counts = commonChecks(app, project, secrets, events);
  afterStop(app, project, before);
  return { run: app.recording, statuses, ...counts };
}

// ---------------------------------------------------------------- fastapi-sync
async function fastapiSync() {
  const project = fixture('fastapi-sync');
  const python = prepareEnvironment(project);
  const before = gitStatus(project);
  const app = await startApp({ project, command: python, run: `py-fastapi-sync-${stamp}`, probe: '/docs',
    commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)] });
  const statuses = {};
  try {
    statuses.report = await app.request('GET', '/report?size=4');
    statuses.dashboard = await app.request('GET', '/dashboard');
    // Concurrent load: every dashboard must keep its own three loads.
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => app.request('GET', index % 2 ? '/dashboard' : '/report?size=3')));
    statuses.concurrent = concurrent.every(status => status === 200) ? 200 : concurrent.join(',');
  } finally {
    await app.stop();
  }
  const events = app.events();
  const t = tree(events);
  check('estados HTTP do cenário', JSON.stringify(statuses) === JSON.stringify({ report: 200, dashboard: 200, concurrent: 200 }), JSON.stringify(statuses));
  const reports = t.named('get_report');
  const builds = reports.map(report => t.children(report.id).find(item => item.function === 'build_report'));
  check('endpoint def na threadpool: get_report → build_report → make_row…, total', reports.length === 5 && builds.every(Boolean)
    && t.names(builds[0].id).join(',') === 'make_row,make_row,make_row,make_row,total' && builds.every(build => t.duration(build) >= 20),
  builds[0] && `${t.names(builds[0].id).join(', ')}; ${t.duration(builds[0]).toFixed(1)} ms`);
  const dashboards = t.named('load_dashboard');
  const isolated = dashboards.every(dashboard => {
    const loads = t.children(dashboard.id);
    return JSON.stringify(loads.map(load => load.function).sort()) === JSON.stringify(['load_alerts', 'load_sales', 'load_stock'])
      && loads.every(load => t.children(load.id).length === 1);
  });
  check('gather: cada load_dashboard tem os seus 3 loads, e cada um o seu helper (5 pedidos, 4 em simultâneo)', dashboards.length === 5 && isolated, `${dashboards.length} dashboards`);
  const sales = t.named('load_sales')[0];
  // asyncio.sleep(0.03) pode acordar uma fração de ms antes; sem as esperas a duração seria perto de 0.
  check('duração async inclui as esperas', t.duration(sales) >= 27 && t.duration(dashboards[0]) >= 27, `load_sales ${t.duration(sales).toFixed(1)} ms`);
  const requests = requestChecks(app, events);
  const isolatedRequests = dashboards.every(dashboard => {
    const own = [dashboard, ...t.children(dashboard.id)];
    return own.every(event => event.requestId === dashboard.requestId) && t.children(dashboard.id).flatMap(load => t.children(load.id)).every(event => event.requestId === dashboard.requestId);
  });
  check('pedidos simultâneos: cada função fica no seu pedido', isolatedRequests && new Set(dashboards.map(event => event.requestId)).size === 5);
  await panelChecks(app, [['GET', '/report', 'build_report'], ['GET', '/dashboard', 'load_sales']]);
  const counts = commonChecks(app, project, {}, events);
  afterStop(app, project, before);
  return { run: app.recording, statuses, ...counts };
}

// ---------------------------------------------------------------- reloaders
// A temporary copy (without .venv) so that a file can be changed; the
// example's own .venv runs it.
async function reloadScenario({ name, executable, commandArgs, request, edit, target, supervisor }) {
  const source = fixture(name);
  const python = prepareEnvironment(source);
  const project = realpathSync(mkdtempSync(join(tmpdir(), `ctpy-${name}-`)));
  cpSync(source, project, { recursive: true, filter: path => !/\/(\.venv|instance|__pycache__)(\/|$)/.test(path) });
  const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
  const app = await startApp({ project, command: executable(python), run: `py-${name}-recarga-${stamp}`, commandArgs, probe: request,
    env: { APP_DATABASE: join(database, 'app.sqlite'), APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}` } });
  let changed = null;
  try {
    await app.request('GET', request);
    await sleep(300);
    const first = new Set(app.events().filter(event => event.function === target).map(event => event.process));
    appendFileSync(join(project, edit), '\n# alteração do ensaio de recarga\n');
    for (let waited = 0; waited < 20000 && !changed; waited += 600) {
      await sleep(500);
      try { await app.request('GET', request); } catch {}
      await sleep(100);
      changed = app.events().filter(event => event.function === target).map(event => event.process).find(process => !first.has(process)) ?? null;
    }
  } finally {
    await app.stop();
    rmSync(database, { recursive: true, force: true });
  }
  const files = app.files();
  const byProcess = new Map();
  for (const event of files.flat()) byProcess.set(event.process, [...(byProcess.get(event.process) ?? []), event]);
  const supervisors = [...byProcess].filter(([, list]) => list.some(event => event.type === 'process' && event.role === 'supervisor'));
  const serving = [...byProcess].filter(([, list]) => list.some(event => event.function === target));
  check('depois da alteração de um ficheiro, a captura continua noutro processo', changed && serving.length >= 2, `${serving.length} processos serviram ${target}`);
  // Both reloaders load the app in the supervisor, which therefore has a file saying what it is.
  check(`supervisor reconhecido (${supervisor})`, supervisors.length === 1 && supervisors[0][1].find(event => event.type === 'process').server === supervisor);
  check('o supervisor não segue funções depois de se saber supervisor', supervisors.every(([, list]) => {
    const at = list.findIndex(event => event.type === 'process');
    return !list.slice(at).some(event => event.type === 'enter');
  }), `${supervisors.length} supervisor(es) com ficheiro${supervisors.length ? `: ${supervisors.map(([, list]) => list.find(event => event.type === 'process').server).join(', ')}` : ''}`);
  check('nenhum ficheiro só com capture-start, e todos começam por ele', files.every(list => list.length > 1 && list[0].type === 'capture-start'), `${files.length} ficheiros, ${byProcess.size} processos`);
  check('nenhum pedido do supervisor', supervisors.every(([, list]) => !list.some(event => event.type === 'request')));
  // werkzeug: the reloader opens the socket and hands it to the child, so the
  // real port may be announced by it; it is still the app's port.
  const ports = [...new Set(files.flat().filter(event => event.type === 'listening').map(event => event.port))];
  check('listening só na porta da app', ports.length === 1 && ports[0] === app.port, `listening: ${ports.join(', ')}; servidor: ${app.port}`);
  check('nenhum processo da app ficou ativo', !app.leftover());
  rmSync(project, { recursive: true, force: true });
  return { run: app.recording, processes: byProcess.size, supervisors: supervisors.length, serving: serving.length };
}

// ---------------------------------------------------------------- database drivers
// PostgreSQL and MySQL in throwaway Docker containers (codetac-ensaio-*),
// on 127.0.0.1 only, removed at the end. Other containers are never touched.
const docker = '/usr/local/bin/docker';
async function databases() {
  if (spawnSync(docker, ['info'], { encoding: 'utf8' }).status !== 0) {
    check('Docker disponível para o Postgres e o MySQL', false, 'o Docker não está a correr');
    return {};
  }
  const project = fixture('databases');
  const python = prepareEnvironment(project);
  const before = gitStatus(project);
  const password = randomBytes(12).toString('hex');
  const [pgPort, myPort] = [await freePort(), await freePort()];
  const names = [`codetac-ensaio-pg-${process.pid}`, `codetac-ensaio-mysql-${process.pid}`];
  const run = args => spawnSync(docker, args, { encoding: 'utf8' });
  const folder = mkdtempSync(join(tmpdir(), 'ctpy-db'));
  let app;
  const secret = 'Valor-do-parametro-secreto';
  const routes = ['psycopg', 'psycopg-async', 'psycopg2', 'asyncpg', 'pymysql', 'sqlalchemy-psycopg', 'sqlalchemy-asyncpg', 'sqlmodel-sqlite'];
  const statuses = {};
  try {
    run(['run', '-d', '--rm', '--name', names[0], '-e', 'POSTGRES_USER=ensaio', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=ensaio', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:17-alpine']);
    run(['run', '-d', '--rm', '--name', names[1], '-e', `MYSQL_ROOT_PASSWORD=${password}`, '-e', 'MYSQL_DATABASE=ensaio', '-e', 'MYSQL_USER=ensaio', '-e', `MYSQL_PASSWORD=${password}`, '-p', `127.0.0.1:${myPort}:3306`, 'mysql:8.4']);
    for (let waited = 0; ; waited += 1000) {
      const ready = run(['exec', names[0], 'pg_isready', '-U', 'ensaio', '-q']).status === 0
        && run(['exec', names[1], 'mysql', '-uensaio', `-p${password}`, '-e', 'select 1', 'ensaio']).status === 0;
      if (ready) break;
      if (waited > 90000) throw new Error('as bases de ensaio não arrancaram');
      await sleep(1000);
    }
    app = await startApp({ project, command: python, run: `py-databases-${stamp}`, probe: '/docs',
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)],
      env: { PG_DSN: `postgresql://ensaio:${password}@127.0.0.1:${pgPort}/ensaio`, MYSQL_PORT: String(myPort), MYSQL_PASSWORD: password,
        APP_DATABASE_URL_SYNC: `sqlite:///${join(folder, 'orm.sqlite')}` } });
    for (const route of routes) statuses[route] = await app.request('POST', `/${route}`, { json: { title: secret } });
  } finally {
    if (app) await app.stop();
    run(['rm', '-f', ...names]);
    rmSync(folder, { recursive: true, force: true });
  }
  check('estados HTTP', Object.values(statuses).every(status => status === 200), JSON.stringify(statuses));
  const dossiers = await panelChecks(app, []);
  const expected = {
    psycopg: ['psycopg', 'pg_items', 'psycopg_'], 'psycopg-async': ['psycopg', 'pg_items', 'psycopg_async_'], psycopg2: ['psycopg2', 'pg_items', 'psycopg2_'],
    asyncpg: ['asyncpg', 'pg_items', 'asyncpg_'], 'sqlalchemy-psycopg': ['sqlalchemy/postgresql', 'orm_items', 'orm_'],
    'sqlalchemy-asyncpg': ['sqlalchemy/postgresql', 'orm_items', 'orm_async_'], 'sqlmodel-sqlite': ['sqlalchemy/sqlite', 'orm_items', 'orm_'],
  };
  for (const route of routes) {
    const steps = databaseSteps(dossierFor(dossiers, 'POST', `/${route}`));
    const found = summary(steps);
    let ok;
    if (route === 'pymysql') {
      ok = found === 'mysql_insert:INSERT my_items (1) → mysql_insert_many:INSERT my_items (2) → mysql_select:SELECT my_items [3] → mysql_touch_missing:UPDATE my_items (0) → mysql_delete:DELETE my_items (3)'
        && steps.every(step => step.library === 'pymysql');
    } else {
      const [library, table, prefix] = expected[route];
      const read = route === 'sqlmodel-sqlite' ? `${prefix}select:SELECT ${table}` : `${prefix}select:SELECT ${table} [1]`;
      ok = found === `${prefix}insert:INSERT ${table} (1) → ${read} → ${prefix}touch_missing:UPDATE ${table} (0) → ${prefix}delete:DELETE ${table} (1)`
        && steps.every(step => step.library === library);
    }
    check(`${route}: INSERT, SELECT, UPDATE sem linhas e DELETE, uma fronteira por comando`, ok, found);
  }
  const raw = app.raw();
  check('0 valores dos parâmetros e 0 credenciais nas gravações', !raw.includes(secret) && !raw.includes(password));
  check('git status do exemplo inalterado', gitStatus(project) === before);
  check('contentores de ensaio apagados, e os outros intactos', !run(['ps', '-a', '--format', '{{.Names}}']).stdout.split('\n').some(name => names.includes(name)));
  check('nenhum processo da app ficou ativo', !app.leftover());
  return { run: app.recording, statuses };
}

// ---------------------------------------------------------------- network, AI, S3, email, files
// Local servers stand for the services: an AI API (OpenAI and Anthropic
// formats, JSON with gzip and streaming), an external API, S3 and SMTP.
function fakeServices() {
  const received = { s3: [], smtp: [] };
  const http = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url, 'http://x');
      const json = (value, gzip) => {
        let data = Buffer.from(JSON.stringify(value));
        response.setHeader('content-type', 'application/json');
        if (gzip && /gzip/.test(request.headers['accept-encoding'] ?? '')) { data = gzipSync(data); response.setHeader('content-encoding', 'gzip'); }
        response.end(data);
      };
      if (url.pathname === '/v1/chat/completions') {
        const payload = JSON.parse(body);
        if (!payload.stream) {
          return json({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Resumo em uma frase.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }, true);
        }
        response.setHeader('content-type', 'text/event-stream');
        const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: payload.model, choices, ...extra })}\n\n`;
        response.write(chunk([{ index: 0, delta: { role: 'assistant', content: 'Em ' } }]));
        response.write(chunk([{ index: 0, delta: { content: 'streaming.' }, finish_reason: 'stop' }]));
        response.write(chunk([], { usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }));
        return response.end('data: [DONE]\n\n');
      }
      if (url.pathname === '/v1/messages') {
        const payload = JSON.parse(body);
        return json({ id: 'msg_1', type: 'message', role: 'assistant', model: payload.model, content: [{ type: 'text', text: 'Olá da imitação.' }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } });
      }
      if (url.pathname === '/status') {
        response.statusCode = request.headers.authorization ? 200 : 401;
        return json({ ok: true });
      }
      if (url.pathname.startsWith('/faturas/')) {
        received.s3.push({ method: request.method, presigned: url.searchParams.has('Signature') || url.searchParams.has('X-Amz-Signature') });
        response.setHeader('etag', '"e1"');
        if (request.method === 'GET') return response.end('conteudo');
        return response.end();
      }
      response.statusCode = 404;
      response.end();
    });
  });
  const smtp = createTcpServer(socket => {
    let data = false;
    let buffer = '';
    socket.write('220 ensaio\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) { if (line === '.') { data = false; received.smtp.push('mensagem'); socket.write('250 aceite\r\n'); } continue; }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'DATA') { data = true; socket.write('354 continue\r\n'); }
        else if (command === 'QUIT') { socket.end('221 adeus\r\n'); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return {
    received,
    async start() {
      await Promise.all([new Promise(resolve => http.listen(0, '127.0.0.1', resolve)), new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve))]);
      return { http: http.address().port, smtp: smtp.address().port };
    },
    close() { http.close(); smtp.close(); },
  };
}

async function network() {
  const project = fixture('network');
  const python = prepareEnvironment(project);
  const before = gitStatus(project);
  const exports = realpathSync(mkdtempSync(join(tmpdir(), 'ctpy-exp')));
  const services = fakeServices();
  const ports = await services.start();
  const secrets = { openai: `sk-proj-${randomBytes(16).toString('hex')}`, anthropic: `sk-ant-${randomBytes(16).toString('hex')}`,
    token: `tok-${randomBytes(12).toString('hex')}`, account: `conta-${randomBytes(6).toString('hex')}`,
    awsKey: `AKIA${randomBytes(8).toString('hex').toUpperCase()}`, awsSecret: randomBytes(20).toString('hex'),
    content: 'Conteudo-do-ficheiro-secreto', recipient: 'cliente.secreto@exemplo.pt', row: 'linha-secreta-do-csv' };
  const app = await startApp({ project, command: python, run: `py-network-${stamp}`, probe: '/docs',
    commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)],
    env: { AI_BASE_URL: `http://127.0.0.1:${ports.http}`, OPENAI_API_KEY: secrets.openai, ANTHROPIC_API_KEY: secrets.anthropic,
      EXTERNAL_API_URL: `http://127.0.0.1:${ports.http}`, EXTERNAL_API_TOKEN: secrets.token, EXTERNAL_ACCOUNT: secrets.account,
      S3_ENDPOINT: `http://127.0.0.1:${ports.http}`, AWS_ACCESS_KEY_ID: secrets.awsKey, AWS_SECRET_ACCESS_KEY: secrets.awsSecret,
      AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(ports.smtp), EXPORT_DIR: exports } });
  const statuses = {};
  try {
    const question = { json: { text: 'o relatório trimestral' } };
    statuses.openai = await app.request('POST', '/ai/openai', question);
    statuses.stream = await app.request('POST', '/ai/openai-stream', question);
    statuses.anthropic = await app.request('POST', '/ai/anthropic', question);
    statuses.requests = await app.request('GET', '/web/requests');
    statuses.urllib = await app.request('GET', '/web/urllib');
    statuses.aiohttp = await app.request('GET', '/web/aiohttp');
    statuses.upload = await app.request('POST', '/files/upload', { json: { name: 'relatorio.pdf', content: secrets.content } });
    statuses.link = await app.request('GET', '/files/link/relatorio.pdf');
    statuses.email = await app.request('POST', '/email', { json: { to: secrets.recipient, total: 12.5 } });
    statuses.export = await app.request('POST', '/export', { json: { rows: [['a', secrets.row], ['b', 'c']] } });
  } finally {
    await app.stop();
    services.close();
  }
  check('estados HTTP do cenário', Object.values(statuses).every(status => status === 200), JSON.stringify(statuses));
  check('os serviços de ensaio receberam o S3 (envio e URL pré-assinado) e o email', services.received.s3.length === 2 && services.received.s3[1].presigned && !services.received.s3[0].presigned
    && services.received.smtp.length === 1, JSON.stringify(services.received));
  const dossiers = await panelChecks(app, [['POST', '/ai/openai', 'ask_openai'], ['GET', '/web/requests', 'summarise'], ['POST', '/export', 'to_csv']]);
  const of = (method, path, kind) => boundarySteps(dossierFor(dossiers, method, path), kind);
  const line = steps => steps.map(step => `${step.by}: ${step.sentence}`).join('; ');

  // AI through the SDKs: classified by path, with the model and the usage.
  const ai = { openai: of('POST', '/ai/openai'), stream: of('POST', '/ai/openai-stream'), anthropic: of('POST', '/ai/anthropic') };
  const usage = step => `${step?.result?.usage?.input}+${step?.result?.usage?.output}`;
  check('SDK openai (async): IA, com o modelo e o usage, dentro de ask_openai', ai.openai.length === 1 && ai.openai[0].kind === 'ia' && ai.openai[0].by === 'ask_openai'
    && ai.openai[0].library === 'httpx2' && ai.openai[0].model === 'gpt-4o-mini' && usage(ai.openai[0]) === '11+5' && ai.openai[0].result?.answerExcerpt === 'Resumo em uma frase.',
  `${line(ai.openai)} (resposta com gzip)`);
  check('SDK openai em streaming: usage do último bloco e o excerto da resposta', ai.stream.length === 1 && ai.stream[0].kind === 'ia' && usage(ai.stream[0]) === '9+3'
    && ai.stream[0].result?.stream === true && ai.stream[0].result?.answerExcerpt === 'Em streaming.', line(ai.stream));
  check('SDK anthropic (sync): IA, com o modelo e o usage, dentro de ask_anthropic', ai.anthropic.length === 1 && ai.anthropic[0].kind === 'ia' && ai.anthropic[0].by === 'ask_anthropic'
    && ai.anthropic[0].operation === '/v1/messages' && usage(ai.anthropic[0]) === '12+7' && ai.anthropic[0].result?.model === 'claude-sonnet-5', line(ai.anthropic));

  // External HTTP with each client: domain, path, keys of the query and status.
  const clients = { requests: ['/web/requests', 'with_requests', 'urllib3'], urllib: ['/web/urllib', 'with_urllib', 'http.client'], aiohttp: ['/web/aiohttp', 'with_aiohttp', 'aiohttp'] };
  for (const [name, [path, fn, library]] of Object.entries(clients)) {
    const steps = of('GET', path);
    check(`${name}: chamada HTTP com o domínio, o estado e só os nomes da query, dentro de ${fn}`, steps.length === 1 && steps[0].kind === 'http' && steps[0].by === fn
      && steps[0].library === library && steps[0].host === '127.0.0.1' && steps[0].path === '/status' && steps[0].result?.status === 200
      && JSON.stringify(steps[0].queryKeys) === '["account"]', line(steps));
  }

  // S3: the upload through botocore (one boundary, not also urllib3's), and the presigned URL read with requests.
  const upload = of('POST', '/files/upload');
  check('boto3: envio para o S3 reconhecido (balde, operação, bytes), uma só fronteira', upload.length === 1 && upload[0].kind === 'ficheiros' && upload[0].provider === 'S3'
    && upload[0].library === 'botocore' && upload[0].bucket === 'faturas' && upload[0].operation === 'escrita' && upload[0].bytes === secrets.content.length
    && upload[0].by === 'upload' && upload[0].result?.status === 200, line(upload));
  const link = of('GET', '/files/link/relatorio.pdf');
  check('URL pré-assinado S3 reconhecido (lido com requests), e gerá-lo não é uma chamada', link.length === 1 && link[0].kind === 'ficheiros' && link[0].provider === 'S3'
    && link[0].library === 'urllib3' && link[0].operation === 'leitura' && link[0].bucket === 'faturas' && link[0].by === 'share'
    && link[0].queryKeys.includes('Signature'), line(link));

  // Email: recipient redacted, count, accepted.
  const mail = of('POST', '/email');
  check('email visível com o destinatário redigido e a contagem', mail.length === 1 && mail[0].kind === 'email' && mail[0].by === 'send_receipt'
    && JSON.stringify(mail[0].to) === '["c***@e***"]' && mail[0].count === 1 && mail[0].result?.accepted === 1, line(mail));

  // Files: the project's writes, in the function that makes them; never the captor's.
  const files = of('POST', '/export', 'ficheiros');
  check('escritas de ficheiros do projeto (open e pathlib), dentro de export', files.length === 2 && files.every(step => step.by === 'export' && step.operation === 'escrita')
    && files[0].path.endsWith('/ctpy-exp' + exports.split('/ctpy-exp')[1] + '/relatorio.csv') && files[1].path.endsWith('/ultimo.txt'), line(files));
  const everything = [...dossiers.values()].flatMap(dossier => boundarySteps(dossier));
  const data = dataDirectory();
  check('escritas do próprio captor nunca aparecem como fronteira', everything.filter(step => step.kind === 'ficheiros' && step.provider === 'file system')
    .every(step => !String(step.path).startsWith(data) && !String(step.path).endsWith('.jsonl')), `${everything.length} fronteiras no total`);
  const effects = effectsOf(dossierFor(dossiers, 'POST', '/export')).concat(effectsOf(dossierFor(dossiers, 'POST', '/files/upload')), effectsOf(dossierFor(dossiers, 'POST', '/email')));
  check('efeitos permanentes: ficheiros escritos, envio para o S3 e email', effects.length >= 4, effects.join(' | '));

  const raw = app.raw();
  const found = Object.entries(secrets).filter(([, value]) => raw.includes(value)).map(([key]) => key);
  check('0 chaves, cabeçalhos, valores de query, credenciais AWS, conteúdos e endereços nas gravações', found.length === 0 && !/authorization|x-api-key|x-amz-credential=/i.test(raw),
    found.length ? `encontrados: ${found.join(', ')}` : `${Object.keys(secrets).length} procurados`);
  rmSync(exports, { recursive: true, force: true });
  afterStop(app, project, before);
  return { run: app.recording, statuses };
}

// ---------------------------------------------------------------- servers
// The same apps under each server of DP4: requests, the real port, and the
// dossiers in the panel.
const SERVERS = [
  { name: 'flask-sqlite', server: 'werkzeug (flask run)', probe: '/', target: ['GET', '/', 'login_form'],
    commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--port', String(port)] },
  { name: 'flask-sqlite', server: 'gunicorn (2 workers sync)', probe: '/', target: ['GET', '/', 'login_form'],
    commandArgs: port => ['-m', 'gunicorn', '-w', '2', '-b', `127.0.0.1:${port}`, 'app:app'] },
  { name: 'flask-sqlite', server: 'waitress', probe: '/', target: ['GET', '/', 'login_form'],
    commandArgs: port => ['-m', 'waitress', `--listen=127.0.0.1:${port}`, 'app:app'] },
  { name: 'fastapi-sync', server: 'uvicorn', probe: '/docs', target: ['GET', '/report', 'build_report'],
    commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)] },
  { name: 'fastapi-sync', server: 'gunicorn + uvicorn-worker (2 workers)', probe: '/docs', target: ['GET', '/report', 'build_report'],
    commandArgs: port => ['-m', 'gunicorn', '-k', 'uvicorn_worker.UvicornWorker', '-w', '2', '-b', `127.0.0.1:${port}`, 'main:app'] },
];

async function servers() {
  const results = {};
  for (const item of SERVERS) {
    console.log(`-- ${item.name} em ${item.server}`);
    const project = fixture(item.name);
    const python = prepareEnvironment(project);
    const before = gitStatus(project);
    const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
    const app = await startApp({ project, command: python, run: `py-${item.name}-${item.server.split(' ')[0]}-${stamp}`, probe: item.probe, commandArgs: item.commandArgs,
      env: { APP_DATABASE: join(database, 'app.sqlite'), APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}` } });
    try {
      const [method, path] = item.target;
      for (let index = 0; index < 4; index++) await app.request(method, path);
    } finally {
      await app.stop();
      rmSync(database, { recursive: true, force: true });
    }
    const events = app.events();
    requestChecks(app, events);
    await panelChecks(app, [item.target]);
    afterStop(app, project, before);
    results[item.server] = { run: app.recording, requests: app.answered.length, processes: new Set(events.map(event => event.process)).size };
  }
  return results;
}

// ---------------------------------------------------------------- websocket and lifespan
// The same exchanges with and without the capture must give the same answers.
async function websocketLifespan() {
  const project = fixture('fastapi-sync');
  const python = prepareEnvironment(project);
  const exchange = async capture => {
    const app = await startApp({ project, command: python, run: `py-websocket-${capture ? 'com' : 'sem'}-${stamp}`, probe: '/docs', capture,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)] });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      const reply = await new Promise((resolve, reject) => {
        socket.onopen = () => socket.send('olá');
        socket.onmessage = message => resolve(message.data);
        socket.onerror = reject;
        setTimeout(() => reject(new Error('sem resposta do websocket')), 5000);
      });
      socket.close();
      await sleep(200);
      return { app, reply };
    } finally {
      await app.stop();
    }
  };
  const without = await exchange(false);
  const withCapture = await exchange(true);
  check('websocket: a mesma resposta com e sem captura', without.reply === 'eco: olá' && withCapture.reply === without.reply, `${without.reply} / ${withCapture.reply}`);
  const events = withCapture.app.events();
  const reply = events.find(event => event.function === 'reply');
  check('websocket: não é um pedido HTTP, e as funções correm', !events.some(event => event.type === 'request' && event.path === '/ws') && reply,
    `${events.filter(event => event.type === 'request').length} pedidos HTTP (a sonda /docs)`);

  const asyncProject = fixture('fastapi-async');
  const asyncPython = prepareEnvironment(asyncProject);
  const lifespan = async capture => {
    const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
    const app = await startApp({ project: asyncProject, command: asyncPython, run: `py-lifespan-${capture ? 'com' : 'sem'}-${stamp}`, probe: '/docs', capture,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)],
      env: { APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}`, EXTERNAL_API_URL: 'http://127.0.0.1:9' } });
    try {
      return [await app.request('POST', '/notes', { json: { title: 'x' } }), await app.request('GET', '/notes')];
    } finally {
      await app.stop();
      rmSync(database, { recursive: true, force: true });
    }
  };
  const plain = await lifespan(false);
  const captured = await lifespan(true);
  check('lifespan: a app cria as tabelas no arranque e responde igual com e sem captura', JSON.stringify(plain) === JSON.stringify(captured) && plain[0] === 201, `${plain} / ${captured}`);
  return { reply: withCapture.reply };
}

const scenarios = {
  'bases-de-dados': databases,
  rede: network,
  servidores: servers,
  'websocket-lifespan': websocketLifespan,
  'flask-sqlite': flaskSqlite,
  'fastapi-async': fastapiAsync,
  'fastapi-sync': fastapiSync,
  'flask-sqlite --reload': () => reloadScenario({ name: 'flask-sqlite', executable: python => python, request: '/', edit: 'app.py', target: 'login_form', supervisor: 'werkzeug',
    commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--debug', '--port', String(port)] }),
  'fastapi-sync --reload': () => reloadScenario({ name: 'fastapi-sync', executable: python => join(python, '..', 'fastapi'), request: '/report?size=2', edit: 'services/report.py', target: 'build_report', supervisor: 'uvicorn',
    commandArgs: port => ['dev', 'main.py', '--port', String(port)] }),
};

async function main() {
  const selected = (names.length ? names : ['flask-sqlite', 'fastapi-async', 'fastapi-sync', 'bases-de-dados', 'rede', 'servidores', 'websocket-lifespan'])
    .flatMap(name => reload && scenarios[`${name} --reload`] ? [name, `${name} --reload`] : [name]);
  const results = {};
  for (const name of selected) {
    if (!scenarios[name]) throw new Error(`cenário desconhecido: ${name}`);
    prefix = name;
    console.log(`\n== ${name}`);
    results[name] = await scenarios[name]();
  }
  const file = join(dataDirectory(), `accept-python-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ results, checks }, null, 2));
  const failed = checks.filter(item => !item.ok);
  console.log(`\n${checks.length - failed.length} de ${checks.length} verificações. Relatório: ${file}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
