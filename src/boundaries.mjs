// Boundaries: what the application does outside its own code (database,
// external HTTP, AI, email, payments, files, authentication). Detection is by
// library or protocol, never by framework. Values are never recorded: SQL is
// kept as its template, URLs without query values, headers only classify.
import diagnostics from 'node:diagnostics_channel';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { actionOf, handleOwnRoute, injectScript, wantsPage, INTERNAL_HEADER } from './page.mjs';

export const SKIP = Symbol('codetac.skip');

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

// Long opaque path segments (tokens, ids) are hidden; readable words stay.
export function safePath(pathname) {
  return String(pathname).split('/').map(segment => {
    const plain = decodeURIComponentSafe(segment);
    return plain.length >= 20 && /^[\w.~-]+$/.test(plain) && /\d/.test(plain) && /[a-z]/i.test(plain) ? '[REDACTED]' : segment;
  }).join('/');
}
function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function splitUrl(raw, base = 'http://localhost') {
  let url;
  try { url = new URL(raw, base); } catch { return { path: '[invalid]', queryKeys: [] }; }
  return { url, path: safePath(url.pathname), queryKeys: [...new Set(url.searchParams.keys())] };
}

// SQL is recorded as a template: string literals are replaced, so values
// concatenated into the text do not reach the recording.
export function describeSql(sql) {
  if (typeof sql !== 'string') return { operation: 'consulta' };
  const text = sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "'?'").replace(/\s+/g, ' ').trim();
  const operation = (text.match(/^\s*(\w+)/)?.[1] ?? 'consulta').toUpperCase();
  // Names may be quoted ("public"."notes", `main`.`Invoice`, [dbo].[t]); the
  // default schemas (public, main, dbo) are dropped, others are kept.
  const tables = [...text.matchAll(/\b(?:from|into|update|join|table(?: if (?:not )?exists)?)\s+((?:(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|\w+)\.)*(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|\w+))/gi)]
    .map(match => match[1].replace(/["`[\]]/g, '').replace(/^(public|main|dbo)\./i, ''))
    .filter(name => name && !/^(select|if|not|exists)$/i.test(name));
  return { operation, tables: [...new Set(tables)].slice(0, 10), sql: text.slice(0, 2000) };
}

function rowsOf(result) {
  if (Array.isArray(result)) return { rows: result.length };
  if (result && typeof result === 'object') {
    if (typeof result.affectedRows === 'number') return { affectedRows: result.affectedRows };
    if (typeof result.changes === 'number') return { affectedRows: result.changes };
    if (typeof result.rowCount === 'number') return { rows: result.rowCount };
    return { rows: 1 };
  }
  return { rows: result === undefined ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// HTTP classification
// ---------------------------------------------------------------------------

const AI = { 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic', 'generativelanguage.googleapis.com': 'Google',
  'api.mistral.ai': 'Mistral', 'api.groq.com': 'Groq', 'openrouter.ai': 'OpenRouter', 'api.deepseek.com': 'DeepSeek',
  'api.cohere.com': 'Cohere', 'api.together.xyz': 'Together' };
const MAIL = { 'api.resend.com': 'Resend', 'api.sendgrid.com': 'SendGrid', 'api.postmarkapp.com': 'Postmark',
  'api.mailgun.net': 'Mailgun', 'api.eu.mailgun.net': 'Mailgun', 'api.brevo.com': 'Brevo', 'api.twilio.com': 'Twilio' };

function bodyText(body) {
  if (typeof body === 'string') return body.length <= 262144 ? body : null;
  if (body instanceof Uint8Array && body.byteLength <= 262144) return Buffer.from(body).toString('utf8');
  return null;
}
function jsonBody(body) {
  const text = bodyText(body);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function classifyHttp({ method, url, headers, body, client }) {
  const { url: parsed, path, queryKeys } = splitUrl(url);
  const host = parsed?.hostname ?? '';
  const base = { kind: 'http', library: client, method, host, path, queryKeys };
  if (!parsed) return base;
  const local = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host);
  // Known providers by domain; local or self-hosted models by their API paths.
  const compatible = /^\/(v1\/(chat\/completions|completions|responses|messages)|api\/(chat|generate))$/.test(parsed.pathname);
  if (AI[host] || compatible) {
    const json = jsonBody(body);
    return { ...base, kind: 'ia', provider: AI[host] ?? (local ? 'local model' : `compatible (${host})`), operation: path,
      local: local || undefined, model: typeof json?.model === 'string' ? json.model : undefined };
  }
  // S3-compatible storage: signed header, or a presigned URL (signature in
  // the query: SigV4, or SigV2, which boto3 still makes by default). Before
  // the local case: a local MinIO or LocalStack is S3.
  if (/^AWS4-HMAC-SHA256/.test(String(headers.authorization ?? '')) || headers['x-amz-content-sha256']
      || queryKeys.some(key => /^x-amz-(signature|algorithm)$/i.test(key))
      || (queryKeys.includes('AWSAccessKeyId') && queryKeys.includes('Signature'))) {
    const virtualHost = host.match(/^(.+?)\.s3[.-]/);
    const bucket = virtualHost ? virtualHost[1] : parsed.pathname.split('/')[1];
    const operation = { GET: 'leitura', HEAD: 'verificação', PUT: 'escrita', POST: 'escrita', DELETE: 'remoção' }[method] ?? method;
    const size = Number(headers['content-length']);
    return { ...base, kind: 'ficheiros', provider: 'S3', operation, bucket, bytes: Number.isFinite(size) ? size : undefined };
  }
  if (local) return { ...base, local: true };
  if (host === 'api.stripe.com') {
    const auth = String(headers.authorization ?? '');
    const text = bodyText(body) ?? '';
    const form = new URLSearchParams(text);
    return { ...base, kind: 'pagamento', provider: 'Stripe', operation: `${method} ${path}`,
      mode: /(sk|rk)_test_/.test(auth) ? 'teste' : /(sk|rk)_live_/.test(auth) ? 'produção' : 'desconhecido',
      amount: form.get('amount') ?? undefined, currency: form.get('currency') ?? undefined };
  }
  if (MAIL[host]) {
    const json = jsonBody(body);
    const to = json?.to ?? json?.personalizations?.[0]?.to ?? json?.To;
    return { ...base, kind: MAIL[host] === 'Twilio' ? 'mensagem' : 'email', provider: MAIL[host],
      to: to === undefined ? undefined : [to].flat().map(item => typeof item === 'string' ? item : item?.email).filter(Boolean),
      subject: typeof json?.subject === 'string' ? json.subject : typeof json?.Subject === 'string' ? json.Subject : undefined };
  }
  if (host.endsWith('.supabase.co')) {
    const [, area, version, first, second] = parsed.pathname.split('/');
    if (area === 'rest' && version === 'v1') {
      const operation = { GET: 'SELECT', HEAD: 'SELECT', POST: 'INSERT', PATCH: 'UPDATE', PUT: 'UPSERT', DELETE: 'DELETE' }[method] ?? method;
      return { ...base, kind: 'base-de-dados', provider: 'Supabase', operation, tables: first === 'rpc' ? [`rpc:${second}`] : [first] };
    }
    if (area === 'auth') return { ...base, kind: 'autenticação', provider: 'Supabase Auth', operation: first };
    if (area === 'storage') return { ...base, kind: 'ficheiros', provider: 'Supabase Storage', operation: method, bucket: second === undefined ? first : second };
  }
  if (host === 'api.clerk.com' || host.endsWith('.clerk.accounts.dev')) return { ...base, kind: 'autenticação', provider: 'Clerk' };
  return base;
}

// AI calls: token usage and short excerpts, read from the JSON or SSE bodies.
const EXCERPT = 200;
const excerpt = text => typeof text === 'string' && text ? text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT) : undefined;
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text ?? part?.input_text ?? '').join(' ');
  return undefined;
}
export function aiRequestDetails(json) {
  if (!json || typeof json !== 'object') return {};
  const messages = json.messages ?? json.contents ?? (Array.isArray(json.input) ? json.input : null);
  let prompt = typeof json.input === 'string' ? json.input : typeof json.prompt === 'string' ? json.prompt : undefined;
  if (!prompt && Array.isArray(messages)) {
    const last = [...messages].reverse().find(message => (message?.role ?? 'user') === 'user') ?? messages.at(-1);
    prompt = textOf(last?.content) ?? textOf(last?.parts);
  }
  return { model: typeof json.model === 'string' ? json.model : undefined, promptExcerpt: excerpt(prompt), stream: json.stream === true || undefined };
}
function usageOf(value) {
  const usage = value?.usage ?? value?.response?.usage ?? value?.message?.usage;
  if (usage) {
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    if (input != null || output != null) return { input, output };
  }
  const meta = value?.usageMetadata;
  if (meta) return { input: meta.promptTokenCount, output: meta.candidatesTokenCount };
  return null;
}
function answerOf(value) {
  return value?.output_text ?? value?.choices?.[0]?.message?.content ?? value?.choices?.[0]?.text
    ?? value?.output?.find?.(item => item?.type === 'message')?.content?.[0]?.text
    ?? value?.content?.find?.(item => item?.type === 'text')?.text ?? value?.candidates?.[0]?.content?.parts?.[0]?.text;
}
export function aiResponseDetails(text) {
  const result = {};
  let answer = '';
  const take = value => {
    // Named "usage" (not "tokens") so the secret redaction keeps the counts.
    const usage = usageOf(value);
    if (usage) result.usage = { ...result.usage, ...Object.fromEntries(Object.entries(usage).filter(([, count]) => count != null)) };
    const full = answerOf(value);
    if (typeof full === 'string') answer = full;
    const delta = value?.choices?.[0]?.delta?.content ?? (value?.type === 'response.output_text.delta' ? value.delta : undefined)
      ?? (value?.type === 'content_block_delta' ? value.delta?.text : undefined);
    if (typeof delta === 'string' && answer.length < EXCERPT) answer += delta;
  };
  try { take(JSON.parse(text)); }
  catch {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { take(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
  if (answer) result.answerExcerpt = excerpt(answer);
  return result;
}

function headerMap(raw) {
  const map = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) map[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
  } else if (typeof raw === 'string') {
    for (const line of raw.split('\r\n')) {
      const index = line.indexOf(':');
      if (index > 0) map[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) map[key.toLowerCase()] = String(value);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export function installBoundaries(runtime, root, page = {}) {
  installRequests(runtime, page);
  installHttpClients(runtime);
  installNodeSqlite(runtime);
  installFiles(runtime, root);
  installPrisma(runtime);
}

// Prisma with its native engine runs the SQL in Rust, out of sight. Every
// client operation goes through the tracing helper Prisma reads from
// globalThis; ours only marks the operation as a boundary and traces nothing.
// Clients with a driver adapter (always in Prisma 7) already show their SQL
// through pg, mysql2 or better-sqlite3, so only the native runtimes count.
const PRISMA_READS = /^(find|count|aggregate|groupBy)/;
const PRISMA_NATIVE = /[\\/]runtime[\\/](library|binary)\.m?js\b/;
export function describePrisma(attributes = {}) {
  const method = String(attributes.method ?? '');
  const operation = PRISMA_READS.test(method) ? 'SELECT' : /^create/.test(method) ? 'INSERT'
    : method === 'upsert' ? 'UPSERT' : /^update/.test(method) ? 'UPDATE' : /^delete/.test(method) ? 'DELETE' : method;
  return { operation, command: method, tables: attributes.model ? [String(attributes.model)] : [],
    sql: attributes.model ? `${attributes.model}.${method}(…)` : `${method}(…)` };
}
export function prismaResult(operation, value) {
  if (operation === 'SELECT') return { rows: Array.isArray(value) ? value.length : value == null ? 0 : 1 };
  if (typeof value?.count === 'number') return { affectedRows: value.count };
  return Array.isArray(value) ? { affectedRows: value.length } : value == null ? {} : { affectedRows: 1 };
}
function installPrisma(runtime) {
  if (globalThis.PRISMA_INSTRUMENTATION) return;
  const helper = {
    isEnabled: () => false,
    getTraceParent: () => '00-10-10-00',
    dispatchEngineSpans() {},
    getActiveContext() {},
    runInChildSpan(options, callback) {
      if (options?.name !== 'operation' || !options.attributes?.method) return callback();
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 12;
      const stack = new Error().stack ?? '';
      Error.stackTraceLimit = limit;
      if (!PRISMA_NATIVE.test(stack)) return callback();
      const details = describePrisma(options.attributes);
      let end;
      try { end = runtime.startBoundary({ kind: 'base-de-dados', library: 'prisma', ...details }); } catch { return callback(); }
      let result;
      try { result = callback(); } catch (error) { end({ error: true }); throw error; }
      return settle(result, end, value => prismaResult(details.operation, value));
    },
  };
  Object.defineProperty(globalThis, 'PRISMA_INSTRUMENTATION', { value: { helper }, configurable: true, writable: true });
}

// Files: only operations made directly by project code during a request.
// The first caller frame outside Node and CodeTAC decides; library code
// (node_modules, bundled dependency chunks) is ignored.
const own = fileURLToPath(new URL('.', import.meta.url));
function callerIsProject(root) {
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  Error.captureStackTrace(holder, callerIsProject);
  Error.stackTraceLimit = limit;
  for (const line of String(holder.stack).split('\n').slice(1)) {
    const match = line.match(/(webpack-internal:\S*?)(?::\d+)+\)?\s*$/)
      ?? line.match(/\(?((?:file:\/\/|\/|[A-Za-z]:\\)[^():]*?)(?::\d+)+\)?\s*$/);
    if (!match) continue;
    let file = match[1];
    if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { continue; } }
    if (file.startsWith(own)) continue;
    if (/node_modules[\\/]|[\\/]node_modules_|^webpack-internal:.*node_modules/.test(file)) return false;
    if (file.startsWith('webpack-internal:')) return true;
    const within = relative(root, file);
    return !(within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within));
  }
  return false;
}
function describePath(root, target) {
  if (typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return { path: '(descriptor)' };
  let path = target instanceof URL ? fileURLToPath(target) : String(target);
  const within = relative(root, path);
  path = within && !within.startsWith('..') && !isAbsolute(within) ? within : path;
  return { path: safePath(path) };
}
const FILE_OPERATIONS = { readFile: 'leitura', writeFile: 'escrita', appendFile: 'escrita', unlink: 'remoção', rm: 'remoção',
  rename: 'mudança de nome', copyFile: 'cópia', mkdir: 'criação de pasta', rmdir: 'remoção' };
function sizeOf(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return undefined;
}
function installFiles(runtime, root) {
  if (!root) return;
  const start = (name, args) => {
    if (!runtime.currentRequest() || !callerIsProject(root)) return null;
    const bytes = name === 'writeFile' || name === 'appendFile' ? sizeOf(args[1]) : undefined;
    return runtime.startBoundary({ kind: 'ficheiros', provider: 'file system', library: 'fs', function: name,
      operation: FILE_OPERATIONS[name], ...describePath(root, args[0]), bytes });
  };
  const finish = (end, name, value) => end?.(name === 'readFile' ? { bytes: sizeOf(value) } : {});
  for (const name of Object.keys(FILE_OPERATIONS)) {
    const promised = fs.promises[name];
    if (typeof promised === 'function') {
      fs.promises[name] = async function (...args) {
        const end = start(name, args);
        try { const value = await promised.apply(this, args); finish(end, name, value); return value; }
        catch (error) { end?.({ error: true }); throw error; }
      };
    }
    const sync = fs[`${name}Sync`];
    if (typeof sync === 'function') {
      fs[`${name}Sync`] = function (...args) {
        const end = start(name, args);
        try { const value = sync.apply(this, args); finish(end, name, value); return value; }
        catch (error) { end?.({ error: true }); throw error; }
      };
    }
    const callback = fs[name];
    if (typeof callback === 'function') {
      fs[name] = function (...args) {
        const end = start(name, args);
        const last = args.length - 1;
        if (end && typeof args[last] === 'function') {
          const done = args[last];
          args[last] = function (error, value) { error ? end({ error: true }) : finish(end, name, value); return done.apply(this, arguments); };
        }
        return callback.apply(this, args);
      };
    }
  }
  // ESM named imports of node:fs and node:fs/promises see the observed versions.
  syncBuiltinESMExports();
}

// Each incoming HTTP request becomes a unit: everything it causes carries its
// id, and the browser action that caused it when the page script marked it.
// CodeTAC's own routes (/__codetac/) never reach the application.
function installRequests(runtime, page) {
  for (const prototype of [http.Server.prototype, https.Server.prototype]) {
    const emit = prototype.emit;
    prototype.emit = function codetacEmit(event, request, response) {
      // The port each server listens on: the `codetac` command uses it to say
      // where the application is.
      if (event === 'listening') {
        try {
          const address = this.address();
          if (address && typeof address === 'object') runtime.emit({ type: 'listening', port: address.port, address: address.address });
        } catch {}
      }
      if (event !== 'request' || !request || !response) return emit.apply(this, arguments);
      try {
        if (handleOwnRoute(request, response, runtime, page)) return true;
        if (request.headers[INTERNAL_HEADER]) return emit.apply(this, arguments);
        if (page.inject !== false && wantsPage(request)) {
          injectScript(request, response);
          runtime.emit({ type: 'page', path: splitUrl(request.url).path });
        }
      } catch {}
      return runtime.request(request, response, () => emit.apply(this, arguments), actionOf(request));
    };
  }
}

// The names of the fields a request sends out (StructureTAC phase 4), never
// their values: the top-level keys of a JSON body, of a form, or the parts of
// a multipart body. Plain names only, at most 40; null when the body cannot be
// read without consuming it (a stream).
const FIELD_NAME = /^[A-Za-z_$][\w$.-]{0,63}$/;
export function sentFields(body, contentType = '') {
  const text = bodyText(body);
  if (text == null || !text.trim()) return null;
  let names = [];
  const trimmed = text.trim();
  if (/multipart\/form-data/i.test(contentType)) names = [...text.matchAll(/content-disposition:[^\r\n]*\bname="([^"]+)"/gi)].map(match => match[1]);
  else if (trimmed.startsWith('{')) {
    try { const json = JSON.parse(trimmed); if (json && typeof json === 'object' && !Array.isArray(json)) names = Object.keys(json); } catch { return null; }
  } else if (trimmed.startsWith('[')) {
    try { const json = JSON.parse(trimmed); const first = Array.isArray(json) ? json.find(item => item && typeof item === 'object') : null; if (first) names = Object.keys(first); } catch { return null; }
  } else if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.$-]+=[^&]*(&[\w.$-]+=[^&]*)*$/.test(trimmed)) names = [...new URLSearchParams(trimmed).keys()];
  const unique = [...new Set(names.filter(name => FIELD_NAME.test(name)))].slice(0, 40);
  return unique.length ? unique : null;
}

function installHttpClients(runtime) {
  const pending = new WeakMap();
  diagnostics.subscribe('undici:request:create', ({ request }) => {
    try {
      const headers = headerMap(request.headers);
      const details = classifyHttp({ method: request.method, url: `${request.origin}${request.path}`, headers, body: request.body, client: 'fetch' });
      const entry = { end: runtime.startBoundary(details) };
      // What leaves the machine: the names of the fields sent to another host,
      // read from the first 64 KB sent (fetch hands the body over in chunks).
      if (!details.local) entry.out = { chunks: [], size: 0, type: headers['content-type'] ?? '' };
      // AI bodies are read (bounded) for usage and excerpts; nothing else is.
      if (details.kind === 'ia') Object.assign(entry, { ai: true, sent: [], received: [], size: 0, request: aiRequestDetails(jsonBody(request.body)) });
      pending.set(request, entry);
    } catch {}
  });
  const collect = (list, entry, chunk, encoding) => {
    if (!entry?.ai || entry.size > 1048576) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
    entry.size += buffer.length;
    list(entry).push(buffer);
  };
  diagnostics.subscribe('undici:request:bodyChunkSent', ({ request, chunk }) => {
    const entry = pending.get(request);
    collect(item => item.sent, entry, chunk);
    if (entry?.out && entry.out.size < 65536) { const buffer = Buffer.from(chunk); entry.out.chunks.push(buffer); entry.out.size += buffer.length; }
  });
  const fieldsOf = entry => {
    if (!entry.out?.chunks.length) return {};
    try { const fields = sentFields(Buffer.concat(entry.out.chunks).toString('utf8'), entry.out.type); return fields ? { fields } : {}; } catch { return {}; }
  };
  diagnostics.subscribe('undici:request:bodyChunkReceived', ({ request, chunk }) => collect(entry => entry.received, pending.get(request), chunk));
  const aiDetails = entry => {
    if (!entry.ai) return {};
    try {
      const sent = entry.sent.length ? aiRequestDetails(JSON.parse(Buffer.concat(entry.sent).toString('utf8'))) : {};
      const request = { ...sent, ...Object.fromEntries(Object.entries(entry.request).filter(([, value]) => value !== undefined)) };
      return { ...request, ...aiResponseDetails(decoded(Buffer.concat(entry.received), entry.encoding)) };
    } catch { return {}; }
  };
  diagnostics.subscribe('undici:request:headers', ({ request, response }) => {
    const entry = pending.get(request);
    if (entry) Object.assign(entry, { status: response.statusCode, encoding: headerMap(response.headers?.map?.(String))['content-encoding'] });
  });
  diagnostics.subscribe('undici:request:trailers', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ status: entry.status, ...fieldsOf(entry), ...aiDetails(entry) }); }
  });
  diagnostics.subscribe('undici:request:error', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ status: entry.status, error: true, ...fieldsOf(entry), ...aiDetails(entry) }); }
  });

  // http/https (axios, older SDKs): the bodies are not on the channels, so for
  // AI calls the request's write/end and the response's push are wrapped on
  // the instance. The app still gets every byte, in the same order and flow.
  const describeClient = request => {
    const headers = headerMap(request.getHeaders?.() ?? {});
    const host = request.host ?? headers.host ?? 'localhost';
    const protocol = request.protocol ?? 'http:';
    return classifyHttp({ method: request.method, url: `${protocol}//${host}${request.path}`, headers, body: null, client: 'http' });
  };
  // The body must be caught from the first write: newer Node publishes "start"
  // only once the request is sent, and "created" (from the constructor) exists
  // only there; older Node publishes "start" from the constructor.
  const sentBodies = new WeakMap();
  const watchBody = (request, details) => {
    if (details.kind !== 'ia' || sentBodies.has(request)) return;
    const body = { ai: true, sent: [], size: 0 };
    sentBodies.set(request, body);
    for (const name of ['write', 'end']) {
      const original = request[name];
      request[name] = function (chunk, encoding) {
        try { if (chunk != null && typeof chunk !== 'function') collect(item => item.sent, body, chunk, encoding); } catch {}
        return original.apply(this, arguments);
      };
    }
  };
  diagnostics.subscribe('http.client.request.created', ({ request }) => {
    try { watchBody(request, describeClient(request)); } catch {}
  });
  diagnostics.subscribe('http.client.request.start', ({ request }) => {
    try {
      const details = describeClient(request);
      watchBody(request, details);
      const entry = { end: runtime.startBoundary(details) };
      const body = sentBodies.get(request);
      // Shared with the write wrappers: the size limit counts both directions.
      if (body) Object.assign(body, { end: entry.end, received: [], request: {} });
      pending.set(request, body ?? entry);
    } catch {}
  });
  diagnostics.subscribe('http.client.response.finish', ({ request, response }) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    if (!entry.ai) { entry.end({ status: response.statusCode }); return; }
    // Fired with the headers: the body is still to come.
    entry.status = response.statusCode;
    entry.encoding = response.headers?.['content-encoding'];
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      entry.end({ status: entry.status, ...(error ? { error: true } : {}), ...aiDetails(entry) });
    };
    const push = response.push;
    response.push = function (chunk, encoding) {
      try { if (chunk === null) finish(); else collect(item => item.received, entry, chunk, encoding); } catch {}
      return push.apply(this, arguments);
    };
    response.once('close', () => finish(!response.complete));
  });
  diagnostics.subscribe('http.client.request.error', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ error: true, ...aiDetails(entry) }); }
  });
}

