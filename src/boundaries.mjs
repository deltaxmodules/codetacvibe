// Boundaries: what the application does outside its own code (database,
// external HTTP, AI, email, payments, files, authentication). Detection is by
// library or protocol, never by framework. Values are never recorded: SQL is
// kept as its template, URLs without query values, headers only classify.
import diagnostics from 'node:diagnostics_channel';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
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
  try { url = new URL(raw, base); } catch { return { path: '[inválido]', queryKeys: [] }; }
  return { url, path: safePath(url.pathname), queryKeys: [...new Set(url.searchParams.keys())] };
}

// SQL is recorded as a template: string literals are replaced, so values
// concatenated into the text do not reach the recording.
export function describeSql(sql) {
  if (typeof sql !== 'string') return { operation: 'consulta' };
  const text = sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "'?'").replace(/\s+/g, ' ').trim();
  const operation = (text.match(/^\s*(\w+)/)?.[1] ?? 'consulta').toUpperCase();
  const tables = [...text.matchAll(/\b(?:from|into|update|join|table(?: if (?:not )?exists)?)\s+[`"[]?([\w.]+)/gi)]
    .map(match => match[1]).filter(name => !/^(select|if|not|exists)$/i.test(name));
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
    return { ...base, kind: 'ia', provider: AI[host] ?? (local ? 'modelo local' : `compatível (${host})`), operation: path,
      local: local || undefined, model: typeof json?.model === 'string' ? json.model : undefined };
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
  // S3-compatible storage: signed header, or a presigned URL (signature in the query).
  if (/^AWS4-HMAC-SHA256/.test(String(headers.authorization ?? '')) || headers['x-amz-content-sha256']
      || queryKeys.some(key => /^x-amz-(signature|algorithm)$/i.test(key))) {
    const virtualHost = host.match(/^(.+?)\.s3[.-]/);
    const bucket = virtualHost ? virtualHost[1] : parsed.pathname.split('/')[1];
    const operation = { GET: 'leitura', HEAD: 'verificação', PUT: 'escrita', POST: 'escrita', DELETE: 'remoção' }[method] ?? method;
    const size = Number(headers['content-length']);
    return { ...base, kind: 'ficheiros', provider: 'S3', operation, bucket, bytes: Number.isFinite(size) ? size : undefined };
  }
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
  if (typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return { path: '(descritor)' };
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
    return runtime.startBoundary({ kind: 'ficheiros', provider: 'sistema de ficheiros', library: 'fs', function: name,
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

function installHttpClients(runtime) {
  const pending = new WeakMap();
  diagnostics.subscribe('undici:request:create', ({ request }) => {
    try {
      const headers = headerMap(request.headers);
      const details = classifyHttp({ method: request.method, url: `${request.origin}${request.path}`, headers, body: request.body, client: 'fetch' });
      const entry = { end: runtime.startBoundary(details) };
      // AI bodies are read (bounded) for usage and excerpts; nothing else is.
      if (details.kind === 'ia') Object.assign(entry, { ai: true, sent: [], received: [], size: 0, request: aiRequestDetails(jsonBody(request.body)) });
      pending.set(request, entry);
    } catch {}
  });
  const collect = (list, entry, chunk) => {
    if (!entry?.ai || entry.size > 1048576) return;
    const buffer = Buffer.from(chunk);
    entry.size += buffer.length;
    list(entry).push(buffer);
  };
  diagnostics.subscribe('undici:request:bodyChunkSent', ({ request, chunk }) => collect(entry => entry.sent, pending.get(request), chunk));
  diagnostics.subscribe('undici:request:bodyChunkReceived', ({ request, chunk }) => collect(entry => entry.received, pending.get(request), chunk));
  const aiDetails = entry => {
    if (!entry.ai) return {};
    try {
      const sent = entry.sent.length ? aiRequestDetails(JSON.parse(Buffer.concat(entry.sent).toString('utf8'))) : {};
      const request = { ...sent, ...Object.fromEntries(Object.entries(entry.request).filter(([, value]) => value !== undefined)) };
      return { ...request, ...aiResponseDetails(Buffer.concat(entry.received).toString('utf8')) };
    } catch { return {}; }
  };
  diagnostics.subscribe('undici:request:headers', ({ request, response }) => {
    const entry = pending.get(request);
    if (entry) entry.status = response.statusCode;
  });
  diagnostics.subscribe('undici:request:trailers', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ status: entry.status, ...aiDetails(entry) }); }
  });
  diagnostics.subscribe('undici:request:error', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ status: entry.status, error: true, ...aiDetails(entry) }); }
  });

  diagnostics.subscribe('http.client.request.start', ({ request }) => {
    try {
      const headers = headerMap(request.getHeaders?.() ?? {});
      const host = request.host ?? headers.host ?? 'localhost';
      const protocol = request.protocol ?? 'http:';
      pending.set(request, { end: runtime.startBoundary(classifyHttp({ method: request.method,
        url: `${protocol}//${host}${request.path}`, headers, body: null, client: 'http' })) });
    } catch {}
  });
  diagnostics.subscribe('http.client.response.finish', ({ request, response }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ status: response.statusCode }); }
  });
  diagnostics.subscribe('http.client.request.error', ({ request }) => {
    const entry = pending.get(request);
    if (entry) { pending.delete(request); entry.end({ error: true }); }
  });
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

export const libraryPoints = [
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
    before: ([data]) => ({ provider: 'SMTP/transporte', to: [data?.to].flat().filter(Boolean).map(String),
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
