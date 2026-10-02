// The new risk rules of the Diff (phase D2, steps 1 to 3), made from the
// files of the two moments, not only from their plans:
//   - dependency added, removed or with another version (package.json,
//     requirements*.txt, pyproject.toml; lock files are not read);
//   - test file deleted, or with fewer tests (emptied when none is left);
//   - new route with none of the known session checks in its handler, in the
//     line that registers or mounts it, or in the middleware of its file
//     (a heuristic: always "possibly").
// Each sentence has the shape of summary.mjs (kind, severity, touches, text,
// side, proof, ids) plus origin: "read" (read in the code) or "possibly".
// A side is { graph, files: { path → hash }, read(path) → text or null }.
import { basename } from 'node:path';
import { t } from '../structure/text.mjs';

const MAX_LIST = 5;
const list = items => (items.length <= MAX_LIST ? items.join(', ') : t('diff.more', { list: items.slice(0, MAX_LIST).join(', '), more: items.length - MAX_LIST }));

// --- Dependencies -----------------------------------------------------------

// The line where a name is first written (for the proof).
function lineOf(text, name) {
  const lines = text.split('\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|["'\\s])${escaped}(["'\\s=<>~!^\\[;@]|$)`, 'i');
  const index = lines.findIndex(line => pattern.test(line));
  return index >= 0 ? index + 1 : 1;
}

const pythonName = name => name.toLowerCase().replace(/[_.]+/g, '-');

// name → { version, dev }.
export function readDependencies(path, text) {
  const found = new Map();
  const name = basename(path);
  if (name === 'package.json') {
    let json;
    try { json = JSON.parse(text); } catch { return null; }
    for (const [section, dev] of [['dependencies', false], ['optionalDependencies', false], ['peerDependencies', false], ['devDependencies', true]]) {
      for (const [dependency, version] of Object.entries(json?.[section] ?? {})) if (!found.has(dependency)) found.set(dependency, { version: String(version), dev });
    }
    return found;
  }
  if (/^requirements.*\.(txt|in)$/.test(name)) {
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(line);
      if (match) found.set(pythonName(match[1]), { version: match[3].replace(/;.*$/, '').trim() || '*', dev: /dev|test/.test(name) });
    }
    return found;
  }
  if (name === 'pyproject.toml') {
    let section = '';
    let inArray = null;
    const addSpec = (spec, dev) => {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^;]*)/.exec(spec);
      if (match && pythonName(match[1]) !== 'python') found.set(pythonName(match[1]), { version: match[3].trim() || '*', dev });
    };
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) { section = header[1].trim(); inArray = null; continue; }
      if (inArray !== null) {
        for (const [, spec] of line.matchAll(/["']([^"']+)["']/g)) addSpec(spec, inArray);
        if (line.includes(']')) inArray = null;
        continue;
      }
      // [project] dependencies = [...], [project.optional-dependencies] x = [...], [dependency-groups] dev = [...]
      const array = /^([\w.-]+)\s*=\s*\[(.*)$/.exec(line);
      const arraySection = (section === 'project' && array?.[1] === 'dependencies') || section === 'project.optional-dependencies' || section === 'dependency-groups';
      if (array && arraySection) {
        const dev = section !== 'project';
        for (const [, spec] of array[2].matchAll(/["']([^"']+)["']/g)) addSpec(spec, dev);
        if (!array[2].includes(']')) inArray = dev;
        continue;
      }
      // [tool.poetry.dependencies] name = "^1.0", [tool.poetry.group.dev.dependencies]
      const poetry = /^tool\.poetry\.(?:group\.[\w-]+\.)?(?:dev-)?dependencies$/.exec(section);
      const pair = /^([A-Za-z0-9][\w.-]*)\s*=\s*(.+)$/.exec(line);
      if (poetry && pair && pythonName(pair[1]) !== 'python') {
        const version = /^["']([^"']*)["']/.exec(pair[2])?.[1] ?? /version\s*=\s*["']([^"']*)["']/.exec(pair[2])?.[1] ?? '*';
        found.set(pythonName(pair[1]), { version, dev: section !== 'tool.poetry.dependencies' });
      }
    }
    return found;
  }
  return null;
}

