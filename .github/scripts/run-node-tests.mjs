import fs from 'node:fs';
import { run } from './client-protocol.mjs';

const manifest = JSON.parse(fs.readFileSync('tests/test-manifest.json', 'utf8'));
const excluded = new Set(manifest.automaticNodeTests.excluded);
const files = manifest.automaticNodeTests.roots.flatMap(directory => fs.readdirSync(directory)
  .filter(name => name.endsWith('.test.mjs')).map(name => `${directory}/${name}`))
  .filter(file => !excluded.has(file)).sort();
if (!files.length) throw new Error('No Cloud tests discovered');
await run(process.execPath, ['--test', '--test-concurrency=2', ...files], { inheritOutput: true, timeout: 15 * 60 * 1000 });