// Captured AI bodies may be compressed on the wire (fetch reports them before
// decoding; http never decodes). Only the bounded copy is decoded.
function decoded(buffer, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase();
  try {
    if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    if (kind === 'br') return zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }).toString('utf8');
    if (kind === 'deflate') {
      // Servers send it with or without the zlib wrapper.
      const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
      try { return zlib.inflateSync(buffer, options).toString('utf8'); } catch { return zlib.inflateRawSync(buffer, options).toString('utf8'); }
    }
    if (kind === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer).toString('utf8');
  } catch { return ''; }
  return buffer.toString('utf8');
}

function wrapSync(runtime, owner, name, describe, library) {
  const original = owner[name];
  if (typeof original !== 'function' || original.codetac) return;
  const wrapped = function (...args) {
    let end;
    try { end = runtime.startBoundary({ kind: 'base-de-dados', library, ...describe(this, args) }); } catch {}
    try {
      const result = original.apply(this, args);
      end?.(name === 'iterate' ? {} : rowsOf(result));
      return result;
    } catch (error) {
      end?.({ error: true });
      throw error;
    }
  };
  wrapped.codetac = true;
  Object.defineProperty(wrapped, 'name', { value: original.name });
  owner[name] = wrapped;
}

export function patchSqliteStatement(runtime, prototype, sqlOf, library) {
  for (const method of ['run', 'get', 'all', 'iterate']) {
    wrapSync(runtime, prototype, method, statement => describeSql(sqlOf(statement)), library);
  }
}

