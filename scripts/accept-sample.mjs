// Ensaio da Fase 5: para cada projeto da amostra, corre o comando `codetac`
// sem ajuda (--yes --no-open), abre a app no Chrome, clica num elemento e
// mede o tempo do comando ao primeiro dossier. Verifica que o dossier existe e
// que nada diz «não suportado». Uso:
//   node scripts/accept-sample.mjs <config.json> [nome…]
// A configuração: { "painel": 4100, "projetos": [{ "nome", "pasta", "ferramenta",
//   "stack", "clicar"?: seletor, "pagina"?: caminho, "pedidos"?: [caminhos], "explicacao"?: expressão, "args"?: [], "env"?: {} }] }
// Com "explicacao", o comando pode parar sem dossier se disser isso (a especificação aceita
// «dossier ou uma explicação clara»): o resultado fica marcado como explicação.
// Com "pedidos" (uma API: o clique no /docs não chama rotas), esses GET são feitos
// antes do diagnóstico, e o ensaio exige pedidos com funções do projeto.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChrome } from './lib/chrome.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const configPath = resolve(process.argv[2] ?? '');
const only = new Set(process.argv.slice(3));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const panelPort = config.painel ?? 4100;
// The command under test: this checkout, or an installed one (CODETAC_CLI=…/bin/codetac).
const cli = process.env.CODETAC_CLI ? [process.env.CODETAC_CLI] : [process.execPath, join(workspace, 'src', 'cli.mjs')];
const LIMIT_MS = 5 * 60 * 1000;
const UNSUPPORTED = /não suportad|not supported|unsupported/i;

function getJson(path) {
  return new Promise(done => {
    http.get({ host: '127.0.0.1', port: panelPort, path, headers: { host: `127.0.0.1:${panelPort}` } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { done({ status: response.statusCode, json: JSON.parse(body), text: body }); } catch { done({ status: response.statusCode, text: body }); } });
    }).on('error', () => done(null));
  });
}

// Candidates to click: visible, inside the viewport, not destructive, not CodeTAC's.
const CANDIDATES = `(() => {
  const avoid = /(sair|logout|log out|sign out|apagar|eliminar|delete|remove|excluir)/i;
  const out = [];
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=tab], input[type=submit], summary')) {
    if (e.closest('codetac-bar') || e.disabled) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight - 10 || r.right < 0 || r.left > innerWidth) continue;
    const text = (e.innerText || e.getAttribute('aria-label') || e.value || '').trim().slice(0, 60);
    if (avoid.test(text)) continue;
    const href = e.getAttribute('href') || '';
    if (href && (/^(mailto|tel|javascript):/i.test(href) || (/^https?:/i.test(href) && !href.startsWith(location.origin)))) continue;
    e.setAttribute('data-codetac-sample', String(out.length));
    out.push({ index: out.length, tag: e.tagName.toLowerCase(), text, href });
  }
  return out;
})()`;

