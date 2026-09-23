import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { transform } from '../src/transform.mjs';
import { createRedactor } from '../src/redact.mjs';

function execute(source, extension = 'mjs', extra = {}, files = {}) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const entry = join(dir, `entry.${extension}`);
  writeFileSync(entry, source);
  const result = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), entry], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label, ...extra },
  });
  const baseline = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(result.status, baseline.status, result.stderr);
  assert.equal(result.stdout, baseline.stdout);
  const events = readdirSync(resolve('.codetac', label)).flatMap(file => readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').map(JSON.parse));
  return { events, result };
}

test('ESM: ordem, origem, concorrência e parentesco após await', () => {
  const { events } = execute(`import { setTimeout as delay } from 'node:timers/promises';
function leaf(value) { return value * 2; }
async function branch(value) { await delay(value === 1 ? 15 : 1); return leaf(value); }
async function main() { const values = await Promise.all([branch(1), branch(2)]); console.log(JSON.stringify(values)); }
await main();`);
  const entries = events.filter(e => e.type === 'enter');
  assert.deepEqual(entries.map(e => e.function), ['main', 'branch', 'branch', 'leaf', 'leaf']);
  assert.equal(entries[3].parentId, entries[2].id);
  assert.equal(entries[4].parentId, entries[1].id);
  assert.equal(entries[1].parentId, entries[0].id);
  assert.deepEqual(entries.map(e => e.line), [4, 3, 3, 2, 2]);
  assert.equal(events.filter(e => e.type === 'exit').length, entries.length);
  assert.ok(events.every((e, i) => e.sequence === i + 1));
});

test('CommonJS: this, arguments, recursão, classes, arrows e identidade de retorno síncrono', () => {
  const { events } = execute(`'use strict';
function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }
const object = { x: 7, read() { return this.x + arguments[0]; } };
const twice = x => x * 2;
const nested = x => y => x + y;
class A { method() { return 2; } }
class B extends A { method() { return super.method() + 1; } }
const promise = Promise.resolve(1);
function same() { return promise; }
console.log(JSON.stringify([factorial(4), object.read(2), twice(5), nested(2)(3), new B().method(), same() === promise]));`, 'cjs');
  assert.ok(events.some(e => e.function === 'factorial'));
  assert.ok(!events.some(e => e.type === 'limitation'));
});

test('erros síncronos/assíncronos preservados sem gravar mensagem nem valores', () => {
  const { events } = execute(`function fail() { throw new Error('secret-value-123'); }
async function reject() { throw new Error('secret-value-123'); }
try { fail(); } catch (e) { console.log(e.message); }
try { await reject(); } catch (e) { console.log(e.message); }`);
  assert.equal(events.filter(e => e.type === 'exit' && e.error).length, 2);
  assert.ok(!JSON.stringify(events).includes('secret-value-123'));
});

test('callbacks de temporizador mantêm o pai e pedidos concorrentes não se confundem', () => {
  const { events } = execute(`function root() { setTimeout(function callback() { leaf(); }, 1); }
function leaf() { console.log('ok'); }
root();`);
  const entries = events.filter(e => e.type === 'enter');
  assert.deepEqual(entries.map(e => e.function), ['root', 'callback', 'leaf']);
  assert.equal(entries[1].parentId, entries[0].id);
  assert.equal(entries[2].parentId, entries[1].id);
});

test('limitações de generators e construtores são explícitas', () => {
  const { events } = execute(`function* numbers() { yield 1; }
class Thing { constructor() { this.x = 3; } }
console.log([...numbers()][0] + new Thing().x);`);
  assert.ok(events.some(e => e.reason === 'generator-skipped'));
  assert.ok(events.some(e => e.reason === 'constructor-skipped'));
});

