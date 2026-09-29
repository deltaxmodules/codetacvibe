// The data model's findings (phase 6, step 3), computed from the graph
// (nothing here is stored in it):
//   - no-rls-browser (alert, the highest priority): a table whose row level
//     security is known to be off, reached directly from code that runs in the
//     browser — anyone with the public key can read or change it;
//   - used-not-defined (warning): the code uses a table no schema file defines;
//   - defined-never-used (warning): a schema file defines a table the code
//     never uses.
// The two inconsistencies need a schema source: in a project whose tables are
// all inferred from use, every table would be "not defined".
// Row level security itself is information, not an audit: it is shown per
// table (enabled, number of policies) where the project's SQL files say it.
const BROWSER = new Set(['client', 'both']);

export function dataFindings(graph) {
  const tables = graph.nodes.filter(node => node.kind === 'table');
  const files = new Map(graph.nodes.filter(node => node.kind === 'file').map(node => [node.id, node]));
  const fileOf = new Map(graph.nodes.filter(node => node.kind === 'symbol').map(node => [node.id, node.file]));
  const uses = new Map(tables.map(table => [table.id, []]));
  for (const edge of graph.edges) if ((edge.kind === 'reads' || edge.kind === 'writes') && uses.has(edge.to)) uses.get(edge.to).push(edge);
  const hasSchema = tables.some(table => !table.inferred);
  const findings = [];
  for (const table of tables) {
    const edges = uses.get(table.id);
    const browser = edges.filter(edge => BROWSER.has(files.get(fileOf.get(edge.from) ?? edge.from)?.runsOn));
    if (table.rls && !table.rls.enabled && browser.length) {
      findings.push({ kind: 'no-rls-browser', severity: 'alert', table: table.name, proof: [...table.rls.proof, ...browser.flatMap(edge => edge.proof)],
        browserFiles: [...new Set(browser.map(edge => files.get(fileOf.get(edge.from) ?? edge.from).path))] });
    }
    if (hasSchema && table.inferred) findings.push({ kind: 'used-not-defined', severity: 'warning', table: table.name, proof: edges.flatMap(edge => edge.proof) });
    if (!table.inferred && !edges.length) findings.push({ kind: 'defined-never-used', severity: 'warning', table: table.name, proof: table.proof });
  }
  const order = { alert: 0, warning: 1 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind) || a.table.localeCompare(b.table));
}

// The «Data model» view (phase 6, step 4): every table with its columns, RLS,
// readers and writers (by operation, with the file, the block and the line),
// the relations between tables, the findings, and where each table goes in
// the entity-relationship diagram. Nothing is stored; all comes from the graph.
const BOX_WIDTH = 230;
const HEADER = 34;
const ROW = 18;
const MAX_ROWS = 14;
const GAP_X = 110;
const GAP_Y = 40;

// Tables in columns by their relations: a table that points to no other is
// in the first column, one that points to a table of column n in column n+1
// (cycles and self-references are cut). Arrows then go from right to left.
// Tables known only from use come last. Inside a column, by name. Positions
// only depend on the graph: stable between readings.
export function dataLayout(tables, relations) {
  const known = new Set(tables.map(table => table.name));
  const targets = new Map(tables.map(table => [table.name, new Set()]));
  for (const relation of relations) if (known.has(relation.to) && relation.to !== relation.from) targets.get(relation.from).add(relation.to);
  const depth = new Map();
  const visiting = new Set();
  const depthOf = name => {
    if (depth.has(name)) return depth.get(name);
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const value = Math.max(-1, ...[...targets.get(name)].map(depthOf)) + 1;
    visiting.delete(name);
    depth.set(name, value);
    return value;
  };
  const defined = tables.filter(table => !table.inferred);
  for (const table of defined) depthOf(table.name);
  const columns = [];
  for (const table of [...defined].sort((a, b) => a.name.localeCompare(b.name))) (columns[depth.get(table.name)] ??= []).push(table);
  const inferred = tables.filter(table => table.inferred).sort((a, b) => a.name.localeCompare(b.name));
  if (inferred.length) columns.push(inferred);
  const heightOf = table => HEADER + Math.max(1, Math.min(table.columns.length, MAX_ROWS) + (table.columns.length > MAX_ROWS ? 1 : 0)) * ROW + 8;
  // A column taller than the diagram would be if it were square is split in
  // several (1250 tables known only from use would make one very tall column).
  const area = tables.reduce((sum, table) => sum + (heightOf(table) + GAP_Y) * (BOX_WIDTH + GAP_X), 0);
  const tallest = Math.max(600, Math.sqrt(area));
  const split = [];
  for (const column of columns.filter(Boolean)) {
    let part = [];
    let used = 0;
    for (const table of column) {
      if (part.length && used + heightOf(table) > tallest) { split.push(part); part = []; used = 0; }
      part.push(table);
      used += heightOf(table) + GAP_Y;
    }
    split.push(part);
  }
  const boxes = {};
  let height = 0;
  split.forEach((column, index) => {
    let y = 0;
    for (const table of column) { boxes[table.name] = { x: index * (BOX_WIDTH + GAP_X), y, w: BOX_WIDTH, h: heightOf(table) }; y += heightOf(table) + GAP_Y; }
    height = Math.max(height, y - GAP_Y);
  });
  const count = split.length;
  return { boxes, width: Math.max(count * (BOX_WIDTH + GAP_X) - GAP_X, 0), height: Math.max(height, 0), header: HEADER, row: ROW, maxRows: MAX_ROWS };
}

