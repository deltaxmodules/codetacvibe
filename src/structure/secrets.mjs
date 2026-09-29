// Secrets and variables (phase 5): what is wrong or worth knowing about the
// project's variables and keys, computed from the graph (nothing here is
// stored in it). Only names, places and kinds: never a value (principle 4).
//
// Step 2 — exposure: a variable with a secret's name that reaches the browser.
//   - public-secret: its name has the framework's public prefix, so the build
//     puts its value in the browser code (always an alert; a service_role key
//     too, whatever its name);
//   - secret-in-browser: read in code that runs in the browser without the
//     prefix: the value is empty there (and adding the prefix would expose it).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Edges by the node they reach, built once per view (a project can have hundreds of variables).
const edgesTo = graph => { const map = new Map(); for (const edge of graph.edges) { if (!map.has(edge.to)) map.set(edge.to, []); map.get(edge.to).push(edge); } return map; };
const fileNodes = graph => new Map(graph.nodes.filter(node => node.kind === 'file').map(node => [node.id, node]));

export function exposure(graph) {
  const files = fileNodes(graph);
  const into = edgesTo(graph);
  const findings = [];
  for (const variable of graph.nodes.filter(node => node.kind === 'env' && node.secretLike)) {
    const reads = (into.get(variable.id) ?? []).filter(edge => edge.kind === 'uses-secret' || edge.kind === 'reads');
    const inBrowser = reads.filter(edge => ['client', 'both'].includes(files.get(edge.from)?.runsOn));
    if (variable.public) {
      findings.push({ kind: 'public-secret', severity: 'alert', variable: variable.name, proof: variable.proof,
        browserFiles: inBrowser.map(edge => files.get(edge.from).path) });
    } else if (inBrowser.length) {
      findings.push({ kind: 'secret-in-browser', severity: 'warning', variable: variable.name, proof: inBrowser.flatMap(edge => edge.proof),
        browserFiles: inBrowser.map(edge => files.get(edge.from).path) });
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? (a.variable < b.variable ? -1 : 1) : a.severity === 'alert' ? -1 : 1));
}

// Step 3 — .env files and git, read from the project folder (git itself, not
// only the .gitignore): a .env followed by git is an alert (its values are in
// the history); one git would add with the next `git add -A` is a warning.
// Examples meant to be shared (.env.example, .sample, .template…) are fine.
// Only paths are looked at, never the contents.
const EXAMPLE = /\.(example|sample|template|dist|defaults)$/i;
function git(root, args) {
  try { return { ok: true, out: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }; }
  catch (error) { return { ok: false, status: error.status ?? null }; }
}
export function envInGit(root, envPaths) {
  const files = envPaths.filter(path => !EXAMPLE.test(path));
  if (!files.length) return [];
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') {
    // No repository: only the .gitignore at the root can be read.
    let rules = '';
    try { rules = readFileSync(join(root, '.gitignore'), 'utf8'); } catch {}
    const covered = /^\s*\/?\.env(\*|\.\*|\b)/m.test(rules);
    return covered ? [] : [{ kind: 'env-no-git', severity: 'warning', files, proof: files.map(file => ({ file, line: 1 })) }];
  }
  const tracked = new Set(git(root, ['ls-files', '-z', '--', ...files]).out?.split('\0').filter(Boolean) ?? []);
  const findings = [];
  for (const file of files) {
    if (tracked.has(file)) { findings.push({ kind: 'env-tracked', severity: 'alert', files: [file], proof: [{ file, line: 1 }] }); continue; }
    // check-ignore answers 0 when a rule covers the path, 1 when none does.
    if (git(root, ['check-ignore', '-q', '--', file]).status === 1) findings.push({ kind: 'env-not-ignored', severity: 'warning', files: [file], proof: [{ file, line: 1 }] });
  }
  return findings;
}

// Step 5 — the "Secrets and variables" view: alerts, warnings, and the two
// separate lists the specification asks for — defined but never used (in a
// real .env; an example file documents variables, it does not set them) and
// used but never defined (in no .env*, examples included). Variables the
// tools always set (NODE_ENV, Vite's MODE…) are never "undefined".
const SET_BY_TOOLS = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);
const ALERT_KINDS = new Set(['public-secret', 'env-tracked', 'literal-key']);

export function secretsView(graph, { root, platform = [] }) {
  const setOutside = new Set(platform);
  const files = fileNodes(graph);
  const envFiles = [...files.values()].filter(file => file.language === 'dotenv').map(file => file.path);
  const isExample = path => EXAMPLE.test(path);
  const findings = [
    ...exposure(graph),
    ...envInGit(root, envFiles),
    ...(graph.notes ?? []).filter(note => note.kind === 'literal-key').map(note => ({ kind: 'literal-key', severity: 'alert', message: note.message, proof: note.proof ?? [] })),
  ];
  const into = edgesTo(graph);
  const variables = graph.nodes.filter(node => node.kind === 'env').map(node => {
    const reads = (into.get(node.id) ?? []).filter(edge => edge.kind === 'reads' || edge.kind === 'uses-secret');
    const definedIn = node.proof.filter(proof => files.get(`file:${proof.file}`)?.language === 'dotenv');
    const readIn = reads.map(edge => ({ file: files.get(edge.from)?.path ?? edge.from, runsOn: files.get(edge.from)?.runsOn ?? null, proof: edge.proof }));
    return { name: node.name, public: Boolean(node.public), secretLike: Boolean(node.secretLike), definedIn, readIn, platform: setOutside.has(node.name) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const unused = variables.filter(item => !item.readIn.length && item.definedIn.some(proof => !isExample(proof.file)))
    .map(item => ({ variable: item.name, proof: item.definedIn.filter(proof => !isExample(proof.file)) }));
  const undefinedVars = variables.filter(item => item.readIn.length && !item.definedIn.length && !SET_BY_TOOLS.has(item.name) && !item.platform)
    .map(item => ({ variable: item.name, proof: item.readIn.flatMap(read => read.proof) }));
  return {
    alerts: findings.filter(item => ALERT_KINDS.has(item.kind)),
    warnings: findings.filter(item => !ALERT_KINDS.has(item.kind)),
    unused, undefined: undefinedVars, variables,
    summary: { variables: variables.length, secrets: variables.filter(item => item.secretLike).length, alerts: findings.filter(item => ALERT_KINDS.has(item.kind)).length,
      warnings: findings.filter(item => !ALERT_KINDS.has(item.kind)).length, unused: unused.length, undefined: undefinedVars.length },
  };
}
