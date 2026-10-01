// Imports and exports of the project's files (phase 1, step 4), read with a
// real parser (@babel/parser: JavaScript, TypeScript, JSX), never with
// regular expressions. Each import is resolved to a file of the project, a
// package, a Node built-in, or left unresolved (with its line), never guessed.
// HTML pages count their <script src> as imports.
import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { dataDirectory } from '../../home.mjs';
import { SKIPPED_FOLDERS } from './inventory.mjs';

const CODE = new Set(['js', 'jsx', 'ts', 'tsx']);
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const BUILTINS = new Set(builtinModules);

export function parserPlugins(path, language) {
  const typescript = language === 'ts' || language === 'tsx';
  // .ts files cannot have JSX (it clashes with <T>(x) => x generics).
  const jsx = language !== 'ts';
  return [...(typescript ? ['typescript'] : []), ...(jsx ? ['jsx'] : []), 'decorators-legacy', 'importAttributes', 'explicitResourceManagement'];
}

// Every node of the tree, depth first, in source order.
function* walk(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) yield* walk(item); }
    else if (value && typeof value.type === 'string') yield* walk(value);
  }
}

const literal = node => (node?.type === 'StringLiteral' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null);
const nameOf = node => node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : null;

// Parameter names of a function, for its signature (never default values).
function paramsOf(fn) {
  return (fn?.params ?? []).map(param => {
    const inner = param.type === 'TSParameterProperty' ? param.parameter : param;
    if (inner.type === 'Identifier') return inner.name;
    if (inner.type === 'AssignmentPattern' && inner.left.type === 'Identifier') return inner.left.name;
    if (inner.type === 'RestElement' && inner.argument.type === 'Identifier') return `...${inner.argument.name}`;
    return inner.type === 'ArrayPattern' ? '[…]' : '{…}';
  });
}

function declarationExports(declaration, line) {
  if (!declaration) return [];
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction') return [{ name: declaration.id?.name, kind: 'function', line, params: paramsOf(declaration) }];
  if (declaration.type === 'ClassDeclaration') return [{ name: declaration.id?.name, kind: 'class', line }];
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap(item => item.id.type === 'Identifier'
      ? [{ name: item.id.name, ...(/Function|Arrow/.test(item.init?.type ?? '') ? { kind: 'function', params: paramsOf(item.init) } : { kind: 'variable' }),
        line: item.loc.start.line }] : []);
  }
  if (/^TS(Interface|TypeAlias|Enum|Module)Declaration$/.test(declaration.type)) return [{ name: declaration.id?.name, kind: 'type', line }];
  return [];
}

// The project's symbols in a file (phase 2): top-level functions, classes and
// components, and the variables it exports (ESM or CommonJS). A function
// whose name starts with a capital letter in a .jsx/.tsx file is a component.
// Nested functions are not symbols (M113); route handlers are added with the
// routes.
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
function topLevelSymbols(program, language) {
  const symbols = [];
  const exported = new Set();
  // Other names a symbol is exported under (export default App; export { a as b }).
  const aliases = new Map();
  const alias = (name, as) => { if (name && as && name !== as) { if (!aliases.has(name)) aliases.set(name, new Set()); aliases.get(name).add(as); } };
  const jsx = language === 'jsx' || language === 'tsx';
  const kindOf = (name, isFunction) => isFunction ? (jsx && /^[A-Z]/.test(name) ? 'component' : 'function') : 'variable';
  const push = (name, isFunction, node, line, isExported, extra = {}) => {
    if (!name) return;
    const fn = FUNCTION_TYPES.has(node.type) || node.type === 'ObjectMethod' ? node : FUNCTION_TYPES.has(node.init?.type) ? node.init
      : FUNCTION_TYPES.has(node.value?.type) ? node.value : null;
    symbols.push({ name, kind: extra.kind ?? kindOf(name, isFunction), line, endLine: node.loc.end.line, exported: isExported,
      ...(fn ? { calls: callsIn(fn) } : {}) });
  };
  const declare = (declaration, isExported, fallback) => {
    if (!declaration) return;
    const line = declaration.loc.start.line;
    if (declaration.type === 'FunctionDeclaration') { push(declaration.id?.name ?? fallback, true, declaration, line, isExported); alias(declaration.id?.name, fallback); }
    else if (declaration.type === 'ClassDeclaration') { push(declaration.id?.name ?? fallback, false, declaration, line, isExported, { kind: 'class' }); alias(declaration.id?.name, fallback); }
    else if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.id.type !== 'Identifier') continue;
        const isFunction = FUNCTION_TYPES.has(item.init?.type);
        push(item.id.name, isFunction, item, item.loc.start.line, isExported, { variable: !isFunction });
      }
    } else if (fallback && (FUNCTION_TYPES.has(declaration.type) || declaration.type === 'ClassExpression')) {
      push(fallback, declaration.type !== 'ClassExpression', declaration, line, true, declaration.type === 'ClassExpression' ? { kind: 'class' } : {});
    } else if (fallback && declaration.type === 'Identifier') { exported.add(declaration.name); alias(declaration.name, fallback); }
  };
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) declare(statement.declaration, true);
      else if (!statement.source) for (const item of statement.specifiers) { exported.add(nameOf(item.local)); alias(nameOf(item.local), nameOf(item.exported)); }
    } else if (statement.type === 'ExportDefaultDeclaration') declare(statement.declaration, true, 'default');
    else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      const { left, right } = statement.expression;
      const target = left.type === 'MemberExpression' ? left : null;
      const isModule = target?.object?.type === 'Identifier' && target.object.name === 'module' && nameOf(target.property) === 'exports';
      const isNamed = target && (target.object?.type === 'Identifier' && target.object.name === 'exports'
        || (target.object?.type === 'MemberExpression' && target.object.object?.name === 'module' && nameOf(target.object.property) === 'exports'));
      if (isModule && right.type === 'Identifier') exported.add(right.name);
      else if (isModule && right.type === 'ObjectExpression') {
        for (const property of right.properties) {
          if (property.type === 'ObjectProperty' && property.value.type === 'Identifier') exported.add(property.value.name);
          else if ((property.type === 'ObjectMethod' || FUNCTION_TYPES.has(property.value?.type)) && nameOf(property.key)) {
            push(nameOf(property.key), true, property, property.loc.start.line, true);
          }
        }
      } else if (isModule && (FUNCTION_TYPES.has(right.type) || right.type === 'ClassExpression')) {
        push(right.id?.name ?? 'default', right.type !== 'ClassExpression', right, statement.loc.start.line, true, right.type === 'ClassExpression' ? { kind: 'class' } : {});
      } else if (isNamed && right.type === 'Identifier') exported.add(right.name);
      else if (isNamed && FUNCTION_TYPES.has(right.type)) push(nameOf(target.property), true, right, statement.loc.start.line, true);
    } else declare(statement, false);
  }
  // Names exported further down (export { a }, module.exports = a).
  for (const symbol of symbols) {
    if (exported.has(symbol.name)) symbol.exported = true;
    if (symbol.exported && aliases.has(symbol.name)) symbol.exportedAs = [...aliases.get(symbol.name)].sort();
  }
  // Plain variables are symbols only when exported.
  return symbols.filter(symbol => symbol.kind !== 'variable' || symbol.exported);
}

