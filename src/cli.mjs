#!/usr/bin/env node
// Comando `codetac` (Fase 5): numa pasta de projeto, descobre como arrancá-lo,
// arranca o painel e a app com a captura e diz onde abrir. Se a app não
// arrancar com a instrumentação fina, arranca-a de novo em modo mínimo.
//   codetac [folder] [options] [-- start command]
//   codetac diagnose [folder]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, homedir, release } from 'node:os';
import http from 'node:http';
import { basename, join, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { detectProject, describeStart, foreignRuntime, chooseScript, prismaWithoutTracing } from './detect.mjs';
import { panelOnPort } from './panel-ping.mjs';
import { MINIMUM, commandFor, describePythonFolder, environmentOf, interpreters, moveTo, probe, proxyOf, pythonPort, versionBelow, withAskedPort, envAddressesOn } from './detect-python.mjs';
import { createSummary, follow } from './recording.mjs';
import { describeFailure, ownError, readTraceback } from './failure.mjs';
import { t } from './structure/text.mjs';

import { dataDirectory, install as workspace } from './home.mjs';

const recordings = dataDirectory();
const register = pathToFileURL(join(workspace, 'src', 'register.mjs')).href;
// The Python captor: its sitecustomize.py runs in every Python process of the app.
const captor = join(workspace, 'src', 'python', 'codetac_py');
const started = Date.now();
const seconds = () => `${Math.round((Date.now() - started) / 1000)} s`;
const say = text => process.stdout.write(`${text}\n`);
// Output cut short (codetac structure --diff | head): stop quietly, like other commands.
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
const HELP = t('run.help');

function parseArgs(argv) {
  const options = { parts: [], command: null, folder: null, sub: null, reclassify: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--') { options.command = argv.slice(index + 1); break; }
    else if (arg === '--script') options.script = value();
    else if (arg === '--part') options.parts.push(value());
    else if (arg === '--port') options.port = Number(value());
    else if (arg === '--panel-port') options.panelPort = Number(value());
    else if (arg === '--minimal') options.minimal = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-open') options.noOpen = true;
    else if (arg === '-h' || arg === '--help' || (arg === 'help' && !options.sub && !options.folder)) options.sub = 'help';
    else if (!options.sub && !options.folder && arg === 'diagnose') options.sub = 'diagnose';
    else if (!options.sub && !options.folder && arg === 'report') options.sub = 'report';
    else if (!options.sub && !options.folder && arg === 'structure') options.sub = 'structure';
    else if (!options.sub && !options.folder && arg === 'check') options.sub = 'check';
    else if (!options.sub && !options.folder && arg === 'privacy') options.sub = 'privacy';
    else if (!options.sub && !options.folder && arg === 'hooks') options.sub = 'hooks';
    else if (!options.sub && !options.folder && arg === 'diff') options.sub = 'diff';
    else if (!options.sub && !options.folder && arg === 'live') options.sub = 'live';
    else if (options.sub === 'live' && !options.live && arg === 'replay') options.live = arg;
    else if ((options.sub === 'live' || options.sub === 'check') && arg === '--json') options.json = true;
    else if (options.sub === 'check' && arg === '--fail-on') {
      options.failOn = value();
      if (!['red', 'yellow'].includes(options.failOn)) { say(t('run.failOn', { value: options.failOn ?? '' })); process.exit(2); }
    }
    else if (options.sub === 'live' && options.live && options.session === undefined && !options.folder
      && !(() => { try { return statSync(resolve(arg)).isDirectory(); } catch { return false; } })()) options.session = arg;
    else if (options.sub === 'diff' && !options.undo && options.prompt === undefined && !options.folder && (arg === 'undo' || arg === 'redo')) options.undo = arg;
    else if (options.sub === 'diff' && arg === '--list') options.list = true;
    else if (options.sub === 'diff' && arg === '--code') options.code = true;
    else if (options.sub === 'diff' && arg === '--open') options.open = true;
    else if (options.sub === 'diff' && options.prompt === undefined && /^\d+$/.test(arg)) options.prompt = Number(arg);
    else if (options.sub === 'hooks' && !options.hooks && !options.folder && ['install', 'uninstall', 'status'].includes(arg)) options.hooks = arg;
    else if (options.sub === 'privacy' && (arg === '--no-ai' || arg === '--ai')) options.noAi = arg === '--no-ai';
    else if (options.sub === 'privacy' && ['--on', '--off', '--default'].includes(arg)) (options[arg.slice(2)] ??= []).push(value());
    else if (options.sub === 'privacy' && arg === '--log') options.log = /^\d+$/.test(argv[index + 1] ?? '') ? Number(value()) : 5;
    else if (options.sub === 'privacy' && arg === '--clear-log') options.clearLog = true;
    else if (options.sub === 'structure' && arg === '--reclassify') options.reclassify = [value(), value()];
    else if (options.sub === 'structure' && arg === '--suggest') options.suggest = true;
    else if (options.sub === 'structure' && arg === '--snapshots') options.snapshots = true;
    else if (options.sub === 'structure' && arg === '--predict') options.predict = true;
    else if (options.sub === 'structure' && arg === '--diff') {
      // Up to two points (a snapshot, a commit, or now); a folder that exists is the project's folder.
      const points = [];
      while (points.length < 2 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('-')
        && (options.folder || !(() => { try { return statSync(resolve(argv[index + 1])).isDirectory(); } catch { return false; } })())) points.push(value());
      options.diff = { points };
    }
    else if (options.sub === 'structure' && arg === '--snapshot') {
      // The label is optional: the next word is the label unless it is an
      // option or a folder that exists (then it is the project's folder).
      const next = argv[index + 1];
      const folder = next !== undefined && !options.folder && (() => { try { return statSync(resolve(next)).isDirectory(); } catch { return false; } })();
      options.snapshot = { label: next !== undefined && !next.startsWith('-') && !folder ? value() : null };
    }
    else if (arg === '-v' || arg === '--version') options.sub = 'version';
    else if (!options.folder && !arg.startsWith('-')) options.folder = arg;
    else { say(`${t('run.unknownOption', { arg })}\n\n${HELP}`); process.exit(2); }
  }
  return options;
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
async function ask(question, choices) {
  if (!interactive) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (choices) {
      choices.forEach((choice, index) => say(`  ${index + 1}. ${choice}`));
      const answer = (await rl.question(`${question} `)).trim();
      return answer;
    }
    return (await rl.question(`${question} `)).trim();
  } finally { rl.close(); }
}
async function confirm(question, options) {
  if (options.yes) return true;
  const answer = await ask(`${question} [Y/n]`);
  if (answer === null) return null;
  return !/^n/i.test(answer);
}

// Folders one level down that start with Node on their own (a package.json with a
// start script that needs no other runtime) or are a Python app.
function startableFolders(root) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    try {
      const script = chooseScript(JSON.parse(readFileSync(join(root, entry.name, 'package.json'), 'utf8')));
      if (script && !foreignRuntime(script.command)) found.push(entry.name);
    } catch {
      if (existsSync(join(root, entry.name, 'pyproject.toml')) || existsSync(join(root, entry.name, 'requirements.txt'))) found.push(entry.name);
    }
  }
  return found.sort();
}
function hasBinary(name) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0;
}
// A package manager that is not installed runs through npx.
function runnable(command) {
  const [bin, ...rest] = command;
  if (['pnpm', 'yarn'].includes(bin) && !hasBinary(bin)) return ['npx', '--yes', bin, ...rest];
  return command;
}

