// `codetac diagnostico` (Fase 5): o que está e o que não está a funcionar,
// em linguagem simples, a partir do projeto, do painel e da última gravação.
import { registerHooks } from 'node:module';
import http from 'node:http';
import { join, relative } from 'node:path';
import { dataDirectory } from './home.mjs';
import { detectProject, describeStart } from './detect.mjs';
import { recordingsOf, summarize } from './recording.mjs';
import { describeConfig, loadConfig } from './ai.mjs';

const directory = dataDirectory();

const REASONS = {
  'module-transform-failed': 'ficheiros que não foi possível preparar',
  'source-map-unreadable': 'ficheiros com source map ilegível',
  'eval-code-transform-failed': 'blocos de código do bundler que não foi possível preparar',
  'constructor-skipped': 'construtores de classes (correm, mas não aparecem)',
  'generator-skipped': 'generators (correm, mas não aparecem)',
  'parameter-redeclaration-skipped': 'funções que redeclaram um parâmetro (correm, mas não aparecem)',
  'direct-eval-skipped': 'funções com eval direto (correm, mas não aparecem)',
};

function ping(port) {
  return new Promise(done => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, response => {
      response.resume();
      done(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); done(false); });
    request.on('error', () => done(false));
  });
}

function panelConfig(port) {
  return new Promise(done => {
    http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
    }).on('error', () => done(null));
  });
}

