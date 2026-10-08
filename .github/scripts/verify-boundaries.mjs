import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateSkillFixture } from './skill-fixture.mjs';
import { validateSharedDependency } from './shared-dependency.mjs';

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false, `Unexpected symlink: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
for (const forbidden of ['scripts/workbench', 'scripts/legacy', 'scripts/sync', 'bin', 'hooks.json', 'scripts/context_guard.py', 'scripts/context_guard_hook.py', 'Coordinator.md']) {
  assert.equal(fs.existsSync(forbidden), false, `Cloud must not maintain a second client source: ${forbidden}`);
}
for (const file of walk('scripts/shared').filter(file => /\.(?:mjs|cjs|js)$/.test(file))) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:from\s*|import\s*\()['"][^'"]*(?:workbench|cloud|prototype)\//, file);
}
for (const file of walk('scripts/cloud').filter(file => file.endsWith('.mjs'))) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:from\s*|import\s*\()['"][^'"]*(?:workbench|context-guard\/scripts)\//, file);
}
for (const file of walk('tests').filter(file => file.endsWith('.mjs'))) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:from\s*|import\s*\()['"]\.\.\/scripts\/workbench\//, file);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(pkg.dependencies?.['@michelj/context-guard'], undefined, 'Skill is a dev-only integration fixture');
const fixture = pkg.devDependencies?.['@michelj/context-guard'];
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
validateSkillFixture(fixture, lock.packages?.['node_modules/@michelj/context-guard']);
assert.ok(pkg.files?.length, 'Cloud package requires an explicit files allowlist');
for (const file of pkg.files) assert.doesNotMatch(file, /(?:tests|\.github|node_modules|^bin|scripts\/(?:workbench|legacy|sync))/);
for (const name of ['@michelj/context-guard-core', '@michelj/context-guard-workbench']) {
  validateSharedDependency(name, pkg.dependencies?.[name], lock.packages?.['node_modules/' + name]);
}
const manifest = JSON.parse(fs.readFileSync('.runtime-generated.json', 'utf8'));
assert.equal(execFileSync('git', ['ls-files', 'scripts/shared', 'prototype', 'docs/interface-contract-v2.json'], { encoding: 'utf8', windowsHide: true }).trim(), '', 'Cloud must not track generated Skill sources');
for (const file of ['scripts/shared/package.json', 'prototype/package.json', 'docs/interface-contract-v2.json']) assert.ok(manifest.files[file]);
console.log('Verified Cloud/client source boundaries and fixed Skill package dependencies.');
