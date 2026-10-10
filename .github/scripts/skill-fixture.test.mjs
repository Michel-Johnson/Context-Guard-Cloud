import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillFixture } from './skill-fixture.mjs';

const commit = 'a'.repeat(40);
const url = `https://github.com/Michel-Johnson/Context-Guard-Skill/releases/download/split-fixture-${commit}/michelj-context-guard-0.5.0.tgz`;
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const locked = { resolved: url, version: '0.5.0', integrity };
const installed = { name: '@michelj/context-guard', version: '0.5.0' };

test('fixed Skill release fixture requires exact URL, version and canonical SHA-512 lock', () => {
  assert.deepEqual(validateSkillFixture(url, locked, installed), { commit, version: '0.5.0', integrity });
  for (const version of ['0.6.0', '0.6.1', '0.6.3', '0.6.5', '0.7.0', '0.7.1']) {
    const nextUrl = url.replace('0.5.0', version);
    const nextLock = { ...locked, resolved: nextUrl, version };
    assert.deepEqual(validateSkillFixture(nextUrl, nextLock, { ...installed, version }), { commit, version, integrity });
    assert.throws(() => validateSkillFixture(nextUrl, { ...nextLock, version: '0.5.0' }));
  }
});

test('Skill fixture rejects local, arbitrary-host, unpinned and ambiguous release sources', () => {
  for (const value of [undefined, 'file:../skill', '0.5.0', `github:Michel-Johnson/Context-Guard-Skill#${commit}`,
    url.replace('https:', 'http:'), url.replace('github.com/', 'github.com.evil.invalid/'),
    url.replace('github.com/', 'user@github.com/'), url.replace('Michel-Johnson/', 'other-owner/'),
    url.replace('Context-Guard-Skill/', 'another-repo/'), url.replace(commit, 'main'),
    url.replace(commit, 'a'.repeat(39)), url.replace(commit, 'A'.repeat(40)),
    url.replace('0.5.0', '0.5.1'), url.replace('0.5.0', '0.6.2'), url.replace('0.5.0', '0.6.4'),
    url.replace('0.5.0', '0.6.30'), url.replace('0.5.0', 'latest'), url.replace('0.5.0', '0.7.2'), `${url}?download=1`, `${url}#fragment`, `${url}\n`]) {
    assert.throws(() => validateSkillFixture(value, { ...locked, resolved: value }), undefined, String(value));
  }
});

test('Cursor owning-backend fixture permits only the exact reviewed release commit and version', () => {
  const approvedCommit = 'dababe445976a2504bc8d02ccc747056bcde30a0';
  const nextUrl = url.replace(commit, approvedCommit).replace('0.5.0', '0.11.0');
  const nextLock = { resolved: nextUrl, version: '0.11.0', integrity };
  assert.deepEqual(validateSkillFixture(nextUrl, nextLock, { ...installed, version: '0.11.0' }),
    { commit: approvedCommit, version: '0.11.0', integrity });
  for (const rejected of [nextUrl.replace(approvedCommit, commit), nextUrl.replace(approvedCommit, '0ce5a2a528f0a56ebc5af525a74316eb0166c561'), nextUrl.replace('0.11.0', '0.11.1'),
    nextUrl.replace('0.11.0', '0.12.0')]) {
    assert.throws(() => validateSkillFixture(rejected, { ...nextLock, resolved: rejected }));
  }
  assert.throws(() => validateSkillFixture(nextUrl, { ...nextLock, version: '0.7.1' }));
});

test('Skill fixture rejects missing or mismatched lock and installed package identity', () => {
  for (const change of [{ resolved: undefined }, { resolved: `${url}?alternate=1` }, { version: '0.4.4' },
    { integrity: undefined }, { integrity: 'sha256-' + Buffer.alloc(32).toString('base64') },
    { integrity: integrity + ' ' + integrity }, { integrity: integrity + '\n' }, { integrity: 'sha512-' + 'A'.repeat(87) + '=' }, { link: true }]) {
    assert.throws(() => validateSkillFixture(url, { ...locked, ...change }));
  }
  assert.throws(() => validateSkillFixture(url, undefined));
  assert.throws(() => validateSkillFixture(url, locked, { ...installed, version: '0.4.4' }));
  assert.throws(() => validateSkillFixture(url, locked, { ...installed, name: 'other-package' }));
});
