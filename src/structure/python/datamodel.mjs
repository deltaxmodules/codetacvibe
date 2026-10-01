// Data model of a Python project (phase 11, step 5): the tables the project
// defines and which functions read and write them, from the facts of
// extract.py, in the same nodes and edges as the Node reader
// (node/datamodel.mjs, tableGraph).
//
// Where tables are defined, in order of preference (a table defined by a
// preferred source is not redefined by the next ones):
//   1. SQLAlchemy declarative models (__tablename__ + Column/mapped_column)
//      and SQLModel classes with table=True;
//   2. Alembic migrations, in path order, upgrade() only (create_table,
//      add_column, drop_column, drop_table, rename_table);
//   3. CREATE TABLE in SQL passed to execute()/executescript()/text().
// Uses: session.query(M) and M.query (Flask-SQLAlchemy), with the chained
// update()/delete(); select/insert/update/delete(M); session.get(M, …) and
// get_or_404; session.add/add_all/merge/delete of a model instance; SQL in
// execute()/text() (sqlAccess of the Node reader).
import { sqlAccess } from '../node/modules.mjs';
import { sqlTables as sqlCreateTables } from '../node/datamodel.mjs';

const MAX_PROOFS = 50;
const READS = new Set(['select']);
const last = name => name.split('.').pop();
const text = value => (value?.t === 'str' ? value.v : null);
const COLUMN_CALLS = new Set(['Column', 'mapped_column']);
const SQL_CALLS = new Set(['execute', 'executemany', 'executescript', 'exec_driver_sql', 'text', 'fetch', 'fetchrow', 'fetchval', 'fetchall', 'fetchone']);
const DRIVERS = [[/\b(psycopg2?|asyncpg|pg8000)\b/, 'postgres'], [/\b(pymysql|mysqlclient|aiomysql|mysql-connector)\b/, 'mysql'], [/\b(aiosqlite)\b/, 'sqlite']];
const SCHEMES = [[/^postgres(?:ql)?(?:\+\w+)?:\/\//, 'postgres'], [/^mysql(?:\+\w+)?:\/\//, 'mysql'], [/^sqlite(?:\+\w+)?:\/\//, 'sqlite'],
  [/^mariadb(?:\+\w+)?:\/\//, 'mysql'], [/^mssql(?:\+\w+)?:\/\//, 'mssql'], [/^oracle(?:\+\w+)?:\/\//, 'oracle']];

// The kind of database: a driver in the requirements, else the scheme of a
// literal URL in the code, else sqlite3 imported, else plain sql.
export function pythonStore(requirements, facts) {
  for (const [pattern, store] of DRIVERS) if (pattern.test(requirements)) return store;
  const strings = [];
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (value.t === 'str') strings.push(value.v);
    for (const item of Object.values(value)) if (item && typeof item === 'object') Array.isArray(item) ? item.forEach(collect) : collect(item);
  };
  for (const item of facts.values()) { for (const call of item.calls ?? []) collect(call); for (const assignment of item.assignments ?? []) collect(assignment.value); }
  for (const value of strings) for (const [pattern, store] of SCHEMES) if (pattern.test(value)) return store;
  if ([...facts.values()].some(item => (item.imports ?? []).some(entry => entry.module === 'sqlite3'))) return 'sqlite';
  return 'sql';
}

// The type of a column: the SQLAlchemy type named in the call, else the
// Python type of the annotation (Mapped[int], Optional[str]), in lower case.
function typeOf(args, annotation) {
  for (const value of args) {
    const name = value?.t === 'name' ? value.v : value?.t === 'call' && value.func?.t === 'name' ? value.func.v : null;
    if (name && !['ForeignKey', 'Sequence', 'Identity', 'Computed'].includes(last(name))) return last(name).toLowerCase();
  }
  return annotationType(annotation)?.type ?? null;
}
// Mapped[int] → int; Optional[str] / str | None → str, nullable.
function annotationType(annotation) {
  let value = annotation;
  let optional = false;
  for (let depth = 0; depth < 4 && value; depth++) {
    if (value.t === 'sub' && ['Mapped', 'Optional', 'typing.Optional'].includes(value.of?.v)) { optional ||= value.of.v !== 'Mapped'; value = value.key; continue; }
    if (value.t === 'other' && value.kind === 'BinOp') return { type: null, optional: true };
    break;
  }
  return value?.t === 'name' ? { type: last(value.v).toLowerCase(), optional } : null;
}
function referenceOf(args, keywords) {
  const target = args.map(value => (value?.t === 'call' && last(value.func?.v ?? '') === 'ForeignKey' ? text(value.args[0]) : null)).find(Boolean) ?? text(keywords.foreign_key);
  if (!target) return null;
  const [table, column] = target.split('.');
  return { table, ...(column ? { column } : {}) };
}
const flag = (keywords, name) => keywords[name]?.t === 'const' ? keywords[name].v === true : null;

// Tables of the models of one file: [{ name, model, columns, proof }].
function modelTables(path, item) {
  const tables = [];
  for (const definition of item.definitions ?? []) {
    if (definition.kind !== 'class') continue;
    const body = (item.assignments ?? []).filter(assignment => assignment.scope === definition.qualname);
    const tablename = body.find(assignment => assignment.targets[0]?.v === '__tablename__' && text(assignment.value));
    const sqlmodel = (definition.bases ?? []).some(base => base?.t === 'name' && last(base.v) === 'SQLModel') && definition.keywords?.table?.v === true;
    if (!tablename && !sqlmodel) continue;
    const columns = [];
    for (const assignment of body) {
      const target = assignment.targets[0];
      if (target?.t !== 'name' || target.v.startsWith('__')) continue;
      const value = assignment.value;
      const call = value?.t === 'call' && value.func?.t === 'name' ? value : null;
      const kind = call ? last(call.func.v) : null;
      if (COLUMN_CALLS.has(kind)) {
        const named = text(call.args[0]);
        const args = named ? call.args.slice(1) : call.args;
        const primaryKey = flag(call.kw, 'primary_key') === true;
        const nullable = flag(call.kw, 'nullable');
        const optional = annotationType(assignment.annotation)?.optional;
        columns.push({ name: named ?? target.v, ...(typeOf(args, assignment.annotation) ? { type: typeOf(args, assignment.annotation) } : {}),
          ...(primaryKey ? { primaryKey } : {}), nullable: primaryKey ? false : nullable ?? (kind === 'mapped_column' ? Boolean(optional) : true),
          ...(flag(call.kw, 'unique') ? { unique: true } : {}), ...(referenceOf(args, call.kw) ? { references: referenceOf(args, call.kw) } : {}),
          proof: { file: path, line: assignment.line } });
      } else if (sqlmodel && assignment.annotation && (!call || kind === 'Field')) {
        if (/^(ClassVar|Relationship|List|list)\b/.test(assignment.annotation.of?.v ?? assignment.annotation.v ?? '') || kind === 'Relationship') continue;
        const found = annotationType(assignment.annotation);
        const keywords = call?.kw ?? {};
        const primaryKey = flag(keywords, 'primary_key') === true;
        columns.push({ name: target.v, ...(found?.type ? { type: found.type } : {}), ...(primaryKey ? { primaryKey } : {}),
          nullable: primaryKey ? false : flag(keywords, 'nullable') ?? Boolean(found?.optional), ...(flag(keywords, 'unique') ? { unique: true } : {}),
          ...(referenceOf([], keywords) ? { references: referenceOf([], keywords) } : {}), proof: { file: path, line: assignment.line } });
      }
    }
    tables.push({ name: text(tablename?.value) ?? definition.name.toLowerCase(), model: definition.qualname, source: 'sqlalchemy', columns,
      proof: { file: path, line: tablename?.line ?? definition.line } });
  }
  return tables;
}

// Tables left by the upgrade() of the Alembic migrations, in path order.
function alembicTables(sources) {
  const tables = new Map();
  const column = (value, path) => {
    if (value?.t !== 'call' || !COLUMN_CALLS.has(last(value.func?.v ?? '')) || !text(value.args[0])) return null;
    const primaryKey = flag(value.kw, 'primary_key') === true;
    return { name: text(value.args[0]), ...(typeOf(value.args.slice(1)) ? { type: typeOf(value.args.slice(1)) } : {}), ...(primaryKey ? { primaryKey } : {}),
      nullable: primaryKey ? false : flag(value.kw, 'nullable') ?? true, ...(flag(value.kw, 'unique') ? { unique: true } : {}),
      ...(referenceOf(value.args.slice(1), value.kw) ? { references: referenceOf(value.args.slice(1), value.kw) } : {}), proof: { file: path, line: value.line } };
  };
  for (const { path, item } of sources) {
    // upgrade() and, in order, the functions of the same file it calls (create_users_table()…).
    const functions = new Set((item.definitions ?? []).filter(definition => definition.kind !== 'class' && !definition.qualname.includes('.')).map(definition => definition.qualname));
    const callsOf = (scope, seen) => (item.calls ?? []).filter(call => call.scope === scope).sort((a, b) => a.line - b.line).flatMap(call => {
      const name = call.func?.t === 'name' ? call.func.v : null;
      return name && functions.has(name) && !seen.has(name) ? callsOf(name, new Set([...seen, name])) : [call];
    });
    for (const call of callsOf('upgrade', new Set(['upgrade']))) {
      if (call.func?.t !== 'name' || !/^(op|alembic\.op)\./.test(call.func.v)) continue;
      const action = last(call.func.v);
      const name = text(call.args[0]);
      if (!name) continue;
      if (action === 'create_table') {
        tables.set(name, { name, source: 'alembic', columns: call.args.slice(1).map(value => column(value, path)).filter(Boolean), proof: { file: path, line: call.line } });
      } else if (action === 'add_column' && tables.has(name)) {
        const added = column(call.args[1], path);
        if (added) tables.get(name).columns.push(added);
      } else if (action === 'drop_column' && tables.has(name)) {
        const table = tables.get(name);
        table.columns = table.columns.filter(item => item.name !== text(call.args[1]));
      } else if (action === 'drop_table') tables.delete(name);
      else if (action === 'rename_table' && tables.has(name) && text(call.args[1])) {
        const table = tables.get(name);
        tables.delete(name);
        tables.set(text(call.args[1]), { ...table, name: text(call.args[1]) });
      }
    }
  }
  return [...tables.values()];
}

// The SQL texts of a file's calls: [{ text, line, scope }].
function sqlCalls(item) {
  return (item.calls ?? []).flatMap(call => {
    const name = call.func?.t === 'name' ? last(call.func.v) : call.func?.t === 'attr' ? call.func.name : null;
    const value = text(call.args[0]);
    return SQL_CALLS.has(name) && value && /\b(select|insert|update|delete|create|replace|merge|with)\b/i.test(value) ? [{ text: value, line: call.line, scope: call.scope }] : [];
  });
}

// { tables: [...] } defined by the project.
export function pythonDataModel(files, facts, { store = 'sql' } = {}) {
  const tables = new Map();
  const add = table => { if (!tables.has(table.name)) tables.set(table.name, table); };
  const readable = files.filter(file => facts.get(file.path) && !facts.get(file.path).error);
  for (const file of readable) for (const table of modelTables(file.path, facts.get(file.path))) add({ ...table, path: file.path });
  for (const table of alembicTables(readable.map(file => ({ path: file.path, item: facts.get(file.path) })))) add(table);
  const sql = readable.flatMap(file => sqlCalls(facts.get(file.path)).filter(call => /\bcreate\s+table\b/i.test(call.text))
    .map(call => ({ path: file.path, text: `${'\n'.repeat(call.line - 1)}${call.text}` })));
  for (const table of sqlCreateTables(sql)) add({ ...table, source: 'sql' });
  return { tables: [...tables.values()].map(table => ({ ...table, store })) };
}

// The nodes and reads/writes edges. `modules` (python/modules.mjs) gives the
// symbols and the names each file imports.
export function pythonTableGraph(model, files, facts, modules, { store = 'sql' } = {}) {
  const nodes = new Map(model.tables.map(table => [table.name, { id: `table:${table.name}`, kind: 'table', name: table.name, store: table.store, inferred: false,
    source: table.source, columns: table.columns.map(column => ({ ...column, proof: [column.proof] })), origin: 'static', proof: [table.proof] }]));
  // Model classes by file and name, to follow imports.
  const models = new Map(model.tables.filter(table => table.model).map(table => [`${table.path}#${table.model}`, table.name]));
  const edges = new Map();
  const use = (path, scope, owner, table, operation, line) => {
    if (!nodes.has(table)) nodes.set(table, { id: `table:${table}`, kind: 'table', name: table, store, inferred: true, origin: 'static', proof: [] });
    const node = nodes.get(table);
    const from = owner ? `symbol:${path}#${owner.name}@${owner.line}` : `file:${path}`;
    const kind = READS.has(operation) ? 'reads' : 'writes';
    const id = `${kind}:${from}->${node.id}`;
    if (!edges.has(id)) edges.set(id, { id, kind, from, to: node.id, origin: 'static', operations: [], proof: [] });
    const edge = edges.get(id);
    if (!edge.operations.includes(operation)) edge.operations.push(operation);
    for (const list of [edge.proof, node.proof]) if (list.length < MAX_PROOFS && !list.some(item => item.file === path && item.line === line)) list.push({ file: path, line });
  };
  for (const file of files) {
    const item = facts.get(file.path);
    const module = modules.get(file.path);
    if (!item || item.error || !module) continue;
    const symbols = new Map(module.symbols.map(symbol => [symbol.name, symbol]));
    const ownerOf = scope => {
      if (!scope) return null;
      const parts = scope.split('.');
      for (let length = parts.length; length > 0; length--) if (symbols.has(parts.slice(0, length).join('.'))) return symbols.get(parts.slice(0, length).join('.'));
      return null;
    };
    // The table a name means here: a model of this file, an imported model, models.Model.
    const tableOf = dotted => {
      if (!dotted) return null;
      const [head, ...rest] = dotted.split('.');
      if (!rest.length) {
        const local = models.get(`${file.path}#${head}`);
        if (local) return local;
        const bound = module.bindings.get(head);
        return bound && !bound.module ? models.get(`${bound.target}#${bound.name}`) ?? null : null;
      }
      const bound = module.bindings.get(head);
      return bound?.module && rest.length === 1 ? models.get(`${bound.target}#${rest[0]}`) ?? null : null;
    };
    const nameOf = value => (value?.t === 'name' ? value.v : null);
    // Local variables bound to a model instance or to a row read from a model: x = M(...), x = session.get(M, ...).
    const instances = new Map();
    for (const assignment of item.assignments ?? []) {
      const target = assignment.targets.length === 1 ? nameOf(assignment.targets[0]) : null;
      const table = target && modelOfValue(assignment.value);
      if (table) instances.set(`${assignment.scope ?? ''}:${target}`, table);
    }
    function modelOfValue(value) {
      if (value?.t !== 'call') return null;
      const called = nameOf(value.func);
      if (called && tableOf(called)) return tableOf(called);
      const verb = called ? last(called) : value.func?.t === 'attr' ? value.func.name : null;
      if (['get', 'get_or_404', 'first_or_404'].includes(verb) && tableOf(nameOf(value.args[0]))) return tableOf(nameOf(value.args[0]));
      return queryModel(value)?.table ?? null;
    }
    // session.query(M)… or M.query… : the model and the methods chained on it.
    function queryModel(call) {
      const chain = [];
      let current = call;
      while (current?.t === 'call' && current.func?.t === 'attr') { chain.push(current.func.name); current = current.func.of; }
      if (current?.t !== 'call' || current.func?.t !== 'name') return null;
      const parts = current.func.v.split('.');
      chain.push(...parts.slice(parts.indexOf('query') + 1).reverse());
      if (last(current.func.v) === 'query' && tableOf(nameOf(current.args[0]))) return { table: tableOf(nameOf(current.args[0])), chain, base: current };
      const at = parts.indexOf('query');
      if (at > 0 && tableOf(parts.slice(0, at).join('.'))) return { table: tableOf(parts.slice(0, at).join('.')), chain, base: current };
      return null;
    }
    const seenQueries = new Map();
    for (const call of item.calls ?? []) {
      const owner = ownerOf(call.scope);
      const called = nameOf(call.func);
      const verb = called ? last(called) : call.func?.t === 'attr' ? call.func.name : null;
      // Queries: one use per query, the strongest operation of its chain.
      const query = queryModel({ t: 'call', ...call });
      if (query) {
        const key = `${query.base.line}:${query.table}`;
        const operation = query.chain.includes('delete') ? 'delete' : query.chain.includes('update') ? 'update' : 'select';
        const known = seenQueries.get(key);
        if (!known || (known.operation === 'select' && operation !== 'select')) seenQueries.set(key, { owner, table: query.table, operation, line: query.base.line, scope: call.scope });
        continue;
      }
      if (['select', 'insert', 'update', 'delete'].includes(verb) && called && !called.includes('.') || /^(sqlalchemy|sa|sqlmodel)\.(select|insert|update|delete)$/.test(called ?? '')) {
        const table = tableOf(nameOf(call.args[0]));
        if (table) use(file.path, call.scope, owner, table, verb, call.line);
        continue;
      }
      if (['get', 'get_or_404', 'first_or_404'].includes(verb) && call.args.length >= 1 && tableOf(nameOf(call.args[0]))) {
        use(file.path, call.scope, owner, tableOf(nameOf(call.args[0])), 'select', call.line);
        continue;
      }
      if (['add', 'add_all', 'merge', 'delete'].includes(verb) && call.args[0]) {
        const operation = verb === 'delete' ? 'delete' : verb === 'merge' ? 'upsert' : 'insert';
        const values = verb === 'add_all' && call.args[0].t === 'list' ? call.args[0].items : [call.args[0]];
        for (const value of values) {
          const local = nameOf(value);
          const table = local && !local.includes('.') ? instances.get(`${call.scope ?? ''}:${local}`) : modelOfValue(value);
          if (table) use(file.path, call.scope, owner, table, operation, call.line);
        }
        continue;
      }
    }
    for (const found of seenQueries.values()) use(file.path, found.scope, found.owner, found.table, found.operation, found.line);
    for (const call of sqlCalls(item)) {
      for (const access of sqlAccess(call.text)) use(file.path, call.scope, ownerOf(call.scope), access.table, access.operation, call.line);
    }
  }
  for (const edge of edges.values()) edge.operations.sort();
  return { nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)), edges: [...edges.values()] };
}
