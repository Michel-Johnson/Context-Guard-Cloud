import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Cross-product tests use the exact released client artifact, never a sibling
// checkout or copied client source. npm's lockfile verifies artifact integrity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const configured = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies?.['@michelj/context-guard'];
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(configured || '');
const pinnedCommit = /(?:#|\/)([a-f0-9]{40})(?:\.tar\.gz)?$/.exec(configured || '')?.[1];
if (!exactVersion && !pinnedCommit) throw new Error('Cloud integration tests require an exact Skill version or immutable Git commit');
export const skillRoot = path.dirname(require.resolve('@michelj/context-guard/package.json'));
const installed = JSON.parse(fs.readFileSync(path.join(skillRoot, 'package.json'), 'utf8'));
if (exactVersion && installed.version !== configured) throw new Error(`Skill fixture version mismatch: expected ${configured}, received ${installed.version}`);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages?.['node_modules/@michelj/context-guard'];
if (!locked?.resolved || (pinnedCommit ? !locked.resolved.includes(pinnedCommit) : locked.version !== configured || !locked.integrity)) {
  throw new Error('Skill fixture must be verified by the committed lockfile');
}
export function skillFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) {
    throw new Error('Skill fixture path must stay inside the installed package');
  }
  return path.join(skillRoot, relative);
}
export function skillImport(relative) { return import(pathToFileURL(skillFile(relative)).href); }
