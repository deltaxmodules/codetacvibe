// Ensaio de captura num projeto real (Fase 0). Não altera o projeto: arranca o
// servidor diretamente (sem scripts npm "pre*"), compara o estado Git antes e
// depois, e grava tudo em .codetac/. Uso:
//   node scripts/validate-project.mjs <config.json>
// A configuração fica fora do Git (ver docs/real-project-config.example.json).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRedactor } from '../src/redact.mjs';

const workspace = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8'));
const root = resolve(config.root);
const runId = `${config.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const preload = pathToFileURL(join(workspace, 'src/register.mjs')).href;
const redact = createRedactor();
const secrets = { ...process.env, ...(config.secretsFile ? JSON.parse(readFileSync(resolve(config.secretsFile), 'utf8')) : {}) };
const rounds = config.rounds ?? 3;
const samples = config.samplesPerRequest ?? 10;
const groups = new Set();
process.once('exit', () => { for (const pid of groups) { try { process.kill(-pid, 'SIGTERM'); } catch {} } });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));

function projectState() {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  } catch { return null; }
}
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const { port } = server.address();
  await new Promise(ok => server.close(ok));
  return port;
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];

async function measure(variant, capture, round) {
  const port = await freePort();
  const label = `${runId}-${variant.name}-${capture ? 'capture' : 'baseline'}-${round}`;
  const directory = join(workspace, '.codetac', label);
  mkdirSync(directory, { recursive: true });
  const configured = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, String(value).replaceAll('{port}', String(port))]));
  const env = { ...process.env, ...configured, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
    CODETAC_ROOT: root, CODETAC_RUN: label };
  delete env.NODE_OPTIONS;
  if (capture) env.NODE_OPTIONS = `--import=${preload}`;
  const args = variant.args.map(arg => arg.replaceAll('{port}', String(port)).replaceAll('{root}', root));
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) groups.add(child.pid);
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-64000); });
  child.stderr.on('data', data => { output = (output + data).slice(-64000); });
  let cookie = '';
  const call = async request => {
    const headers = { ...(request.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (request.json) headers['content-type'] = 'application/json';
    // Valores "$NOME" vêm do ambiente ou de config.secretsFile (fora do Git),
    // para não guardar credenciais na configuração.
    const body = request.json ? JSON.stringify(request.json, (_key, value) =>
      typeof value === 'string' && /^\$[A-Za-z0-9_]+$/.test(value) ? secrets[value.slice(1)] ?? '' : value) : undefined;
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, { method: request.method ?? 'GET', headers, body,
      redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs ?? 60000) });
    await response.arrayBuffer();
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (request.keepCookies && setCookie.length) cookie = setCookie.map(item => item.split(';')[0]).join('; ');
    if (request.status && response.status !== request.status) throw new Error(`${request.name}: estado ${response.status}, esperado ${request.status}`);
    return response.status;
  };
  try {
    while (true) {
      if (performance.now() - started > 180000) throw new Error('servidor não ficou pronto em 180 s');
      if (child.exitCode !== null) throw new Error(`servidor terminou com código ${child.exitCode}`);
      try { await fetch(`http://127.0.0.1:${port}${config.readyPath ?? '/'}`, { redirect: 'manual', signal: AbortSignal.timeout(60000) }); break; }
      catch { await delay(300); }
    }
    const startupMs = performance.now() - started;
    for (const request of config.setup ?? []) await call(request);
    // As primeiras chamadas compilam a rota em desenvolvimento; não são medidas.
    for (const request of config.requests) for (let i = 0; i < (config.warmup ?? 2); i++) await call(request);
    const results = [];
    for (const request of config.requests) {
      const timings = [];
      const windows = [];
      for (let i = 0; i < samples; i++) {
        const from = process.hrtime.bigint();
        const start = performance.now();
        await call(request);
        timings.push(performance.now() - start);
        windows.push([from, process.hrtime.bigint()]);
      }
      results.push({ name: request.name, samplesMs: timings, medianMs: percentile(timings, .5), p95Ms: percentile(timings, .95), windows });
    }
    // Carga concorrente: rajadas de N pedidos iguais em paralelo.
    const concurrent = [];
    if (config.concurrency) {
      for (const request of config.requests) {
        const burstsMs = [];
        const latenciesMs = [];
        const windows = [];
        for (let burst = 0; burst < (config.bursts ?? 5); burst++) {
          const from = process.hrtime.bigint();
          const start = performance.now();
          await Promise.all(Array.from({ length: config.concurrency }, async () => {
            const begin = performance.now();
            await call(request);
            latenciesMs.push(performance.now() - begin);
          }));
          burstsMs.push(performance.now() - start);
          windows.push([from, process.hrtime.bigint()]);
        }
        concurrent.push({ name: request.name, burstsMs, latenciesMs, windows });
      }
    }
    if (capture) {
      await delay(200);
      const events = readdirSync(directory).filter(file => file.endsWith('.jsonl'))
        .flatMap(file => readFileSync(join(directory, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      const enters = events.filter(event => event.type === 'enter');
      const byId = new Map(enters.map(event => [event.id, event]));
      for (const result of results) {
        // O relógio monotónico é comum aos processos da máquina: os pedidos são
        // sequenciais, por isso a janela de cada pedido isola as suas funções.
        const [from, to] = result.windows.at(-1);
        const inside = enters.filter(event => BigInt(event.timeNs) >= from && BigInt(event.timeNs) <= to);
        result.lastRequest = inside.map(event => ({ function: event.function,
          file: event.file.startsWith(root) ? event.file.slice(root.length + 1) : event.file, line: event.line,
          mapped: event.mapped, parent: byId.get(event.parentId)?.function ?? null, process: event.process }));
      }
      // Isolamento: em cada rajada, cada função tem de ter os mesmos filhos
      // diretos que teve quando o pedido correu sozinho. Contextos misturados
      // dariam filhos a mais num pedido e a menos noutro.
      const key = event => `${event.function}@${event.file}:${event.line}`;
      const signatures = (from, to) => {
        const inside = enters.filter(event => BigInt(event.timeNs) >= from && BigInt(event.timeNs) <= to);
        const children = new Map(inside.map(event => [event.id, []]));
        for (const event of inside) children.get(event.parentId)?.push(key(event));
        return inside.map(event => [key(event), children.get(event.id).sort().join('|')]);
      };
      for (const item of concurrent) {
        const result = results.find(entry => entry.name === item.name);
        const expected = new Map();
        for (const [from, to] of result.windows) for (const [node, signature] of signatures(from, to)) {
          if (!expected.has(node)) expected.set(node, new Set());
          expected.get(node).add(signature);
        }
        let checked = 0;
        const mismatches = [];
        for (const [from, to] of item.windows) for (const [node, signature] of signatures(from, to)) {
          checked++;
          if (!expected.get(node)?.has(signature)) mismatches.push({ node, signature });
        }
        item.isolation = { checked, mismatches: mismatches.length, examples: mismatches.slice(0, 5) };
      }
      const limitations = events.filter(event => event.type === 'limitation');
      const modules = events.filter(event => event.type === 'module');
      for (const result of [...results, ...concurrent]) delete result.windows;
      return { capture, round, label, startupMs, results, concurrent, enters: enters.length,
        modules: modules.length, instrumentedFunctions: modules.reduce((sum, item) => sum + item.functions, 0),
        limitations: Object.entries(Object.groupBy(limitations, item => item.reason)).map(([reason, items]) => ({ reason, count: items.length })) };
    }
    for (const result of [...results, ...concurrent]) delete result.windows;
    return { capture, round, label, startupMs, results, concurrent };
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise(ok => child.once('exit', ok)), delay(3000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      groups.delete(child.pid);
    }
    writeFileSync(join(directory, 'server.log'), redact(output), { mode: 0o600 });
  }
}

const before = projectState();
const report = { date: new Date().toISOString(), node: process.version, project: config.name, kind: 'real-project', rounds, samplesPerRequest: samples, variants: [] };
for (const variant of config.variants) {
  console.log(`${config.name} / ${variant.name}: ${rounds} pares alternados…`);
  try {
    const runs = [];
    for (let round = 1; round <= rounds; round++) {
      for (const capture of round % 2 ? [false, true] : [true, false]) runs.push(await measure(variant, capture, round));
    }
    const requests = config.requests.map(({ name }) => {
      const pick = capture => runs.filter(run => run.capture === capture).flatMap(run => run.results.find(item => item.name === name).samplesMs);
      const base = pick(false);
      const captured = pick(true);
      return { name, baselineMedianMs: percentile(base, .5), captureMedianMs: percentile(captured, .5),
        medianRatio: percentile(captured, .5) / percentile(base, .5), p95Ratio: percentile(captured, .95) / percentile(base, .95) };
    });
    const concurrency = config.concurrency ? config.requests.map(({ name }) => {
      const pick = (capture, field) => runs.filter(run => run.capture === capture).flatMap(run => run.concurrent.find(item => item.name === name)[field]);
      const isolation = runs.filter(run => run.capture).map(run => run.concurrent.find(item => item.name === name).isolation);
      return { name, parallel: config.concurrency,
        burstMedianRatio: percentile(pick(true, 'burstsMs'), .5) / percentile(pick(false, 'burstsMs'), .5),
        latencyMedianRatio: percentile(pick(true, 'latenciesMs'), .5) / percentile(pick(false, 'latenciesMs'), .5),
        latencyP95Ratio: percentile(pick(true, 'latenciesMs'), .95) / percentile(pick(false, 'latenciesMs'), .95),
        baselineBurstMedianMs: percentile(pick(false, 'burstsMs'), .5), captureBurstMedianMs: percentile(pick(true, 'burstsMs'), .5),
        nodesChecked: isolation.reduce((sum, item) => sum + item.checked, 0),
        isolationMismatches: isolation.reduce((sum, item) => sum + item.mismatches, 0),
        examples: isolation.flatMap(item => item.examples).slice(0, 5) };
    }) : [];
    report.variants.push({ name: variant.name, requests, concurrency, runs });
    for (const item of requests) console.log(`  ${item.name}: mediana ${item.medianRatio.toFixed(2)}x, p95 ${item.p95Ratio.toFixed(2)}x`);
    for (const item of concurrency) console.log(`  ${item.name} ×${item.parallel} em paralelo: rajada ${item.burstMedianRatio.toFixed(2)}x, latência p95 ${item.latencyP95Ratio.toFixed(2)}x, isolamento ${item.nodesChecked - item.isolationMismatches}/${item.nodesChecked}`);
  } catch (error) {
    report.variants.push({ name: variant.name, error: String(error) });
    console.error(`  ${variant.name}: ${error}`);
  }
}
const after = projectState();
report.projectUnchanged = before === after;
report.projectStatusBefore = before;
report.projectStatusAfter = after;
const output = join(workspace, '.codetac', `${runId}-report.json`);
writeFileSync(output, JSON.stringify(redact(report), null, 2), { mode: 0o600 });
console.log(`Projeto inalterado (git status): ${report.projectUnchanged}`);
console.log(`Relatório: ${output}`);
if (!report.projectUnchanged || report.variants.some(variant => variant.error)) process.exitCode = 1;
