"""Stage 9: the validation of a FastAPI request body as an opaque step, and
boundaries after the response marked."""
import json
import unittest

from helpers import Sandbox, write

# fastapi.dependencies.utils as FastAPI has it: solve_dependencies looks up
# request_body_to_args in its module at each call.
FAKE_FASTAPI = '''
async def request_body_to_args(body_fields, received_body, embed_body_fields):
    errors = []
    values = {}
    for field in body_fields:
        if field not in received_body:
            errors.append({'loc': ('body', field), 'type': 'missing'})
        else:
            values[field] = received_body[field]
            for check in body_fields[field]:
                check(values[field])
    return values, errors


async def solve_dependencies(body_fields, body):
    return await request_body_to_args(body_fields=body_fields, received_body=body, embed_body_fields=False)
'''

APP = '''
import asyncio, json
from codetac_py.context import current
from codetac_py.servers import Unit
from fastapi.dependencies.utils import solve_dependencies

def title_not_empty(value):
    return bool(value.strip())

async def endpoint(values):
    return values

async def handle(body):
    unit = Unit('POST', '/notes')
    token = unit.enter()
    try:
        values, errors = await solve_dependencies({'title': [title_not_empty]}, body)
        if not errors:
            await endpoint(values)
        return len(errors)
    finally:
        current.reset(token)
        unit.end(False)

async def main():
    print(json.dumps([await handle({'title': 'valor-do-titulo'}), await handle({'outro': 1})]))

asyncio.run(main())
'''


class Validation(Sandbox):
    def setUp(self):
        super().setUp()
        write(self.libs, 'fastapi/__init__.py', '')
        write(self.libs, 'fastapi/dependencies/__init__.py', '')
        write(self.libs, 'fastapi/dependencies/utils.py', FAKE_FASTAPI)

    def test_passo_opaco_da_validacao(self):
        result = self.run_script('main.py', APP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [0, 1])
        events = self.events()
        requests = [event['requestId'] for event in events if event['type'] == 'request']
        steps = self.calls(events)['request validation (not observable)']
        self.assertEqual([step['requestId'] for step in steps], requests)
        first = steps[0]
        self.assertEqual({key: first[key] for key in ('file', 'line', 'endLine', 'mapped', 'opaque')},
                         {'file': None, 'line': None, 'endLine': None, 'mapped': False, 'opaque': True})
        self.assertEqual(first['parentId'], self.calls(events)['handle'][0]['id'])
        # Validators of the project run inside it; the endpoint comes after it.
        self.assertEqual(self.calls(events)['title_not_empty'][0]['parentId'], first['id'])
        self.assertEqual(self.calls(events)['endpoint'][0]['parentId'], self.calls(events)['handle'][0]['id'])
        exits = {event['id']: event for event in events if event['type'] == 'exit'}
        # A body that fails validation (422) marks the step as an error.
        self.assertEqual([exits[step['id']]['error'] for step in steps], [False, True])
        self.assertNotIn('valor-do-titulo', self.raw())

    def test_modo_minimo_sem_passo(self):
        result = self.run_script('main.py', APP, extra={'CODETAC_LEVEL': 'minimo'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse([event for event in self.events() if event['type'] == 'enter'])


BOUNDARY_AFTER = '''
import json
from codetac_py.boundaries import start_boundary
from codetac_py.context import current
from codetac_py.servers import Unit

unit = Unit('POST', '/notes')
token = unit.enter()
start_boundary({'kind': 'base-de-dados', 'operation': 'INSERT', 'tables': ['notes']})()
unit.end(False)
unit.enter_after()
start_boundary({'kind': 'base-de-dados', 'operation': 'INSERT', 'tables': ['audit']})()
current.reset(token)
'''


class AfterResponse(Sandbox):
    def test_fronteira_depois_da_resposta(self):
        result = self.run_script('main.py', BOUNDARY_AFTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        boundaries = [event for event in self.events() if event['type'] == 'boundary']
        self.assertEqual([(event['tables'], event.get('afterResponse')) for event in boundaries], [(['notes'], None), (['audit'], True)])
        self.assertEqual(len({event['requestId'] for event in boundaries}), 1)


if __name__ == '__main__':
    unittest.main()
