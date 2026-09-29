// The data model of a project (phase 6, step 1): the tables its schema files
// define, with their columns, keys and relations. Sources, by preference:
// Prisma (schema.prisma), Drizzle (pgTable/mysqlTable/sqliteTable), SQL
// migrations (CREATE/ALTER/DROP TABLE, in path order) and the types Supabase
// generates. A table defined by a preferred source is not redefined by a later
// one. The code's use of tables (step 2) links functions to them and adds
// the tables known only from that use, marked inferred.
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parserPlugins } from './modules.mjs';
import { enclosing } from './outgoing.mjs';

export const SOURCES = ['prisma', 'drizzle', 'sql', 'supabase-types'];
const PRISMA_STORES = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'sqlserver', mongodb: 'mongodb', cockroachdb: 'cockroachdb' };
const DRIZZLE_STORES = { pgTable: 'postgres', mysqlTable: 'mysql', sqliteTable: 'sqlite' };
const CODE = new Set(['js', 'jsx', 'ts', 'tsx']);

// Unquoted SQL names fold to lower case; the public schema is left out.
function sqlName(raw) {
  const parts = raw.split('.').map(part => (/^["`[]/.test(part) ? part.slice(1, -1) : part.toLowerCase()));
  if (parts.length > 1 && parts[0] === 'public') parts.shift();
  return parts.join('.');
}

// Statements of an SQL file with the line each starts on. Comments, strings,
// quoted names and $$ bodies never split a statement.
export function sqlStatements(text) {
  const statements = [];
  let start = -1;
  let line = 1;
  let startLine = 1;
  let body = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const rest = text.slice(index, index + 2);
    if (rest === '--') {
      const end = text.indexOf('\n', index);
      index = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (rest === '/*') {
      const end = text.indexOf('*/', index + 2);
      const skipped = text.slice(index, end === -1 ? text.length : end + 2);
      line += skipped.split('\n').length - 1;
      body += '\n'.repeat(skipped.split('\n').length - 1);
      index += skipped.length - 1;
      continue;
    }
    if (char === ';') {
      if (body.trim()) statements.push({ text: body.trim(), line: startLine });
      body = '';
      start = -1;
      continue;
    }
    if (start === -1 && !/\s/.test(char)) { start = index; startLine = line; body = ''; }
    let piece = char;
    const dollar = char === '$' ? text.slice(index).match(/^\$[A-Za-z_]*\$/) : null;
    const closing = dollar ? dollar[0] : char === "'" || char === '"' || char === '`' ? char : null;
    if (closing) {
      const end = text.indexOf(closing, index + closing.length);
      piece = text.slice(index, end === -1 ? text.length : end + closing.length);
      index += piece.length - 1;
    }
    line += piece.split('\n').length - 1;
    if (start !== -1) body += piece;
  }
  if (body.trim()) statements.push({ text: body.trim(), line: startLine });
  return statements;
}

// Pieces separated by commas outside parentheses, each with its line offset.
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"') { index = text.indexOf(char, index + 1); if (index === -1) break; continue; }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if ((char === ',' && depth === 0) || index === text.length) {
      const raw = text.slice(from, index);
      const lead = raw.match(/^\s*/)[0];
      if (raw.trim()) parts.push({ text: raw.trim(), offset: text.slice(0, from).split('\n').length - 1 + lead.split('\n').length - 1 });
      from = index + 1;
    }
  }
  return parts;
}

// The text between the parenthesis at `open` and its match.
function enclosed(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "'" || text[index] === '"') { index = text.indexOf(text[index], index + 1); if (index === -1) return null; continue; }
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) return text.slice(open + 1, index);
  }
  return null;
}

