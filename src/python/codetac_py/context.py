"""The current node and the current request, like AsyncLocalStorage in the
Node runtime. Each thread and each asyncio task has its own context.

The value is a tuple (node, request, before, start, code):
- node: the number of the current call in this process, or None; request:
  the request id as a JSON literal, or 'null';
- before, start, code: for an ordinary function being run, the value to put
  back when it returns, its start time and its code object (capture.py keeps
  the state of a call here instead of in a table: it costs less per call).
  Generators and coroutines, which suspend, keep theirs in a table.

Keep it importable on old Pythons (3.8+): requests are recorded in the
minimal mode too.
"""
import contextvars

NULL = 'null'

current = contextvars.ContextVar('codetac_node', default=(None, NULL, None, 0, None))


# After the response of its request (BackgroundTasks, the close() of a WSGI
# body), the request's literal carries the mark: the writer puts the literal
# where it puts "requestId", so enter and exit events get
# "requestId":"…","afterResponse":true at no extra cost per call.
AFTER = ',"afterResponse":true'


def after_response(literal):
    return literal if literal == NULL or literal.endswith(AFTER) else literal + AFTER


def request_of(literal):
    """(request id or None, after the response) from a request literal."""
    if literal == NULL:
        return None, False
    after = literal.endswith(AFTER)
    if after:
        literal = literal[:-len(AFTER)]
    return literal[1:-1], after


def scope(node, request):
    """A value that only says where the calls that follow belong."""
    return (node, request, None, 0, None)


def request_scope(request_json):
    """Makes the calls that follow belong to a request; returns the token to reset."""
    return current.set(scope(current.get()[0], request_json))