function installNodeSqlite(runtime) {
  let sqlite;
  try { sqlite = process.getBuiltinModule?.('node:sqlite'); } catch {}
  if (!sqlite?.StatementSync) return;
  patchSqliteStatement(runtime, sqlite.StatementSync.prototype, statement => statement.sourceSQL, 'node:sqlite');
  wrapSync(runtime, sqlite.DatabaseSync.prototype, 'exec', (_db, [sql]) => describeSql(sql), 'node:sqlite');
}

// ---------------------------------------------------------------------------
// Library points: functions inside libraries (loaded directly or found in a
// bundle through its source map) that are wrapped as boundaries.
// ---------------------------------------------------------------------------

function sqlArgument(value) {
  return typeof value === 'string' ? value : typeof value?.sql === 'string' ? value.sql : typeof value?.text === 'string' ? value.text : undefined;
}
function settle(result, end, extract = rowsOf) {
  if (result && typeof result.then === 'function') {
    // The derived promise keeps the caller's view: rejections stay unhandled
    // unless the application handles them.
    return result.then(value => { end(extract(value)); return value; }, error => { end({ error: true }); throw error; });
  }
  return result;
}

// MongoDB: every command of the official driver (and of Mongoose, which uses
// it) goes through executeOperation. Commands take the SQL names so the
// dossier, the sentences and the effects treat them like any other database.
// Filters are kept as field names only, never values.
const MONGO_OPERATIONS = {
  find: 'SELECT', aggregate: 'SELECT', getMore: 'SELECT', count: 'SELECT', distinct: 'SELECT',
  insert: 'INSERT', update: 'UPDATE', delete: 'DELETE',
  createIndexes: 'CREATE', create: 'CREATE', drop: 'DROP', dropIndexes: 'DROP',
};
const MONGO_INTERNAL = new Set(['endSessions', 'killCursors', 'bulkWrite', 'commitTransaction', 'abortTransaction']);
function mongoFilterKeys(operation) {
  const filters = [operation.filter, operation.query, operation.cmdBase?.query,
    ...(Array.isArray(operation.statements) ? operation.statements.map(statement => statement?.q) : []),
    ...(Array.isArray(operation.pipeline) ? operation.pipeline.map(stage => stage?.$match) : [])];
  const keys = filters.flatMap(filter => filter && typeof filter === 'object' && !Array.isArray(filter) ? Object.keys(filter) : []);
  return [...new Set(keys)].slice(0, 20);
}
export function describeMongo(operation) {
  let command;
  try { command = operation?.commandName; } catch {}
  if (typeof command !== 'string' || MONGO_INTERNAL.has(command)) return SKIP;
  const remove = command === 'findAndModify' && (operation.cmdBase?.remove || operation.constructor?.name === 'FindOneAndDeleteOperation');
  const target = operation.target ?? operation.collection?.collectionName;
  const collection = typeof target === 'string' && target !== '1' ? target : operation.ns?.collection;
  const filterKeys = mongoFilterKeys(operation);
  return { operation: command === 'findAndModify' ? (remove ? 'DELETE' : 'UPDATE') : MONGO_OPERATIONS[command] ?? command,
    command, tables: typeof collection === 'string' && collection !== '$cmd' ? [collection] : [],
    ...(filterKeys.length ? { filterKeys } : {}),
    // Shown where SQL templates are: the command and the filter fields, no values.
    sql: `${typeof collection === 'string' ? `${collection}.` : ''}${command}(${filterKeys.length ? `{ ${filterKeys.map(key => `${key}: …`).join(', ')} }` : ''})` };
}
export function mongoResult(operation, value) {
  if (operation === 'findAndModify') {
    // Driver 6 returns the document itself unless includeResultMetadata is set.
    const document = value && ('lastErrorObject' in value || ('value' in value && 'ok' in value)) ? value.value : value;
    return { affectedRows: document ? 1 : 0 };
  }
  if (value == null) return MONGO_OPERATIONS[operation] === 'SELECT' ? { rows: 0 } : {};
  if (MONGO_OPERATIONS[operation] === 'SELECT') {
    if (typeof value.length === 'number') return { rows: value.length };
    if (Array.isArray(value.cursor?.firstBatch)) return { rows: value.cursor.firstBatch.length };
    if (Array.isArray(value)) return { rows: value.length };
    return typeof value === 'number' ? { rows: 1 } : {};
  }
  const count = value.insertedCount ?? value.modifiedCount ?? value.deletedCount ?? value.nModified ?? value.n;
  if (typeof count === 'number') return { affectedRows: count };
  if ('insertedId' in value) return { affectedRows: 1 };
  return {};
}

