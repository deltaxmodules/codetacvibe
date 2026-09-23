// Action dossier as shown to a person: the store's dossier with the browser
// positions resolved to project files (through the application's source maps).
import { sep } from 'node:path';
import { createResolver } from './origins.mjs';

export function createActionView(store, resolver = createResolver()) {
  const browserFiles = new Map();
  // Browser files that may be shown: project files found by resolving the
  // positions of a recorded action of that run.
  const LIBRARIES_OF_REACT = new Set(['react', 'react-dom', 'scheduler', 'react-server-dom-webpack', 'react-server-dom-turbopack']);

  function shortFile(root, file) {
    return root && file && file.startsWith(root + sep) ? file.slice(root.length + 1) : file;
  }
  function allowBrowserFile(run, file) {
    if (!browserFiles.has(run)) browserFiles.set(run, new Set());
    browserFiles.get(run).add(file);
  }
  // React itself, also when a framework ships its own copy (next/dist/compiled/react).
  function reactInternal(frame) {
    return LIBRARIES_OF_REACT.has(frame.library) || /\/compiled\/(react|react-dom|react-server-dom-[\w-]+|scheduler)\//.test(frame.file ?? '')
      || /^(exports\.)?(jsxDEV|jsxs?|createElement|fakeJSXCallSite)$/.test(frame.fn ?? '');
  }
  // Where the element was written: the first frame outside React itself.
  function creation(frames, root, run) {
    const frame = frames.find(item => item.resolved && !reactInternal(item));
    if (!frame) return null;
    if (frame.project) {
      allowBrowserFile(run, frame.file);
      return { project: true, fn: frame.fn ?? null, file: frame.file, short: shortFile(root, frame.file), line: frame.line };
    }
    return { project: false, library: frame.library ?? null };
  }
  // The project functions on the way to a request, outermost first.
  function chain(frames, root, run) {
    const result = [];
    for (const frame of [...frames].reverse()) {
      if (!frame.project) continue;
      const previous = result.at(-1);
      if (previous && previous.file === frame.file && previous.line === frame.line) continue;
      allowBrowserFile(run, frame.file);
      result.push({ fn: frame.fn ?? '(anónima)', file: frame.file, short: shortFile(root, frame.file), line: frame.line, resolved: frame.resolved });
    }
    const libraries = [...new Set(frames.filter(frame => frame.library && !reactInternal(frame)).map(frame => frame.library))];
    return { chain: result, libraries, unresolved: frames.length > 0 && frames.every(frame => !frame.resolved) };
  }

  async function resolvedAction(id) {
    store.ingest();
    const dossier = store.actionDossier(id);
    if (!dossier) return null;
    const context = { origin: dossier.origin, root: dossier.root, scripts: dossier.scripts };
    const resolve = async frames => {
      if (!dossier.root) return [];
      return Promise.all((frames ?? []).map(async frame => {
        // Script URLs carry the port of that run, so the key is unique to it.
        const key = JSON.stringify([dossier.root, frame.url ?? frame.file, frame.line, frame.column]);
        const cached = store.cachedOrigin?.(key);
        if (cached) return { ...cached, fn: frame.fn || cached.fn };
        if (!dossier.origin && !frame.file) return { ...frame, resolved: false };
        const result = await resolver.resolveFrame(frame, context);
        if (result.resolved) store.cacheOrigin?.(key, result);
        return result;
      }));
    };
    const run = dossier.run;
    for (const item of dossier.timeline) {
      if (item.type === 'trigger' && item.trigger.component) {
        const component = item.trigger.component;
        component.origin = creation(await resolve(component.frames), dossier.root, run);
        delete component.frames;
        // When the element comes from a library component (a router link, a
        // UI kit button), the first owner written in the project is named too.
        for (const owner of component.owners ?? []) {
          owner.origin = creation(await resolve(owner.frames), dossier.root, run);
          delete owner.frames;
        }
        if (!component.origin?.project) {
          const index = (component.owners ?? []).findIndex(owner => owner.origin?.project);
          // owners[index] was written in the project, inside owners[index + 1].
          if (index >= 0) component.project = { name: component.owners[index + 1]?.name ?? null, via: component.owners[index].name,
            origin: component.owners[index].origin };
        }
      }
      if (item.type === 'request') {
        Object.assign(item.browser, chain(await resolve(item.browser.frames), dossier.root, run));
        delete item.browser.frames;
      }
      if (item.type === 'screen') {
        for (const key of ['stateChanged', 'mounted', 'unmounted']) {
          for (const component of item.screen[key] ?? []) {
            component.origin = creation(await resolve(component.frames), dossier.root, run);
            delete component.frames;
          }
        }
      }
    }
    delete dossier.scripts;
    return dossier;
  }


  return { resolvedAction, browserFile: (run, file) => Boolean(browserFiles.get(run)?.has(file)) };
}
