import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfig } from './ci-impact.mjs';

const source = fs.readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r\n', '\n');
const config = JSON.parse(fs.readFileSync('.github/ci-impact.json', 'utf8'));
validateConfig(config);
assert.deepEqual(config.jobs, ['test', 'minimum-runtime', 'slack', 'browser', 'package']);
assert.ok(config.fullRunPatterns.includes('.github/**'), 'CI changes must force complete CI');
for (const name of ['impact', 'security', 'test', 'minimum-runtime', 'slack', 'browser', 'package', 'required']) {
  assert.match(source, new RegExp(`^  ${name}:$`, 'm'), `Missing mandatory CI job: ${name}`);
}
assert.match(source, /^    name: Required$/m);
assert.match(source, /needs: \[impact, security, test, minimum-runtime, slack, browser, package\]/);
for (const job of config.jobs) {
  const block = source.split(`  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.ok(block, `Missing selected job: ${job}`);
  assert.match(block, /needs: \[impact, security\]/);
  assert.ok(block.includes(`if: needs.impact.outputs.${job.replaceAll('-', '_')} == 'true'`));
}
assert.match(source, /fetch-depth: 0/);
assert.match(source, /ci-impact\.mjs/);
assert.match(source, /--check-required true/);
assert.match(source, /--test \.github\/scripts\/ci-impact\.test\.mjs/);
assert.match(source, /name: cloud-ci-impact-plan/);
assert.match(source, /if-no-files-found: error/);
for (const job of ['impact', 'security']) {
  const block = source.split(`  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.doesNotMatch(block, /^    if:/m, `${job} must always run`);
}
assert.match(source, /if: always\(\)/);
assert.match(source, /contents: read/);
assert.match(source, /node-version: ['"]18['"]/);
assert.match(source, /node-version: ['"]22['"]/);
assert.match(source, /security-scan\.mjs ci/);
assert.match(source, /npm run security:test/);
assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund/);
assert.match(source, /npm ci --prefix plugins\/slack --ignore-scripts/);
assert.match(source, /npm run test:browser/);
assert.match(source, /npm run build:runtime/);
assert.doesNotMatch(source, /pack:shared/);
assert.match(source, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
assert.match(source, /cloud-installed-smoke\.mjs/);
assert.match(source, /name: Bound browser dependency downloads/);
assert.match(source, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
assert.match(source, /Acquire::http::Timeout "20"/);
assert.match(source, /Acquire::https::Timeout "20"/);
assert.match(source, /Acquire::Retries "1"/);
assert.match(source, /output\/playwright\/browser-ci\/\*\*\/result\.json/);
assert.match(source, /security-scan\.mjs package/);
assert.doesNotMatch(source, /pull_request_target|continue-on-error|\|\|\s*true|npm publish/);
assert.doesNotMatch(source, /trusted=yes|AllowInsecureRepositories|Verify-Peer.*false|--allow-unauthenticated/);
for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/, 'Actions must use immutable commits');
console.log('Verified selective, fail-closed Cloud CI without deployment side effects.');
