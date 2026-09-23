import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRedactor } from '../src/redact.mjs';

const workspace = resolve(import.meta.dirname, '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const preload = pathToFileURL(join(workspace, 'src/register.mjs')).href;
const redact = createRedactor();
const activeGroups = new Set();
function cleanup() {
  for (const pid of activeGroups) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
}
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });
const definitions = [
  { name: 'express', args: [join(workspace, 'fixtures/express/server.cjs')],
    expected: [['handler', 'server.cjs', 5], ['service', 'server.cjs', 4], ['calculate', 'server.cjs', 3]] },
  { name: 'vite', args: [join(workspace, 'fixtures/vite/server.mjs')],
    expected: [['handler', 'server.mjs', 6], ['service', 'server.mjs', 5], ['calculate', 'server.mjs', 4]] },
  { name: 'next', args: [join(workspace, 'node_modules/next/dist/bin/next'), 'dev', '--turbopack', '--hostname', '127.0.0.1'],
    expected: [['GET', 'route.js', 2], ['service', 'service.js', 3], ['calculate', 'service.js', 2]] },
];

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  return port;
}
function percentile(values, fraction) { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]; }
async function measure(definition, capture, round) {
  const port = await freePort();
  const label = `stacks-${runId}-${definition.name}-${capture ? 'capture' : 'baseline'}-${round}`;
  const directory = join(workspace, '.codetac', label);
  mkdirSync(directory, { recursive: true });
  const args = [...definition.args];
  if (definition.name === 'next') args.push('--port', String(port));
  const env = { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
    CODETAC_ROOT: join(workspace, 'fixtures', definition.name), CODETAC_RUN: label };
  // Controlled fixture: do not inherit unrelated preload instrumentation.
  delete env.NODE_OPTIONS;
  if (capture) env.NODE_OPTIONS = `--import=${preload}`;
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: env.CODETAC_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) activeGroups.add(child.pid);
  let output = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { output = (output + data).slice(-64000); });
  child.stderr.on('data', data => { output = (output + data).slice(-64000); });
  const request = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/probe`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok || (await response.json()).value !== 42) throw new Error('unexpected response');
  };
  try {
    let ready = false;
    while (performance.now() - started < 90000) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      try { await request(); ready = true; break; } catch { await delay(200); }
    }
    if (!ready) throw new Error('readiness timeout');
    const startupMs = performance.now() - started;
    for (let i = 0; i < 10; i++) await request();
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      await request();
      samples.push(performance.now() - start);
    }
    let coverage = null;
    if (capture) {
      // Events are written in batches; give the runtime time to flush.
      await delay(150);
      const events = readdirSync(directory).filter(file => file.endsWith('.jsonl')).flatMap(file => readFileSync(join(directory, file), 'utf8').trim().split('\n').map(JSON.parse));
      const entries = events.filter(event => event.type === 'enter');
      const observations = definition.expected.map(([name, suffix, line]) => {
        const observed = entries.filter(event => event.function === name && event.file.endsWith(suffix));
        return { function: name, expectedLine: line, calls: observed.length,
          correctOrigin: observed.length > 0 && observed.every(event => event.line === line),
          observed: observed[0] ? { file: observed[0].file, line: observed[0].line, mapped: observed[0].mapped } : null };
      });
      const [parentName, middleName, leafName] = definition.expected.map(item => item[0]);
      const byId = new Map(entries.map(event => [event.id, event]));
      const leaves = entries.filter(event => event.function === leafName);
      const chainCorrect = leaves.length > 0 && leaves.every(leaf => {
        const middle = byId.get(leaf.parentId);
        const parent = byId.get(middle?.parentId);
        return middle?.function === middleName && parent?.function === parentName
          && parent.sequence < middle.sequence && middle.sequence < leaf.sequence;
      });
      coverage = { observations, chainCorrect, totalEntries: entries.length,
        limitations: events.filter(event => event.type === 'limitation'),
        passed: observations.every(item => item.correctOrigin) && chainCorrect };
    }
    return { capture, round, label, startupMs, samplesMs: samples, medianMs: percentile(samples, .5), p95Ms: percentile(samples, .95), coverage };
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise(ok => child.once('exit', ok)), delay(1500)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      activeGroups.delete(child.pid);
    }
    writeFileSync(join(directory, 'server.log'), redact(output), { mode: 0o600 });
  }
}

const report = { date: new Date().toISOString(), node: process.version, platform: process.platform,
  kind: 'controlled-fixtures-not-real-project-acceptance', requestsPerRun: 40, warmupRequests: 10, rounds: 3,
  dependencies: JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).devDependencies, results: [] };
for (const definition of definitions) {
  console.log(`A testar ${definition.name} (3 pares, 40 pedidos por execução)…`);
  try {
    const runs = [];
    for (let round = 1; round <= 3; round++) {
      for (const capture of round % 2 ? [false, true] : [true, false]) runs.push(await measure(definition, capture, round));
    }
    const baseline = runs.filter(run => !run.capture).flatMap(run => run.samplesMs);
    const capture = runs.filter(run => run.capture).flatMap(run => run.samplesMs);
    const medianRatio = percentile(capture, .5) / percentile(baseline, .5);
    const p95Ratio = percentile(capture, .95) / percentile(baseline, .95);
    const coveragePassed = runs.filter(run => run.capture).every(run => run.coverage.passed);
    report.results.push({ name: definition.name, medianRatio, p95Ratio, coveragePassed,
      performancePassed: medianRatio <= 2 && p95Ratio <= 2, runs });
    console.log(`${definition.name}: cobertura=${coveragePassed}; mediana=${medianRatio.toFixed(2)}x; p95=${p95Ratio.toFixed(2)}x`);
  } catch (error) {
    report.results.push({ name: definition.name, error: String(error), coveragePassed: false, performancePassed: false });
    console.error(`${definition.name}: ${error}`);
  }
}
mkdirSync(join(workspace, '.codetac'), { recursive: true });
writeFileSync(join(workspace, '.codetac', 'stack-report.json'), JSON.stringify(redact(report), null, 2));
console.log('Relatório: .codetac/stack-report.json');
if (report.results.some(result => !result.coveragePassed || !result.performancePassed)) process.exitCode = 1;