// A request to the project's own server: fetch('/api/x'), axios.post(`/api/${id}`)…
// Returns { client, line, method, path } (template parts become :param), or
// { client, line, dynamic: true } when the URL is not a fixed text. Absolute
// URLs and URLs from environment variables are outgoing calls, not requests.
const METHOD_NAMES = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
// A generated API client (hey-api / openapi-ts, openapi-typescript-codegen):
// client.post({ url: '/api/v1/items/' }), client.request({ method: 'POST', url }),
// __request(OpenAPI, { method: 'POST', url }). The url is a fixed path; {id} is a parameter.
function generatedClientRequest(node) {
  const callee = node.callee;
  const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? nameOf(callee.property) : null;
  const options = name === '__request' ? node.arguments[1] : node.arguments[0];
  if (!name || options?.type !== 'ObjectExpression' || !(METHOD_NAMES.has(name) || name === 'request' || name === '__request')) return null;
  const property = key => options.properties.find(item => item.type === 'ObjectProperty' && nameOf(item.key) === key);
  const url = property('url') ? literal(property('url').value) : null;
  if (url == null || !url.startsWith('/') || url.startsWith('//')) return null;
  const method = METHOD_NAMES.has(name) ? name.toUpperCase() : literal(property('method')?.value)?.toUpperCase() ?? null;
  if (!method) return null;
  return { client: 'generated', line: node.loc.start.line, method, path: url.split(/[?#]/)[0].replace(/\{[^}]+\}/g, ':param') || '/' };
}

function sameSiteRequest(node) {
  const generated = generatedClientRequest(node);
  if (generated) return generated;
  const callee = node.callee;
  let client = null;
  let method = null;
  if (callee.type === 'Identifier' && ['fetch', '$fetch', 'ofetch'].includes(callee.name)) client = callee.name;
  else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && ['axios', 'ky', 'ofetch', '$fetch'].includes(callee.object.name)
    && METHOD_NAMES.has(nameOf(callee.property))) { client = callee.object.name; method = nameOf(callee.property).toUpperCase(); }
  if (!client || !node.arguments.length) return null;
  const [first, options] = node.arguments;
  const line = node.loc.start.line;
  let path = literal(first);
  if (path == null && first.type === 'TemplateLiteral') path = first.quasis.map((quasi, index) => quasi.value.cooked + (index < first.expressions.length ? ':param' : '')).join('');
  if (path == null) {
    if (envName(first) || (first.type === 'TemplateLiteral' && envName(first.expressions[0]))) return null;
    return { client, line, dynamic: true };
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (!method) {
    const property = options?.type === 'ObjectExpression'
      ? options.properties.find(item => item.type === 'ObjectProperty' && nameOf(item.key) === 'method') : null;
    const value = property ? literal(property.value) : null;
    method = property ? (value ? value.toUpperCase() : null) : 'GET';
  }
  return { client, line, method, path: path.split(/[?#]/)[0] || '/' };
}

// Calls made inside a function (phase 2): `name(…)` and `object.name(…)`, with
// their lines, in source order. Resolved to project symbols by the reader.
function callsIn(fn) {
  const calls = [];
  const seen = new Set();
  for (const node of walk(fn.body ?? fn)) {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') continue;
    const callee = node.callee;
    const call = callee.type === 'Identifier' ? { name: callee.name }
      : (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.object.type === 'Identifier' && !callee.computed
        ? { object: callee.object.name, name: nameOf(callee.property) } : null;
    if (!call?.name) continue;
    const line = node.loc.start.line;
    const key = `${call.object ?? ''}.${call.name}@${line}`;
    if (!seen.has(key)) { seen.add(key); calls.push({ ...call, line }); }
  }
  return calls;
}

// Names this file takes from other modules: import x / { a as b } / * as n,
// const x = require('…'), const { a, b: c } = require('…'). Resolved to
// files by projectModules.
function importBindings(program) {
  const bindings = [];
  const requireOf = init => {
    const call = init?.type === 'AwaitExpression' ? init.argument : init;
    if (call?.type === 'CallExpression' && call.callee.type === 'Identifier' && call.callee.name === 'require') return literal(call.arguments[0]);
    return null;
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
      for (const item of statement.specifiers) {
        const imported = item.type === 'ImportDefaultSpecifier' ? 'default' : item.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(item.imported);
        bindings.push({ local: item.local.name, imported, specifier: statement.source.value, line: statement.loc.start.line });
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const item of statement.declarations) {
        const specifier = requireOf(item.init);
        if (specifier == null) continue;
        if (item.id.type === 'Identifier') bindings.push({ local: item.id.name, imported: 'default', specifier, line: item.loc.start.line });
        else if (item.id.type === 'ObjectPattern') {
          for (const property of item.id.properties) {
            if (property.type === 'ObjectProperty' && property.value.type === 'Identifier') {
              bindings.push({ local: property.value.name, imported: nameOf(property.key), specifier, line: item.loc.start.line });
            }
          }
        }
      }
    }
  }
  return bindings;
}

// Routes registered in code (Express, Fastify, Koa-router, Hono…):
// object.get('/path', …, handler), and the mounts object.use('/prefix', router)
// and object.register(plugin, { prefix }). Each is tied to the top-level
// function it is in when the object is one of that function's parameters (a
// Fastify plugin), else to the object's own name.
// require('./x') or import('./x') written in place (app.use('/a', require('./a'))).
function inlineRequire(node) {
  const call = node?.type === 'AwaitExpression' ? node.argument : node;
  if (call?.type === 'CallExpression' && call.callee.type === 'Identifier' && call.callee.name === 'require') return literal(call.arguments[0]);
  if (call?.type === 'ImportExpression') return literal(call.source);
  return null;
}
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
function routeRegistrations(program) {
  const routes = [];
  const mounts = [];
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
    let owner = null;
    if (declaration?.type === 'FunctionDeclaration') owner = { name: declaration.id?.name ?? 'default', params: paramsOf(declaration) };
    else if (declaration?.type === 'VariableDeclaration' && declaration.declarations.length === 1 && FUNCTION_TYPES.has(declaration.declarations[0].init?.type)) {
      owner = { name: declaration.declarations[0].id.name, params: paramsOf(declaration.declarations[0].init) };
    } else if (statement.type === 'ExportDefaultDeclaration' && FUNCTION_TYPES.has(declaration?.type)) owner = { name: 'default', params: paramsOf(declaration) };
    const scopeOf = object => (owner?.params.includes(object) ? { plugin: owner.name } : { object });
    for (const node of walk(statement)) {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.object.type !== 'Identifier' || node.callee.computed) continue;
      register(scopeOf(node.callee.object.name), nameOf(node.callee.property), node.arguments, node.loc.start.line);
    }
    // A chain on a new router, bound to a name or exported:
    // const api = Router().use(a).use(b); export default Router().use('/api', api).
    const chained = [];
    if (statement.type === 'ExportDefaultDeclaration') chained.push(['default', statement.declaration]);
    if (declaration?.type === 'VariableDeclaration') for (const item of declaration.declarations) if (item.id.type === 'Identifier') chained.push([item.id.name, item.init]);
    const assigned = statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' ? statement.expression : null;
    if (assigned && assigned.left.type === 'MemberExpression' && assigned.left.object.type === 'Identifier' && assigned.left.object.name === 'module'
      && nameOf(assigned.left.property) === 'exports') chained.push(['default', assigned.right]);
    for (const [object, expression] of chained) {
      const calls = [];
      let current = expression;
      while (current?.type === 'CallExpression' && current.callee.type === 'MemberExpression' && !current.callee.computed && current.callee.object.type === 'CallExpression') {
        calls.unshift(current);
        current = current.callee.object;
      }
      const root = current?.type === 'CallExpression' ? current.callee : null;
      const isRouter = root && ((root.type === 'Identifier' && /^(Router|express)$/.test(root.name))
        || (root.type === 'MemberExpression' && nameOf(root.property) === 'Router'));
      if (!isRouter) continue;
      for (const call of calls) register({ object }, nameOf(call.callee.property), call.arguments, call.callee.property.loc.start.line);
    }
  }
  function register(scope, method, args, line) {
    const path = literal(args[0]);
    if (ROUTE_METHODS.has(method) && args.length >= 2 && path != null && (path.startsWith('/') || path === '*')) {
      const last = args[args.length - 1];
      const handler = FUNCTION_TYPES.has(last.type)
        ? { inline: true, name: last.id?.name ?? '<anonymous>', line: last.loc.start.line, endLine: last.loc.end.line, calls: callsIn(last) }
        : last.type === 'Identifier' ? { ref: last.name } : null;
      routes.push({ ...scope, method, path, line, handler });
    } else if (method === 'use' && args.length) {
      const prefix = literal(args[0]);
      // A prefix that is not a fixed text (a variable's member, a template,
      // a sum) is never guessed: the mount is left out.
      if (prefix == null && args.length > 1 && /Member|Template|Binary|Conditional|Logical/.test(args[0].type)) return;
      const rest = prefix != null ? args.slice(1) : args;
      if (prefix != null && !prefix.startsWith('/')) return;
      for (const item of rest) {
        if (item.type === 'Identifier') mounts.push({ ...scope, prefix: prefix ?? '', ref: item.name, line });
        else if (inlineRequire(item) != null) mounts.push({ ...scope, prefix: prefix ?? '', specifier: inlineRequire(item), line });
      }
    } else if (method === 'register' && (args[0]?.type === 'Identifier' || inlineRequire(args[0]) != null)) {
      const options = args[1]?.type === 'ObjectExpression' ? args[1] : null;
      const prefixProperty = options?.properties.find(property => property.type === 'ObjectProperty' && nameOf(property.key) === 'prefix');
      const prefix = prefixProperty ? literal(prefixProperty.value) : '';
      if (prefix == null) return;
      mounts.push({ ...scope, prefix, ...(args[0].type === 'Identifier' ? { ref: args[0].name } : { specifier: inlineRequire(args[0]) }), line });
    }
  }
  return { routes, mounts };
}

// An HTTP call to somewhere else: fetch/axios/got/ky with an absolute URL
// (its host) or a URL from an environment variable (its name). Calls to a
// path of the same site ("/api/users") are not outgoing; a URL built at run
// time is kept as dynamic, never guessed.
const HTTP_CLIENTS = new Set(['fetch', 'axios', 'got', 'ky', 'ofetch', '$fetch', 'request', 'superagent']);
function envName(node) {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return null;
  const object = node.object;
  const fromProcess = object?.type === 'MemberExpression' && object.object?.name === 'process' && nameOf(object.property) === 'env';
  const fromMeta = object?.type === 'MemberExpression' && object.object?.type === 'MetaProperty' && nameOf(object.property) === 'env';
  // process.env[name] (a variable) names nothing: only process.env.X and process.env['X'].
  if (node.computed && node.property?.type !== 'StringLiteral') return null;
  return fromProcess || fromMeta ? nameOf(node.property) : null;
}
const isEnvObject = node => (node?.type === 'MemberExpression' && nameOf(node.property) === 'env' && !node.computed
  && (node.object?.name === 'process' || node.object?.type === 'MetaProperty'));

// Environment variables read by a file (phase 5): process.env.X,
// process.env['X'], import.meta.env.X and const { X, Y: y } = process.env.
function envReads(program) {
  const reads = [];
  for (const node of walk(program)) {
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const name = envName(node);
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) reads.push({ name, line: node.loc.start.line });
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isEnvObject(node.init)) {
      for (const property of node.id.properties) {
        const name = property.type === 'ObjectProperty' ? nameOf(property.key) : null;
        if (name) reads.push({ name, line: property.loc.start.line });
      }
    }
  }
  return reads;
}
// What a value is, as far as the code says (phase 4): an environment variable
// ({ env }), an absolute URL ({ host }), or nothing known. Looks through
// `a ?? b` / `a || b` (the variable first, then the fallback), TypeScript
// casts, templates that start with a variable or a URL, and top-level
// constants of the same file (one step).
function valueInfo(node, constants = new Map(), depth = 0) {
  if (!node || depth > 3) return null;
  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') {
    return valueInfo(node.expression, constants, depth + 1);
  }
  if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
    return valueInfo(node.left, constants, depth + 1) ?? valueInfo(node.right, constants, depth + 1);
  }
  // BASE + '/path': the base says where it goes.
  if (node.type === 'BinaryExpression' && node.operator === '+') return valueInfo(node.left, constants, depth + 1);
  const variable = envName(node);
  if (variable) return { env: variable };
  if (node.type === 'Identifier' && constants.has(node.name)) return valueInfo(constants.get(node.name), new Map(), depth + 1);
  const text = literal(node) ?? (node.type === 'TemplateLiteral' ? node.quasis[0].value.cooked : null);
  if (text != null) {
    const match = text.match(/^(?:https?|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/(?:[^@/?#]*@)?([^/:?#`$]+)/i);
    if (match) return { host: match[1].toLowerCase() };
    if (node.type === 'TemplateLiteral' && text === '' && node.expressions.length) return valueInfo(node.expressions[0], constants, depth + 1);
    return null;
  }
  return null;
}
// Top-level `const name = …` of a file, for valueInfo.
function topConstants(program) {
  const constants = new Map();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const item of declaration.declarations) if (item.id.type === 'Identifier' && item.init) constants.set(item.id.name, item.init);
  }
  return constants;
}
function outgoingCall(node, constants) {
  const callee = node.callee;
  const name = callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && HTTP_CLIENTS.has(callee.object.name) ? callee.object.name : null;
  if (!name || !HTTP_CLIENTS.has(name) || !node.arguments.length) return null;
  const first = node.arguments[0];
  const line = node.loc.start.line;
  const text = literal(first) ?? (first.type === 'TemplateLiteral' ? first.quasis[0].value.cooked : null);
  if (text != null && !(first.type === 'TemplateLiteral' && text === '')) {
    const match = text.match(/^https?:\/\/([^/:?#`$]+)/i);
    if (match) return { client: name, line, host: match[1].toLowerCase() };
    return null;
  }
  const info = valueInfo(first, constants);
  if (info?.env) return { client: name, line, env: info.env };
  if (info?.host) return { client: name, line, host: info.host };
  return { client: name, line, dynamic: true };
}

// A client of a package created or called (phase 4): new Pool(…),
// createClient(…), Sentry.init(…), sgMail.send(…). Only names imported from
// packages (not project files); what the arguments say about the address is
// kept (valueInfo), for the catalogue of services to decide.
const ADDRESS_OPTIONS = ['connectionString', 'url', 'host', 'baseURL', 'baseUrl', 'endpoint', 'uri', 'dsn'];
const isPackage = specifier => typeof specifier === 'string' && !/^(\.|\/|@\/|~\/|#|node:)/.test(specifier);
function packageCall(node, byLocal, constants) {
  const callee = node.callee;
  let binding = null;
  let name = null;
  if (callee.type === 'Identifier' && byLocal.has(callee.name)) { binding = byLocal.get(callee.name); name = binding.imported; }
  else if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.object.type === 'Identifier' && !callee.computed
    && byLocal.has(callee.object.name) && ['*', 'default'].includes(byLocal.get(callee.object.name).imported)) {
    binding = byLocal.get(callee.object.name);
    name = nameOf(callee.property);
  }
  if (!binding || !name) return null;
  const args = node.arguments;
  const options = {};
  for (const argument of args.slice(0, 2)) {
    if (argument?.type !== 'ObjectExpression') continue;
    for (const property of argument.properties) {
      const key = property.type === 'ObjectProperty' ? nameOf(property.key) : null;
      if (ADDRESS_OPTIONS.includes(key)) { const info = valueInfo(property.value, constants); if (info) options[key] = info; }
    }
  }
  const first = args[0] && args[0].type !== 'ObjectExpression' ? valueInfo(args[0], constants) : null;
  return { package: binding.specifier, name, line: node.loc.start.line, ...(first ? { first } : {}), ...(Object.keys(options).length ? { options } : {}) };
}

// Keys written in the code (phase 5, step 4), by known shapes. Only the kind
// and the line are kept (also in the parse cache); the value never is. A JWT
// counts only when its payload says role service_role (an anon key is public).
const KEY_SHAPES = [
  ['stripe-live', /\b(?:sk|rk)_live_[0-9A-Za-z]{10,}/], ['stripe-test', /\b(?:sk|rk)_test_[0-9A-Za-z]{10,}/],
  ['stripe-webhook', /\bwhsec_[0-9A-Za-z]{20,}/], ['anthropic', /\bsk-ant-[0-9A-Za-z_-]{20,}/],
  ['openai', /\bsk-(?!ant-)(?:proj-|svcacct-)?[0-9A-Za-z_-]{20,}/], ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github', /\b(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,})/], ['slack', /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/], ['sendgrid', /\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
];
const JWT = /\beyJ[0-9A-Za-z_-]{8,}\.(eyJ[0-9A-Za-z_-]{8,})\.[0-9A-Za-z_-]{8,}/g;
export function literalKeys(source) {
  const found = [];
  source.split('\n').forEach((text, index) => {
    for (const [kind, shape] of KEY_SHAPES) if (shape.test(text)) found.push({ kind, line: index + 1 });
    for (const match of text.matchAll(JWT)) {
      let role = null;
      try { role = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))?.role ?? null; } catch {}
      if (role === 'service_role') found.push({ kind: 'supabase-service-role', line: index + 1 });
    }
  });
  return found;
}
// The same shapes, masked in a text shown to the user (code excerpts): the
// public prefix stays, the rest becomes dots. Any JWT is masked (its role is
// not worth the risk), and so are the base64 lines of a private key block.
const PREFIX = /^(?:[sr]k_(?:live|test)_|whsec_|sk-ant-|sk-(?:proj-|svcacct-)?|AKIA|ASIA|gh[pousr]_|github_pat_|xox[baprs]-|AIza|SG\.|eyJ)/;
export function maskKeys(text) {
  let masked = text;
  for (const [, shape] of KEY_SHAPES) masked = masked.replace(new RegExp(shape.source, 'g'), match => (match.startsWith('-----') ? match : `${match.match(PREFIX)?.[0] ?? ''}••••••`));
  masked = masked.replace(/\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g, 'eyJ••••••');
  if (/^\s*[A-Za-z0-9+/=]{40,}\s*$/.test(masked)) masked = masked.replace(/[A-Za-z0-9+/=]{40,}/, '••••••');
  return masked;
}
const GENERATED_HEADER = /\b(auto-?generated|automatically generated|@generated|code generated|generated by|do not edit)\b/i;
const KEY_LANGUAGES = new Set(['js', 'jsx', 'ts', 'tsx', 'json', 'html', 'yaml', 'vue', 'svelte', 'python', 'shell']);

// What one file imports and exports. Parse failures are reported, not thrown.
export function readModule(source, path, language, { startLine = 1 } = {}) {
  const result = { imports: [], exports: [], directives: [], outgoing: [], sdk: [], env: [], keys: [], symbols: [], bindings: [], routes: [], mounts: [], requests: [], data: [], runtimeImports: [], error: null };
  if (startLine === 1 && KEY_LANGUAGES.has(language)) result.keys = literalKeys(source);
  // Code written by a tool (hey-api, TanStack Router, Prisma…): its header says so.
  if (startLine === 1 && GENERATED_HEADER.test(source.slice(0, 1500).split('\n').filter(line => /^\s*(\/\/|\/\*|\*|#)/.test(line)).join('\n'))) result.generated = true;
  if (language === 'html') {
    const pattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    for (const match of source.matchAll(pattern)) {
      result.imports.push({ specifier: match[1], line: source.slice(0, match.index).split('\n').length, kind: 'script' });
    }
    // Inline scripts: their imports and requests, with the page's lines.
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(match[1]) || /\btype\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(match[1]) || !match[2].trim()) continue;
      const startLine = source.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length;
      const inline = readModule(match[2], path, 'js', { startLine });
      if (inline.error) continue;
      result.imports.push(...inline.imports);
      result.outgoing.push(...inline.outgoing);
      result.sdk.push(...inline.sdk);
      result.env.push(...inline.env);
      result.requests.push(...inline.requests);
      result.data.push(...inline.data);
    }
    return result;
  }
  if (!CODE.has(language)) return result;
  let ast;
  try {
    ast = parse(source, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true, startLine, plugins: parserPlugins(path, language) });
  } catch (error) {
    result.error = `${error.message}`.slice(0, 200);
    return result;
  }
  if (ast.errors?.length) result.error = `${ast.errors[0].message}`.slice(0, 200);
  result.directives = ast.program.directives.map(directive => directive.value.value);
  const add = (specifier, line, kind, extra = {}) => result.imports.push({ specifier, line, kind, ...extra });
  for (const statement of ast.program.body) {
    const line = statement.loc.start.line;
    if (statement.type === 'ImportDeclaration') {
      add(statement.source.value, line, statement.importKind === 'type' ? 'type' : 'static',
        { names: statement.specifiers.map(item => item.type === 'ImportDefaultSpecifier' ? 'default' : item.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(item.imported)) });
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        add(statement.source.value, line, statement.exportKind === 'type' ? 'type' : 'reexport', { names: statement.specifiers.map(item => nameOf(item.local)) });
        for (const item of statement.specifiers) result.exports.push({ name: nameOf(item.exported), kind: statement.exportKind === 'type' ? 'type' : 'reexport', line });
      } else if (statement.declaration) result.exports.push(...declarationExports(statement.declaration, line));
      else for (const item of statement.specifiers) result.exports.push({ name: nameOf(item.exported), kind: 'binding', line });
    } else if (statement.type === 'ExportAllDeclaration') {
      add(statement.source.value, line, 'reexport', { names: ['*'] });
      result.exports.push({ name: statement.exported ? nameOf(statement.exported) : '*', kind: 'reexport', line });
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration;
      const kind = /Function|Arrow/.test(declaration.type) ? 'function' : declaration.type === 'ClassDeclaration' ? 'class' : 'variable';
      result.exports.push({ name: 'default', kind, line, local: declaration.id?.name ?? (declaration.type === 'Identifier' ? declaration.name : undefined),
        ...(kind === 'function' ? { params: paramsOf(declaration) } : {}) });
    } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      // CommonJS: module.exports = …, module.exports.x = …, exports.x = …
      const { left, right } = statement.expression;
      const target = left.type === 'MemberExpression' ? left : null;
      const isModule = target?.object?.type === 'Identifier' && target.object.name === 'module' && nameOf(target.property) === 'exports';
      const isNamed = target && (target.object?.type === 'Identifier' && target.object.name === 'exports'
        || (target.object?.type === 'MemberExpression' && target.object.object?.name === 'module' && nameOf(target.object.property) === 'exports'));
      if (isModule && right.type === 'ObjectExpression') {
        for (const property of right.properties) if (property.type === 'ObjectProperty') result.exports.push({ name: nameOf(property.key), kind: 'binding', line: property.loc.start.line, commonjs: true });
      } else if (isModule) result.exports.push({ name: 'default', kind: /Function|Arrow|Class/.test(right.type) ? 'function' : 'variable', line, commonjs: true,
        local: right.type === 'Identifier' ? right.name : undefined });
      else if (isNamed) result.exports.push({ name: nameOf(target.property), kind: /Function|Arrow/.test(right.type) ? 'function' : 'variable', line, commonjs: true });
    }
  }
  result.symbols = topLevelSymbols(ast.program, language);
  result.bindings = importBindings(ast.program);
  Object.assign(result, routeRegistrations(ast.program));
  const constants = topConstants(ast.program);
  result.env = envReads(ast.program);
  const byLocal = new Map(result.bindings.filter(item => isPackage(item.specifier)).map(item => [item.local, item]));
  // require(), import(), outgoing HTTP calls and package clients anywhere.
  for (const node of walk(ast.program)) {
    const call = node.type === 'CallExpression' ? outgoingCall(node, constants) : null;
    if (call) result.outgoing.push(call);
    const client = (node.type === 'CallExpression' || node.type === 'NewExpression') && !call ? packageCall(node, byLocal, constants) : null;
    if (client) result.sdk.push(client);
    const request = node.type === 'CallExpression' ? sameSiteRequest(node) : null;
    if (request) result.requests.push(request);
    result.data.push(...dataAccess(node, constants));
    if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee.type === 'Import')) {
      const target = node.type === 'ImportExpression' ? node.source : node.arguments[0];
      add(literal(target), node.loc.start.line, 'dynamic');
      if (literal(target) == null) result.runtimeImports.push(runtimeImport(target, node.loc.start.line));
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
      add(literal(node.arguments[0]), node.loc.start.line, 'require');
      if (literal(node.arguments[0]) == null) result.runtimeImports.push(runtimeImport(node.arguments[0], node.loc.start.line));
    }
  }
  result.imports.sort((a, b) => a.line - b.line);
  return result;
}

