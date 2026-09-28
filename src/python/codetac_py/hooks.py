"""Post-import hooks: a module of a library is patched right after it is
imported, before the code that imported it can bind its names. Used by
servers.py (servers) and boundaries.py (databases, HTTP...).

Keep it importable on old Pythons (3.8+).
"""
import sys

HOOKS = {}


def register(name, hook):
    """Runs hook(module) when `name` is imported, or now if it already was."""
    HOOKS.setdefault(name, []).append(hook)
    module = sys.modules.get(name)
    if module is not None:  # imported before the capture started
        _apply(hook, module)
    _install()


def _apply(hook, module):
    try:
        hook(module)
    except Exception as error:  # a version we do not know: it runs unobserved
        sys.stderr.write('codeTAC: %s was not prepared (%s: %s)\n' % (module.__name__, type(error).__name__, error))


class _Loader(object):
    """Runs the real loader, then the hooks. Everything else is the real loader's."""

    def __init__(self, loader, hooks):
        self._loader = loader
        self._hooks = hooks

    def __getattr__(self, name):
        return getattr(self._loader, name)

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        # The module keeps the real loader: nothing else sees this wrapper.
        module.__loader__ = self._loader
        if getattr(module, '__spec__', None) is not None:
            module.__spec__.loader = self._loader
        self._loader.exec_module(module)
        for hook in self._hooks:
            _apply(hook, module)


class _Finder(object):
    def find_spec(self, name, path=None, target=None):
        hooks = HOOKS.get(name)
        if not hooks:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, 'find_spec'):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, 'exec_module'):
                    spec.loader = _Loader(spec.loader, hooks)
                return spec
        return None

    def invalidate_caches(self):
        pass


def _install():
    if not any(isinstance(finder, _Finder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
