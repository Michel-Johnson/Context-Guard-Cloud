#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const hash = data => createHash('sha256').update(data).digest('hex');
const manifestFile = path.join(root, '.runtime-generated.json');
const generatedPath = file => /^(?:scripts\/shared\/|prototype\/|references\/)[^\\]+$/.test(file) || file === 'docs/interface-contract-v2.json';
const mappings = [
  ['@michelj/context-guard-core', 'scripts/shared', file => !file.startsWith('roles/') && !file.startsWith('references/') && !file.startsWith('skill-reference/') && file !== 'interface-contract-v2.json'],
  ['@michelj/context-guard-core', 'scripts/shared/roles', file => file.startsWith('roles/'), file => file.slice('roles/'.length)],
  ['@michelj/context-guard-core', 'scripts/shared', file => file.startsWith('references/') || file.startsWith('skill-reference/')],
  ['@michelj/context-guard-core', 'docs', file => file === 'interface-contract-v2.json'],
  ['@michelj/context-guard-workbench', 'prototype', () => true],
];

async function assertDestination(file) {
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep)) throw new Error(`Invalid generated destination: ${file}`);
  let current = root;
  for (const component of ['', ...path.relative(root, target).split(path.sep)]) {
    if (component) current = path.join(current, component);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Generated destination must not contain symlinks or junctions: ${file}`);
    if (stat && current !== target && !stat.isDirectory()) throw new Error(`Generated destination parent is not a directory: ${file}`);
  }
}

async function walk(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime package must not contain symlinks: ${relative}`);
    if (entry.isDirectory()) result.push(...await walk(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

export async function buildRuntime({ experimentalCore = null } = {}) {
  await assertDestination('.runtime-generated.json');
  const packageManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const outputs = new Map(), packages = {};
  for (const [name, destination, accepts, rename = file => file] of mappings) {
    const source = path.dirname(require.resolve(`${name}/package.json`));
    const descriptor = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const expected = packageManifest.dependencies?.[name];
    const releaseURL = `https://github.com/Michel-Johnson/Context-Guard-Skill/releases/download/shared-v${descriptor.version}/michelj-${name.split('/')[1]}-${descriptor.version}.tgz`;
    let experimental = null;
    if (experimentalCore && name === '@michelj/context-guard-core') {
      const bytes = await fs.readFile(experimentalCore.artifact);
      const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules/.package-lock.json'), 'utf8')).packages?.['node_modules/' + name];
      if (!/^[a-f0-9]{64}$/.test(experimentalCore.sha256 || '') || hash(bytes) !== experimentalCore.sha256 ||
        !/^\d+\.\d+\.\d+-native-json\.\d+$/.test(descriptor.version) || descriptor.name !== name ||
        installed?.version !== descriptor.version || installed?.integrity !== 'sha512-' + createHash('sha512').update(bytes).digest('base64')) {
        throw new Error('Experimental Core artifact or installed package does not match its fixed checksum');
      }
      const archive = path.resolve(experimentalCore.artifact), installedFiles = await walk(source);
      const packedFiles = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true }).trim().split('\n');
      if (JSON.stringify(packedFiles.sort()) !== JSON.stringify(installedFiles.map(file => 'package/' + file).sort())) {
        throw new Error('Experimental Core archive and installation file sets differ');
      }
      for (const file of installedFiles) {
        const packed = execFileSync('tar', ['-xOf', archive, 'package/' + file], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        if (!packed.equals(await fs.readFile(path.join(source, file)))) throw new Error('Experimental Core installed bytes differ from the fixed artifact');
      }
      experimental = { sha256: experimentalCore.sha256 };
    } else if (descriptor.name !== name || !/^\d+\.\d+\.\d+$/.test(descriptor.version) || expected !== releaseURL) throw new Error(`Unexpected runtime dependency: ${name}`);
    packages[name] = { version: descriptor.version, dependency: expected, ...(experimental ? { experimental } : {}) };
    for (const file of await walk(source)) {
      if (!accepts(file)) continue;
      const relative = path.posix.join(destination, rename(file));
      if (!generatedPath(relative) || relative.split('/').some(part => part === '..' || part === '.')) throw new Error(`Unexpected generated path: ${relative}`);
      if (outputs.has(relative)) throw new Error(`Duplicate generated runtime path: ${relative}`);
      outputs.set(relative, await fs.readFile(path.join(source, file)));
    }
  }
  let previous = { files: {} };
  try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Validate every output before making any change, including stale files
  // listed by the previous manifest. Junctions must never escape the checkout.
  for (const file of new Set([...outputs.keys(), ...Object.keys(previous.files)])) await assertDestination(file);
  // Never overwrite edits in generated runtime files. Source changes belong in
  // the Skill package and must be released before this dependency is updated.
  for (const [file, digest] of Object.entries(previous.files)) {
    const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep) || !generatedPath(file) || file.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid generated runtime manifest path');
    const current = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current && hash(current) !== digest) throw new Error(`Generated runtime was edited: ${file}`);
  }
  for (const [file, data] of outputs) {
    const target = path.join(root, file);
    if (!previous.files[file]) {
      const current = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && !current.equals(data)) throw new Error(`Refusing to overwrite an existing source: ${file}`);
    }
  }
  for (const file of Object.keys(previous.files)) if (!outputs.has(file)) await fs.unlink(path.join(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const files = {};
  for (const [file, data] of outputs) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), data);
    files[file] = hash(data);
  }
  await fs.writeFile(manifestFile, JSON.stringify({ schemaVersion: 1, packages, files }, null, 2) + '\n');
  console.log(`Materialized ${outputs.size} runtime files from fixed Skill package versions.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--experimental-core');
  const experimentalCore = index < 0 ? null : { artifact: process.argv[index + 1], sha256: process.argv[index + 2] };
  buildRuntime({ experimentalCore }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
