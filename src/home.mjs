// Where CodeTAC keeps its recordings, its database and its configuration
// (Phase 6): CODETAC_HOME; in a Git checkout of CodeTAC, its own .codetac
// folder (as in the earlier phases); installed from npm, ~/.codetac.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const install = fileURLToPath(new URL('../', import.meta.url));

export function dataDirectory(env = process.env) {
  if (env.CODETAC_HOME) return resolve(env.CODETAC_HOME);
  if (existsSync(join(install, '.git'))) return join(install, '.codetac');
  return join(homedir(), '.codetac');
}
