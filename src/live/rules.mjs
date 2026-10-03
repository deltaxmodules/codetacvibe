// Live mode, phase L2: each event of the log (events.mjs) → a short sentence
// in plain English, by fixed rules (no AI): what kind of tool, which folder
// and file, which command, which package, whether it worked. Each sentence
// keeps the rule that gave it and the area of the project it touches
// (interface, server, database, configuration, tests), which the steps of
// L4a group by. An event no rule knows gets no sentence: it is listed by
// `codetac live replay`, to write the next rule (never guessed).
//
// The sentences are for the start of an action (what the assistant is doing
// now), for a failure, and for a notification. The end of an action gives no
// sentence of its own; it says whether the action worked.
import { basename, extname } from 'node:path';
import { t } from '../structure/text.mjs';
import { packageName, packagePurpose } from './packages.mjs';

export const AREAS = ['interface', 'server', 'database', 'configuration', 'tests', 'analysis', 'other'];
const MAX_WORDS = 10;
const NAME_WORDS = 4;

const say = (key, vars) => t(`live.say.${key}`, vars);

// "LoginForm", "user-profile", "auth_callback" → "login form", "user profile", "auth callback".
export function words(name) {
  return String(name ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, NAME_WORDS).join(' ');
}

// The folders of a path that name something: no route groups "(auth)", no
// dynamic parts "[id]", no "src", "app", "pages".
const MEANINGLESS = new Set(['src', 'app', 'pages', 'api', 'routes', 'components', 'ui', 'lib', 'server', 'client', 'views', 'screens', 'features', 'modules', '']);
const meaningful = path => path.split('/').slice(0, -1).filter(part => !/^\(.*\)$/.test(part) && !/^\[.*\]$/.test(part) && !part.startsWith('@') && !MEANINGLESS.has(part.toLowerCase()));

const UI_EXT = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less']);
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.rb', '.php', '.rs', '.java', '.kt']);
const CONFIG_FILES = /^(tsconfig.*\.json|jsconfig\.json|\.eslintrc.*|\.prettierrc.*|\.babelrc|Dockerfile|docker-compose\.ya?ml|vercel\.json|netlify\.toml|components\.json|\.gitignore|\.npmrc|\.nvmrc|requirements.*\.txt|pyproject\.toml|setup\.cfg|Procfile|turbo\.json|.*\.config\.[mc]?[jt]s|.*\.config\.json)$/;
const DEPENDENCY_FILES = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'Gemfile', 'Cargo.toml']);
const LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'uv.lock']);
const inFolder = (path, names) => path.toLowerCase().split('/').slice(0, -1).some(part => names.includes(part));

