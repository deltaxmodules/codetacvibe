// Python examples (fixtures/python/<name>) run with or without the Python
// captor: shared by scripts/accept-python.mjs and scripts/benchmark-python.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../../src/home.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const captor = join(root, 'src/python/codetac_py');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
export const fixture = name => realpathSync(join(root, 'fixtures/python', name));
export const gitStatus = folder => spawnSync('git', ['status', '--porcelain', '--', folder], { cwd: root, encoding: 'utf8' }).stdout;

export function prepareEnvironment(project) {
  const python = join(project, '.venv/bin/python');
  const uv = spawnSync('uv', ['--version']).status === 0;
  if (existsSync(python)) {
    // Quick when nothing changed; installs what requirements.txt gained.
    if (uv) spawnSync('uv', ['pip', 'install', '-q', '--python', python, '-r', 'requirements.txt'], { cwd: project, stdio: 'inherit' });
    return python;
  }
  console.log('A criar o .venv do exemplo (só na primeira vez)…');
  const steps = uv
    ? [['uv', ['venv', '--python', '3.12', '.venv']], ['uv', ['pip', 'install', '--python', python, '-r', 'requirements.txt']]]
    : [['python3.12', ['-m', 'venv', '.venv']], [python, ['-m', 'pip', 'install', '-r', 'requirements.txt']]];
  for (const [command, commandArgs] of steps) {
    const result = spawnSync(command, commandArgs, { cwd: project, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} falhou`);
  }
  return python;
}

// One running app, its recording and its cookies.
export async function startApp({ project, command, commandArgs, env, run, probe = '/', capture = true }) {
  const port = await freePort();
  const recording = join(dataDirectory(), run);
  const fullEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODETAC_') && key !== 'PYTHONPATH')),
    ...(capture ? { PYTHONPATH: captor, CODETAC_RUN: run, CODETAC_ROOT: project } : {}), PYTHONDONTWRITEBYTECODE: '1', ...env };
  const child = spawn(command, commandArgs(port), { cwd: project, env: fullEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const jar = new Map();
  const app = {
    port, recording, child, run, jar, output: () => output, answered: [],
    // own: a request to CodeTAC's own routes (/__codetac/), never a request of the app.
    async request(method, path, { form, json, headers: extra = {}, own = false } = {}) {
      const headers = { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...extra };
      let body;
      if (form) { body = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
      if (json) { body = JSON.stringify(json); headers['content-type'] = 'application/json'; }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
      app.last = { body: await response.text(), headers: response.headers };
      if (!own) app.answered.push({ method, path: path.split('?')[0], status: response.status });
      return response.status;
    },
    leftover: () => spawnSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8' }).stdout.trim(),
    async stop() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      for (let waited = 0; waited < 8000 && (child.exitCode === null && child.signalCode === null || app.leftover()); waited += 100) await sleep(100);
      if (app.leftover()) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await sleep(300); }
    },
    files() {
      if (!existsSync(recording)) return [];
      return readdirSync(recording).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(recording, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
    },
    events() { return app.files().flat(); },
    raw() { return existsSync(recording) ? readdirSync(recording).map(file => readFileSync(join(recording, file), 'utf8')).join('') : ''; },
  };
  for (let waited = 0; ; waited += 200) {
    try { await app.request('GET', probe); break; } catch {
      if (waited > 30000 || child.exitCode !== null) { await app.stop(); throw new Error(`a app não respondeu:\n${output}`); }
      await sleep(200);
    }
  }
  return app;
}

