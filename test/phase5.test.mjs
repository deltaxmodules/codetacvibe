import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { detectProject, portOf, foreignRuntime } from '../src/detect.mjs';
import { summarize } from '../src/recording.mjs';

function folder(files) {
  const dir = join(tmpdir(), `codetac-detect-${randomUUID()}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('deteção: script dev, gestor de pacotes, stack e porta', () => {
  const dir = folder({ 'package.json': { scripts: { dev: 'next dev -p 3005', start: 'next start' }, dependencies: { next: '16' } }, 'pnpm-lock.yaml': '' });
  const project = detectProject(dir);
  assert.deepEqual(project.missing, []);
  assert.equal(project.start.length, 1);
  assert.deepEqual(project.start[0].command, ['pnpm', 'run', 'dev']);
  assert.equal(project.start[0].stack, 'Next.js');
  assert.deepEqual(project.start[0].port, { value: 3005, source: 'script' });
  assert.equal(project.start[0].installed, false);
  rmSync(dir, { recursive: true });
});

test('deteção: sem dev, os scripts dev:* arrancam juntos; sem package.json, o ficheiro do servidor', () => {
  const both = folder({ 'package.json': { scripts: { 'dev:server': 'cd server && npm run dev', 'dev:client': 'cd client && npm run dev', 'dev:db': 'x', start: 'node server' } } });
  assert.deepEqual(detectProject(both).start.map(part => part.script.name), ['dev:server', 'dev:client']);
  const plain = folder({ 'server.js': 'require("http").createServer().listen(process.env.PORT || 7000)' });
  const project = detectProject(plain);
  assert.deepEqual(project.start[0].command, ['node', 'server.js']);
  assert.equal(project.start[0].port.value, 7000);
  const empty = folder({ 'README.md': '' });
  assert.deepEqual(detectProject(empty).missing, ['package']);
  const noScript = folder({ 'package.json': { scripts: { build: 'tsc' } } });
  assert.deepEqual(detectProject(noScript).missing, ['command']);
  for (const dir of [both, plain, empty, noScript]) rmSync(dir, { recursive: true });
});

test('deteção: várias partes sem script de topo pedem uma escolha; porta do .env e da config do Vite', () => {
  const dir = folder({
    'client/package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '7' } },
    'client/vite.config.ts': 'export default { server: { port: 8080 } }',
    'api/package.json': { scripts: { dev: 'tsx watch src/index.ts' }, dependencies: { express: '5' } },
    'api/.env': 'PORT=4001\n',
  });
  const project = detectProject(dir);
  assert.deepEqual(project.missing, ['part']);
  const ports = Object.fromEntries(project.parts.map(part => [part.part, part.port]));
  assert.deepEqual(ports.client, { value: 8080, source: 'vite.config.ts' });
  assert.deepEqual(ports.api, { value: 4001, source: '.env' });
  assert.equal(portOf(dir, '', null), null);
  rmSync(dir, { recursive: true });
});

test('deteção: runtimes que não são o Node', () => {
  assert.equal(foreignRuntime('bun run server.ts'), 'bun');
  assert.equal(foreignRuntime('deno task dev'), 'deno');
  assert.equal(foreignRuntime('vite --host'), null);
  assert.equal(foreignRuntime('node bundle.js'), null);
});

// Minimal mode: requests and boundaries without the project's functions.
function serve(extra) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'server.mjs');
  writeFileSync(entry, `import http from 'node:http';
import { readFileSync } from 'node:fs';
function handler(request, response) { readFileSync(new URL(import.meta.url)); response.setHeader('content-type', 'text/html'); response.end('<html><head></head><body>ok</body></html>'); }
const server = http.createServer(handler).listen(0, async () => {
  const { port } = server.address();
  await fetch('http://127.0.0.1:' + port + '/pagina', { headers: { accept: 'text/html' } }).then(r => r.text());
  server.close();
});`);
  const result = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), entry], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label, CODETAC_PANEL_PORT: '1', ...extra },
  });
  assert.equal(result.status, 0, result.stderr);
  const events = readdirSync(resolve('.codetac', label)).flatMap(file => readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').map(JSON.parse));
  return { events, folder: resolve('.codetac', label) };
}

test('modo mínimo: pedidos, fronteiras e barra, sem funções do projeto, com o motivo', () => {
  const { events, folder: recording } = serve({ CODETAC_LEVEL: 'minimo', CODETAC_MINIMO_MOTIVO: 'ensaio' });
  const start = events.find(event => event.type === 'capture-start');
  assert.equal(start.level, 'minimo');
  assert.equal(start.reason, 'ensaio');
  assert.ok(!events.some(event => event.type === 'enter'));
  assert.ok(events.some(event => event.type === 'request'));
  assert.ok(events.some(event => event.type === 'boundary' && event.kind === 'ficheiros'));
  assert.ok(events.some(event => event.type === 'listening' && event.port > 0));
  assert.deepEqual(events.filter(event => event.type === 'page').map(event => event.path), ['/pagina']);
  const summary = summarize(recording);
  assert.equal(summary.requests, 1);
  assert.equal(summary.pages, 1);
  assert.equal(summary.files, 0);
});

test('modo normal: a mesma app segue as funções e o resumo conta-as', () => {
  const { events, folder: recording } = serve({});
  assert.equal(events.find(event => event.type === 'capture-start').level, 'normal');
  assert.ok(events.some(event => event.type === 'enter' && event.function === 'handler' && event.requestId));
  const summary = summarize(recording);
  assert.equal(summary.withFunctions.size, 1);
  assert.equal(summary.files, 1);
});

test('comando: sem arranque descoberto e sem terminal, explica como o indicar', async () => {
  const dir = folder({ 'README.md': '' });
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), dir, '--panel-port', '4199'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  const code = await new Promise(done => child.on('exit', done));
  assert.equal(code, 2);
  assert.match(text, /did not find a package.json/);
  assert.match(text, /codetac \. -- node server\.js/);
  assert.doesNotMatch(text, /not supported/i);
  rmSync(dir, { recursive: true });
});

// A function turned into text and evaluated elsewhere (workerpool,
// page.evaluate…) carries the instrumentation with it and fails there. When
// that happens at start-up, the command restarts the application in minimal
// mode, and the recording says why.
test('comando: a app que falha com a instrumentação arranca em modo mínimo, com aviso', async () => {
  const dir = folder({
    'package.json': { name: 'serializa', scripts: { start: 'node server.js' } },
    'server.js': `const http = require('node:http');
const vm = require('node:vm');
function double(value) { return value * 2; }
// Runs the function's own text in a fresh context, as a worker pool would.
if (vm.runInNewContext('(' + double.toString() + ')(21)') !== 42) process.exit(1);
http.createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<html><head></head><body>ok</body></html>'); })
  .listen(process.env.PORT || 0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port); });`,
  });
  mkdirSync(join(dir, 'node_modules'));
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), dir, '--no-open', '--panel-port', '4198'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODETAC_AI_PROVIDER: 'none' } });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const end = Date.now() + 60000;
  while (!/App ready/.test(text) && child.exitCode === null && Date.now() < end) await new Promise(done => setTimeout(done, 200));
  child.kill('SIGINT');
  await new Promise(done => child.on('exit', done));
  assert.match(text, /failed while starting with the full capture/);
  assert.match(text, /✓ App ready at http:\/\/\S+ \(\d+ s\) · minimal mode/);
  const run = text.match(/Recording: (\S+-minimal)/)[1];
  const start = readdirSync(resolve('.codetac', run)).flatMap(file => readFileSync(resolve('.codetac', run, file), 'utf8').trim().split('\n').map(JSON.parse))
    .find(event => event.type === 'capture-start');
  assert.equal(start.level, 'minimo');
  assert.match(start.reason, /failed to start with the full instrumentation/);
  rmSync(dir, { recursive: true });
});

// 0.3.1: a Python app whose own code fails while importing is not retried in
// minimal mode, and the error is named instead of an exit code.
test('arranque falhado: o erro da própria app Python, sem repetir em modo mínimo', async () => {
  const { readTraceback, ownError, describeFailure } = await import('../src/failure.mjs');
  const folder = '/p/backend';
  const read = lines => { const state = {}; for (const line of lines) readTraceback(state, line); return state; };
  const app = read([
    'INFO:     Started reloader process [25946] using WatchFiles',
    'Process SpawnProcess-1:',
    'Traceback (most recent call last):',
    '  File "/opt/homebrew/lib/python3.12/multiprocessing/process.py", line 314, in _bootstrap',
    '  File "/p/backend/.venv/lib/python3.12/site-packages/uvicorn/server.py", line 76, in _serve',
    '  File "/usr/lib/node_modules/codetac/src/python/codetac_py/servers.py", line 431, in codetac_load',
    '    load(self, *args, **kwargs)',
    '  File "/p/backend/app/main.py", line 1838, in <module>',
    "    app.mount(settings.uploads_url_prefix, StaticFiles(directory=settings.uploads_dir), name='uploads')",
    '                                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    '  File "/p/backend/.venv/lib/python3.12/site-packages/starlette/staticfiles.py", line 56, in __init__',
    `RuntimeError: Directory '/var/lib/transcapiart/uploads' does not exist`,
    'INFO:     Stopping reloader process [25946]',
  ]);
  assert.equal(app.traceback.error, `RuntimeError: Directory '/var/lib/transcapiart/uploads' does not exist`);
  assert.deepEqual(ownError(app.traceback, folder), { file: 'app/main.py', line: 1838 });
  assert.equal(describeFailure({ ...app, part: '.' }, false), `RuntimeError: Directory '/var/lib/transcapiart/uploads' does not exist`);
  assert.equal(describeFailure({ ...app, part: 'api' }, true), `[api] RuntimeError: Directory '/var/lib/transcapiart/uploads' does not exist`);
  // Raised inside CodeTAC's captor, below the app's code: the capture's fault, retried.
  const captor = read(['Traceback (most recent call last):', '  File "/p/backend/app/main.py", line 3, in <module>',
    '  File "/x/codetac/src/python/codetac_py/hooks.py", line 25, in exec_module', 'TypeError: boom']);
  assert.equal(ownError(captor.traceback, folder), null);
  // Only libraries: not the app's code.
  const library = read(['Traceback (most recent call last):', '  File "/p/backend/.venv/lib/python3.12/site-packages/uvicorn/main.py", line 4, in main', 'ImportError: x']);
  assert.equal(ownError(library.traceback, folder), null);
  // Chained exceptions: the last one counts. No traceback: the exit code.
  const chained = read(['Traceback (most recent call last):', '  File "/p/backend/a.py", line 1, in <module>', 'KeyError: 1', '',
    'During handling of the above exception, another exception occurred:', '', 'Traceback (most recent call last):', '  File "/p/backend/b.py", line 2, in <module>', 'ValueError: 2']);
  assert.equal(chained.traceback.error, 'ValueError: 2');
  assert.equal(describeFailure({ exitCode: 3, part: '.' }, false), 'exit code 3');
  assert.equal(describeFailure({ crashed: true, part: 'web' }, true), '[web] crashed');
});

test('arranque falhado: traceback do Rich (fastapi dev), com caminhos partidos e com espaços', async () => {
  const { readTraceback, ownError } = await import('../src/failure.mjs');
  const state = {};
  for (const line of [
    '╭───────────────────── Traceback (most recent call last) ──────────────────────╮',
    '│ /p/Projectos 2026/backend/.venv/lib/python3.12/sit │',
    '│ e-packages/fastapi_cli/cli.py:404 in dev                                     │',
    '│ in exec_module:999                                                           │',
    '│ /p/Projectos 2026/backend/app/ma │',
    '│ in.py:48 in <module>   │',
    '│   45 async def forecast(city: str):                                          │',
    '│ /p/Projectos 2026/backend/.venv/lib/python3.12/site-packages/starlette/staticfiles.py:57 in __init__ │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    "RuntimeError: Directory '/var/lib/x/uploads' does not exist",
  ]) readTraceback(state, line);
  assert.deepEqual(state.traceback.frames.map(frame => `${frame.file}:${frame.line}`), [
    '/p/Projectos 2026/backend/.venv/lib/python3.12/site-packages/fastapi_cli/cli.py:404',
    '/p/Projectos 2026/backend/app/main.py:48',
    '/p/Projectos 2026/backend/.venv/lib/python3.12/site-packages/starlette/staticfiles.py:57']);
  assert.equal(state.traceback.error, "RuntimeError: Directory '/var/lib/x/uploads' does not exist");
  assert.deepEqual(ownError(state.traceback, '/p/Projectos 2026/backend'), { file: 'app/main.py', line: 48 });
});
