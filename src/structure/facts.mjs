// The facts an AI explanation may use (phase 10, step 1): for the whole plan
// and for one alert. Sentences built by rules from the graph and from the
// findings the views already computed (secrets, data model, structure health,
// changes); never code, never a value. Each explanation request is made of
// these facts only (explain.mjs), and the answer may only name what they name.
import { createHash } from 'node:crypto';
import { TEXT } from './text.mjs';

const MAX_PLACES = 10;
const MAX_LIST = 8;
const LAYERS = TEXT.layers;
const list = items => {
  const unique = [...new Set(items)];
  return unique.length > MAX_LIST ? `${unique.slice(0, MAX_LIST).join(', ')} and ${unique.length - MAX_LIST} more` : unique.join(', ');
};

// facts: { name, facts: [{ section, text }], names }
export function planFacts(graph, { secrets = null, data = null, health = null } = {}) {
  const facts = [];
  const names = new Set();
  const add = (section, text) => facts.push({ section, text });
  const files = graph.nodes.filter(node => node.kind === 'file');
  const blocks = graph.nodes.filter(node => node.kind === 'block');
  add('overview', `${files.length} files in ${blocks.length} blocks${graph.project.types.length ? `; recognised as ${graph.project.types.join(', ')}` : ''}.`);
  for (const block of blocks) {
    const inside = files.filter(file => file.block === block.id).map(file => file.path);
    names.add(block.name);
    for (const path of inside.slice(0, 5)) names.add(path);
    add('blocks', `${block.name}: ${inside.length} file${inside.length === 1 ? '' : 's'} (${list(inside.slice(0, 5))}${inside.length > 5 ? ', …' : ''}).`);
  }
  const pairs = new Map();
  for (const edge of graph.edges) {
    if (!edge.from.startsWith('block:') || !edge.to.startsWith('block:') || edge.from === edge.to) continue;
    const key = `${edge.from}\n${edge.to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + (edge.count ?? 1));
  }
  const blockName = id => blocks.find(block => block.id === id)?.name ?? id;
  for (const [key, count] of [...pairs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [from, to] = key.split('\n');
    add('dependencies', `${blockName(from)} uses ${blockName(to)} (${count} link${count === 1 ? '' : 's'}).`);
  }
  const routes = graph.nodes.filter(node => node.kind === 'route').map(node => node.name);
  for (const route of routes) names.add(route);
  if (routes.length) add('routes', `${routes.length} route${routes.length === 1 ? '' : 's'}: ${list(routes)}.`);
  const services = graph.nodes.filter(node => node.kind === 'service');
  for (const service of services) names.add(service.name);
  if (services.length) add('outside', `Data leaves the machine to ${services.length} service${services.length === 1 ? '' : 's'}: ${list(services.map(service => `${service.name} (${service.category})`))}.`);
  const tables = graph.nodes.filter(node => node.kind === 'table');
  for (const table of tables) names.add(table.name);
  if (tables.length) add('data', `${tables.length} table${tables.length === 1 ? '' : 's'}: ${list(tables.map(table => table.name + (table.rls ? (table.rls.enabled ? ' (row level security on)' : ' (row level security off)') : table.inferred ? ' (known only from use)' : '')))}.`);
  // Which alerts, with the names they are about: the explanation does not
  // have to guess which file or variable a count refers to.
  const about = item => [...new Set([item.variable, item.table, ...(item.files ?? []), ...(item.kind === 'literal-key' ? (item.proof ?? []).map(proof => proof.file) : [])].filter(Boolean))];
  const kindName = kind => (TEXT.explainFacts.kinds[kind]?.[0] ?? kind).replace(/\.$/, '').toLowerCase();
  if (secrets) {
    add('attention', `Secrets and variables: ${secrets.summary.alerts} alert${secrets.summary.alerts === 1 ? '' : 's'}, ${secrets.summary.warnings} warning${secrets.summary.warnings === 1 ? '' : 's'}.`);
    for (const item of [...secrets.alerts, ...secrets.warnings].slice(0, MAX_LIST)) {
      for (const name of about(item)) names.add(name);
      add('attention', `${item.severity === 'alert' ? 'Alert' : 'Warning'}: ${kindName(item.kind)}${about(item).length ? ` (${list(about(item))})` : ''}.`);
    }
  }
  if (data?.summary && tables.length) {
    add('attention', `Data model: ${data.summary.alerts} alert${data.summary.alerts === 1 ? '' : 's'}, ${data.summary.warnings} warning${data.summary.warnings === 1 ? '' : 's'}.`);
    for (const item of [...data.alerts, ...data.warnings].slice(0, MAX_LIST)) add('attention', `${item.severity === 'alert' ? 'Alert' : 'Warning'}: ${kindName(item.kind)} (${item.table}).`);
  }
  if (health) {
    const kinds = Object.entries(health.summary.byKind).map(([kind, count]) => `${TEXT.explainFacts.smellNames[kind] ?? kind} (${count})`);
    add('attention', health.summary.total ? `Structure health: ${list(kinds)}.` : 'Structure health: nothing to point out.');
    for (const [kind] of Object.entries(health.summary.byKind)) {
      const files = health.smells.filter(item => item.kind === kind).flatMap(item => item.files ?? (item.blockName ? [item.blockName] : []));
      for (const name of files) names.add(name);
      if (files.length) add('attention', `${TEXT.explainFacts.smellNames[kind] ?? kind}: ${list(files)}.`);
    }
  }
  return { name: graph.project.name, facts, names: [...names] };
}

// A stable key for an alert of a view: the same finding keeps its key while
// the graph says the same thing about it.
export function alertKey(source, item) {
  const { key: _key, target: _target, ...rest } = item;
  return createHash('sha256').update(`${source}\n${JSON.stringify(rest)}`).digest('hex').slice(0, 16);
}
export function withKeys(source, items) {
  return items.map(item => ({ ...item, key: alertKey(source, item) }));
}

// The facts of one alert. source: secrets | data | health | changes.
export function alertFacts(source, item, graph) {
  const facts = [];
  const names = new Set();
  const add = (section, text) => facts.push({ section, text });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const blockOf = path => nodes.get(nodes.get(`file:${path}`)?.block)?.name ?? null;
  const kinds = TEXT.explainFacts.kinds;
  if (source === 'changes') {
    add('what', item.text);
    add('why', kinds.change);
    if (item.side === 'before') add('details', 'It is about something that is gone: it is proven by the older version.');
    if (item.touches?.length) add('details', `It touches ${item.touches.join(' and ')}.`);
  } else {
    const [what, why] = kinds[item.kind] ?? [item.kind, ''];
    add('what', what);
    if (why) add('why', why);
    if (item.severity) add('details', `Severity: ${item.severity}.`);
    if (item.certainty === 'possible') add('details', `Only possibly: ${TEXT.plan[{ folder: 'healthBecauseFolder', name: 'healthBecauseName', public: 'healthBecausePublic', 'by-name': 'healthBecauseByName', vendor: 'healthBecauseVendor' }[item.because]] ?? item.because ?? 'the reading cannot be sure'}`);
    if (item.variable) { names.add(item.variable); add('details', `Variable: ${item.variable}.`); }
    if (item.table) { names.add(item.table); add('details', `Table: ${item.table}.`); }
    if (item.name) { names.add(item.name); add('details', `Function or value: ${item.name}.`); }
    if (item.files?.length) add('details', `Files: ${list(item.files)}.`);
    if (item.browserFiles?.length) add('details', `Runs in the browser: ${list(item.browserFiles)}.`);
    if (item.block || item.blockName) add('details', `Block: ${item.blockName ?? nodes.get(item.block)?.name ?? item.block}.`);
    if (item.to) add('details', `Uses the block: ${nodes.get(item.to)?.name ?? LAYERS[String(item.to).replace(/^block:/, '')] ?? item.to}.`);
    if (item.lines) add('details', `${item.lines} lines; the limit is ${item.limit}.`);
    if (item.count) add('details', `${item.count} files.`);
    if (item.tokens) add('details', `${item.tokens} tokens copied, in ${item.places ?? item.files?.length} places.`);
    if (item.message) add('details', item.message);
    for (const path of [...(item.files ?? []), ...(item.browserFiles ?? [])]) names.add(path);
  }
  const places = (item.proof ?? []).slice(0, MAX_PLACES);
  for (const proof of places) {
    names.add(proof.file);
    const block = blockOf(proof.file);
    if (block) names.add(block);
    add('places', `${proof.file} line ${proof.line}${block ? ` (${block})` : ''}.`);
  }
  if ((item.proof ?? []).length > MAX_PLACES) add('places', `And ${item.proof.length - MAX_PLACES} more places.`);
  return { name: source === 'changes' ? 'a change in the structure' : (kinds[item.kind]?.[0] ?? item.kind).replace(/\.$/, ''), facts, names: [...names] };
}
