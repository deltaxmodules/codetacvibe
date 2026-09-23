import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createResolver } from '../src/origins.mjs';

// A fake project on disk and a fake development server (fetchText).
function project(files) {
  const root = resolve('.codetac', `test-${randomUUID()}-origens`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}
const origin = 'http://127.0.0.1:3000';
const inline = map => `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
// Generated line 1 → original line 3 (mapping "AAEA": column 0, source 0, line +2, column 0).
const oneLine = source => ({ version: 3, sources: [source], names: [], mappings: 'AAEA' });

test('script com mapa separado (Turbopack, Vite): posição original no ficheiro do projeto', async () => {
  const root = project({ 'app/login/page.tsx': 'a\nb\nfunction handleLogin() {}\n' });
  const served = {
    [`${origin}/_next/static/chunks/page.js`]: 'handleLogin();\n//# sourceMappingURL=page.js.map',
    [`${origin}/_next/static/chunks/page.js.map`]: JSON.stringify(oneLine('turbopack:///[project]/app/login/page.tsx')),
  };
  const resolver = createResolver({ fetchText: async url => served[url] });
  const [frame] = await resolver.resolveFrames([{ fn: 'handleLogin', url: `${origin}/_next/static/chunks/page.js`, line: 1, column: 1 }], { origin, root });
  assert.equal(frame.file, join(root, 'app/login/page.tsx'));
  assert.equal(frame.line, 3);
  assert.equal(frame.project, true);
  assert.equal(frame.fn, 'handleLogin');
});

test('código em eval com Trusted Types (webpack do Next.js): usa o último sourceURL e caminhos absolutos', async () => {
  const root = project({ 'app/page.tsx': 'a\nb\nc\n' });
  const code = `x();\n//# sourceURL=[module]\n${inline(oneLine(join(root, 'app/page.tsx')))}\n//# sourceURL=webpack-internal:///(app-pages-browser)/./app/page.tsx\n`;
  const chunk = `(self.chunks = []).push({ "m": function () { eval(__webpack_require__.ts(${JSON.stringify(code)})); } });`;
  const resolver = createResolver({ fetchText: async url => url === `${origin}/_next/static/chunks/app/page.js` ? chunk : '' });
  const [frame] = await resolver.resolveFrames([{ fn: 'Page', url: 'webpack-internal:///(app-pages-browser)/./app/page.tsx', line: 1, column: 1 }],
    { origin, root, scripts: [`${origin}/_next/static/chunks/app/page.js`] });
  assert.equal(frame.file, join(root, 'app/page.tsx'));
  assert.equal(frame.line, 3);
  assert.equal(frame.project, true);
});

test('script servido tal como está no disco, sem mapa: mesma linha; conteúdo diferente não é resolvido', async () => {
  const text = 'function save() {}\nsave();\n';
  const root = project({ 'public/app.js': text, 'old.js': 'outro conteúdo' });
  const served = { [`${origin}/public/app.js`]: text, [`${origin}/old.js`]: 'conteúdo mudado' };
  const resolver = createResolver({ fetchText: async url => served[url] });
  const [same, changed] = await resolver.resolveFrames([
    { fn: 'save', url: `${origin}/public/app.js`, line: 2, column: 1 },
    { fn: 'x', url: `${origin}/old.js`, line: 1, column: 1 },
  ], { origin, root });
  assert.equal(same.file, join(root, 'public/app.js'));
  assert.equal(same.line, 2);
  assert.equal(changed.resolved, false);
});

test('bibliotecas, outras origens e ficheiros fora do projeto não são tomados como código do projeto', async () => {
  const root = project({ 'src/a.ts': 'a\nb\nc\n' });
  const served = {
    [`${origin}/lib.js`]: `f();\n${inline(oneLine('webpack://_N_E/./node_modules/react-router/dist/index.js'))}`,
    [`${origin}/fora.js`]: `f();\n${inline(oneLine('/etc/passwd'))}`,
  };
  let fetched = 0;
  const resolver = createResolver({ fetchText: async url => { fetched++; return served[url]; } });
  const [library, outside, remote] = await resolver.resolveFrames([
    { url: `${origin}/lib.js`, line: 1, column: 1 },
    { url: `${origin}/fora.js`, line: 1, column: 1 },
    { url: 'https://cdn.example.com/x.js', line: 1, column: 1 },
  ], { origin, root });
  assert.equal(library.project, false);
  assert.equal(library.library, 'react-router');
  assert.equal(outside.project, false);
  assert.equal(remote.resolved, false);
  assert.equal(fetched, 2, 'nunca pede scripts a outras origens');
});