const isManifest = path => /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.(txt|in))$/.test(path) && !path.split('/').includes('node_modules');

function dependencyRisks(before, after) {
  const sentences = [];
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(isManifest).sort();
  for (const path of paths) {
    if (before.files[path] === after.files[path]) continue;
    const beforeText = before.files[path] ? before.read(path) ?? '' : '';
    const afterText = after.files[path] ? after.read(path) ?? '' : '';
    const old = readDependencies(path, beforeText) ?? new Map();
    const now = readDependencies(path, afterText) ?? new Map();
    const describe = (name, item) => `${name} ${item.version}${item.dev ? ` ${t('risk.dev')}` : ''}`;
    const added = [...now].filter(([name]) => !old.has(name));
    const removed = [...old].filter(([name]) => !now.has(name));
    const changed = [...now].filter(([name, item]) => old.has(name) && old.get(name).version !== item.version);
    if (added.length) sentences.push({ kind: 'dependency-added', severity: 'warning', touches: [], side: 'after', origin: 'read',
      text: t('risk.dependencyAdded', { count: added.length, file: path, list: list(added.map(([name, item]) => describe(name, item))) }),
      proof: added.slice(0, 8).map(([name]) => ({ file: path, line: lineOf(afterText, name) })), ids: [`file:${path}`] });
    if (removed.length) sentences.push({ kind: 'dependency-removed', severity: 'info', touches: [], side: 'before', origin: 'read',
      text: t('risk.dependencyRemoved', { count: removed.length, file: path, list: list(removed.map(([name]) => name)) }),
      proof: removed.slice(0, 8).map(([name]) => ({ file: path, line: lineOf(beforeText, name) })), ids: [`file:${path}`] });
    if (changed.length) sentences.push({ kind: 'dependency-changed', severity: 'info', touches: [], side: 'after', origin: 'read',
      text: t('risk.dependencyChanged', { count: changed.length, file: path, list: list(changed.map(([name, item]) => `${name} ${old.get(name).version} → ${item.version}`)) }),
      proof: changed.slice(0, 8).map(([name]) => ({ file: path, line: lineOf(afterText, name) })), ids: [`file:${path}`] });
  }
  return sentences;
}

// --- Tests -------------------------------------------------------------------

const TEST_NAME = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;
const isTestFile = (graph, path) => graph.nodes.some(node => node.kind === 'file' && node.path === path && node.block === 'block:tests') || TEST_NAME.test(path);

