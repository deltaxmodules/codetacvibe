"""Library boundaries: databases here (stage 6); the network (network.py) and
files (files.py) since stage 7. The classification and the fields are those
of src/boundaries.mjs:

  boundary      {id, parentId, requestId, kind: 'base-de-dados', library, operation, tables, sql}
  boundary-end  {id, requestId, durationNs, error, rows | affectedRows}

The SQL is recorded as a template (describe_sql, the port of describeSql):
string literals are replaced, and the parameters are never read.

Where each library is seen:
- SQLAlchemy / SQLModel, sync and async: the engine events
  (before/after_cursor_execute, handle_error);
- sqlite3: connect() gives subclasses of Connection and Cursor (the C types
  cannot be patched);
- psycopg (3): Cursor and AsyncCursor; psycopg2: connection and cursor
  factories; PyMySQL and mysqlclient: their cursors; asyncpg: Connection;
- aiosqlite runs sqlite3 in its own thread: the calls it sends there carry
  the caller's context.

A boundary inside another (SQLAlchemy over a driver, executemany over
execute) is recorded once: the outer one.

Keep it importable on old Pythons (3.8+): the minimal mode records boundaries.
"""
import contextvars
import functools
import itertools
import re
import time

from .context import current, request_of
from .hooks import register

WRITES = {'INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE', 'MERGE'}
_boundaries = itertools.count(1)
# Inside a database boundary: an inner one (the driver under SQLAlchemy) is not recorded.
_inside = contextvars.ContextVar('codetac_boundary', default=False)


def _codetac():
    import codetac_py
    return codetac_py


# The SQL template (src/boundaries.mjs describeSql) --------------------------------

_literal = re.compile(r"'(?:[^'\\]|\\.|'')*'")
_space = re.compile(r'\s+')
_S = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
_first = re.compile('^' + _S + '*(\\w+)', re.ASCII)
_tables = re.compile(r'\b(?:from|into|update|join|table(?: if (?:not )?exists)?)\s+[`"\[]?([\w.]+)', re.ASCII | re.IGNORECASE)
_keywords = re.compile(r'^(select|if|not|exists)$', re.ASCII | re.IGNORECASE)
_js_trim = re.compile('^' + _S + '+|' + _S + '+$')


def describe_sql(sql):
    if isinstance(sql, bytes):
        sql = sql.decode('utf-8', 'replace')
    if not isinstance(sql, str):
        return {'operation': 'consulta'}
    text = _js_trim.sub('', _space.sub(' ', _literal.sub("'?'", sql)))
    first = _first.match(text)
    operation = (first.group(1) if first else 'consulta').upper()
    tables = []
    for match in _tables.finditer(text):
        name = match.group(1)
        if not _keywords.match(name) and name not in tables:
            tables.append(name)
    return {'operation': operation, 'tables': tables[:10], 'sql': text[:2000]}


# Boundaries ------------------------------------------------------------------------

def start_boundary(details):
    """Records the start; returns end(extra), which records the end once."""
    writer = _codetac().writer
    state = current.get()
    boundary_id = '%s:b%d' % (writer.process, next(_boundaries))
    request, after = request_of(state[1])
    event = {'type': 'boundary', 'id': boundary_id, 'parentId': None if state[0] is None else '%s:%d' % (writer.process, state[0]),
             'requestId': request}
    if after:
        event['afterResponse'] = True
    event.update(details)
    writer.emit(event)
    started = time.perf_counter_ns()
    done = []

    def end(extra=None):
        if done:
            return
        done.append(True)
        result = {'type': 'boundary-end', 'id': boundary_id, 'requestId': request,
                  'durationNs': time.perf_counter_ns() - started, 'error': False}
        result.update(extra or {})
        writer.emit(result)

    return end


def _rows(operation, count):
    """rows for reads, affectedRows for writes; nothing when the driver does not know (-1)."""
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return {}
    return {'affectedRows': count} if operation in WRITES else {'rows': count}


def database(library, sql, run, count):
    """Runs run() as a database boundary; count(result) gives the rows."""
    if _inside.get():
        return run()
    try:
        details = describe_sql(sql)
        end = start_boundary(dict({'kind': 'base-de-dados', 'library': library}, **details))
    except Exception:
        return run()
    token = _inside.set(True)
    try:
        result = run()
    except BaseException:
        end({'error': True})
        raise
    finally:
        _inside.reset(token)
    try:
        end(_rows(details['operation'], count(result)))
    except Exception:
        end()
    return result


async def database_async(library, sql, run, count):
    if _inside.get():
        return await run()
    try:
        details = describe_sql(sql)
        end = start_boundary(dict({'kind': 'base-de-dados', 'library': library}, **details))
    except Exception:
        return await run()
    token = _inside.set(True)
    try:
        result = await run()
    except BaseException:
        end({'error': True})
        raise
    finally:
        _inside.reset(token)
    try:
        end(_rows(details['operation'], count(result)))
    except Exception:
        end()
    return result


