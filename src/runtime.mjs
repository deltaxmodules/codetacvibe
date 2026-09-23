import { AsyncLocalStorage } from 'node:async_hooks';
import fs, { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId, isMainThread } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createRedactor, isSensitiveName } from './redact.mjs';
import { SKIP, libraryPoints, splitUrl } from './boundaries.mjs';

// Events are buffered and written in batches. The order inside a file is the
// order of `sequence`; the buffer is flushed on size, on a short timer, on
// normal exit and on SIGINT/SIGTERM/SIGHUP. A SIGKILL loses the last batch.
const FLUSH_BYTES = 256 * 1024;
// CodeTAC's own batches must not appear as writes of the application: they
// are written with open/write/close, which the file boundary does not wrap
// (fs.appendFileSync goes through the wrapped fs.writeFileSync).
const { openSync, writeSync, closeSync } = fs;
function appendFileSync(file, text, { mode }) {
  const fd = openSync(file, 'a', mode);
  try {
    const buffer = Buffer.from(text);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
  } finally { closeSync(fd); }
}
const FLUSH_MS = 25;

export function createRuntime(directory, { flushBytes = FLUSH_BYTES, flushMs = FLUSH_MS } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${process.pid}-${threadId}-${randomUUID()}.jsonl`);
  const context = new AsyncLocalStorage();
  const redact = createRedactor();
  const processId = `${process.pid}:${threadId}`;
  const prefix = `{"version":1,"process":${JSON.stringify(processId)},"sequence":`;
  const idPrefix = JSON.stringify(`${processId}:`).slice(0, -1);
  const functions = [];
  let buffer = [];
  let bufferedBytes = 0;
  let timer = null;
  let sequence = 0;
  let span = 0;
  let requests = 0;
  let boundaries = 0;
  let disabled = false;
  let pendingEnd = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buffer.length || disabled) return;
    const chunk = buffer.join('');
    buffer = [];
    bufferedBytes = 0;
    try {
      appendFileSync(file, chunk, { mode: 0o600 });
    } catch {
      disabled = true;
      process.stderr.write('[CodeTAC] Gravação indisponível; a aplicação continua sem captura.\n');
    }
  }
  function write(line) {
    if (disabled) return;
    buffer.push(line);
    bufferedBytes += line.length;
    if (bufferedBytes >= flushBytes) flush();
    else if (!timer) { timer = setTimeout(flush, flushMs); timer.unref(); }
  }
  // `body` is a JSON object fragment without braces, already redacted.
  function line(body) {
    return `${prefix}${++sequence},"timeNs":${Number(process.hrtime.bigint())},${body}}\n`;
  }
  function emit(event) {
    if (disabled) return;
    write(line(JSON.stringify(redact(event)).slice(1, -1)));
  }
  // Static function metadata is redacted and serialised once, not per call.
  // Parameter names stay out of the per-call event; they only name the
  // values recorded in detail mode.
  function prepare(meta) {
    const { params, ...recorded } = meta;
    return { async: Boolean(meta.async), enter: JSON.stringify(redact(recorded)).slice(1, -1),
      file: meta.file, line: meta.line, name: meta.function, params: params ?? [] };
  }
  function register(meta) {
    const info = prepare(meta);
    functions.push(info);
    detailed.push(wanted(info));
    return functions.length - 1;
  }

  // Detail on request (Phase 4): the panel writes detalhe.json in this
  // recording's folder; the functions it names record their arguments,
  // return value and executed lines from the next call on. Everything else
  // only pays a null check.
  const detailed = [];
  let wish = { functions: new Set(), files: new Set() };
  function wanted(info) {
    // A function is named by file, line and name: several functions can start on one line.
    return wish.files.has(info.file) || wish.functions.has(`${info.file}:${info.line}:${info.name}`) || wish.functions.has(`${info.file}:${info.line}:`);
  }
  const detailFile = join(directory, 'detalhe.json');
  function readDetail() {
    let spec = {};
    try { spec = JSON.parse(readFileSync(detailFile, 'utf8')); } catch {}
    wish = { functions: new Set((spec.functions ?? []).map(item => `${item.file}:${item.line}:${item.function ?? ''}`)), files: new Set(spec.files ?? []) };
    for (let index = 0; index < functions.length; index++) detailed[index] = wanted(functions[index]);
  }
  readDetail();
  try { fs.watchFile(detailFile, { interval: 400, persistent: false }, readDetail); } catch {}

  function capture() {
    return { args: undefined, lines: new Set(), a(values) { this.args = values; }, l(line, last = line) { for (let n = line; n <= last; n++) this.lines.add(n); } };
  }
  function detailEvent(id, request, info, captured, outcome) {
    const event = { type: 'detail', id: JSON.parse(id), requestId: request === 'null' ? null : JSON.parse(request),
      // Parameter names are values of this event, so the redaction by field
      // name cannot see them: sensitive parameters are hidden here, and so is
      // what a function with a sensitive name returns (a password hash…).
      args: info.params.map((name, index) => ({ name, value: isSensitiveName(name) ? '[REDACTED]' : preview(captured.args?.[index]) })),
      lines: [...captured.lines].sort((a, b) => a - b) };
    if (outcome.error) event.threw = preview(outcome.value);
    else event.returned = isSensitiveName(info.name) ? '[REDACTED]' : preview(outcome.value);
    emit(event);
  }

  function run(meta, callback) {
    const info = typeof meta === 'number' ? functions[meta] : prepare(meta);
    const captured = typeof meta === 'number' && detailed[meta] ? capture() : null;
    const parent = context.getStore();
    const number = ++span;
    const id = `${idPrefix}${number}"`;
    const request = parent ? parent.request : 'null';
    write(line(`"type":"enter","id":${id},"parentId":${parent ? parent.id : 'null'},"requestId":${request},${info.enter}`));
    const start = process.hrtime.bigint();
    const finish = (error, value) => {
      if (captured) { try { detailEvent(id, request, info, captured, { error, value }); } catch {} }
      write(line(`"type":"exit","id":${id},"requestId":${request},"error":${error},"durationNs":${Number(process.hrtime.bigint() - start)}`));
    };
    return context.run({ id, request }, () => {
      try {
        const result = callback(captured);
        if (info.async) {
          return result.then(value => { finish(false, value); return value; }, error => { finish(true, error); throw error; });
        }
        finish(false, result);
        return result;
      } catch (error) {
        finish(true, error);
        throw error;
      }
    });
  }

  // Store ids are kept as JSON literals (see run); boundaries decode them.
  function current() {
    const store = context.getStore();
    return { parentId: store && store.id !== 'null' ? JSON.parse(store.id) : null,
      requestId: store && store.request !== 'null' ? JSON.parse(store.request) : null };
  }
  // Starts a boundary and returns end(extra), which records it once.
  function startBoundary(details) {
    const id = `${processId}:b${++boundaries}`;
    const where = current();
    emit({ type: 'boundary', id, ...where, ...details });
    const start = process.hrtime.bigint();
    let done = false;
    return (extra = {}) => {
      if (done) return;
      done = true;
      emit({ type: 'boundary-end', id, requestId: where.requestId, durationNs: Number(process.hrtime.bigint() - start), error: false, ...extra });
    };
  }
  function library(index, self, args, name, body) {
    const point = libraryPoints[index];
    let details;
    try { details = point.before ? point.before(args, self, name, api) : {}; } catch { details = {}; }
    const end = details === SKIP ? () => {} : startBoundary({ kind: point.kind, library: point.library, function: name, ...details });
    const previous = pendingEnd;
    pendingEnd = end;
    let result;
    try { result = body(); }
    catch (error) { end({ error: true }); throw error; }
    finally { pendingEnd = previous; }
    try { return point.after ? point.after(result, end, self, name, api) : (end({}), result); }
    catch { end({}); return result; }
  }
  // Wraps a callback argument of the library call being entered.
  function callback(fn) {
    const end = pendingEnd;
    if (!end || typeof fn !== 'function') return fn;
    return function (error, ...rest) {
      end(error ? { error: true } : {});
      return fn.call(this, error, ...rest);
    };
  }
  function request(req, res, handle, action = null) {
    const parent = context.getStore();
    const requestId = `${processId}:r${++requests}`;
    const { path, queryKeys } = splitUrl(req.url ?? '/');
    emit({ type: 'request', requestId, parentId: current().parentId, method: req.method, path, queryKeys, at: Date.now(),
      action: action?.action, actionRequest: action?.actionRequest ?? undefined });
    const start = process.hrtime.bigint();
    let done = false;
    // Cookies the response sets or deletes: names only, never values. Headers
    // given directly to writeHead are not visible through getHeader.
    let written = null;
    const writeHead = res.writeHead;
    if (typeof writeHead === 'function') {
      res.writeHead = function (...args) {
        const headers = args.find((item, index) => index > 0 && item && typeof item === 'object');
        if (headers) written = Array.isArray(headers) ? headers : Object.entries(headers);
        return writeHead.apply(this, args);
      };
    }
    const end = () => {
      if (done) return;
      done = true;
      let cookies;
      try { cookies = cookieNames(res.getHeader?.('set-cookie'), written); } catch {}
      emit({ type: 'request-end', requestId, status: res.statusCode, aborted: !res.writableFinished,
        durationNs: Number(process.hrtime.bigint() - start), cookies });
    };
    res.once('finish', end);
    res.once('close', end);
    return context.run({ id: parent ? parent.id : 'null', request: JSON.stringify(requestId) }, handle);
  }
  function currentRequest() {
    const store = context.getStore();
    return store && store.request !== 'null' ? store.request : null;
  }
  const api = { run, emit, register, flush, file, startBoundary, library, callback, request, currentRequest };

  process.on('exit', flush);
  // Signals are only delivered to the main thread.
  // CodeTAC's listener runs first and removes itself before the others run,
  // so handlers that exit only when they are alone (tsx, for example) still
  // see themselves alone. With no other listener, the default termination is
  // restored by raising the signal again.
  for (const signal of isMainThread ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : []) {
    const onSignal = () => {
      process.removeListener(signal, onSignal);
      flush();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.prependListener(signal, onSignal);
  }
  return api;
}

