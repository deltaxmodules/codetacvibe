// Classification of files into blocks (phase 1, step 5). Deterministic rules,
// in order; the first that applies decides, and its name is kept with the
// file. A code file no rule recognises is Unknown (never guessed). Where a
// file runs (client, server, both) is worked out separately, from the entry
// points of the browser.
import { basename } from 'node:path';

const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte']);
const META_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-workspace.yaml',
  'next-env.d.ts', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.node-version', '.editorconfig', '.prettierrc', '.prettierignore',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.dockerignore', 'Dockerfile', 'docker-compose.yml', 'vercel.json', 'netlify.toml',
  'components.json', 'codetac.structure.json', 'turbo.json', 'nx.json', 'lerna.json', 'Procfile']);
const DATABASE_PACKAGES = new Set(['pg', 'postgres', 'mysql', 'mysql2', 'mongodb', 'mongoose', '@prisma/client', 'drizzle-orm', '@supabase/supabase-js',
  '@supabase/ssr', 'ioredis', 'redis', 'better-sqlite3', 'sqlite3', 'sqlite', 'knex', 'sequelize', 'typeorm', 'kysely', '@neondatabase/serverless',
  '@vercel/postgres', '@planetscale/database', '@libsql/client', 'firebase-admin', 'firebase/firestore']);
const SERVER_PACKAGES = new Set(['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi', 'restify', 'polka']);
// SDKs of external services (AI, payments, email, messaging, storage…).
const SERVICE_PACKAGES = new Set(['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', '@mistralai/mistralai', 'ai', 'groq-sdk',
  'stripe', 'resend', 'nodemailer', '@sendgrid/mail', 'postmark', 'twilio', 'mailgun.js', '@aws-sdk/client-s3', '@aws-sdk/client-ses',
  '@vercel/blob', 'cloudinary', 'posthog-node', 'posthog-js', '@sentry/node', '@sentry/nextjs', '@sentry/react', 'mixpanel', 'algoliasearch']);
const NEXT_CONVENTIONS = /^(page|layout|loading|error|not-found|template|default|global-error|forbidden|unauthorized)\.(t|j)sx?$/;
const folders = path => path.split('/').slice(0, -1);
const inFolder = (path, names) => folders(path).some(folder => names.includes(folder.toLowerCase()));

