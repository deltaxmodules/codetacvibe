"""Batched JSONL writer, with the same format and policy as src/runtime.mjs.

Events are queued and written every 25 ms by a daemon thread. Adding an
event is a single deque append, and the enter/exit events of the capture are
queued as tuples of values and turned into JSON lines in the batch (stage 5):
formatting was most of the cost per call, and in a web app the batch is
written while the app waits. The order inside a file is the order of
`sequence`. The queue is flushed at exit and on SIGINT/SIGTERM/SIGHUP; a
SIGKILL or os._exit loses the last 25 ms. At exit the thread is stopped and
joined before the last flush: a daemon thread that wakes while the
interpreter shuts down crashed CPython 3.12 (SIGSEGV in take_gil, stage 8;
the M71 failure of stage 7).

CodeTAC's own batches are written with os.open/os.write/os.close, so they
never appear as file writes of the app.

Keep it importable on old Pythons (3.8+): the minimal mode uses it too.
"""
import atexit
import collections
import itertools
import json
import os
import signal
import sys
import threading
import time

from .redact import create_redactor

FLUSH_SECONDS = 0.025
INSTALL = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
RUN_NAME = r'^[a-zA-Z0-9_-]{1,80}$'


def data_directory(env=None):
    """Same order as src/home.mjs: CODETAC_HOME, the Git checkout, ~/.codetac."""
    env = os.environ if env is None else env
    if env.get('CODETAC_HOME'):
        return os.path.abspath(env['CODETAC_HOME'])
    if os.path.exists(os.path.join(INSTALL, '.git')):
        return os.path.join(INSTALL, '.codetac')
    return os.path.join(os.path.expanduser('~'), '.codetac')


class Writer(object):
    def __init__(self, directory, flush_seconds=FLUSH_SECONDS):
        self.directory = directory  # created with the first batch
        self.flush_seconds = flush_seconds
        self.redact = create_redactor()
        self.disabled = False
        self.start_event = None
        self.header = None
        # One queue for the life of the process: the capture keeps its append.
        self.queue = collections.deque()
        # Reentrant: a signal handler may flush while the main thread is flushing.
        self.lock = threading.RLock()
        self.thread = None
        self.stopping = threading.Event()
        # Called every 400 ms by the writer's thread (detalhe.json, detail.py).
        self.periodic = []
        self._name_process()
        # Registered first, so it runs after the app's own atexit handlers.
        atexit.register(self.close)
        if hasattr(os, 'register_at_fork'):
            os.register_at_fork(after_in_child=self._after_fork)

    def _name_process(self):
        """A new file per process, with its own sequence."""
        pid = os.getpid()
        self.process = '%d:0' % pid
        self.file = os.path.join(self.directory, '%d-0-%s.jsonl' % (pid, os.urandom(16).hex()))
        self.prefix = '{"version":1,"process":"%s","sequence":' % self.process
        # Node ids are "<process>:<n>"; kept as the opening of a JSON string.
        self.id_prefix = '"%s:' % self.process
        self.sequence = itertools.count(1)

    def _after_fork(self):
        """The child drops the parent's batch and starts its own file, with its own capture-start."""
        self.queue.clear()
        self.lock = threading.RLock()
        self.thread = None
        self.stopping = threading.Event()
        self._name_process()
        if self.start_event is not None:
            self.header = self.line(self.redact_fragment(self.start_event))
            self._start_thread()

    def line(self, body):
        """`body` is a JSON object fragment without braces, already redacted."""
        return '%s%d,"timeNs":%d,%s}\n' % (self.prefix, next(self.sequence), time.perf_counter_ns(), body)

    def start(self, event):
        """capture-start: the first line of the file, written with the first real event, so
        that a process that never runs anything of the project (a supervisor, a helper
        started by multiprocessing) leaves no file."""
        self.start_event = event
        self.header = self.line(self.redact_fragment(event))
        self._start_thread()

    @property
    def active(self):
        """Whether this process has written, or queued, anything beyond capture-start."""
        return self.start_event is not None and (self.header is None or len(self.queue) > 0)

    def write(self, line):
        self.queue.append(line)

    def _format(self, parts):
        """Lines as they are; the capture's tuples as the lines of src/runtime.mjs."""
        prefix, ids = self.prefix, self.id_prefix
        lines = []
        for item in parts:
            if item.__class__ is str:
                lines.append(item)
            elif item[0] == 1:  # (1, sequence, time, node, parent, request, metadata)
                _, sequence, at, node, parent, request, info = item
                lines.append('%s%d,"timeNs":%d,"type":"enter","id":%s%d","parentId":%s,"requestId":%s,%s}\n' % (
                    prefix, sequence, at, ids, node, 'null' if parent is None else '%s%d"' % (ids, parent), request, info))
            else:  # (0, sequence, time, node, request, error, duration)
                _, sequence, at, node, request, error, duration = item
                lines.append('%s%d,"timeNs":%d,"type":"exit","id":%s%d","requestId":%s,"error":%s,"durationNs":%d}\n' % (
                    prefix, sequence, at, ids, node, request, error, duration))
        return lines

    def emit(self, event):
        self.queue.append(self.line(self.redact_fragment(event)))

    def redact_fragment(self, event):
        """Redacted and serialised once, for metadata repeated in many events."""
        return json.dumps(self.redact(event), ensure_ascii=False, separators=(',', ':'))[1:-1]

    def _start_thread(self):
        with self.lock:
            if self.thread is None:
                thread = threading.Thread(target=self._loop, name='codetac-writer', daemon=True)
                thread.start()
                self.thread = thread

    def _loop(self):
        queue, stopping = self.queue, self.stopping
        waited = 0.0
        while not stopping.wait(self.flush_seconds):
            if queue:
                self.flush()
            waited += self.flush_seconds
            if waited >= 0.4 and self.periodic:
                waited = 0.0
                for task in self.periodic:
                    try:
                        task()
                    except Exception:
                        pass

    def close(self):
        """At exit: the thread stops before the interpreter shuts down, then the last flush."""
        self.stopping.set()
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(2)
        self.flush()

    def flush(self):
        with self.lock:
            queue = self.queue
            count = len(queue)
            if not count:
                return
            parts = [queue.popleft() for _ in range(count)]
            if self.disabled:
                return
            lines = self._format(parts)
            if self.header is not None:
                lines.insert(0, self.header)
                self.header = None
            data = ''.join(lines).encode('utf-8', 'replace')
            try:
                if not os.path.isdir(self.directory):
                    os.makedirs(self.directory, mode=0o700, exist_ok=True)
                fd = os.open(self.file, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                try:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(fd, view):]
                finally:
                    os.close(fd)
            except OSError:
                self.disabled = True
                sys.stderr.write('[CodeTAC] Recording unavailable; the app keeps running without capture.\n')