async function runProject(chrome, project) {
  const result = { nome: project.nome, ferramenta: project.ferramenta, stack: project.stack, pasta: project.pasta };
  const lines = [];
  // The project must stay as it was (untracked files the project ignores, like .venv, do not count).
  const gitStatus = () => spawnSync('git', ['status', '--porcelain'], { cwd: resolve(workspace, project.pasta), encoding: 'utf8' }).stdout ?? '';
  const gitBefore = gitStatus();
  const started = Date.now();
  const child = spawn(cli[0], [...cli.slice(1), project.pasta, '--yes', '--no-open', '--panel-port', String(panelPort), ...(project.args ?? [])],
    { cwd: workspace, env: { ...process.env, CODETAC_AI_PROVIDER: 'none', ...project.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffered = '';
  const onData = chunk => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop();
    for (const line of parts) lines.push({ ms: Date.now() - started, line });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const find = pattern => lines.find(entry => pattern.test(entry.line));
  const waitLine = async (pattern, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = find(pattern);
      if (found) return found;
      if (child.exitCode !== null) return null;
      await delay(250);
    }
    return null;
  };
  try {
    const ready = await waitLine(/^✓ App ready at (\S+)/, LIMIT_MS);
    if (!ready) throw new Error(`A app não ficou pronta: ${lines.slice(-6).map(entry => entry.line).join(' / ')}`);
    result.prontaMs = ready.ms;
    result.url = ready.line.match(/at (\S+)/)[1];
    result.modo = /minimal mode/.test(ready.line) ? 'mínimo' : 'normal';
    result.instalacaoMs = (() => {
      const from = find(/Installing/);
      const to = find(/Panel:/);
      return from && to ? to.ms - from.ms : 0;
    })();
    const page = await chrome.newPage();
    await page.goto(project.pagina ? new URL(project.pagina, result.url).href : result.url);
    result.barra = await page.waitFor('document.querySelector("codetac-bar")', 30000).then(() => true, () => false);
    await delay(1500);
    const candidates = await page.evaluate(CANDIDATES);
    result.candidatos = candidates.length;
    const order = project.clicar ? [{ selector: project.clicar, text: project.clicar }]
      : candidates.map(item => ({ selector: `[data-codetac-sample="${item.index}"]`, text: `${item.tag} «${item.text}»` }));
    for (const item of order.slice(0, 4)) {
      try { await page.click(item.selector); } catch { continue; }
      result.clicado = item.text;
      const first = await waitLine(/^✓ First dossier \((\d+) s.*action=/, 20000);
      if (first) {
        result.primeiroDossieMs = first.ms;
        result.link = first.line.match(/(http\S+)$/)[1];
        break;
      }
      // A click that did nothing: back to the page and try the next one.
      await page.goto(project.pagina ? new URL(project.pagina, result.url).href : result.url).catch(() => {});
      await delay(1000);
      await page.evaluate(CANDIDATES);
    }
    // No click produced an action (a page that fails, or nothing clickable):
    // the dossier of the page load, which the command also announces.
    if (!result.link) {
      const load = await waitLine(/^✓ First dossier \((\d+) s.*request=/, 20000);
      if (load) {
        result.primeiroDossieMs = load.ms;
        result.link = load.line.match(/(http\S+)$/)[1];
        result.tipoDossie = 'carregamento da página';
      }
    } else result.tipoDossie = 'ação';
    result.errosConsola = page.errors.slice(0, 5);
    if (result.link) {
      const action = result.link.includes('action=');
      const id = decodeURIComponent(result.link.split(/(?:action|request)=/)[1] ?? '');
      await delay(1500);
      const dossier = await getJson(`/api/${action ? 'actions' : 'requests'}/${encodeURIComponent(id)}`);
      const d = dossier?.json ?? {};
      const server = action ? (d.timeline ?? []).flatMap(item => item.server ?? []) : d.steps ? [d] : [];
      if (!action) d.label = `${d.request?.method} ${d.request?.path} (estado ${d.request?.status})`;
      result.dossie = {
        estado: dossier?.status, acao: d.label, nivel: d.level, motivo: d.reason ?? null,
        pedidosBrowser: (d.timeline ?? []).filter(item => item.type === 'request').length,
        pedidosServidor: server.length,
        funcoes: server.reduce((total, item) => total + item.steps.filter(step => step.type === 'function').length, 0),
        fronteiras: server.reduce((total, item) => total + item.steps.filter(step => step.type === 'boundary').length, 0),
        naoSuportado: UNSUPPORTED.test(dossier?.text ?? ''),
      };
      const view = await chrome.newPage();
      await view.goto(result.link);
      await delay(2500);
      const shot = join(workspace, '.codetac', `amostra-${project.nome}.png`);
      writeFileSync(shot, await view.screenshot());
      result.captura = shot;
    }
  } catch (error) {
    result.erro = error.message;
  }
  if (project.pedidos?.length && result.url) {
    result.pedidos = [];
    for (const path of project.pedidos) {
      try { result.pedidos.push(`${path} ${(await fetch(new URL(path, result.url))).status}`); } catch { result.pedidos.push(`${path} erro`); }
    }
    await delay(1500);
  }
  // Diagnosis while the application still runs.
  result.diagnostico = await new Promise(done => {
    const diag = spawn(cli[0], [...cli.slice(1), 'diagnose', project.pasta, '--panel-port', String(panelPort)], { cwd: workspace });
    let text = '';
    diag.stdout.on('data', chunk => { text += chunk; });
    diag.on('exit', () => done(text));
  });
  child.kill('SIGINT');
  await Promise.race([new Promise(done => child.once('exit', done)), delay(10000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  result.saida = lines.map(entry => entry.line).filter(line => !/^\s+│/.test(line));
  // CodeTAC's own messages: not the application's (│) nor the installer's (npm warn…).
  result.naoSuportadoNaSaida = lines.some(entry => UNSUPPORTED.test(entry.line) && !/^\s+│|^npm (warn|WARN)/.test(entry.line));
  result.projetoInalterado = gitStatus() === gitBefore;
  result.comFuncoes = Number(result.diagnostico.match(/With project functions: (\d+)/)?.[1] ?? 0);
  result.explicado = Boolean(project.explicacao && !result.link && new RegExp(project.explicacao).test(result.saida.join('\n')));
  if (result.explicado) result.tipoDossie = 'explicação';
  result.aceite = (result.explicado && result.projetoInalterado && !result.naoSuportadoNaSaida) || Boolean(result.link && result.dossie?.estado === 200 && !result.dossie.naoSuportado && !result.naoSuportadoNaSaida
    && result.primeiroDossieMs < LIMIT_MS && (!project.pedidos?.length || result.comFuncoes > 0) && result.projetoInalterado);
  return result;
}

const chrome = await launchChrome({ scratch: join(workspace, '.codetac') });
const results = [];
try {
  for (const project of config.projetos) {
    if (only.size && !only.has(project.nome)) continue;
    process.stdout.write(`\n=== ${project.nome} (${project.ferramenta}, ${project.stack})\n`);
    const result = await runProject(chrome, project);
    results.push(result);
    process.stdout.write(`${result.aceite ? 'ACEITE' : 'FALHOU'} · pronta ${Math.round((result.prontaMs ?? 0) / 1000)} s · primeiro dossier ${result.primeiroDossieMs ? Math.round(result.primeiroDossieMs / 1000) + ' s' : '—'}` +
      ` · modo ${result.modo ?? '?'} · clique ${result.clicado ?? '—'} · projeto ${result.projetoInalterado ? 'inalterado' : 'ALTERADO'}${result.erro ? ` · erro: ${result.erro}` : ''}\n`);
    if (result.dossie) process.stdout.write(`  dossier: ${JSON.stringify(result.dossie)}\n`);
  }
} finally {
  await chrome.close();
}
const out = join(workspace, '.codetac', `amostra-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
process.stdout.write(`\nResultados: ${out}\n`);
process.exitCode = results.every(result => result.aceite) ? 0 : 1;