export async function diagnose(root, { panelPort = 4000, out = text => process.stdout.write(`${text}\n`) } = {}) {
  let problems = 0;
  const ok = text => out(`  ✓ ${text}`);
  const bad = (text, fix) => { problems++; out(`  ✗ ${text}`); if (fix) out(`      → ${fix}`); };
  const note = (text, fix) => { out(`  ! ${text}`); if (fix) out(`      → ${fix}`); };

  out(`Diagnóstico do CodeTAC · ${root}\n`);
  out('Este computador');
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 24 && typeof registerHooks === 'function') ok(`Node ${process.version}: consegue seguir as funções do projeto.`);
  else if (typeof registerHooks === 'function') note(`Node ${process.version}: funciona, mas o CodeTAC foi verificado no Node 24 ou superior.`, 'Instale o Node 24 ou mais recente.');
  else bad(`Node ${process.version}: não permite seguir as funções; só o modo mínimo (pedidos e fronteiras).`, 'Instale o Node 24 ou mais recente.');

  out('\nO projeto');
  const project = detectProject(root);
  if (project.missing.includes('package')) bad('Não há package.json nem ficheiro de servidor (server.js, index.js…) nesta pasta.', 'Corra o comando na pasta da app, ou indique o arranque: codetac . -- node server.js');
  else if (project.missing.includes('part')) note(`Tem várias partes: ${project.parts.map(part => part.part).join(', ')}. O comando pergunta quais arrancar.`);
  else if (project.missing.includes('command')) bad('O package.json não tem um script de arranque (dev, start…).', 'Indique o comando: codetac . -- <comando>');
  for (const part of project.start.length ? project.start : project.parts) {
    ok(`Arranque: ${describeStart(part)}`);
    if (part.port) ok(`Porta provável: ${part.port.value} (${part.port.source}). A porta real é lida quando a app arranca.`);
    if (!part.installed) bad(`As dependências de ${part.part === '.' ? 'o projeto' : part.part} não estão instaladas.`, `${part.manager === 'bun' ? 'npm' : part.manager} install (ou codetac --sim, que instala)`);
    if (part.foreign) note(`O script usa ${part.foreign}, que não é o Node: essa parte corre, mas não é observada por dentro.`);
  }

  out('\nO painel');
  const panelOn = await ping(panelPort);
  if (panelOn) ok(`Está a correr em http://127.0.0.1:${panelPort}.`);
  else note(`Não está a correr na porta ${panelPort}.`, 'O comando codetac arranca-o; sozinho: npm run panel, na pasta do CodeTAC.');
  try {
    // The running panel's own configuration, else the one it would load.
    const config = (panelOn && await panelConfig(panelPort)) || describeConfig(await loadConfig({ directory }));
    ok(`Frases de finalidade: ${config.active ? `${config.model} (${config.provider}${config.local ? ', local: nada sai da máquina' : ', excertos redigidos são enviados'})`
      : `fixas, geradas dos factos (${config.problem ?? 'sem modelo de IA configurado'})`}.`);
  } catch {}

  out('\nA última gravação deste projeto');
  const [last] = recordingsOf(directory, root);
  if (!last) {
    note('Ainda não há gravações deste projeto.', 'Arranque com: codetac (na pasta do projeto). Depois volte a correr o diagnóstico.');
    out(problems ? `\n${problems} problema(s) a resolver.` : '\nNada impede o arranque.');
    return problems ? 1 : 0;
  }
  const summary = summarize(last.folder);
  ok(`${last.name} (${new Date(last.changed).toLocaleString('pt-PT')}), ${summary.processes.size} processo(s) Node observados.`);
  const minimal = summary.starts.find(start => start.level === 'minimo');
  if (minimal) note(`Modo mínimo: as funções do projeto não foram seguidas (${minimal.reason ?? 'sem motivo registado'}). Pedidos, fronteiras e browser sim.`,
    'Se a app arranca sem o CodeTAC mas não com ele, envie estas linhas e as mensagens do arranque.');
  if (summary.ports.size) ok(`Portas abertas pela app: ${[...summary.ports].join(', ')}.`);
  else if (!summary.requests) bad('A captura não viu a app abrir nenhuma porta.', 'A app arrancou? Se o servidor não for Node (bun, deno…), não é observado.');
  if (!minimal) {
    if (summary.files) ok(`Ficheiros do projeto preparados: ${summary.files} (${summary.functions} funções).`);
    else if (summary.requests) bad('Nenhum ficheiro do projeto passou pelo CodeTAC.',
      'O servidor pode estar a correr código já empacotado sem source map, ou fora da pasta do projeto. Os dossiers mostram só pedidos e fronteiras.');
    const failed = summary.failed.length;
    if (failed) {
      note(`${failed} ficheiro(s) correm sem ser seguidos (não foi possível prepará-los):`);
      for (const item of summary.failed.slice(0, 5)) out(`      - ${relative(root, item.file ?? '') || item.file}${item.detail ? `: ${item.detail}` : ''}`);
    }
    for (const [reason, count] of summary.limitations) {
      if (reason === 'module-transform-failed' || reason === 'source-map-unreadable') continue;
      note(`${REASONS[reason] ?? reason}: ${count}.`);
    }
  }
  if (summary.requests) {
    ok(`Pedidos gravados: ${summary.requests}. Com funções do projeto: ${summary.withFunctions.size}. Com fronteiras: ${summary.withBoundaries.size}.`);
    if (!minimal && summary.files && !summary.withFunctions.size) note('Nenhum pedido passou por funções do projeto até agora.',
      'Normal numa app só de frontend (Vite, páginas estáticas): o servidor só entrega ficheiros; o que interessa está no browser.');
  } else note('Ainda não chegou nenhum pedido.', 'Abra a app no browser e use-a.');
  if (summary.pages) ok(`Páginas servidas com a barra do CodeTAC: ${summary.pages}.`);
  else if (summary.requests && !summary.actions.size) note('Nenhuma página HTML passou pelo servidor observado: a barra não foi injetada.',
    'Se a página vem de outro servidor (outro processo, não Node), abra-a através do servidor Node da app.');
  if (summary.actions.size) ok(`Ações do browser gravadas: ${summary.actions.size}.`);
  else if (summary.pages) note('A barra está na página, mas ainda não chegou nenhuma ação.', 'Clique em algo na app. Se nada aparecer, veja a consola do browser (erros de CSP?).');

  out(problems ? `\n${problems} problema(s) a resolver.` : '\nTudo o que foi possível verificar está a funcionar.');
  return problems ? 1 : 0;
}
