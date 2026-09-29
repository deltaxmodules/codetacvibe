// Reads one project in a worker thread, so a large project never holds up the
// panel. Receives { root }; answers { graph, problems } or { error }.
import { parentPort, workerData } from 'node:worker_threads';
import { readProject } from './readers.mjs';

try {
  const { graph, problems } = await readProject(workerData.root);
  parentPort.postMessage({ graph, problems });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message ?? error) });
}
