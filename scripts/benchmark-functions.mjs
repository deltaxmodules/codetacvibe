import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = resolve(import.meta.dirname, '..');
const root = resolve(workspace, 'fixtures/performance');
const label = `performance-${Date.now()}`;
const runs = [];
for (let round = 1; round <= 3; round++) {
  for (const capture of round % 2 ? [false, true] : [true, false]) {
    const env = { ...process.env, CODETAC_ROOT: root, CODETAC_RUN: label };
    delete env.NODE_OPTIONS;
    const args = capture ? ['--import', pathToFileURL(resolve(workspace, 'src/register.mjs')).href] : [];
    const result = spawnSync(process.execPath, [...args, resolve(root, 'probe.mjs')], { env, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Falhou o ensaio de desempenho; verificar o runtime.');
    runs.push({ round, capture, ...JSON.parse(result.stdout) });
  }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const baselineMs = median(runs.filter(run => !run.capture).flatMap(run => run.samplesMs));
const captureMs = median(runs.filter(run => run.capture).flatMap(run => run.samplesMs));
const report = { date: new Date().toISOString(), node: process.version, workload: '1000 invoice lines; 1001 function calls per operation; synthetic CPU stress',
  baselineMs, captureMs, ratio: captureMs / baselineMs, sameResult: runs.every(run => run.total === runs[0].total), runs };
mkdirSync(resolve(workspace, '.codetac'), { recursive: true });
writeFileSync(resolve(workspace, '.codetac', 'performance-report.json'), JSON.stringify(report, null, 2));
console.log(`1000 linhas: base=${baselineMs.toFixed(3)}ms; captura=${captureMs.toFixed(3)}ms; rácio=${report.ratio.toFixed(1)}x; mesmo resultado=${report.sameResult}`);
console.log('Relatório: .codetac/performance-report.json');
if (!report.sameResult || report.ratio > 2) process.exitCode = 1;
