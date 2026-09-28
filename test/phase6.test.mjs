import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/store.mjs';
import { dataDirectory, install } from '../src/home.mjs';

test('pasta de dados: CODETAC_HOME, o checkout Git, ou ~/.codetac', () => {
  assert.equal(dataDirectory({ CODETAC_HOME: '/tmp/x' }), '/tmp/x');
  const expected = existsSync(join(install, '.git')) ? join(install, '.codetac') : join(homedir(), '.codetac');
  assert.equal(dataDirectory({}), expected);
});

test('numa instalação nova, o painel cria a pasta de dados', () => {
  const folder = join(tmpdir(), `codetac-home-${randomUUID()}`, '.codetac');
  const store = openStore(folder);
  assert.ok(existsSync(join(folder, 'codetac.db')));
  store.close();
  rmSync(join(folder, '..'), { recursive: true });
});

test('o pacote publicado só leva o código, o README e a licença', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  assert.ok(files.includes('src/cli.mjs') && files.includes('LICENSE') && files.includes('readme.md'));
  assert.deepEqual(files.filter(file => !file.startsWith('src/') && !['LICENSE', 'readme.md', 'package.json'].includes(file)), []);
});

test('comando: versão e relatório sem a pasta pessoal', () => {
  const version = spawnSync(process.execPath, ['src/cli.mjs', '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), JSON.parse(spawnSync('cat', ['package.json'], { encoding: 'utf8' }).stdout).version);
  const home = join(tmpdir(), `codetac-report-${randomUUID()}`);
  const report = spawnSync(process.execPath, ['src/cli.mjs', 'report', '.', '--panel-port', '4197'], { encoding: 'utf8', env: { ...process.env, CODETAC_HOME: home } });
  assert.match(report.stdout, /Report saved to/);
  assert.doesNotMatch(report.stdout, new RegExp(homedir().replace(/[/\\]/g, '\\$&') + '/'));
  rmSync(home, { recursive: true, force: true });
});

// The panel's page is a template literal: an escape that is valid there can
// break the script it produces (\' becomes '). Checked without importing
// panel.mjs, which would start a server.
test('painel: o script da página é JavaScript válido', () => {
  const source = readFileSync(join(install, 'src', 'panel.mjs'), 'utf8');
  const literal = source.slice(source.indexOf('const page = `') + 'const page = '.length, source.lastIndexOf('`;') + 1);
  const LABELS = {};
  const page = new Function('LABELS', `return ${literal};`)(LABELS);
  const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});
