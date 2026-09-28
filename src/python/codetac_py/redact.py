"""Port of src/redact.mjs with identical behaviour.

test/vetores-redacao.json holds inputs and expected outputs shared by the Node
and the Python tests: any difference fails in both.

JavaScript regular expressions without the u flag have ASCII \\w, \\d and \\b,
ASCII-only case folding, and a Unicode \\s. The patterns below use re.ASCII
and spell \\s out, to match them character for character.

Keep it importable on old Pythons (3.8+): the minimal mode uses it too.
"""
import os
import re

_S = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
_NOT_S = _S.replace('[', '[^', 1)
_FLAGS = re.ASCII | re.IGNORECASE
_NAMES = 'password|secret|token|authorization|api[ _-]?key|credential|private[ _-]?key|session'

_sensitive = re.compile(_NAMES, _FLAGS)
MARKER = '[REDACTED]'
MIN_SECRET_LENGTH = 8

_bearer = re.compile('Bearer' + _S + '+' + _NOT_S[:-1] + '"\',;]+', _FLAGS)
_private_key = re.compile('-----BEGIN [\\w ]*PRIVATE KEY-----[\\s\\S]*?-----END [\\w ]*PRIVATE KEY-----', re.ASCII)
_tokens = re.compile('\\b(?:sk-(?:proj-|ant-)?[\\w-]{8,}|gh[pousr]_[\\w]{10,}|github_pat_[\\w]{10,}|AKIA[A-Z0-9]{16}'
                     '|AIza[\\w-]{20,}|xox[baprs]-[\\w-]{10,}|eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+)\\b', re.ASCII)
_assignment = re.compile('((?:' + _NAMES + ')' + _S + '*[=:]' + _S + '*)(?:"[^"]*"|\'[^\']*\'|' + _NOT_S[:-1] + ',;]+)', _FLAGS)
_email = re.compile('\\b([\\w.+-])[\\w.+-]*@([\\w-])[\\w.-]*\\.[a-z]{2,}\\b', _FLAGS)
_phone = re.compile('(?<![\\w])\\+?\\d[\\d ()-]{7,}\\d(?![\\w])', re.ASCII)
_surrogate = re.compile('[\\ud800-\\udfff]')


def is_sensitive_name(name):
    """A name (field, parameter, function) that announces a secret."""
    return bool(_sensitive.search('' if name is None else str(name)))


def create_redactor(env=None, max_bytes=10 * 1024):
    env = os.environ if env is None else env
    # Very short values ("1", "true") are flags, not secrets; matching them
    # would destroy unrelated text such as paths and numbers.
    secrets = sorted((value for key, value in env.items()
                      if _sensitive.search(key) and isinstance(value, str) and len(value) >= MIN_SECRET_LENGTH),
                     key=len, reverse=True)

    def text(value):
        for secret in secrets:
            value = value.replace(secret, MARKER)
        value = _bearer.sub('Bearer ' + MARKER, value)
        value = _private_key.sub(MARKER, value)
        value = _tokens.sub(MARKER, value)
        value = _assignment.sub(lambda match: match.group(1) + MARKER, value)
        value = _email.sub(lambda match: match.group(1) + '***@' + match.group(2) + '***', value)
        value = _phone.sub(lambda match: match.group(0)[:2] + '***' + match.group(0)[-2:], value)
        # Node counts and cuts UTF-8 bytes, with lone surrogates as U+FFFD.
        encoded = value.encode('utf-8', 'surrogatepass')
        if len(encoded) > max_bytes:
            encoded = _surrogate.sub('�', value).encode('utf-8')
            cut = encoded[:max_bytes].decode('utf-8', 'replace')
            if cut.endswith('�'):
                cut = cut[:-1]
            value = cut + '[TRUNCATED]'
        return value

    # text() depends only on its input (the secrets are fixed here): short texts repeat
    # (event keys, library names, SQL of the same query) and are redacted once.
    # Bounded, so a stream of distinct values cannot grow it.
    cache = {}
    keys = {}

    def cached(value):
        if len(value) > 512:
            return text(value)
        found = cache.get(value)
        if found is None:
            if len(cache) >= 4096:
                cache.clear()
            found = cache[value] = text(value)
        return found

    def key_of(key):
        found = keys.get(key)
        if found is None:
            name = str(key)
            if len(keys) >= 4096:
                keys.clear()
            found = keys[key] = (cached(name), bool(_sensitive.search(name)))
        return found

    def redact(value):
        if isinstance(value, str):
            return cached(value)
        if isinstance(value, (list, tuple)):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            out = {}
            for key, item in value.items():
                name, sensitive = key_of(key)
                out[name] = MARKER if sensitive else redact(item)
            return out
        return value

    return redact
