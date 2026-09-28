// Ensaio da Etapa 12 Python: o comando `codetac` numa pasta Python, sem configuração.
//   node scripts/accept-codetac-python.mjs [--instalar]
// 1. Exemplos 1–4 no Chrome, pelo accept-sample.mjs (scripts/ensaios/amostra-python-exemplos.json):
//    arrancam só com `codetac`, com funções do projeto nos dossiers, e o diagnóstico
//    mostra o Python e o servidor. Porta 5000 do AirPlay e 8000 ocupada: explicadas.
// 2. Python abaixo de 3.12 (o 3.9 do macOS, num .venv criado pelo uv numa cópia do
//    exemplo 1): modo mínimo, explicado antes e confirmado pela captura.
// 3. DP5 sem terminal: sem .venv, o comando mostra o que correria e para, sem criar nada.
//    Com --instalar, também com --yes: cria o .venv, instala e arranca (precisa de rede).
// No fim: fixtures inalteradas, nenhum processo dos ensaios ativo, gravações apagadas.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../src/home.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const cli = join(workspace, 'src', 'cli.mjs');
const install = process.argv.includes('--instalar');
const started = Date.now();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const gitStatus = () => spawnSync('git', ['status', '--porcelain', '--', 'fixtures/python'], { cwd: workspace, encoding: 'utf8' }).stdout;
const holder = port => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc'], { encoding: 'utf8' }).stdout?.split('\n').find(line => line.startsWith('c'))?.slice(1) ?? null;
const temporary = [];
function copyExample(name, { venv }) {
  const folder = mkdtempSync(join(tmpdir(), `ctpy12-${name}-`));
  temporary.push(folder);
  const source = join(workspace, 'fixtures/python', name);
  for (const entry of readdirSync(source)) {
    if (['.venv', '__pycache__'].includes(entry) || entry.startsWith('aceitacao')) continue;
    cpSync(join(source, entry), join(folder, entry), { recursive: true });
  }
  if (venv) {
    for (const [command, args] of [['uv', ['venv', '-q', '--python', venv, '.venv']], ['uv', ['pip', 'install', '-q', '--python', '.venv/bin/python', '-r', 'requirements.txt']]]) {
      const result = spawnSync(command, args, { cwd: folder, stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} falhou`);
    }
  }
  return folder;
}

// One run of the command: its lines, until a pattern or the end.
function runCommand(folder, args = []) {
  const child = spawn(process.execPath, [cli, folder, '--no-open', '--panel-port', '4100', ...args],
    { cwd: workspace, env: { ...process.env, CODETAC_AI_PROVIDER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const run = { child, text: '' };
  child.stdout.on('data', chunk => { run.text += chunk; });
  child.stderr.on('data', chunk => { run.text += chunk; });
  // 'close', not 'exit': after 'exit' the last output may still be in the pipes.
  child.on('close', () => { run.closed = true; });
  run.until = async (pattern, timeout = 180_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end && !pattern.test(run.text) && !run.closed) await delay(250);
    return run.text.match(pattern);
  };
  run.stop = async () => {
    if (child.exitCode === null) try { process.kill(-child.pid, 'SIGINT'); } catch {}
    const end = Date.now() + 12_000;
    while (child.exitCode === null && Date.now() < end) await delay(200);
    if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  return run;
}
const lastRecording = prefix => readdirSync(dataDirectory()).filter(name => name.startsWith(prefix))
  .map(name => ({ name, time: statSync(join(dataDirectory(), name)).mtimeMs })).filter(item => item.time >= started).sort((a, b) => b.time - a.time)[0]?.name;
function firstEvents(recording) {
  const folder = join(dataDirectory(), recording);
  return readdirSync(folder).filter(file => file.endsWith('.jsonl')).map(file => JSON.parse(readFileSync(join(folder, file), 'utf8').split('\n')[0]));
}

const before = gitStatus();
const airplay = process.platform === 'darwin' && /ControlCe/.test(holder(5000) ?? '');
const taken8000 = Boolean(holder(8000));

// 1. Examples 1–4 in Chrome.
process.stdout.write('== Exemplos 1–4 no Chrome (accept-sample.mjs)\n');
const sample = spawnSync(process.execPath, [join(workspace, 'scripts/accept-sample.mjs'), join(workspace, 'scripts/ensaios/amostra-python-exemplos.json')],
  { cwd: workspace, encoding: 'utf8', timeout: 1_200_000 });
const file = sample.stdout.match(/Resultados: (\S+)/)?.[1];
const sampled = file ? JSON.parse(readFileSync(file, 'utf8')) : [];
check('accept-sample: os 4 exemplos correram', sampled.length === 4, file ?? sample.stderr.slice(-300));
for (const item of sampled) {
  check(`${item.nome}: arranca só com codetac e chega ao dossier`, item.aceite,
    `pronta ${Math.round(item.prontaMs / 1000)} s, primeiro dossier ${Math.round((item.primeiroDossieMs ?? 0) / 1000)} s, ${item.tipoDossie ?? '—'}, ${item.comFuncoes} pedido(s) com funções`);
  check(`${item.nome}: diagnóstico com o Python e o servidor`, /Python 3\.\d+\.\d+ \(\.venv\/bin\/python\)/.test(item.diagnostico) && /Server: (uvicorn|werkzeug)/.test(item.diagnostico));
  const moved = item.saida.join('\n');
  if (item.nome === 'py-flask-sqlite' && airplay) check('porta 5000 do AirPlay explicada, com outra porta', /macOS AirPlay Receiver/.test(moved) && /Starting the app on port \d+/.test(moved));
  if (item.nome !== 'py-flask-sqlite' && taken8000) check(`${item.nome}: porta 8000 ocupada explicada, com outra porta`, /Port 8000 is already taken/.test(moved) && /on port \d+/.test(moved));
  if (item.nome === 'py-mixed' && taken8000) check('py-mixed: o proxy do Vite segue a porta nova da API', /the Vite proxy follows it \(variable API_PORT\)/.test(moved) && item.dossie?.funcoes > 0);
}
if (!airplay) check('porta 5000 do AirPlay', true, 'não ensaiada: a 5000 não está com o AirPlay nesta máquina');

// 2. Python below the minimum: minimal mode, explained.
process.stdout.write('\n== Python abaixo de 3.12\n');
const old = spawnSync('/usr/bin/python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).stdout?.trim();
if (old && Number(old.split('.')[1]) < 12 && old.startsWith('3.')) {
  const folder = copyExample('flask-sqlite', { venv: '/usr/bin/python3' });
  const run = runCommand(folder);
  const ready = await run.until(/✓ App ready at (\S+)/);
  if (ready) await fetch(ready[1]).catch(() => null);
  await delay(1500);
  await run.stop();
  const recording = lastRecording('ctpy12-flask-sqlite');
  const starts = recording ? firstEvents(recording) : [];
  check(`Python ${old}: a app arranca`, Boolean(ready));
  check(`Python ${old}: explicado antes de arrancar`, new RegExp(`The project's Python is ${old.replace('.', '\\.')}\\.\\d+: the app runs in minimal mode`).test(run.text));
  check(`Python ${old}: a captura ficou em modo mínimo, com o motivo`, starts.length && starts.every(event => event.level === 'minimo' && /cannot follow the functions/.test(event.reason ?? '')),
    starts.map(event => `${event.python} ${event.level}`).join(', '));
} else check('Python abaixo de 3.12', false, 'não há um Python 3.8–3.11 em /usr/bin/python3');

// 3. DP5: no environment.
process.stdout.write('\n== DP5: projeto sem .venv\n');
{
  const folder = copyExample('fastapi-sync', { venv: null });
  const run = runCommand(folder);
  await run.until(/(?!)/, 30_000); // never matches: waits for the end
  check('sem terminal: mostra os comandos e para (código 2)', run.child.exitCode === 2 && /has no Python environment \(\.venv\)/.test(run.text) && /(uv venv|-m venv)/.test(run.text) && /-r requirements\.txt/.test(run.text),
    run.text.split('\n').filter(line => /^\s{4}/.test(line)).map(line => line.trim()).join(' ; '));
  check('sem terminal: não cria nada', !existsSync(join(folder, '.venv')));
  if (install) {
    const second = runCommand(folder, ['--yes']);
    const ready = await second.until(/✓ App ready at (\S+)/, 300_000);
    const status = ready ? (await fetch(new URL('report', ready[1])).catch(() => null))?.status : null;
    await delay(1500);
    await second.stop();
    check('com --yes: cria o .venv, instala e arranca', Boolean(ready) && existsSync(join(folder, '.venv/pyvenv.cfg')) && status === 200, `GET /report → ${status}`);
  }
}

// The end: fixtures unchanged, nothing left running, recordings removed.
await delay(1000);
check('fixtures/python inalteradas (git status)', gitStatus() === before);
const left = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter(line => /fixtures\/python|ctpy12-/.test(line) && !line.includes('accept-codetac-python'));
check('nenhum processo dos ensaios ficou ativo', !left.length, left.slice(0, 3).join(' | '));
let removed = 0;
for (const name of readdirSync(dataDirectory())) {
  if (!/^(flask-sqlite|fastapi-async|fastapi-sync|mixed|ctpy12-[\w-]+?)-\d{8}-\d{6}/.test(name)) continue;
  const path = join(dataDirectory(), name);
  if (statSync(path).mtimeMs < started) continue;
  rmSync(path, { recursive: true, force: true });
  removed++;
}
for (const folder of temporary) rmSync(folder, { recursive: true, force: true });
process.stdout.write(`(gravações dos ensaios apagadas: ${removed})\n`);

const passed = results.filter(item => item.ok).length;
const out = join(dataDirectory(), `codetac-python-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), airplay, taken8000, results, sample: file }, null, 2));
process.stdout.write(`\n${passed} de ${results.length} verificações. Relatório: ${out}\n`);
process.exitCode = passed === results.length ? 0 : 1;