// How many tests a file declares: it()/test() in JavaScript, def test_… in Python.
export function countTests(path, text) {
  if (path.endsWith('.py')) return [...text.matchAll(/^\s*(?:async\s+)?def\s+test\w*\s*\(/gm)].length;
  return [...text.matchAll(/(?<![\w.$])(?:it|test)(?:\.(?:only|concurrent|each\([^)]*\)))?\s*\(\s*[`'"]/g)].length;
}

function testRisks(before, after) {
  const sentences = [];
  const deleted = Object.keys(before.files).filter(path => !after.files[path] && isTestFile(before.graph, path)).sort();
  if (deleted.length) sentences.push({ kind: 'test-deleted', severity: 'warning', touches: [], side: 'before', origin: 'read',
    text: t('risk.testDeleted', { count: deleted.length, list: list(deleted) }), proof: deleted.slice(0, 8).map(path => ({ file: path, line: 1 })), ids: deleted.map(path => `file:${path}`) });
  for (const path of Object.keys(after.files).sort()) {
    if (!before.files[path] || before.files[path] === after.files[path] || !isTestFile(after.graph, path)) continue;
    const count = countTests(path, before.read(path) ?? '');
    const now = countTests(path, after.read(path) ?? '');
    if (now >= count) continue;
    sentences.push({ kind: 'tests-removed', severity: 'warning', touches: [], side: 'before', origin: 'read',
      text: t(now === 0 ? 'risk.testsEmptied' : 'risk.testsRemoved', { file: path, before: count, after: now, count: count - now }),
      proof: [{ file: path, line: 1 }], ids: [`file:${path}`] });
  }
  return sentences;
}

// --- Routes without a session check -------------------------------------------

// The session checks known to CodeTAC: middleware and helpers of the common
// libraries and the usual names (Express, Fastify, Next.js, NextAuth, Clerk,
// Supabase, FastAPI, Flask). A name not in this list is not seen.
export const SESSION_CHECKS = [
  /\b(?:require|ensure|check|verify|validate)[_-]?(?:auth\w*|user|login|logged\w*|session|token|jwt|admin|role)\b/i,
  /\b(?:is|has)[_-]?(?:authenticated|auth|logged[_-]?in|session|role|permission)\b/i,
  /\bauthenticate\w*\b|\bauthori[sz]e\w*\b/i,
  /\b(?:with|use)[_-]?(?:auth|session|user)\b/i,
  /\bauth[_-]?(?:required|guard|middleware|check|user)\b/i,
  /\b(?:login|jwt|auth|permission)[_-]?required\b/i,
  /\bget[_-]?current[_-]?(?:active[_-]?)?user\b|\bcurrent[_-]?user\b|\bcurrentUser\b/,
  /\bgetServerSession\b|\bgetSession\b|\bgetUser\b|\bgetToken\b|\bclerkMiddleware\b|\bauthMiddleware\b/,
  /\bauth\s*\(\s*\)|\bauth\s*\.\s*protect\b|\bpassport\s*\.\s*authenticate\b/,
  /\bsupabase\s*\.\s*auth\b|\b(?:req|request)\s*\.\s*(?:user|session|auth)\b|\bsession\s*\.\s*user\b/,
  /\b(?:HTTPBearer|HTTPBasic|OAuth2PasswordBearer|APIKeyHeader|APIKeyCookie)\b|\bSecurity\s*\(/,
];
const hasCheck = text => SESSION_CHECKS.some(pattern => pattern.test(text));
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HANDLER_LINES = 60;

// The text where a check would be: the handler (the function the route
// calls, from a few lines above it, where decorators and the registering line
// are, to its end), the lines of the route's proofs (where it is registered
// and mounted), the "use"/"dependencies" lines of those files, and a Next.js
// middleware.
const FILE_GUARDS = /\.\s*use\s*\(|\bdependencies\s*=|\bbefore_request\b|\baddHook\s*\(|\bpreHandler\b|\bonRequest\b/;
function guardText(side, route) {
  const parts = [];
  const graph = side.graph;
  const lines = path => (side.read(path) ?? '').split('\n');
  const files = new Set();
  const called = graph.edges.filter(edge => edge.kind === 'calls' && edge.from === route.id)
    .map(edge => graph.nodes.find(node => node.id === edge.to)).find(node => node?.kind === 'symbol');
  if (called) {
    const path = called.file.replace(/^file:/, '');
    files.add(path);
    parts.push(lines(path).slice(Math.max(0, called.line - 4), called.endLine ?? called.line + HANDLER_LINES).join('\n'));
  }
  for (const proof of route.proof ?? []) {
    files.add(proof.file);
    const text = lines(proof.file);
    parts.push(text.slice(Math.max(0, proof.line - 4), called ? proof.line : proof.line + HANDLER_LINES).join('\n'));
  }
  for (const path of files) parts.push(lines(path).filter(line => FILE_GUARDS.test(line)).join('\n'));
  for (const path of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']) if (side.files[path]) parts.push(side.read(path) ?? '');
  return parts.join('\n');
}

function routeRisks(diff, after) {
  const sentences = [];
  for (const route of diff.routes.added) {
    if (hasCheck(guardText(after, route))) continue;
    sentences.push({ kind: 'route-no-auth', severity: WRITES.has(route.method) ? 'warning' : 'info', touches: [], side: 'after', origin: 'possibly',
      text: t('risk.routeNoAuth', { route: route.name }), proof: (route.proof ?? []).slice(0, 2), ids: [route.id] });
  }
  return sentences;
}

// diff: diffGraphs(before.graph, after.graph).
export function promptRisks(diff, before, after) {
  return [...dependencyRisks(before, after), ...testRisks(before, after), ...routeRisks(diff, after)];
}