function get(port, path, { host = '127.0.0.1', timeout = 3000, headers = {} } = {}) {
  return new Promise(done => {
    const request = http.get({ host, port, path, timeout, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 4096) body += chunk; });
      response.on('end', () => done({ status: response.statusCode, type: String(response.headers['content-type'] ?? ''), body }));
    });
    request.on('timeout', () => { request.destroy(); done(null); });
    request.on('error', () => done(null));
  });
}
const wait = ms => new Promise(done => setTimeout(done, ms));

// The panel: reuses one of this version already running, or starts it. A
// panel of another version is left running (another codetac may be using it)
// and a new one starts on the next free port: an older panel does not know
// the pages the new bar asks for (/structure answered "Not found.").
async function ensurePanel(port, avoid) {
  const version = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version;
  const others = [];
  for (let candidate = port; candidate < port + 20; candidate++) {
    if (avoid.has(candidate)) continue;
    const ping = await get(candidate, '/api/ping');
    const found = panelOnPort(ping, version);
    if (found?.kind === 'same') return { port: candidate, reused: true, others, version };
    if (found) { others.push({ port: candidate, version: found.version, pid: found.pid }); continue; }
    if (ping) continue; // another program answers on this port
    const child = spawn(process.execPath, [join(workspace, 'src', 'panel.mjs'), '--port', String(candidate)],
      { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let first = '';
    child.stdout.on('data', chunk => { first += chunk; });
    child.stderr.on('data', chunk => { first += chunk; });
    for (let tries = 0; tries < 60; tries++) {
      await wait(250);
      if (child.exitCode !== null) break;
      const ok = await get(candidate, '/api/ping');
      if (ok?.status === 200) return { port: candidate, child, line: first.split('\n')[0], others, version };
    }
    child.kill();
    if (/EADDRINUSE/.test(first)) continue;
    throw new Error(t('run.panelDidNotStart', { output: first.trim().split('\n').slice(-3).join(' ') }));
  }
  throw new Error(t('run.noFreePort'));
}

// A panel of this version for `codetac diff --open`: one already running, or a
// new one on the first free port, started apart so it stays after the command.
async function panelForReport(port) {
  const version = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version;
  for (let candidate = port; candidate < port + 20; candidate++) {
    const ping = await get(candidate, '/api/ping');
    if (panelOnPort(ping, version)?.kind === 'same') return candidate;
    if (ping) continue;
    const child = spawn(process.execPath, [join(workspace, 'src', 'panel.mjs'), '--port', String(candidate)], { cwd: workspace, stdio: 'ignore', detached: true, env: { ...process.env } });
    child.unref();
    for (let tries = 0; tries < 40; tries++) {
      await wait(250);
      if ((await get(candidate, '/api/ping'))?.status === 200) return candidate;
    }
    return null;
  }
  return null;
}

function recordingName(name) {
  const slug = String(name).toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${slug}-${stamp}`;
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local)(?::(\d{2,5}))?/g;

// Starts the parts of the application with the capture at a level; resolves
// when one of them serves HTTP, or when they all stopped.
const CRASHED = /\[nodemon\] app crashed|Failed running ['"]|waiting for (?:file )?changes before restart/i;
const BUSY = /EADDRINUSE[^\n]*?:(\d{2,5})\b|[Pp]ort (\d{2,5}) is (?:already )?in use()/;

function startApp(parts, { run, panelPort, minimal, reason, root, extraEnv = {} }) {
  const children = [];
  const ports = [];
  const tail = [];
  const state = { busy: null };
  const env = {
    ...process.env, CODETAC_ROOT: root, CODETAC_RUN: run, CODETAC_PANEL_PORT: String(panelPort),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${register}`].filter(Boolean).join(' '),
    PYTHONPATH: [captor, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
  };
  // Python writes to a pipe in blocks: without this, the app's prints would show late.
  env.PYTHONUNBUFFERED ??= '1';
  // Python's bytecode (__pycache__) goes to CodeTAC's folder, not into the project:
  // some projects even keep .pyc files in Git.
  env.PYTHONPYCACHEPREFIX ??= join(recordings, 'pycache');
  // The application's output goes through a pipe: its colours stay when the terminal has them.
  if (process.stdout.isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1';
  Object.assign(env, extraEnv);
  if (minimal) Object.assign(env, { CODETAC_LEVEL: 'minimo', CODETAC_MINIMO_MOTIVO: reason });
  for (const part of parts) {
    const [bin, ...args] = runnable(part.command);
    const child = spawn(bin, args, { cwd: part.folder, env: { ...env, ...part.env, ...(part.language === 'python' ? environmentOf(part) : {}) }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      shell: process.platform === 'win32' });
    const label = parts.length > 1 ? `[${part.part}] ` : '';
    child.tail = [];
    const show = chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        process.stdout.write(`  │ ${label}${line}\n`);
        const plain = line.replace(ANSI, '');
        tail.push(`${label}${plain}`);
        if (tail.length > 40) tail.shift();
        child.tail.push(plain);
        if (child.tail.length > 12) child.tail.shift();
        for (const match of plain.matchAll(URL_IN_OUTPUT)) if (match[1]) ports.push(Number(match[1]));
        // Watch modes (node --watch, nodemon, tsx watch) keep running after a crash.
        if (CRASHED.test(plain)) child.crashed = true;
        // A Python app that fails while importing, under a reloader (uvicorn --reload,
        // fastapi dev, flask --debug): the reloader stays, waiting for changes.
        if (child.part?.language === 'python') readTraceback(child, plain);
        const busy = plain.match(BUSY);
        if (busy) state.busy = Number(busy[1] ?? busy[2] ?? busy[3]);
      }
    };
    child.stdout.on('data', show);
    child.stderr.on('data', show);
    // A command that cannot start (not found, not executable): said in words, never a crash.
    // The exit code is already set (negative), so the waits below see the part as stopped.
    child.on('error', error => {
      const hint = bin === 'python' ? ` ${t('run.pythonHint')}` : '';
      child.spawnError = error.code === 'ENOENT' ? t('run.commandNotFound', { bin, hint }) : t('run.couldNotStart', { bin, error: error.message });
      show(child.spawnError);
    });
    child.part = part;
    children.push(child);
  }
  return { children, ports, tail, state };
}

