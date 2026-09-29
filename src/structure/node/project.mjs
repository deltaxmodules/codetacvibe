// Project type of a Node folder, for the StructureTAC plan (phase 1, step 2).
// AI-generated projects often declare little, so every signal counts:
// dependencies, scripts, framework config files, folder conventions and the
// packages the code imports (given by the caller once the files are parsed).
// Workspaces (monorepos) are described package by package.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const isFolder = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const hasAny = (folder, names) => names.some(name => existsSync(join(folder, name)));
const CONFIG = extensions => name => extensions.map(extension => `${name}.config.${extension}`);
const configs = CONFIG(['js', 'mjs', 'cjs', 'ts', 'mts']);

// Frameworks that are recognised only by name (dependency, script or import).
const SERVERS = [
  ['express', 'express'], ['fastify', 'fastify'], ['koa', 'koa'], ['hono', 'hono'], ['@nestjs/core', 'nestjs'],
];
const META = [
  ['nuxt', 'nuxt'], ['@sveltejs/kit', 'sveltekit'], ['astro', 'astro'], ['@remix-run/dev', 'remix'], ['@react-router/dev', 'react-router'],
];

// Next.js App Router: an app/ folder (or src/app) with a layout or page.
function nextRouters(folder) {
  const types = [];
  for (const base of ['app', 'src/app']) {
    const path = join(folder, base);
    if (isFolder(path) && readdirSync(path).some(name => /^(layout|page)\.(t|j)sx?$/.test(name))) { types.push('next-app-router'); break; }
  }
  for (const base of ['pages', 'src/pages']) if (isFolder(join(folder, base))) { types.push('next-pages-router'); break; }
  return types;
}

// Types of one package folder. `imported` is the set of packages its code
// imports (bare specifiers), when known.
export function packageTypes(folder, { imported = new Set() } = {}) {
  const pkg = readJson(join(folder, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const scripts = Object.values(pkg.scripts ?? {}).join('\n');
  // Scripts count for plain names only ("next dev", "vite build").
  const uses = name => name in deps || imported.has(name) || (!name.includes('/') && new RegExp(`(^|[\\s/"'&;])${name}(\\s|$)`, 'm').test(scripts));
  const types = new Set();
  const isNext = uses('next') || hasAny(folder, configs('next'));
  if (isNext) {
    const routers = nextRouters(folder);
    for (const type of routers.length ? routers : ['next']) types.add(type);
  }
  if (!isNext && (uses('vite') || hasAny(folder, configs('vite')))) {
    if (uses('react') || uses('react-dom')) types.add('vite-react');
    else if (uses('vue')) types.add('vite-vue');
    else if (uses('svelte')) types.add('vite-svelte');
    else types.add('vite');
  }
  if (!isNext && !types.size && (uses('react-scripts'))) types.add('create-react-app');
  for (const [name, type] of [...SERVERS, ...META]) if (uses(name)) types.add(type);
  return [...types].sort();
}

// Workspace members: package.json "workspaces" (array or { packages }) and
// pnpm-workspace.yaml. Simple globs only ("apps/*", "packages/**" as one level).
export function workspaceFolders(root) {
  const pkg = readJson(join(root, 'package.json')) ?? {};
  const patterns = [...(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [])];
  try {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    const block = yaml.match(/^packages:\s*\n((?:\s+-.*\n?)+)/m);
    if (block) patterns.push(...block[1].split('\n').map(line => line.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, '').trim()).filter(Boolean));
  } catch {}
  const folders = new Set();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const clean = pattern.replace(/\/\*\*?$/, '').replace(/\/$/, '');
    if (/\/\*\*?$/.test(pattern)) {
      const parent = join(root, clean);
      if (!isFolder(parent)) continue;
      for (const name of readdirSync(parent).sort()) {
        const path = join(parent, name);
        if (isFolder(path) && existsSync(join(path, 'package.json'))) folders.add(relative(root, path).split(sep).join('/'));
      }
    } else if (!clean.includes('*') && existsSync(join(root, clean, 'package.json'))) folders.add(clean);
  }
  return [...folders].sort();
}

// The whole project: its own types, and one entry per workspace member.
// `importedBy(folder)` returns the packages imported by the code of a member
// (relative folder, '.' for the root).
export function describeProject(root, { importedBy = () => new Set() } = {}) {
  const members = workspaceFolders(root).map(folder => ({ folder, types: packageTypes(join(root, folder), { imported: importedBy(folder) }) }));
  const own = packageTypes(root, { imported: importedBy('.') });
  const types = new Set(own);
  if (members.length) types.add('workspace');
  for (const member of members) for (const type of member.types) types.add(type);
  return { types: [...types].sort(), packages: members };
}