// Observes a promise without taking part in its chain: the caller keeps the
// original, so a rejection nobody handles stays exactly as it was.
function observe(promise, end, extract) {
  if (!promise || typeof promise.then !== 'function') { end({}); return; }
  Promise.prototype.then.call(promise, value => { try { end(extract(value)); } catch { end({}); } }, () => end({ error: true }));
}

// postgres.js: a query is a lazy promise, sent on its first then/catch/finally
// (Query.handle). The template strings give the SQL with $n placeholders; the
// values never. Queries of the connection itself (types, state) are skipped.
function postgresSql(query) {
  const strings = query?.strings;
  if (!strings || typeof strings.length !== 'number' || !strings.length) return undefined;
  return Array.from(strings, String).reduce((text, part, index) => `${text}$${index}${part}`);
}
function postgresResult(result) {
  if (!result || typeof result !== 'object') return {};
  const command = typeof result.command === 'string' ? result.command.toUpperCase() : '';
  if (/^(INSERT|UPDATE|DELETE|MERGE|COPY)$/.test(command) && typeof result.count === 'number') return { affectedRows: result.count };
  return typeof result.length === 'number' ? { rows: result.length } : {};
}

// Redis (ioredis, node-redis): the command and its keys, never the values.
// Keys become patterns (session:{id}, cart:{n}) so the same kind of key is
// one "table" and opaque identifiers are not recorded.
const REDIS_INTERNAL = new Set(['AUTH', 'HELLO', 'CLIENT', 'SELECT', 'INFO', 'READONLY', 'MULTI', 'EXEC', 'DISCARD', 'QUIT', 'RESET']);
const REDIS_DELETES = new Set(['DEL', 'UNLINK', 'HDEL', 'SREM', 'ZREM', 'LREM', 'LPOP', 'RPOP', 'SPOP', 'BLPOP', 'BRPOP', 'LMPOP', 'BLMPOP',
  'ZPOPMIN', 'ZPOPMAX', 'BZPOPMIN', 'BZPOPMAX', 'ZMPOP', 'GETDEL', 'XDEL', 'XTRIM', 'LTRIM', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYRANK',
  'ZREMRANGEBYLEX', 'FLUSHDB', 'FLUSHALL', 'JSON.DEL', 'JSON.FORGET']);
