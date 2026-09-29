// The catalogue of known services (phase 4, step 1): services.json in the
// package, extended by the user's "services" in codetac.structure.json. A user
// entry with the id of a known service adds to it (hosts, SDKs) and sets its
// jurisdiction; a new id adds a service. The jurisdiction is the user's word
// on where the data stays: StructureTAC never fills it, and it stays out of
// the graph (docs/structuretac/schema.md §6).
import { readFileSync } from 'node:fs';
import { CONFIG_FILE } from './config.mjs';

export const CATEGORIES = ['ai', 'database', 'payments', 'analytics', 'monitoring', 'email', 'messaging', 'storage', 'auth', 'http'];
const DESTINATIONS = ['argument', 'connectionString', 'url', 'host', 'dsn'];
const BUILT_IN = JSON.parse(readFileSync(new URL('./services.json', import.meta.url), 'utf8')).services;

const isText = value => typeof value === 'string' && value.trim() !== '';
const hostPattern = host => (host.startsWith('*.') ? name => name.endsWith(host.slice(1)) : name => name === host);

// { services, problems, byHost(host), bySdk(package, name), byId(id) }.
export function serviceCatalogue(userEntries = []) {
  const problems = [];
  const services = new Map(BUILT_IN.map(item => [item.id, { ...item, hosts: [...(item.hosts ?? [])], sdk: [...(item.sdk ?? [])], builtIn: true }]));
  const say = message => problems.push(`${CONFIG_FILE}: ${message}`);
  for (const [index, entry] of (Array.isArray(userEntries) ? userEntries : []).entries()) {
    const where = `"services" entry ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { say(`${where} must be an object; it is ignored.`); continue; }
    if (!isText(entry.id) || !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id)) { say(`${where} needs an "id" (lower case letters, digits, . _ -); it is ignored.`); continue; }
    const hosts = entry.hosts ?? [];
    const sdk = entry.sdk ?? [];
    if (!Array.isArray(hosts) || !hosts.every(isText)) { say(`${where} (${entry.id}): "hosts" must be a list of host names; it is ignored.`); continue; }
    if (!Array.isArray(sdk) || !sdk.every(item => isText(item?.package) && Array.isArray(item.create) && item.create.every(isText))) {
      say(`${where} (${entry.id}): "sdk" must be a list of { "package", "create": [names] }; it is ignored.`); continue;
    }
    if (entry.jurisdiction !== undefined && !isText(entry.jurisdiction)) { say(`${where} (${entry.id}): "jurisdiction" must be text; it is ignored.`); continue; }
    if (entry.destination !== undefined && !DESTINATIONS.includes(entry.destination)) { say(`${where} (${entry.id}): "destination" must be one of ${DESTINATIONS.join(', ')}; it is ignored.`); continue; }
    const known = services.get(entry.id);
    if (known) {
      if (entry.category !== undefined && entry.category !== known.category) say(`${where} (${entry.id}): the category of a known service stays ${known.category}.`);
      known.hosts.push(...hosts);
      known.sdk.push(...sdk);
      if (entry.name !== undefined && isText(entry.name)) known.name = entry.name;
      if (entry.jurisdiction !== undefined) known.jurisdiction = entry.jurisdiction.trim();
      continue;
    }
    if (!CATEGORIES.includes(entry.category)) { say(`${where} (${entry.id}): "category" must be one of ${CATEGORIES.join(', ')}; it is ignored.`); continue; }
    if (!hosts.length && !sdk.length) { say(`${where} (${entry.id}): give "hosts" or "sdk", or it can never be recognised; it is ignored.`); continue; }
    services.set(entry.id, { id: entry.id, name: isText(entry.name) ? entry.name : entry.id, category: entry.category, hosts: [...hosts], sdk: [...sdk],
      ...(entry.destination ? { destination: entry.destination } : {}), ...(entry.jurisdiction !== undefined ? { jurisdiction: entry.jurisdiction.trim() } : {}), builtIn: false });
  }
  const list = [...services.values()];
  const hostRules = list.flatMap(service => service.hosts.map(host => ({ test: hostPattern(host.toLowerCase()), service, exact: !host.startsWith('*.') })));
  // An exact host wins over a wildcard; the user's own entries were added last.
  hostRules.sort((a, b) => Number(b.exact) - Number(a.exact));
  return {
    services: list, problems,
    byId: id => services.get(id) ?? null,
    byHost: host => hostRules.find(rule => rule.test(String(host).toLowerCase()))?.service ?? null,
    bySdk: (pkg, name) => list.find(service => service.sdk.some(item => item.package === pkg && item.create.includes(name))) ?? null,
    packages: new Set(list.flatMap(service => service.sdk.map(item => item.package))),
  };
}