// Whether a path is inside scripts/, bin/ or tools/ at the root of a package.
const scriptsFolderOf = (path, packageRoots) => {
  const match = path.match(/^(?:(.*)\/)?(?:scripts|bin|tools)\//);
  return Boolean(match) && packageRoots.has(match[1] ?? '');
};

// The rules. Each returns a [layer, rule] pair or null. `file` is the
// inventory entry, `module` its imports/exports, `context` the project.
const RULES = [
  (file) => basename(file.path).startsWith('.env') && ['config', 'dotenv'],
  (file) => (META_FILES.has(basename(file.path)) || /^(tsconfig|jsconfig)(\..+)?\.json$/.test(basename(file.path))
    || /\.config\.(m|c)?(j|t)s$/.test(file.path) || /^\.(eslintrc|prettierrc|babelrc|swcrc)/.test(basename(file.path))) && ['config', 'project-meta'],
  (file) => !file.path.includes('/') && file.language === 'markdown' && ['config', 'project-meta'],
  (file) => (/\.(test|spec)\.[mc]?[jt]sx?$/.test(file.path) || inFolder(file.path, ['__tests__', 'test', 'tests', 'e2e', 'cypress', 'playwright'])) && ['tests', 'test-file'],
  (file) => (file.language === 'sql' || file.language === 'prisma' || inFolder(file.path, ['migrations'])) && ['data', 'database-schema'],
  (file, module, context) => context.next && /(^|\/)app\/(.+\/)?route\.(t|j)s$/.test(file.path) && ['routes', 'next-app-router:route'],
  (file, module, context) => context.next && /(^|\/)pages\/api\//.test(file.path) && ['routes', 'next-pages-router:api'],
  (file, module, context) => context.next && /^(src\/)?middleware\.(t|j)s$/.test(file.path) && ['routes', 'next:middleware'],
  (file, module) => module?.directives.includes('use server') && ['routes', 'next:server-action'],
  (file, module, context) => context.next && /(^|\/)app\//.test(file.path) && NEXT_CONVENTIONS.test(basename(file.path)) && ['interface', 'next-app-router:convention'],
  (file) => file.language === 'html' && ['interface', inFolder(file.path, ['public', 'static']) ? 'static-page' : 'html-entry'],
  (file) => CODE.has(file.language) && (/^config\.[mc]?[jt]s$/.test(basename(file.path)) || inFolder(file.path, ['config'])) && ['config', 'config-module'],
  (file) => ['json', 'yaml', 'toml'].includes(file.language) && inFolder(file.path, ['config', 'configs', 'settings']) && ['config', 'config-file'],
  (file, module) => module?.imports.some(item => SERVER_PACKAGES.has(item.package)) && ['routes', 'server-setup'],
  (file, module, context) => CODE.has(file.language) && /^(server|app)\.[mc]?[jt]s$/.test(basename(file.path)) && /^(src\/)?[^/]+$/.test(file.path)
    && context.runsOn.get(file.path) !== 'client' && ['routes', 'server-entry'],
  (file, module) => module?.imports.some(item => DATABASE_PACKAGES.has(item.package)) && ['data', 'database-client'],
  (file) => CODE.has(file.language) && inFolder(file.path, ['routes', 'api', 'controllers', 'handlers', 'endpoints', 'routers', 'middleware', 'middlewares'])
    && ['routes', 'folder:routes'],
  (file) => CODE.has(file.language) && inFolder(file.path, ['services', 'usecases', 'use-cases', 'domain', 'actions']) && ['logic', 'folder:services'],
  (file, module, context) => module?.imports.some(item => item.target && context.databaseClients.has(item.target)) && ['data', 'database-queries'],
  (file, module) => module?.directives.includes('use client') && ['interface', 'use-client'],
  (file) => ['jsx', 'tsx', 'vue', 'svelte', 'css'].includes(file.language) && ['interface', 'ui-file'],
  (file) => CODE.has(file.language) && inFolder(file.path, ['components', 'pages', 'views', 'layouts', 'screens', 'ui', 'hooks']) && ['interface', 'folder:interface'],
  (file, module, context) => context.browserEntries.has(file.path) && ['interface', 'browser-entry'],
  (file) => CODE.has(file.language) && (inFolder(file.path, ['utils', 'util', 'helpers', 'helper', 'shared', 'common'])
    || /(^|[.-])(utils?|helpers?)([.-]|$)/.test(basename(file.path).replace(/\.[^.]+$/, ''))) && ['utilities', 'utilities'],
  (file, module) => (module?.outgoing.some(call => call.host || call.env) || module?.imports.some(item => SERVICE_PACKAGES.has(item.package))) && ['external', 'outgoing-call'],
  // Maintenance scripts are project tooling, not code the app runs (after the
  // data and external rules, so a seed that uses the database stays Data access).
  (file, module, context) => CODE.has(file.language) && scriptsFolderOf(file.path, context.packageRoots)
    && ['config', 'folder:scripts'],
  (file) => CODE.has(file.language) && inFolder(file.path, ['lib', 'core', 'logic', 'modules', 'features', 'store', 'stores', 'state']) && ['logic', 'folder:lib'],
  (file) => (file.path.endsWith('.d.ts') || inFolder(file.path, ['types', '@types'])) && ['utilities', 'types'],
  (file) => file.language === 'markdown' && ['config', 'documentation'],
];

// Where each code file runs. The browser starts at the scripts of HTML pages,
// at 'use client' files and at the pages of the Next.js Pages Router; what they import runs there too, except
// 'use server' modules (Server Actions, called over the network). The rest
// runs on the server. A file reached from both sides runs on both.
export function whereFilesRun(files, modules, { types = [] } = {}) {
  const client = new Set();
  const visit = path => {
    if (client.has(path)) return;
    const module = modules.get(path);
    if (!module || module.directives?.includes('use server')) return;
    client.add(path);
    for (const item of module.imports) if (item.target && item.kind !== 'type') visit(item.target);
  };
  const entries = new Set();
  const rendered = new Set();
  for (const file of files) {
    const module = modules.get(file.path);
    if (file.language === 'html') for (const item of module?.imports ?? []) if (item.target) { entries.add(item.target); visit(item.target); }
    if (module?.directives.includes('use client')) visit(file.path);
    // Next.js Pages Router: pages are rendered on the server and hydrated in
    // the browser (API routes and _document stay on the server).
    if (types.includes('next-pages-router') && CODE.has(file.language) && /^(src\/)?pages\/(?!api\/)(?!_document\.)/.test(file.path)) {
      rendered.add(file.path);
      visit(file.path);
    }
  }
  // Server side: code imported by a file that runs on the server. A
  // 'use client' module is a boundary (a Client Component), as 'use server'
  // is for the browser.
  const server = new Set();
  const serverVisit = path => {
    if (server.has(path) || modules.get(path)?.directives?.includes('use client')) return;
    server.add(path);
    for (const item of modules.get(path)?.imports ?? []) if (item.target && item.kind !== 'type') serverVisit(item.target);
  };
  for (const file of files) if (CODE.has(file.language) && (!client.has(file.path) || rendered.has(file.path))) serverVisit(file.path);
  const runsOn = new Map();
  for (const file of files) {
    if (file.language === 'html') runsOn.set(file.path, 'client');
    else if (CODE.has(file.language)) runsOn.set(file.path, client.has(file.path) ? (server.has(file.path) ? 'both' : 'client') : 'server');
  }
  return { runsOn, browserEntries: entries };
}

// Classifies every file: [{ path, layer, rule, runsOn? }].
export function classify(files, modules, { types = [] } = {}) {
  const { runsOn, browserEntries } = whereFilesRun(files, modules, { types });
  const context = { next: types.some(type => type.startsWith('next')), runsOn, browserEntries, databaseClients: new Set(),
    packageRoots: new Set(['', ...files.filter(file => basename(file.path) === 'package.json' && file.path.includes('/')).map(file => file.path.slice(0, -'/package.json'.length))]) };
  for (const file of files) {
    if (modules.get(file.path)?.imports.some(item => DATABASE_PACKAGES.has(item.package))) context.databaseClients.add(file.path);
  }
  return files.map(file => {
    const module = modules.get(file.path);
    let decision = null;
    for (const rule of RULES) { decision = rule(file, module, context); if (decision) break; }
    const [layer, rule] = decision || ['unknown', 'no-rule'];
    // Project meta files (build and tool configs) are not part of what runs.
    const where = rule === 'project-meta' ? undefined : runsOn.get(file.path);
    return { path: file.path, layer, rule, ...(where ? { runsOn: where } : {}) };
  });
}
