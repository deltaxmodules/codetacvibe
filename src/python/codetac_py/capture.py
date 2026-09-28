"""Functions of the project, with sys.monitoring (PEP 669). Python 3.12+.

- One decision per code object: the first time a code object outside the
  project starts, the callback returns DISABLE and it costs nothing after.
- Static metadata is redacted and serialised once per code object; enter and
  exit events only add ids and times, as in src/runtime.mjs.
- Parentage: a ContextVar with the current node. Threads and asyncio tasks
  each have their own context.
- PY_YIELD and PY_RESUME (or PY_THROW) are suspensions and resumptions, not
  exits: the duration of a generator or coroutine includes its waits.
"""
import ast
import itertools
import os
import sys
from time import perf_counter_ns

MONITORING = sys.monitoring
EVENTS = MONITORING.events
DISABLE = MONITORING.DISABLE
# 3 and 4 are not assigned to any kind of tool; 5 (optimizer) and 2
# (profiler, used by cProfile) only if they are free.
TOOL_IDS = (3, 4, 5, 2)
CO_OPTIMIZED = 0x0001
CO_ASYNC = 0x0080 | 0x0100 | 0x0200  # coroutine, iterable coroutine, async generator
CO_GENERATOR = 0x0020
CO_SUSPENDS = CO_GENERATOR | CO_ASYNC  # generator, or any of those: it can be suspended
from .context import NULL, current, request_scope, scope  # noqa: F401 (request_scope is used by the tests)
from .detail import Detail
from .jinja_map import Templates, is_template, read_table
from .project import ProjectFiles


class NoToolId(Exception):
    pass


def free_tool_id():
    for tool in TOOL_IDS:
        try:
            MONITORING.use_tool_id(tool, 'codetac')
            return tool
        except ValueError:
            continue
    raise NoToolId('another tool is already monitoring Python')


