"""Stage 2: functions of the project with lines, order and parentage (spec 3.2)."""
import os
import unittest

from helpers import CAPTOR, SRC, Sandbox, line_of, write

SERVICE = '''
def deco(function):
    def wrapper(*args):
        return function(*args)
    return wrapper


def validate(order):
    if not order:
        raise ValueError('password=segredo123 no pedido')
    return True


def price(order):
    return sum(item * 2 for item in order)


class Orders:
    def create(self, order):
        validate(order)
        return price(order)
'''

MAIN = '''
from shop.service import Orders, deco, validate


@deco
def handler(order):
    return Orders().create(order)


def safe():
    try:
        validate([])
    except ValueError:
        return 'recusado'


print(handler([1, 2]), safe())
'''


class Sequence(Sandbox):
    def test_handler_servico_funcao_com_as_linhas_do_codigo(self):
        service = write(self.project, 'shop/service.py', SERVICE)
        write(self.project, 'shop/__init__.py', '')
        result = self.run_script('main.py', MAIN)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '6 recusado')
        events = self.events()
        calls = self.calls(events)
        main = os.path.join(self.project, 'main.py')

        # The decorated handler: the line of `def`, not of the decorator.
        handler = calls['handler'][0]
        self.assertEqual((handler['file'], handler['line'], handler['endLine']), (main, line_of(main, 'def handler'), line_of(main, 'return Orders()')))
        self.assertEqual((handler['mapped'], handler['async'], handler['column']), (False, False, 1))
        # handler -> Orders.create -> validate, price -> <genexpr>; names without
        # "<locals>" (stage 11, M38).
        wrapper = calls['deco.wrapper'][0]
        create = calls['Orders.create'][0]
        self.assertEqual(handler['parentId'], wrapper['id'])
        self.assertEqual(create['parentId'], handler['id'])
        self.assertEqual((create['file'], create['line']), (service, line_of(service, 'def create')))
        validate, price = calls['validate'][0], calls['price'][0]
        self.assertEqual([validate['parentId'], price['parentId']], [create['id'], create['id']])
        self.assertLess(validate['sequence'], price['sequence'])
        self.assertEqual((validate['line'], price['line']), (line_of(service, 'def validate'), line_of(service, 'def price')))
        self.assertEqual(calls['generator expression in price'][0]['parentId'], price['id'])

        # Every enter has one exit, with the same id and the same request.
        exits = {event['id']: event for event in events if event['type'] == 'exit'}
        for event in events:
            if event['type'] == 'enter':
                self.assertIn(event['id'], exits)
                self.assertIsNone(event['requestId'])
                self.assertGreaterEqual(exits[event['id']]['durationNs'], 0)
        # Module bodies and class bodies are not functions.
        self.assertNotIn('<module>', calls)
        self.assertNotIn('Orders', calls)
        modules = {event['file']: event['functions'] for event in events if event['type'] == 'module'}
        self.assertEqual(modules[service], 6)
        self.assertEqual(modules[main], 2)
        self.assertEqual([event['sequence'] for event in events if event['process'] == events[0]['process']],
                         list(range(1, len(events) + 1)))

    def test_erro_marcado_sem_a_mensagem(self):
        write(self.project, 'shop/service.py', SERVICE)
        write(self.project, 'shop/__init__.py', '')
        result = self.run_script('main.py', MAIN)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        calls = self.calls(events)
        exits = {event['id']: event for event in events if event['type'] == 'exit'}
        failed = [call for call in calls['validate'] if exits[call['id']]['error']]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['parentId'], calls['safe'][0]['id'])
        self.assertFalse(exits[calls['safe'][0]['id']]['error'])
        text = self.raw()
        self.assertNotIn('segredo123', text)
        self.assertNotIn('ValueError', text)
        self.assertNotIn('no pedido', text)

    def test_generator_suspenso_nao_e_pai_do_que_corre_entre_yields(self):
        result = self.run_script('main.py', '''
            def step(n):
                return n

            def other():
                return 0

            def numbers():
                yield step(1)
                yield step(2)

            def main():
                for _ in numbers():
                    other()

            main()
        ''')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls(self.events())
        main, numbers = calls['main'][0], calls['numbers'][0]
        self.assertEqual(numbers['parentId'], main['id'])
        self.assertEqual([call['parentId'] for call in calls['step']], [numbers['id']] * 2)
        self.assertEqual([call['parentId'] for call in calls['other']], [main['id']] * 2)

    def test_cada_thread_tem_o_seu_contexto(self):
        result = self.run_script('main.py', '''
            import threading

            def work():
                return inner()

            def inner():
                return 1

            def main():
                thread = threading.Thread(target=work)
                thread.start()
                thread.join()

            main()
        ''')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls(self.events())
        self.assertIsNone(calls['work'][0]['parentId'])
        self.assertEqual(calls['inner'][0]['parentId'], calls['work'][0]['id'])


