"""Stage 3: parentage and durations in async code and threads (spec 3.2)."""
import unittest

from helpers import Sandbox


class Async(Sandbox):
    def scenario(self, source):
        result = self.run_script('main.py', source)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        exits = {event['id']: event for event in events if event['type'] == 'exit'}
        return self.calls(events), exits

    def test_await_encadeado_mantem_o_pai_depois_de_await(self):
        calls, exits = self.scenario('''
import asyncio

def leaf():
    return 1

async def inner():
    await asyncio.sleep(0.01)
    return leaf()

async def outer():
    first = await inner()
    await asyncio.sleep(0.01)
    return first + leaf()

asyncio.run(outer())
''')
        outer, inner = calls['outer'][0], calls['inner'][0]
        self.assertEqual(inner['parentId'], outer['id'])
        self.assertEqual([leaf['parentId'] for leaf in calls['leaf']], [inner['id'], outer['id']])
        self.assertTrue(outer['async'] and inner['async'])
        self.assertFalse(calls['leaf'][0]['async'])

    def test_duracao_async_inclui_as_esperas(self):
        calls, exits = self.scenario('''
import asyncio

async def wait():
    await asyncio.sleep(0.05)

asyncio.run(wait())
''')
        self.assertGreaterEqual(exits[calls['wait'][0]['id']]['durationNs'], 50_000_000)
        # One exit per call: the suspension is not an exit.
        self.assertEqual(len(exits), sum(len(items) for items in calls.values()))

    def test_gather_concorrente(self):
        calls, exits = self.scenario('''
import asyncio

def helper(name):
    return name

async def load(name, delay):
    await asyncio.sleep(delay)
    return helper(name)

async def page():
    return await asyncio.gather(load('a', 0.03), load('b', 0.01), load('c', 0.02))

asyncio.run(page())
''')
        page = calls['page'][0]
        loads = calls['load']
        self.assertEqual([load['parentId'] for load in loads], [page['id']] * 3)
        # Each helper belongs to the load that called it, though they finish in another order.
        self.assertEqual(sorted(helper['parentId'] for helper in calls['helper']), sorted(load['id'] for load in loads))
        durations = sorted(exits[load['id']]['durationNs'] for load in loads)
        self.assertGreaterEqual(durations[0], 10_000_000)
        self.assertGreaterEqual(durations[2], 30_000_000)

    def test_create_task_tem_como_pai_quem_o_criou(self):
        calls, _ = self.scenario('''
import asyncio

async def job():
    await asyncio.sleep(0)
    return work()

def work():
    return 1

async def start():
    return asyncio.create_task(job())

async def main():
    task = await start()
    await other()
    await task

async def other():
    await asyncio.sleep(0.01)

asyncio.run(main())
''')
        self.assertEqual(calls['job'][0]['parentId'], calls['start'][0]['id'])
        self.assertEqual(calls['work'][0]['parentId'], calls['job'][0]['id'])
        self.assertEqual(calls['other'][0]['parentId'], calls['main'][0]['id'])

    def test_threadpool_que_copia_o_contexto(self):
        # asyncio.to_thread and anyio (Starlette's def endpoints) copy the context.
        calls, _ = self.scenario('''
import asyncio, contextvars
from concurrent.futures import ThreadPoolExecutor

def blocking():
    return inside()

def inside():
    return 1

async def endpoint():
    await asyncio.to_thread(blocking)
    context = contextvars.copy_context()
    with ThreadPoolExecutor() as pool:
        await asyncio.get_running_loop().run_in_executor(pool, context.run, blocking)

asyncio.run(endpoint())
''')
        endpoint = calls['endpoint'][0]
        self.assertEqual([call['parentId'] for call in calls['blocking']], [endpoint['id']] * 2)
        self.assertEqual([call['parentId'] for call in calls['inside']], [call['id'] for call in calls['blocking']])

    def test_gerador_async_nao_e_pai_do_consumidor(self):
        calls, _ = self.scenario('''
import asyncio

def make(n):
    return n

def use(n):
    return n

async def items():
    for n in range(2):
        await asyncio.sleep(0)
        yield make(n)

async def consume():
    async for item in items():
        use(item)

asyncio.run(consume())
''')
        consume, items = calls['consume'][0], calls['items'][0]
        self.assertEqual(items['parentId'], consume['id'])
        self.assertEqual([call['parentId'] for call in calls['make']], [items['id']] * 2)
        self.assertEqual([call['parentId'] for call in calls['use']], [consume['id']] * 2)

    def test_erro_e_cancelamento_numa_corrotina(self):
        calls, exits = self.scenario('''
import asyncio

async def fails():
    await asyncio.sleep(0)
    raise ValueError('não gravar')

async def slow():
    await asyncio.sleep(5)

async def main():
    try:
        await fails()
    except ValueError:
        pass
    task = asyncio.create_task(slow())
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

asyncio.run(main())
''')
        self.assertTrue(exits[calls['fails'][0]['id']]['error'])
        # Stage 11 (M46): a cancelled coroutine is not an error of the app.
        self.assertFalse(exits[calls['slow'][0]['id']]['error'])
        self.assertFalse(exits[calls['main'][0]['id']]['error'])
        self.assertNotIn('não gravar', self.raw())


if __name__ == '__main__':
    unittest.main()