class Capture(object):
    def __init__(self, writer, root):
        self.writer = writer
        self.root = os.path.realpath(root)
        self.tool = free_tool_id()
        self.infos = {}       # code object -> serialised enter fragment, or None
        self.project_file = ProjectFiles(self.root)  # co_filename -> real path of a project file, or None
        self.templates = Templates(self.root)  # Jinja templates of the project
        self.other_file = ProjectFiles(self.root, python=False)  # co_filename -> a file of the project that is not .py
        self.places = {}      # real path -> {(first line, name): (line, endLine, column)}
        self.modules = set()  # real paths already announced with a `module` event
        self.frames = {}      # generators and coroutines: id(frame) -> [node id, context before, start, own context]
        self.suspends = set() # code objects of generators and coroutines
        # Synchronous generators of Jinja templates: consumed whole by the template's
        # render (a C join), so nothing of the app runs between their yields. Following
        # each yield cost milliseconds per page (one yield per piece of HTML); their
        # context is set at the start and put back at the end only.
        self.whole = set()
        self.counter = itertools.count(1)
        self.opaque_infos = {}  # name -> serialised enter fragment of an opaque step
        self.functions = 0
        self.places_of = {}      # code object -> (file, line, name), for detail on request
        self.template_tables = {}  # code object of a mapped template -> its line table
        self.detail = Detail(self, writer, writer.directory)

    def classify(self, code, get_frame=None):
        info = None
        try:
            path = self.project_file(code.co_filename)
            if path is None:
                # Code compiled from a Jinja template of the project: mapped to
                # the lines of the .html. The frame is asked for only then:
                # materialising frames of any code (libraries, the interpreter
                # shutting down) crashed CPython 3.12 at exit (stage 8).
                if get_frame is not None and code.co_flags & CO_OPTIMIZED and self.other_file(code.co_filename) is not None:
                    frame = get_frame(2)  # 0: classify, 1: py_start, 2: the code starting
                    if is_template(frame.f_globals):
                        info = self._template(code, frame.f_globals)
            else:
                if code.co_flags & CO_OPTIMIZED:
                    info = self._describe(code, path)
                elif code.co_name == '<module>' and path not in self.modules:
                    # Module and class bodies are not functions.
                    self.modules.add(path)
                    self.writer.emit({'type': 'module', 'file': path, 'functions': _count_functions(code)})
        except Exception:
            info = None
        self.infos[code] = info
        return info

    def _template(self, code, globals_):
        found = self.templates.describe(code, globals_)
        if not found:
            return None
        meta, limitation = found
        if limitation is not None:
            self.writer.emit(limitation)
        self.functions += 1
        if code.co_flags & CO_SUSPENDS:
            self.suspends.add(code)
            if code.co_flags & CO_SUSPENDS == CO_GENERATOR:
                self.whole.add(code)
        if meta['line'] is not None:
            self.template_tables[code] = read_table(globals_.get('debug_info'))
            self._place_for_detail(code, (meta['file'], meta['line'], meta['function']))
        return self.writer.redact_fragment(meta)

    def _place_for_detail(self, code, place):
        self.places_of[code] = place
        if self.detail.functions or self.detail.files:
            self.detail.consider(code, place)

    def _describe(self, code, path):
        line, end_line, column = self._place(code, path)
        self.functions += 1
        if code.co_flags & CO_SUSPENDS:
            self.suspends.add(code)
        name = readable_name(code.co_qualname)
        meta = {'function': name, 'file': path, 'line': line, 'endLine': end_line,
                'column': column, 'mapped': False, 'async': bool(code.co_flags & CO_ASYNC)}
        self._place_for_detail(code, (path, line, name))
        return self.writer.redact_fragment(meta)

    def _place(self, code, path):
        """The `def` line (co_firstlineno is the first decorator's), from the file's syntax tree."""
        places = self.places.get(path)
        if places is None:
            places = self.places[path] = _read_places(path)
        found = places.get((code.co_firstlineno, code.co_name))
        if found:
            return found
        lines = [line for _, _, line in code.co_lines() if line is not None]
        return code.co_firstlineno, max(lines) if lines else code.co_firstlineno, None

    # Events -------------------------------------------------------------------------
    # The hot path (stage 5). Per call: one ContextVar get and set on the way in
    # and out, one clock reading and one tuple of values appended to the
    # writer's queue each way (the writer makes the JSON lines in the batch). An ordinary function keeps its state in the context value itself
    # (context.py); only generators and coroutines, which suspend and resume,
    # use the table keyed by their frame.
    def start(self):
        self.events = (EVENTS.PY_START | EVENTS.PY_RETURN | EVENTS.PY_UNWIND
                       | EVENTS.PY_YIELD | EVENTS.PY_RESUME | EVENTS.PY_THROW)
        self._bind()
        MONITORING.set_events(self.tool, self.events)
        # detalhe.json: now, and every 400 ms from the writer's thread.
        self.detail.poll()
        self.writer.periodic.append(self.detail.poll)
        if hasattr(os, 'register_at_fork'):
            # The writer has a new file, prefix and sequence in the child.
            os.register_at_fork(after_in_child=self._bind)

    def _bind(self):
        tool, on = self.tool, MONITORING.register_callback
        infos, frames, suspends, writer, whole = self.infos, self.frames, self.suspends, self.writer, self.whole
        append, next_sequence, next_node = writer.queue.append, writer.sequence.__next__, self.counter.__next__
        classify, get_frame, get, set_ = self.classify, sys._getframe, current.get, current.set
        now, missing = perf_counter_ns, object()
        # Functions with detail on request (usually none: one falsy check per call).
        detailed, detail = self.detail.codes, self.detail

        def py_start(code, offset):
            try:
                info = infos.get(code, missing)
                if info is missing:
                    info = classify(code, get_frame)
                if info is None:
                    return DISABLE
                before = get()
                started = now()
                node = next_node()
                append((1, next_sequence(), started, node, before[0], before[1], info))
                if detailed and code in detailed:
                    detail.start(code, get_frame(1), node, before[1])
                if code in suspends:
                    here = (node, before[1], None, 0, None)
                    frames[id(get_frame(1))] = [node, before, started, here]
                    set_(here)
                else:
                    set_((node, before[1], before, started, code))
            except Exception:
                pass

        def finish(code, error):
            if code in suspends:
                state = frames.pop(id(get_frame(2)), None)
                if state is None:
                    return
                set_(state[1])
                ended = now()
                append((0, next_sequence(), ended, state[0], state[3][1], error, ended - state[2]))
                return
            state = get()
            # Only the call that is running: a call that started before the
            # capture (or while it was paused) has no state of its own.
            if state[4] is code:
                set_(state[2])
                ended = now()
                append((0, next_sequence(), ended, state[0], state[1], error, ended - state[3]))

        def py_return(code, offset, value):
            try:
                if infos.get(code) is None:
                    return DISABLE
                if detailed and code in detailed:
                    detail.finish(get_frame(1), code, returned=value)
                # The ordinary case inline (finish() below does the same): it is
                # the most frequent event.
                state = get()
                if state[4] is code:
                    set_(state[2])
                    ended = now()
                    append((0, next_sequence(), ended, state[0], state[1], 'false', ended - state[3]))
                elif code in suspends:
                    finish(code, 'false')
            except Exception:
                pass

        def py_unwind(code, offset, exception):
            # Cannot be disabled: called for every frame an exception leaves.
            try:
                if infos.get(code) is not None:
                    if detailed and code in detailed:
                        detail.finish(get_frame(1), code, exception=exception)
                    # Closing a suspended generator, or cancelling a coroutine (a
                    # client that went away), is not an error of the app.
                    kind = type(exception)
                    finish(code, 'false' if kind is GeneratorExit or kind.__name__ == 'CancelledError' else 'true')
            except Exception:
                pass

        def py_yield(code, offset, value):
            try:
                if infos.get(code) is None or code in whole:
                    return DISABLE
                state = frames.get(id(get_frame(1)))
                if state is not None:
                    set_(state[1])
            except Exception:
                pass

        def resumed():
            state = frames.get(id(get_frame(2)))
            if state is not None:
                state[1] = get()
                set_(state[3])

        def py_resume(code, offset):
            try:
                if infos.get(code) is None or code in whole:
                    return DISABLE
                resumed()
            except Exception:
                pass

        def py_throw(code, offset, exception):
            try:
                if infos.get(code) is not None:
                    resumed()
            except Exception:
                pass

        def line(code, number):
            # Only the code objects with detail have LINE events (set_local_events).
            try:
                detail.line(get_frame(1), code, number)
            except Exception:
                pass

        on(tool, EVENTS.PY_START, py_start)
        on(tool, EVENTS.LINE, line)
        on(tool, EVENTS.PY_RETURN, py_return)
        on(tool, EVENTS.PY_UNWIND, py_unwind)
        on(tool, EVENTS.PY_YIELD, py_yield)
        on(tool, EVENTS.PY_RESUME, py_resume)
        on(tool, EVENTS.PY_THROW, py_throw)

    def opaque(self, name):
        """A step the capture cannot see inside (compiled code, such as the validation of
        pydantic-core): an enter now, with `opaque: true` and no file; returns end(error).
        Functions of the project it calls (validators) are its children."""
        writer = self.writer
        info = self.opaque_infos.get(name)
        if info is None:
            info = self.opaque_infos[name] = writer.redact_fragment({
                'function': name, 'file': None, 'line': None, 'endLine': None, 'column': None,
                'mapped': False, 'async': False, 'opaque': True})
        before = current.get()
        node = next(self.counter)
        started = perf_counter_ns()
        writer.queue.append((1, next(writer.sequence), started, node, before[0], before[1], info))
        token = current.set((node, before[1], None, 0, None))

        def end(error):
            current.reset(token)
            ended = perf_counter_ns()
            writer.queue.append((0, next(writer.sequence), ended, node, before[1], 'true' if error else 'false', ended - started))
        return end

    def pause(self):
        MONITORING.set_events(self.tool, 0)

    def resume(self):
        MONITORING.set_events(self.tool, self.events)

    def stop(self):
        MONITORING.set_events(self.tool, 0)
        MONITORING.free_tool_id(self.tool)


def readable_name(qualname):
    """co_qualname without the noise: "deco.<locals>.wrapper" -> "deco.wrapper",
    "total.<locals>.<genexpr>" -> "generator expression in total", lambdas alike."""
    name = qualname.replace('.<locals>', '')
    for inner, label in (('<genexpr>', 'generator expression'), ('<lambda>', 'lambda')):
        if name == inner:
            return label
        if name.endswith('.' + inner):
            return '%s in %s' % (label, name[:-len(inner) - 1])
    return name


def _count_functions(code):
    count = 0
    for constant in code.co_consts:
        if hasattr(constant, 'co_flags'):
            count += bool(constant.co_flags & CO_OPTIMIZED) + _count_functions(constant)
    return count


def _read_places(path):
    places = {}
    try:
        with open(path, 'rb') as file:
            tree = ast.parse(file.read(), path)
    except (OSError, SyntaxError, ValueError):
        return places
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            first = min([node.lineno] + [item.lineno for item in node.decorator_list])
            places[(first, node.name)] = (node.lineno, node.end_lineno, node.col_offset + 1)
        elif isinstance(node, ast.Lambda):
            places.setdefault((node.lineno, '<lambda>'), (node.lineno, node.end_lineno, node.col_offset + 1))
    return places