// Set-Cookie headers → [{ name, cleared }]. A cookie is cleared when it
// expires immediately (Max-Age=0 or less, or an Expires date in the past).
export function cookieNames(header, written) {
  const values = [header].flat().filter(value => typeof value === 'string');
  if (written) {
    // writeHead(status, [name, value, name, value…]) or entries of an object.
    const pairs = written.length && !Array.isArray(written[0]) ? written.flatMap((item, index) => index % 2 ? [] : [[item, written[index + 1]]]) : written;
    for (const [name, value] of pairs) if (String(name).toLowerCase() === 'set-cookie') values.push(...[value].flat().filter(item => typeof item === 'string'));
  }
  if (!values.length) return undefined;
  const result = new Map();
  for (const value of values) {
    const [pair, ...attributes] = value.split(';');
    const name = pair.split('=')[0].trim();
    if (!name) continue;
    const maxAge = attributes.map(item => item.trim().match(/^max-age\s*=\s*(-?\d+)/i)?.[1]).find(item => item != null);
    const expires = attributes.map(item => item.trim().match(/^expires\s*=\s*(.+)$/i)?.[1]).find(Boolean);
    const cleared = maxAge != null ? Number(maxAge) <= 0 : expires ? Date.parse(expires) < Date.now() : false;
    result.set(name, { name, cleared });
  }
  return [...result.values()];
}

