// `codetac check` (block K, step K1.1): is the app safe to ship? A static
// reading only — the app is not started and no value of a .env file is read.
// It reuses the Structure's findings (secrets, data model) and sorts them in
// 🔴 (blocks shipping), 🟡 (look at it) and ✅ (checked and fine). Every
// finding says why and where (file:line); a ✅ is shown only when there was
// something to check. Names, files and lines only: never a value.
// K1.2: tables used from the browser whose row level security no file shows,
// the kind of each key written in the code (a test key is 🟡), AI, email and
// message services called from the browser, and where the data goes.
// K1.3: the local setup that points to real things (environment.mjs): the
// development .env files are read only to classify their values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../structure/readers.mjs';
import { leaksView } from '../structure/leaks.mjs';
import { serviceCatalogue } from '../structure/services.mjs';
import { literalKeys } from '../structure/node/modules.mjs';
import { environmentFacts } from './environment.mjs';
import { secretsView } from '../structure/secrets.mjs';
import { dataFindings } from '../structure/data.mjs';
import { readConfig } from '../structure/config.mjs';
import { t } from '../structure/text.mjs';

const RED = new Set(['public-secret', 'env-tracked', 'literal-key', 'no-rls-browser']);
const BROWSER = new Set(['client', 'both']);
const PLAN_KEY = { 'public-secret': 'secret_public_secret', 'secret-in-browser': 'secret_secret_in_browser', 'env-tracked': 'secret_env_tracked',
  'env-not-ignored': 'secret_env_not_ignored', 'env-no-git': 'secret_env_no_git' };
const MAX_PLACES = 3;
// Keys that are 🟡, not 🔴: a test key moves no real money; a Google key is
// often public by design (Firebase, Maps) and is safe when it is restricted.
const YELLOW_KEYS = { 'stripe-test': 'literal-key-test', google: 'literal-key-google' };
// Services with no key that is safe in the browser (Stripe and Supabase have one).
const SECRET_ONLY = new Set(['ai', 'email', 'messaging']);
const ENVIRONMENT = new Set(['live-key', 'remote-supabase', 'remote-database', 'production-mode']);
// Facts worth knowing that block nothing (K1.7: a Supabase project in the
// cloud is how nearly every Lovable or Bolt app is set up).
const INFO = new Set(['remote-supabase']);

function title(item) {
  if (item.kind === 'literal-key') return item.inBrowser ? `${item.message} ${t('check.inBrowser')}` : item.message;
  if (item.kind === 'rls-unknown-browser') return t('check.rlsUnknown', { table: item.table, files: item.browserFiles.join(', ') });
  if (ENVIRONMENT.has(item.kind)) return t(`check.environment.${item.kind}`, { variable: item.variable, file: item.file });
  if (item.kind === 'service-from-browser') return t('check.serviceFromBrowser', { service: item.service, files: item.browserFiles.join(', ') });
  if (item.kind === 'no-rls-browser') return `${t('cli.summary.data.no-rls-browser', { table: item.table }).replace(/\.$/, '')} (${item.browserFiles.join(', ')}).`;
  return t(`plan.${PLAN_KEY[item.kind]}`, { name: item.variable ?? '', files: (item.files ?? []).join(', '), browser: (item.browserFiles ?? []).join(', ') });
}

// The same place can prove a finding twice (the table's migration and its use).
const places = proof => [...new Map(proof.map(item => [`${item.file}:${item.line}`, { file: item.file, line: item.line }])).values()];

const browserUse = graph => {
  const files = new Map(graph.nodes.filter(node => node.kind === 'file').map(node => [node.id, node]));
  const fileOf = new Map(graph.nodes.filter(node => node.kind === 'symbol').map(node => [node.id, node.file]));
  const uses = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'reads' && edge.kind !== 'writes') continue;
    const file = files.get(fileOf.get(edge.from) ?? edge.from);
    if (!BROWSER.has(file?.runsOn)) continue;
    if (!uses.has(edge.to)) uses.set(edge.to, []);
    uses.get(edge.to).push({ path: file.path, proof: edge.proof });
  }
  return uses;
};

// A table used from the browser with no SQL file that says whether its row
// level security is on (in Supabase it is set in the dashboard, not always in
// a migration): it can be fine, or open to anyone.
function rlsUnknown(graph) {
  const uses = browserUse(graph);
  return graph.nodes.filter(node => node.kind === 'table' && !node.rls && uses.has(node.id)).map(table => ({ kind: 'rls-unknown-browser', table: table.name,
    browserFiles: [...new Set(uses.get(table.id).map(use => use.path))], proof: uses.get(table.id).flatMap(use => use.proof) }));
}