// A module chosen at run time (phase 8): import(`./lib/${name}.js`) keeps
// its fixed start ('./lib/'), from which the folder it loads from is known;
// import(name) keeps nothing (it could load any file).
function runtimeImport(node, line) {
  const start = node?.type === 'TemplateLiteral' ? node.quasis[0].value.cooked ?? '' : node?.type === 'BinaryExpression' ? literal(node.left) ?? '' : '';
  return { prefix: /^\.{1,2}\//.test(start) ? start : null, line };
}

// Tables the code touches (phase 6, step 2), as the call says them:
//   { via: 'supabase', table, operation, line }  client.from('t').select()/insert()…
//   { via: 'sql', table, operation, line }       query('select … from t'), sql`…`
//   { via: 'prisma', model, operation, line }    prisma.user.findMany()
//   { via: 'drizzle', variable, operation, line } db.select().from(t), db.insert(t)
// Prisma and Drizzle names are resolved against the schema by the reader.
// Operations use the SQL words: select, insert, update, upsert, delete.
const SUPABASE_OPERATIONS = new Set(['select', 'insert', 'update', 'upsert', 'delete']);
const NOT_SUPABASE = new Set(['Array', 'Buffer', 'Object', 'Uint8Array', 'Rx', 'Observable']);
const PRISMA_OPERATIONS = { findMany: 'select', findFirst: 'select', findFirstOrThrow: 'select', findUnique: 'select', findUniqueOrThrow: 'select',
  count: 'select', aggregate: 'select', groupBy: 'select', create: 'insert', createMany: 'insert', createManyAndReturn: 'insert',
  update: 'update', updateMany: 'update', upsert: 'upsert', delete: 'delete', deleteMany: 'delete' };
const DRIZZLE_WRITES = new Set(['insert', 'update', 'delete']);
const SQL_METHODS = new Set(['query', 'execute', 'exec', 'run', 'all', 'get', 'prepare', 'unsafe', 'raw']);
const SQL_START = /^\s*(?:with|select|insert|update|delete|merge|replace)\b/i;
const SQL_NAME = String.raw`((?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*))?)`;

const propertyName = member => (member?.type === 'MemberExpression' || member?.type === 'OptionalMemberExpression') && !member.computed ? member.property.name : null;

// Table names an SQL text reads and writes. Unquoted names fold to lower case;
// the public schema is left out.
export function sqlAccess(text) {
  const name = raw => { const parts = raw.split('.').map(part => (/^["`]/.test(part) ? part.slice(1, -1) : part.toLowerCase())); if (parts.length > 1 && parts[0] === 'public') parts.shift(); return parts.join('.'); };
  const clean = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const found = [];
  const add = (table, operation) => { if (!found.some(item => item.table === table && item.operation === operation)) found.push({ table, operation }); };
  const ctes = new Set([...clean.matchAll(new RegExp(String.raw`(?:\bwith(?:\s+recursive)?|,)\s*${SQL_NAME}\s+as\s*\(`, 'gi'))].map(match => name(match[1])));
  const writes = [
    [String.raw`\binsert\s+(?:or\s+\w+\s+)?into\s+${SQL_NAME}`, 'insert'], [String.raw`\breplace\s+into\s+${SQL_NAME}`, 'upsert'],
    [String.raw`\bupdate\s+(?:only\s+)?${SQL_NAME}\s+set\b`, 'update'], [String.raw`\bdelete\s+from\s+(?:only\s+)?${SQL_NAME}`, 'delete'],
    [String.raw`\bmerge\s+into\s+${SQL_NAME}`, 'upsert'],
  ];
  const written = new Set();
  for (const [pattern, operation] of writes) for (const match of clean.matchAll(new RegExp(pattern, 'gi'))) { const table = name(match[1]); written.add(`${operation} ${table}`); if (!ctes.has(table)) add(table, operation); }
  if (/\bon\s+conflict\b[\s\S]*\bdo\s+update\b|\bon\s+duplicate\s+key\s+update\b/i.test(clean)) {
    for (const item of found) if (item.operation === 'insert') item.operation = 'upsert';
  }
  for (const match of clean.matchAll(new RegExp(String.raw`\b(from|join|using)\s+(?:only\s+|lateral\s+)?${SQL_NAME}`, 'gi'))) {
    const table = name(match[2]);
    const before = clean.slice(0, match.index);
    if (/\bdelete\s*$/i.test(before) || ctes.has(table) || /^(?:select|unnest|generate_series|json\w*|jsonb\w*|lateral)$/.test(table)) continue;
    if (match[1].toLowerCase() === 'from' && /\bdistinct\s+$|\bis\s+$/i.test(before)) continue;
    if (/^\s*\(/.test(clean.slice(match.index + match[0].length))) continue; // a function call
    if (/\b(?:extract|substring|trim|position|overlay)\s*\([^()]*$/i.test(before)) continue; // extract(year from x)
    add(table, 'select');
  }
  return found;
}

// The SQL text of a string, a template (its values become ?) or a tagged template.
function sqlText(node) {
  if (node?.type === 'StringLiteral') return node.value;
  const template = node?.type === 'TaggedTemplateExpression' ? node.quasi : node;
  if (template?.type === 'TemplateLiteral') return template.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('?');
  return null;
}

function dataAccess(node, constants) {
  const line = node.loc?.start.line;
  if (node.type === 'TaggedTemplateExpression') {
    const tag = node.tag.type === 'Identifier' ? node.tag.name : propertyName(node.tag);
    const text = /^(?:sql|SQL|query)$/.test(tag ?? '') ? sqlText(node) : null;
    return text && SQL_START.test(text) ? sqlAccess(text).map(item => ({ via: 'sql', ...item, line })) : [];
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return [];
  const method = propertyName(node.callee);
  const object = node.callee.object;
  // Supabase: <client>.from('t').<operation>(…)
  if (SUPABASE_OPERATIONS.has(method) && /Call/.test(object?.type ?? '') && propertyName(object.callee) === 'from') {
    const table = literal(object.arguments[0]);
    const receiver = object.callee.object;
    if (table && object.arguments.length === 1 && !(receiver?.type === 'Identifier' && NOT_SUPABASE.has(receiver.name))) {
      return [{ via: 'supabase', table, operation: method, line: object.loc.start.line }];
    }
  }
  // Drizzle: db.select().from(t), db.insert(t), db.update(t), db.delete(t); db.query.t.findMany()
  if (method === 'from' && node.arguments.length === 1 && node.arguments[0].type === 'Identifier') {
    let inner = object;
    while (/Call/.test(inner?.type ?? '') && propertyName(inner.callee) !== 'select' && propertyName(inner.callee) !== 'selectDistinct') inner = inner.callee.object?.type && /Call/.test(inner.callee.object.type) ? inner.callee.object : null;
    if (inner) return [{ via: 'drizzle', variable: node.arguments[0].name, operation: 'select', line }];
  }
  if (DRIZZLE_WRITES.has(method) && node.arguments.length === 1 && node.arguments[0].type === 'Identifier') {
    return [{ via: 'drizzle', variable: node.arguments[0].name, operation: method, line }];
  }
  // Prisma: <client>.<model>.<operation>(…); Drizzle's relational db.query.<t>.findMany() too.
  if (PRISMA_OPERATIONS[method] && (object?.type === 'MemberExpression' || object?.type === 'OptionalMemberExpression') && !object.computed) {
    const model = object.property.name;
    const owner = propertyName(object.object) === 'query' ? 'drizzle' : 'prisma';
    if (owner === 'drizzle' && /^find/.test(method)) return [{ via: 'drizzle', variable: model, operation: 'select', line }];
    if (owner === 'prisma' && model && !model.startsWith('$')) return [{ via: 'prisma', model, operation: PRISMA_OPERATIONS[method], line }];
  }
  // SQL passed to a database call: pool.query('…'), db.execute(sql`…`), client.unsafe('…').
  if (SQL_METHODS.has(method) || (node.callee.type === 'Identifier' && /^(?:query|sql)$/.test(node.callee.name))) {
    let first = node.arguments[0];
    if (first?.type === 'Identifier' && constants.has(first.name)) first = constants.get(first.name);
    if (first?.type === 'ObjectExpression') first = first.properties.find(item => item.type === 'ObjectProperty' && nameOf(item.key) === 'text')?.value;
    const text = sqlText(first);
    if (text && SQL_START.test(text) && first.type !== 'TaggedTemplateExpression') return sqlAccess(text).map(item => ({ via: 'sql', ...item, line }));
  }
  return [];
}

// JSON with comments and trailing commas, as tsconfig allows.
function readJsonc(path) {
  try {
    const text = readFileSync(path, 'utf8')
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch { return null; }
}

// compilerOptions.paths and baseUrl of the tsconfig.json (or jsconfig.json)
// of a folder, following relative "extends". As in TypeScript, paths are
// relative to baseUrl when there is one, else to the config that sets them.
export function pathAliases(root, folder = '') {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let file = join(root, folder, name);
    let paths = null;
    let pathsFolder = null;
    let baseUrl = null;
    let seen = false;
    for (let depth = 0; depth < 5; depth++) {
      const config = readJsonc(file);
      if (!config) break;
      seen = true;
      const options = config.compilerOptions ?? {};
      const here = posix.relative(root.split('\\').join('/'), dirname(file).split('\\').join('/')) || '.';
      if (!paths && options.paths) { paths = options.paths; pathsFolder = here; }
      if (baseUrl == null && typeof options.baseUrl === 'string') baseUrl = posix.normalize(posix.join(here, options.baseUrl));
      if (typeof config.extends !== 'string' || !config.extends.startsWith('.')) break;
      file = join(dirname(file), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`);
    }
    if (!seen) continue;
    const base = baseUrl ?? pathsFolder ?? '.';
    return { baseUrl, paths: Object.entries(paths ?? {}).map(([pattern, targets]) => ({ pattern, targets: targets.map(target => posix.normalize(posix.join(base, target))) })) };
  }
  return { baseUrl: null, paths: [] };
}

export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Resolves one import of `from` (a project path) against the set of project
// files. Returns { target } (a project file), { package }, { builtin } or
// { unresolved: true }.
export function resolveImport(specifier, from, files, { aliases = { baseUrl: null, paths: [] }, workspaces = new Map() } = {}) {
  if (specifier == null) return { unresolved: true, dynamic: true };
  const clean = specifier.split(/[?#]/)[0];
  // Build output (.next/types…) is generated, not part of the project.
  const generated = path => posix.normalize(path).split('/').some(part => SKIPPED_FOLDERS.has(part));
  const tryPath = path => {
    const normal = posix.normalize(path).replace(/^\.\//, '');
    if (normal.startsWith('../')) return null;
    const candidates = [normal, ...EXTENSIONS.map(extension => normal + extension), ...EXTENSIONS.map(extension => `${normal}/index${extension}`)];
    // TypeScript with NodeNext writes "./x.js" for x.ts.
    const js = normal.match(/^(.*)\.(m|c)?js$/);
    if (js) candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map(extension => js[1] + extension));
    return candidates.find(candidate => files.has(candidate)) ?? null;
  };
  if (clean.startsWith('.')) {
    const joined = posix.join(posix.dirname(from), clean);
    const target = tryPath(joined);
    return target ? { target } : generated(joined) ? { generated: true } : { unresolved: true };
  }
  if (clean.startsWith('/')) {
    // A page in public/ or static/ is served from that folder (express.static, Vite's public/).
    const staticRoot = from.match(/^(.*?(?:^|\/)(?:public|static))\//)?.[1];
    const target = tryPath(clean.slice(1)) ?? (staticRoot ? tryPath(`${staticRoot}${clean}`) : null);
    return target ? { target } : { unresolved: true };
  }
  if (clean.startsWith('node:') || BUILTINS.has(clean.split('/')[0])) return { builtin: clean.replace(/^node:/, '') };
  for (const { pattern, targets } of aliases.paths) {
    const star = pattern.indexOf('*');
    const matches = star === -1 ? clean === pattern : clean.startsWith(pattern.slice(0, star)) && clean.endsWith(pattern.slice(star + 1));
    if (!matches) continue;
    const middle = star === -1 ? '' : clean.slice(star, clean.length - (pattern.length - star - 1));
    for (const target of targets) {
      const found = tryPath(target.replace('*', middle));
      if (found) return { target: found };
    }
  }
  if (aliases.baseUrl) {
    const found = tryPath(posix.join(aliases.baseUrl, clean));
    if (found) return { target: found };
  }
  const name = packageName(clean);
  if (workspaces.has(name)) {
    const folder = workspaces.get(name);
    const found = tryPath(posix.join(folder, clean.slice(name.length))) ?? tryPath(posix.join(folder, 'src', 'index')) ?? tryPath(posix.join(folder, 'index'));
    if (found) return { target: found, workspace: name };
  }
  return { package: name };
}

const PARSE_CACHE_VERSION = 16;
function parseCachePath(root) {
  return join(dataDirectory(), 'structure', 'cache', `${createHash('sha256').update(root).digest('hex').slice(0, 32)}-modules.json`);
}

// Imports (resolved) and exports of every inventoried file. `files` is the
// inventory ({ path, language, hash }); `packages` the workspace members
// ({ folder }). Parse results are cached by content hash, outside the project.
export function projectModules(root, files, { packages = [], cache = true } = {}) {
  const paths = new Set(files.map(file => file.path));
  const folders = packages.map(item => item.folder).sort((a, b) => b.length - a.length);
  const aliases = new Map([['.', pathAliases(root)], ...folders.map(folder => [folder, pathAliases(root, folder)])]);
  const workspaces = new Map();
  for (const folder of folders) {
    try { const name = JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')).name; if (name) workspaces.set(name, folder); } catch {}
  }
  let previous = {};
  if (cache) { try { const saved = JSON.parse(readFileSync(parseCachePath(root), 'utf8')); if (saved.version === PARSE_CACHE_VERSION) previous = saved.files; } catch {} }
  const next = {};
  const modules = new Map();
  let parsedNow = 0;
  for (const file of files) {
    let parsed = previous[file.hash];
    if (!parsed) { parsed = readModule(readFileSync(join(root, file.path), 'utf8'), file.path, file.language); parsedNow++; }
    next[file.hash] = parsed;
    const member = folders.find(folder => file.path.startsWith(`${folder}/`)) ?? '.';
    const options = { aliases: aliases.get(member), workspaces };
    modules.set(file.path, { ...parsed, member, imports: parsed.imports.map(item => ({ ...item, ...resolveImport(item.specifier, file.path, paths, options) })),
      bindings: (parsed.bindings ?? []).map(item => ({ ...item, ...resolveImport(item.specifier, file.path, paths, options) })),
      mounts: (parsed.mounts ?? []).map(item => (item.specifier != null ? { ...item, ...resolveImport(item.specifier, file.path, paths, options) } : item)) });
  }
  // Rewritten only when something was parsed or a file went away.
  if (cache && (parsedNow || Object.keys(previous).length !== Object.keys(next).length)) {
    const path = parseCachePath(root);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify({ version: PARSE_CACHE_VERSION, files: next }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {}
  }
  return modules;
}

// Packages imported by the code of each workspace member ('.' is the root).
export function importedPackages(modules) {
  const byMember = new Map();
  for (const module of modules.values()) {
    if (!byMember.has(module.member)) byMember.set(module.member, new Set());
    for (const item of module.imports) if (item.package && item.kind !== 'type') byMember.get(module.member).add(item.package);
  }
  return byMember;
}
