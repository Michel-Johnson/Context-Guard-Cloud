import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Only these product roots can enter the service package. Tests, local clients,
// credentials and deployment state remain excluded even if package.json changes.
const allowedRoots = ['scripts/cloud', 'scripts/shared', 'prototype', 'deploy', 'licenses', 'references'];
const allowedFiles = ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md'];
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Product packages must not contain symlinks');
    return entry.isDirectory() ? files(relative) : [relative];
  });
}
export const packedFiles = [...allowedFiles, ...allowedRoots.flatMap(files)].sort();
export function packageFiles(kind = 'cloud') {
  if (kind === 'cloud') return packedFiles;
  const directory = kind === 'core' ? 'scripts/shared' : kind === 'workbench' ? 'prototype' : null;
  if (!directory) throw new Error('Unknown release package kind');
  const permittedDirectory = kind === 'core' ? /^(?:vendor|roles|references|LICENSES)\// : /^(?:vendor|LICENSES)\//;
  const permittedFile = kind === 'core' ? /^[^/]+\.mjs$/ : /^[^/]+\.(?:html|js|mjs|css|png)$/;
  return files(directory).map(file => file.slice(directory.length + 1)).filter(file =>
    ['package.json', 'README.md', 'LICENSE'].includes(file) || permittedDirectory.test(file) || permittedFile.test(file)).sort();
}
