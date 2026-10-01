// Blocks of a Python project (phase 11, step 4): the same layers as the Node
// reader, by deterministic rules in order, read from the facts of extract.py.
// The first rule that applies decides and its name is kept with the file; a
// .py file no rule recognises is Unknown. Files that are not Python go
// through the Node reader's rules (.env, HTML, Markdown, JSON…), after the
// Python project files and Jinja templates.
import { basename } from 'node:path';
import { classify as classifyNode } from '../node/classify.mjs';

const META = new Set(['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'pdm.lock',
  'alembic.ini', 'tox.ini', 'pytest.ini', 'mypy.ini', '.flake8', '.python-version', 'runtime.txt', 'MANIFEST.in', 'noxfile.py']);
const DATABASE_MODULES = new Set(['sqlalchemy', 'flask_sqlalchemy', 'sqlmodel', 'psycopg', 'psycopg2', 'asyncpg', 'aiosqlite', 'sqlite3', 'pymysql', 'MySQLdb',
  'mysql', 'pymongo', 'motor', 'mongoengine', 'redis', 'databases', 'peewee', 'tortoise', 'supabase', 'prisma']);
// Calls that open a database connection or session (the client file).
const DATABASE_OPENERS = new Set(['create_engine', 'create_async_engine', 'sessionmaker', 'async_sessionmaker', 'scoped_session', 'SQLAlchemy', 'connect',
  'MongoClient', 'AsyncIOMotorClient', 'Redis', 'from_url', 'create_pool', 'Database', 'create_client', 'Prisma']);
const HTTP_MODULES = new Set(['requests', 'httpx', 'aiohttp', 'urllib3']);
const SERVICE_MODULES = new Set(['openai', 'anthropic', 'google', 'mistralai', 'groq', 'cohere', 'replicate', 'stripe', 'resend', 'sendgrid', 'postmark',
  'twilio', 'boto3', 'botocore', 'cloudinary', 'posthog', 'sentry_sdk', 'mixpanel', 'algoliasearch', 'mailgun', 'smtplib']);
const APPS = new Set(['FastAPI', 'Flask', 'Starlette', 'Quart']);
const ROUTE_VERBS = /\.(get|post|put|patch|delete|options|head|route|api_route)$/;
const MODEL_BASES = /(^|\.)(Base|Model|DeclarativeBase|SQLModel|Document)$/;
const HOOKS = /\.(app_errorhandler|errorhandler|exception_handler|before_request|after_request|before_app_request|after_app_request|teardown_request|teardown_appcontext|middleware)$/;
const MAIL_MODULES = new Set(['flask_mail', 'fastapi_mail', 'emails', 'yagmail', 'aiosmtplib', 'smtplib']);

const folders = path => path.split('/').slice(0, -1).map(folder => folder.toLowerCase());
const inFolder = (path, names) => folders(path).some(folder => names.includes(folder));
const last = name => name.split('.').pop();
const topModules = item => new Set((item.imports ?? []).filter(entry => !entry.level).map(entry => entry.module.split('.')[0]));
const callNames = item => (item.calls ?? []).filter(call => call.func?.t === 'name').map(call => last(call.func.v));
const baseNames = definition => (definition.bases ?? []).filter(base => base?.t === 'name').map(base => base.v);
const decorated = (item, pattern) => (item.definitions ?? []).some(definition => definition.decorators.some(decorator => {
  const name = decorator?.t === 'call' ? decorator.func : decorator;
  return name?.t === 'name' && pattern.test(name.v);
}));
const isEmpty = item => !item.definitions?.length && !item.imports?.length && !item.assignments?.length && !item.calls?.length;