export function dataView(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const findings = dataFindings(graph);
  const users = new Map();
  for (const edge of graph.edges) {
    if (edge.kind !== 'reads' && edge.kind !== 'writes') continue;
    const table = nodes.get(edge.to);
    if (table?.kind !== 'table') continue;
    const from = nodes.get(edge.from);
    const file = from?.kind === 'symbol' ? nodes.get(from.file) : from;
    const block = nodes.get(file?.block);
    if (!users.has(table.id)) users.set(table.id, { readers: [], writers: [] });
    users.get(table.id)[edge.kind === 'reads' ? 'readers' : 'writers'].push({ name: from?.kind === 'symbol' ? from.name : null, file: file?.path ?? edge.from,
      block: block ? { id: block.id, name: block.name } : null, runsOn: file?.runsOn ?? null, operations: edge.operations ?? [], proof: edge.proof });
  }
  const useProofs = new Set([...users.values()].flatMap(use => [...use.readers, ...use.writers]).flatMap(item => item.proof.map(proof => `${proof.file}:${proof.line}`)));
  const byUse = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.proof[0]?.line ?? 0) - (b.proof[0]?.line ?? 0));
  const tables = graph.nodes.filter(node => node.kind === 'table').map(node => {
    const use = users.get(node.id) ?? { readers: [], writers: [] };
    return { id: node.id, name: node.name, store: node.store, inferred: Boolean(node.inferred), source: node.source ?? null, rls: node.rls ?? null,
      columns: (node.columns ?? []).map(column => ({ name: column.name, type: column.type ?? null, primaryKey: Boolean(column.primaryKey), nullable: column.nullable !== false,
        unique: Boolean(column.unique), references: column.references ?? null, proof: column.proof })),
      // Where it is defined: its proofs that are not uses (none when inferred).
      definedIn: node.inferred ? [] : node.proof.filter(proof => !useProofs.has(`${proof.file}:${proof.line}`)),
      readers: use.readers.sort(byUse), writers: use.writers.sort(byUse), findings: findings.filter(item => item.table === node.name).map(item => item.kind) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(tables.map(table => table.name));
  const relations = tables.flatMap(table => table.columns.filter(column => column.references).map(column => ({ from: table.name, column: column.name,
    to: column.references.table, toColumn: column.references.column ?? null, outside: !known.has(column.references.table), proof: column.proof })));
  const alerts = findings.filter(item => item.severity === 'alert');
  const warnings = findings.filter(item => item.severity !== 'alert');
  return {
    tables, relations, alerts, warnings, layout: dataLayout(tables, relations.filter(relation => !relation.outside)),
    summary: { tables: tables.length, inferred: tables.filter(table => table.inferred).length, withRls: tables.filter(table => table.rls?.enabled).length,
      rlsKnown: tables.filter(table => table.rls).length, alerts: alerts.length, warnings: warnings.length },
  };
}
