// Deteção de projetos Python pelo comando codetac (Etapa 12 Python), em pastas
// temporárias, sem ambientes virtuais nem Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectProject } from '../src/detect.mjs';
import { commandFor, declaredCommands, describePythonFolder, findApp, hasPythonSignals, moveTo, proxyOf, pythonPort, versionBelow } from '../src/detect-python.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'ctpydetect'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('Python: sinais, app e versão mínima', t => {
  const root = project({
    'requirements.txt': 'fastapi\nuvicorn\n',
    'app/main.py': 'from fastapi import FastAPI\n\napi: FastAPI = FastAPI(title="x")\n',
    'app/other.py': 'x = 1\n',
    'tests/test_main.py': 'app = FastAPI()\n',
    'factory/__init__.py': 'from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(hasPythonSignals(root), true);
  assert.equal(hasPythonSignals(join(root, 'app')), false);
  const app = findApp(root);
  assert.deepEqual([app.file, app.module, app.variable, app.framework], [join('app', 'main.py'), 'app.main', 'api', 'FastAPI']);
  const factory = findApp(join(root, 'factory'));
  assert.deepEqual([factory.module, factory.variable, factory.framework], ['__init__', 'create_app()', 'Flask']);
  assert.deepEqual([versionBelow('3.11.9'), versionBelow('3.12.0'), versionBelow('3.9.6'), versionBelow('3.14.1')], [true, false, true, false]);
});