// The program holding a port, to name it.
function holder(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], { encoding: 'utf8' });
  return result.stdout?.split('\n').find(line => line.startsWith('c'))?.slice(1) ?? null;
}
function freePort() {
  return new Promise(done => {
    const server = http.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

function stopAll(children, force = null) {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // Python apps stop as with Ctrl+C: SIGTERM makes some of them warn (leaked semaphores).
    const signal = force ?? (child.part?.language === 'python' ? 'SIGINT' : 'SIGTERM');
    try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  }
}
const running = children => children.filter(child => child.exitCode === null && child.signalCode === null);

// The processes of the application: its children and their descendants.
function processTree(children) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const rows = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const ours = new Set(children.map(child => child.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, pgid] of rows) if (!ours.has(pid) && (ours.has(ppid) || ours.has(pgid))) { ours.add(pid); grew = true; }
  }
  return ours;
}
// Who listens on a port (pid and address), by lsof; null where lsof is missing.
function listeners(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8' });
  if (result.error) return null;
  const found = [];
  let current = null;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) found.push(current = { pid: Number(line.slice(1)), names: [] });
    else if (line.startsWith('c') && current) current.command = line.slice(1);
    else if (line.startsWith('n') && current) current.names.push(line.slice(1));
  }
  return found;
}

// The page of the application: the first candidate port that answers HTML,
// else the first that answers at all (an API without pages). Only ports
// opened by the application's own processes count: another program on the
// same port (in the other IP family) would otherwise answer in its place.
async function findApp(candidates, panelPort, { children, addresses, warn }) {
  let api = null;
  const ours = processTree(children);
  for (const port of [...new Set(candidates)].filter(port => port && port !== panelPort)) {
    const owners = listeners(port);
    let host = 'localhost';
    if (owners && ours) {
      const mine = owners.filter(owner => ours.has(owner.pid));
      const others = owners.filter(owner => !ours.has(owner.pid));
      if (!mine.length) continue;
      if (others.length) {
        // Reach the application by the exact address it bound.
        const bound = addresses.get(port) ?? (mine[0].names.find(name => /^127\.0\.0\.1:|^\[::1\]:/.test(name)) ?? mine[0].names[0] ?? '').replace(/:\d+$/, '');
        // '::' (every IPv6 address) too: the other program holds the IPv4 one.
        host = /^\[?::1?\]?$/.test(bound) ? '::1' : '127.0.0.1';
        warn(port, others[0].command ?? t('run.anotherProgram'), host);
      }
    }
    // The internal header keeps these probes out of the recording.
    const headers = { accept: 'text/html', 'x-codetac-internal': '1', host: `${host === '::1' ? '[::1]' : host}:${port}` };
    const answer = await get(port, '/', { host, timeout: 90_000, headers })
      ?? (host === 'localhost' ? await get(port, '/', { host: '127.0.0.1', timeout: 90_000, headers: { ...headers, host: `127.0.0.1:${port}` } }) : null);
    if (!answer) continue;
    // A 404 in HTML is an API's "Cannot GET /"; a 500 is a page that fails,
    // shown with a warning.
    const url = `http://${host === '::1' ? '[::1]' : host}:${port}/`;
    if (/text\/html/.test(answer.type) && answer.status !== 404) return { port, url, page: true, status: answer.status };
    api ??= { port, url, page: false, status: answer.status };
  }
  return api;
}

