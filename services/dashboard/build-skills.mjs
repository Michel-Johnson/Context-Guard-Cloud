import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadSharedDashboard } from './server.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--base-url' || !args[1]) {
  throw new Error('Usage: node build-skills.mjs --base-url https://dashboard.example.test');
}
const shared = await loadSharedDashboard();
// The builder and its inputs came from the same verified fixed archive as the server.
// It refuses to overwrite any existing release or catalog.
const output = execFileSync('python3', [
  resolve(shared.moduleRoot, '../../skills/build-distribution.py'),
  '--web-root', resolve(shared.moduleRoot, 'web'), '--base-url', args[1],
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
process.stdout.write(output);
