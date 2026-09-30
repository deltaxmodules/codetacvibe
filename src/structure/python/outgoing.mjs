// What a Python project reads from the environment and sends out of the
// machine (phase 11, step 6), from the facts of extract.py. It gives, per
// file, the same shapes the Node reader's modules give — `env` [{ name, line }],
// `outgoing` [{ host | env, line }], `sdk` [{ package, name, line, first,
// options }] — so the Node reader's environment() and outgoingServices() make
// the env and service nodes and edges the same way.
//
// Variables: os.environ[…], os.getenv(…), os.environ.get(…), and the fields of
// pydantic-settings BaseSettings classes (DATABASE_URL for database_url, with
// the class's env_prefix). HTTP: requests, httpx, urllib.request, and clients
// (httpx.Client/AsyncClient, requests.Session, aiohttp.ClientSession, with or
// without `with … as`), with base_url. SDKs: the "python" entries of the
// service catalogue. Databases: create_engine/create_async_engine of
// SQLAlchemy/SQLModel, as the service of the project's store.
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request', 'stream'];
const HTTP_MODULES = ['requests', 'httpx'];
const CLIENTS = new Set(['httpx.Client', 'httpx.AsyncClient', 'requests.Session', 'requests.session', 'aiohttp.ClientSession']);
const ENGINES = new Set(['sqlalchemy.create_engine', 'sqlalchemy.ext.asyncio.create_async_engine', 'sqlmodel.create_engine', 'sqlalchemy.engine.create_engine']);
const NETWORK_STORES = new Set(['postgres', 'mysql']);
const last = name => name.split('.').pop();
const text = value => (value?.t === 'str' ? value.v : null);

// The host of an absolute URL, or null.
export function hostOf(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(String(url ?? ''));
  return match ? match[1].toLowerCase() : null;
}

// Settings classes (BaseSettings) of the project and the instances made of
// them: which variable `settings.database_url` is.
export function settingsOf(facts) {
  const classes = new Map();
  for (const [path, item] of facts) {
    for (const definition of item.definitions ?? []) {
      if (definition.kind !== 'class' || !(definition.bases ?? []).some(base => base?.t === 'name' && last(base.v) === 'BaseSettings')) continue;
      const body = (item.assignments ?? []).filter(assignment => assignment.scope === definition.qualname);
      const config = (item.assignments ?? []).find(assignment => (assignment.scope === definition.qualname && assignment.targets[0]?.v === 'model_config'))?.value;
      const nested = (item.assignments ?? []).find(assignment => assignment.scope === `${definition.qualname}.Config` && assignment.targets[0]?.v === 'env_prefix');
      const prefix = text(config?.kw?.env_prefix) ?? text(nested?.value) ?? '';
      const fields = new Map();
      for (const assignment of body) {
        const name = assignment.targets[0]?.t === 'name' ? assignment.targets[0].v : null;
        if (!name || !assignment.annotation || name === 'model_config' || name.startsWith('_')) continue;
        const alias = assignment.value?.t === 'call' && last(assignment.value.func?.v ?? '') === 'Field' ? text(assignment.value.kw.alias) ?? text(assignment.value.kw.validation_alias) : null;
        fields.set(name, { env: alias ?? `${prefix}${name}`.toUpperCase(), line: assignment.line });
      }
      classes.set(`${path}#${definition.qualname}`, { path, fields });
    }
  }
  const instances = new Map();
  for (const [path, item] of facts) {
    for (const assignment of item.assignments ?? []) {
      const target = assignment.targets[0]?.t === 'name' ? assignment.targets[0].v : null;
      const called = assignment.value?.t === 'call' && assignment.value.func?.t === 'name' ? assignment.value.func.v : null;
      if (!target || assignment.scope || !called) continue;
      instances.set(`${path}::${target}`, { path, called });
    }
  }
  return { classes, instances };
}

