"""What only a framework knows, when the dossier would otherwise have a gap.

- FastAPI: the body of a request is validated by pydantic-core, compiled
  (Rust), where no Python function runs. The dossier shows an opaque step,
  "request validation (not observable)", around it: its time, whether it
  failed (422), and any validators of the project as its children. The point
  is fastapi.dependencies.utils.request_body_to_args, which solve_dependencies
  looks up in its module at each call.

Keep it importable on old Pythons (3.8+); in the minimal mode, without
functions, nothing is recorded here.
"""
import functools
import inspect

from .hooks import register

VALIDATION = 'request validation (not observable)'


def _monitor():
    import codetac_py
    return codetac_py.monitor if codetac_py.role == 'app' else None


def _patch_fastapi_dependencies(module):
    original = module.request_body_to_args
    if getattr(original, '__codetac_wrapped__', False):
        return

    def failed(result):
        # (values, errors): errors is the list of validation errors.
        try:
            return bool(result[1])
        except (TypeError, IndexError, KeyError):
            return False

    if inspect.iscoroutinefunction(original):
        @functools.wraps(original)
        async def request_body_to_args(*args, **kwargs):
            monitor = _monitor()
            if monitor is None:
                return await original(*args, **kwargs)
            end = monitor.opaque(VALIDATION)
            error = True
            try:
                result = await original(*args, **kwargs)
                error = failed(result)
                return result
            finally:
                end(error)
    else:
        @functools.wraps(original)
        def request_body_to_args(*args, **kwargs):
            monitor = _monitor()
            if monitor is None:
                return original(*args, **kwargs)
            end = monitor.opaque(VALIDATION)
            error = True
            try:
                result = original(*args, **kwargs)
                error = failed(result)
                return result
            finally:
                end(error)

    request_body_to_args.__codetac_wrapped__ = True
    module.request_body_to_args = request_body_to_args


def install():
    register('fastapi.dependencies.utils', _patch_fastapi_dependencies)
