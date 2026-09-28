"""Detail on request (Phase 4 of the Node version, spec 3.8).

The panel writes .codetac/<recording>/detalhe.json: functions (file, line,
name) and whole files. For those functions only, and from their next call:

- the arguments, read from the frame when the call starts;
- the value returned, or the type of the exception;
- the lines that ran: LINE events are switched on for those code objects
  only (sys.monitoring.set_local_events), so the rest of the app pays
  nothing.

The `detail` event has the format of the Node runtime (src/runtime.mjs), so
the panel does not change. The file is read every 400 ms by the writer's
thread (no thread of its own: see writer.py on daemon threads at exit).

preview() never runs code of the app: no __repr__, __str__, properties or
__getattr__ of any type outside the standard library. Types are tested with
issubclass on the real type (isinstance may read an overridden __class__),
built-in containers are read through the methods of their base type, and
objects of the app through the C descriptor of their __dict__ only.
"""
import datetime
import decimal
import enum
import json
import math
import os
import sys
import types
import uuid
from pathlib import PurePath

from .redact import MARKER, is_sensitive_name

MONITORING = sys.monitoring
LINE = MONITORING.events.LINE
CO_VARARGS = 0x0004
CO_VARKEYWORDS = 0x0008
LIMITS = {'depth': 4, 'items': 20, 'keys': 30, 'nodes': 300, 'text': 2000}


# preview ----------------------------------------------------------------------------

_TYPE_DICT = type.__dict__['__dict__']        # a class's own namespace, without its metaclass
_TYPE_QUALNAME = type.__dict__['__qualname__']
_TYPE_MODULE = type.__dict__['__module__']
_TYPE_MRO = type.__dict__['__mro__']
_GETSET = types.GetSetDescriptorType


def _class_name(cls):
    try:
        return _TYPE_QUALNAME.__get__(cls)
    except Exception:
        return '?'


def _class_module(cls):
    try:
        module = _TYPE_MODULE.__get__(cls)
        return module if isinstance(module, str) else ''
    except Exception:
        return ''


def _instance_dict(item):
    """The instance's __dict__, through the C descriptor of the class that has one; None when
    the class defines __dict__ itself (a property: app code) or has none (slots, C types)."""
    for cls in _TYPE_MRO.__get__(type(item)):
        found = _TYPE_DICT.__get__(cls).get('__dict__')
        if found is None:
            continue
        if type(found) is _GETSET:
            try:
                value = found.__get__(item)
            except Exception:
                return None
            return value if type(value) is dict else None
        return None
    return None


def _query_keys(query):
    keys = []
    for part in query.split('&'):
        key = part.split('=', 1)[0]
        if key and key not in keys:
            keys.append(key)
    return keys


def _path(path, query):
    keys = _query_keys(query) if query else []
    return path + ('?' + '&'.join('%s=…' % key for key in keys) if keys else '')


def _http_summary(item, cls, fields):
    """Requests and responses of Starlette, werkzeug and Flask, from their own fields:
    method, path without query values, header names; never header values or bodies."""
    module = _class_module(cls)
    if not module.startswith(('starlette.', 'fastapi.', 'werkzeug.', 'flask.')):
        return None
    name = _class_name(cls)
    scope = fields.get('scope')
    if type(scope) is dict and scope.get('type') in ('http', 'websocket'):
        query = scope.get('query_string') or b''
        headers = [key.decode('latin-1') for key, _ in list(scope.get('headers') or [])[:40] if type(key) is bytes]
        return {'$class': name, 'method': scope.get('method'), 'path': _path(str(scope.get('path', '')), query.decode('latin-1')),
                'headers': headers}
    environ = fields.get('environ')
    if type(environ) is dict and 'REQUEST_METHOD' in environ:
        headers = [key[5:].replace('_', '-').lower() for key in environ if type(key) is str and key.startswith('HTTP_')][:40]
        return {'$class': name, 'method': environ.get('REQUEST_METHOD'), 'path': _path(str(environ.get('PATH_INFO', '')),
                                                                                       str(environ.get('QUERY_STRING', ''))),
                'headers': headers}
    if 'status_code' in fields and ('raw_headers' in fields or 'body' in fields):
        raw = fields.get('raw_headers') or []
        return {'$class': name, 'status': fields.get('status_code') if type(fields.get('status_code')) is int else None,
                'headers': [key.decode('latin-1') for key, _ in list(raw)[:40] if type(key) is bytes]}
    if '_status_code' in fields or '_status' in fields:
        code = fields.get('_status_code')
        return {'$class': name, 'status': code if type(code) is int else None}
    return {'$class': name, '$summarised': True}