// DP5: a Python project without an environment, or without its dependencies.
// Always asked first (--sim answers yes); the environment is .venv in the project.
function requirementFiles(folder) {
  let names = [];
  try { names = readdirSync(folder); } catch {}
  const files = names.filter(name => /^requirements.*\.txt$/.test(name) && !/(dev|test|lint|doc)/.test(name));
  return files.includes('requirements.txt') ? ['requirements.txt'] : files.slice(0, 1);
}
function pythonSteps(part, { create, skip = [] }) {
  const { folder, python } = part;
  const uv = hasBinary('uv');
  const venvPython = python.interpreter ?? join(folder, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const steps = [];
  let chosen = null;
  if (part.manager === 'uv' && uv) return { steps: [['uv', ['sync']]], chosen, env: {} };
  if (part.manager === 'poetry' || part.manager === 'pipenv') {
    const tool = part.manager;
    if (!hasBinary(tool)) return { problem: t('run.toolMissing', { tool }) };
    // Both keep the environment in the project when asked to: the .venv of DP5.
    const env = tool === 'poetry' ? { POETRY_VIRTUALENVS_IN_PROJECT: 'true' } : { PIPENV_VENV_IN_PROJECT: '1' };
    return { steps: [tool === 'poetry' ? ['poetry', ['install', '--no-root']] : ['pipenv', ['install', '--dev']]], chosen, env };
  }
  if (create) {
    const found = interpreters();
    chosen = found.find(item => !versionBelow(item.version) && !skip.includes(item.executable)) ?? null;
    // uv fetches a Python 3.12 when there is none on the computer.
    if (uv) steps.push(['uv', ['venv', '--python', chosen?.executable ?? MINIMUM.join('.'), '.venv']]);
    else {
      chosen ??= found[0] ?? null;
      if (!chosen) return { problem: t('run.noPython') };
      steps.push([chosen.executable, ['-m', 'venv', '.venv']]);
    }
  }
  const files = requirementFiles(folder);
  const install = uv ? ['uv', ['pip', 'install', '--python', venvPython]] : [venvPython, ['-m', 'pip', 'install']];
  if (files.length) steps.push([install[0], [...install[1], '-r', files[0]]]);
  else if (existsSync(join(folder, 'pyproject.toml'))) {
    if (uv) steps.push([install[0], [...install[1], '-r', 'pyproject.toml']]);
    else steps.push({ pyproject: true, install });
  }
  return { steps, chosen, env: {} };
}
// A command as the user would type it in the project's folder.
const shown = ([bin, args], folder) => [bin, ...args].map(token => token.startsWith(`${folder}/`) ? token.slice(folder.length + 1) : token)
  .map(token => token.includes(' ') ? `"${token}"` : token).join(' ');

async function preparePython(part, root, options, skip = []) {
  const label = part.part === '.' ? t('run.theProject') : t('run.thePart', { part: part.part });
  const create = !part.python.interpreter;
  const plan = pythonSteps(part, { create, skip });
  if (plan.problem) { say(`✗ ${t('run.noEnvironment', { label })} ${plan.problem}`); process.exit(2); }
  const lines = plan.steps.map(step => step.pyproject ? `${shown(step.install, part.folder)} <pyproject.toml dependencies>` : shown(step, part.folder));
  const why = create
    ? t('run.noVenv', { label })
    : t('run.missingDeps', { source: part.python.source, list: `${part.python.missing.slice(0, 6).join(', ')}${part.python.missing.length > 6 ? '…' : ''}` });
  say(`${why} ${t('run.mustRun', { folder: part.folder })}`);
  for (const line of lines) say(`    ${line}`);
  if (create && plan.chosen) say(`  ${t('run.withPython', { version: plan.chosen.version, newest: skip.length ? '' : `, ${t('run.newest')}` })}`);
  else if (create && hasBinary('uv') && part.manager !== 'uv') say(`  ${t('run.uvDownloads', { version: MINIMUM.join('.') })}`);
  if (!lines.length) return part;
  // A retry with an older Python was already agreed to.
  const yes = skip.length ? true : await confirm(t(create ? 'run.createVenv' : 'run.installNow'), options);
  if (yes === null) { say(t('run.runThoseOrYes')); process.exit(2); }
  if (!yes) { say(t('run.withoutDeps')); process.exit(2); }
  for (const step of plan.steps) {
    let command = step;
    if (step.pyproject) {
      const venvPython = join(part.folder, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const declared = probe(existsSync(venvPython) ? venvPython : step.install[0], part.folder)?.pyproject ?? [];
      if (!declared.length) continue;
      command = [step.install[0], [...step.install[1], ...declared]];
    }
    say(`  ${t('run.running', { command: shown(command, part.folder) })}`);
    // Not the environment of whoever runs codetac: the project's.
    const env = { ...process.env, ...plan.env };
    delete env.VIRTUAL_ENV;
    const result = spawnSync(command[0], command[1], { cwd: part.folder, stdio: 'inherit', env });
    if (result.status !== 0) {
      // Pinned dependencies may not exist yet for the newest Python (no wheel, and the
      // build fails): the new .venv is made again with the next older Python ≥ the minimum.
      const older = create && plan.chosen ? interpreters().find(item => !versionBelow(item.version) && item.executable !== plan.chosen.executable
        && ![...skip, plan.chosen.executable].includes(item.executable) && item.version.split('.').slice(0, 2).join('.') !== plan.chosen.version.split('.').slice(0, 2).join('.')) : null;
      if (older) {
        say(`! ${t('run.retryOlderPython', { failed: plan.chosen.version, older: older.version })}`);
        rmSync(join(part.folder, '.venv'), { recursive: true, force: true });
        return preparePython(part, root, options, [...skip, plan.chosen.executable]);
      }
      say(`✗ ${t('run.failedCode', { code: result.status })}`);
      process.exit(1);
    }
  }
  if (create && existsSync(join(part.folder, '.venv'))) {
    const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: part.folder, encoding: 'utf8' }).stdout?.trim() === 'true';
    // Git shows the .venv (as untracked) only when nothing ignores it; uv puts a .gitignore inside it.
    if (inGit && spawnSync('git', ['status', '--porcelain', '--', '.venv'], { cwd: part.folder, encoding: 'utf8' }).stdout.trim()) {
      say(`! ${t('run.venvNotIgnored')}`);
    }
  }
  const again = describePythonFolder(part.folder, root);
  if (!again?.command) { say(`✗ ${t('run.stillUnknown')}`); process.exit(1); }
  if (again.python.missing.length) say(`! ${t('run.stillMissing', { list: again.python.missing.join(', ') })}`);
  return { ...again, part: part.part };
}

// A command given by the user. In a Python project it runs with the project's
// environment (uvicorn, flask… as python -m with its interpreter).
function manualPart(project, root, command) {
  const top = project.top?.language === 'python' && project.top.folder === root ? project.top : null;
  if (!top) return { folder: root, part: '.', name: project.name, command, script: null, stack: null, port: null, installed: true, foreign: foreignRuntime(command.join(' ')) };
  const text = command.join(' ');
  const part = { ...top, installed: true, notes: [], python: { ...top.python, declared: text, declaredSource: t('run.givenCommand') },
    script: { name: t('run.givenCommand'), command: text } };
  part.port = pythonPort(root, { command: text, app: top.python.app });
  part.command = commandFor(part, part.port?.value ?? 8000);
  return part;
}

// The macOS AirPlay Receiver listens on 5000 (and 7000): Flask's default port.
function portTakenBy(port, who) {
  if (process.platform === 'darwin' && port === 5000 && /ControlCe|AirPlay/i.test(who ?? '')) {
    return t('run.takenByAirPlay');
  }
  return t('run.takenBy', { who: who ?? t('run.unknown') });
}