def _sql_of(args, kwargs, name='query'):
    if args:
        return args[0]
    return kwargs.get(name, kwargs.get('sql', kwargs.get('operation')))


def _wrap_cursor_method(owner, method, library, count=None):
    """cursor.execute(sql, ...) / executemany: rows from cursor.rowcount."""
    original = getattr(owner, method, None)
    if original is None or getattr(original, '__codetac__', False):
        return

    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        return database(library, _sql_of(args, kwargs), lambda: original(self, *args, **kwargs),
                        count or (lambda result: getattr(self, 'rowcount', -1)))

    wrapper.__codetac__ = True
    setattr(owner, method, wrapper)


def _wrap_async_cursor_method(owner, method, library):
    original = getattr(owner, method, None)
    if original is None or getattr(original, '__codetac__', False):
        return

    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):
        return await database_async(library, _sql_of(args, kwargs), lambda: original(self, *args, **kwargs),
                                    lambda result: getattr(self, 'rowcount', -1))

    wrapper.__codetac__ = True
    setattr(owner, method, wrapper)


# sqlite3 ---------------------------------------------------------------------------
# Connection and Cursor are C types: connect() returns subclasses whose execute
# methods are boundaries. The app's own factory= is subclassed the same way.

_sqlite_classes = {}


def _sqlite_cursor_class(base):
    found = _sqlite_classes.get(('cursor', base))
    if found is None:
        found = type(base.__name__, (base,), {'__module__': base.__module__, '__qualname__': base.__qualname__})
        for method in ('execute', 'executemany', 'executescript'):
            _wrap_cursor_method(found, method, 'sqlite3')
        _sqlite_classes[('cursor', base)] = found
    return found


def _sqlite_connection_class(base, module):
    found = _sqlite_classes.get(('connection', base))
    if found is not None:
        return found

    def cursor(self, factory=None):
        return base.cursor(self, _sqlite_cursor_class(factory or module.Cursor))

    # Connection.execute* create a cursor in C: here they go through cursor().
    def execute(self, sql, parameters=()):
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql, parameters):
        return self.cursor().executemany(sql, parameters)

    def executescript(self, script):
        return self.cursor().executescript(script)

    found = type(base.__name__, (base,), {'__module__': base.__module__, '__qualname__': base.__qualname__,
                                          'cursor': cursor, 'execute': execute, 'executemany': executemany,
                                          'executescript': executescript})
    _sqlite_classes[('connection', base)] = found
    return found


def _patch_sqlite(module):
    connect = module.connect
    if getattr(connect, '__codetac__', False):
        return

    @functools.wraps(connect)
    def codetac_connect(*args, **kwargs):
        factory = kwargs.pop('factory', None) or module.Connection
        try:
            kwargs['factory'] = _sqlite_connection_class(factory, module)
        except TypeError:  # a factory that cannot be subclassed: unobserved
            kwargs['factory'] = factory
        return connect(*args, **kwargs)

    codetac_connect.__codetac__ = True
    module.connect = codetac_connect


# aiosqlite: sqlite3 in its own thread; the calls carry the caller's context.
def _patch_aiosqlite(module):
    connection = module.Connection
    original = getattr(connection, '_execute', None)
    if original is None or getattr(original, '__codetac__', False):
        return

    @functools.wraps(original)
    async def _execute(self, fn, *args, **kwargs):
        context = contextvars.copy_context()
        return await original(self, context.run, fn, *args, **kwargs)

    _execute.__codetac__ = True
    connection._execute = _execute


# SQLAlchemy / SQLModel ---------------------------------------------------------------

def _patch_sqlalchemy(module):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    if getattr(Engine, '__codetac__', False):
        return
    Engine.__codetac__ = True

    def before(conn, cursor, statement, parameters, context, executemany):
        if context is None or _inside.get():
            return
        try:
            details = describe_sql(statement)
            dialect = getattr(getattr(conn, 'dialect', None), 'name', None)
            end = start_boundary(dict({'kind': 'base-de-dados', 'library': 'sqlalchemy' + ('/' + dialect if dialect else '')}, **details))
            context._codetac = (end, details['operation'], _inside.set(True))
        except Exception:
            pass

    def finish(context, extra):
        state = getattr(context, '_codetac', None)
        if state is None:
            return
        context._codetac = None
        end, operation, token = state
        try:
            _inside.reset(token)
        except ValueError:  # reset from another context (an async driver): let it go
            _inside.set(False)
        end(extra(operation))

    def after(conn, cursor, statement, parameters, context, executemany):
        finish(context, lambda operation: _rows(operation, getattr(cursor, 'rowcount', -1)))

    def error(exception_context):
        finish(exception_context.execution_context, lambda operation: {'error': True})

    event.listen(Engine, 'before_cursor_execute', before)
    event.listen(Engine, 'after_cursor_execute', after)
    event.listen(Engine, 'handle_error', error)


