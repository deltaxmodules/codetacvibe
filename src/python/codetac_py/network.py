"""Network boundaries (stage 7): external HTTP, AI, S3 and email, with the
classification and the fields of src/boundaries.mjs:

  boundary      {kind: 'http' | 'ia' | 'ficheiros' | 'email' | ..., library, method, host, path, queryKeys, ...}
  boundary-end  {status, error; for AI: model, promptExcerpt, usage, answerExcerpt}

classify_http, ai_request_details and ai_response_details are ports of the
Node functions; test/vetores-http.json holds cases shared by both tests.
Headers only classify (never recorded); URLs keep the query keys, not the
values; AI bodies are read, bounded, for the usage and short excerpts.

Where each client is seen:
- http.client (urllib.request, and requests/urllib3): putrequest/putheader/
  endheaders, and getresponse for the status;
- httpx and httpx2, sync and async (httpx2 carries the openai and anthropic
  SDKs): the transports, whose response stream is followed to its end;
- aiohttp (client): ClientSession._request, and ClientResponse.read for AI;
- boto3/botocore: Endpoint._send, one boundary per attempt;
- smtplib: SMTP.sendmail (send_message goes through it).

Keep it importable on old Pythons (3.8+): the minimal mode records boundaries.
"""
import functools
import json
import re
import weakref
import zlib
from urllib.parse import parse_qsl, urlencode, urlsplit

from .boundaries import _inside, _js_trim, start_boundary
from .hooks import register
from .servers import safe_path

LIMIT = 1048576   # bytes of an AI exchange read for the usage and excerpts
BODY = 262144     # bodies larger than this are not parsed for the classification
EXCERPT = 200

AI = {'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic', 'generativelanguage.googleapis.com': 'Google',
      'api.mistral.ai': 'Mistral', 'api.groq.com': 'Groq', 'openrouter.ai': 'OpenRouter', 'api.deepseek.com': 'DeepSeek',
      'api.cohere.com': 'Cohere', 'api.together.xyz': 'Together'}
MAIL = {'api.resend.com': 'Resend', 'api.sendgrid.com': 'SendGrid', 'api.postmarkapp.com': 'Postmark',
        'api.mailgun.net': 'Mailgun', 'api.eu.mailgun.net': 'Mailgun', 'api.brevo.com': 'Brevo', 'api.twilio.com': 'Twilio'}
S3_OPERATIONS = {'GET': 'leitura', 'HEAD': 'verificação', 'PUT': 'escrita', 'POST': 'escrita', 'DELETE': 'remoção'}
SUPABASE = {'GET': 'SELECT', 'HEAD': 'SELECT', 'POST': 'INSERT', 'PATCH': 'UPDATE', 'PUT': 'UPSERT', 'DELETE': 'DELETE'}

_local = re.compile(r'^(localhost|127\.0\.0\.1|\[?::1\]?)$')
_compatible = re.compile(r'^/(v1/(chat/completions|completions|responses|messages)|api/(chat|generate))$')
_space = re.compile('[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+')


# URLs (src/boundaries.mjs splitUrl) ------------------------------------------------

def split_url(raw):
    """(host, pathname) or None, the path to record, and the query's keys."""
    try:
        parts = urlsplit(str(raw))
        if not parts.scheme or not parts.netloc:
            parts = urlsplit('http://localhost' + ('' if str(raw).startswith('/') else '/') + str(raw))
        host = parts.hostname or ''
        parts.port  # noqa: B018 (an invalid port makes the URL invalid, as in Node)
    except ValueError:
        return None, '[invalid]', []
    if ':' in host:
        host = '[%s]' % host
    pathname = parts.path or '/'
    keys = []
    for key, _ in parse_qsl(parts.query, keep_blank_values=True):
        if key not in keys:
            keys.append(key)
    return (host, pathname), safe_path(pathname), keys


# Bodies ----------------------------------------------------------------------------

def body_text(body):
    if isinstance(body, str):
        return body if len(body) <= BODY else None
    if isinstance(body, (bytes, bytearray, memoryview)) and len(body) <= BODY:
        return bytes(body).decode('utf-8', 'replace')
    return None