const REDIS_WRITES = new Set(['SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'GETSET', 'GETEX', 'APPEND', 'SETRANGE', 'SETBIT',
  'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY', 'HSET', 'HSETNX', 'HMSET', 'HINCRBY', 'HINCRBYFLOAT', 'LPUSH', 'RPUSH',
  'LPUSHX', 'RPUSHX', 'LSET', 'LINSERT', 'LMOVE', 'BLMOVE', 'RPOPLPUSH', 'BRPOPLPUSH', 'SADD', 'SMOVE', 'ZADD', 'ZINCRBY', 'XADD',
  'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST', 'RENAME', 'RENAMENX', 'COPY', 'PFADD', 'PFMERGE', 'GEOADD',
  'SUNIONSTORE', 'SINTERSTORE', 'SDIFFSTORE', 'ZUNIONSTORE', 'ZINTERSTORE', 'ZDIFFSTORE', 'ZRANGESTORE', 'JSON.SET', 'JSON.MERGE']);
// Writes whose 0 or nil reply means that nothing was stored.
const REDIS_CONDITIONAL = new Set(['SET', 'SETNX', 'MSETNX', 'HSETNX', 'LPUSHX', 'RPUSHX', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT',
  'PERSIST', 'RENAMENX', 'COPY', 'SMOVE', 'GETEX']);
