import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Python captor's own tests (test/python, unittest from the standard
// library). They need Python 3.12 or later; without it they are skipped with
// the reason, never failed. CODETAC_PYTHON picks the interpreter.
const MINIMUM = [3, 12];
const root = fileURLToPath(new URL('../', import.meta.url));

function findPython() {
  const candidates = process.env.CODETAC_PYTHON ? [process.env.CODETAC_PYTHON]
    : ['python3.14', 'python3.13', 'python3.12', 'python3', 'python'];
  const found = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const version = probe.stdout.trim();
    const [major, minor] = version.split('.').map(Number);
    if (major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1])) return { python: candidate, version };
    found.push(`${candidate} é o ${version}`);
  }
  return { reason: `sem Python ${MINIMUM.join('.')} ou mais recente${found.length ? ` (${found.join(', ')})` : ''}: testes do captor Python ignorados` };
}

const { python, version, reason } = findPython();

test(`captor Python: testes unittest${python ? ` (Python ${version})` : ''}`, { skip: reason }, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODETAC_')));
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'test/python'], {
    cwd: root, encoding: 'utf8', env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 300_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\nOK/);
});

test('o pacote leva o captor Python sem o __pycache__', () => {
  const cache = join(root, 'src/python/codetac_py/__pycache__');
  const probe = join(cache, 'codetac-pack-probe.cpython-312.pyc');
  mkdirSync(cache, { recursive: true });
  writeFileSync(probe, '');
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
    const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
    assert.ok(files.includes('src/python/codetac_py/sitecustomize.py') && files.includes('src/python/codetac_py/__init__.py'));
    assert.deepEqual(files.filter(file => file.includes('__pycache__') || file.endsWith('.pyc')), []);
  } finally {
    rmSync(probe, { force: true });
  }
});

test('vetores de redação partilhados com o captor Python (lado Node)', async () => {
  const { createRedactor, isSensitiveName } = await import('../src/redact.mjs');
  const vectors = JSON.parse(readFileSync(join(root, 'test/vetores-redacao.json'), 'utf8'));
  const redact = createRedactor(vectors.env);
  for (const { entrada, saida } of vectors.casos) assert.deepEqual(redact(entrada), saida);
  const small = createRedactor(vectors.env, vectors.maxBytes);
  for (const { entrada, saida } of vectors.casosCurtos) assert.equal(small(entrada), saida);
  for (const { nome, sensivel } of vectors.nomes) assert.equal(isSensitiveName(nome), sensivel);
});

