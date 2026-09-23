// Aceitação da Fase 1 num projeto: arranca-o com captura, faz os pedidos
// configurados, lê o dossiê do armazenamento local e verifica os critérios.
//   node scripts/accept-dossier.mjs <config.json>
// Critérios: funções do projeto pela ordem, fronteiras (escrita em base de
// dados e serviço externo) e nenhum segredo conhecido gravado.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../src/store.mjs';

const workspace = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8'));
const root = resolve(config.root);
const label = `${config.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const secrets = config.secretsFile ? JSON.parse(readFileSync(resolve(config.secretsFile), 'utf8')) : {};
const substitute = value => typeof value === 'string'
  ? value.replace(/\$([A-Za-z0-9_]+)/g, (match, name) => secrets[name] ?? process.env[name] ?? match) : value;

async function freePort() {
  const server = createServer();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise(ok => server.close(ok));
  return port;
}

const port = await freePort();
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CODETAC_ROOT: root, CODETAC_RUN: label,
  NODE_OPTIONS: `--import=${pathToFileURL(join(workspace, 'src/register.mjs')).href}`, PORT: String(port) };
for (const [key, value] of Object.entries(config.env ?? {})) env[key] = String(value).replaceAll('{port}', String(port));
const args = config.args.map(arg => arg.replaceAll('{port}', String(port)).replaceAll('{root}', root));
const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output = (output + data).slice(-64000); });
child.stderr.on('data', data => { output = (output + data).slice(-64000); });
const stop = async () => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([new Promise(ok => child.once('exit', ok)), delay(5000)]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
};
process.once('SIGINT', async () => { await stop(); process.exit(130); });

const performed = [];
try {
  const started = performance.now();
  while (true) {
    if (performance.now() - started > 180000) throw new Error('servidor não ficou pronto em 180 s');
    if (child.exitCode !== null) throw new Error(`servidor terminou com código ${child.exitCode}\n${output.slice(-2000)}`);
    try { await fetch(`http://127.0.0.1:${port}${config.readyPath ?? '/'}`, { redirect: 'manual', signal: AbortSignal.timeout(60000) }); break; }
    catch { await delay(300); }
  }
  for (const request of config.requests) {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key, substitute(value)]));
    let body;
    if (request.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.json, (_key, value) => substitute(value));
    }
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, { method: request.method ?? 'GET', headers, body, redirect: 'manual' });
    await response.arrayBuffer();
    performed.push({ name: request.name, method: request.method ?? 'GET', path: request.path.split('?')[0], status: response.status, accept: Boolean(request.accept), expect: request.expect });
    console.log(`${request.method ?? 'GET'} ${request.path} → ${response.status}`);
  }
  await delay(config.settleMs ?? 1000);
} finally {
  await stop();
}

const store = openStore(join(workspace, '.codetac'));
store.ingest();
const recorded = store.listRequests({ run: label, limit: 1000 });
const report = { date: new Date().toISOString(), project: config.name, run: label, requests: [], secretsFound: [], passed: true };

for (const item of performed) {
  const match = recorded.find(entry => entry.method === item.method && entry.path === item.path && !report.requests.some(r => r.requestId === entry.requestId));
  const dossier = match ? store.dossier(match.requestId) : null;
  const steps = dossier?.steps ?? [];
  const ids = new Set(steps.map(step => step.id));
  const functions = steps.filter(step => step.type === 'function');
  const boundaries = steps.filter(step => step.type === 'boundary');
  const checks = {
    recorded: Boolean(dossier),
    functions: functions.length > 0,
    // Every step hangs from the request or from an earlier step of the same request.
    order: steps.every((step, index) => index === 0 || step.sequence > steps[index - 1].sequence || step.depth === 0)
      && steps.every(step => step.depth === 0 || ids.has(step.parentId)),
    dbWrite: boundaries.some(step => step.kind === 'base-de-dados' && /^(INSERT|UPDATE|DELETE|UPSERT|REPLACE)$/.test(step.operation)),
    dbRead: boundaries.some(step => step.kind === 'base-de-dados'),
    external: boundaries.some(step => ['ia', 'email', 'mensagem', 'pagamento', 'ficheiros', 'autenticação'].includes(step.kind) || (step.kind === 'http' && !step.local)),
    boundariesFinished: boundaries.every(step => step.finished),
  };
  const required = item.accept ? ['recorded', 'functions', 'order', ...(item.expect ?? config.expect ?? ['dbWrite', 'external']), 'boundariesFinished'] : ['recorded'];
  const passed = required.every(name => checks[name]);
  if (!passed) report.passed = false;
  report.requests.push({ ...item, requestId: match?.requestId ?? null, checks, required, passed,
    steps: steps.map(step => step.type === 'function'
      ? { depth: step.depth, function: step.function, file: step.file?.startsWith(root) ? step.file.slice(root.length + 1) : step.file, line: step.line, ms: step.durationMs }
      : { depth: step.depth, boundary: step.kind, library: step.library, provider: step.provider, operation: step.operation ?? step.method,
        tables: step.tables, host: step.host, path: step.path, to: step.to, subject: step.subject, sql: step.sql, result: step.result, ms: step.durationMs }),
    marks: dossier?.marks ?? [] });
}

// Known secrets: sensitive values from the project's env files and the credentials used.
const sensitive = /password|secret|token|authorization|api[ _-]?key|apikey|credential|private[ _-]?key|session/i;
const values = new Set(Object.values(secrets).filter(value => typeof value === 'string' && value.length >= 6));
for (const file of config.envFiles ?? []) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index < 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (sensitive.test(key) && value.length >= 8) values.add(value);
  }
}
for (const value of config.extraSecrets ?? []) values.add(value);
const recordings = join(workspace, '.codetac', label);
const texts = readdirSync(recordings).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(recordings, name), 'utf8'));
for (const value of values) {
  if (texts.some(text => text.includes(value))) report.secretsFound.push(`valor com ${value.length} caracteres`);
}
if (report.secretsFound.length) report.passed = false;
report.secretsChecked = values.size;

const output_ = join(workspace, '.codetac', `${label}-aceitacao.json`);
writeFileSync(output_, JSON.stringify(report, null, 2), { mode: 0o600 });
for (const item of report.requests.filter(entry => entry.accept)) {
  console.log(`\n${item.method} ${item.path} → ${item.status}  ${item.passed ? 'ACEITE' : 'FALHOU'}  ${JSON.stringify(item.checks)}`);
  for (const step of item.steps) {
    const indent = '  '.repeat(step.depth + 1);
    console.log(step.function
      ? `${indent}${step.function}  ${step.file}:${step.line}`
      : `${indent}[${step.boundary}] ${step.provider ?? step.library ?? ''} ${step.operation ?? ''} ${step.tables?.join(',') ?? step.host ?? ''}${step.to ? ' para ' + step.to.join(',') : ''}${step.result?.status ? ' → ' + step.result.status : ''}`);
  }
  console.log(`  Marcas: ${item.marks.map(mark => mark.label).join('; ') || 'nenhuma'}`);
}
console.log(`\nSegredos verificados: ${report.secretsChecked}; encontrados na gravação: ${report.secretsFound.length}`);
console.log(`Resultado: ${report.passed ? 'ACEITE' : 'FALHOU'} — ${output_}`);
if (!report.passed) process.exitCode = 1;