// What a file is, from its path: { kind, name } (name in words, may be '').
export function fileKind(path) {
  const file = basename(path);
  const ext = extname(file).toLowerCase();
  const lower = path.toLowerCase();
  if (file.startsWith('.env')) return { kind: 'env' };
  if (LOCK_FILES.has(file)) return { kind: 'lock' };
  if (DEPENDENCY_FILES.has(file)) return { kind: 'dependencies' };
  if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(file) || /^test_.*\.py$|_test\.(py|go)$/.test(file) || inFolder(path, ['__tests__', 'test', 'tests', 'e2e', 'cypress', 'playwright'])) {
    return { kind: 'test', name: words(file.replace(/\.(test|spec)(?=\.)/, '').replace(/^test_/, '').replace(/_test(?=\.)/, '')) };
  }
  if (ext === '.sql' || ext === '.prisma' || inFolder(path, ['migrations', 'migration', 'alembic']) || /(^|\/)(schema|models?)\.(ts|js|py)$/.test(lower) || /(^|\/)drizzle\//.test(lower)) return { kind: 'database' };
  if (CONFIG_FILES.test(file)) return { kind: 'config' };
  if (ext === '.md' || ext === '.mdx' || ext === '.txt') return { kind: 'docs' };
  if (STYLE_EXT.has(ext)) return { kind: 'styles' };
  // Server endpoints: Next.js app/api/**/route.ts, pages/api/**, routes/, api/ folders, FastAPI/Flask routers.
  if (/(^|\/)route\.[mc]?[jt]s$/.test(lower) || /(^|\/)pages\/api\//.test(lower) || (CODE_EXT.has(ext) && inFolder(path, ['api', 'routes', 'routers', 'endpoints', 'controllers', 'handlers']))) {
    const parts = meaningful(path);
    const own = /^(route|index|router|routes|handler)$/.test(file.replace(/\.[^.]+$/, '')) ? '' : file;
    return { kind: 'route', name: words(own || parts.slice(-2).join(' ')) };
  }
  // Pages: Next.js page.tsx (named by their folder), pages/*.tsx, src/views, src/screens.
  if (/^page\.[jt]sx?$/.test(file) || (UI_EXT.has(ext) && inFolder(path, ['pages', 'views', 'screens']))) {
    const parts = meaningful(path);
    const own = /^(page|index)$/.test(file.replace(/\.[^.]+$/, '')) ? '' : file;
    return { kind: 'page', name: words(own || parts.at(-1) || 'home') };
  }
  if (/^layout\.[jt]sx?$/.test(file)) return { kind: 'layout' };
  if (UI_EXT.has(ext)) {
    const own = /^index$/.test(file.replace(/\.[^.]+$/, '')) ? meaningful(path).at(-1) : file;
    return { kind: 'component', name: words(own) };
  }
  if (CODE_EXT.has(ext) && (inFolder(path, ['db', 'database', 'repositories', 'repository', 'dal', 'data', 'models', 'prisma']) || /(^|\/)(db|database|prisma|supabase)\.[mc]?[jt]s$/.test(lower))) return { kind: 'data' };
  if (CODE_EXT.has(ext)) return { kind: 'code', name: file === `index${ext}` && meaningful(path).length ? `${meaningful(path).at(-1)}/${file}` : file };
  return { kind: 'other', name: file };
}

const FILE_AREA = { env: 'configuration', lock: 'configuration', dependencies: 'configuration', test: 'tests', database: 'database', config: 'configuration',
  docs: 'other', styles: 'interface', route: 'server', page: 'interface', layout: 'interface', component: 'interface', data: 'database', code: 'server', other: 'other' };

export function fileSentence(tool, path, change) {
  if (!path) return null;
  const { kind, name } = fileKind(path);
  const verb = change ?? (tool === 'Write' ? 'create' : 'change');
  const area = FILE_AREA[kind];
  const named = (key, fallback) => (name ? say(`${key}.${verb}`, { name }) : say(fallback));
  switch (kind) {
    case 'env': case 'config': return { text: say('config'), rule: `file-${kind}`, area };
    case 'lock': return { text: say('dependencies'), rule: 'file-lock', area };
    case 'dependencies': return { text: say('dependencies'), rule: 'file-dependencies', area };
    case 'database': return { text: say('databaseStructure'), rule: 'file-database', area, topic: say('topic.structure') };
    case 'docs': return { text: say('writeDocs'), rule: 'file-docs', area };
    case 'styles': return { text: say('styles'), rule: 'file-styles', area, topic: say('topic.styles') };
    case 'layout': return { text: say('layout'), rule: 'file-layout', area };
    case 'data': return { text: say('data'), rule: 'file-data', area, topic: say('topic.data') };
    case 'test': return { text: named('test', `tests.${verb}`), rule: 'file-test', area, topic: name || undefined };
    case 'route': return { text: named('route', `routeAny.${verb}`), rule: 'file-route', area, topic: name ? say('topic.route', { name }) : undefined };
    case 'page': return { text: say(`page.${verb}`, { name }), rule: 'file-page', area, topic: say('topic.page', { name }) };
    case 'component': return { text: named('component', `componentAny.${verb}`), rule: 'file-component', area, topic: name || undefined };
    case 'code': return { text: named('code', `codeAny.${verb}`), rule: 'file-code', area, generic: true };
    default: return { text: say(`file.${verb}`, { name }), rule: 'file-other', area, generic: true };
  }
}