// The kind of a key written in the code, read again from its line (the note
// keeps only the sentence), and whether that file runs in the browser.
function keyKinds(root, graph, alerts) {
  const files = new Map(graph.nodes.filter(node => node.kind === 'file').map(node => [node.path, node]));
  const sources = new Map();
  return alerts.map(item => {
    if (item.kind !== 'literal-key') return item;
    const place = item.proof[0];
    if (!place) return item;
    if (!sources.has(place.file)) { try { sources.set(place.file, literalKeys(readFileSync(join(root, place.file), 'utf8'))); } catch { sources.set(place.file, []); } }
    const key = sources.get(place.file).find(found => found.line === place.line)?.kind ?? null;
    return { ...item, key, inBrowser: BROWSER.has(files.get(place.file)?.runsOn) };
  });
}

// AI, email and message services called from code that runs in the browser:
// their key has to be there too. And every service the code sends data to.
function services(root, graph) {
  const { rows } = leaksView(graph, { catalogue: serviceCatalogue(readConfig(root).services) });
  const fromBrowser = rows.filter(row => row.browser && SECRET_ONLY.has(row.category)).map(row => {
    const calls = row.calls.filter(call => BROWSER.has(call.runsOn));
    return { kind: 'service-from-browser', service: row.name, browserFiles: [...new Set(calls.map(call => call.file))], proof: calls.flatMap(call => call.proof) };
  });
  const leaves = rows.map(row => ({ name: row.name, category: row.category, browser: row.browser,
    variable: row.destination?.type === 'env' && row.destination.variable !== row.name ? row.destination.variable : null, places: places(row.calls.flatMap(call => call.proof)) }));
  return { fromBrowser, leaves, risky: rows.some(row => SECRET_ONLY.has(row.category)) };
}

const environment = (root, graph) => environmentFacts(root, graph.nodes.filter(node => node.kind === 'file' && node.language === 'dotenv').map(node => node.path))
  .map(fact => ({ ...fact, proof: [{ file: fact.file, line: fact.line }] }));

// What passed: only checks that had something to look at.
function passed(graph, view, outside) {
  const kinds = new Set([...view.alerts, ...view.warnings].map(item => item.kind));
  const files = graph.nodes.filter(node => node.kind === 'file');
  const list = [];
  const secrets = view.variables.filter(item => item.secretLike).length;
  if (secrets && !kinds.has('public-secret') && !kinds.has('secret-in-browser')) list.push({ kind: 'secrets', text: t('check.passed.secrets', { count: secrets }) });
  const envFiles = files.filter(file => file.language === 'dotenv' && !/\.(example|sample|template|dist|defaults)$/i.test(file.path)).length;
  if (envFiles && !['env-tracked', 'env-not-ignored', 'env-no-git'].some(kind => kinds.has(kind))) list.push({ kind: 'env-git', text: t('check.passed.envGit', { count: envFiles }) });
  if (files.some(file => file.language !== 'dotenv') && !kinds.has('literal-key')) list.push({ kind: 'literal-keys', text: t('check.passed.literalKeys') });
  const fileOf = new Map(graph.nodes.filter(node => node.kind === 'symbol').map(node => [node.id, node.file]));
  const runsOn = new Map(files.map(file => [file.id, file.runsOn]));
  const fromBrowser = new Set(graph.edges.filter(edge => (edge.kind === 'reads' || edge.kind === 'writes') && BROWSER.has(runsOn.get(fileOf.get(edge.from) ?? edge.from)))
    .map(edge => edge.to));
  const protectedTables = graph.nodes.filter(node => node.kind === 'table' && node.rls?.enabled && fromBrowser.has(node.id)).length;
  if (protectedTables) list.push({ kind: 'rls', text: t('check.passed.rls', { count: protectedTables }) });
  if (outside.risky && !outside.fromBrowser.length) list.push({ kind: 'services', text: t('check.passed.services') });
  return list;
}

