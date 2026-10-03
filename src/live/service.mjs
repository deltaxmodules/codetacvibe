// The live window's side of the panel (phase L3):
//   GET /api/live/projects             the projects whose prompts the hooks record
//   GET /api/live/state?project=<id>   the window's state now (state.mjs)
//   GET /api/live/stream?project=<id>  the same, sent again each time it changes (Server-Sent Events)
//   GET /api/live/state?project=<id>&n=<n>  the state of an earlier prompt (the history)
//   GET /api/live/prompts?project=<id>  the project's prompts, newest first
// A project is named by the id of its Diff folder, as in the Diff's pages.
// While a window is open, the panel moves what capture.sh left in the
// waiting folder into the session's log (M202), so the window follows the
// assistant without waiting for the end of the prompt.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { diffFolder } from '../diff/archive.mjs';
import { liveFolder, ingest, spoolFolder } from './events.mjs';
import { liveState, promptHistory } from './state.mjs';

const TICK = 300;
const HEARTBEAT = 15_000;

const mtime = path => { try { return statSync(path).mtimeMs; } catch { return 0; } };
const waitingCount = root => { try { return readdirSync(spoolFolder(root)).filter(name => name.endsWith('.json')).length; } catch { return 0; } };

// What changes when the window has something new to show.
function signature(root) {
  const sessions = join(liveFolder(root), 'sessions');
  let newest = 0;
  try { for (const name of readdirSync(sessions)) newest = Math.max(newest, mtime(join(sessions, name))); } catch {}
  return `${mtime(join(diffFolder(root), 'prompts.json'))}:${newest}:${waitingCount(root)}`;
}

export function createLiveService({ projectById, listProjects, tick = TICK }) {
  const stateOf = (id, n = 'latest') => {
    const root = projectById(id);
    if (!root) return null;
    if (waitingCount(root)) { try { ingest(root); } catch {} }
    return liveState(root, { n: /^\d+$/.test(String(n)) ? Number(n) : 'latest' });
  };
  return {
    projects: () => listProjects().map(({ id, name, last }) => ({ id, name, last })),
    state: stateOf,
    prompts: id => { const root = projectById(id); return root ? promptHistory(root) : null; },
    // Keeps the response open and writes the state whenever the files change.
    stream(id, request, response) {
      const root = projectById(id);
      if (!root) return false;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      let last = null;
      let beat = Date.now();
      const send = () => {
        let now;
        try { now = signature(root); } catch { return; }
        if (now !== last) {
          last = now;
          try { response.write(`data: ${JSON.stringify(stateOf(id))}\n\n`); } catch {}
          beat = Date.now();
          // Reading the waiting folder changed the signature: take the new one, so the same state is not sent twice.
          try { last = signature(root); } catch {}
        } else if (Date.now() - beat > HEARTBEAT) {
          response.write(': still here\n\n');
          beat = Date.now();
        }
      };
      send();
      const timer = setInterval(send, tick);
      request.on('close', () => clearInterval(timer));
      return true;
    },
  };
}
