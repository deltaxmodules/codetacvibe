// `codetac diagnose` (Fase 5): o que está e o que não está a funcionar,
// em linguagem simples, a partir do projeto, do painel e da última gravação.
import nodeModule from 'node:module';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { dataDirectory } from './home.mjs';
import { detectProject, describeStart, prismaWithoutTracing } from './detect.mjs';
import { MINIMUM, versionBelow } from './detect-python.mjs';
import { recordingsOf, summarize } from './recording.mjs';
import { describeConfig, loadConfig } from './ai.mjs';
import { TEXT, t } from './structure/text.mjs';

const directory = dataDirectory();

// The sentences live in structure/text/en.json (diagnose).
const REASONS = TEXT.diagnose.reasons;

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

// A Python part: interpreter, version, dependencies, server and start (Etapa 12 Python).
function pythonPart(part, { ok, bad, note }) {
  const label = part.part === '.' ? '' : `[${part.part}] `;
  const { python } = part;
  if (!python.interpreter) bad(`${label}${t('diagnose.noVenv')}`, t('diagnose.noVenvFix'));
  else if (!python.version) bad(`${label}${t('diagnose.pythonSilent', { interpreter: relative(part.folder, python.interpreter) })}`, t('diagnose.pythonSilentFix'));
  else if (versionBelow(python.version)) note(`${label}${t('diagnose.pythonOld', { version: python.version, interpreter: relative(part.folder, python.interpreter) })}`,
    t('diagnose.pythonOldFix', { version: MINIMUM.join('.') }));
  else ok(`${label}${t('diagnose.pythonOk', { version: python.version, interpreter: relative(part.folder, python.interpreter) || python.interpreter })}`);
  if (python.interpreter && python.missing.length) bad(`${label}${t('diagnose.missingDeps', { list: `${python.missing.slice(0, 8).join(', ')}${python.missing.length > 8 ? '…' : ''}` })}`, t('diagnose.missingDepsFix'));
  ok(t('diagnose.start', { start: describeStart(part) }));
  if (part.server) ok(`${label}${t('diagnose.server', { server: part.server })}`);
  if (part.port) ok(`${label}${t('diagnose.pythonPort', { port: part.port.value, source: part.port.source })}`);
  // The version note is already the first line.
  for (const text of (part.notes ?? []).filter(text => !text.startsWith("The project's Python"))) note(`${label}${text}`);
}