test('source map inline traduz nome, ficheiro e linha originais', () => {
  const map = Buffer.from(JSON.stringify({ version: 3, sources: ['original.ts'], names: ['originalName'], mappings: 'AASEA', sourcesContent: [''] })).toString('base64');
  const { events } = execute(`function minified() { return 1; }\nconsole.log(minified());\n//# sourceMappingURL=data:application/json;base64,${map}`, 'mjs', {}, { 'original.ts': '' });
  const entry = events.find(e => e.type === 'enter');
  assert.equal(entry.line, 10);
  assert.equal(entry.column, 3);
  assert.equal(entry.function, 'originalName');
  assert.match(entry.file, /original\.ts$/);
  assert.equal(entry.mapped, true);
});

test('TypeScript nativo é instrumentado com posições do original', () => {
  const { events } = execute(`function double(value: number): number { return value * 2; }\nconsole.log(double(3));`, 'mts');
  const entry = events.find(e => e.function === 'double');
  assert.equal(entry.line, 1);
  assert.equal(entry.column, 1);
});

test('diretivas strict mantidas', () => {
  execute(`function strict() { 'use strict'; return this === undefined; }\nconsole.log(strict());`, 'cjs');
});

test('redação: campos, ambiente, texto, email, telefone e limite em bytes', () => {
  const redact = createRedactor({ API_KEY: 'custom-value-123' }, 80);
  const value = redact({ nested: { AUTHORIZATION: 'a', api_key: 'b', privateKey: 'c', SessionId: 'd' },
    text: 'Bearer abc123 custom-value-123 sk-proj-abcdefghijk', email: 'jorge@example.com', phone: '+41 79 123 45 67',
    long: 'á'.repeat(100), free: 'password=hello secret:world' });
  assert.deepEqual(Object.values(value.nested), Array(4).fill('[REDACTED]'));
  assert.ok(!value.text.includes('abc123'));
  assert.ok(!value.text.includes('custom-value-123'));
  assert.equal(value.email, 'j***@e***');
  assert.ok(!value.phone.includes('123'));
  assert.ok(value.long.endsWith('[TRUNCATED]'));
  assert.ok(Buffer.byteLength(value.long) <= 91);
  assert.ok(!value.free.includes('hello'));
});

test('sintaxe inválida não é aceite silenciosamente pelo transformador', () => {
  assert.throws(() => transform('function {', '/tmp/invalid.mjs'));
});


test('arrows com expressões entre parênteses, objetos e encadeamento preservam sintaxe', () => {
  execute(`const object = x => ({ value: x });
const nested = x => (y => ({ value: x + y }));
const expression = x => (x * 2);
console.log(JSON.stringify([object(2), nested(2)(3), expression(3)]));`);
});

function fakeProject() {
  const project = resolve('.codetac', `test-${randomUUID()}-project`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'app.ts'), '');
  return project;
}

