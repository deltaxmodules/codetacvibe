"""Where the cost per call goes: sys.monitoring callbacks built up one piece at a time."""
import collections
import contextvars
import itertools
import json
import sys
import time

M = sys.monitoring
E = M.events
TOOL = 4
CALLS = int(sys.argv[1]) if len(sys.argv) > 1 else 300_000


def trivial(value):
    return value


def measure():
    trivial(0)
    start = time.perf_counter_ns()
    for index in range(CALLS):
        trivial(index)
    return (time.perf_counter_ns() - start) / CALLS


current = contextvars.ContextVar('c', default=(None, 'null', None, 0, None))
queue = collections.deque()
counter = itertools.count(1)
sequence = itertools.count(1)
now = time.perf_counter_ns
target = trivial.__code__
ENTER = '"function":"trivial","file":"/x/probe.py","line":8,"endLine":9,"column":1,"mapped":false,"async":false'
LINE = '{"version":1,"process":"1:0","sequence":%d,"timeNs":%d,"type":"enter","id":"1:0:%d","parentId":%s,"requestId":%s,%s}\n'


# The same steps as capture.py, added one at a time.
def variant(name):
    def start_empty(code, offset):
        if code is not target:
            return M.DISABLE

    def return_empty(code, offset, value):
        if code is not target:
            return M.DISABLE

    def start_context(code, offset):
        if code is not target:
            return M.DISABLE
        before = current.get()
        current.set((1, before[1], before, 0, code))

    def return_context(code, offset, value):
        if code is not target:
            return M.DISABLE
        state = current.get()
        if state[4] is code:
            current.set(state[2])

    def start_queue(code, offset):
        if code is not target:
            return M.DISABLE
        before = current.get()
        started = now()
        node = next(counter)
        queue.append((1, next(sequence), started, node, before[0], before[1], ENTER))
        current.set((node, before[1], before, started, code))

    def return_queue(code, offset, value):
        if code is not target:
            return M.DISABLE
        state = current.get()
        if state[4] is code:
            current.set(state[2])
            ended = now()
            queue.append((0, next(sequence), ended, state[0], state[1], 'false', ended - state[3]))

    def start_line(code, offset):
        if code is not target:
            return M.DISABLE
        before = current.get()
        started = now()
        node = next(counter)
        queue.append(LINE % (next(sequence), started, node, 'null', before[1], ENTER))
        current.set((node, before[1], before, started, code))

    def return_line(code, offset, value):
        if code is not target:
            return M.DISABLE
        state = current.get()
        if state[4] is code:
            current.set(state[2])
            ended = now()
            queue.append(LINE % (next(sequence), ended, state[0], 'null', state[1], ENTER))

    table = {'callbacks vazios': (start_empty, return_empty), '+ ContextVar': (start_context, return_context),
             '+ relógio, contadores e tuplo na fila (captor)': (start_queue, return_queue),
             'linha JSON no caminho do pedido (antes da etapa 5)': (start_line, return_line)}
    return table[name]


results = {'sem monitorização': measure()}
M.use_tool_id(TOOL, 'bench')
for name in ('callbacks vazios', '+ ContextVar', '+ relógio, contadores e tuplo na fila (captor)', 'linha JSON no caminho do pedido (antes da etapa 5)'):
    start, finish = variant(name)
    M.register_callback(TOOL, E.PY_START, start)
    M.register_callback(TOOL, E.PY_RETURN, finish)
    M.set_events(TOOL, E.PY_START | E.PY_RETURN)
    M.restart_events()
    results[name] = measure()
    M.set_events(TOOL, 0)
    queue.clear()
print(json.dumps({key: round(value, 1) for key, value in results.items()}, ensure_ascii=False))