# PostgreSQL and MySQL drivers ------------------------------------------------------

def _patch_psycopg(module):
    for name in ('execute', 'executemany'):
        _wrap_cursor_method(module.Cursor, name, 'psycopg')
        _wrap_async_cursor_method(module.AsyncCursor, name, 'psycopg')
    # ServerCursor and AsyncServerCursor derive from these, and Connection.execute uses them.


def _patch_psycopg2(module):
    extensions = module.extensions
    classes = {}

    def cursor_class(base):
        found = classes.get(base)
        if found is None:
            found = type(base.__name__, (base,), {'__module__': base.__module__})
            for name in ('execute', 'executemany'):
                _wrap_cursor_method(found, name, 'psycopg2')
            classes[base] = found
        return found

    def connection_class(base):
        found = classes.get(('connection', base))
        if found is None:
            def cursor(self, *args, **kwargs):
                factory = kwargs.get('cursor_factory') or self.cursor_factory or extensions.cursor
                kwargs['cursor_factory'] = cursor_class(factory)
                return base.cursor(self, *args, **kwargs)
            found = type(base.__name__, (base,), {'__module__': base.__module__, 'cursor': cursor})
            classes[('connection', base)] = found
        return found

    connect = module.connect
    if getattr(connect, '__codetac__', False):
        return

    @functools.wraps(connect)
    def codetac_connect(*args, **kwargs):
        kwargs['connection_factory'] = connection_class(kwargs.get('connection_factory') or extensions.connection)
        return connect(*args, **kwargs)

    codetac_connect.__codetac__ = True
    module.connect = codetac_connect


def _patch_pymysql_cursors(module):
    for name in ('execute', 'executemany'):
        _wrap_cursor_method(module.Cursor, name, 'pymysql')


def _patch_mysqldb_cursors(module):
    for name in ('execute', 'executemany'):
        _wrap_cursor_method(module.BaseCursor, name, 'mysqlclient')


def _asyncpg_count(method):
    def count(result):
        if method in ('fetch',):
            return len(result)
        if method == 'fetchrow':
            return 0 if result is None else 1
        if method == 'execute' and isinstance(result, str):
            # The status: "INSERT 0 3", "UPDATE 2", "SELECT 5", "CREATE TABLE".
            last = result.rsplit(' ', 1)[-1]
            return int(last) if last.isdigit() else -1
        return -1
    return count


def _patch_asyncpg_connection(module):
    connection = module.Connection
    for method in ('execute', 'executemany', 'fetch', 'fetchrow', 'fetchval'):
        original = getattr(connection, method, None)
        if original is None or getattr(original, '__codetac__', False):
            continue

        def make(original, method):
            @functools.wraps(original)
            async def wrapper(self, *args, **kwargs):
                return await database_async('asyncpg', _sql_of(args, kwargs), lambda: original(self, *args, **kwargs), _asyncpg_count(method))
            wrapper.__codetac__ = True
            return wrapper

        setattr(connection, method, make(original, method))


def _patch_asyncpg_transaction(module):
    # Transaction control (BEGIN, COMMIT, ROLLBACK, SAVEPOINT) is not a read or
    # a write: as with the other drivers, whose commit() is not a query, it is
    # not a boundary (SQLAlchemy async issues it through this class).
    transaction = module.Transaction
    for method in ('start', 'commit', 'rollback'):
        original = getattr(transaction, method, None)
        if original is None or getattr(original, '__codetac__', False):
            continue

        def make(original):
            @functools.wraps(original)
            async def wrapper(self, *args, **kwargs):
                token = _inside.set(True)
                try:
                    return await original(self, *args, **kwargs)
                finally:
                    _inside.reset(token)
            wrapper.__codetac__ = True
            return wrapper

        setattr(transaction, method, make(original))


def install(root=None, data=None):
    from . import files, network
    network.install()
    if root is not None and data is not None:
        files.install(root, data)
    register('sqlite3.dbapi2', _patch_sqlite)
    register('sqlite3', _patch_sqlite)  # sqlite3 imported before the capture
    register('aiosqlite.core', _patch_aiosqlite)
    register('sqlalchemy', _patch_sqlalchemy)
    register('psycopg', _patch_psycopg)
    register('psycopg2', _patch_psycopg2)
    register('pymysql.cursors', _patch_pymysql_cursors)
    register('MySQLdb.cursors', _patch_mysqldb_cursors)
    register('asyncpg.connection', _patch_asyncpg_connection)
    register('asyncpg.transaction', _patch_asyncpg_transaction)
