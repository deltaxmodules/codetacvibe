// Browser positions → project source. The page script only records positions
// in the scripts the browser ran (URL, line, column). They are resolved here
// through the source maps that the application's own development server
// publishes, whatever the bundler: separate or inline maps, and code evaluated
// from strings with its own map (webpack's "eval" development modes).
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { AnyMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_HEADER } from './page.mjs';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)$/;
const MAX_SCRIPT = 64 * 1024 * 1024;

async function defaultFetch(url) {
  const response = await fetch(url, { headers: { [INTERNAL_HEADER]: '1' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_SCRIPT) throw new Error('demasiado grande');
  return text;
}

function decodeDataUrl(reference) {
  const comma = reference.indexOf(',');
  return reference.slice(0, comma).includes(';base64')
    ? Buffer.from(reference.slice(comma + 1), 'base64').toString('utf8')
    : decodeURIComponent(reference.slice(comma + 1));
}
// Only a comment at the start of a real line counts; the same text inside a
// string (code evaluated later) belongs to that code, not to the script.
function lastMapReference(text) {
  let found = null;
  for (const match of text.matchAll(/^\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/gm)) found = match[1];
  return found;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
function sameText(file, text) {
  try { return readFileSync(file, 'utf8') === text; } catch { return false; }
}
function inside(root, file) {
  const within = relative(root, file);
  return within !== '' && !within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within);
}

export function createResolver({ fetchText = defaultFetch } = {}) {
  const scripts = new Map();   // script URL → Promise<{ map } | null>
  const evaluated = new Map(); // sourceURL of evaluated code → AnyMap
  const indexed = new Set();   // scripts already searched for evaluated code
  const subfolders = new Map();

  function loadScript(url) {
    if (!scripts.has(url)) {
      scripts.set(url, (async () => {
        const text = await fetchText(url);
        const reference = lastMapReference(text);
        if (!reference) return { text, map: null };
        if (reference.startsWith('data:')) return { text, map: new AnyMap(JSON.parse(decodeDataUrl(reference)), url) };
        const mapUrl = new URL(reference, url);
        if (mapUrl.origin !== new URL(url).origin) return { text, map: null };
        return { text, map: new AnyMap(JSON.parse(await fetchText(mapUrl.href)), mapUrl.href) };
      })().catch(() => null));
    }
    return scripts.get(url);
  }

  // Code evaluated from string literals, with an inline map and a sourceURL.
  async function indexEvaluated(url) {
    if (indexed.has(url)) return;
    indexed.add(url);
    const loaded = await loadScript(url);
    if (!loaded?.text || !loaded.text.includes('sourceURL=')) return;
    let ast;
    try { ast = parse(loaded.text, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
    catch { try { ast = parse(loaded.text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); } catch { return; } }
    simple(ast, {
      CallExpression(node) {
        let argument = node.arguments[0];
        // Trusted Types wrappers: eval(policy("…")), as in Next.js (__webpack_require__.ts).
        if (argument?.type === 'CallExpression' && argument.arguments.length === 1) argument = argument.arguments[0];
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'eval' || argument?.type !== 'Literal' || typeof argument.value !== 'string') return;
        const code = argument.value;
        // The last sourceURL is the one the browser uses (webpack writes "[module]" first).
        const name = [...code.matchAll(/^\/\/[#@]\s*sourceURL=(\S+)\s*$/gm)].at(-1)?.[1];
        const reference = lastMapReference(code);
        if (!name || !reference?.startsWith('data:') || evaluated.has(name)) return;
        // No base URL: its sources are absolute paths or bundler names, kept as they are.
        try { evaluated.set(name, new AnyMap(JSON.parse(decodeDataUrl(reference)))); } catch {}
      },
    });
  }

  function folders(root) {
    if (!subfolders.has(root)) {
      let list = [];
      try {
        list = readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').map(entry => entry.name);
      } catch {}
      subfolders.set(root, list);
    }
    return subfolders.get(root);
  }

  // A source name from a map, in any bundler's notation, to a file on disk.
  function toFile(source, root) {
    let name = String(source);
    if (name.startsWith('file:')) { try { name = fileURLToPath(name); } catch {} }
    name = name.replace(/^webpack:\/\/[^/]*\//, '').replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, '')
      .replace(/^turbopack:\/\/\/\[project\]\//, '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    const library = name.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    if (library) return { file: name, project: false, library };
    const candidates = [];
    if (isAbsolute(name)) candidates.push(name);
    const bare = name.replace(/^(\.\.?\/)+/, '').replace(/^\//, '');
    candidates.push(join(root, bare));
    for (const folder of folders(root)) candidates.push(join(root, folder, bare));
    for (const candidate of candidates) {
      if (inside(root, candidate) && isFile(candidate)) {
        let real = candidate;
        try { real = realpathSync(candidate); } catch {}
        return { file: real, project: !real.split(sep).includes('node_modules') };
      }
    }
    return { file: name, project: false };
  }

  async function resolveFrame(frame, { origin, root, scripts: pageScripts = [] }) {
    if (!frame || !root) return { ...frame, resolved: false };
    // React 18 development builds already give the original file.
    if (frame.file && !frame.url) {
      const file = isAbsolute(frame.file) ? frame.file : join(root, frame.file);
      return { fn: frame.fn, file, line: frame.line, column: frame.column, resolved: true, project: inside(root, file) && isFile(file) };
    }
    let map = null;
    let url;
    try { url = new URL(frame.url); } catch {}
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
      if (!LOOPBACK.test(url.hostname) || (origin && url.origin !== origin)) return { ...frame, resolved: false };
      const loaded = await loadScript(url.href.replace(/#.*$/, ''));
      map = loaded?.map ?? null;
      // A script served exactly as it is on disk, with no map: same lines.
      if (!map && loaded?.text) {
        const { file, project } = toFile(url.pathname, root);
        if (project && sameText(file, loaded.text)) return { fn: frame.fn, file, line: frame.line, column: frame.column, project, resolved: true };
      }
    } else if (/^webpack-internal:/.test(frame.url ?? '')) {
      if (!evaluated.has(frame.url)) {
        for (const script of pageScripts) {
          let scriptUrl;
          try { scriptUrl = new URL(script); } catch { continue; }
          if (!LOOPBACK.test(scriptUrl.hostname) || (origin && scriptUrl.origin !== origin)) continue;
          await indexEvaluated(scriptUrl.href);
          if (evaluated.has(frame.url)) break;
        }
      }
      map = evaluated.get(frame.url) ?? null;
      if (!map) {
        // Without its map, the module is known but the line is not.
        const { file, project, library } = toFile(frame.url, root);
        return { fn: frame.fn, file, line: null, project, library, resolved: false };
      }
    }
    if (!map) return { ...frame, resolved: false };
    const original = originalPositionFor(map, { line: frame.line, column: Math.max(0, (frame.column ?? 1) - 1) });
    if (!original.source || original.line == null) return { ...frame, resolved: false };
    const { file, project, library } = toFile(original.source, root);
    // The stack gives the enclosing function; the map's name at that position
    // is the identifier being called there (for example "fetch").
    return { fn: frame.fn || original.name, file, line: original.line, column: original.column + 1, project, library, resolved: true };
  }

  async function resolveFrames(frames, context) {
    if (!Array.isArray(frames)) return [];
    return Promise.all(frames.map(frame => resolveFrame(frame, context)));
  }
  return { resolveFrames, resolveFrame };
}
