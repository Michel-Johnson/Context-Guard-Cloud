import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSharedDependency } from './shared-dependency.mjs';
const name = '@michelj/context-guard-core';
const url = 'https://github.com/Michel-Johnson/Context-Guard-Skill/releases/download/shared-v2.0.2/michelj-context-guard-core-2.0.2.tgz';
const lock = { resolved: url, version: '2.0.2', integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') };
test('Cloud 固定共享包的来源、版本及完整性，不接受浮动或本地依赖', () => {
  assert.equal(validateSharedDependency(name, url, lock).version, '2.0.2');
  for (const invalid of [undefined, 'latest', 'file:../skill', url.replace('Skill', 'Cloud'), url.replace('github.com/', 'github.com.evil.invalid/'), url.replace('2.0.2.tgz', '2.0.1.tgz'), url + '\n', url + '?x=1']) {
    assert.throws(() => validateSharedDependency(name, invalid, { ...lock, resolved: invalid }));
  }
  for (const invalid of [{ version: '2.0.1' }, { resolved: 'file:other' }, { link: true }, { integrity: undefined }, { integrity: lock.integrity + '\n' }]) {
    assert.throws(() => validateSharedDependency(name, url, { ...lock, ...invalid }));
  }
});