// A readable copy of a value for the detail view: plain JSON, bounded in
// depth, length and size. Getters are not called (they could change state);
// class instances keep their class name. Redaction happens when it is emitted.
const LIMITS = { depth: 4, items: 20, keys: 30, nodes: 300, text: 2000 };
export function preview(value) {
  let nodes = 0;
  const seen = new WeakSet();
  function walk(item, depth) {
    if (++nodes > LIMITS.nodes) return '[…]';
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : String(item);
    if (typeof item === 'string') return item.length > LIMITS.text ? `${item.slice(0, LIMITS.text)}[TRUNCATED ${item.length}]` : item;
    if (item === undefined) return { $tipo: 'undefined' };
    if (typeof item === 'bigint') return `${item}n`;
    if (typeof item === 'symbol') return { $tipo: 'symbol', descricao: item.description ?? '' };
    if (typeof item === 'function') return { $tipo: 'função', nome: item.name || '(anónima)' };
    if (seen.has(item)) return { $tipo: 'circular' };
    if (depth >= LIMITS.depth) return { $tipo: Array.isArray(item) ? `lista (${item.length})` : className(item) ?? 'objeto', $resumido: true };
    seen.add(item);
    try {
      if (item instanceof Error) return { $tipo: 'erro', nome: item.name, mensagem: String(item.message ?? '') };
      if (item instanceof Date) return { $tipo: 'data', valor: Number.isNaN(item.getTime()) ? 'inválida' : item.toISOString() };
      if (item instanceof Promise) return { $tipo: 'promessa' };
      const known = summary(item);
      if (known) return known;
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return { $tipo: className(item) ?? 'bytes', bytes: item.byteLength };
      if (item instanceof Map) return { $tipo: 'Map', tamanho: item.size, entradas: [...item].slice(0, LIMITS.items).map(([key, entry]) => [walk(key, depth + 1), walk(entry, depth + 1)]) };
      if (item instanceof Set) return { $tipo: 'Set', tamanho: item.size, valores: [...item].slice(0, LIMITS.items).map(entry => walk(entry, depth + 1)) };
      if (Array.isArray(item)) {
        const out = item.slice(0, LIMITS.items).map(entry => walk(entry, depth + 1));
        if (item.length > LIMITS.items) out.push({ $mais: item.length - LIMITS.items });
        return out;
      }
      const out = {};
      const name = className(item);
      if (name) out.$classe = name;
      // Fields starting with "_" of class instances are internals (streams,
      // emitters, frameworks), not the application's data.
      const keys = Object.keys(item).filter(key => !(name && key.startsWith('_')));
      for (const key of keys.slice(0, LIMITS.keys)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        out[key] = descriptor && 'value' in descriptor ? walk(descriptor.value, depth + 1) : { $tipo: 'getter' };
      }
      if (keys.length > LIMITS.keys) out.$mais = keys.length - LIMITS.keys;
      return out;
    } catch {
      return { $tipo: 'ilegível' };
    }
  }
  return walk(value, 0);
}
// HTTP objects of Node, fetch and frameworks are summarised: method, path
// without query values and header names, never header values (cookies,
// authorization) nor sockets and buffers.
function summary(item) {
  const name = className(item);
  if (!name) return null;
  const headerNames = headers => {
    try {
      if (typeof headers?.keys === 'function') return [...headers.keys()].slice(0, 40);
      return Object.keys(headers ?? {}).slice(0, 40);
    } catch { return []; }
  };
  const path = url => { try { const parsed = new URL(String(url), 'http://x'); return parsed.pathname + (parsed.search ? '?' + [...parsed.searchParams.keys()].map(key => `${key}=…`).join('&') : ''); } catch { return '[?]'; } };
  if (name === 'IncomingMessage' || (typeof item.method === 'string' && 'headers' in item && ('url' in item))) {
    return { $classe: name, metodo: item.method, caminho: path(item.url), cabecalhos: headerNames(item.headers) };
  }
  if (name === 'ServerResponse') return { $classe: name, estado: item.statusCode, cabecalhos: headerNames(item.getHeaders?.()) };
  if (name === 'Response') return { $classe: name, estado: item.status, cabecalhos: headerNames(item.headers) };
  if (name === 'Headers') return { $classe: name, nomes: headerNames(item) };
  if (/^(Socket|TLSSocket|Server|Agent|EventEmitter|Readable|Writable|Duplex|Transform|PassThrough|WriteStream|ReadStream|Pool|PoolConnection|Connection|Database|DatabaseSync|Statement|StatementSync)$/.test(name)) {
    return { $classe: name, $resumido: true };
  }
  return null;
}
function className(item) {
  try {
    const proto = Object.getPrototypeOf(item);
    if (proto === null) return null;
    const name = proto.constructor?.name;
    return name && name !== 'Object' ? name : null;
  } catch { return null; }
}