export async function checkProject(root) {
  const started = Date.now();
  const { graph, problems } = await readProject(root);
  const view = secretsView(graph, { root, platform: readConfig(root).env.platform });
  const outside = services(root, graph);
  const found = [...keyKinds(root, graph, view.alerts), ...view.warnings, ...dataFindings(graph).filter(item => item.kind === 'no-rls-browser'),
    ...rlsUnknown(graph), ...outside.fromBrowser, ...environment(root, graph)];
  // K1.7: a secret with the public prefix that no code reads is not in the
  // browser yet (the build only puts in what the code reads): 🟡, not 🔴.
  const read = new Set(view.variables.filter(item => item.readIn.length).map(item => item.name));
  const all = found.map(item => {
    const variant = item.kind === 'literal-key' ? YELLOW_KEYS[item.key] : item.kind === 'public-secret' && !read.has(item.variable) ? 'public-secret-unread' : null;
    const level = INFO.has(item.kind) ? 'info' : RED.has(item.kind) && !variant ? 'red' : 'yellow';
    return { level, kind: item.kind, ...(item.key ? { key: item.key } : {}),
      text: variant === 'public-secret-unread' ? t('check.publicUnread', { name: item.variable }) : title(item),
      why: t(`check.why.${variant ?? item.kind}`), places: places(item.proof ?? []) };
  });
  const findings = all.filter(item => item.level !== 'info').sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  const info = all.filter(item => item.level === 'info');
  return {
    project: { name: graph.project.name, types: graph.project.types, files: graph.nodes.filter(node => node.kind === 'file').length },
    findings, info, passed: passed(graph, view, outside), leaves: outside.leaves, notes: (graph.notes ?? []).filter(note => note.kind !== 'literal-key').map(note => note.message), problems,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

export function printReport(report, out) {
  const { project } = report;
  out(t('check.title', { name: project.name, types: project.types.length ? ` (${project.types.join(', ')})` : '' }));
  out(t('check.read', { count: project.files, seconds: report.seconds.toFixed(1) }));
  out('');
  if (!project.files) { out(t('check.verdict.empty')); out(''); return; }
  for (const level of ['red', 'yellow']) {
    const list = report.findings.filter(item => item.level === level);
    if (!list.length) continue;
    out(t(`check.${level}`, { count: list.length }));
    for (const item of list) {
      out(`  ${level === 'red' ? '🔴' : '🟡'} ${item.text}`);
      out(`     ${item.why}`);
      if (item.places.length) out(`     ${t('check.at')} ${item.places.slice(0, MAX_PLACES).map(place => `${place.file}:${place.line}`).join(', ')}${item.places.length > MAX_PLACES ? ', …' : ''}`);
    }
    out('');
  }
  if (report.info.length) {
    out(t('check.info', { count: report.info.length }));
    for (const item of report.info) out(`  ℹ ${item.text} ${item.why}`);
    out('');
  }
  if (report.leaves.length) {
    out(t('check.leaves', { count: report.leaves.length }));
    for (const item of report.leaves) {
      out(`  · ${t(item.browser ? 'check.leavesBrowser' : 'check.leavesServer', { name: item.name, category: item.category })}${item.variable ? ` ${t('check.leavesVariable', { variable: item.variable })}` : ''}`
        + `${item.places.length ? ` — ${item.places.slice(0, MAX_PLACES).map(place => `${place.file}:${place.line}`).join(', ')}${item.places.length > MAX_PLACES ? ', …' : ''}` : ''}`);
    }
    out('');
  }
  if (report.passed.length) {
    out(t('check.green', { count: report.passed.length }));
    for (const item of report.passed) out(`  ✅ ${item.text}`);
    out('');
  }
  for (const note of report.notes) out(`  ${t('cli.summary.note', { message: note })}`);
  for (const problem of report.problems) out(`  ! ${problem}`);
  const red = report.findings.filter(item => item.level === 'red').length;
  const yellow = report.findings.length - red;
  out(red ? t('check.verdict.red', { count: red }) : yellow ? t('check.verdict.yellow', { count: yellow }) : t('check.verdict.clean'));
  out(t('check.footnote'));
  out('');
}

// K1.4: for machines. The verdict decides the exit code: 1 when there is a
// 🔴 (or a 🟡, with --fail-on yellow), else 0; a wrong option is 2.
export function verdictOf(report) {
  if (!report.project.files) return 'empty';
  return report.findings.some(item => item.level === 'red') ? 'red' : report.findings.length ? 'yellow' : 'clean';
}

// The --json output (report.schema.json).
export function jsonReport(report, version) {
  const red = report.findings.filter(item => item.level === 'red').length;
  return { schemaVersion: 1, tool: { name: 'codetac', version }, project: report.project, verdict: verdictOf(report),
    counts: { red, yellow: report.findings.length - red, passed: report.passed.length },
    findings: report.findings, info: report.info, passed: report.passed, leaves: report.leaves, notes: report.notes, problems: report.problems, seconds: report.seconds };
}

export async function checkCommand(root, { json = false, failOn = 'red', version = '', out = text => process.stdout.write(`${text}\n`) } = {}) {
  const report = await checkProject(root);
  if (json) out(JSON.stringify(jsonReport(report, version), null, 2));
  else printReport(report, out);
  const verdict = verdictOf(report);
  return verdict === 'red' || (failOn === 'yellow' && verdict === 'yellow') ? 1 : 0;
}
