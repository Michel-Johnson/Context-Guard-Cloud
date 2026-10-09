import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorGitProof } from '../scripts/cloud/cursor-git-proof.mjs';

const baseSha = 'a'.repeat(40), sourceSha = 'b'.repeat(40), branch = 'cursor/task-one';
function fixture(change) {
  const calls = [], data = {
    head: { name: branch, commit: { sha: sourceSha } }, commit: { sha: sourceSha, parents: [{ sha: baseSha }], files: [{ filename: 'src/fixture.mjs' }] },
    comparison: { base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, status: 'ahead', behind_by: 0,
      total_commits: 1, commits: [{ sha: sourceSha }], files: [{ filename: 'src/fixture.mjs' }] },
  };
  change?.(data);
  const verifier = new CursorGitProof({ repository: 'example/repo', fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error'); assert.equal(new URL(url).origin, 'https://api.github.com');
    const response = url.includes('/branches/') ? data.head : url.includes('/compare/') ? data.comparison : data.commit;
    return new Response(JSON.stringify(response), { status: 200 });
  } });
  const input = { run: { status: 'FINISHED', git: { branches: [{ repoUrl: 'github.com/example/repo', branch }] } },
    baseSha, sourceSha, approvedPaths: ['src/'] };
  return { calls, data, input, verifier };
}
test('Cursor Git proof reads only the approved repository and verifies own branch, actual commit, base and complete reviewed diff', async () => {
  const f = fixture(), proof = await f.verifier.verify(f.input);
  assert.equal(proof.sourceSha, sourceSha); assert.equal(proof.baseSha, baseSha); assert.equal(proof.branch, branch);
  assert.deepEqual(proof.files, ['src/fixture.mjs']); assert.equal(f.calls.length, 4);
  assert.equal(f.calls.every(call => call.url.startsWith('https://api.github.com/repos/example/repo/')), true);
  assert.match(f.calls[0].url, /cursor%2Ftask-one$/);
});
test('Cursor Git proof rejects foreign branch, stale SHA, unapproved changes, renames and incomplete comparisons', async t => {
  const cases = {
    branchSha: f => { f.data.head.commit.sha = baseSha; },
    missingCommit: f => { f.data.commit.sha = baseSha; },
    base: f => { f.data.comparison.merge_base_commit.sha = sourceSha; },
    foreign: f => { f.input.run.git.branches[0].repoUrl = 'github.com/other/repo'; },
    main: f => { f.input.run.git.branches[0].branch = 'main'; },
    path: f => { f.data.comparison.files[0].filename = 'other/file.mjs'; },
    rename: f => { f.data.comparison.files[0].previous_filename = 'other/private.mjs'; },
    traversal: f => { f.data.comparison.files[0].filename = 'src/../other.mjs'; },
    partialCommits: f => { f.data.comparison.total_commits = 2; },
    truncatedFiles: f => { f.data.comparison.files = Array.from({ length: 300 }, () => ({ filename: 'src/fixture.mjs' })); },
    invalidScope: f => { f.input.approvedPaths = ['../']; },
    mergedHistory: f => { f.data.commit.parents.push({ sha: 'c'.repeat(40) }); },
    incompleteCommit: f => { f.data.commit.files = Array.from({ length: 100 }, () => ({ filename: 'src/fixture.mjs' })); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); change(f); await assert.rejects(f.verifier.verify(f.input), { code: 'SOURCE_UNVERIFIED' });
  });
});

test('Cursor Git scope verification rejects an out-of-scope commit even when a later revert hides it from the final diff', async () => {
  const f = fixture(), intermediateSha = 'c'.repeat(40);
  f.data.comparison.total_commits = 2; f.data.comparison.commits.unshift({ sha: intermediateSha });
  f.data.commit.parents = [{ sha: intermediateSha }];
  const original = f.verifier.request;
  f.verifier.request = async (url, options) => url.includes('/commits/' + intermediateSha) ? new Response(JSON.stringify({
    sha: intermediateSha, parents: [{ sha: baseSha }], files: [{ filename: '.codex/private.md' }],
  })) : original(url, options);
  await assert.rejects(f.verifier.verify(f.input), { code: 'SOURCE_UNVERIFIED' });
});