export function pythonUsage(files, facts, modules, { catalogue, store = 'sql' }) {
  const settings = settingsOf(facts);
  const usage = new Map();
  // The settings class a name means in a file (a class of the file or imported).
  const classOf = (path, name) => {
    if (settings.classes.has(`${path}#${name}`)) return settings.classes.get(`${path}#${name}`);
    const bound = modules.get(path)?.bindings.get(name);
    return bound && !bound.module ? settings.classes.get(`${bound.target}#${bound.name}`) ?? null : null;
  };
  // settings.field → the variable, following an imported instance.
  const settingsField = (path, dotted) => {
    const [head, field, ...rest] = dotted.split('.');
    if (!field || rest.length) return null;
    let instance = settings.instances.get(`${path}::${head}`);
    let where = path;
    if (!instance) {
      const bound = modules.get(path)?.bindings.get(head);
      if (bound && !bound.module) { instance = settings.instances.get(`${bound.target}::${bound.name}`); where = bound.target; }
    }
    const found = instance && classOf(where, instance.called);
    return found?.fields.get(field)?.env ?? null;
  };
  for (const file of files) {
    const item = facts.get(file.path);
    if (!item || item.error) continue;
    const module = modules.get(file.path);
    const env = [];
    const outgoing = [];
    const sdk = [];
    for (const read of item.environ ?? []) env.push({ name: read.name, line: read.line });
    for (const found of settings.classes.values()) if (found.path === file.path) for (const field of found.fields.values()) env.push({ name: field.env, line: field.line });

    // External modules by local name: import httpx as h → h = httpx; from twilio.rest import Client → Client = twilio.rest.Client.
    const aliases = new Map();
    for (const entry of item.imports ?? []) {
      if (entry.level) continue;
      if (!entry.names) aliases.set(entry.as ?? entry.module.split('.')[0], entry.as ? entry.module : entry.module.split('.')[0]);
      else for (const { name, as } of entry.names) if (name !== '*') aliases.set(as ?? name, `${entry.module}.${name}`);
    }
    const full = dotted => {
      if (!dotted) return null;
      const [head, ...rest] = dotted.split('.');
      return aliases.has(head) ? [aliases.get(head), ...rest].join('.') : null;
    };
    // Module-level text constants (BASE_URL = 'https://…') of this file.
    const constants = new Map();
    for (const assignment of item.assignments ?? []) {
      const target = assignment.targets.length === 1 && assignment.targets[0]?.t === 'name' ? assignment.targets[0].v : null;
      if (target && !assignment.scope) constants.set(target, assignment.value);
    }
    // Where a value sends to: { host } | { env } | null.
    const destination = (value, depth = 0) => {
      if (!value || depth > 3) return null;
      if (value.t === 'str') return hostOf(value.v) ? { host: hostOf(value.v) } : null;
      if (value.t === 'fstr') {
        // f"https://api.x.com/v1/{id}": the host is whole before the first value; f"{BASE_URL}/x": the value it starts with.
        const before = value.v.split('{')[0];
        if (/^[a-z]+:\/\/[^/:?#]+[/:?#]/i.test(before)) return { host: hostOf(before) };
        return value.head ? destination(value.head, depth + 1) : null;
      }
      if (value.t === 'call' && value.func?.t === 'name' && ['os.getenv', 'getenv', 'os.environ.get', 'environ.get'].includes(value.func.v) && text(value.args[0])) return { env: text(value.args[0]) };
      if (value.t === 'sub' && ['os.environ', 'environ'].includes(value.of?.v) && text(value.key)) return { env: text(value.key) };
      if (value.t === 'name') {
        const variable = settingsField(file.path, value.v);
        if (variable) return { env: variable };
        if (!value.v.includes('.') && constants.has(value.v)) return destination(constants.get(value.v), depth + 1);
        const bound = module?.bindings.get(value.v);
        if (bound && !bound.module) {
          const other = facts.get(bound.target);
          const assigned = (other?.assignments ?? []).find(assignment => !assignment.scope && assignment.targets[0]?.v === bound.name);
          if (assigned) return destination(assigned.value, depth + 1);
        }
      }
      return null;
    };
    const info = value => { const found = destination(value); return found ? (found.host ? { host: found.host } : { env: found.env }) : null; };
    // HTTP clients bound to a name (module level or in a function), with their base_url.
    const clients = new Map();
    for (const assignment of item.assignments ?? []) {
      const target = assignment.targets[0]?.t === 'name' ? assignment.targets[0].v : null;
      const called = assignment.value?.t === 'call' && assignment.value.func?.t === 'name' ? full(assignment.value.func.v) : null;
      if (target && called && CLIENTS.has(called)) clients.set(`${assignment.scope ?? ''}:${target}`, assignment.value.kw.base_url ?? null);
    }
    const clientOf = (scope, name) => {
      for (let current = scope; ; current = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '') {
        if (clients.has(`${current}:${name}`)) return { base: clients.get(`${current}:${name}`) };
        if (!current) return null;
      }
    };
    for (const call of item.calls ?? []) {
      const dotted = call.func?.t === 'name' ? call.func.v : null;
      const name = full(dotted);
      const verb = dotted ? last(dotted) : null;
      // requests.post(url), httpx.get(url), requests.request(method, url), urllib.request.urlopen(url).
      let url = null;
      let http = false;
      if (name && HTTP_MODULES.includes(name.split('.')[0]) && name.split('.').length === 2 && HTTP_VERBS.includes(verb)) {
        http = true;
        url = verb === 'request' || verb === 'stream' ? call.args[1] ?? call.kw.url : call.args[0] ?? call.kw.url;
      } else if (name === 'urllib.request.urlopen' || name === 'urllib.request.Request' || name === 'aiohttp.request') {
        http = true;
        url = name === 'aiohttp.request' ? call.args[1] ?? call.kw.url : call.args[0] ?? call.kw.url;
      } else if (dotted && dotted.split('.').length === 2 && HTTP_VERBS.includes(verb)) {
        const client = clientOf(call.scope ?? '', dotted.split('.')[0]);
        if (client) {
          http = true;
          const given = verb === 'request' || verb === 'stream' ? call.args[1] ?? call.kw.url : call.args[0] ?? call.kw.url;
          url = given && info(given) ? given : client.base ?? given;
        }
      }
      if (http) {
        const found = info(url);
        if (found) outgoing.push({ ...found, line: call.line });
        continue;
      }
      if (!name) continue;
      // A database engine: the service of the project's store (a literal URL's scheme wins).
      if (ENGINES.has(name)) {
        const given = text(call.args[0]);
        const scheme = given ? /^(postgres|postgresql|mysql|mariadb)/i.exec(given)?.[1].toLowerCase() : null;
        const service = scheme ? (scheme.startsWith('postgres') ? 'postgres' : 'mysql') : store;
        if (NETWORK_STORES.has(service)) sdk.push({ package: 'py:database', name: service, line: call.line, ...(info(call.args[0]) ? { first: info(call.args[0]) } : {}) });
        continue;
      }
      // A client or a call of an SDK of the catalogue: module.name(…), or a name imported from the module.
      const parts = name.split('.');
      for (let cut = parts.length - 1; cut > 0; cut--) {
        const pythonModule = parts.slice(0, cut).join('.');
        if (!catalogue.pythonModules.has(pythonModule)) continue;
        const called = parts[cut];
        const service = catalogue.byPython(pythonModule, called);
        if (!service) break;
        const options = Object.fromEntries(Object.entries(call.kw).map(([key, value]) => [key, info(value)]).filter(([, value]) => value));
        if (options.conninfo || options.dsn) options.connectionString = options.conninfo ?? options.dsn;
        sdk.push({ package: `py:${pythonModule}`, name: service.python.find(item => item.module === pythonModule)?.create.includes(called) ? called : '*', line: call.line,
          ...(info(call.args[0]) ? { first: info(call.args[0]) } : {}), ...(Object.keys(options).length ? { options } : {}) });
        break;
      }
    }
    usage.set(file.path, { env, outgoing, sdk, keys: item.keys ?? [] });
  }
  return usage;
}

// The catalogue as the Node reader's outgoingServices() asks it: Python SDK
// calls come as package "py:<module>", database engines as "py:database".
export function pythonCatalogue(catalogue) {
  return { ...catalogue, bySdk: (pkg, name) => (pkg === 'py:database' ? catalogue.byId(name)
    : pkg.startsWith('py:') ? catalogue.byPython(pkg.slice(3), name) : catalogue.bySdk(pkg, name)) };
}
