// Ensaio da Etapa 13 Python: a amostra de código aberto (scripts/ensaios/amostra-python.json).
//   node scripts/accept-amostra-python.mjs [nome…]
// Arranca um Postgres de ensaio num contentor próprio (codetac-ensaio-*), cria as
// bases, corre o accept-sample.mjs (codetac --yes, do projeto sem .venv ao primeiro
// dossier no Chrome) e remove o contentor no fim. Clonar antes cada «repositorio»
// na «pasta» indicada (git clone --depth 1).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const configPath = join(workspace, 'scripts/ensaios/amostra-python.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const only = process.argv.slice(2);
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

for (const project of config.projetos) {
  if (!existsSync(join(workspace, project.pasta))) {
    process.stdout.write(`Falta clonar ${project.repositorio} em ${project.pasta}\n`);
    process.exit(2);
  }
}

const pg = config.postgres;
const needed = config.projetos.some(project => (!only.length || only.includes(project.nome)) && /postgres/.test(JSON.stringify(project.env ?? {})));
if (needed) {
  if (!pg.contentor.startsWith('codetac-ensaio-')) throw new Error('O contentor de ensaio tem de se chamar codetac-ensaio-*');
  docker('rm', '-f', pg.contentor);
  const run = docker('run', '-d', '--name', pg.contentor, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `127.0.0.1:${pg.porta}:5432`, pg.imagem);
  if (run.status !== 0) throw new Error(`O Postgres de ensaio não arrancou: ${run.stderr}`);
  let ready = false;
  for (let tries = 0; tries < 60 && !ready; tries++) {
    await delay(500);
    ready = docker('exec', pg.contentor, 'pg_isready', '-U', 'postgres').status === 0;
  }
  // pg_isready answers before the init scripts finish: one more real query.
  await delay(1500);
  for (const base of pg.bases) docker('exec', pg.contentor, 'psql', '-U', 'postgres', '-c', `CREATE DATABASE ${base}`);
  process.stdout.write(`Postgres de ensaio: ${pg.contentor} em 127.0.0.1:${pg.porta} (bases: ${pg.bases.join(', ')})\n`);
}
try {
  const result = spawnSync(process.execPath, [join(workspace, 'scripts/accept-sample.mjs'), configPath, ...only], { cwd: workspace, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  if (needed) docker('rm', '-f', pg.contentor);
  process.stdout.write(`Contentor de ensaio removido: ${docker('ps', '-a', '--format', '{{.Names}}').stdout.includes(pg.contentor) ? 'NÃO' : 'sim'}\n`);
}