const REDIS_NO_KEYS = /^(PING|ECHO|TIME|DBSIZE|FLUSHDB|FLUSHALL|SCAN|KEYS|PUBLISH|SPUBLISH|SUBSCRIBE|PSUBSCRIBE|UNSUBSCRIBE|PUNSUBSCRIBE|CONFIG|COMMAND|SCRIPT|FUNCTION|MEMORY|SLOWLOG|LATENCY|WAIT|SAVE|BGSAVE|LASTSAVE|ROLE|MONITOR|DEBUG|OBJECT|CLUSTER|ACL|PUBSUB|WATCH|UNWATCH)$/;
function redisKeyIndexes(command, args) {
  if (REDIS_NO_KEYS.test(command)) return [];
  if (/^(MGET|DEL|UNLINK|EXISTS|TOUCH|SINTER|SUNION|SDIFF|PFCOUNT|WATCH)$/.test(command)) return args.map((_, index) => index);
  if (/^(MSET|MSETNX)$/.test(command)) return args.map((_, index) => index).filter(index => index % 2 === 0);
  if (/^(EVAL|EVALSHA|EVAL_RO|EVALSHA_RO|FCALL|FCALL_RO)$/.test(command)) {
    const count = Number(String(args[1]));
    return Number.isInteger(count) && count > 0 ? Array.from({ length: Math.min(count, 20) }, (_, index) => index + 2) : [];
  }
  if (/^(BLPOP|BRPOP|BZPOPMIN|BZPOPMAX)$/.test(command)) return args.slice(0, -1).map((_, index) => index);
  if (/^(RENAME|RENAMENX|COPY|SMOVE|LMOVE|BLMOVE|RPOPLPUSH|BRPOPLPUSH)$/.test(command)) return [0, 1];
  return args.length ? [0] : [];
}
export function redisKeyPattern(key) {
  const text = Buffer.isBuffer(key) ? key.toString('utf8') : String(key);
  return text.slice(0, 200).split(':').map(part => {
    if (/^\d+$/.test(part)) return '{n}';
    if (/@/.test(part)) return '{email}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^[0-9a-f]{12,}$/i.test(part)
      || (part.length >= 16 && /\d/.test(part) && /[a-z]/i.test(part) && /^[\w.~+/=-]+$/.test(part))) return '{id}';
    return part.length > 40 ? '{…}' : part;
  }).join(':');
}
export function describeRedis(name, args, keys) {
  const command = String(name ?? '').toUpperCase();
  if (!command || REDIS_INTERNAL.has(command)) return SKIP;
  const list = Array.isArray(args) ? args : [];
  const indexes = keys ?? redisKeyIndexes(command, list).map(index => list[index]);
  const patterns = [...new Set(indexes.filter(key => key != null && typeof key !== 'object' || Buffer.isBuffer(key)).map(redisKeyPattern))].slice(0, 5);
  const operation = REDIS_DELETES.has(command) ? 'DELETE' : REDIS_WRITES.has(command) ? 'UPDATE'
    : REDIS_NO_KEYS.test(command) ? command : 'SELECT';
  return { operation, command, tables: patterns, sql: `${command}${patterns.length ? ` ${patterns.join(' ')}` : ''}` };
}
export function redisResult(details, reply) {
  if (!details || details === SKIP) return {};
  const { operation, command } = details;
  if (operation === 'DELETE') {
    if (typeof reply === 'number') return { affectedRows: reply };
    if (reply == null || (Array.isArray(reply) && !reply.length)) return { affectedRows: 0 };
    return { affectedRows: Array.isArray(reply) && !/POP/.test(command) ? reply.length : 1 };
  }
  if (operation === 'UPDATE') {
    const nothing = reply == null || (REDIS_CONDITIONAL.has(command) && (reply === 0 || reply === false));
    return { affectedRows: nothing ? 0 : Math.max(1, details.tables.length) };
  }
  if (operation === 'SELECT') {
    if (command === 'EXISTS' && typeof reply === 'number') return { rows: reply };
    return { rows: reply == null ? 0 : Array.isArray(reply) ? reply.length : 1 };
  }
  return {};
}
// ioredis sends a queued command again when the connection comes back.
const redisSeen = new WeakMap();
function ioredisDetails(command) {
  if (!command || typeof command !== 'object' || redisSeen.has(command)) return SKIP;
  let keys;
  try { keys = typeof command.getKeys === 'function' ? command.getKeys() : undefined; } catch {}
  const details = describeRedis(command.name, command.args, keys);
  redisSeen.set(command, details);
  return details;
}

