#!/usr/bin/env node
// Comando `codetac` (Fase 5): numa pasta de projeto, descobre como arrancá-lo,
// arranca o painel e a app com a captura e diz onde abrir. Se a app não
// arrancar com a instrumentação fina, arranca-a de novo em modo mínimo.
//   codetac [pasta] [opções] [-- comando de arranque]
//   codetac diagnostico [pasta]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, homedir, release } from 'node:os';
import http from 'node:http';
import { basename, join, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { detectProject, describeStart, foreignRuntime } from './detect.mjs';
import { createSummary, follow } from './recording.mjs';

import { dataDirectory, install as workspace } from './home.mjs';

const recordings = dataDirectory();
const register = pathToFileURL(join(workspace, 'src', 'register.mjs')).href;
const started = Date.now();
const seconds = () => `${Math.round((Date.now() - started) / 1000)} s`;
const say = text => process.stdout.write(`${text}\n`);
const HELP = `Uso:
  codetac [pasta] [opções] [-- comando]   arranca a app da pasta (por omissão, a atual) com o CodeTAC
  codetac diagnostico [pasta]              explica o que está e o que não está a funcionar
  codetac relatorio [pasta]                guarda o diagnóstico num ficheiro para enviar com uma incidência
  codetac --version                        versão instalada

Opções:
  --script <nome>      script do package.json a usar (por omissão: dev, start…)
  --parte <pasta>      num projeto com várias partes, qual arrancar (pode repetir)
  --porta <n>          porta da app, se não for descoberta sozinha
  --painel <n>         porta do painel (por omissão 4000)
  --minimo             não seguir as funções do projeto (só pedidos e fronteiras)
  --sim                responder «sim» às perguntas (instalar dependências…)
  --nao-abrir          não abrir o browser
  -- <comando>         comando de arranque, quando não for descoberto (ex.: -- node server.js)`;

function parseArgs(argv) {
  const options = { parts: [], command: null, folder: null, sub: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--') { options.command = argv.slice(index + 1); break; }
    else if (arg === '--script') options.script = value();
    else if (arg === '--parte') options.parts.push(value());
    else if (arg === '--porta') options.port = Number(value());
    else if (arg === '--painel') options.panelPort = Number(value());
    else if (arg === '--minimo') options.minimal = true;
    else if (arg === '--sim') options.yes = true;
    else if (arg === '--nao-abrir') options.noOpen = true;
    else if (arg === '-h' || arg === '--help' || arg === 'ajuda') options.sub = 'ajuda';
    else if (!options.sub && !options.folder && ['diagnostico', 'diagnóstico'].includes(arg)) options.sub = 'diagnostico';
    else if (!options.sub && !options.folder && ['relatorio', 'relatório'].includes(arg)) options.sub = 'relatorio';
    else if (arg === '-v' || arg === '--version' || arg === 'versao') options.sub = 'versao';
    else if (!options.folder && !arg.startsWith('-')) options.folder = arg;
    else { say(`Opção desconhecida: ${arg}\n\n${HELP}`); process.exit(2); }
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
  const answer = await ask(`${question} [S/n]`);
  if (answer === null) return null;
  return !/^n/i.test(answer);
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

// The panel: reuses one already running, or starts it.
async function ensurePanel(port, avoid) {
  for (let candidate = port; candidate < port + 20; candidate++) {
    if (avoid.has(candidate)) continue;
    const ping = await get(candidate, '/api/ping');
    if (ping?.status === 200 && ping.body.includes('"ok":true')) return { port: candidate, reused: true };
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
      if (ok?.status === 200) return { port: candidate, child, line: first.split('\n')[0] };
    }
    child.kill();
    if (/EADDRINUSE/.test(first)) continue;
    throw new Error(`O painel não arrancou: ${first.trim().split('\n').slice(-3).join(' ')}`);
  }
  throw new Error('Não encontrei uma porta livre para o painel.');
}

function recordingName(name) {
  const slug = String(name).toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projeto';
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
  };
  // The application's output goes through a pipe: its colours stay when the terminal has them.
  if (process.stdout.isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1';
  Object.assign(env, extraEnv);
  if (minimal) Object.assign(env, { CODETAC_LEVEL: 'minimo', CODETAC_MINIMO_MOTIVO: reason });
  for (const part of parts) {
    const [bin, ...args] = runnable(part.command);
    const child = spawn(bin, args, { cwd: part.folder, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      shell: process.platform === 'win32' });
    const label = parts.length > 1 ? `[${part.part}] ` : '';
    const show = chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        process.stdout.write(`  │ ${label}${line}\n`);
        const plain = line.replace(ANSI, '');
        tail.push(`${label}${plain}`);
        if (tail.length > 40) tail.shift();
        for (const match of plain.matchAll(URL_IN_OUTPUT)) if (match[1]) ports.push(Number(match[1]));
        // Watch modes (node --watch, nodemon, tsx watch) keep running after a crash.
        if (CRASHED.test(plain)) child.crashed = true;
        const busy = plain.match(BUSY);
        if (busy) state.busy = Number(busy[1] ?? busy[2] ?? busy[3]);
      }
    };
    child.stdout.on('data', show);
    child.stderr.on('data', show);
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

function stopAll(children, signal = 'SIGTERM') {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
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
        host = /^\[?::1\]?$/.test(bound) ? '::1' : '127.0.0.1';
        warn(port, others[0].command ?? 'outro programa', host);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.sub === 'ajuda') { say(HELP); return; }
  if (options.sub === 'versao') { say(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version); return; }
  const folder = resolve(options.folder ?? process.cwd());
  if (!existsSync(folder)) { say(`A pasta ${folder} não existe.`); process.exit(2); }
  const root = realpathSync(folder);
  if (options.sub === 'relatorio') {
    // The diagnosis in a file to send with an incident: no code, no values;
    // the home folder is shortened to ~.
    const { diagnose } = await import('./diagnose.mjs');
    const lines = [];
    const version = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version;
    lines.push(`codeTAC ${version} · Node ${process.version} · ${process.platform} ${arch()} · ${release()}`, '');
    await diagnose(root, { panelPort: options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000), out: text => lines.push(text) });
    const text = lines.join('\n').split(homedir()).join('~') + '\n';
    mkdirSync(recordings, { recursive: true });
    const file = join(recordings, `relatorio-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(file, text);
    say(text);
    say(`Relatório guardado em ${file.split(homedir()).join('~')}`);
    say('Não contém código nem valores da app: só o que está acima. Envie-o com a descrição do problema em');
    say('  https://github.com/deltaxmodules/codeTac_V2/issues/new');
    return;
  }
  if (options.sub === 'diagnostico') {
    const { diagnose } = await import('./diagnose.mjs');
    process.exitCode = await diagnose(root, { panelPort: options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000) });
    return;
  }

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 24) say(`! Este Node é o ${process.version}; o CodeTAC foi feito para o Node 24 ou superior. Vou tentar na mesma.`);

  // 1. How to start the project.
  const project = detectProject(root);
  let parts = project.start;
  if (options.command?.length) {
    parts = [{ folder: root, part: '.', name: project.name, command: options.command, script: null, stack: null, port: null, installed: true, foreign: foreignRuntime(options.command.join(' ')) }];
  } else if (options.parts.length) {
    parts = options.parts.map(name => project.parts.find(part => part.part === name || basename(part.folder) === name) ?? (name === '.' ? project.top : null)).filter(Boolean);
    if (!parts.length) { say(`Não encontrei a parte ${options.parts.join(', ')}. Partes: ${project.parts.map(part => part.part).join(', ') || 'nenhuma'}.`); process.exit(2); }
  } else if (options.script) {
    const base = project.top ?? project.start[0];
    if (!base) { say('Não há package.json nesta pasta para escolher um script.'); process.exit(2); }
    parts = [{ ...base, script: { name: options.script, command: '' }, command: [base.runner, 'run', options.script] }];
  }
  say(`CodeTAC · ${project.name} (${root})`);
  if (!parts.length && project.missing.includes('part')) {
    say('Este projeto tem várias partes que se podem arrancar:');
    const answer = await ask('Quais arranco? (números separados por vírgulas, ou Enter para todas)', project.parts.map(describeStart));
    if (answer === null) parts = project.parts;
    else parts = answer ? answer.split(/[\s,]+/).map(n => project.parts[Number(n) - 1]).filter(Boolean) : project.parts;
  }
  if (!parts.length) {
    say(project.missing.includes('package')
      ? 'Não encontrei um package.json nem um ficheiro de servidor (server.js, index.js…) nesta pasta.'
      : 'Não encontrei um script de arranque (dev, start…) no package.json.');
    const answer = await ask('Que comando arranca a app? (ex.: node server.js, ou Enter para sair)');
    if (!answer) { say('Indique o comando depois de --, por exemplo: codetac . -- node server.js'); process.exit(2); }
    parts = [{ folder: root, part: '.', name: project.name, command: answer.split(/\s+/), script: null, stack: null, port: null, installed: true, foreign: foreignRuntime(answer) }];
  }
  for (const part of parts) say(`  Arranque: ${describeStart(part)}`);
  for (const part of parts.filter(part => part.foreign)) {
    say(`! [${part.part}] O script usa ${part.foreign}, que não é o Node: essa parte corre, mas o CodeTAC não a consegue observar por dentro.`);
  }

  // 2. Dependencies.
  for (const part of parts.filter(part => !part.installed)) {
    const manager = part.manager === 'bun' ? 'npm' : part.manager;
    const where = part.installFolder ?? (part.manager === 'pnpm' || part.workspaces ? root : part.folder);
    const yes = await confirm(`As dependências de ${part.part === '.' ? 'o projeto' : part.part} não estão instaladas. Instalar agora com «${manager} install»?`, options);
    if (yes === null) { say(`As dependências não estão instaladas. Corra «${manager} install» na pasta ou use --sim.`); process.exit(2); }
    if (!yes) continue;
    const [bin, ...args] = runnable([manager, 'install']);
    say(`  A instalar (${bin} ${args.join(' ')})…`);
    const result = spawnSync(bin, args, { cwd: where, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) { say(`✗ A instalação falhou (código ${result.status}). Veja as mensagens acima.`); process.exit(1); }
    for (const other of parts) if ((other.installFolder ?? other.folder) === where || (where === root && !other.installFolder)) other.installed = true;
  }

  // 3. The panel, on a port the application does not use.
  const predicted = new Set(parts.map(part => part.port?.value).filter(Boolean));
  if (options.port) predicted.add(options.port);
  const panel = await ensurePanel(options.panelPort ?? Number(process.env.CODETAC_PANEL_PORT || 4000), predicted);
  const panelUrl = `http://127.0.0.1:${panel.port}`;
  say(panel.reused ? `  Painel: ${panelUrl} (já estava a correr)` : `  Painel: ${panelUrl}${panel.line ? ` · ${panel.line}` : ''}`);

  // 4. The application, with the fine capture; minimal mode if it does not start.
  let minimal = Boolean(options.minimal);
  let reason = minimal ? 'pedido com --minimo' : null;
  let run = recordingName(project.name) + (minimal ? '-minimo' : '');
  let app = null;
  let found = null;
  const cleanup = () => { stopAll(app?.children ?? []); panel.child?.kill(); };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    say('\nA terminar a app e o painel…');
    cleanup();
    setTimeout(() => { stopAll(app?.children ?? [], 'SIGKILL'); process.exit(0); }, 4000).unref();
    const check = setInterval(() => { if (!running(app?.children ?? []).length) { clearInterval(check); panel.child?.kill(); process.exit(0); } }, 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const extraEnv = {};
  const busyTried = new Set();
  const warnedShared = new Set();
  const sharedWarning = (port, command, host) => {
    if (warnedShared.has(port)) return;
    warnedShared.add(port);
    say(`! A porta ${port} também está a ser usada por outro programa (${command}). Para não o abrir por engano, uso o endereço ${host === '::1' ? '[::1]' : host}.`);
  };
  for (let attempt = 0; attempt < 4 && !found; attempt++) {
    say(`  Gravação: ${run}${minimal ? ' (modo mínimo)' : ''}`);
    say('  A arrancar a app…');
    app = startApp(parts, { run, panelPort: panel.port, minimal, reason, root, extraEnv });
    const summary = createSummary();
    const recording = follow(join(recordings, run), summary.add);
    const deadline = Date.now() + 180_000;
    let warned = false;
    let api = null;
    // Before it is ready, any part that stops (or crashes in a watch mode) is a failed start.
    const failed = () => app.children.filter(child => child.exitCode !== null || child.signalCode !== null || child.crashed);
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
      if (!found && api && (Date.now() - api.at > 20_000 || (parts.length === 1 && /^(Express|Fastify|Koa|Hono|NestJS)$/.test(parts[0].stack ?? '')))) found = api;
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
        say(`  … a app ainda não respondeu (${seconds()}). Algumas demoram na primeira vez.`);
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
      say(`✗ A porta ${busy} já está ocupada${who ? ` por outro programa (${who})` : ''}, e uma parte da app precisa dela.`);
      say('  Não a mudo sozinho: as outras partes da app contam com essa porta. Feche esse programa e volte a correr o comando.');
      cleanup();
      process.exit(1);
    }
    if (busy && !busyTried.has(busy)) {
      busyTried.add(busy);
      const who = holder(busy);
      const port = await freePort();
      extraEnv.PORT = String(port);
      predicted.add(port);
      say(`! A porta ${busy} já está ocupada${who ? ` por outro programa (${who})` : ''}. Vou arrancar a app na porta ${port} (variável PORT).`);
      run = recordingName(project.name) + (minimal ? '-minimo' : '');
      continue;
    }
    if (busy) {
      say(`✗ A porta ${busy} continua ocupada${holder(busy) ? ` (${holder(busy)})` : ''} e a app não aceita outra pela variável PORT.`);
      say('  Feche o programa que usa essa porta e volte a correr o comando.');
      cleanup();
      process.exit(1);
    }
    if (!stopped.length) {
      say(`✗ A app não abriu nenhuma porta em ${seconds()}.`);
      say('  Se a app usa uma porta que não escreve no terminal, indique-a: codetac . --porta <n>');
      cleanup();
      process.exit(1);
    }
    const codes = stopped.map(child => `${child.part.part}: ${child.crashed ? 'falhou' : `código ${child.exitCode ?? child.signalCode}`}`).join(', ');
    if (minimal) {
      say(`✗ A app falhou também em modo mínimo (${codes}).`);
      say('  O problema parece ser da própria app, não da captura. Últimas linhas:');
      for (const line of app.tail.slice(-12)) say(`    ${line}`);
      say('  Dica: faltam dependências ou variáveis de ambiente (.env)? «codetac diagnostico» ajuda a ver.');
      cleanup();
      process.exit(1);
    }
    minimal = true;
    reason = `a app falhou ao arrancar com a instrumentação fina (${codes})`;
    run = `${run}-minimo`;
    say(`! A app falhou durante o arranque com a captura completa (${codes}).`);
    say('  Vou arrancá-la de novo em modo mínimo: pedidos, fronteiras e browser, sem seguir as funções do projeto.');
  }
  if (!found) { say('✗ Não foi possível arrancar a app.'); cleanup(); process.exit(1); }

  // 5. Ready: where to go, and the first dossier.
  const appUrl = found.url ?? `http://localhost:${found.port}/`;
  say('');
  say(`✓ App pronta em ${appUrl} (${seconds()})${minimal ? ' · modo mínimo' : ''}`);
  if (found.status >= 500) say(`! A página inicial respondeu com erro ${found.status}. Veja as mensagens da app acima (faltam variáveis de ambiente?). O dossiê desse pedido mostra onde falhou.`);
  if (found.page) {
    say('  Abra-a no browser e use-a: a barra do CodeTAC aparece no canto inferior direito.');
    say('  Cada ação (clique, formulário…) fica com um dossiê; a barra abre-o.');
    if (!options.noOpen && interactive) openBrowser(appUrl);
  } else {
    say('  Esta app responde sem páginas HTML (uma API). Faça pedidos como de costume; cada pedido fica com um dossiê no painel.');
  }
  say(`  Painel: ${panelUrl}  ·  Terminar: Ctrl+C`);
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
      if (!firstShown) { firstShown = true; say(`✓ Primeiro dossiê (${seconds()} desde o comando): ${link}`); }
      else say(`• Ação gravada: ${link}`);
    }
    // A page that loads but where nothing is clicked yet (or that fails to
    // render): the dossier of its own load.
    if (!firstShown && summary.firstPage && Date.now() - summary.firstPage.seenAt > 8000) {
      firstShown = true;
      say(`✓ Primeiro dossiê (${seconds()} desde o comando), o do carregamento da página: ${panelUrl}/?request=${encodeURIComponent(summary.firstPage.requestId)}`);
      say('  Cada clique na app terá o seu próprio dossiê.');
    }
    if (!firstShown && summary.firstRequest && !found.page) {
      firstShown = true;
      say(`✓ Primeiro dossiê (${seconds()} desde o comando): ${panelUrl}/?request=${encodeURIComponent(summary.firstRequest.requestId)}`);
    }
    if (!silentWarned && !minimal && summary.requests >= 3 && !summary.withFunctions.size && summary.functions === 0) {
      silentWarned = true;
      say('! Já chegaram pedidos, mas nenhuma função do projeto foi observada. Os dossiês mostram pedidos e fronteiras.');
      say('  «codetac diagnostico» explica porquê.');
    }
    // A part that fails later with a taken port: its requests could reach the
    // other program (a proxy to that port). Everything stops.
    const down = app.children.filter(child => child.exitCode !== null || child.signalCode !== null || child.crashed);
    if (app.state.busy && down.length && parts.length > 1 && !stopping) {
      clearInterval(watcher);
      const who = holder(app.state.busy);
      say(`✗ Uma parte da app falhou: a porta ${app.state.busy} está ocupada${who ? ` por outro programa (${who})` : ''}.`);
      say('  Paro a app, para que os pedidos dela não cheguem a esse programa. Feche-o e volte a correr o comando.');
      stop();
      return;
    }
    if (!running(app.children).length && !stopping) {
      clearInterval(watcher);
      say('A app terminou.');
      panel.child?.kill();
      process.exit(0);
    }
  }, 700);
}

main().catch(error => {
  say(`✗ ${error.message}`);
  process.exit(1);
});