test('Python: comandos declarados, só os de desenvolvimento e com o ficheiro presente', t => {
  const root = project({
    'main.py': 'from fastapi import FastAPI\nimport uvicorn\napp = FastAPI()\nif __name__ == "__main__":\n    uvicorn.run(app)\n',
    'init_data.py': 'import sqlite3\n',
    Procfile: 'web: uvicorn main:app --host 0.0.0.0 --port $PORT\nworker: celery -A tasks worker\n',
    Makefile: 'dev:\n\t@uv run uvicorn main:app --reload --port 8100\n',
    'README.md': '```bash\npip install -r requirements.txt\npython init_data.py 2026\nuvicorn other:app --reload\ngunicorn -w 4 main:app\npython main.py\n```\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = declaredCommands(root);
  assert.deepEqual(found.map(item => item.source), ['Procfile', 'Makefile (dev)', 'README']);
  assert.equal(found[1].command, 'uv run uvicorn main:app --reload --port 8100');
  assert.equal(found[2].command, 'python main.py');
});

test('Python: porta pelo comando, .env, ficheiro e omissões; comando com o interpretador do projeto', t => {
  const root = project({
    'app.py': 'from flask import Flask\napp = Flask(__name__)\nif __name__ == "__main__":\n    app.run(port=int(os.environ.get("PORT", "5055")))\n',
    '.flaskenv': 'FLASK_RUN_PORT=5077\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = findApp(root);
  assert.deepEqual(pythonPort(root, { command: 'uvicorn main:app --port 8123' }), { value: 8123, source: 'command' });
  assert.deepEqual(pythonPort(root, { command: 'flask', app }), { value: 5077, source: '.flaskenv' });
  rmSync(join(root, '.flaskenv'));
  assert.deepEqual(pythonPort(root, { command: 'python', app }), { value: 5055, source: 'app.py' });
  assert.deepEqual(pythonPort(root, { command: 'flask', app }), { value: 5000, source: 'Flask default' });
  assert.deepEqual(pythonPort(root, { command: 'uvicorn', framework: 'FastAPI' }), { value: 8000, source: 'uvicorn default' });

  const python = { interpreter: '/p/.venv/bin/python', app, how: 'flask', declared: null };
  assert.deepEqual(commandFor({ python }, 5001), ['/p/.venv/bin/python', '-m', 'flask', '--app', 'app', 'run', '--debug', '--port', '5001']);
  const declared = { interpreter: '/p/.venv/bin/python', declared: 'uv run uvicorn main:app --host 0.0.0.0 --port $PORT' };
  assert.deepEqual(commandFor({ python: declared }, 9001), ['/p/.venv/bin/python', '-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '9001']);
  // A known server declared without a port gets one; gunicorn gets --bind.
  const bare = { interpreter: '/p/.venv/bin/python', declared: 'uvicorn app.main:app --reload' };
  assert.deepEqual(commandFor({ python: bare }, 9004), ['/p/.venv/bin/python', '-m', 'uvicorn', 'app.main:app', '--reload', '--port', '9004']);
  const gunicorn = { interpreter: '/p/.venv/bin/python', declared: 'gunicorn -w 2 main:app' };
  assert.deepEqual(commandFor({ python: gunicorn }, 9005), ['/p/.venv/bin/python', '-m', 'gunicorn', '-w', '2', 'main:app', '--bind', '127.0.0.1:9005']);
  const fixed = { interpreter: '/p/.venv/bin/python', declared: 'fastapi dev main.py --port 8100' };
  assert.deepEqual(commandFor({ python: fixed }, 9002), ['/p/.venv/bin/python', '-m', 'fastapi', 'dev', 'main.py', '--port', '9002']);
  // python app.py: the port goes in the PORT variable.
  const plain = moveTo({ python: { interpreter: '/p/.venv/bin/python', app, how: 'python', declared: null }, command: [] }, 9003);
  assert.deepEqual([plain.command, plain.env.PORT, plain.port.value], [['/p/.venv/bin/python', 'app.py'], '9003', 9003]);
});

test('Python: sem ambiente, o arranque é o que terá depois de criado; avisos de -I e do granian', t => {
  const root = project({
    'requirements.txt': 'fastapi[standard]\n',
    'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const granian = project({ 'requirements.txt': 'granian\n', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n', Procfile: 'web: granian --interface asgi main:app\n' });
  const isolated = project({ 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\napp.run()\n', Procfile: 'web: python -I app.py\n' });
  t.after(() => [root, granian, isolated].forEach(folder => rmSync(folder, { recursive: true, force: true })));
  const part = describePythonFolder(root);
  assert.deepEqual([part.language, part.stack, part.installed, part.python.interpreter, part.server], ['python', 'FastAPI', false, null, 'uvicorn']);
  assert.deepEqual(part.command, ['python3', '-m', 'fastapi', 'dev', 'main.py', '--port', '8000']);
  assert.match(describePythonFolder(granian).notes.join(' '), /granian calls the app from Rust/);
  assert.match(describePythonFolder(isolated).notes.join(' '), /uses -I: with that option Python ignores PYTHONPATH/);
  writeFileSync(join(root, '.env.example'), 'DATABASE_URL=\n');
  assert.match(describePythonFolder(root).notes.join(' '), /has a \.env\.example but no \.env/);
  writeFileSync(join(root, '.env'), 'DATABASE_URL=x\n');
  assert.doesNotMatch(describePythonFolder(root).notes.join(' '), /\.env\.example/);
});

test('Stack mista: frontend Node e API Python arrancam juntos; o proxy do Vite e a sua variável', t => {
  const root = project({
    'web/package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^8' } }),
    'web/vite.config.js': "const api = `http://127.0.0.1:${process.env.API_PORT ?? 8000}`;\nexport default { server: { proxy: { '/api': { target: api } } } };\n",
    'api/requirements.txt': 'fastapi\n',
    'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const detected = detectProject(root);
  assert.deepEqual(detected.start.map(part => [part.part, part.language ?? 'node', part.stack]).sort(), [['api', 'python', 'FastAPI'], ['web', 'node', 'Vite']]);
  assert.deepEqual(detected.missing, []);
  assert.deepEqual(proxyOf(join(root, 'web')), { variables: [{ variable: 'API_PORT', port: 8000 }], literal: [] });
  writeFileSync(join(root, 'web/vite.config.js'), "export default { server: { proxy: { '/api': 'http://localhost:8000' } } };\n");
  assert.deepEqual(proxyOf(join(root, 'web')), { variables: [], literal: [8000] });
  // The configuration named with --config.
  mkdirSync(join(root, 'web/config'));
  writeFileSync(join(root, 'web/config/vite.config.ts'), "export default { server: { proxy: { '/api': 'http://127.0.0.1:8100' } } };\n");
  assert.deepEqual(proxyOf(join(root, 'web'), 'vite --config ./config/vite.config.ts'), { variables: [], literal: [8100] });
});

test('Frontend na raiz e API Python em backend/: arrancam os dois, salvo se o script da raiz já arranca o Python', t => {
  const root = project({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^8' } }),
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  const together = project({
    'package.json': JSON.stringify({ scripts: { dev: 'concurrently "vite" "cd backend && uvicorn main:app --reload"' } }),
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  t.after(() => [root, together].forEach(folder => rmSync(folder, { recursive: true, force: true })));
  assert.deepEqual(detectProject(root).start.map(part => [part.part, part.language ?? 'node']), [['.', 'node'], ['backend', 'python']]);
  assert.deepEqual(detectProject(together).start.map(part => [part.part, part.language ?? 'node']), [['.', 'node']]);
});

test('Deteção Node sem mudanças: um package.json com arranque ganha a um requirements.txt; um sem arranque não esconde a app Python', t => {
  const node = project({ 'package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }), 'server.js': '', 'requirements.txt': 'mkdocs\n' });
  const tooling = project({ 'package.json': JSON.stringify({ devDependencies: { tailwindcss: '^4' } }), 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
  t.after(() => [node, tooling].forEach(folder => rmSync(folder, { recursive: true, force: true })));
  const first = detectProject(node);
  assert.deepEqual([first.start.length, first.start[0].language, first.start[0].command], [1, undefined, ['npm', 'run', 'dev']]);
  const second = detectProject(tooling);
  assert.deepEqual([second.start.length, second.start[0].language, second.start[0].stack], [1, 'python', 'Flask']);
});