def json_body(body):
    text = body_text(body)
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _at(value, *path):
    """value?.a?.[0]?.b as in JavaScript: None when any step is missing."""
    for key in path:
        if isinstance(key, int):
            if not isinstance(value, list) or not -len(value) <= key < len(value):
                return None
            value = value[key]
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def _first(*values):
    """a ?? b ?? c: the first value that is not None (the others are lambdas)."""
    for value in values:
        value = value() if callable(value) else value
        if value is not None:
            return value
    return None


def _truthy(value):
    return value is not None and value is not False and value != 0 and value != ''


# Classification (src/boundaries.mjs classifyHttp) ----------------------------------

def classify_http(method, url, headers, body, client):
    parsed, path, query_keys = split_url(url)
    host = parsed[0] if parsed else ''
    base = {'kind': 'http', 'library': client, 'method': method, 'host': host, 'path': path, 'queryKeys': query_keys}
    if parsed is None:
        return base
    pathname = parsed[1]
    local = bool(_local.match(host))
    if host in AI or _compatible.match(pathname):
        data = json_body(body)
        result = dict(base, kind='ia', provider=AI.get(host) or ('local model' if local else 'compatible (%s)' % host), operation=path)
        if local:
            result['local'] = True
        if isinstance(_at(data, 'model'), str):
            result['model'] = data['model']
        return result
    # S3-compatible storage: signed header, or a presigned URL (signature in
    # the query: SigV4, or SigV2, which boto3 still makes by default). Before
    # the local case: a local MinIO or LocalStack is S3.
    authorization = str(headers.get('authorization', ''))
    if (authorization.startswith('AWS4-HMAC-SHA256') or _truthy(headers.get('x-amz-content-sha256'))
            or any(re.match(r'^x-amz-(signature|algorithm)$', key, re.IGNORECASE) for key in query_keys)
            or ('AWSAccessKeyId' in query_keys and 'Signature' in query_keys)):
        virtual = re.match(r'^(.+?)\.s3[.-]', host)
        segments = pathname.split('/')
        bucket = virtual.group(1) if virtual else (segments[1] if len(segments) > 1 else None)
        result = dict(base, kind='ficheiros', provider='S3', operation=S3_OPERATIONS.get(method, method))
        if bucket is not None:
            result['bucket'] = bucket
        size = _number(headers.get('content-length'))
        if size is not None:
            result['bytes'] = size
        return result
    if local:
        return dict(base, local=True)
    if host == 'api.stripe.com':
        form = {}
        for key, value in parse_qsl(body_text(body) or '', keep_blank_values=True):
            form.setdefault(key, value)  # URLSearchParams.get: the first value
        mode = ('teste' if re.search('(sk|rk)_test_', authorization) else
                'produção' if re.search('(sk|rk)_live_', authorization) else 'desconhecido')
        result = dict(base, kind='pagamento', provider='Stripe', operation='%s %s' % (method, path), mode=mode)
        for key in ('amount', 'currency'):
            if key in form:
                result[key] = form[key]
        return result
    if host in MAIL:
        data = json_body(body)
        result = dict(base, kind='mensagem' if MAIL[host] == 'Twilio' else 'email', provider=MAIL[host])
        to = _first(_at(data, 'to'), lambda: _at(data, 'personalizations', 0, 'to'), lambda: _at(data, 'To'))
        if to is not None:
            items = to if isinstance(to, list) else [to]
            names = [item if isinstance(item, str) else _at(item, 'email') for item in items]
            result['to'] = [name for name in names if _truthy(name)]
        subject = _at(data, 'subject') if isinstance(_at(data, 'subject'), str) else _at(data, 'Subject')
        if isinstance(subject, str):
            result['subject'] = subject
        return result
    if host.endswith('.supabase.co'):
        segments = (pathname.split('/') + [None] * 5)[:5]
        area, version, first, second = segments[1:5]
        if area == 'rest' and version == 'v1':
            return dict(base, kind='base-de-dados', provider='Supabase', operation=SUPABASE.get(method, method),
                        tables=['rpc:%s' % second] if first == 'rpc' else [first])
        if area == 'auth':
            return dict(base, kind='autenticação', provider='Supabase Auth', operation=first)
        if area == 'storage':
            return dict(base, kind='ficheiros', provider='Supabase Storage', operation=method,
                        bucket=first if second is None else second)
    if host == 'api.clerk.com' or host.endswith('.clerk.accounts.dev'):
        return dict(base, kind='autenticação', provider='Clerk')
    return base


