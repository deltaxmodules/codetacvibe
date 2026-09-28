"""Stage 1: the captor loads without changing the app (spec 3.1)."""
import json
import os
import shutil
import subprocess
import unittest

from helpers import CAPTOR, SRC, Sandbox, listing, write


class SiteCustomize(Sandbox):
    def test_encadeia_o_sitecustomize_da_app(self):
        write(self.libs, 'sitecustomize.py', 'import sys\nsys.ORIGINAL_RAN = True\nMARK = "original"\n')
        for run in (None, 'ensaio'):
            with self.subTest(CODETAC_RUN=run):
                result = self.run_python('import sys, sitecustomize\nprint(sys.ORIGINAL_RAN, sitecustomize.MARK)', run)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'True original')

    def test_usercustomize_continua_a_carregar(self):
        write(self.libs, 'usercustomize.py', 'import sys\nsys.USER_RAN = True\n')
        result = self.run_python('import site, sys\nprint(site.ENABLE_USER_SITE, getattr(sys, "USER_RAN", False))', 'ensaio')
        self.assertEqual(result.returncode, 0, result.stderr)
        enabled, ran = result.stdout.split()
        if enabled != 'True':
            self.skipTest('este Python não carrega usercustomize (ENABLE_USER_SITE falso)')
        self.assertEqual(ran, 'True')

    def test_erro_no_sitecustomize_da_app_e_tratado_como_sem_codetac(self):
        write(self.libs, 'sitecustomize.py', 'raise RuntimeError("falha da app")\n')
        result = self.run_python('print("app corre")', 'ensaio')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), 'app corre')
        self.assertIn('Error in sitecustomize', result.stderr)
        self.assertIn('RuntimeError: falha da app', result.stderr)

    def test_sem_sitecustomize_da_app_nada_falha(self):
        result = self.run_python('import sys\nprint("sitecustomize" in sys.modules)', 'ensaio')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')

    def test_modulos_do_captor_nao_escondem_os_da_app(self):
        for name in ('capture', 'page', 'redact', 'servers', 'writer', 'detail', 'boundaries'):
            write(self.libs, name + '.py', 'OWNER = "app"\n')
        code = ('import os, sys, capture, page, redact, servers, writer, detail, boundaries\n'
                'print({m.OWNER for m in (capture, page, redact, servers, writer, detail, boundaries)})\n'
                'print(any(os.path.realpath(p or ".") == %r for p in sys.path))' % CAPTOR)
        for run in (None, 'ensaio'):
            with self.subTest(CODETAC_RUN=run):
                result = self.run_python(code, run)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split('\n')[:2], ["{'app'}", 'False'])

    def test_sem_codetac_run_nao_faz_nada(self):
        before = (listing(self.project), listing(self.home))
        result = self.run_python('import sys\nprint("codetac_py" in sys.modules)')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'False')
        self.assertEqual((listing(self.project), listing(self.home)), before)
        self.assertEqual(before, ([], []))

    def test_com_codetac_run_grava_so_na_pasta_de_dados(self):
        result = self.run_python('import codetac_py\nprint(codetac_py.level, codetac_py.reason)', 'ensaio')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'normal None')
        # Nothing of the project ran: capture-start waits, and no file is left.
        self.assertEqual((listing(self.project), listing(self.home)), ([], []))

    def test_modo_minimo_pedido(self):
        result = self.run_python('import codetac_py\nprint(codetac_py.level, "|", codetac_py.reason)', 'ensaio',
                                 extra={'CODETAC_LEVEL': 'minimo', 'CODETAC_MINIMO_MOTIVO': 'pedido com --minimo'})
        self.assertEqual(result.stdout.strip(), 'minimo | pedido com --minimo')


def old_python():
    """A Python below the minimum on this machine, to prove the fallback for real."""
    for candidate in ('/usr/bin/python3', shutil.which('python3.11'), shutil.which('python3.10'), shutil.which('python3.9')):
        if candidate and os.path.exists(candidate):
            probe = subprocess.run([candidate, '-c', 'import sys; print(sys.version_info >= (3, 12))'],
                                   capture_output=True, text=True)
            if probe.stdout.strip() == 'False':
                return candidate
    return None


class OldPython(Sandbox):
    def test_python_antigo_fica_em_modo_minimo_com_o_motivo(self):
        python = old_python()
        if not python:
            self.skipTest('não há nenhum Python abaixo de 3.12 nesta máquina')
        write(self.libs, 'sitecustomize.py', 'MARK = "original"\n')
        result = self.run_python('import sys, sitecustomize, codetac_py\n'
                                 'print(sitecustomize.MARK, codetac_py.level)\nprint(codetac_py.reason)', 'ensaio', python)
        self.assertEqual(result.returncode, 0, result.stderr)
        first, reason = result.stdout.strip().split('\n')
        self.assertEqual(first, 'original minimo')
        self.assertRegex(reason, r'^Python 3\.\d+ cannot follow the functions \(3\.12 or newer is needed\)$')

    def test_decisao_de_nivel_abaixo_do_minimo(self):
        # Without CODETAC_RUN at startup, then started by hand under a simulated old version.
        code = ('import os, sys, json, glob\n'
                'sys.path.insert(0, %r)\n'
                'import codetac_py\n'
                'sys.version_info = (3, 11, 9)\n'
                'os.environ["CODETAC_RUN"] = "ensaio"\n'
                'codetac_py.start()\n'
                'print(codetac_py.level, "|", codetac_py.reason)\n'
                'print(json.dumps(codetac_py.writer.start_event))' % SRC)
        result = self.run_python(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary, start = result.stdout.strip().split('\n')
        self.assertEqual(summary, 'minimo | Python 3.11 cannot follow the functions (3.12 or newer is needed)')
        start = json.loads(start)
        self.assertEqual((start['type'], start['level']), ('capture-start', 'minimo'))
        self.assertIn('Python 3.11', start['reason'])

if __name__ == '__main__':
    unittest.main()