class ProjectFilter(Sandbox):
    def test_venv_e_dependencias_dentro_do_projeto_nao_sao_gravados(self):
        outside = {
            '.venv/lib/python3.12/site-packages/flaskish/app.py': 'def dispatch(f):\n    return f()\n',
            'env/lib/python3.12/site-packages/other.py': 'def other(f):\n    return f()\n',
            'env/bin/tool.py': 'def tool(f):\n    return f()\n',
            'venv/helper.py': 'def helper(f):\n    return f()\n',
            'vendor/site-packages/pkg.py': 'def pkg(f):\n    return f()\n',
            'frontend/node_modules/x/script.py': 'def script(f):\n    return f()\n',
            '.hidden/gen.py': 'def generated(f):\n    return f()\n',
            'lib/__pycache__/stray.py': 'def stray(f):\n    return f()\n',
        }
        for name, source in outside.items():
            write(self.project, name, source)
        # An environment with another name is known by its pyvenv.cfg.
        write(self.project, 'env/pyvenv.cfg', 'home = /usr/bin\n')
        folders = sorted({os.path.join(self.project, os.path.dirname(name)) for name in outside})
        result = self.run_script('main.py', '''
            import sys
            sys.path[:0] = %r
            from app import dispatch
            from other import other
            from tool import tool
            from helper import helper
            from pkg import pkg
            from script import script
            from gen import generated
            from stray import stray

            def view():
                return 1

            for runner in (dispatch, other, tool, helper, pkg, script, generated, stray):
                runner(view)
        ''' % folders)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        calls = self.calls(events)
        self.assertEqual(sorted(calls), ['view'])
        self.assertEqual(len(calls['view']), 8)
        # Library frames are skipped, so the project's function has no parent.
        self.assertEqual({call['parentId'] for call in calls['view']}, {None})
        files = {event['file'] for event in events if 'file' in event}
        self.assertEqual(files, {os.path.join(self.project, 'main.py')})

    def test_a_pasta_do_captor_nunca_e_observada(self):
        result = self.run_script('main.py', 'def f():\n    return 1\nf()\n', extra={'CODETAC_ROOT': os.path.dirname(SRC)})
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        self.assertFalse([event for event in events if event.get('file', '').startswith(CAPTOR)])

    def test_codigo_fora_da_raiz_e_codigo_gerado_nao_sao_gravados(self):
        write(self.libs, 'external.py', 'def external(f):\n    return f()\n')
        result = self.run_script('main.py', '''
            from external import external
            namespace = {}
            exec(compile('def made():\\n    return 1\\n', '<string>', 'exec'), namespace)

            def view():
                return namespace['made']()

            external(view)
        ''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(self.calls(self.events())), ['view'])


class ToolId(Sandbox):
    def test_sem_tool_id_livre_fica_em_modo_minimo_com_o_motivo(self):
        code = ('import os, sys\n'
                'sys.path.insert(0, %r)\n'
                'for tool in range(6):\n'
                '    try: sys.monitoring.use_tool_id(tool, "outra")\n'
                '    except ValueError: pass\n'
                'import codetac_py\n'
                'os.environ["CODETAC_RUN"] = "ensaio"\n'
                'codetac_py.start()\n'
                'print(codetac_py.level, "|", codetac_py.reason, "|", codetac_py.writer.start_event["reason"])' % SRC)
        result = self.run_python(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'minimo | another tool is already monitoring Python | another tool is already monitoring Python')

    def test_usa_outro_id_quando_o_preferido_esta_ocupado(self):
        code = ('import os, sys\n'
                'sys.path.insert(0, %r)\n'
                'sys.monitoring.use_tool_id(3, "outra")\n'
                'import codetac_py\n'
                'os.environ["CODETAC_RUN"] = "ensaio"\n'
                'codetac_py.start()\n'
                'print(codetac_py.level, codetac_py.monitor.tool, sys.monitoring.get_tool(3))' % SRC)
        result = self.run_python(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'normal 4 outra')

if __name__ == '__main__':
    unittest.main()
