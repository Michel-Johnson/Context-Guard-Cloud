import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSkillFixture } from '../../.github/scripts/skill-fixture.mjs';

// Cross-product tests use the exact released client artifact, never a sibling
// checkout or copied client source. npm's lockfile verifies artifact integrity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const configured = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies?.['@michelj/context-guard'];
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages?.['node_modules/@michelj/context-guard'];
validateSkillFixture(configured, locked);
export const skillRoot = path.dirname(require.resolve('@michelj/context-guard/package.json'));
const installed = JSON.parse(fs.readFileSync(path.join(skillRoot, 'package.json'), 'utf8'));
validateSkillFixture(configured, locked, installed);
export function skillFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) {
    throw new Error('Skill fixture path must stay inside the installed package');
  }
  return path.join(skillRoot, relative);
}
export function skillImport(relative) { return import(pathToFileURL(skillFile(relative)).href); }