# Signals. The flush runs first, then whatever the app installed. Handlers the
# app installs later (uvicorn, asyncio, gunicorn...) are wrapped the same way
# by signal.signal, and signal.getsignal still returns the app's own. With no
# handler of the app, the default termination follows: the signal is raised
# again with SIG_DFL.
SIGNALS = ('SIGINT', 'SIGTERM', 'SIGHUP')


def install_signals(flush):
    if threading.current_thread() is not threading.main_thread():
        return
    numbers = set(getattr(signal, name) for name in SIGNALS if hasattr(signal, name))
    original_signal = signal.signal
    original_getsignal = signal.getsignal

    def unwrap(handler):
        return getattr(handler, '__codetac_app_handler__', handler)

    def wrap(handler):
        def codetac_signal(number, frame):
            flush()
            if callable(handler):
                return handler(number, frame)
            original_signal(number, signal.SIG_DFL)
            os.kill(os.getpid(), number)
        codetac_signal.__codetac_app_handler__ = handler
        return codetac_signal

    def codetac_signal_signal(number, handler):
        if number in numbers and handler != signal.SIG_IGN and not hasattr(handler, '__codetac_app_handler__'):
            handler = wrap(handler)
        return unwrap(original_signal(number, handler))

    def codetac_getsignal(number):
        return unwrap(original_getsignal(number))

    codetac_signal_signal.__doc__ = original_signal.__doc__
    codetac_getsignal.__doc__ = original_getsignal.__doc__
    for number in numbers:
        current = original_getsignal(number)
        # An ignored signal stays ignored (nohup); a handler set outside
        # Python (None) is left alone.
        if current is not None and current != signal.SIG_IGN:
            original_signal(number, wrap(current))
    signal.signal = codetac_signal_signal
    signal.getsignal = codetac_getsignal