export const libraryPoints = [
  { file: /node_modules\/postgres\/(src|cjs\/src|cf\/src)\/query\.js$/, names: ['handle'], kind: 'base-de-dados', library: 'postgres',
    // handle() runs on every then/catch/finally; only the first one sends.
    before: (_args, self) => self?.executed || self?.handler?.name === 'execute' ? SKIP : describeSql(postgresSql(self) ?? ''),
    after: (result, end, self) => { observe(self, end, postgresResult); return result; } },
  { file: /node_modules\/ioredis\/built\/Redis\.js$/, names: ['sendCommand'], kind: 'base-de-dados', library: 'ioredis',
    before: ([command]) => ioredisDetails(command),
    after: (result, end, _self, _name, _api, [command]) => { observe(command?.promise ?? result, end, reply => redisResult(redisSeen.get(command), reply)); return result; } },
  { file: /node_modules\/@redis\/client\/(dist\/)?lib\/client\/commands-queue\.[jt]s$/, names: ['addCommand'], kind: 'base-de-dados', library: 'redis',
    before: ([args]) => Array.isArray(args) ? describeRedis(args[0], args.slice(1)) : SKIP,
    after: (result, end, _self, _name, _api, [args]) => { observe(result, end, reply => redisResult(describeRedis(args?.[0], args?.slice(1)), reply)); return result; } },
  { file: /node_modules\/mongodb\/(lib|src)\/operations\/execute_operation\.[jt]s$/, names: ['executeOperation'], kind: 'base-de-dados', library: 'mongodb',
    before: ([, operation]) => describeMongo(operation),
    after: (result, end, _self, _name, _api, [, operation]) => settle(result, end, value => mongoResult(operation?.commandName, value)) },
  { file: /node_modules\/mysql2\/lib\/base\/connection\.js$/, names: ['query', 'execute'], kind: 'base-de-dados', library: 'mysql2',
    before: args => describeSql(sqlArgument(args[0])),
    after(command, end) {
      if (!command || typeof command.once !== 'function') { end({}); return command; }
      const onResult = command.onResult;
      if (typeof onResult === 'function') {
        command.onResult = function (error, rows, ...rest) {
          end(error ? { error: true } : rowsOf(rows));
          return onResult.call(this, error, rows, ...rest);
        };
      } else {
        command.once('end', () => end(rowsOf(command._rows?.[0])));
      }
      return command;
    } },
  { file: /node_modules\/pg\/lib\/client\.js$/, names: ['query'], kind: 'base-de-dados', library: 'pg', callbacks: [1, 2],
    before: args => describeSql(sqlArgument(args[0])),
    after: (result, end) => settle(result, end) },
  { file: /node_modules\/nodemailer\/lib\/mailer\/index\.js$/, names: ['sendMail'], kind: 'email', library: 'nodemailer', callbacks: [1],
    before: ([data]) => ({ provider: 'SMTP/transport', to: [data?.to].flat().filter(Boolean).map(String),
      subject: typeof data?.subject === 'string' ? data.subject : undefined }),
    after: (result, end) => settle(result, end, info => ({ accepted: info?.accepted?.length, rejected: info?.rejected?.length })) },
  // Authentication: whether a session exists, never its content.
  { file: /node_modules\/next-auth\/next\/index\.js$/, names: ['getServerSession'], kind: 'autenticação', library: 'next-auth',
    before: () => ({ provider: 'NextAuth', operation: 'verificação de sessão' }),
    after: (result, end) => settle(result, end, session => ({ sessao: session ? 'presente' : 'ausente' })) },
  { file: /node_modules\/next-auth\/lib\/index\.js$/, names: ['getSession'], kind: 'autenticação', library: 'next-auth',
    before: () => ({ provider: 'Auth.js', operation: 'verificação de sessão' }),
    after: (result, end) => settle(result, end, response => ({ status: response?.status })) },
  // better-sqlite3 statements are native: the first prepare() patches their prototype.
  { file: /node_modules\/better-sqlite3\/lib\/methods\/wrappers\.js$/, names: ['prepare', 'exec'], kind: 'base-de-dados', library: 'better-sqlite3',
    before: (args, _self, name, runtime) => name === 'exec' ? describeSql(args[0]) : SKIP,
    after(result, end, _self, name, runtime) {
      if (name === 'prepare' && result && typeof result === 'object') {
        patchSqliteStatement(runtime, Object.getPrototypeOf(result), statement => statement.source, 'better-sqlite3');
      } else end({});
      return result;
    } },
];

export function libraryPointFor(file, name) {
  const normalized = String(file).replaceAll('\\', '/');
  return libraryPoints.findIndex(point => point.file.test(normalized) && point.names.includes(name));
}
export function isLibraryFile(file) {
  const normalized = String(file).replaceAll('\\', '/');
  return libraryPoints.some(point => point.file.test(normalized));
}