// The commands of a shell line that do something: "cd app && npm install x | tee log" → [["npm", "install", "x"]].
// Prefixes that say nothing by themselves; and commands whose whole segment says nothing (cd app).
const SKIP = new Set(['time', 'timeout', 'nohup', 'sudo', 'env', 'do', 'then', 'else', '{', '(']);
const NOTHING = new Set(['cd', 'export', 'source', '.', 'set', 'true', 'clear', 'pushd', 'popd', 'unset', 'local', 'shopt']);
// Shell lines that only open or close a loop or a condition.
const SHELL_SYNTAX = /^\s*(for|while|until|if|elif|done|fi|esac|case|function|\}|\))\b/;
export function commands(line) {
  const out = [];
  for (const segment of String(line ?? '').split(/&&|\|\||;|\n/)) {
    if (SHELL_SYNTAX.test(segment)) continue;
    const first = segment.split(/(?<!\|)\|(?!\|)/)[0];
    let parts = first.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    parts = parts.map(part => part.replace(/^(['"])(.*)\1$/, '$2'));
    // Redirections and heredocs (<<'EOF', > file, 2>&1) are not the program nor its arguments; '…' is a heredoc taken out.
    parts = parts.filter(part => !/^(\d?[<>]|&>|<<)/.test(part) && part !== '…');
    while (parts.length && (/^[A-Z_][A-Z0-9_]*=/.test(parts[0]) || SKIP.has(parts[0]))) {
      // "timeout 30 npm test" → drop the number too.
      const skipped = parts.shift();
      if (skipped === 'timeout' && /^\d/.test(parts[0] ?? '')) parts.shift();
    }
    if (parts.length && !NOTHING.has(parts[0])) out.push(parts);
  }
  return out;
}

const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const LOOK = new Set(['ls', 'cat', 'head', 'tail', 'find', 'grep', 'rg', 'tree', 'wc', 'pwd', 'which', 'file', 'stat', 'less', 'du', 'sed', 'awk', 'echo', 'printf', 'jq', 'diff', 'sort', 'uniq', 'xxd', 'od', 'open']);
const FILES = new Set(['mkdir', 'rm', 'mv', 'cp', 'touch', 'chmod', 'ln', 'rmdir', 'unzip', 'tar', 'rsync']);

function scriptSentence(script) {
  const name = script.toLowerCase();
  if (/(^|:)(test|tests|e2e|spec|vitest|jest|playwright|cypress)(:|$)/.test(name)) return { text: say('checkWorks'), rule: 'cmd-test', area: 'tests' };
  if (/(^|:)(build|compile|export)(:|$)/.test(name)) return { text: say('build'), rule: 'cmd-build', area: 'other' };
  if (/(^|:)(lint|format|prettier|typecheck|type-check|check|tsc)(:|$)/.test(name)) return { text: say('lint'), rule: 'cmd-lint', area: 'other' };
  if (/(^|:)(dev|start|serve|preview|watch)(:|$)/.test(name)) return { text: say('start'), rule: 'cmd-start', area: 'other' };
  if (/(^|:)(db|migrate|migration|prisma|drizzle|seed|supabase)(:|$)/.test(name)) return { text: say(/seed/.test(name) ? 'seed' : 'databaseStructure'), rule: 'cmd-database', area: 'database' };
  return { text: say('script', { name: script }), rule: 'cmd-script', area: 'other', generic: true };
}

function installSentence(packages) {
  const names = packages.filter(spec => !spec.startsWith('-')).map(packageName).filter(Boolean);
  if (!names.length) return { text: say('installAll'), rule: 'cmd-install-all', area: 'configuration' };
  const known = names.map(name => [name, packagePurpose(name)]).find(([, purpose]) => purpose);
  if (known) {
    const purpose = known[1];
    const area = purpose === 'database' ? 'database' : purpose === 'testing' ? 'tests' : ['user interface', 'styling', 'icons', 'animation', 'forms', 'charts', 'maps'].includes(purpose) ? 'interface' : ['authentication', 'payments', 'email', 'server', 'security', 'artificial intelligence', 'file storage', 'real-time'].includes(purpose) ? 'server' : 'configuration';
    return { text: purpose === 'type definitions' ? say('installTypes') : say('installKnown', { purpose, article: /^[aeiou]/i.test(purpose) ? 'an' : 'a' }), rule: 'cmd-install-known', area, package: known[0], topic: purpose === 'type definitions' ? undefined : say('topic.library', { purpose }) };
  }
  return { text: say('installUnknown', { name: names[0] }), rule: 'cmd-install-unknown', area: 'configuration', package: names[0] };
}

// One command (program and arguments) → a sentence, or null.
function commandSentence(parts) {
  let [program, ...args] = parts;
  program = basename(program);
  if (RUNNERS.has(program) || (MANAGERS.has(program) && ['dlx', 'exec', 'x'].includes(args[0]))) {
    if (MANAGERS.has(program)) args.shift();
    while (args[0]?.startsWith('-')) args.shift();
    [program, ...args] = args;
    if (!program) return null;
    program = packageName(program);
  }
  const sub = args.find(arg => !arg.startsWith('-'));
  if (MANAGERS.has(program)) {
    if (['install', 'i', 'add', 'ci'].includes(sub)) return installSentence(sub === 'ci' ? [] : args.slice(args.indexOf(sub) + 1));
    if (['uninstall', 'remove', 'rm', 'un'].includes(sub)) return { text: say('uninstall', { name: packageName(args.at(-1) ?? '') }), rule: 'cmd-uninstall', area: 'configuration' };
    if (sub === 'test' || sub === 't') return { text: say('checkWorks'), rule: 'cmd-test', area: 'tests' };
    if (sub === 'run' || sub === 'run-script') return scriptSentence(args[args.indexOf(sub) + 1] ?? '');
    if (['start', 'dev', 'build', 'lint'].includes(sub)) return scriptSentence(sub);
    if (['outdated', 'ls', 'list', 'view', 'info', 'audit', 'why', 'pkg', 'config', '-v', '--version'].includes(sub) || !sub) return { text: say('look'), rule: 'cmd-look', area: 'analysis' };
    if (program !== 'npm') return scriptSentence(sub);
    if (sub === 'publish' || sub === 'pack' || sub === 'version') return { text: say('publish'), rule: 'cmd-publish', area: 'other' };
    return { text: say('run', { name: `npm ${sub}` }), rule: 'cmd-run', area: 'other', generic: true };
  }
  if (['pip', 'pip3', 'uv', 'poetry', 'pipenv'].includes(program)) {
    if (['install', 'add', 'sync'].includes(sub) || (program === 'uv' && sub === 'pip')) {
      const rest = args.filter(arg => !arg.startsWith('-') && !['install', 'add', 'sync', 'pip'].includes(arg) && !/requirements|\.txt$|\.toml$|^\.$/.test(arg));
      return installSentence(rest);
    }
    if (sub === 'run') return commandSentence(args.slice(args.indexOf('run') + 1));
    return { text: say('look'), rule: 'cmd-look', area: 'analysis' };
  }
  if (['jest', 'vitest', 'pytest', 'mocha', 'playwright', 'cypress', 'ava', 'tap'].includes(program) || (program === 'go' && sub === 'test') || (program === 'cargo' && sub === 'test')
    || (/^python3?$/.test(program) && args.includes('pytest')) || (program === 'node' && args.includes('--test'))) return { text: say('checkWorks'), rule: 'cmd-test', area: 'tests' };
  if (['tsc', 'eslint', 'prettier', 'ruff', 'black', 'mypy', 'flake8', 'biome', 'pyright'].includes(program)) return { text: say('lint'), rule: 'cmd-lint', area: 'other' };
  if (program === 'next' || program === 'vite' || program === 'nuxt') return scriptSentence(sub ?? 'dev');
  if (['prisma', 'drizzle-kit', 'supabase', 'alembic', 'knex', 'sequelize'].includes(program)) {
    const generate = /^(generate|studio|format|validate)$/.test(sub ?? '');
    return { text: say(generate ? 'databaseCode' : 'databaseStructure'), rule: 'cmd-database', area: 'database' };
  }
  if (['psql', 'mysql', 'sqlite3', 'mongosh', 'redis-cli'].includes(program)) return { text: say('database'), rule: 'cmd-database-query', area: 'database' };
  if (program === 'git') {
    if (sub === 'commit') return { text: say('gitCommit'), rule: 'cmd-git-commit', area: 'other' };
    if (sub === 'push') return { text: say('gitPush'), rule: 'cmd-git-push', area: 'other' };
    if (['status', 'diff', 'log', 'show', 'branch', 'blame', 'rev-parse', 'ls-files'].includes(sub)) return { text: say('gitLook'), rule: 'cmd-git-look', area: 'analysis' };
    return { text: say('git'), rule: 'cmd-git', area: 'other' };
  }
  if (program === 'gh') return { text: say('github'), rule: 'cmd-github', area: 'other' };
  if (['docker', 'docker-compose', 'podman'].includes(program)) return { text: say('docker'), rule: 'cmd-docker', area: 'other' };
  if (['curl', 'wget', 'http', 'httpie'].includes(program)) {
    const url = args.find(arg => /^https?:\/\//.test(arg) || /^(localhost|127\.0\.0\.1)/.test(arg)) ?? '';
    return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url) ? { text: say('tryServer'), rule: 'cmd-request-local', area: 'server' } : { text: say('fetch'), rule: 'cmd-request', area: 'analysis' };
  }
  if (LOOK.has(program)) return { text: say('look'), rule: 'cmd-look', area: 'analysis' };
  if (FILES.has(program)) return { text: say('files'), rule: 'cmd-files', area: 'other' };
  if (['uvicorn', 'gunicorn', 'hypercorn', 'nodemon', 'flask', 'rails'].includes(program) && !/^(--?help|-h)$/.test(sub ?? '')) {
    if (program === 'flask' && sub && sub !== 'run') return { text: say(sub === 'db' ? 'databaseStructure' : 'look'), rule: sub === 'db' ? 'cmd-database' : 'cmd-look', area: sub === 'db' ? 'database' : 'analysis' };
    return { text: say('start'), rule: 'cmd-start', area: 'other' };
  }
  if (/^python[0-9.]*$/.test(program) && /manage\.py$/.test(sub ?? '')) {
    const task = args[args.indexOf(sub) + 1] ?? '';
    if (/^(migrate|makemigrations)$/.test(task)) return { text: say('databaseStructure'), rule: 'cmd-database', area: 'database' };
    if (task === 'runserver') return { text: say('start'), rule: 'cmd-start', area: 'other' };
    if (task === 'test') return { text: say('checkWorks'), rule: 'cmd-test', area: 'tests' };
  }
  if ((['node', 'deno', 'bun', 'tsx', 'ts-node'].includes(program) || /^python[0-9.]*$/.test(program)) && /^(\.\/)?(src\/)?(server|app|main|index|run|wsgi|asgi)\.(m?[jt]s|py)$/.test(sub ?? '')) {
    return { text: say('start'), rule: 'cmd-start', area: 'other' };
  }
  if (['node', 'python', 'python3', 'deno', 'bun', 'ts-node', 'tsx', 'ruby', 'go'].includes(program) && sub && !sub.startsWith('-')) {
    if (['-e', '-c', '--eval'].some(flag => args.includes(flag))) return { text: say('check'), rule: 'cmd-eval', area: 'analysis' };
    return { text: say('run', { name: basename(sub) }), rule: 'cmd-run', area: 'other', generic: true };
  }
  if (['node', 'python', 'python3'].includes(program) && ['-e', '-c', '--eval'].some(flag => args.includes(flag))) return { text: say('check'), rule: 'cmd-eval', area: 'analysis' };
  if (['kill', 'pkill', 'lsof', 'ps', 'killall'].includes(program)) return { text: say('processes'), rule: 'cmd-process', area: 'other' };
  if (program === 'make') return { text: say('script', { name: sub ?? 'make' }), rule: 'cmd-script', area: 'other', generic: true };
  if (['bash', 'sh', 'zsh'].includes(program) && sub && !sub.startsWith('-')) return { text: say('run', { name: basename(sub) }), rule: 'cmd-run', area: 'other', generic: true };
  if (['bash', 'sh', 'zsh'].includes(program)) return { text: say('runCommands'), rule: 'cmd-shell', area: 'other', generic: true };
  if (/^\.{0,2}\//.test(parts[0]) || /\.(sh|py|js|mjs|rb)$/.test(program)) return { text: say('run', { name: program }), rule: 'cmd-run', area: 'other', generic: true };
  if (['ssh', 'scp', 'sftp', 'mosh'].includes(program)) return { text: say('remote'), rule: 'cmd-remote', area: 'server' };
  if (program === 'sleep' || program === 'wait') return { text: say('wait'), rule: 'cmd-wait', area: 'other' };
  if (['perl', 'patch'].includes(program)) return { text: say('editFiles'), rule: 'cmd-edit', area: 'other' };
  if (['claude', 'codex', 'gemini', 'aider', 'ollama', 'llm'].includes(program)) return { text: say('otherAi'), rule: 'cmd-ai', area: 'other' };
  if (['brew', 'apt', 'apt-get', 'port', 'winget', 'choco'].includes(program)) return { text: say('installTool'), rule: 'cmd-install-tool', area: 'configuration' };
  if (['dig', 'ping', 'nc', 'nslookup', 'traceroute', 'host', 'openssl'].includes(program)) return { text: say('network'), rule: 'cmd-network', area: 'other' };
  if (['date', 'whoami', 'uname', 'id', 'hostname', 'sw_vers', 'printenv', 'type', 'command'].includes(program)) return { text: say('look'), rule: 'cmd-look', area: 'analysis' };
  if (['osascript', 'launchctl', 'defaults', 'plutil', 'systemctl', 'service', 'crontab'].includes(program)) return { text: say('system'), rule: 'cmd-system', area: 'other' };
  if (program === 'npm' || RUNNERS.has(parts[0])) return { text: say('run', { name: program }), rule: 'cmd-run', area: 'other', generic: true };
  return null;
}

function bashSentence(command) {
  const list = commands(command);
  // The first command that says something; a line of only looking says "looking".
  let fallback = null;
  for (const parts of list) {
    const sentence = commandSentence(parts);
    if (!sentence) continue;
    if (sentence.rule === 'cmd-look' || sentence.rule === 'cmd-files' || sentence.rule === 'cmd-git-look') { fallback ??= sentence; continue; }
    return sentence;
  }
  return fallback;
}

// A shell line that writes files (heredocs, redirections, cp…) is read as the writing of those files;
// each file keeps its own sentence, for the steps by area. Logs and files outside the project do not count.
const INCIDENTAL = new Set(['cmd-look', 'cmd-files', 'cmd-git-look', 'cmd-edit', 'cmd-shell']);
function shellSentence(input) {
  const own = bashSentence(input.command);
  const files = (input.writes ?? []).filter(path => !/\.(log|tmp|out)$/.test(path) && !/^(\/|~)/.test(path)).map(path => { const sentence = fileSentence('Write', path); return sentence && { ...sentence, path }; }).filter(Boolean);
  if (!files.length) return own;
  if (own && !INCIDENTAL.has(own.rule)) return { ...own, files };
  if (files.length === 1) return { ...files[0], files };
  const main = files.find(file => !['configuration', 'other'].includes(file.area)) ?? files[0];
  return { text: say('writeMany', { count: files.length }), rule: 'cmd-write-files', area: main.area, files };
}

const TEST_COMMAND = command => commands(command).some(parts => commandSentence(parts)?.rule === 'cmd-test');

// A translator keeps what it learned (the tasks' names) across the events of a session, in order.
export function createTranslator() {
  const tasks = new Map();
  let created = 0;
  return function translate(event) {
    const tool = event.tool;
    const input = event.input ?? {};
    if (event.kind === 'notice') {
      if (['permission_prompt', 'permission_request', 'elicitation_dialog', 'agent_needs_input'].includes(event.notice)) return { text: say('waiting'), rule: 'notice-permission', area: 'other', waiting: true };
      if (event.notice === 'idle_prompt') return { text: say('idle'), rule: 'notice-idle', area: 'other' };
      return null;
    }
    if (event.kind === 'end') {
      // What the tasks are called: TaskCreate gives the id only in its result.
      if (tool === 'TaskCreate' && event.result?.task) tasks.set(event.result.task, input.subject);
      return null;
    }
    if (event.kind === 'fail') {
      if ((tool === 'Bash' || tool === 'PowerShell') && TEST_COMMAND(input.command)) return { text: say('testFailed'), rule: 'fail-test', area: 'tests', problem: true };
      if (tool === 'Bash' || tool === 'PowerShell') return { text: say('commandFailed'), rule: 'fail-command', area: 'other', problem: true };
      return { text: say('stepFailed'), rule: 'fail-tool', area: 'other', problem: true };
    }
    switch (tool) {
      case 'Read': case 'Grep': case 'Glob': case 'LS': case 'NotebookRead': return { text: say('look'), rule: 'read', area: 'analysis' };
      case 'WebFetch': return { text: say('readDocs'), rule: 'web-fetch', area: 'analysis' };
      case 'WebSearch': return { text: say('search'), rule: 'web-search', area: 'analysis' };
      case 'Task': case 'Agent': return { text: say('helper'), rule: 'agent', area: 'analysis' };
      case 'TodoWrite': return { text: say('plan'), rule: 'todo', area: 'analysis' };
      case 'TaskCreate': created++; return { text: say('planTask', { subject: input.subject ?? '' }), rule: 'task-create', area: 'analysis' };
      case 'TaskUpdate': {
        const subject = input.subject ?? tasks.get(input.task) ?? '';
        if (input.status === 'in_progress') return { text: subject ? say('taskStart', { subject }) : say('plan'), rule: 'task-start', area: 'analysis', task: input.task };
        if (input.status === 'completed') return { text: subject ? say('taskDone', { subject }) : say('plan'), rule: 'task-done', area: 'analysis', task: input.task };
        return { text: say('plan'), rule: 'task-update', area: 'analysis', task: input.task };
      }
      case 'TaskList': case 'TaskGet': case 'TaskOutput': return { text: say('plan'), rule: 'task-read', area: 'analysis' };
      case 'TaskStop': case 'KillShell': case 'KillBash': return { text: say('processes'), rule: 'task-stop', area: 'other' };
      case 'BashOutput': case 'Monitor': case 'ScheduleWakeup': return { text: say('waitTask'), rule: 'wait-task', area: 'other' };
      case 'AskUserQuestion': return { text: say('question'), rule: 'ask-user', area: 'other', waiting: true };
      case 'ListAgents': case 'SendMessage': return { text: say('helper'), rule: 'agent', area: 'analysis' };
      case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return fileSentence(tool, input.file);
      case 'Bash': case 'PowerShell': return shellSentence(input);
      case 'ExitPlanMode': case 'EnterPlanMode': return { text: say('plan'), rule: 'plan-mode', area: 'analysis' };
      case 'Skill': return { text: say('plan'), rule: 'skill', area: 'analysis' };
      default: {
        const mcp = /^mcp__(.+?)__/.exec(tool ?? '');
        if (mcp && /chrome|browser|playwright|puppeteer|selenium/i.test(mcp[1])) return { text: say('browser'), rule: 'mcp-browser', area: 'interface' };
        if (mcp && /context7|docs|documentation/i.test(mcp[1])) return { text: say('readDocs'), rule: 'mcp-docs', area: 'analysis' };
        if (mcp) return { text: say('mcp', { name: words(mcp[1].replace(/^claude_ai_/, '')) }), rule: 'mcp', area: 'other', generic: true };
        return null;
      }
    }
  };
}

// At most MAX_WORDS words (a long name is cut, with an ellipsis).
export function short(text) {
  const list = String(text).split(/\s+/);
  return list.length > MAX_WORDS ? `${list.slice(0, MAX_WORDS).join(' ')}…` : text;
}

// Every event of a session with its sentence: [{ event, sentence|null }].
export function translateSession(events) {
  const translate = createTranslator();
  return events.map(event => {
    const sentence = translate(event);
    return { event, sentence: sentence ? { ...sentence, text: short(sentence.text) } : null };
  });
}
