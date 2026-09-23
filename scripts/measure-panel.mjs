// Aceitação da Fase 3: abre dossiers no painel com o Chrome real, mede se a
// vista agrupada cabe num ecrã e guarda uma captura de cada um.
// Uso: node scripts/measure-panel.mjs <painel> <pasta das capturas> action:<id>|request:<id>…
// O painel tem de estar a correr. Espera pelas frases da IA quando há modelo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './lib/chrome.mjs';

const [panel, out, ...targets] = process.argv.slice(2);
if (!panel || !out || !targets.length) {
  console.error('Uso: node scripts/measure-panel.mjs http://127.0.0.1:4010 <pasta> action:<id> request:<id>…');
  process.exit(2);
}
const WIDTH = 1280;
const HEIGHT = 900;
mkdirSync(out, { recursive: true });
const chrome = await launchChrome({ width: WIDTH, height: HEIGHT });
const results = [];
try {
  for (const target of targets) {
    const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    const page = await chrome.newPage();
    await page.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${panel}/?embed=1&${kind}=${encodeURIComponent(id)}`);
    try { await page.waitFor(`!!document.querySelector('section.effects')`, 90000); }
    catch (error) {
      const html = await page.evaluate(`document.getElementById('detail')?.innerHTML.slice(0, 400) ?? document.body.innerHTML.slice(0, 400)`);
      throw new Error(`${target}: ${error.message}\nPágina: ${html}\nErros: ${JSON.stringify(page.errors).slice(0, 1000)}`);
    }
    // With a model, wait until every sentence has been written (or failed).
    await page.waitFor(`(() => { const t = document.getElementById('ai')?.textContent || ''; return t && !t.startsWith('A escrever'); })()`, 600000);
    const measure = await page.evaluate(`(() => {
      const detail = document.getElementById('detail');
      const effects = document.querySelector('section.effects');
      const top = detail.querySelector('h2').getBoundingClientRect().top + detail.scrollTop;
      const bottom = effects.getBoundingClientRect().bottom + detail.scrollTop;
      const rows = [...detail.querySelectorAll('.step, .cross')].filter(e => e.offsetParent !== null).length;
      const all = detail.querySelectorAll('.step').length;
      return { height: Math.round(bottom - top), rows, all, ai: document.getElementById('ai').textContent,
        summary: document.querySelector('.summary')?.textContent ?? null, title: detail.querySelector('h2').textContent,
        ia: detail.querySelectorAll('.src-ia:not(.src-rej)').length, rejected: [...detail.querySelectorAll('.src-rej')].map(e => e.title) };
    })()`);
    const file = join(out, `${kind}-${id.replace(/[^\w.-]/g, '_')}.png`);
    writeFileSync(file, await page.screenshot());
    results.push({ target, ...measure, fits: measure.height <= HEIGHT, screenshot: file, consoleErrors: page.errors.length });
    await page.call('Page.close').catch(() => {});
  }
} finally {
  await chrome.close();
}
console.log(JSON.stringify(results, null, 2));