test('código sem mapa em pastas escondidas (.next) é cola do bundle, não do projeto', () => {
  const project = fakeProject();
  const map = { version: 3, sources: [pathToFileURL(join(project, 'app.ts')).href], names: [], mappings: 'AAAA' };
  const inline = `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
  assert.equal(transform('function __webpack_exec__() {}', join(project, '.next/server/route.js'), 'commonjs', project).count, 0);
  assert.equal(transform(`function handler() {}${inline}`, join(project, '.next/server/route.js'), 'commonjs', project).count, 1);
  assert.equal(transform('function handler() {}', join(project, 'server.js'), 'commonjs', project).count, 1);
});

test('mapas em secções excluem dependências e conservam a origem da aplicação', () => {
  const project = fakeProject();
  const map = { version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sources: [pathToFileURL(join(project, 'app.ts')).href], names: [], mappings: 'AAEA' } },
    { offset: { line: 1, column: 0 }, map: { version: 3, sources: [pathToFileURL(join(project, 'node_modules/lib/index.js')).href], names: [], mappings: 'AAAA' } },
  ] };
  const source = 'function own() { return 1; }\nfunction library() { return 2; }\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64');
  const result = transform(source, join(project, 'build.js'), 'module', project);
  assert.equal(result.count, 1);
  assert.ok(result.source.includes(`"file":${JSON.stringify(join(project, 'app.ts'))},"line":3`));
});


test('redeclarar um parâmetro com var não altera o resultado observado', () => {
  const { events } = execute(`function example(value) { var value; return value; }\nconsole.log(example(42));`, 'cjs');
  assert.ok(events.some(e => e.reason === 'parameter-redeclaration-skipped'));
});

test('source map ilegível conserva o módulo e declara a limitação', () => {
  const source = 'function untouched() {}\n//# sourceMappingURL=missing.map';
  const result = transform(source, '/missing/app.js');
  assert.equal(result.source, source);
  assert.equal(result.count, 0);
  assert.equal(result.diagnostics[0].reason, 'source-map-unreadable');
});

function spawnCaptured(source, extra = {}) {
  const label = `test-${randomUUID()}`;
  const dir = resolve('.codetac', `${label}-input`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, source);
  const child = spawn(process.execPath, ['--import', resolve('src/register.mjs'), entry], {
    env: { ...process.env, CODETAC_ROOT: dir, CODETAC_RUN: label, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const read = () => readdirSync(resolve('.codetac', label)).flatMap(file => readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return { child, read };
}
const ready = child => new Promise(ok => child.stdout.once('data', ok));
const exited = child => new Promise(ok => child.once('exit', (code, signal) => ok({ code, signal })));

test('lotes: SIGTERM sem handler da aplicação grava eventos e termina pelo sinal', async () => {
  const { child, read } = spawnCaptured(`function tick() { return 1; }
for (let i = 0; i < 50; i++) tick();
setInterval(() => {}, 1000);
console.log('ready');`, {});
  await ready(child);
  child.kill('SIGTERM');
  assert.deepEqual(await exited(child), { code: null, signal: 'SIGTERM' });
  assert.equal(read().filter(e => e.type === 'enter' && e.function === 'tick').length, 50);
});

test('lotes: handler de SIGTERM da aplicação continua a decidir', async () => {
  const { child, read } = spawnCaptured(`function tick() { return 1; }
tick();
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', function stop() { clearInterval(timer); console.log('app-handled'); });
console.log('ready');`);
  let output = '';
  child.stdout.on('data', data => { output += data; });
  await ready(child);
  child.kill('SIGTERM');
  assert.deepEqual(await exited(child), { code: 0, signal: null });
  assert.match(output, /app-handled/);
  assert.ok(read().some(e => e.function === 'stop'));
});

// Loaders such as tsx exit on a signal only when their handler is the only one.
test('lotes: handler que só termina quando é o único continua a terminar', async () => {
  const { child, read } = spawnCaptured(`function tick() { return 1; }
tick();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { if (process.listenerCount('SIGTERM') === 1) process.exit(143); });
console.log('ready');`);
  await ready(child);
  child.kill('SIGTERM');
  assert.deepEqual(await exited(child), { code: 143, signal: null });
  assert.ok(read().some(e => e.function === 'tick'));
});

test('lotes: process.exit e exceção não apanhada gravam os eventos pendentes', async () => {
  for (const ending of ['process.exit(3);', "throw new Error('boom');"]) {
    const { child, read } = spawnCaptured(`function last() { return 1; }\nlast();\n${ending}`);
    const { code } = await exited(child);
    assert.notEqual(code, 0);
    const events = read();
    assert.ok(events.some(e => e.type === 'enter' && e.function === 'last'));
    assert.ok(events.every((e, i) => e.sequence === i + 1));
  }
});

test('limitações em código de dependências dentro de um bundle não são reportadas como do projeto', () => {
  const project = fakeProject();
  const map = { version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sources: [pathToFileURL(join(project, 'app.ts')).href], names: [], mappings: 'AAEA' } },
    { offset: { line: 1, column: 0 }, map: { version: 3, sources: [pathToFileURL(join(project, 'node_modules/lib/index.js')).href], names: [], mappings: 'AAAA' } },
  ] };
  const source = 'function* own() { yield 1; }\nfunction* library() { yield 2; }\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64');
  const result = transform(source, join(project, 'build.js'), 'module', project);
  assert.deepEqual(result.diagnostics, [{ reason: 'generator-skipped', file: join(project, 'app.ts'), line: 3 }]);
});

test('código em eval com source map inline é instrumentado; o de dependências não', () => {
  const project = fakeProject();
  writeFileSync(join(project, 'service.ts'), '');
  const inlineMap = source => '\n//# sourceMappingURL=data:application/json;base64,'
    + Buffer.from(JSON.stringify({ version: 3, sources: [source], names: [], mappings: 'AAAA' })).toString('base64');
  const own = `function service() { return 21; }${inlineMap(join(project, 'service.ts'))}`;
  const library = `function helper() { return 2; }${inlineMap(join(project, 'node_modules/lib/helper.js'))}`;
  const source = `const modules = {
  a: function (exports) { eval(${JSON.stringify(own)}); exports.service = service; },
  b: function (exports) { eval(${JSON.stringify(library)}); exports.helper = helper; },
};
const a = {}; const b = {};
modules.a(a); modules.b(b);
console.log(a.service() * b.helper());`;
  const result = transform(source, join(project, 'bundle.js'), 'commonjs', project);
  assert.equal(result.count, 1);
  // Invólucros cujo eval é código mapeado já tratado não são lacunas do projeto.
  assert.deepEqual(result.diagnostics, []);
  const label = `test-${randomUUID()}`;
  writeFileSync(join(project, 'bundle.cjs'), source);
  const run = spawnSync(process.execPath, ['--import', resolve('src/register.mjs'), join(project, 'bundle.cjs')], {
    encoding: 'utf8', env: { ...process.env, CODETAC_ROOT: project, CODETAC_RUN: label } });
  assert.equal(run.stdout.trim(), '42', run.stderr);
  const captured = readdirSync(resolve('.codetac', label)).flatMap(file => readFileSync(resolve('.codetac', label, file), 'utf8').trim().split('\n').map(JSON.parse));
  const entries = captured.filter(e => e.type === 'enter');
  assert.deepEqual(entries.map(e => [e.function, e.file, e.line]), [['service', join(project, 'service.ts'), 1]]);
});

test('redação: valores curtos de variáveis sensíveis não apagam texto comum', () => {
  const redact = createRedactor({ CHILD_SESSION: '1', SESSION_FLAG: 'true', API_TOKEN: 'long-secret-value' });
  assert.equal(redact('/tmp/a1b1/true.js long-secret-value'), '/tmp/a1b1/true.js [REDACTED]');
});

test('módulo recarregado sem alterações reutiliza a transformação e continua capturado', () => {
  const { events } = execute(`const path = require.resolve('./dep.cjs');
const first = require(path).work();
delete require.cache[path];
console.log(first + require(path).work());`, 'cjs', {}, { 'dep.cjs': 'exports.work = function work() { return 21; };' });
  const loads = events.filter(e => e.type === 'module' && e.file.endsWith('dep.cjs'));
  assert.deepEqual(loads.map(e => Boolean(e.cached)), [false, true]);
  assert.equal(events.filter(e => e.type === 'enter' && e.function === 'work').length, 2);
});

test('CommonJS compilado por outro loader (Module._extensions) é instrumentado uma vez', () => {
  const { events } = execute(`const Module = require('node:module');
const fs = require('node:fs');
// Simula um loader como o tsx: lê e compila o ficheiro sem passar pelos hooks.
Module._extensions['.custom'] = (module, filename) => module._compile(fs.readFileSync(filename, 'utf8'), filename);
console.log(require('./dep.custom').work());`, 'cjs', {}, { 'dep.custom': 'exports.work = function work() { return 42; };' });
  const entries = events.filter(e => e.type === 'enter' && e.function === 'work');
  assert.equal(entries.length, 1);
  assert.match(entries[0].file, /dep\.custom$/);
});