async function main() {
  // Phase D1: what the Claude Code hooks run (codetac hook <event> --project <folder>).
  // Read before the other options: it prints nothing and always exits with 0.
  if (process.argv[2] === 'hook') {
    try {
      const argv = process.argv.slice(3);
      const at = argv.indexOf('--project');
      const { prepareReport, runHook } = await import('./diff/hook.mjs');
      const prompt = argv.indexOf('--prompt');
      if (argv[0] === 'Prepare') await prepareReport(argv[at + 1], Number(argv[prompt + 1]));
      else runHook(argv[0], { project: at >= 0 ? argv[at + 1] : null });
    } catch {}
    process.exit(0);
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.sub === 'help') { say(HELP); return; }
  // Block K (K1.5): `codetac check` runs from Node 20; the rest needs
  // registerHooks and node:sqlite (Node 22.15), and is made for Node 24.
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if ((nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 15)) && !['check', 'version', 'diagnose', 'report'].includes(options.sub)) {
    say(t('run.nodeTooOld', { version: process.version }));
    process.exit(1);
  }
  if (options.sub === 'version') { say(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version); return; }
  const folder = resolve(options.folder ?? process.cwd());
  if (!existsSync(folder)) { say(t('run.noFolder', { folder })); process.exit(2); }
  const root = realpathSync(folder);
  if (options.sub === 'report') {
    // The diagnosis in a file to send with an incident: no code, no values;
    // the home folder is shortened to ~.
    const { diagnose } = await import('./diagnose.mjs');
    const lines = [];
    const version = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version;
    lines.push(`codeTAC ${version} · Node ${process.version} · ${process.platform} ${arch()} · ${release()}`, '');
    await diagnose(root, { panelPort: options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000), out: text => lines.push(text) });
    const text = lines.join('\n').split(homedir()).join('~') + '\n';
    mkdirSync(recordings, { recursive: true });
    const file = join(recordings, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(file, text);
    say(text);
    say(t('run.reportSaved', { file: file.split(homedir()).join('~') }));
    say(t('run.reportContents'));
    say('  https://github.com/deltaxmodules/codetacvibe/issues/new');
    return;
  }
  if (options.sub === 'privacy') {
    const { privacyCommand } = await import('./privacy.mjs');
    const { loadConfig } = await import('./ai.mjs');
    process.exitCode = privacyCommand({ noAi: options.noAi, on: options.on, off: options.off, reset: options.default, log: options.log ?? null, clearLog: options.clearLog },
      { config: await loadConfig({ directory: recordings }) });
    return;
  }
  if (options.sub === 'check') {
    // Block K: is the app safe to ship? A static reading; nothing is started.
    const { checkCommand } = await import('./check/check.mjs');
    process.exitCode = await checkCommand(root, { json: options.json ?? false, failOn: options.failOn ?? 'red',
      version: JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version });
    return;
  }
  if (options.sub === 'structure') {
    const { structureCommand } = await import('./structure/cli.mjs');
    if (options.predict && !options.snapshot) { say(t('run.predictNeedsSnapshot')); process.exitCode = 2; return; }
    const confirm = interactive ? async question => /^y(es)?$/i.test(String(await ask(question) ?? '').trim()) : null;
    process.exitCode = await structureCommand(root, { reclassify: options.reclassify, suggest: options.suggest, yes: options.yes, confirm,
      snapshot: options.snapshot ?? null, snapshots: options.snapshots ?? false, diff: options.diff ?? null,
      predict: options.predict ?? false, ask: interactive ? ask : null });
    return;
  }
  if (options.sub === 'diff') {
    const { diffCommand, reportAddress } = await import('./diff/cli.mjs');
    if (options.open) {
      // Phase D3: the report in the panel, with no app running (a panel of this version, or one started apart that stays).
      const address = reportAddress(root, options.prompt ?? 'latest');
      if (address.error) { say(`✗ ${address.error}`); process.exitCode = 2; return; }
      const panel = await panelForReport(options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000));
      if (!panel) { say(`✗ ${t('prompts.cli.noPanel')}`); process.exitCode = 1; return; }
      const url = `http://127.0.0.1:${panel}${address.path}`;
      say(t('prompts.cli.opening', { url }));
      openBrowser(url);
      return;
    }
    if (options.undo) {
      // Phase D6: undo or redo a whole prompt (asks first, or --yes).
      const { switchCommand } = await import('./diff/cli.mjs');
      const confirm = interactive ? async question => /^y(es)?$/i.test(String(await ask(question) ?? '').trim()) : null;
      process.exitCode = await switchCommand(root, options.undo, { n: options.prompt ?? 'latest', yes: options.yes, confirm });
      return;
    }
    process.exitCode = await diffCommand(root, { n: options.prompt ?? 'latest', list: options.list ?? false, code: options.code ?? false });
    return;
  }
  if (options.sub === 'live') {
    const { liveCommand, liveAddress } = await import('./live/cli.mjs');
    if (!options.live) {
      // Phase L3: the live window, in a panel of this version (one running, or one started apart that stays).
      const address = liveAddress(root);
      if (address.warning) say(`! ${address.warning}`);
      const panel = await panelForReport(options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000));
      if (!panel) { say(`✗ ${t('live.cli.noPanel')}`); process.exitCode = 1; return; }
      const url = `http://127.0.0.1:${panel}${address.path}`;
      say(t('live.cli.opening', { url }));
      if (!options.noOpen) openBrowser(url);
      return;
    }
    process.exitCode = liveCommand(root, { action: options.live, session: options.session ?? null, json: options.json ?? false });
    return;
  }
  if (options.sub === 'hooks') {
    const { hooksCommand } = await import('./diff/install.mjs');
    const confirm = interactive ? async question => /^y(es)?$/i.test(String(await ask(question) ?? '').trim()) : null;
    process.exitCode = await hooksCommand(root, options.hooks ?? 'status', { yes: options.yes, confirm });
    return;
  }
  if (options.sub === 'diagnose') {
    const { diagnose } = await import('./diagnose.mjs');
    process.exitCode = await diagnose(root, { panelPort: options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000) });
    return;
  }

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 24) say(`! ${t('run.oldNode', { version: process.version })}`);

  // 1. How to start the project.
  const project = detectProject(root);
  let parts = project.start;
  if (options.command?.length) {
    parts = [manualPart(project, root, options.command)];
  } else if (options.parts.length) {
    parts = options.parts.map(name => project.parts.find(part => part.part === name || basename(part.folder) === name) ?? (name === '.' ? project.top : null)).filter(Boolean);
    if (!parts.length) { say(t('run.partNotFound', { parts: options.parts.join(', '), all: project.parts.map(part => part.part).join(', ') || t('run.none') })); process.exit(2); }
  } else if (options.script) {
    const base = project.top ?? project.start[0];
    if (!base) { say(t('run.noPackageForScript')); process.exit(2); }
    parts = [{ ...base, script: { name: options.script, command: '' }, command: [base.runner, 'run', options.script] }];
  }
  say(`CodeTAC · ${project.name} (${root})`);
  if (!parts.length && project.missing.includes('part')) {
    say(t('run.severalParts'));
    const answer = await ask(t('run.whichParts'), project.parts.map(describeStart));
    if (answer === null) parts = project.parts;
    else parts = answer ? answer.split(/[\s,]+/).map(n => project.parts[Number(n) - 1]).filter(Boolean) : project.parts;
  }
  if (!parts.length && project.top?.language === 'python') {
    say(project.top.python.django
      ? t('run.django')
      : t('run.pythonAppNotFound'));
  }
  if (!parts.length) {
    const python = project.top?.language === 'python';
    if (!python) say(project.missing.includes('package')
      ? t('run.noPackage')
      : t('run.noStartScript'));
    const example = python ? 'uvicorn main:app --reload' : 'node server.js';
    const answer = await ask(t('run.whichCommand', { example }));
    if (!answer) { say(t('run.giveCommand', { example })); process.exit(2); }
    parts = [manualPart(project, root, answer.split(/\s+/))];
  }
  const absent = [];
  for (const part of parts.filter(part => part.foreign)) {
    // Python started from a Node script inherits the Python captor (PYTHONPATH).
    if (/^(python3?|uvicorn)$/.test(part.foreign)) say(`! [${part.part}] ${t('run.scriptStartsPython', { version: MINIMUM.join('.') })}`);
    else if (!hasBinary(part.foreign.split(' ')[0])) absent.push(part);
    else say(`! [${part.part}] ${t('run.scriptNotNode', { tool: part.foreign })}`);
  }
  // A script that needs a program this computer does not have (bun…): said before starting,
  // with the folders that start without it.
  if (absent.length) {
    for (const part of absent) say(`✗ [${part.part}] ${t('run.scriptNeeds', { command: part.script?.command ?? part.command.join(' '), tool: part.foreign })}`);
    const others = [...new Set([...parts.filter(part => !absent.includes(part)).map(part => part.part), ...startableFolders(root)])].filter(folder => folder !== '.');
    say(`  ${t('run.installAndRerun', { tools: [...new Set(absent.map(part => part.foreign))].join(` ${t('steps.and')} `),
      others: others.length ? `, ${t('run.orStartOnly', { parts: others.map(folder => `--part ${folder}`).join(' ') })}` : '' })}`);
    process.exit(1);
  }

  // 2. Dependencies. Python (DP5): an environment in the project, always asked first.
  for (const [index, part] of parts.entries()) {
    if (part.language === 'python' && !part.installed) parts[index] = await preparePython(part, root, options);
  }
  for (const part of parts) say(`  ${t('run.start', { start: describeStart(part) })}`);
  for (const part of parts) for (const note of part.notes ?? []) say(`! ${parts.length > 1 ? `[${part.part}] ` : ''}${note}`);
  for (const part of parts.filter(part => part.language !== 'python' && !part.installed)) {
    const manager = part.manager === 'bun' ? 'npm' : part.manager;
    const where = part.installFolder ?? (part.manager === 'pnpm' || part.workspaces ? root : part.folder);
    // npm: the project's files stay as they are. With a lockfile, `npm ci` installs exactly it;
    // without one (or when it is out of date), `npm install --no-package-lock` writes none.
    const locked = manager === 'npm' && existsSync(join(where, 'package-lock.json'));
    const commands = manager !== 'npm' ? [[manager, 'install']] : locked ? [['npm', 'ci'], ['npm', 'install', '--no-package-lock']] : [['npm', 'install', '--no-package-lock']];
    const yes = await confirm(t('run.installDeps', { part: part.part === '.' ? t('run.theProjectLower') : part.part, command: commands[0].join(' ') }), options);
    if (yes === null) { say(t('run.depsNotInstalled', { command: commands[0].join(' ') })); process.exit(2); }
    if (!yes) continue;
    let result = null;
    for (const [index, command] of commands.entries()) {
      const [bin, ...args] = runnable(command);
      if (index) say(`! ${t('run.lockfileFailed', { command: commands[index - 1].join(' ') })}`);
      say(`  ${t('run.installing', { command: `${bin} ${args.join(' ')}` })}`);
      result = spawnSync(bin, args, { cwd: where, stdio: 'inherit', shell: process.platform === 'win32' });
      if (result.status === 0) break;
    }
    if (result.status !== 0) { say(`✗ ${t('run.installFailed', { code: result.status })}`); process.exit(1); }
    for (const other of parts) if ((other.installFolder ?? other.folder) === where || (where === root && !other.installFolder)) other.installed = true;
  }

  // Prisma 4, 5 or 6.0 without the tracing preview: its operations would be missing, silently.
  for (const part of parts.filter(part => part.language !== 'python')) {
    const prisma = prismaWithoutTracing(part.folder, root);
    if (!prisma) continue;
    say(`! ${parts.length > 1 ? `[${part.part}] ` : ''}${t('run.prismaNoTracing', { version: prisma.version })}`);
    say(`  ${t('run.prismaHow', { schema: prisma.schema })}`);
  }

  // A Python app gets its port on the command line: a port another program
  // holds (AirPlay on 5000, another API on 8000) is replaced before starting.
  // A Vite proxy that reads the API's port from a variable follows it.
  const extraEnv = {};
  const asked = withAskedPort(parts, options);
  if (asked !== parts) { parts = asked; say(`  ${t('run.start', { start: describeStart(parts[0]) })}  (${t('run.portFromOption')})`); }
  for (const [index, part] of parts.entries()) {
    const old = part.port?.value;
    if (part.language !== 'python' || !old || options.command?.length) continue;
    const owners = listeners(old);
    if (!owners?.length) continue;
    const who = owners[0].command;
    const proxies = parts.filter(other => other.language !== 'python').map(other => ({ other, proxy: proxyOf(other.folder, other.script?.command) })).filter(item => item.proxy);
    const fixed = proxies.find(item => item.proxy.literal.includes(old) && !item.proxy.variables.some(variable => variable.port === old));
    if (fixed) {
      say(`✗ ${t('run.apiPortTaken', { port: old, by: ` ${portTakenBy(old, who)}` })}`);
      say(`  ${t('run.proxyFixed', { part: fixed.other.part })}`);
      say(`  ${t('run.closeOrChange')}`);
      process.exit(1);
    }
    const port = await freePort();
    const variable = proxies.flatMap(item => item.proxy.variables).find(item => item.port === old);
    parts[index] = moveTo(part, port);
    if (variable) extraEnv[variable.variable] = String(port);
    // The frontend's .env may give the API's address (VITE_API_URL=http://localhost:8000):
    // the variable goes to the frontend with the new port (the environment wins over .env).
    const addresses = parts.filter(other => other.language !== 'python').flatMap(other => envAddressesOn(other.folder, old).map(item => ({ ...item, part: other.part })));
    for (const item of addresses) extraEnv[item.variable] = item.value.replace(`:${old}`, `:${port}`);
    say(`! ${t('run.portTaken', { port: old, by: ` ${portTakenBy(old, who)}` })}`);
    say(`  ${t('run.startingOn', { what: parts.length > 1 ? t('run.thePartLower', { part: part.part }) : t('run.theApp'), port,
      proxy: variable ? `, ${t('run.proxyFollows', { variable: variable.variable })}` : '' })}`);
    for (const item of addresses) say(`  ${t('run.frontendFollows', { variable: item.variable, file: `${item.part === '.' ? '' : `${item.part}/`}${item.file}`, port })}`);
    say(`  ${t('run.start', { start: describeStart(parts[index]) })}`);
  }
  // Frontend and Python API without a proxy: requests go to another origin (DP3).
  if (parts.some(part => part.language === 'python')) {
    for (const part of parts.filter(part => part.stack === 'Vite' && !proxyOf(part.folder, part.script?.command))) {
      say(`! [${part.part}] ${t('run.viteNoProxy')}`);
      say(`  ${t('run.setProxy')}`);
    }
  }

  // 3. The panel, on a port the application does not use.
  const predicted = new Set(parts.map(part => part.port?.value).filter(Boolean));
  if (options.port) predicted.add(options.port);
  const panel = await ensurePanel(options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000), predicted);
  const panelUrl = `http://127.0.0.1:${panel.port}`;
  for (const other of panel.others) {
    say(`! ${t('run.otherPanel', { version: other.version ? t('run.version', { version: other.version }) : t('run.olderVersion'), port: other.port, own: panel.version })}`);
    say(`  ${t('run.closeOld', { how: other.pid ? `kill ${other.pid}` : t('run.stopOldPanel', { port: other.port }) })}`);
  }
  say(panel.reused ? `  ${t('run.panel', { url: panelUrl })} (${t('run.alreadyRunning')})` : `  ${t('run.panel', { url: panelUrl })}${panel.line ? ` · ${panel.line}` : ''}`);

  // 4. The application, with the fine capture; minimal mode if it does not start.
  let minimal = Boolean(options.minimal);
  let reason = minimal ? t('run.minimalRequested') : null;
  let run = recordingName(project.name) + (minimal ? '-minimal' : '');
  let app = null;
  let found = null;
  const cleanup = () => { stopAll(app?.children ?? []); panel.child?.kill(); };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    say(`\n${t('run.stopping')}`);
    cleanup();
    setTimeout(() => { stopAll(app?.children ?? [], 'SIGKILL'); process.exit(0); }, 4000).unref();
    const check = setInterval(() => { if (!running(app?.children ?? []).length) { clearInterval(check); panel.child?.kill(); process.exit(0); } }, 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const busyTried = new Set();
  const warnedShared = new Set();
  const sharedWarning = (port, command, host) => {
    if (warnedShared.has(port)) return;
    warnedShared.add(port);
    say(`! ${t('run.portShared', { port, command, host: host === '::1' ? '[::1]' : host })}`);
  };
  for (let attempt = 0; attempt < 4 && !found; attempt++) {
    say(`  ${t('run.recording', { run })}${minimal ? ` (${t('run.minimalMode')})` : ''}`);
    say(`  ${t('run.startingApp')}`);
    app = startApp(parts, { run, panelPort: panel.port, minimal, reason, root, extraEnv });
    const summary = createSummary();
    const recording = follow(join(recordings, run), summary.add);
    const deadline = Date.now() + 180_000;
    let warned = false;
    let api = null;
    // Before it is ready, any part that stops (or crashes in a watch mode) is a failed start.
    // A traceback before the app answers is a failed start once nothing answers for 5 s.
    const failed = () => app.children.filter(child => child.exitCode !== null || child.signalCode !== null || child.crashed
      || (child.traceback && Date.now() - child.traceback.at > 5000));
    while (!found && Date.now() < deadline) {
      await wait(500);
      recording.poll();
      // Ports the application really opened (seen by the capture, or written
      // in its output); the predicted ones only decide the order.
      const opened = [...summary.ports, ...app.ports];
      // Pages first: the ports of the parts that serve the browser (Vite, Next…).
      const front = parts.filter(part => /Vite|Next|Nuxt|Astro|Svelte|Remix|React|Angular/.test(part.stack ?? '')).map(part => part.port?.value);
      const candidates = [options.port, ...[...front, ...predicted].filter(port => opened.includes(port)), ...opened];
      const answer = candidates.some(Boolean) ? await findApp(candidates, panel.port, { children: app.children, addresses: summary.addresses, warn: sharedWarning }) : null;
      if (answer?.page) found = answer;
      else if (answer) api ??= { ...answer, at: Date.now() };
      // An API without pages is accepted when nothing else serves pages for a while.
      // Right away only for a known API stack; otherwise pages may still come (Vite after the API…).
      if (!found && api && (Date.now() - api.at > 20_000 || (parts.length === 1 && /^(Express|Fastify|Koa|Hono|NestJS|FastAPI)$/.test(parts[0].stack ?? '')))) found = api;
      if (found) {
        // The other parts may still be failing (a port taken…): a moment to see it.
        await wait(2000);
        if (failed().length) found = null;
        break;
      }
      // A taken port only matters when a part fails because of it: some
      // tools (Next.js) move to the next free port by themselves.
      if (failed().length) break;
      if (!warned && Date.now() - started > 60_000) {
        warned = true;
        say(`  … ${t('run.notAnsweredYet', { time: seconds() })}`);
      }
    }
    if (found) { app.recording = recording; app.summary = summary; break; }
    const stopped = failed();
    stopAll(app.children);
    await wait(800);
    stopAll(app.children, 'SIGKILL');
    // A port already taken by another program: not a problem of the capture.
    // Some servers do not say it (they bind one IP family and stop): the
    // expected port of a part that stopped, held by someone else, says it.
    if (!app.state.busy) {
      for (const child of stopped) {
        const expected = child.part.port?.value;
        if (expected && listeners(expected)?.length) { app.state.busy = expected; break; }
      }
    }
    const busy = stopped.length ? app.state.busy : null;
    // Several parts point at each other's ports (a Vite proxy to the API…):
    // moving one would send its requests to the other program. Only a single
    // part is moved.
    if (busy && parts.length > 1) {
      const who = holder(busy);
      say(`✗ ${t('run.portNeeded', { port: busy, by: who ? ` ${t('run.takenBy', { who })}` : '' })}`);
      say(`  ${t('run.notMoving')}`);
      cleanup();
      process.exit(1);
    }
    if (busy && !busyTried.has(busy)) {
      busyTried.add(busy);
      const who = holder(busy);
      const port = await freePort();
      predicted.add(port);
      if (parts[0].language === 'python') {
        parts[0] = moveTo(parts[0], port);
        say(`! ${t('run.portTaken', { port: busy, by: ` ${portTakenBy(busy, who)}` })} ${t('run.startingAppOn', { port })}`);
      } else {
        extraEnv.PORT = String(port);
        say(`! ${t('run.portTaken', { port: busy, by: who ? ` ${t('run.takenBy', { who })}` : '' })} ${t('run.startingAppOnVariable', { port })}`);
      }
      run = recordingName(project.name) + (minimal ? '-minimal' : '');
      continue;
    }
    if (busy) {
      say(`✗ ${t('run.stillTaken', { port: busy, who: holder(busy) ? ` (${holder(busy)})` : '' })}`);
      say(`  ${t('run.closeProgram')}`);
      cleanup();
      process.exit(1);
    }
    if (!stopped.length) {
      say(`✗ ${t('run.noPort', { time: seconds() })}`);
      say(`  ${t('run.givePort')}`);
      cleanup();
      process.exit(1);
    }
    const codes = stopped.map(child => describeFailure({ ...child, part: child.part.part }, parts.length > 1)).join(', ');
    // A Python error raised by the app's own code: minimal mode would fail the same way.
    const own = !minimal && stopped.map(child => ({ child, where: ownError(child.traceback, child.part.folder) })).find(item => item.where);
    // A start command that does not exist: minimal mode would fail the same way.
    const missing = stopped.find(child => child.spawnError);
    if (missing) {
      say(`✗ ${missing.spawnError}`);
      say(`  ${t('run.giveTypedCommand')}`);
      cleanup();
      process.exit(1);
    }
    // Exit code 127: the shell did not find a command of the script (bun, a CLI not installed).
    // Minimal mode would fail the same way; the lines that say it are that part's.
    const notFound = stopped.find(child => child.exitCode === 127);
    if (notFound) {
      say(`✗ ${parts.length > 1 ? `[${notFound.part.part}] ` : ''}${t('run.exit127')}`);
      for (const line of notFound.tail.slice(-4)) say(`    ${line}`);
      say(`  ${t('run.installProgram')}`);
      cleanup();
      process.exit(1);
    }
    if (own) {
      say(`✗ ${t('run.appFailed', { failure: describeFailure({ ...own.child, part: own.child.part.part }, parts.length > 1) })}`);
      say(`  ${t('run.raisedIn', { place: `${own.where.file}:${own.where.line}` })}`);
      say(`  ${t('run.tipConfig')}`);
      cleanup();
      process.exit(1);
    }
    if (minimal) {
      say(`✗ ${t('run.failedMinimal', { codes })}`);
      say(`  ${t('run.problemInApp')}`);
      for (const line of app.tail.slice(-12)) say(`    ${line}`);
      say(`  ${t('run.tipDiagnose')}`);
      cleanup();
      process.exit(1);
    }
    minimal = true;
    reason = t('run.fullFailedReason', { codes });
    run = `${run}-minimal`;
    say(`! ${t('run.fullFailed', { codes })}`);
    say(`  ${t('run.retryMinimal')}`);
  }
  if (!found) { say(`✗ ${t('run.couldNotStartApp')}`); cleanup(); process.exit(1); }

  // 5. Ready: where to go, and the first dossier.
  const appUrl = found.url ?? `http://localhost:${found.port}/`;
  say('');
  say(`✓ ${t('run.ready', { url: appUrl, time: seconds() })}${minimal ? ` · ${t('run.minimalMode')}` : ''}`);
  // The capture may have chosen the minimal mode by itself (Python below the minimum…).
  // (Unless it was announced before starting: a Python below the minimum.)
  if (!minimal && !parts.some(part => part.python?.version && versionBelow(part.python.version))) {
    const own = app.summary.starts.find(start => start.level === 'minimo');
    if (own) say(`! ${t('run.minimalBySelf', { reason: own.reason })}`);
  }
  if (found.status >= 500) say(`! ${t('run.homeError', { status: found.status })}`);
  if (found.page) {
    say(`  ${t('run.openIt')}`);
    say(`  ${t('run.eachAction')}`);
    if (!options.noOpen && interactive) openBrowser(appUrl);
  } else if (found.status === 404 && parts.some(part => /Vite|Next|Nuxt|Astro|Svelte|Remix|React|Angular/.test(part.stack ?? ''))) {
    // A frontend that answers 404 on its home page is not an API: it did not find its page.
    say(`! ${t('run.home404')}`);
    say(`  ${t('run.home404Dossier')}`);
  } else if (parts.length === 1 && parts[0].stack === 'FastAPI') {
    // The interactive documentation is a page: the bar appears there, and each «Try it out» is an action.
    const docs = `${appUrl}docs`;
    say(`  ${t('run.isApi')}`);
    say(`  ${t('run.tryDocs', { url: docs })}`);
    if (!options.noOpen && interactive) openBrowser(docs);
  } else {
    say(`  ${t('run.noPages')}`);
  }
  say(`  ${t('run.panel', { url: panelUrl })}  ·  ${t('run.stopKeys')}`);
  say('');
  let firstShown = false;
  let silentWarned = false;
  const seenActions = new Set();
  const { recording, summary } = app;
  const watcher = setInterval(() => {
    recording.poll();
    for (const id of summary.actions) {
      if (seenActions.has(id)) continue;
      seenActions.add(id);
      const link = `${panelUrl}/?action=${encodeURIComponent(id)}`;
      if (!firstShown) { firstShown = true; say(`✓ ${t('run.firstDossier', { time: seconds(), link })}`); }
      else say(`• ${t('run.actionRecorded', { link })}`);
    }
    // A page that loads but where nothing is clicked yet (or that fails to
    // render): the dossier of its own load.
    if (!firstShown && summary.firstPage && Date.now() - summary.firstPage.seenAt > 8000) {
      firstShown = true;
      say(`✓ ${t('run.firstDossierPage', { time: seconds(), link: `${panelUrl}/?request=${encodeURIComponent(summary.firstPage.requestId)}` })}`);
      say(`  ${t('run.eachClick')}`);
    }
    if (!firstShown && summary.firstRequest && !found.page) {
      firstShown = true;
      say(`✓ ${t('run.firstDossier', { time: seconds(), link: `${panelUrl}/?request=${encodeURIComponent(summary.firstRequest.requestId)}` })}`);
    }
    if (!silentWarned && !minimal && summary.requests >= 3 && !summary.withFunctions.size && summary.functions === 0) {
      silentWarned = true;
      say(`! ${t('run.noFunctions')}`);
      say(`  ${t('run.diagnoseExplains')}`);
    }
    // A part that fails later with a taken port: its requests could reach the
    // other program (a proxy to that port). Everything stops.
    const down = app.children.filter(child => child.exitCode !== null || child.signalCode !== null || child.crashed);
    if (app.state.busy && down.length && parts.length > 1 && !stopping) {
      clearInterval(watcher);
      const who = holder(app.state.busy);
      say(`✗ ${t('run.partFailedPort', { port: app.state.busy, by: who ? ` ${t('run.takenBy', { who })}` : '' })}`);
      say(`  ${t('run.stoppingForPort')}`);
      stop();
      return;
    }
    if (!running(app.children).length && !stopping) {
      clearInterval(watcher);
      say(t('run.stopped'));
      panel.child?.kill();
      process.exit(0);
    }
  }, 700);
}

main().catch(error => {
  say(`✗ ${error.message}`);
  process.exit(1);
});
