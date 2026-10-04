#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist');
await fs.mkdir(destination, { recursive: true });
const checksums = [];
for (const directory of ['scripts/shared', 'prototype']) {
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', destination];
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const invocation = process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.map(value => `"${value}"`).join(' ')}`] : args;
  const result = spawnSync(command, invocation, { cwd: path.join(root, directory), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`Unable to pack ${directory}: ${result.stderr}`);
  const [packed] = JSON.parse(result.stdout);
  if (!packed || path.basename(packed.filename) !== packed.filename) throw new Error('Invalid package output');
  const data = await fs.readFile(path.join(destination, packed.filename));
  checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${packed.filename}`);
}
await fs.writeFile(path.join(destination, 'SHA256SUMS'), checksums.join('\n') + '\n');
console.log(checksums.join('\n'));