def _number(value):
    """Number(value) in JavaScript, for a header: None when it is not a number."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return 0
    try:
        number = float(text)
    except ValueError:
        return None
    if number != number or number in (float('inf'), float('-inf')):
        return None
    return int(number) if number.is_integer() else number


# AI: model, usage and excerpts (src/boundaries.mjs aiRequestDetails, aiResponseDetails)

def _excerpt(text):
    if not isinstance(text, str) or not text:
        return None
    return _js_trim.sub('', _space.sub(' ', text))[:EXCERPT]


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(part if isinstance(part, str) else
                        (_first(_at(part, 'text'), lambda: _at(part, 'input_text'), '')) for part in content)
    return None


def _compact(values):
    return {key: value for key, value in values.items() if value is not None}


def ai_request_details(data):
    if not isinstance(data, dict):
        return {}
    messages = _first(data.get('messages'), lambda: data.get('contents'),
                      lambda: data['input'] if isinstance(data.get('input'), list) else None)
    prompt = data['input'] if isinstance(data.get('input'), str) else data['prompt'] if isinstance(data.get('prompt'), str) else None
    if not prompt and isinstance(messages, list):
        users = [message for message in messages if _first(_at(message, 'role'), 'user') == 'user']
        last = users[-1] if users else (messages[-1] if messages else None)
        prompt = _first(_text_of(_at(last, 'content')), lambda: _text_of(_at(last, 'parts')))
    return _compact({'model': data['model'] if isinstance(data.get('model'), str) else None,
                     'promptExcerpt': _excerpt(prompt), 'stream': True if data.get('stream') is True else None})


def _usage_of(value):
    usage = _first(_at(value, 'usage'), lambda: _at(value, 'response', 'usage'), lambda: _at(value, 'message', 'usage'))
    if _truthy(usage):
        found = {'input': _first(_at(usage, 'input_tokens'), lambda: _at(usage, 'prompt_tokens')),
                 'output': _first(_at(usage, 'output_tokens'), lambda: _at(usage, 'completion_tokens'))}
        if found['input'] is not None or found['output'] is not None:
            return found
    meta = _at(value, 'usageMetadata')
    if _truthy(meta):
        return {'input': _at(meta, 'promptTokenCount'), 'output': _at(meta, 'candidatesTokenCount')}
    return None


def _answer_of(value):
    def listed(key, kind, *path):
        items = _at(value, key)
        if not isinstance(items, list):
            return None
        found = next((item for item in items if _at(item, 'type') == kind), None)
        return _at(found, *path)
    return _first(_at(value, 'output_text'), lambda: _at(value, 'choices', 0, 'message', 'content'),
                  lambda: _at(value, 'choices', 0, 'text'), lambda: listed('output', 'message', 'content', 0, 'text'),
                  lambda: listed('content', 'text', 'text'), lambda: _at(value, 'candidates', 0, 'content', 'parts', 0, 'text'))


def ai_response_details(text):
    result = {}
    answer = ['']

    def take(value):
        # Named "usage" (not "tokens") so the secret redaction keeps the counts.
        usage = _usage_of(value)
        if usage:
            result['usage'] = dict(result.get('usage', {}), **_compact(usage))
        full = _answer_of(value)
        if isinstance(full, str):
            answer[0] = full
        kind = _at(value, 'type')
        delta = _first(_at(value, 'choices', 0, 'delta', 'content'),
                       lambda: _at(value, 'delta') if kind == 'response.output_text.delta' else None,
                       lambda: _at(value, 'delta', 'text') if kind == 'content_block_delta' else None)
        if isinstance(delta, str) and len(answer[0]) < EXCERPT:
            answer[0] += delta

    try:
        take(json.loads(text))
    except ValueError:
        for line in text.split('\n'):
            if not line.startswith('data:'):
                continue
            try:
                take(json.loads(line[5:].strip()))
            except ValueError:
                pass
    if answer[0]:
        result['answerExcerpt'] = _excerpt(answer[0])
    return result


def _decoded(data, encoding):
    """The bytes of a gzip or deflate body; other encodings (br, zstd) are not read (M68)."""
    encoding = (encoding or '').strip().lower()
    try:
        if encoding in ('gzip', 'x-gzip'):
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(data)
        if encoding == 'deflate':
            try:
                return zlib.decompressobj().decompress(data)
            except zlib.error:
                return zlib.decompressobj(-zlib.MAX_WBITS).decompress(data)
    except zlib.error:
        return b''
    return data if encoding in ('', 'identity') else b''


# One outgoing HTTP exchange ----------------------------------------------------------

class Exchange(object):
    """A started HTTP boundary; for AI, the bounded bodies until the end."""

    def __init__(self, details, body):
        self.end = start_boundary(details)
        self.ai = details.get('kind') == 'ia'
        self.status = None
        self.encoding = None
        self.request = ai_request_details(json_body(body)) if self.ai else {}
        self.received = []
        self.size = 0

    def collect(self, chunk):
        if self.ai and self.size <= LIMIT and chunk:
            self.received.append(bytes(chunk))
            self.size += len(chunk)

    def finish(self, error=False):
        result = {}
        if self.status is not None:
            result['status'] = self.status
        if error:
            result['error'] = True
        if self.ai:
            try:
                result.update(self.request)
                result.update(ai_response_details(_decoded(b''.join(self.received), self.encoding).decode('utf-8', 'replace')))
            except Exception:
                pass
            self.received = []
        self.end(result)


def start_exchange(client, method, url, headers, body):
    """An Exchange, or None inside another boundary or when it cannot be described."""
    if _inside.get():
        return None
    try:
        method = method.decode('ascii', 'replace') if isinstance(method, bytes) else str(method).upper()
        return Exchange(classify_http(method, url, headers, body, client), body)
    except Exception:
        return None


def _header_map(items):
    found = {}
    for key, value in items:
        key = (key.decode('latin-1') if isinstance(key, bytes) else str(key)).lower()
        value = value.decode('latin-1') if isinstance(value, bytes) else str(value)
        found[key] = found[key] + ', ' + value if key in found else value
    return found


# http.client (urllib.request, requests/urllib3) ------------------------------------------

def _patch_http_client(module):
    connection = module.HTTPConnection
    if getattr(connection.putrequest, '__codetac__', False):
        return
    putrequest, putheader, endheaders, getresponse = (
        connection.putrequest, connection.putheader, connection.endheaders, connection.getresponse)

    def url_of(self, target):
        if '://' in target:  # a proxy receives the absolute URL
            return target
        host, port = getattr(self, '_tunnel_host', None) or self.host, getattr(self, '_tunnel_port', None) or self.port
        https = isinstance(self, getattr(module, 'HTTPSConnection', ())) or bool(getattr(self, '_tunnel_host', None))
        default = module.HTTPS_PORT if https else module.HTTP_PORT
        netloc = ('[%s]' % host if ':' in host else host) + ('' if port in (None, default) else ':%d' % port)
        return '%s://%s%s' % ('https' if https else 'http', netloc, target)

    @functools.wraps(putrequest)
    def codetac_putrequest(self, method, url, *args, **kwargs):
        self.__dict__.pop('_codetac_exchange', None)
        self._codetac_request = None if _inside.get() else [method, url, []]
        return putrequest(self, method, url, *args, **kwargs)

    @functools.wraps(putheader)
    def codetac_putheader(self, header, *values):
        pending = self.__dict__.get('_codetac_request')
        if pending is not None:
            pending[2].append((header, b', '.join(value if isinstance(value, bytes) else str(value).encode('latin-1', 'replace')
                                                   for value in values)))
        return putheader(self, header, *values)

    @functools.wraps(endheaders)
    def codetac_endheaders(self, message_body=None, *args, **kwargs):
        pending = self.__dict__.pop('_codetac_request', None)
        exchange = None
        if pending is not None:
            library = 'urllib3' if type(self).__module__.startswith(('urllib3', 'botocore')) else 'http.client'
            try:
                url = url_of(self, pending[1] if isinstance(pending[1], str) else pending[1].decode('latin-1'))
            except Exception:
                url = '[invalid]'
            exchange = start_exchange(library, pending[0], url, _header_map(pending[2]), message_body)
        try:
            result = endheaders(self, message_body, *args, **kwargs)
        except BaseException:
            if exchange is not None:
                exchange.finish(error=True)
            raise
        if exchange is not None:
            self._codetac_exchange = exchange
        return result

    @functools.wraps(getresponse)
    def codetac_getresponse(self, *args, **kwargs):
        exchange = self.__dict__.pop('_codetac_exchange', None)
        try:
            response = getresponse(self, *args, **kwargs)
        except BaseException:
            if exchange is not None:
                exchange.finish(error=True)
            raise
        if exchange is not None:
            # The status line and headers: the body is read later by the
            # caller (usage and excerpts of AI are not read here: M65).
            exchange.status = getattr(response, 'status', None)
            exchange.finish()
        return response

    for name, wrapper in (('putrequest', codetac_putrequest), ('putheader', codetac_putheader),
                          ('endheaders', codetac_endheaders), ('getresponse', codetac_getresponse)):
        wrapper.__codetac__ = True
        setattr(connection, name, wrapper)


# httpx (and the SDKs of OpenAI and Anthropic) --------------------------------------------

def _httpx_exchange(library, request):
    try:
        body = request.content
    except Exception:  # a streamed body not read yet
        body = None
    return start_exchange(library, request.method, str(request.url), _header_map(request.headers.raw), body)


def _patch_httpx(module, library='httpx'):
    """httpx, and httpx2 (its successor, used by the openai and anthropic SDKs), with the same API."""
    sync, asynchronous = module.HTTPTransport, module.AsyncHTTPTransport
    if getattr(sync.handle_request, '__codetac__', False):
        return

    class Stream(module.SyncByteStream):
        """The response body, followed to its end (or close)."""

        def __init__(self, stream, exchange):
            self._stream, self._exchange = stream, exchange

        def __iter__(self):
            try:
                for chunk in self._stream:
                    self._exchange.collect(chunk)
                    yield chunk
            except Exception:
                self._exchange.finish(error=True)
                raise
            self._exchange.finish()

        def close(self):
            try:
                self._stream.close()
            finally:
                self._exchange.finish()

    class AsyncStream(module.AsyncByteStream):
        def __init__(self, stream, exchange):
            self._stream, self._exchange = stream, exchange

        async def __aiter__(self):
            try:
                async for chunk in self._stream:
                    self._exchange.collect(chunk)
                    yield chunk
            except Exception:
                self._exchange.finish(error=True)
                raise
            self._exchange.finish()

        async def aclose(self):
            try:
                await self._stream.aclose()
            finally:
                self._exchange.finish()

    handle_request = sync.handle_request
    handle_async_request = asynchronous.handle_async_request

    @functools.wraps(handle_request)
    def codetac_handle_request(self, request):
        exchange = _httpx_exchange(library, request)
        if exchange is None:
            return handle_request(self, request)
        try:
            response = handle_request(self, request)
        except BaseException:
            exchange.finish(error=True)
            raise
        exchange.status, exchange.encoding = response.status_code, response.headers.get('content-encoding')
        response.stream = Stream(response.stream, exchange)
        return response

    @functools.wraps(handle_async_request)
    async def codetac_handle_async_request(self, request):
        exchange = _httpx_exchange(library, request)
        if exchange is None:
            return await handle_async_request(self, request)
        try:
            response = await handle_async_request(self, request)
        except BaseException:
            exchange.finish(error=True)
            raise
        exchange.status, exchange.encoding = response.status_code, response.headers.get('content-encoding')
        response.stream = AsyncStream(response.stream, exchange)
        return response

    codetac_handle_request.__codetac__ = codetac_handle_async_request.__codetac__ = True
    sync.handle_request = codetac_handle_request
    asynchronous.handle_async_request = codetac_handle_async_request


# aiohttp (client) ------------------------------------------------------------------------

def _patch_aiohttp(module):
    session, response_class = module.ClientSession, module.ClientResponse
    if getattr(session._request, '__codetac__', False):
        return
    request = session._request
    read = response_class.read
    # AI responses waiting for their body; a response never read is dropped with it.
    pending = weakref.WeakKeyDictionary()

    def describe(self, method, str_or_url, kwargs):
        url = str(str_or_url)
        base = getattr(self, '_base_url', None)
        if base is not None and '://' not in url:
            url = str(base.join(module.URL(url)))
        params = kwargs.get('params')
        if params:
            query = params if isinstance(params, str) else urlencode(list(params.items()) if hasattr(params, 'items') else list(params))
            url += ('&' if '?' in url else '?') + query
        headers = []
        for source in (getattr(self, '_default_headers', None), kwargs.get('headers')):
            if source:
                headers.extend(source.items() if hasattr(source, 'items') else source)
        body = kwargs.get('data')
        if kwargs.get('json') is not None:
            body = json.dumps(kwargs['json'])
        return start_exchange('aiohttp', method, url, _header_map(headers), body if isinstance(body, (str, bytes)) else None)

    @functools.wraps(request)
    async def codetac_request(self, method, str_or_url, **kwargs):
        try:
            exchange = describe(self, method, str_or_url, kwargs)
        except Exception:
            exchange = None
        if exchange is None:
            return await request(self, method, str_or_url, **kwargs)
        try:
            response = await request(self, method, str_or_url, **kwargs)
        except BaseException:
            exchange.finish(error=True)
            raise
        exchange.status = response.status
        if exchange.ai:
            try:
                pending[response] = exchange
                return response
            except TypeError:  # not weak-referenceable in this version: no usage
                exchange.ai = False
        exchange.finish()
        return response

    @functools.wraps(read)
    async def codetac_read(self):
        exchange = pending.pop(self, None)
        if exchange is None:
            return await read(self)
        try:
            body = await read(self)  # already decompressed by aiohttp
        except BaseException:
            exchange.finish(error=True)
            raise
        exchange.collect(body[:LIMIT])
        exchange.finish()
        return body

    codetac_request.__codetac__ = codetac_read.__codetac__ = True
    session._request = codetac_request
    response_class.read = codetac_read


# boto3 / botocore -------------------------------------------------------------------------

def _aws_details(service, request):
    headers = _header_map(request.headers.items())
    if service == 's3':
        details = classify_http(request.method, request.url, headers, None, 'botocore')
        if details['kind'] == 'ficheiros':
            return details
    parsed, path, keys = split_url(request.url)
    return {'kind': 'http', 'library': 'botocore', 'provider': 'AWS %s' % service, 'method': request.method,
            'host': parsed[0] if parsed else '', 'path': path, 'queryKeys': keys}


def _patch_botocore(module):
    endpoint = module.Endpoint
    send = endpoint._send
    if getattr(send, '__codetac__', False):
        return

    @functools.wraps(send)
    def codetac_send(self, request):
        if _inside.get():
            return send(self, request)
        try:
            end = start_boundary(_aws_details(getattr(self, '_endpoint_prefix', None) or '?', request))
        except Exception:
            return send(self, request)
        token = _inside.set(True)  # urllib3 underneath is the same exchange
        try:
            response = send(self, request)
        except BaseException:
            end({'error': True})
            raise
        finally:
            _inside.reset(token)
        end({'status': getattr(response, 'status_code', None)})
        return response

    codetac_send.__codetac__ = True
    endpoint._send = codetac_send


# smtplib --------------------------------------------------------------------------------
# Only the recipients (redacted when written) and their count: never the
# sender, the subject or the message.

def _patch_smtplib(module):
    smtp = module.SMTP
    sendmail = smtp.sendmail
    if getattr(sendmail, '__codetac__', False):
        return

    @functools.wraps(sendmail)
    def codetac_sendmail(self, from_addr, to_addrs, *args, **kwargs):
        if _inside.get():
            return sendmail(self, from_addr, to_addrs, *args, **kwargs)
        try:
            if not isinstance(to_addrs, (str, bytes)):
                to_addrs = list(to_addrs)  # an iterator is read once, here
            items = [to_addrs] if isinstance(to_addrs, (str, bytes)) else to_addrs
            recipients = [item.decode('utf-8', 'replace') if isinstance(item, bytes) else str(item) for item in items]
            end = start_boundary({'kind': 'email', 'library': 'smtplib', 'provider': 'SMTP', 'host': str(getattr(self, '_host', '') or ''),
                                  'to': recipients, 'count': len(recipients)})
        except Exception:
            return sendmail(self, from_addr, to_addrs, *args, **kwargs)
        token = _inside.set(True)
        try:
            refused = sendmail(self, from_addr, to_addrs, *args, **kwargs)
        except BaseException:
            end({'error': True})
            raise
        finally:
            _inside.reset(token)
        rejected = len(refused) if isinstance(refused, dict) else 0
        end({'accepted': len(recipients) - rejected, 'rejected': rejected})
        return refused

    codetac_sendmail.__codetac__ = True
    smtp.sendmail = codetac_sendmail


def install():
    register('http.client', _patch_http_client)
    register('httpx', _patch_httpx)
    register('httpx2', functools.partial(_patch_httpx, library='httpx2'))
    register('aiohttp.client', _patch_aiohttp)
    register('botocore.endpoint', _patch_botocore)
    register('smtplib', _patch_smtplib)
