import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Capture once at startup. A checkout changed beneath a running process must
// not make that process advertise the new source revision.
export async function releaseIdentity() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  let sourceSha = null;
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[a-f0-9]{40}$/.test(sha)) sourceSha = sha;
  } catch { /* A source archive without Git reports unknown, never a guessed SHA. */ }
  return Object.freeze({ version: manifest.version, sourceSha,
    messageVersion: 2, capabilities: ['private-map-heads', 'device-memory', 'coordinator-tools', 'split-packages', 'coordinator-steer', 'session-completion', 'memory-document-ui'] });
}