def preview(value):
    """A readable copy for the detail view: plain JSON, bounded in depth, length and size.
    Redaction happens when the event is emitted."""
    nodes = [0]
    seen = set()

    def text(item):
        return item if len(item) <= LIMITS['text'] else '%s[TRUNCATED %d]' % (item[:LIMITS['text']], len(item))

    def walk(item, depth):
        nodes[0] += 1
        if nodes[0] > LIMITS['nodes']:
            return '[…]'
        cls = type(item)
        if item is None or cls is bool:
            return item
        if cls is int:
            return item if -2 ** 53 < item < 2 ** 53 else int.__repr__(item)
        if cls is float:
            return item if math.isfinite(item) else float.__repr__(item)
        if cls is str:
            return text(item)
        if issubclass(cls, (bytes, bytearray, memoryview)):
            return {'$type': 'bytes', 'bytes': len(item) if cls in (bytes, bytearray) else memoryview.__len__(item)}
        if cls in (types.FunctionType, types.BuiltinFunctionType, types.MethodType):
            return {'$type': 'function', 'name': getattr(item, '__qualname__', None) if cls is not types.MethodType else '(method)'}
        if issubclass(cls, type):
            return {'$type': 'class', 'name': _class_name(item)}
        if cls is types.ModuleType:
            return {'$type': 'module'}
        if cls in (types.GeneratorType, types.CoroutineType, types.AsyncGeneratorType):
            return {'$type': {types.GeneratorType: 'generator', types.CoroutineType: 'coroutine'}.get(cls, 'async generator')}
        if issubclass(cls, BaseException):
            # The type only: the message comes from __str__, which may be the app's.
            return {'$type': 'error', 'name': _class_name(cls)}
        if cls in (datetime.datetime, datetime.date, datetime.time):
            return {'$type': 'date', 'value': cls.isoformat(item)}
        if cls is decimal.Decimal:
            return {'$type': 'decimal', 'value': decimal.Decimal.__str__(item)}
        if cls is uuid.UUID:
            return {'$type': 'uuid', 'value': uuid.UUID.__str__(item)}
        if issubclass(cls, PurePath) and _class_module(cls).startswith('pathlib'):
            return {'$type': 'path', 'value': PurePath.__str__(item)}
        key = id(item)
        if key in seen:
            return {'$type': 'circular'}
        name = _class_name(cls)
        if depth >= LIMITS['depth']:
            return {'$type': name, '$summarised': True}
        seen.add(key)
        try:
            if issubclass(cls, enum.Enum):
                fields = _instance_dict(item) or {}
                return {'$class': name, 'name': fields.get('_name_') if type(fields.get('_name_')) is str else None}
            if issubclass(cls, dict):
                out = {}
                entries = list(dict.items(item))
                for entry_key, entry in entries[:LIMITS['keys']]:
                    label = entry_key if type(entry_key) is str else walk(entry_key, depth + 1) if type(entry_key) in (int, float, bool) or entry_key is None else '[%s]' % _class_name(type(entry_key))
                    out[str(label)] = walk(entry, depth + 1)
                if len(entries) > LIMITS['keys']:
                    out['$more'] = len(entries) - LIMITS['keys']
                if cls is not dict:
                    out = {'$class': name, **out}
                return out
            if issubclass(cls, (list, tuple)):
                base = list if issubclass(cls, list) else tuple
                size = base.__len__(item)
                out = [walk(base.__getitem__(item, index), depth + 1) for index in range(min(size, LIMITS['items']))]
                if size > LIMITS['items']:
                    out.append({'$more': size - LIMITS['items']})
                return out
            if issubclass(cls, (set, frozenset)):
                base = set if issubclass(cls, set) else frozenset
                values = []
                for entry in base.__iter__(item):
                    if len(values) >= LIMITS['items']:
                        break
                    values.append(walk(entry, depth + 1))
                return {'$type': 'set', 'size': base.__len__(item), 'values': values}
            fields = _instance_dict(item)
            if fields is None:
                # Slots, C types (connections, sockets, locks…): the class only.
                return {'$class': name, '$summarised': True}
            summary = _http_summary(item, cls, fields)
            if summary is not None:
                return summary
            out = {'$class': name}
            # Fields starting with "_" are internals (frameworks, ORMs), not the app's data.
            keys = [field for field in fields if type(field) is str and not field.startswith('_')]
            for field in keys[:LIMITS['keys']]:
                out[field] = walk(fields[field], depth + 1)
            if len(keys) > LIMITS['keys']:
                out['$more'] = len(keys) - LIMITS['keys']
            return out
        except Exception:
            return {'$type': 'unreadable'}
        finally:
            seen.discard(key)

    return walk(value, 0)