// The request event is written by hand here; servers.py emits it in stage 4.
test('eventos do captor Python entram no store.mjs sem ramos Python', { skip: reason }, async () => {
  const { openStore } = await import('../src/store.mjs');
  const folder = mkdtempSync(join(tmpdir(), 'ctpy'));
  const project = join(folder, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'service.py'), 'def total(items):\n    return sum(square(i) for i in items)\n\n\ndef square(x):\n    return x * x\n');
  writeFileSync(join(project, 'main.py'), [
    'import codetac_py',
    'from codetac_py import capture',
    'from service import total',
    '',
    'def handler():',
    '    return total([1, 2])',
    '',
    'writer = codetac_py.writer',
    'writer.emit({"type": "request", "requestId": "py:r1", "parentId": None, "method": "GET", "path": "/soma", "queryKeys": [], "at": 1})',
    'scope = capture.request_scope(\'"py:r1"\')',
    'handler()',
    'capture.current.reset(scope)',
    'writer.emit({"type": "request-end", "requestId": "py:r1", "status": 200, "aborted": False, "durationNs": 1000})',
    '',
  ].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODETAC_') && key !== 'PYTHONPATH'));
  const result = spawnSync(python, ['main.py'], { cwd: project, encoding: 'utf8', env: { ...env,
    PYTHONPATH: join(root, 'src/python/codetac_py'), CODETAC_RUN: 'py-ingestao', CODETAC_HOME: join(folder, 'home'), CODETAC_ROOT: project } });
  assert.equal(result.status, 0, result.stderr);
  const store = openStore(join(folder, 'home'));
  try {
    store.ingest();
    const dossier = store.dossier('py:r1');
    const real = realpathSync(project);
    assert.equal(dossier.level, 'normal');
    assert.equal(dossier.root, real);
    assert.equal(dossier.request.status, 200);
    assert.deepEqual(dossier.steps.map(step => [step.function, step.depth, step.line, step.file, step.finished, step.error]), [
      ['handler', 0, 5, join(real, 'main.py'), true, false],
      ['total', 1, 1, join(real, 'service.py'), true, false],
      ['generator expression in total', 2, 2, join(real, 'service.py'), true, false],
      ['square', 3, 5, join(real, 'service.py'), true, false],
      ['square', 3, 5, join(real, 'service.py'), true, false],
    ]);
    assert.ok(store.recordedFile('py-ingestao', join(real, 'service.py')));
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

// Stage 5: the minimal mode, with its reason, as the dossier shows it. The
// app answers one request through wsgiref (standard library).
const MINIMAL_APP = [
  'import os, sys, threading, urllib.request',
  'from wsgiref.simple_server import make_server, WSGIRequestHandler',
  'if os.environ.get("OCUPAR_TOOL_IDS"):',
  '    for tool in range(6):',
  '        try: sys.monitoring.use_tool_id(tool, "outra")',
  '        except ValueError: pass',
  '    import codetac_py',
  '    os.environ["CODETAC_RUN"] = os.environ.pop("RUN_DEPOIS")',
  '    codetac_py.start()',
  'class Quiet(WSGIRequestHandler):',
  '    def log_message(self, *args): pass',
  'def view():',
  '    return [b"ok"]',
  'def app(environ, start_response):',
  '    start_response("200 OK", [("Content-Type", "text/plain")])',
  '    return view()',
  'server = make_server("127.0.0.1", 0, app, handler_class=Quiet)',
  'threading.Thread(target=server.serve_forever, daemon=True).start()',
  'urllib.request.urlopen("http://127.0.0.1:%d/pagina" % server.server_address[1]).read()',
  'server.shutdown()',
  '',
].join('\n');

function oldPython() {
  for (const candidate of ['/usr/bin/python3', 'python3.11', 'python3.10', 'python3.9']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 12))'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'False') return candidate;
  }
  return null;
}

test('modo mínimo: o motivo aparece no dossier (arranque, tool id, Python antigo)', { skip: reason }, async () => {
  const { openStore } = await import('../src/store.mjs');
  const folder = mkdtempSync(join(tmpdir(), 'ctpy'));
  const project = join(folder, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'main.py'), MINIMAL_APP);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODETAC_') && key !== 'PYTHONPATH'));
  const base = { ...env, PYTHONPATH: join(root, 'src/python/codetac_py'), CODETAC_HOME: join(folder, 'home'), CODETAC_ROOT: project };
  const old = oldPython();
  const cases = [
    { run: 'py-minimo-arranque', python, env: { CODETAC_RUN: 'py-minimo-arranque', CODETAC_LEVEL: 'minimo', CODETAC_MINIMO_MOTIVO: 'a app não arrancou com a captura completa' },
      reason: 'a app não arrancou com a captura completa' },
    { run: 'py-minimo-tool', python, env: { OCUPAR_TOOL_IDS: '1', RUN_DEPOIS: 'py-minimo-tool', PYTHONPATH: join(root, 'src/python') },
      reason: 'another tool is already monitoring Python' },
    ...(old ? [{ run: 'py-minimo-antigo', python: old, env: { CODETAC_RUN: 'py-minimo-antigo' }, reason: /^Python 3\.\d+ cannot follow the functions \(3\.12 or newer is needed\)$/ }] : []),
  ];
  const store = openStore(join(folder, 'home'));
  try {
    for (const item of cases) {
      const result = spawnSync(item.python, ['main.py'], { cwd: project, encoding: 'utf8', env: { ...base, ...item.env } });
      assert.equal(result.status, 0, result.stderr);
      store.ingest();
      const [request] = store.listRequests({ run: item.run });
      assert.ok(request, `${item.run}: sem pedido gravado`);
      const dossier = store.dossier(request.requestId);
      assert.equal(dossier.level, 'minimo', item.run);
      if (item.reason instanceof RegExp) assert.match(dossier.reason, item.reason);
      else assert.equal(dossier.reason, item.reason);
      assert.equal(dossier.request.path, '/pagina');
      assert.equal(dossier.request.status, 200);
      assert.deepEqual(dossier.steps, [], `${item.run}: em modo mínimo não se seguem funções`);
    }
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('vetores de HTTP e IA partilhados com o captor Python (lado Node)', async () => {
  const { classifyHttp, aiRequestDetails, aiResponseDetails } = await import('../src/boundaries.mjs');
  const vectors = JSON.parse(readFileSync(join(root, 'test/vetores-http.json'), 'utf8'));
  const plain = value => JSON.parse(JSON.stringify(value));
  for (const { entrada, saida } of vectors.classificacao) assert.deepEqual(plain(classifyHttp(entrada)), saida);
  for (const { entrada, saida } of vectors.pedidosIA) assert.deepEqual(plain(aiRequestDetails(entrada)), saida);
  for (const { entrada, saida } of vectors.respostasIA) assert.deepEqual(plain(aiResponseDetails(entrada)), saida);
});

test('vetores de SQL partilhados com o captor Python (lado Node)', async () => {
  const { describeSql } = await import('../src/boundaries.mjs');
  const vectors = JSON.parse(readFileSync(join(root, 'test/vetores-sql.json'), 'utf8'));
  for (const { entrada, saida } of vectors.casos) assert.deepEqual(describeSql(entrada), saida);
});
