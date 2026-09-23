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
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), dir, '--painel', '4199'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  const code = await new Promise(done => child.on('exit', done));
  assert.equal(code, 2);
  assert.match(text, /Não encontrei um package.json/);
  assert.match(text, /codetac \. -- node server\.js/);
  assert.doesNotMatch(text, /não suportad/i);
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
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), dir, '--nao-abrir', '--painel', '4198'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODETAC_AI_PROVIDER: 'nenhum' } });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const end = Date.now() + 60000;
  while (!/App pronta/.test(text) && child.exitCode === null && Date.now() < end) await new Promise(done => setTimeout(done, 200));
  child.kill('SIGINT');
  await new Promise(done => child.on('exit', done));
  assert.match(text, /falhou durante o arranque com a captura completa/);
  assert.match(text, /✓ App pronta em http:\/\/\S+ \(\d+ s\) · modo mínimo/);
  const run = text.match(/Gravação: (\S+-minimo)/)[1];
  const start = readdirSync(resolve('.codetac', run)).flatMap(file => readFileSync(resolve('.codetac', run, file), 'utf8').trim().split('\n').map(JSON.parse))
    .find(event => event.type === 'capture-start');
  assert.equal(start.level, 'minimo');
  assert.match(start.reason, /falhou ao arrancar com a instrumentação fina/);
  rmSync(dir, { recursive: true });
});
