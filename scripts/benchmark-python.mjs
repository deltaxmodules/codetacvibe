#!/usr/bin/env node
// Cost of the Python captor (stage 5), with the protocol of Phase 0:
// 1. structural cost per call: a trivial function of the project called 10⁶
//    times (fixtures/python/performance/probe.py), and its parts (components.py);
// 2. examples 1–3 and the CPU route (example 5): three alternating pairs
//    without and with capture, 10 warm-up requests and 40 measured ones per
//    run; median and p95 over all the samples of each mode, with the number
//    of modules and functions instrumented;
// 3. isolation under concurrent load: every request must have the same tree
//    of functions as the same request made alone.
//   node scripts/benchmark-python.mjs [estrutural] [pedidos] [isolamento]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dataDirectory } from '../src/home.mjs';
import { fixture, prepareEnvironment, root, sleep, startApp } from './lib/python-apps.mjs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const parts = process.argv.slice(2);
const wanted = part => !parts.length || parts.includes(part);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const report = { date: new Date().toISOString(), python: null, protocol: { rounds: 3, warmup: 10, measured: 40 } };
let failed = false;

// ---------------------------------------------------------------- 1. structural
function structural() {
  const project = fixture('performance');
  const python = 'python3.12';
  const home = mkdtempSync(join(tmpdir(), 'ctpy-custo'));
  const run = (capture, extra = []) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODETAC_') && key !== 'PYTHONPATH')),
      ...(capture ? { PYTHONPATH: join(root, 'src/python/codetac_py'), CODETAC_RUN: 'estrutural', CODETAC_ROOT: project, CODETAC_HOME: home } : {}) };
    const result = spawnSync(python, [...extra, 'probe.py', '1000000'], { cwd: project, env, encoding: 'utf8', timeout: 120000 });
    rmSync(join(home, 'estrutural'), { recursive: true, force: true });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).nsPerCall;
  };
  const samples = { without: [], with: [], hotPath: [] };
  for (let round = 0; round < 3; round++) {
    for (const capture of round % 2 ? [true, false] : [false, true]) samples[capture ? 'with' : 'without'].push(run(capture));
    // The request's own path: the writer's batch (JSON lines, disk) postponed.
    samples.hotPath.push(run(true, ['-c', 'import codetac_py, runpy, sys, time; codetac_py.writer.flush_seconds = 1000; time.sleep(0.05); sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")']));
  }
  rmSync(home, { recursive: true, force: true });
  const median = values => percentile(values, 0.5);
  const components = JSON.parse(spawnSync(python, ['components.py', '300000'], { cwd: project, encoding: 'utf8' }).stdout);
  report.structural = {
    baselineNsPerCall: median(samples.without), capturedNsPerCall: median(samples.with), hotPathNsPerCall: median(samples.hotPath),
    costNsPerCall: median(samples.with) - median(samples.without), hotPathCostNsPerCall: median(samples.hotPath) - median(samples.without),
    components, samples,
  };
  const s = report.structural;
  console.log(`Mínimo estrutural por chamada: ${s.costNsPerCall.toFixed(0)} ns no total (${s.hotPathCostNsPerCall.toFixed(0)} ns no caminho do pedido; a função sozinha: ${s.baselineNsPerCall.toFixed(0)} ns)`);
  console.log(`  componentes (ns por chamada, acumulado): ${JSON.stringify(components)}`);
}

