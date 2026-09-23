// Minimal Chrome DevTools Protocol driver for the acceptance scripts: real
// mouse and keyboard events (isTrusted), console errors, layout snapshots.
// Uses the Chrome installed on the machine; nothing is downloaded.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const CANDIDATES = [
  process.env.CODETAC_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export async function launchChrome({ headless = true, width = 1280, height = 900, scratch = tmpdir() } = {}) {
  const executable = CANDIDATES.find(path => existsSync(path));
  if (!executable) throw new Error('Chrome não encontrado (defina CODETAC_CHROME).');
  const profile = mkdtempSync(join(scratch, 'codetac-chrome-'));
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-sync', '--password-store=basic', '--use-mock-keychain',
    `--window-size=${width},${height}`, ...(headless ? ['--headless=new'] : []), 'about:blank'];
  const child = spawn(executable, args, { stdio: 'ignore', detached: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const started = Date.now();
  while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() - started > 20000) throw new Error('Chrome não abriu a porta de depuração.');
    await delay(100);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.onmessage = message => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      const { ok, fail } = waiting.get(data.id);
      waiting.delete(data.id);
      data.error ? fail(new Error(`${data.error.message} ${data.error.data ?? ''}`)) : ok(data.result);
    } else if (data.method) for (const listener of listeners) listener(data);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const number = ++id;
    waiting.set(number, { ok, fail });
    socket.send(JSON.stringify({ id: number, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  // Each page gets its own browser context: no cookies or storage shared
  // between runs (localhost cookies are shared across ports).
  async function newPage() {
    const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const errors = [];
    let loads = 0;
    listeners.add(event => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Page.loadEventFired') loads++;
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails;
        errors.push({ kind: 'exceção', text: details.exception?.description?.split('\n')[0] ?? details.text });
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        errors.push({ kind: 'console.error', text: event.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 300) });
      }
      if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        errors.push({ kind: 'log', text: `${event.params.entry.text} ${event.params.entry.url ?? ''}`.slice(0, 300) });
      }
    });
    await call('Page.bringToFront');
    await call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    async function evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    }
    async function waitFor(expression, timeout = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try { if (await evaluate(`Boolean(${expression})`)) return true; } catch {}
        await delay(100);
      }
      throw new Error(`Tempo esgotado à espera de: ${expression}`);
    }
    async function goto(url, timeout = 90000) {
      const before = loads;
      await call('Page.navigate', { url });
      const start = Date.now();
      while (loads === before) {
        if (Date.now() - start > timeout) throw new Error(`Página não carregou: ${url}`);
        await delay(100);
      }
    }
    async function center(selector) {
      const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
        e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) throw new Error(`Elemento não encontrado: ${selector}`);
      return box;
    }
    async function click(selector) {
      const { x, y } = await center(selector);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    async function type(selector, text) {
      await click(selector);
      await call('Input.insertText', { text });
    }
    // Position and size of every element of the page, except CodeTAC's own.
    function layout() {
      return evaluate(`(() => { const out = []; let i = 0;
        for (const e of document.querySelectorAll('body *')) {
          // Elements that are never drawn (scripts, styles…) are left out: a
          // streamed page may split its data into a different number of scripts.
          if (e.closest('codetac-bar') || e.matches('script, style, link, meta, template, noscript')) continue;
          const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
          out.push([i++, e.tagName, Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2, s.display, s.visibility]);
        }
        return { count: out.length, items: out, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] }; })()`);
    }
    async function screenshot() {
      return Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    }
    return { call, evaluate, waitFor, goto, click, type, layout, screenshot, errors };
  }

  async function close() {
    try { await send('Browser.close'); } catch {}
    await Promise.race([new Promise(ok => child.once('exit', ok)), delay(3000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  return { newPage, close };
}