const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*))?`;
const names = list => list.split(',').map(item => sqlName(item.trim())).filter(Boolean);
const CONSTRAINT_WORDS = /^(?:not\s+null|null|primary\s+key|references|default|unique|check|generated|constraint|collate)\b/i;

function referencesOf(text) {
  const match = text.match(new RegExp(String.raw`\breferences\s+(${NAME})\s*(?:\(([^)]*)\))?`, 'i'));
  if (!match) return null;
  const column = match[2] ? names(match[2])[0] : null;
  return { table: sqlName(match[1]), ...(column ? { column } : {}) };
}

// One column definition of CREATE TABLE or ALTER TABLE … ADD COLUMN.
function sqlColumn(text, proof) {
  const match = text.match(new RegExp(String.raw`^(${NAME})\s*(.*)$`, 's'));
  if (!match) return null;
  const words = match[2].split(/\s+/);
  const type = [];
  while (words.length && !CONSTRAINT_WORDS.test(words.join(' '))) type.push(words.shift());
  const rest = words.join(' ');
  const primaryKey = /\bprimary\s+key\b/i.test(rest);
  const references = referencesOf(rest);
  return { name: sqlName(match[1]), ...(type.length ? { type: type.join(' ').toLowerCase() } : {}), ...(primaryKey ? { primaryKey: true } : {}),
    nullable: !primaryKey && !/\bnot\s+null\b/i.test(rest), ...(/\bunique\b/i.test(rest) ? { unique: true } : {}), ...(references ? { references } : {}), proof };
}

// A table constraint: PRIMARY KEY (…), FOREIGN KEY (…) REFERENCES …, UNIQUE (…).
function sqlConstraint(table, text) {
  const body = text.replace(/^constraint\s+\S+\s+/i, '');
  const key = body.match(/^primary\s+key\s*\(([^)]*)\)/i);
  if (key) for (const name of names(key[1])) { const column = table.columns.find(item => item.name === name); if (column) { column.primaryKey = true; column.nullable = false; } }
  const foreign = body.match(/^foreign\s+key\s*\(([^)]*)\)/i);
  const references = foreign ? referencesOf(body) : null;
  if (foreign && references) for (const name of names(foreign[1])) { const column = table.columns.find(item => item.name === name); if (column) column.references = references; }
  const unique = body.match(/^unique\s*\(([^)]*)\)/i);
  if (unique && names(unique[1]).length === 1) { const column = table.columns.find(item => item.name === names(unique[1])[0]); if (column) column.unique = true; }
  return Boolean(key || foreign || unique || /^(?:check|exclude)\b/i.test(body));
}

// Tables left by running the SQL files in path order.
export function sqlTables(sources) {
  const tables = new Map();
  for (const { path, text } of sources) {
    for (const statement of sqlStatements(text)) {
      const proof = offset => ({ file: path, line: statement.line + offset });
      const create = statement.text.match(new RegExp(String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${NAME})`, 'i'));
      if (create) {
        const table = { name: sqlName(create[1]), columns: [], proof: proof(0) };
        const open = statement.text.indexOf('(', create[0].length);
        const inner = open !== -1 && !/^\s*(?:as|partition)\b/i.test(statement.text.slice(create[0].length)) ? enclosed(statement.text, open) : null;
        if (inner != null) {
          const before = statement.text.slice(0, open + 1).split('\n').length - 1;
          for (const part of topLevel(inner)) {
            if (sqlConstraint(table, part.text) || /^like\b/i.test(part.text)) continue;
            const column = sqlColumn(part.text, proof(before + part.offset));
            if (column) table.columns.push(column);
          }
        }
        tables.set(table.name, table);
        continue;
      }
      const drop = statement.text.match(/^drop\s+table\s+(?:if\s+exists\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/is);
      if (drop) { for (const name of names(drop[1])) tables.delete(name); continue; }
      const alter = statement.text.match(new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})\s+`, 'i'));
      if (!alter || !tables.has(sqlName(alter[1]))) continue;
      const table = tables.get(sqlName(alter[1]));
      const actions = statement.text.slice(alter[0].length);
      const offsetOf = statement.text.slice(0, alter[0].length).split('\n').length - 1;
      for (const action of topLevel(actions)) {
        const at = proof(offsetOf + action.offset);
        const rename = action.text.match(new RegExp(String.raw`^rename\s+to\s+(${NAME})$`, 'i'));
        if (rename) { tables.delete(table.name); table.name = sqlName(rename[1]); tables.set(table.name, table); continue; }
        const renameColumn = action.text.match(new RegExp(String.raw`^rename\s+(?:column\s+)?(${NAME})\s+to\s+(${NAME})$`, 'i'));
        if (renameColumn) { const column = table.columns.find(item => item.name === sqlName(renameColumn[1])); if (column) column.name = sqlName(renameColumn[2]); continue; }
        const dropColumn = action.text.match(new RegExp(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${NAME})`, 'i'));
        if (dropColumn && !/^drop\s+constraint\b/i.test(action.text)) { table.columns = table.columns.filter(item => item.name !== sqlName(dropColumn[1])); continue; }
        const add = action.text.match(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i);
        if (!add) continue;
        const definition = action.text.slice(add[0].length);
        if (sqlConstraint(table, definition)) continue;
        const column = sqlColumn(definition, at);
        if (column) table.columns = [...table.columns.filter(item => item.name !== column.name), column];
      }
    }
  }
  return [...tables.values()];
}

