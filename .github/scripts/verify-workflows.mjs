import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
for (const name of ['security', 'test', 'minimum-runtime', 'slack', 'browser', 'package', 'required']) {
  assert.match(source, new RegExp(`^  ${name}:$`, 'm'), `Missing mandatory CI job: ${name}`);
}
assert.match(source, /^    name: Required$/m);
assert.match(source, /needs: \[security, test, minimum-runtime, slack, browser, package\]/);
assert.match(source, /if: always\(\)/);
assert.match(source, /contents: read/);
assert.match(source, /node-version: ['"]18['"]/);
assert.match(source, /node-version: ['"]22['"]/);
assert.match(source, /security-scan\.mjs ci/);
assert.match(source, /npm run security:test/);
assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund/);
assert.match(source, /npm ci --prefix plugins\/slack --ignore-scripts/);
assert.match(source, /npm run test:browser/);
assert.match(source, /security-scan\.mjs package/);
assert.doesNotMatch(source, /pull_request_target|continue-on-error|\|\|\s*true|npm publish/);
for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/, 'Actions must use immutable commits');
console.log('Verified complete, fail-closed Cloud CI without deployment side effects.');