# Detail on request ------------------------------------------------------------------

def parameter_names(code):
    """In the order of the signature: positional, *args, keyword-only, **kwargs
    (co_varnames keeps *args after the keyword-only ones)."""
    names = code.co_varnames
    positional, keyword = code.co_argcount, code.co_kwonlyargcount
    varargs = (names[positional + keyword],) if code.co_flags & CO_VARARGS else ()
    extra = positional + keyword + len(varargs)
    varkw = (names[extra],) if code.co_flags & CO_VARKEYWORDS else ()
    return names[:positional] + varargs + names[positional:positional + keyword] + varkw


def template_line(table, line):
    """The template line of a generated line (Template.get_corresponding_lineno)."""
    for template, generated in reversed(table):
        if generated <= line:
            return template
    return 1


class Detail(object):
    def __init__(self, capture, writer, directory):
        self.capture = capture
        self.writer = writer
        self.file = os.path.join(directory, 'detalhe.json')
        self.stamp = None
        self.functions = set()   # "file:line:name"
        self.files = set()
        self.codes = {}          # code object -> parameter names, for the functions with detail
        self.calls = {}          # id(frame) -> [args, lines, node, request literal, code]

    # detalhe.json -----------------------------------------------------------------
    def poll(self):
        try:
            stat = os.stat(self.file)
            stamp = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            stamp = None
        if stamp == self.stamp:
            return
        self.stamp = stamp
        spec = {}
        if stamp is not None:
            try:
                with open(self.file, 'rb') as file:
                    spec = json.loads(file.read().decode('utf-8'))
            except (OSError, ValueError):
                spec = {}
        functions = spec.get('functions') if isinstance(spec, dict) else None
        files = spec.get('files') if isinstance(spec, dict) else None
        self.functions = set('%s:%s:%s' % (item.get('file'), item.get('line'), item.get('function') or '')
                             for item in functions or [] if isinstance(item, dict))
        self.files = set(item for item in files or [] if isinstance(item, str))
        for code, place in list(self.capture.places_of.items()):
            self.consider(code, place)

    def wanted(self, place):
        file, line, name = place
        return file in self.files or '%s:%s:%s' % (file, line, name) in self.functions or '%s:%s:' % (file, line) in self.functions

    def consider(self, code, place):
        """Switches detail on or off for one code object of the project."""
        wanted = self.wanted(place)
        tool = self.capture.tool
        if wanted and code not in self.codes:
            self.codes[code] = parameter_names(code)
            MONITORING.set_local_events(tool, code, LINE)
        elif not wanted and code in self.codes:
            del self.codes[code]
            MONITORING.set_local_events(tool, code, 0)

    # Calls ------------------------------------------------------------------------
    def start(self, code, frame, node, request):
        try:
            names = self.codes.get(code)
            if names is None:
                return
            local = frame.f_locals
            args = [{'name': name, 'value': MARKER if is_sensitive_name(name) else preview(local.get(name))} for name in names]
        except Exception:
            args = []
        self.calls[id(frame)] = [args, set(), node, request, code]

    def line(self, frame, code, line):
        call = self.calls.get(id(frame))
        if call is not None and call[4] is code:
            table = self.capture.template_tables.get(code)
            call[1].add(template_line(table, line) if table is not None else line)

    def finish(self, frame, code, returned=None, exception=None):
        call = self.calls.pop(id(frame), None)
        if call is None or call[4] is not code:
            return
        args, lines, node, request, _ = call
        from .context import request_of
        request_id, _ = request_of(request)
        event = {'type': 'detail', 'id': '%s:%d' % (self.writer.process, node), 'requestId': request_id,
                 'args': args, 'lines': sorted(lines)}
        if exception is not None and type(exception) is not GeneratorExit:
            event['threw'] = preview(exception)
        else:
            name = self.capture.places_of.get(code, (None, None, ''))[2]
            event['returned'] = MARKER if is_sensitive_name(name.rsplit('.', 1)[-1]) else preview(returned)
        self.writer.emit(event)
