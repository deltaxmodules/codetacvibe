// The project's StructureTAC configuration (phase 1, step 6; phase 12, step
// 1): ignored files, the user's layer rules and manual reclassifications,
// which always win over the reader's rules. The file, codetac.structure.json
// at the project root, is written by the user, or by CodeTAC only when the
// user reclassifies a file (CodeTAC never writes into a project on its own);
// it is removed when it no longer holds anything.
import { DEFAULT_THRESHOLDS, SMELL_KINDS } from './smells.mjs';
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { globSource } from './node/inventory.mjs';
import { t } from './text.mjs';

export const CONFIG_FILE = 'codetac.structure.json';
export const LAYERS = ['interface', 'routes', 'logic', 'data', 'external', 'config', 'utilities', 'tests', 'unknown'];

// Pattern of "ignore" and "layers", as in .gitignore: "*" and "?" within one
// path segment, "**" across segments, a trailing "/" for a folder (and all
// below it); without a slash inside, it matches at any depth.
export function pathPattern(pattern) {
  let text = pattern.trim().replace(/^\.\//, '');
  const folder = text.endsWith('/');
  if (folder) text = text.slice(0, -1);
  const anchored = text.includes('/');
  const regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globSource(text.replace(/^\//, ''))}${folder ? '/.*' : '(?:/.*)?'}$`);
  return path => regex.test(path);
}

const KNOWN_KEYS = new Set(['version', 'ignore', 'layers', 'reclassify', 'services', 'env', 'smells', 'snapshots', 'diff', 'live']);
const EMPTY = () => ({ ignore: [], layers: [], reclassify: {}, services: [], env: { platform: [] }, smells: {}, snapshots: {}, diff: {}, live: {}, problems: [] });

// The project's configuration:
//   ignore: [pattern]           files left out of the plan (on top of .gitignore)
//   layers: { pattern: block }  the user's rules, before the reader's (first match wins)
//   reclassify: { path: block } one file, always wins (codetac structure --reclassify)
//   services                    extra services and their jurisdiction (phase 4, services.mjs)
//   env: { platform: [names] }  variables set outside the .env files (hosting, CI): never "undefined"
//   smells: { limit: n, off: [kinds] }  thresholds of the structural smells (phase 8, smells.mjs), and smells turned off
//   snapshots: { keep: n }      how many snapshots of the structure are kept (phase 9, snapshots.mjs; default 20)
//   diff: { keep: n }           how many prompts the Diff keeps, with their files (phase D1, src/diff/prompts.mjs; default 50)
//   live: { minInterval: ms }   the live window's smaller line changes at most this often (phase L3, src/live/state.mjs; default 1500)
// A broken file or entry is reported in problems, never fatal: the plan is
// still drawn, with what is valid.
export function readConfig(root) {
  const config = EMPTY();
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return config;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    config.problems.push(t('config.notJson', { file: CONFIG_FILE, reason: error.message.slice(0, 80) }));
    return config;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    config.problems.push(t('config.notObject', { file: CONFIG_FILE }));
    return config;
  }
  const { problems } = config;
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) problems.push(t('config.unknownKey', { file: CONFIG_FILE, key, known: [...KNOWN_KEYS].join(', ') }));
  if (raw.version !== undefined && raw.version !== 1) problems.push(t('config.unknownVersion', { file: CONFIG_FILE, version: JSON.stringify(raw.version) }));
  const blockList = LAYERS.join(', ');
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) problems.push(t('config.ignoreNotList', { file: CONFIG_FILE }));
    else for (const pattern of raw.ignore) {
      if (typeof pattern === 'string' && pattern.trim()) config.ignore.push({ pattern, test: pathPattern(pattern) });
      else problems.push(t('config.ignoreNotPattern', { file: CONFIG_FILE, pattern: JSON.stringify(pattern) }));
    }
  }
  if (raw.layers !== undefined) {
    if (!raw.layers || typeof raw.layers !== 'object' || Array.isArray(raw.layers)) problems.push(t('config.layersNotMap', { file: CONFIG_FILE }));
    else for (const [pattern, layer] of Object.entries(raw.layers)) {
      if (!pattern.trim()) problems.push(t('config.layersEmpty', { file: CONFIG_FILE }));
      else if (LAYERS.includes(layer)) config.layers.push({ pattern, layer, test: pathPattern(pattern) });
      else problems.push(t('config.layersNotBlock', { file: CONFIG_FILE, layer, pattern, blocks: blockList }));
    }
  }
  if (raw.reclassify !== undefined && (!raw.reclassify || typeof raw.reclassify !== 'object' || Array.isArray(raw.reclassify))) {
    problems.push(t('config.reclassifyNotMap', { file: CONFIG_FILE }));
  } else for (const [file, layer] of Object.entries(raw.reclassify ?? {})) {
    if (LAYERS.includes(layer)) config.reclassify[file] = layer;
    else problems.push(t('config.reclassifyNotBlock', { file: CONFIG_FILE, layer, path: file, blocks: blockList }));
  }
  if (raw.services !== undefined) {
    if (Array.isArray(raw.services)) config.services = raw.services;
    else problems.push(t('config.servicesNotList', { file: CONFIG_FILE }));
  }
  if (raw.env !== undefined) {
    const platform = raw.env?.platform;
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env) || (platform !== undefined && !Array.isArray(platform))) {
      problems.push(t('config.envShape', { file: CONFIG_FILE }));
    } else for (const name of platform ?? []) {
      if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) config.env.platform.push(name);
      else problems.push(t('config.envNotName', { file: CONFIG_FILE, name: JSON.stringify(name) }));
    }
  }
  if (raw.smells !== undefined) {
    if (!raw.smells || typeof raw.smells !== 'object' || Array.isArray(raw.smells)) problems.push(t('config.smellsNotObject', { file: CONFIG_FILE }));
    else {
      for (const [key, value] of Object.entries(raw.smells)) {
        if (key === 'off') {
          const list = Array.isArray(value) ? value : [value];
          for (const kind of list) {
            if (SMELL_KINDS.includes(kind)) (config.smells.off ??= []).push(kind);
            else problems.push(t('config.smellsOffUnknown', { file: CONFIG_FILE, kind: JSON.stringify(kind), known: SMELL_KINDS.join(', ') }));
          }
        } else if (!(key in DEFAULT_THRESHOLDS)) {
          problems.push(t('config.smellsUnknownKey', { file: CONFIG_FILE, key, known: [...Object.keys(DEFAULT_THRESHOLDS), 'off'].join(', ') }));
        } else if (Number.isInteger(value) && value > 0) config.smells[key] = value;
        else problems.push(t('config.smellsNotNumber', { file: CONFIG_FILE, key, default: DEFAULT_THRESHOLDS[key] }));
      }
    }
  }
  // How many to keep: snapshots of the structure (phase 9) and prompts of the Diff (phase D1).
  for (const section of ['snapshots', 'diff']) {
    if (raw[section] === undefined) continue;
    const value = raw[section];
    const keep = value?.keep;
    if (!value || typeof value !== 'object' || Array.isArray(value)) problems.push(t(`config.${section}Shape`, { file: CONFIG_FILE }));
    else {
      for (const key of Object.keys(value)) if (key !== 'keep') problems.push(t(`config.${section}UnknownKey`, { file: CONFIG_FILE, key }));
      if (keep !== undefined) {
        if (Number.isInteger(keep) && keep > 0) config[section].keep = keep;
        else problems.push(t(`config.${section}Keep`, { file: CONFIG_FILE }));
      }
    }
  }
  // The live window (phase L3): how often its smaller line may change, in milliseconds.
  if (raw.live !== undefined) {
    const value = raw.live;
    if (!value || typeof value !== 'object' || Array.isArray(value)) problems.push(t('config.liveShape', { file: CONFIG_FILE }));
    else {
      for (const key of Object.keys(value)) if (key !== 'minInterval') problems.push(t('config.liveUnknownKey', { file: CONFIG_FILE, key }));
      const interval = value.minInterval;
      if (interval !== undefined) {
        if (Number.isInteger(interval) && interval >= 200 && interval <= 60000) config.live.minInterval = interval;
        else problems.push(t('config.liveMinInterval', { file: CONFIG_FILE }));
      }
    }
  }
  return config;
}