// Row level security from the SQL files, in path order: per table, whether
// it is enabled (ALTER TABLE … ENABLE/DISABLE ROW LEVEL SECURITY) and its
// policies (CREATE/DROP POLICY … ON table). Tables no file mentions are absent.
export function sqlSecurity(sources) {
  const tables = new Map();
  const entry = name => { if (!tables.has(name)) tables.set(name, { enabled: false, policies: new Map(), proof: null }); return tables.get(name); };
  for (const { path, text } of sources) {
    for (const statement of sqlStatements(text)) {
      const proof = { file: path, line: statement.line };
      const create = statement.text.match(new RegExp(String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${NAME})`, 'i'));
      if (create) { const item = entry(sqlName(create[1])); item.enabled = false; item.policies.clear(); item.proof = proof; continue; }
      const drop = statement.text.match(/^drop\s+table\s+(?:if\s+exists\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/is);
      if (drop) { for (const name of names(drop[1])) tables.delete(name); continue; }
      const rls = statement.text.match(new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})\s+(enable|disable)\s+row\s+level\s+security`, 'i'));
      if (rls) { const item = entry(sqlName(rls[1])); item.enabled = rls[2].toLowerCase() === 'enable'; item.proof = proof; continue; }
      const rename = statement.text.match(new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})\s+rename\s+to\s+(${NAME})$`, 'i'));
      if (rename && tables.has(sqlName(rename[1]))) { const item = tables.get(sqlName(rename[1])); tables.delete(sqlName(rename[1])); tables.set(sqlName(rename[2]), item); continue; }
      const policy = statement.text.match(new RegExp(String.raw`^(create|drop)\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\S+)\s+on\s+(${NAME})`, 'i'));
      if (policy) {
        const item = entry(sqlName(policy[3]));
        if (policy[1].toLowerCase() === 'create') item.policies.set(policy[2], proof);
        else item.policies.delete(policy[2]);
      }
    }
  }
  return new Map([...tables].map(([name, item]) => [name, { enabled: item.enabled, policies: item.policies.size,
    proof: [...(item.proof ? [item.proof] : []), ...item.policies.values()] }]));
}

// Prisma: models become tables (@@map names them), scalar fields columns
// (@map), @id/@@id keys and @relation(fields, references) the relations.
export function prismaTables(sources) {
  const blocks = [];
  let store = null;
  for (const { path, text } of sources) {
    const lines = text.split('\n');
    let current = null;
    lines.forEach((raw, index) => {
      const line = raw.replace(/\/\/.*$/, '').trim();
      const open = line.match(/^(model|enum|type|datasource|generator|view)\s+(\w+)\s*\{/);
      if (open) { current = { kind: open[1], name: open[2], fields: [], attributes: [], path, line: index + 1 }; blocks.push(current); return; }
      if (line === '}') { current = null; return; }
      if (!current || !line) return;
      if (current.kind === 'datasource') { const provider = line.match(/^provider\s*=\s*"([^"]+)"/); if (provider) store = PRISMA_STORES[provider[1]] ?? provider[1]; return; }
      if (line.startsWith('@@')) { current.attributes.push(line); return; }
      const field = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (field) current.fields.push({ name: field[1], type: field[2], list: Boolean(field[3]), optional: Boolean(field[4]), attributes: field[5], line: index + 1 });
    });
  }
  const models = new Map(blocks.filter(block => block.kind === 'model').map(block => {
    const mapped = block.attributes.map(item => item.match(/^@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/)).find(Boolean);
    return [block.name, { block, table: mapped ? mapped[1] : block.name }];
  }));
  const tables = [];
  for (const { block, table: name } of models.values()) {
    const columnName = field => field.attributes.match(/@map\(\s*(?:name\s*:\s*)?"([^"]+)"/)?.[1] ?? field.name;
    const columns = [];
    for (const field of block.fields) {
      if (models.has(field.type) || field.list) continue;
      columns.push({ name: columnName(field), type: field.type, ...(/@id\b/.test(field.attributes) ? { primaryKey: true } : {}), nullable: field.optional,
        ...(/@unique\b/.test(field.attributes) ? { unique: true } : {}), proof: { file: block.path, line: field.line } });
    }
    const byField = new Map(block.fields.map(field => [field.name, field]));
    for (const attribute of block.attributes) {
      const ids = attribute.match(/^@@id\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]/);
      if (ids) for (const item of ids[1].split(',').map(part => part.trim())) { const column = columns.find(entry => entry.name === columnName(byField.get(item) ?? { name: item, attributes: '' })); if (column) column.primaryKey = true; }
    }
    for (const field of block.fields) {
      const target = models.get(field.type);
      const relation = target && field.attributes.match(/@relation\(([^)]*)\)/);
      const from = relation?.[1].match(/fields\s*:\s*\[([^\]]*)\]/);
      const to = relation?.[1].match(/references\s*:\s*\[([^\]]*)\]/);
      if (!from || !to) continue;
      const targetFields = new Map(target.block.fields.map(item => [item.name, item]));
      from[1].split(',').map(part => part.trim()).forEach((item, index) => {
        const column = columns.find(entry => entry.name === columnName(byField.get(item) ?? { name: item, attributes: '' }));
        const referenced = to[1].split(',').map(part => part.trim())[index];
        if (column && referenced) column.references = { table: target.table, column: columnName(targetFields.get(referenced) ?? { name: referenced, attributes: '' }) };
      });
    }
    tables.push({ name, model: block.name, store, columns, proof: { file: block.path, line: block.line } });
  }
  return tables;
}

// Babel tree of a code file, or null.
function tree(path, text) {
  const language = path.endsWith('.tsx') ? 'tsx' : /\.[mc]?ts$/.test(path) ? 'ts' : 'js';
  try { return parse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: parserPlugins(path, language) }); } catch { return null; }
}

const stringOf = node => (node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null);

// Drizzle: const users = pgTable('users', { id: serial('id').primaryKey(), … }).
export function drizzleTables(sources) {
  const found = [];
  for (const { path, text } of sources) {
    const ast = tree(path, text);
    if (!ast) continue;
    const visit = node => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression'
        && node.init.callee.type === 'Identifier' && DRIZZLE_STORES[node.init.callee.name] && stringOf(node.init.arguments[0])) {
        let shape = node.init.arguments[1];
        if (shape && /Function|Arrow/.test(shape.type)) shape = shape.body?.type === 'ObjectExpression' ? shape.body : null;
        found.push({ variable: node.id.name, name: stringOf(node.init.arguments[0]), store: DRIZZLE_STORES[node.init.callee.name], shape, path, line: node.loc.start.line });
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value.type === 'string') visit(value);
      }
    };
    visit(ast.program);
  }
  const byVariable = new Map(found.map(item => [item.variable, item.name]));
  return found.map(({ variable, name, store, shape, path, line }) => {
    const columns = [];
    for (const property of shape?.properties ?? []) {
      if (property.type !== 'ObjectProperty') continue;
      const key = property.key.name ?? stringOf(property.key);
      const calls = [];
      let node = property.value;
      while (node?.type === 'CallExpression') {
        calls.unshift(node);
        node = node.callee.type === 'MemberExpression' ? node.callee.object : null;
      }
      const root = calls[0];
      if (!root || root.callee.type !== 'Identifier') continue;
      const methods = new Map(calls.slice(1).map(call => [call.callee.property?.name, call]));
      const reference = methods.get('references')?.arguments[0];
      const target = reference && /Function|Arrow/.test(reference.type) ? reference.body : null;
      const references = target?.type === 'MemberExpression' && target.object.type === 'Identifier' && byVariable.has(target.object.name)
        ? { table: byVariable.get(target.object.name), column: columnOf(found.find(item => item.variable === target.object.name), target.property.name) } : null;
      columns.push({ name: stringOf(root.arguments[0]) ?? key, type: root.callee.name, ...(methods.has('primaryKey') ? { primaryKey: true } : {}),
        nullable: !methods.has('primaryKey') && !methods.has('notNull'), ...(methods.has('unique') ? { unique: true } : {}), ...(references ? { references } : {}),
        proof: { file: path, line: property.loc.start.line } });
    }
    return { name, variable, store, columns, proof: { file: path, line } };
  });
}

// The database name of a Drizzle column, from its table's shape.
function columnOf(table, key) {
  const property = table?.shape?.properties?.find(item => (item.key?.name ?? stringOf(item.key)) === key);
  let node = property?.value;
  while (node?.type === 'CallExpression' && node.callee.type === 'MemberExpression') node = node.callee.object;
  return (node?.type === 'CallExpression' && stringOf(node.arguments[0])) || key;
}

// Supabase generated types: Database[schema].Tables[table].Row and Relationships.
export function supabaseTypeTables(sources) {
  const tables = [];
  const members = node => (node?.type === 'TSTypeLiteral' ? node.members : node?.type === 'TSInterfaceBody' ? node.body : []);
  const member = (node, name) => members(node).find(item => item.type === 'TSPropertySignature' && (item.key.name ?? item.key.value) === name);
  for (const { path, text } of sources) {
    const ast = tree(path, text);
    if (!ast) continue;
    for (const statement of ast.program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      const shape = declaration?.type === 'TSTypeAliasDeclaration' && declaration.id.name === 'Database' ? declaration.typeAnnotation
        : declaration?.type === 'TSInterfaceDeclaration' && declaration.id.name === 'Database' ? declaration.body : null;
      for (const schema of members(shape)) {
        const schemaName = schema.key?.name ?? schema.key?.value;
        const list = member(schema.typeAnnotation?.typeAnnotation, 'Tables');
        for (const entry of members(list?.typeAnnotation?.typeAnnotation)) {
          const tableName = entry.key?.name ?? entry.key?.value;
          if (!tableName) continue;
          const name = schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
          const row = member(entry.typeAnnotation?.typeAnnotation, 'Row');
          const columns = members(row?.typeAnnotation?.typeAnnotation).filter(item => item.type === 'TSPropertySignature').map(item => {
            const type = item.typeAnnotation?.typeAnnotation;
            const parts = type?.type === 'TSUnionType' ? type.types : [type];
            const shown = parts.filter(part => part && part.type !== 'TSNullKeyword').map(part => text.slice(part.start, part.end)).join(' | ');
            return { name: item.key.name ?? item.key.value, ...(shown ? { type: shown } : {}), nullable: parts.some(part => part?.type === 'TSNullKeyword'),
              proof: { file: path, line: item.loc.start.line } };
          });
          const relations = member(entry.typeAnnotation?.typeAnnotation, 'Relationships')?.typeAnnotation?.typeAnnotation;
          for (const relation of relations?.elementTypes ?? []) {
            const field = key => member(relation, key)?.typeAnnotation?.typeAnnotation;
            const literal = node => (node?.type === 'TSLiteralType' ? node.literal.value : null);
            const tuple = node => (node?.elementTypes ?? []).map(literal);
            const from = tuple(field('columns'));
            const to = tuple(field('referencedColumns'));
            const target = literal(field('referencedRelation'));
            from.forEach((item, index) => {
              const column = columns.find(entry => entry.name === item);
              if (column && target) column.references = { table: target, ...(to[index] ? { column: to[index] } : {}) };
            });
          }
          tables.push({ name, store: 'supabase', columns, proof: { file: path, line: entry.loc.start.line } });
        }
      }
    }
  }
  return tables;
}

// Store of plain SQL: Supabase's folder, else the project's database client.
function sqlStore(path, packages) {
  if (path.startsWith('supabase/') || path.includes('/supabase/')) return 'supabase';
  if (packages.has('pg') || packages.has('postgres') || packages.has('@neondatabase/serverless') || packages.has('@vercel/postgres')) return 'postgres';
  if (packages.has('mysql2') || packages.has('mysql')) return 'mysql';
  if (packages.has('better-sqlite3') || packages.has('sqlite3') || packages.has('@libsql/client')) return 'sqlite';
  return 'sql';
}

// { tables: [{ name, source, store, columns, proof, model?, variable? }] } for a project.
// modules (the parsed files, when the reader has them) narrow the code files
// read again: Drizzle schemas import drizzle-orm, Supabase types export Database.
export function dataModel(root, files, { packages = new Set(), modules = null } = {}) {
  const read = path => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } };
  const pick = (test, filter = () => true) => files.filter(test).map(file => ({ path: file.path, text: read(file.path) })).filter(item => item.text != null && filter(item.text));
  let sql = null;
  const sqlSources = () => (sql ??= pick(file => file.language === 'sql'));
  const code = candidate => file => CODE.has(file.language) && (!modules || candidate(modules.get(file.path)));
  const importsDrizzle = module => module?.imports.some(item => /^drizzle-orm(?:\/|$)/.test(item.specifier ?? ''));
  const exportsDatabase = module => module?.exports.some(item => item.name === 'Database');
  const sources = {
    prisma: () => prismaTables(pick(file => file.language === 'prisma')),
    drizzle: () => drizzleTables(pick(code(importsDrizzle), text => /drizzle-orm/.test(text) && /\b(?:pg|mysql|sqlite)Table\s*\(/.test(text))),
    sql: () => sqlTables(sqlSources()).map(table => ({ ...table, store: sqlStore(table.proof.file, packages) })),
    'supabase-types': () => supabaseTypeTables(pick(code(exportsDatabase), text => /\bDatabase\b/.test(text) && /\bTables\s*:/.test(text) && /\bRow\s*:/.test(text))),
  };
  const tables = new Map();
  for (const source of SOURCES) {
    for (const table of sources[source]()) if (!tables.has(table.name)) tables.set(table.name, { ...table, source });
  }
  // Row level security, when the project's SQL files say it (Supabase migrations, mostly).
  const security = sqlSecurity(sqlSources());
  for (const table of tables.values()) {
    const rls = security.get(table.name);
    if (rls?.proof.length) table.rls = rls;
  }
  return { tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

const MAX_PROOFS = 12;
const READS = new Set(['select']);
const lowerFirst = name => name.charAt(0).toLowerCase() + name.slice(1);

// Graph nodes for the tables, defined and inferred from use, and the reads and
// writes edges from the function (else the file) that uses each. Prisma models
// and Drizzle variables count only when the schema defines them; a Supabase
// .from('t') or a table in an SQL text is a table even when nothing defines it.
// symbolsOf: path → symbols; packages: the project's dependencies.
export function tableGraph(model, modules, { symbolsOf = new Map(), packages = new Set() } = {}) {
  const tables = new Map(model.tables.map(table => [table.name, { id: `table:${table.name}`, kind: 'table', name: table.name, store: table.store ?? table.source,
    inferred: false, source: table.source, columns: table.columns.map(column => ({ ...column, proof: [column.proof] })), ...(table.rls ? { rls: table.rls } : {}),
    origin: 'static', proof: [table.proof] }]));
  const byModel = new Map(model.tables.filter(table => table.model).map(table => [lowerFirst(table.model), table.name]));
  const byVariable = new Map(model.tables.filter(table => table.variable).map(table => [table.variable, table.name]));
  const edges = new Map();
  const paths = [...modules.keys()].sort();
  for (const path of paths) {
    for (const use of modules.get(path).data ?? []) {
      const name = use.via === 'prisma' ? byModel.get(use.model) : use.via === 'drizzle' ? byVariable.get(use.variable) : use.table;
      if (!name) continue;
      if (!tables.has(name)) {
        tables.set(name, { id: `table:${name}`, kind: 'table', name, store: use.via === 'supabase' ? 'supabase' : sqlStore(path, packages), inferred: true, origin: 'static', proof: [] });
      }
      const table = tables.get(name);
      const symbol = enclosing(symbolsOf.get(path) ?? [], use.line);
      const from = symbol ? `symbol:${path}#${symbol.name}@${symbol.line}` : `file:${path}`;
      const kind = READS.has(use.operation) ? 'reads' : 'writes';
      const id = `${kind}:${from}->${table.id}`;
      if (!edges.has(id)) edges.set(id, { id, kind, from, to: table.id, origin: 'static', operations: [], proof: [] });
      const edge = edges.get(id);
      if (!edge.operations.includes(use.operation)) edge.operations.push(use.operation);
      for (const list of [edge.proof, table.proof]) {
        if (list.length < MAX_PROOFS && !list.some(item => item.file === path && item.line === use.line)) list.push({ file: path, line: use.line });
      }
    }
  }
  for (const edge of edges.values()) edge.operations.sort();
  return { nodes: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)), edges: [...edges.values()] };
}
