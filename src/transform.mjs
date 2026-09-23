import { parse } from 'acorn';
import { fullAncestor } from 'acorn-walk';
import MagicString from 'magic-string';
import { AnyMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { relative, isAbsolute, sep } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { libraryPointFor, libraryPoints } from './boundaries.mjs';

export const runtimeKey = 'codetac.phase0.runtime';

// Only real comments count: the same text inside a string literal (for
// example code passed to eval) is not this module's source map.
function inputMap(comments, filename) {
  const matches = comments.filter(comment => comment.type === 'Line')
    .map(comment => comment.value.match(/^[#@]\s*sourceMappingURL=(\S+)/)).filter(Boolean);
  if (!matches.length) return null;
  const reference = matches.at(-1)[1];
  const base = pathToFileURL(filename).href;
  if (reference.startsWith('data:')) {
    const comma = reference.indexOf(',');
    const raw = reference.slice(0, comma).includes(';base64')
      ? Buffer.from(reference.slice(comma + 1), 'base64').toString('utf8')
      : decodeURIComponent(reference.slice(comma + 1));
    return new AnyMap(JSON.parse(raw), base);
  }
  const url = new URL(reference, base);
  if (url.protocol !== 'file:') throw new Error('non-local source map');
  return new AnyMap(JSON.parse(readFileSync(url, 'utf8')), url.href);
}

const localFiles = new Map();
function isLocalFile(file) {
  if (!localFiles.has(file)) {
    let result = false;
    try { result = statSync(file).isFile(); } catch {}
    localFiles.set(file, result);
  }
  return localFiles.get(file);
}

// Code passed to eval as a string literal with its own inline source map (for
// example bundlers' "eval" development modes) never reaches the module hooks.
// It is instrumented like a module, with the same origin filter.
function evalLiteral(node) {
  const argument = node.arguments[0];
  return node.callee.type === 'Identifier' && node.callee.name === 'eval' && node.arguments.length === 1
    && argument.type === 'Literal' && typeof argument.value === 'string'
    && /\/\/[#@]\s*sourceMappingURL=data:/.test(argument.value) ? argument : null;
}

function contains(outer, inner) { return inner.start >= outer.start && inner.end <= outer.end; }

export function transform(source, filename, format = 'module', projectRoot = null, register = null) {
  // The declared format can disagree with the syntax when another loader
  // (tsx, ts-node...) converts ESM to CommonJS after this hook. The wrappers
  // inserted below are valid in both, so parse with whichever one fits.
  const options = sourceType => ({ ecmaVersion: 'latest', sourceType, allowHashBang: true,
    allowReturnOutsideFunction: sourceType === 'script' && format === 'commonjs' });
  let sourceType = format === 'module' ? 'module' : 'script';
  let tokens = [];
  let comments = [];
  let ast;
  try {
    ast = parse(source, { ...options(sourceType), onToken: tokens, onComment: comments, locations: true });
  } catch (error) {
    sourceType = sourceType === 'module' ? 'script' : 'module';
    tokens = [];
    comments = [];
    try { ast = parse(source, { ...options(sourceType), onToken: tokens, onComment: comments, locations: true }); }
    catch { throw error; }
  }
  const output = new MagicString(source);
  const diagnostics = [];
  let map;
  try { map = inputMap(comments, filename); }
  catch { return { source, count: 0, diagnostics: [{ reason: 'source-map-unreadable', file: filename }] }; }
  let count = 0;
  fullAncestor(ast, node => {
    const literal = node.type === 'CallExpression' && evalLiteral(node);
    if (!literal) return;
    try {
      const inner = transform(literal.value, filename, 'script', projectRoot, register);
      diagnostics.push(...inner.diagnostics);
      if (inner.count) {
        output.overwrite(literal.start, literal.end, JSON.stringify(inner.source));
        count += inner.count;
      }
    } catch {
      diagnostics.push({ reason: 'eval-code-transform-failed', file: filename, line: literal.loc.start.line });
    }
  });
  fullAncestor(ast, (node, _state, ancestors) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    const parent = ancestors.at(-2);
    let name = node.id?.name || parent?.id?.name || parent?.key?.name || parent?.key?.value || '<anonymous>';
    // Decide eligibility first: skipped constructs are only reported for
    // project code, not for bundler runtimes or dependencies inside a bundle.
    let file = filename;
    let line = node.loc.start.line;
    let column = node.loc.start.column + 1;
    let mapped = false;
    let endLine = node.loc.end.line;
    if (map) {
      const end = originalPositionFor(map, { line: node.loc.end.line, column: Math.max(0, node.loc.end.column - 1) });
      endLine = end.line ?? null;
      const original = originalPositionFor(map, { line, column: column - 1 });
      if (original.source && original.line != null) {
        file = original.source.startsWith('file:') ? fileURLToPath(original.source) : original.source;
        line = original.line;
        column = original.column + 1;
        name = original.name || name;
        mapped = true;
        if (end.source !== original.source) endLine = null;
      }
    }
    let libraryIndex = -1;
    if (projectRoot) {
      const path = relative(projectRoot, file);
      // Bundles may mix application and dependency code. Only original local
      // project sources are traced, regardless of the bundler's identity.
      // Unmapped code inside hidden folders (.next, .nuxt, .svelte-kit...) is
      // build output or bundler glue, not source the person wrote.
      const parts = path.split(sep);
      const project = isAbsolute(file) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
        && !parts.includes('node_modules') && (!map || (mapped && isLocalFile(file)))
        && (mapped || !parts.slice(0, -1).some(part => part.startsWith('.')));
      if (!project) {
        // Known library functions become boundaries, wherever they are loaded from.
        libraryIndex = libraryPointFor(file, String(name));
        if (libraryIndex < 0 || node.type === 'ArrowFunctionExpression' || node.generator || node.body.type !== 'BlockStatement') return;
      }
    }
    const global = `globalThis[Symbol.for(${JSON.stringify(runtimeKey)})]`;
    if (libraryIndex >= 0) {
      const assignments = (libraryPoints[libraryIndex].callbacks ?? []).map(index => node.params[index])
        .map(parameter => parameter?.type === 'AssignmentPattern' ? parameter.left : parameter)
        .filter(parameter => parameter?.type === 'Identifier')
        .map(({ name: parameter }) => `if(typeof ${parameter}==='function')${parameter}=${global}.callback(${parameter});`).join('');
      insertBody(`${global}.library(${libraryIndex},this,arguments,${JSON.stringify(String(name))},${node.async ? 'async ' : ''}()=>{${assignments}`);
      count++;
      return;
    }
    if (node.generator || (parent?.type === 'MethodDefinition' && parent.kind === 'constructor')) {
      diagnostics.push({ reason: node.generator ? 'generator-skipped' : 'constructor-skipped', file, line });
      return;
    }
    // Direct eval is scope-sensitive; do not move it to an inner closure.
    const parameterNames = new Set();
    for (const parameter of node.params) fullAncestor(parameter, child => {
      if (child.type === 'Identifier') parameterNames.add(child.name);
    });
    let parameterRedeclaration = false;
    fullAncestor(node.body, (child, _state, chain) => {
      if (chain.some(ancestor => ancestor !== child && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(ancestor.type))) return;
      if (child.type === 'VariableDeclaration' && child.kind === 'var') {
        for (const declaration of child.declarations) fullAncestor(declaration.id, binding => {
          if (binding.type === 'Identifier' && parameterNames.has(binding.name)) parameterRedeclaration = true;
        });
      }
      if (child.type === 'FunctionDeclaration' && parameterNames.has(child.id?.name)) parameterRedeclaration = true;
    });
    if (parameterRedeclaration) {
      diagnostics.push({ reason: 'parameter-redeclaration-skipped', file, line });
      return;
    }
    let directEval = false;
    let opaqueEval = false;
    fullAncestor(node.body, child => {
      if (child.type === 'CallExpression' && child.callee.type === 'Identifier' && child.callee.name === 'eval') {
        directEval = true;
        if (!evalLiteral(child)) opaqueEval = true;
      }
    });
    if (directEval) {
      // A wrapper whose only evals are mapped literals is bundler glue: the
      // evaluated code was handled above, so it is not a gap in the project.
      if (opaqueEval) diagnostics.push({ reason: 'direct-eval-skipped', file, line });
      return;
    }
    // The end line lets the panel show the whole function; it is only kept
    // when it maps to the same original file, after the start.
    if (map && !(endLine >= line)) endLine = null;
    // Detail on request (Phase 4): the callback receives a capture object,
    // null unless detail was asked for this function. It records the
    // parameters (bound names, after defaults and destructuring) and the
    // original line of each statement that runs. When off, each costs a
    // null check.
    const bound = [];
    for (const parameter of node.params) fullAncestor(parameter, (child, _state, chain) => {
      const holder = chain.at(-2);
      if (child.type !== 'Identifier') return;
      // Skip keys of object patterns and default values: only bound names.
      if (holder?.type === 'Property' && holder.key === child && holder.value !== child) return;
      if (holder?.type === 'AssignmentPattern' && holder.right === child) return;
      if (holder?.type === 'MemberExpression' || holder?.type === 'CallExpression') return;
      if (chain.slice(0, -1).some(item => item.type === 'AssignmentPattern' && item.right && contains(item.right, child))) return;
      if (!bound.includes(child.name)) bound.push(child.name);
    });
    const capture = '__codetac$c';
    const details = { function: String(name), file, line, endLine, column, mapped, async: node.async, params: bound };
    // With a runtime registry, each call passes a numeric id instead of
    // allocating and serialising the metadata again.
    const meta = register ? String(register(details)) : JSON.stringify(details);
    const call = `${global}.run(${meta},${node.async ? 'async ' : ''}(${capture})=>{${capture}&&${capture}.a([${bound.join(',')}]);`;
    const originalLine = position => {
      if (!map) return position.line;
      const found = originalPositionFor(map, { line: position.line, column: position.column });
      if (found.source == null || found.line == null) return null;
      const source = found.source.startsWith('file:') ? fileURLToPath(found.source) : found.source;
      return source === file ? found.line : null;
    };
    // A statement that spans lines marks all of them, unless it holds other
    // statements (if, loops, try…), which mark their own lines.
    const mark = (at, until) => {
      const original = originalLine(at);
      if (original == null) return '';
      const last = until ? originalLine(until) : null;
      return last != null && last > original ? `${capture}&&${capture}.l(${original},${last});` : `${capture}&&${capture}.l(${original});`;
    };
    const HOLDERS = /^(If|For|ForIn|ForOf|While|DoWhile|Try|Switch|Block|Labeled|With)Statement$/;
    function insertBody(call) {
      let insertion = node.body.start + 1;
      for (const statement of node.body.body) {
        if (!statement.directive) break;
        insertion = statement.end;
      }
      output.appendLeft(insertion, `;return ${call}`);
      output.prependRight(node.body.end - 1, '});');
    }
    if (node.body.type === 'BlockStatement') {
      insertBody(call);
      // Statements of this function (not of functions inside it), in lists
      // where a statement can be inserted before them.
      fullAncestor(node.body, (child, _state, chain) => {
        const holder = chain.at(-2);
        if (!holder || !/Statement|Declaration|Directive/.test(child.type) || child.directive) return;
        const list = holder.type === 'BlockStatement' || holder.type === 'SwitchCase' ? (holder.body ?? holder.consequent) : null;
        if (!list || !list.includes(child)) return;
        if (chain.slice(0, -1).some(item => item !== node && item !== node.body && /Function|StaticBlock|Class/.test(item.type))) return;
        if (child.type === 'FunctionDeclaration' || child.type === 'ClassDeclaration') return;
        const text = mark(child.loc.start, HOLDERS.test(child.type) ? null : child.loc.end);
        if (text) output.prependRight(child.start, text);
      });
    } else {
      const arrow = tokens.findLast(token => token.type.label === '=>' && token.start >= node.start && token.end <= node.body.start);
      output.prependRight(arrow.end, `{return ${call}${mark(node.body.loc.start, node.body.loc.end)}return (`);
      output.appendLeft(node.end, ');});}');
    }
    count++;
  });
  const generated = output.toString();
  parse(generated, options(sourceType));
  return { source: generated, count, diagnostics };
}