// The rules for .py files. Each returns [layer, rule] or null.
const RULES = [
  (file, item) => basename(file.path) === '__init__.py' && isEmpty(item) && ['config', 'python:package-marker'],
  (file) => (/^test_.*\.py$|_test\.py$|^conftest\.py$|^tests?\.py$/.test(basename(file.path)) || inFolder(file.local, ['tests', 'test'])) && ['tests', 'test-file'],
  (file) => META.has(basename(file.path)) && ['config', 'project-meta'],
  (file, item) => (inFolder(file.local, ['migrations', 'alembic']) || topModules(item).has('alembic')) && ['data', 'python:alembic-migration'],
  (file, item) => ((item.definitions ?? []).some(definition => baseNames(definition).some(base => last(base) === 'BaseSettings'))
    || /^(settings|config)\.py$/.test(basename(file.path)) || inFolder(file.local, ['config', 'settings'])) && ['config', 'python:settings'],
  (file, item) => callNames(item).some(name => APPS.has(name)) && ['routes', 'python:app-entry'],
  (file, item) => (item.definitions ?? []).some(definition => definition.decorators.some(decorator => decorator?.t === 'call'
    && decorator.func?.t === 'name' && ROUTE_VERBS.test(decorator.func.v))) && ['routes', 'python:routes'],
  // Request hooks and error pages (@bp.app_errorhandler(404), @app.before_request…): the request's path.
  (file, item) => decorated(item, HOOKS) && ['routes', 'python:request-hooks'],
  // Terminal commands (click, typer, @bp.cli.command()): project tooling.
  (file, item) => ([...topModules(item)].some(name => name === 'click' || name === 'typer') || decorated(item, /\.cli\.(command|group)$/)) && ['config', 'python:cli'],
  // A package that creates a blueprint or a router (bp = Blueprint('auth', __name__)).
  (file, item) => callNames(item).some(name => name === 'Blueprint' || name === 'APIRouter') && ['routes', 'python:blueprint'],
  (file) => inFolder(file.local, ['routers', 'routes', 'api', 'endpoints', 'views', 'blueprints', 'controllers', 'handlers']) && ['routes', 'folder:routers'],
  (file, item) => ((item.definitions ?? []).some(definition => definition.kind === 'class' && (baseNames(definition).some(base => MODEL_BASES.test(base))
    && (item.assignments ?? []).some(assignment => assignment.scope === definition.qualname && assignment.targets[0]?.v === '__tablename__')
    || baseNames(definition).some(base => last(base) === 'SQLModel') && definition.keywords?.table?.v === true))
    || /^models?\.py$/.test(basename(file.path)) || inFolder(file.local, ['models'])) && ['data', 'python:models'],
  (file, item) => [...topModules(item)].some(name => DATABASE_MODULES.has(name)) && callNames(item).some(name => DATABASE_OPENERS.has(name))
    && ['data', 'database-client'],
  (file, item, context) => (context.importsOf.get(file.path) ?? []).some(target => context.data.has(target))
    && ['data', 'database-queries'],
  // Folders of data access (db/, repositories/, crud/, queries/), when nothing above decided.
  (file) => inFolder(file.local, ['db', 'database', 'repositories', 'repository', 'crud', 'queries', 'dal']) && ['data', 'folder:data'],
  (file) => (/^schemas?\.py$/.test(basename(file.path)) || inFolder(file.local, ['schemas'])) && ['logic', 'python:schemas'],
  (file) => inFolder(file.local, ['services', 'usecases', 'use_cases', 'domain', 'actions']) && ['logic', 'folder:services'],
  (file) => (inFolder(file.local, ['utils', 'util', 'helpers', 'helper', 'shared', 'common']) || /(^|_)(utils?|helpers?)(_|\.py$)/.test(basename(file.path)))
    && ['utilities', 'utilities'],
  (file, item) => [...topModules(item)].some(name => HTTP_MODULES.has(name) || SERVICE_MODULES.has(name)) && ['external', 'outgoing-call'],
  // Email (Flask-Mail, emails, an email.py) and search engines reached through the app (current_app.elasticsearch.index…).
  (file, item) => ([...topModules(item)].some(name => MAIL_MODULES.has(name)) || /^(e?mails?|mailer)\.py$/.test(basename(file.path))) && ['external', 'python:email'],
  (file, item) => (item.calls ?? []).some(call => call.func?.t === 'name' && /(^|\.)(elasticsearch|opensearch|meilisearch)(\.|$)/i.test(call.func.v)) && ['external', 'python:search'],
  (file) => /^(scripts|bin|tools)\//.test(file.local) && ['config', 'folder:scripts'],
  (file) => inFolder(file.local, ['core', 'lib', 'logic', 'modules', 'features']) && ['logic', 'folder:lib'],
];

// Rules for files that are not Python, before the Node reader's.
const OTHER_RULES = [
  (file) => META.has(basename(file.path)) || /^requirements.*\.txt$/.test(basename(file.path)) ? ['config', 'project-meta'] : null,
  (file) => file.language === 'html' && inFolder(file.path, ['templates']) ? ['interface', 'python:template', 'client'] : null,
  (file) => inFolder(file.path, ['migrations', 'alembic']) && /\.(mako|ini)$/.test(file.path) ? ['data', 'python:alembic-migration'] : null,
];

// Classifies every file: [{ path, layer, rule, runsOn? }]. `modules` gives
// the project imports of each .py file (python/modules.mjs).
// Folder rules look at the path inside the Python part (api/services/x.py is
// services/x.py of the part api/: api/ is where the part is, not a folder of routes).
export function classifyPython(files, facts, modules, { folders = [''] } = {}) {
  const part = path => folders.filter(folder => folder && path.startsWith(`${folder}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
  const local = file => ({ ...file, local: part(file.path) ? file.path.slice(part(file.path).length + 1) : file.path });
  const python = files.filter(file => file.language === 'python');
  const others = files.filter(file => file.language !== 'python');
  const decided = new Map();
  const context = { importsOf: new Map([...modules].map(([path, module]) => [path, module.imports.map(entry => entry.target)])), data: new Set() };
  // Two passes: the files that define the data (clients and models) first, so
  // a file importing them is known to query the database.
  const decide = given => {
    const file = local(given);
    const item = facts.get(file.path);
    if (!item || item.error) return ['unknown', item?.error ? 'unreadable' : 'unread'];
    for (const rule of RULES) {
      const found = rule(file, item, context);
      if (found) return found;
    }
    return ['unknown', 'no-rule'];
  };
  for (const file of python) {
    const [, rule] = decide(file);
    if (rule === 'database-client' || rule === 'python:models') context.data.add(file.path);
  }
  for (const file of python) {
    const [layer, rule] = decide(file);
    const where = ['project-meta', 'python:package-marker', 'python:alembic-migration'].includes(rule) ? null : 'server';
    decided.set(file.path, { path: file.path, layer, rule, ...(where ? { runsOn: where } : {}) });
  }
  const byNode = new Map(classifyNode(others, new Map()).map(item => [item.path, item]));
  for (const file of others) {
    let found = null;
    for (const rule of OTHER_RULES) { found = rule(file); if (found) break; }
    decided.set(file.path, found ? { path: file.path, layer: found[0], rule: found[1], ...(found[2] ? { runsOn: found[2] } : {}) } : byNode.get(file.path));
  }
  return files.map(file => decided.get(file.path));
}
