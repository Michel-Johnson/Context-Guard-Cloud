import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const builder = fileURLToPath(new URL('../scripts/build-runtime.mjs', import.meta.url));
const releaseURL = (name, version) => `https://github.com/Michel-Johnson/Context-Guard-Skill/releases/download/shared-v${version}/michelj-${name.split('/')[1]}-${version}.tgz`;
async function fixture(t, { declaredVersion = '1.0.0', installedVersion = '1.0.0' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-build-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'skill'), outside = path.join(directory, 'outside');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(outside);
  await fs.copyFile(builder, path.join(root, 'scripts/build-runtime.mjs'));
  const dependencies = {};
  for (const [name, files] of [
    ['@michelj/context-guard-core', { 'example.mjs': 'export const example = 1;\n', 'roles/Tester.md': '# Tester\n' }],
    ['@michelj/context-guard-workbench', { 'workbench.html': '<!doctype html><title>Test</title>' }],
  ]) {
    dependencies[name] = releaseURL(name, declaredVersion);
    const packageRoot = path.join(root, 'node_modules', name);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: installedVersion, type: 'module' }));
    for (const [file, data] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(packageRoot, file)), { recursive: true });
      await fs.writeFile(path.join(packageRoot, file), data);
    }
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: dependencies }));
  return { root, outside,
    run: async (args = []) => {
      try { const result = await exec(process.execPath, ['scripts/build-runtime.mjs', ...args], { cwd: root, windowsHide: true }); return { code: 0, ...result }; }
      catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
  };
}

test('runtime builder materializes pinned core and UI with a repeatable manifest', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const first = await fs.readFile(path.join(f.root, '.runtime-generated.json'), 'utf8');
  assert.equal((await f.run()).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, '.runtime-generated.json'), 'utf8'), first);
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/roles/Tester.md'), 'utf8'), '# Tester\n');
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/example.mjs'), 'utf8'), 'export const example = 1;\n');
});

test('runtime builder migrates reference directories without changing runtime or user files', async t => {
  const f = await fixture(t);
  const core = path.join(f.root, 'node_modules/@michelj/context-guard-core');
  await fs.mkdir(path.join(core, 'references'));
  await fs.writeFile(path.join(core, 'references/map-read.md'), 'old guide');
  assert.equal((await f.run()).code, 0);
  await fs.writeFile(path.join(f.root, 'user-note.md'), 'preserve');
  await fs.unlink(path.join(core, 'references/map-read.md'));
  await fs.mkdir(path.join(core, 'skill-reference'));
  await fs.writeFile(path.join(core, 'skill-reference/map-read.md'), 'new guide');
  assert.equal((await f.run()).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/skill-reference/map-read.md'), 'utf8'), 'new guide');
  await assert.rejects(fs.access(path.join(f.root, 'scripts/shared/references/map-read.md')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/example.mjs'), 'utf8'), 'export const example = 1;\n');
  assert.equal(await fs.readFile(path.join(f.root, 'user-note.md'), 'utf8'), 'preserve');
  assert.equal((await f.run()).code, 0);
});

test('runtime builder preserves existing source files instead of overwriting them', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'scripts/shared/roles'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'scripts/shared/roles/Tester.md'), '# User source\n');
  assert.notEqual((await f.run()).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/roles/Tester.md'), 'utf8'), '# User source\n');
});

test('runtime builder preserves edits to previously generated files', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  await fs.writeFile(path.join(f.root, 'scripts/shared/roles/Tester.md'), '# User edit\n');
  assert.notEqual((await f.run()).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/roles/Tester.md'), 'utf8'), '# User edit\n');
});

test('runtime builder rejects generated manifest path traversal before modifying files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outside, 'sentinel'), 'preserve');
  await fs.writeFile(path.join(f.root, '.runtime-generated.json'), JSON.stringify({ files: { '../outside/sentinel': 'invalid' } }));
  assert.notEqual((await f.run()).code, 0);
  assert.equal(await fs.readFile(path.join(f.outside, 'sentinel'), 'utf8'), 'preserve');
});

test('runtime builder rejects a destination junction before writing outside the Skill root', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'scripts'), { recursive: true });
  await fs.symlink(f.outside, path.join(f.root, 'scripts/shared'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.run();
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(await fs.readdir(f.outside), []);
});