// A path given by the user, as a project path (relative, forward slashes), or
// an error when it is not a file inside the project.
export function projectPath(root, given) {
  const real = realpathSync(root);
  let absolute = resolve(real, given);
  // The same file by another name (/var is /private/var on macOS).
  try { absolute = realpathSync(absolute); } catch {}
  const inside = relative(real, absolute);
  if (!inside || inside.startsWith('..') || resolve(inside) === inside) return { error: `${given} is not inside the project.` };
  let isFile = false;
  try { isFile = statSync(absolute).isFile(); } catch {}
  if (!isFile) return { error: `${given} is not a file of the project.` };
  return { path: inside.split(sep).join('/') };
}

// Sets (or, with layer "auto", removes) the manual block of a file. Returns
// { path, layer, created, removed } or { error }.
export function reclassify(root, given, layer) {
  const target = projectPath(root, given);
  if (target.error) return target;
  if (layer !== 'auto' && !LAYERS.includes(layer)) return { error: `"${layer}" is not a block. Blocks: ${LAYERS.join(', ')}, or auto to go back to the rules.` };
  const file = join(root, CONFIG_FILE);
  const existed = existsSync(file);
  let raw = {};
  if (existed) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return { error: `${CONFIG_FILE} is not valid JSON; fix or delete it first.` }; }
  }
  const entries = { ...(raw.reclassify ?? {}) };
  if (layer === 'auto') delete entries[target.path];
  else entries[target.path] = layer;
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  const { reclassify: _old, version: _version, ...rest } = raw;
  if (!Object.keys(sorted).length && !Object.keys(rest).length) {
    if (existed) rmSync(file);
    return { path: target.path, layer, removed: existed };
  }
  writeFileSync(file, `${JSON.stringify({ version: 1, ...rest, reclassify: sorted }, null, 2)}\n`);
  return { path: target.path, layer, created: !existed };
}
