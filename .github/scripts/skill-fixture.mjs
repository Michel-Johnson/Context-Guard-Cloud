import assert from 'node:assert/strict';

const fixtureUrl = /^https:\/\/github\.com\/Michel-Johnson\/Context-Guard-Skill\/releases\/download\/split-fixture-([a-f0-9]{40})\/michelj-context-guard-(0\.(?:5\.0|6\.[0135]))\.tgz$/;

// A released fixture is distinct from the Cloud service's runtime dependencies.
// Exact URL identity and npm's SHA-512 lock prevent silent source substitution.
export function validateSkillFixture(configured, locked, installed) {
  assert.equal(typeof configured, 'string', 'Skill fixture dependency must be configured');
  const match = fixtureUrl.exec(configured);
  assert.ok(match && match[0] === configured, 'Skill fixture must use the approved repository and split-fixture-<40-char SHA> release URL');
  assert.equal(locked?.resolved, configured, 'Skill fixture lock must resolve the exact configured release URL');
  assert.equal(locked?.version, match[2], 'Skill fixture lock must identify the exact approved release version');
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(locked?.integrity || '');
  assert.ok(integrity && integrity[0] === locked.integrity, 'Skill fixture lock must contain one SHA-512 integrity digest');
  const digest = Buffer.from(integrity[1], 'base64');
  assert.ok(digest.length === 64 && digest.toString('base64') === integrity[1], 'Skill fixture integrity must be canonical SHA-512');
  assert.notEqual(locked?.link, true, 'Skill fixture cannot be a linked local checkout');
  if (installed) {
    assert.equal(installed.name, '@michelj/context-guard', 'Installed Skill fixture package name mismatch');
    assert.equal(installed.version, locked.version, 'Installed Skill fixture version mismatch');
  }
  return { commit: match[1], version: locked.version, integrity: locked.integrity };
}