export async function diagnose(root, { panelPort = 4000, out = text => process.stdout.write(`${text}\n`) } = {}) {
  let problems = 0;
  const ok = text => out(`  ✓ ${text}`);
  const bad = (text, fix) => { problems++; out(`  ✗ ${text}`); if (fix) out(`      → ${fix}`); };
  const note = (text, fix) => { out(`  ! ${text}`); if (fix) out(`      → ${fix}`); };

  out(`${t('diagnose.title', { root })}\n`);
  out(t('diagnose.computer'));
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 24 && typeof nodeModule.registerHooks === 'function') ok(t('diagnose.nodeOk', { version: process.version }));
  else if (typeof nodeModule.registerHooks === 'function') note(t('diagnose.nodeOld', { version: process.version }), t('diagnose.installNode'));
  else bad(t('diagnose.nodeMinimal', { version: process.version }), t('diagnose.installNode'));

  out(`\n${t('diagnose.project')}`);
  const project = detectProject(root);
  if (project.missing.includes('package')) bad(t('diagnose.noPackage'), t('diagnose.noPackageFix'));
  else if (project.missing.includes('part')) note(t('diagnose.severalParts', { parts: project.parts.map(part => part.part).join(', ') }));
  else if (project.missing.includes('command') && project.top?.language === 'python') {
    if (project.top.python.django) bad(t('diagnose.django'));
    else bad(t('diagnose.pythonAppNotFound'), t('diagnose.pythonAppNotFoundFix'));
  } else if (project.missing.includes('command')) bad(t('diagnose.noStartScript'), t('diagnose.noStartScriptFix'));
  for (const part of project.start.length ? project.start : project.parts) {
    if (part.language === 'python') { pythonPart(part, { ok, bad, note }); continue; }
    ok(t('diagnose.start', { start: describeStart(part) }));
    if (part.port) ok(t('diagnose.nodePort', { port: part.port.value, source: part.port.source }));
    if (!part.installed) bad(t('diagnose.depsNotInstalled', { part: part.part === '.' ? t('run.theProjectLower') : part.part }), t('diagnose.depsNotInstalledFix', { manager: part.manager === 'bun' ? 'npm' : part.manager }));
    const prisma = prismaWithoutTracing(part.folder, root);
    if (prisma) bad(t('run.prismaNoTracing', { version: prisma.version }),
      t('diagnose.prismaFix', { schema: prisma.schema }));
    if (part.foreign && !/^(python3?|uvicorn)$/.test(part.foreign) && spawnSync(process.platform === 'win32' ? 'where' : 'which', [part.foreign.split(' ')[0]], { stdio: 'ignore' }).status !== 0) {
      bad(t('diagnose.foreignMissing', { tool: part.foreign }), t('diagnose.foreignMissingFix', { tool: part.foreign }));
    } else if (part.foreign) note(t('diagnose.foreign', { tool: part.foreign }));
  }

  out(`\n${t('diagnose.panel')}`);
  const panelOn = await ping(panelPort);
  if (panelOn) ok(t('diagnose.panelOn', { port: panelPort }));
  else note(t('diagnose.panelOff', { port: panelPort }), t('diagnose.panelOffFix'));
  try {
    // The running panel's own configuration, else the one it would load.
    const config = (panelOn && await panelConfig(panelPort)) || describeConfig(await loadConfig({ directory }));
    ok(t('diagnose.purposes', { how: config.active ? `${config.model} (${config.provider}, ${t(config.local ? 'diagnose.local' : 'diagnose.redacted')})`
      : t('diagnose.fixed', { problem: config.problem ?? t('diagnose.noModel') }) }));
  } catch {}

  out(`\n${t('diagnose.latest')}`);
  const [last] = recordingsOf(directory, root);
  if (!last) {
    note(t('diagnose.noRecordings'), t('diagnose.noRecordingsFix'));
    out(`\n${problems ? t('diagnose.problems', { count: problems }) : t('diagnose.nothingPrevents')}`);
    return problems ? 1 : 0;
  }
  const summary = summarize(last.folder);
  // Processes by runtime; a supervisor (reloader) serves nothing and is left out.
  const serving = summary.starts.filter(start => !summary.supervisors.has(start.process));
  const pythons = [...new Set(serving.filter(start => start.python).map(start => start.python))];
  const nodes = serving.filter(start => !start.python).length;
  const runtimes = [nodes && `${nodes} Node`, pythons.length && `${serving.length - nodes} Python ${pythons.join(', ')}`].filter(Boolean).join(', ');
  ok(t('diagnose.recording', { name: last.name, date: new Date(last.changed).toLocaleString('en-GB'), count: serving.length, runtimes: runtimes ? ` (${runtimes})` : '' }));
  if (summary.supervisors.size) ok(t('diagnose.supervisors', { count: summary.supervisors.size }));
  if (summary.servers.size) ok(t('diagnose.server', { server: [...summary.servers].join(', ') }));
  const minimal = summary.starts.find(start => start.level === 'minimo');
  if (minimal) note(t('diagnose.minimal', { reason: minimal.reason ?? t('diagnose.noReason') }),
    t('diagnose.minimalFix'));
  if (summary.ports.size) ok(t('diagnose.ports', { ports: [...summary.ports].join(', ') }));
  else if (!summary.requests) bad(t('diagnose.noPorts'), t('diagnose.noPortsFix'));
  if (!minimal) {
    if (summary.files) ok(t('diagnose.files', { files: summary.files, functions: summary.functions }));
    else if (summary.requests) bad(t('diagnose.noFiles'),
      t('diagnose.noFilesFix'));
    const failed = summary.failed.length;
    if (failed) {
      note(t('diagnose.failedFiles', { count: failed }));
      for (const item of summary.failed.slice(0, 5)) out(`      - ${relative(root, item.file ?? '') || item.file}${item.detail ? `: ${item.detail}` : ''}`);
    }
    for (const [reason, count] of summary.limitations) {
      if (reason === 'module-transform-failed' || reason === 'source-map-unreadable') continue;
      note(`${REASONS[reason] ?? reason}: ${count}.`);
    }
  }
  if (summary.requests) {
    ok(t('diagnose.requests', { requests: summary.requests, functions: summary.withFunctions.size, boundaries: summary.withBoundaries.size }));
    if (!minimal && summary.files && !summary.withFunctions.size) note(t('diagnose.noFunctions'),
      t('diagnose.noFunctionsFix'));
  } else note(t('diagnose.noRequests'), t('diagnose.noRequestsFix'));
  if (summary.pages) ok(t('diagnose.pages', { count: summary.pages }));
  else if (summary.requests && !summary.actions.size) note(t('diagnose.noPages'),
    t('diagnose.noPagesFix'));
  if (summary.actions.size) ok(t('diagnose.actions', { count: summary.actions.size }));
  else if (summary.pages) note(t('diagnose.noActions'), t('diagnose.noActionsFix'));

  out(`\n${problems ? t('diagnose.problems', { count: problems }) : t('diagnose.allWorking')}`);
  return problems ? 1 : 0;
}