test('Cursor Git verification refuses pagination rather than silently ignoring hidden files or checks', async () => {
  const f = fixture(); f.verifier.request = async () => new Response(JSON.stringify(f.data.head), {
    headers: { Link: '<https://api.github.com/page-two>; rel="next"' },
  });
  await assert.rejects(f.verifier.verify(f.input), { code: 'SOURCE_UNVERIFIED' });
});
test('Cursor Git proof catches a moved branch after immutable comparison, without mutating GitHub', async () => {
  const f = fixture(); let heads = 0;
  f.verifier.request = async url => {
    f.calls.push({ url });
    if (url.includes('/branches/')) return new Response(JSON.stringify({ name: branch, commit: { sha: ++heads === 1 ? sourceSha : baseSha } }));
    return new Response(JSON.stringify(url.includes('/compare/') ? f.data.comparison : f.data.commit));
  };
  await assert.rejects(f.verifier.verify(f.input), { code: 'SOURCE_UNVERIFIED' });
  assert.equal(f.calls.length, 4);
});
test('Cursor Git proof rejects transport/malformed/private responses without copying secret values', async () => {
  for (const request of [async () => { throw new Error('private-value'); }, async () => new Response('private-value'),
    async () => new Response('private-value', { status: 403 })]) {
    const f = fixture(); f.verifier.request = request;
    await assert.rejects(f.verifier.verify(f.input), cause => { assert.equal(cause.code, 'SOURCE_UNVERIFIED'); assert.doesNotMatch(cause.message, /private-value/); return true; });
  }
});

function checksFixture() {
  const calls = [], data = { total_count: 1, check_runs: [{ id: 1, name: 'Required', app: { id: 15368 }, head_sha: sourceSha, status: 'completed', conclusion: 'success' }] };
  const verifier = new CursorGitProof({ repository: 'example/repo', fetch: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(data));
  } });
  const input = { sourceSha, requiredChecks: [{ name: 'Required', appId: 15368 }] };
  return { calls, data, verifier, input };
}
test('Exact-SHA CI machine facts pin configured check names and issuer, retaining all push/PR suites without inventing task verdicts', async () => {
  const f = checksFixture(); f.data.check_runs.push({ ...f.data.check_runs[0], id: 2, conclusion: 'failure' }); f.data.total_count = 2;
  const facts = await f.verifier.checks(f.input);
  assert.equal(facts.length, 2); assert.deepEqual(facts.map(check => check.conclusion), ['success', 'failure']);
  assert.equal(facts.every(check => check.sourceSha === sourceSha && check.appId === 15368), true);
  assert.equal(facts.some(check => 'verdict' in check || 'testId' in check), false);
  assert.match(f.calls[0].url, /\/commits\/b{40}\/check-runs\?filter=latest&per_page=100$/);
});
test('Exact-SHA check facts refuse wrong issuer/revision, absent or running/skipped checks, incomplete lists and invalid policy', async t => {
  const cases = {
    issuer: f => { f.data.check_runs[0].app.id = 9; },
    revision: f => { f.data.check_runs[0].head_sha = baseSha; },
    missing: f => { f.data.check_runs = []; f.data.total_count = 0; },
    running: f => { f.data.check_runs[0].status = 'in_progress'; },
    skipped: f => { f.data.check_runs[0].conclusion = 'skipped'; },
    neutral: f => { f.data.check_runs[0].conclusion = 'neutral'; },
    incomplete: f => { f.data.total_count = 2; },
    noPolicy: f => { f.input.requiredChecks = []; },
    duplicatedPolicy: f => { f.input.requiredChecks.push({ appId: 15368, name: 'Required' }); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = checksFixture(); change(f); await assert.rejects(f.verifier.checks(f.input), { code: 'SOURCE_UNVERIFIED' });
  });
});