test('runtime builder rejects a linked manifest before reading or overwriting it', async t => {
  const f = await fixture(t);
  const outsideManifest = path.join(f.outside, 'manifest.json');
  const original = JSON.stringify({ files: {} });
  await fs.writeFile(outsideManifest, original);
  try { await fs.symlink(outsideManifest, path.join(f.root, '.runtime-generated.json'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`File symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  assert.notEqual((await f.run()).code, 0);
  assert.equal(await fs.readFile(outsideManifest, 'utf8'), original);
});

test('runtime builder rejects installed 1.0.0 when the fixed release requires 1.1.0', async t => {
  const f = await fixture(t, { declaredVersion: '1.1.0' });
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unexpected runtime dependency/);
  assert.equal(await fs.access(path.join(f.root, '.runtime-generated.json')).then(() => true, () => false), false);
});

test('runtime builder upgrades matching fixed releases from 1.0.0 to 1.0.1', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const packageFile = path.join(f.root, 'package.json');
  const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  for (const name of Object.keys(manifest.dependencies)) {
    manifest.dependencies[name] = releaseURL(name, '1.0.1');
    const descriptorFile = path.join(f.root, 'node_modules', name, 'package.json');
    const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
    descriptor.version = '1.0.1';
    await fs.writeFile(descriptorFile, JSON.stringify(descriptor));
  }
  await fs.writeFile(packageFile, JSON.stringify(manifest));
  await fs.writeFile(path.join(f.root, 'node_modules/@michelj/context-guard-core/example.mjs'), 'export const example = 2;\n');
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(f.root, 'scripts/shared/example.mjs'), 'utf8'), 'export const example = 2;\n');
  const generated = JSON.parse(await fs.readFile(path.join(f.root, '.runtime-generated.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies)) {
    assert.equal(generated.packages[name].version, '1.0.1');
    assert.equal(generated.packages[name].dependency, releaseURL(name, '1.0.1'));
  }
});
async function experimentalFixture(t) {
  const f = await fixture(t), name = '@michelj/context-guard-core';
  const source = path.join(f.root, 'node_modules', name), descriptorFile = path.join(source, 'package.json');
  const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  descriptor.version = '1.0.0-native-json.0'; await fs.writeFile(descriptorFile, JSON.stringify(descriptor));
  const stage = path.join(f.root, 'artifact-stage'); await fs.mkdir(stage);
  await fs.cp(source, path.join(stage, 'package'), { recursive: true });
  const artifact = path.join(f.root, 'experimental-core.tgz');
  await exec('tar', ['-czf', artifact, '-C', stage, 'package/package.json', 'package/example.mjs', 'package/roles/Tester.md'], { windowsHide: true });
  const bytes = await fs.readFile(artifact), sha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(f.root, 'node_modules/.package-lock.json'), JSON.stringify({ packages: {
    ['node_modules/' + name]: { version: descriptor.version, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
  } }));
  return { ...f, source, artifact, sha256 };
}
test('experimental builder requires explicit checksum and preserves official dependencies', async t => {
  const f = await experimentalFixture(t), before = await fs.readFile(path.join(f.root, 'package.json'), 'utf8');
  assert.notEqual((await f.run()).code, 0);
  assert.equal((await f.run(['--experimental-core', f.artifact, f.sha256])).code, 0);
  const generated = JSON.parse(await fs.readFile(path.join(f.root, '.runtime-generated.json'), 'utf8'));
  assert.deepEqual(generated.packages['@michelj/context-guard-core'].experimental, { sha256: f.sha256 });
  assert.equal(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'), before);
});
test('experimental builder rejects checksum mismatch before generating any output', async t => {
  const f = await experimentalFixture(t);
  assert.notEqual((await f.run(['--experimental-core', f.artifact, '0'.repeat(64)])).code, 0);
  await assert.rejects(fs.access(path.join(f.root, '.runtime-generated.json')), { code: 'ENOENT' });
});
test('experimental builder compares actual installed bytes rather than trusting installation metadata', async t => {
  const f = await experimentalFixture(t);
  await fs.writeFile(path.join(f.source, 'example.mjs'), 'export const tampered = true;');
  const result = await f.run(['--experimental-core', f.artifact, f.sha256]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /installed bytes differ/);
  await assert.rejects(fs.access(path.join(f.root, '.runtime-generated.json')), { code: 'ENOENT' });
});
