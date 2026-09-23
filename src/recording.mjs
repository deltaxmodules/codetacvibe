// Leitura direta de uma gravação (.codetac/<gravação>/*.jsonl), sem a base
// do painel: o comando `codetac` segue-a enquanto a app corre, e o
// diagnóstico resume-a.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isLibraryFile } from './boundaries.mjs';

// Follows the files of a recording and calls `onEvent` for each new event.
export function follow(directory, onEvent) {
  const offsets = new Map();
  const rests = new Map();
  function poll() {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(directory, name);
      let size;
      try { size = statSync(path).size; } catch { continue; }
      let offset = offsets.get(path) ?? 0;
      if (size <= offset) continue;
      const fd = openSync(path, 'r');
      try {
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
          const read = readSync(fd, buffer, 0, buffer.length, offset);
          if (!read) break;
          offset += read;
          const text = (rests.get(path) ?? '') + buffer.subarray(0, read).toString('utf8');
          const lines = text.split('\n');
          rests.set(path, lines.pop());
          for (const line of lines) {
            if (!line) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            onEvent(event, name);
          }
        }
      } finally { closeSync(fd); }
      offsets.set(path, offset);
    }
  }
  return { poll };
}

// What a recording shows about the capture, in counts.
export function createSummary() {
  const summary = {
    starts: [], ports: new Set(), addresses: new Map(), pages: 0, requests: 0, withFunctions: new Set(), withBoundaries: new Set(),
    actions: new Set(), files: 0, functions: 0, emptyFiles: 0, failed: [], limitations: new Map(), processes: new Set(),
    firstAction: null, firstRequest: null, firstPage: null, pagePath: null,
  };
  summary.add = event => {
    if (event.process) summary.processes.add(event.process);
    switch (event.type) {
      case 'capture-start': summary.starts.push({ level: event.level, reason: event.reason, root: event.root, node: event.node }); break;
      case 'listening':
        if (event.port) { summary.ports.add(event.port); summary.addresses.set(event.port, event.address); }
        break;
      case 'page': summary.pages++; summary.pagePath = event.path; break;
      case 'request':
        summary.requests++;
        summary.firstRequest ??= event;
        // The request that follows a page event with the same path loaded that page.
        if (summary.pagePath && event.path === summary.pagePath) { summary.firstPage ??= { ...event, seenAt: Date.now() }; summary.pagePath = null; }
        break;
      case 'browser-action':
        if (!summary.actions.has(event.actionId)) summary.firstAction ??= event;
        summary.actions.add(event.actionId);
        break;
      case 'module':
        if (event.cached || isLibraryFile(event.file ?? '')) break;
        summary.files++;
        summary.functions += event.functions ?? 0;
        if (!event.functions) summary.emptyFiles++;
        break;
      case 'limitation':
        summary.limitations.set(event.reason, (summary.limitations.get(event.reason) ?? 0) + 1);
        if (event.reason === 'module-transform-failed' || event.reason === 'source-map-unreadable') summary.failed.push({ file: event.file, detail: event.detail });
        break;
      case 'enter':
        if (event.requestId && !isLibraryFile(event.file ?? '')) summary.withFunctions.add(event.requestId);
        break;
      case 'boundary':
        if (event.requestId) summary.withBoundaries.add(event.requestId);
        break;
    }
  };
  return summary;
}

export function summarize(directory) {
  const summary = createSummary();
  follow(directory, summary.add).poll();
  return summary;
}

// The recordings of a project, newest first (by the folder's last change).
export function recordingsOf(workspaceDirectory, root) {
  if (!existsSync(workspaceDirectory)) return [];
  const found = [];
  for (const name of readdirSync(workspaceDirectory)) {
    const folder = join(workspaceDirectory, name);
    if (name === 'projetos' || !statSync(folder).isDirectory()) continue;
    const files = readdirSync(folder).filter(file => file.endsWith('.jsonl'));
    if (!files.length) continue;
    // The first line of any file is its capture-start, with the root.
    let first = null;
    for (const file of files) {
      const fd = openSync(join(folder, file), 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        const line = buffer.subarray(0, read).toString('utf8').split('\n')[0];
        first = JSON.parse(line);
      } catch {} finally { closeSync(fd); }
      if (first) break;
    }
    if (first?.type === 'capture-start' && first.root === root) {
      const changed = Math.max(...files.map(file => statSync(join(folder, file)).mtimeMs));
      found.push({ name, folder, changed });
    }
  }
  return found.sort((a, b) => b.changed - a.changed);
}
