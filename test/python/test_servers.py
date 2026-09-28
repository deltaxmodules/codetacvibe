"""Stage 3: supervisors (reloaders) are recognised and record nothing of their own."""
import os
import unittest

from helpers import Sandbox, write

WERKZEUG = '''
class BaseWSGIServer:
    def __init__(self, host, port, app):
        self.app = app


def run_simple(hostname, port, application, use_reloader=False, **options):
    BaseWSGIServer(hostname, port, application)
    return application()
'''

UVICORN = '''
class Config:
    def bind_socket(self):
        return 'socket'

    def load(self):
        self.loaded_app = None
'''


class Supervisors(Sandbox):
    def setUp(self):
        super().setUp()
        write(self.libs, 'werkzeug/__init__.py', '')
        write(self.libs, 'werkzeug/serving.py', WERKZEUG)
        write(self.libs, 'uvicorn/__init__.py', '')
        write(self.libs, 'uvicorn/config.py', UVICORN)

    def processes(self):
        found = {}
        for event in self.events():
            found.setdefault(event['process'], []).append(event)
        return found

    def test_pai_do_reloader_do_werkzeug(self):
        result = self.run_script('main.py', '''
import codetac_py
from werkzeug.serving import run_simple

def load_app():
    return 'app'

def watch():
    return 'a vigiar ficheiros'

load_app()
print(run_simple('127.0.0.1', 5000, watch, use_reloader=True), codetac_py.role)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'a vigiar ficheiros supervisor')
        events = self.events()
        names = [event['function'] for event in events if event['type'] == 'enter']
        self.assertEqual(names, ['load_app'])
        self.assertEqual(events[-1], {**events[-1], 'type': 'process', 'role': 'supervisor', 'server': 'werkzeug'})

    def test_filho_do_reloader_do_werkzeug_e_a_app(self):
        result = self.run_script('main.py', '''
import codetac_py
from werkzeug.serving import run_simple

def serve():
    return 'a servir'

print(run_simple('127.0.0.1', 5000, serve, True), codetac_py.role)
''', extra={'WERKZEUG_RUN_MAIN': 'true'})
        self.assertEqual(result.stdout.strip(), 'a servir app', result.stderr)
        self.assertEqual([event['function'] for event in self.events() if event['type'] == 'enter'], ['serve'])

    def test_sem_reloader_o_werkzeug_serve_e_e_a_app(self):
        result = self.run_script('main.py', '''
import codetac_py
from werkzeug.serving import run_simple

def serve():
    return 'a servir'

print(run_simple('127.0.0.1', 5000, serve), codetac_py.role)
''')
        self.assertEqual(result.stdout.strip(), 'a servir app', result.stderr)

    def test_supervisor_do_uvicorn_sem_codigo_do_projeto_nao_deixa_ficheiro(self):
        # uvicorn --reload: the supervisor never imports the app.
        result = self.run_python('import codetac_py\nfrom uvicorn.config import Config\nConfig().bind_socket()\nprint(codetac_py.role)', 'ensaio')
        self.assertEqual(result.stdout.strip(), 'supervisor')
        self.assertEqual(result.stderr, '')
        self.assertEqual(os.listdir(self.home), [])

    def test_modulo_fica_com_o_loader_verdadeiro(self):
        result = self.run_python('import werkzeug.serving as s\nprint(type(s.__loader__).__name__, type(s.__spec__.loader).__name__, s.run_simple.__name__)', 'ensaio')
        self.assertEqual(result.stdout.strip(), 'SourceFileLoader SourceFileLoader run_simple', result.stderr)

    @unittest.skipUnless(hasattr(os, 'fork'), 'sem os.fork')
    def test_worker_criado_por_fork_do_supervisor_volta_a_seguir_funcoes(self):
        # gunicorn: the arbiter supervises, the forked workers serve.
        result = self.run_script('main.py', '''
import os, sys, warnings
import codetac_py
from uvicorn.config import Config
warnings.simplefilter('ignore', DeprecationWarning)

def arbiter_work():
    return 1

def worker_work():
    return 2

Config().bind_socket()
arbiter_work()
pid = os.fork()
if pid == 0:
    worker_work()
    print('worker', codetac_py.role, flush=True)
    sys.exit(0)
os.waitpid(pid, 0)
print('arbiter', codetac_py.role)
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(result.stdout.split('\n')[:2]), ['arbiter supervisor', 'worker app'])
        names = [event['function'] for event in self.events() if event['type'] == 'enter']
        self.assertEqual(names, ['worker_work'])


class Helpers(Sandbox):
    def test_processo_que_nao_corre_codigo_do_projeto_nao_deixa_ficheiro(self):
        # multiprocessing's resource tracker, a spawned helper...
        result = self.run_python('import json\nprint(json.dumps({"a": 1}))', 'ensaio')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.listdir(self.home), [])


if __name__ == '__main__':
    unittest.main()
