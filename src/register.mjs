import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';
import { transform, runtimeKey } from './transform.mjs';
import { installBoundaries, isLibraryFile } from './boundaries.mjs';
import { panelUrl } from './page.mjs';
import { dataDirectory, install as workspace } from './home.mjs';
const root = realpathSync(resolve(process.env.CODETAC_ROOT || process.cwd()));
// Output goes to CodeTAC's data folder (home.mjs), never into the observed app.
const label = process.env.CODETAC_RUN || 'manual';
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error('CODETAC_RUN: use only letters, digits, _ or - (at most 80).');
const runtime = createRuntime(join(dataDirectory(), label));
globalThis[Symbol.for(runtimeKey)] = runtime;
// Minimal mode (Phase 5): requests, boundaries and the page bar, without
// following the project's functions. The `codetac` command falls back to it
// when the application does not start with the fine instrumentation; it is
// also used when this Node cannot register module hooks.
const minimal = process.env.CODETAC_LEVEL === 'minimo' || typeof registerHooks !== 'function';
const reason = process.env.CODETAC_LEVEL === 'minimo' ? (process.env.CODETAC_MINIMO_MOTIVO || 'requested at startup')
  : minimal ? `Node ${process.version} cannot register module hooks` : undefined;
runtime.emit({ type: 'capture-start', root, node: process.version, level: minimal ? 'minimo' : 'normal', reason });
// The page script is injected into HTML pages unless CODETAC_PAGE=0.
installBoundaries(runtime, root, { panel: panelUrl(), run: label, inject: process.env.CODETAC_PAGE !== '0' });
const transformed = new Map();
const produced = new Set();

function observed(filename) {
  if (filename.startsWith(join(workspace, 'src') + sep)) return false;
  // Known libraries are transformed only to mark their boundary functions.
  if (isLibraryFile(filename)) return true;
  if (minimal) return false;
  const within = relative(root, filename);
  return !(within.startsWith(`..${sep}`) || within === '..' || within.startsWith(sep)
    || within.split(sep).includes('node_modules'));
}

// Returns the instrumented source and format, or null to keep the original.
function instrument(source, filename, format) {
  // Development servers may reload unchanged bundles (require cache cleared);
  // reuse the transformation instead of parsing the same code again.
  const cached = transformed.get(filename);
  if (cached?.input === source) {
    runtime.emit({ type: 'module', file: filename, functions: cached.count, cached: true });
    return cached;
  }
  const input = source;
  try {
    // Another loader (tsx, ts-node...) may report a .ts file as plain
    // "module"/"commonjs" while its source still carries type syntax.
    if (format.endsWith('-typescript') || /\.[cm]?ts$/.test(filename)) {
      source = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: pathToFileURL(filename).href });
      format = format.replace('-typescript', '');
    }
    const output = transform(source, filename, format, root, runtime.register);
    runtime.emit({ type: 'module', file: filename, functions: output.count });
    for (const diagnostic of output.diagnostics) runtime.emit({ type: 'limitation', ...diagnostic });
    const entry = { input, format, source: output.source, count: output.count };
    transformed.set(filename, entry);
    produced.add(output.source);
    return entry;
  } catch (error) {
    // Parser messages hold a position, not source values; they are redacted anyway.
    runtime.emit({ type: 'limitation', reason: 'module-transform-failed', file: filename, detail: String(error?.message).slice(0, 200) });
    return null;
  }
}

if (typeof registerHooks === 'function') registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:')) return result;
    const filename = fileURLToPath(url);
    if (!observed(filename)
        || !['module', 'commonjs', 'module-typescript', 'commonjs-typescript'].includes(result.format)) return result;
    const source = result.source == null ? readFileSync(filename, 'utf8') : Buffer.from(result.source).toString('utf8');
    const entry = instrument(source, filename, result.format);
    return entry ? { ...result, format: entry.format, source: entry.source } : result;
  },
});

// Loaders that compile CommonJS themselves (for example through
// Module._extensions) bypass the load hook, but every CommonJS module still
// goes through Module.prototype._compile.
const Module = createRequire(import.meta.url)('node:module');
const compile = Module.prototype._compile;
Module.prototype._compile = function codetacCompile(content, filename, ...rest) {
  if (typeof content === 'string' && typeof filename === 'string' && !produced.has(content) && observed(filename)) {
    const entry = instrument(content, filename, 'commonjs');
    if (entry) return compile.call(this, entry.source, filename, ...rest);
  }
  return compile.call(this, content, filename, ...rest);
};
