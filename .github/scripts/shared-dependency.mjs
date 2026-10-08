import assert from 'node:assert/strict';

export function validateSharedDependency(name, configured, locked) {
  assert.ok(['@michelj/context-guard-core', '@michelj/context-guard-workbench'].includes(name));
  const expression = new RegExp('^https://github\\.com/Michel-Johnson/Context-Guard-Skill/releases/download/shared-v(\\d+\\.\\d+\\.\\d+)/michelj-' + name.split('/')[1] + '-\\1\\.tgz$');
  const match = typeof configured === 'string' && expression.exec(configured);
  assert.ok(match && match[0] === configured, 'Shared dependency must use a fixed Skill release');
  assert.equal(locked?.resolved, configured, 'Shared lock must resolve the exact release');
  assert.equal(locked?.version, match[1]);
  assert.notEqual(locked?.link, true);
  const digest = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(locked?.integrity || '');
  assert.ok(digest && digest[0] === locked.integrity);
  assert.equal(Buffer.from(digest[1], 'base64').toString('base64'), digest[1]);
  return { version: match[1], integrity: locked.integrity };
}