// ---------------------------------------------------------------- 2. requests
// Each case: the server command, what to prepare, and the request measured.
function cases() {
  return [
    { name: 'Exemplo 1: Flask + sqlite3 (GET /items, com sessão)', fixture: 'flask-sqlite', example: true,
      commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--port', String(port)], probe: '/',
      prepare: async app => {
        await app.request('POST', '/login', { form: { username: 'ana', password: 'palavra-passe-de-ensaio' } });
        for (let index = 0; index < 5; index++) await app.request('POST', '/items', { form: { title: `item ${index}` } });
      },
      request: ['GET', '/items'] },
    { name: 'Exemplo 2: FastAPI async + SQLAlchemy (GET /notes)', fixture: 'fastapi-async', example: true,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs',
      prepare: async app => { for (let index = 0; index < 5; index++) await app.request('POST', '/notes', { json: { title: `nota ${index}` } }); },
      request: ['GET', '/notes'] },
    { name: 'Exemplo 3: endpoint def na threadpool (GET /report?size=20)', fixture: 'fastapi-sync', example: true,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs', request: ['GET', '/report?size=20'] },
    { name: 'Exemplo 3: asyncio.gather (GET /dashboard)', fixture: 'fastapi-sync', example: true,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs', request: ['GET', '/dashboard'] },
    { name: 'Exemplo 5: rota de CPU (GET /cpu?count=500: ~1.000 chamadas e 500 retomas de um gerador)', fixture: 'fastapi-sync', example: false,
      commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs', request: ['GET', '/cpu?count=500'] },
  ];
}

// Projects of the open-source sample (Stage 13): `node scripts/benchmark-python.mjs amostra`,
// after scripts/accept-amostra-python.mjs (it creates their .venv). Not in the default run.
function sampleCases() {
  const folder = name => join(root, '.codetac/projetos/python', name);
  return [
    { name: 'Amostra: readathon (Claude Code; Flask + Jinja + SQLite, GET /school)', folder: folder('stevensouza_readathon'), example: false,
      commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--port', String(port)], probe: '/', request: ['GET', '/school'] },
    { name: 'Amostra: genius (Replit Agent; Flask + SQLite, GET /)', folder: folder('yonahanoch_genius---platform/backend'), example: false,
      commandArgs: port => ['-m', 'flask', '--app', 'main', 'run', '--port', String(port)], probe: '/', request: ['GET', '/'] },
  ];
}

async function measureRun(definition, capture, round) {
  const project = definition.folder ?? fixture(definition.fixture);
  const python = definition.folder ? join(project, '.venv/bin/python') : prepareEnvironment(project);
  if (!existsSync(python)) throw new Error(`${project} não tem .venv: corra primeiro node scripts/accept-amostra-python.mjs`);
  const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
  const app = await startApp({ project, command: python, commandArgs: definition.commandArgs, probe: definition.probe, capture,
    run: `py-custo-${definition.fixture ?? basename(project)}-${stamp}-${round}-${capture ? 'com' : 'sem'}`,
    env: { APP_DATABASE: join(database, 'app.sqlite'), APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}` } });
  const samples = [];
  try {
    if (definition.prepare) await definition.prepare(app);
    const [method, path] = definition.request;
    for (let index = 0; index < 10; index++) await app.request(method, path);
    for (let index = 0; index < 40; index++) {
      const started = performance.now();
      const status = await app.request(method, path);
      samples.push(performance.now() - started);
      if (status !== 200) throw new Error(`${path} respondeu ${status}`);
    }
  } finally {
    await app.stop();
    rmSync(database, { recursive: true, force: true });
  }
  let coverage = null;
  if (capture) {
    const events = app.events();
    const requests = events.filter(event => event.type === 'request' && event.path === definition.request[1].split('?')[0]);
    const measured = new Set(requests.slice(-40).map(event => event.requestId));
    const enters = events.filter(event => event.type === 'enter');
    coverage = {
      modules: events.filter(event => event.type === 'module').length,
      functions: new Set(enters.map(event => `${event.file}:${event.line}:${event.function}`)).size,
      callsPerRequest: enters.filter(event => measured.has(event.requestId)).length / Math.max(1, measured.size),
    };
    report.python ??= events.find(event => event.type === 'capture-start')?.python;
    rmSync(app.recording, { recursive: true, force: true });
  }
  return { capture, round, samples, coverage };
}

async function requests(definitions = cases(), key = 'requests') {
  report[key] = [];
  for (const definition of definitions) {
    const runs = [];
    for (let round = 0; round < 3; round++) {
      for (const capture of round % 2 ? [true, false] : [false, true]) runs.push(await measureRun(definition, capture, round));
    }
    const baseline = runs.filter(run => !run.capture).flatMap(run => run.samples);
    const captured = runs.filter(run => run.capture).flatMap(run => run.samples);
    const coverage = runs.find(run => run.coverage)?.coverage;
    const result = {
      name: definition.name, example: definition.example,
      baseline: { medianMs: percentile(baseline, 0.5), p95Ms: percentile(baseline, 0.95) },
      captured: { medianMs: percentile(captured, 0.5), p95Ms: percentile(captured, 0.95) },
      medianRatio: percentile(captured, 0.5) / percentile(baseline, 0.5),
      p95Ratio: percentile(captured, 0.95) / percentile(baseline, 0.95),
      coverage, runs: runs.map(({ capture, round, samples }) => ({ capture, round, samples })),
    };
    result.passed = !definition.example || result.p95Ratio <= 2;
    if (!result.passed) failed = true;
    report[key].push(result);
    console.log(`${result.passed ? '✓' : '✗'} ${definition.name}: mediana ${result.baseline.medianMs.toFixed(2)} → ${result.captured.medianMs.toFixed(2)} ms (${result.medianRatio.toFixed(2)}×); `
      + `p95 ${result.baseline.p95Ms.toFixed(2)} → ${result.captured.p95Ms.toFixed(2)} ms (${result.p95Ratio.toFixed(2)}×); `
      + `${coverage.modules} módulos, ${coverage.functions} funções, ${coverage.callsPerRequest.toFixed(0)} chamadas por pedido`);
  }
}

// ---------------------------------------------------------------- 3. isolation
// The shape of a request: its functions as a tree of names, children sorted
// (concurrent children may start in another order).
function shapes(events) {
  const enters = events.filter(event => event.type === 'enter' && event.requestId);
  const children = new Map();
  for (const event of enters) {
    const key = `${event.requestId}|${event.parentId}`;
    children.set(key, [...(children.get(key) ?? []), event]);
  }
  const shape = (requestId, id) => (children.get(`${requestId}|${id}`) ?? [])
    .map(event => `${event.function}(${shape(requestId, event.id)})`).sort().join(',');
  const byRequest = new Map();
  for (const event of events.filter(item => item.type === 'request')) {
    const roots = enters.filter(item => item.requestId === event.requestId && !enters.some(parent => parent.id === item.parentId));
    byRequest.set(event.requestId, { path: event.path, shape: roots.map(item => `${item.function}(${shape(event.requestId, item.id)})`).sort().join(',') });
  }
  return byRequest;
}

async function isolation() {
  report.isolation = [];
  const external = createHttpServer((request, response) => setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{"city":"Lisboa","max":20.4}'); }, 15));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const definitions = [
    { fixture: 'flask-sqlite', commandArgs: port => ['-m', 'flask', '--app', 'app', 'run', '--port', String(port)], probe: '/',
      prepare: async app => { await app.request('POST', '/login', { form: { username: 'ana', password: 'palavra-passe-de-ensaio' } }); await app.request('POST', '/items', { form: { title: 'x' } }); },
      paths: ['/items', '/', '/items?page=2'] },
    { fixture: 'fastapi-async', commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs',
      prepare: async app => { await app.request('POST', '/notes', { json: { title: 'x' } }); }, paths: ['/notes', '/forecast/Lisboa'] },
    { fixture: 'fastapi-sync', commandArgs: port => ['-m', 'uvicorn', 'main:app', '--port', String(port)], probe: '/docs',
      paths: ['/dashboard', '/report?size=3', '/cpu?count=20'] },
  ];
  for (const definition of definitions) {
    const project = fixture(definition.fixture);
    const python = prepareEnvironment(project);
    const database = mkdtempSync(join(tmpdir(), 'ctpy-db'));
    const app = await startApp({ project, command: python, commandArgs: definition.commandArgs, probe: definition.probe, run: `py-isolamento-${definition.fixture}-${stamp}`,
      env: { APP_DATABASE: join(database, 'app.sqlite'), APP_DATABASE_URL: `sqlite+aiosqlite:///${join(database, 'notes.sqlite')}`, EXTERNAL_API_URL: `http://127.0.0.1:${external.address().port}` } });
    const alone = new Set();
    try {
      if (definition.prepare) await definition.prepare(app);
      for (const path of definition.paths) await app.request('GET', path);
      await sleep(200);
      for (const request of shapes(app.events()).keys()) alone.add(request);
      // 60 requests, 20 at a time, of all the routes mixed.
      for (let batch = 0; batch < 3; batch++) {
        await Promise.all(Array.from({ length: 20 }, (_, index) => app.request('GET', definition.paths[(index + batch) % definition.paths.length])));
      }
      await sleep(200);
    } finally {
      await app.stop();
      rmSync(database, { recursive: true, force: true });
    }
    const all = shapes(app.events());
    const reference = new Map();
    for (const [id, item] of all) if (alone.has(id) && definition.paths.some(path => path.split('?')[0] === item.path)) reference.set(item.path, item.shape);
    let checked = 0;
    const errors = [];
    for (const [id, item] of all) {
      if (alone.has(id) || !reference.has(item.path)) continue;
      checked++;
      if (item.shape !== reference.get(item.path)) errors.push({ path: item.path, expected: reference.get(item.path), found: item.shape });
    }
    const passed = checked === 60 && errors.length === 0;
    if (!passed) failed = true;
    report.isolation.push({ fixture: definition.fixture, concurrentRequests: checked, errors });
    console.log(`${passed ? '✓' : '✗'} isolamento ${definition.fixture}: ${checked} pedidos em simultâneo (20 de cada vez), ${errors.length} com filhos diferentes do pedido feito sozinho`);
    rmSync(app.recording, { recursive: true, force: true });
  }
  external.close();
}

async function main() {
  if (wanted('estrutural')) structural();
  if (wanted('pedidos')) await requests();
  if (wanted('isolamento')) await isolation();
  if (parts.includes('amostra')) await requests(sampleCases(), 'sample');
  const file = join(dataDirectory(), `python-custo-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Relatório: ${file}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
