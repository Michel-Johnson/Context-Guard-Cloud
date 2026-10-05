import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { completeSessionMemory, commitSessionMap, memoryPublicationStatus, publishSessionMemory, readMemoryProject, sessionCompletionMatches, startMemoryServer } from '../scripts/cloud/memory.mjs';
import { projectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { atomicWrite, encode, readJSON, withFileLock } from '../scripts/shared/io.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-reviewed-publication-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(root, 'code.txt'), 'baseline'); git('add', 'code.txt'); git('commit', '-m', 'baseline');
  const sha = git('rev-parse', 'HEAD');
  const configuration = { dataDir: path.join(root, 'memory'), adminToken: 'admin-fixture', projects: { project: { token: 'agent-fixture', root, ref: 'refs/heads/main' } } };
  const service = await startMemoryServer(configuration);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const send = async (scope, input, token = 'agent-fixture') => {
    const response = await fetch(`${service.url}/v1/projects/project/${scope}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const map = { v: 1, root: { id: 'T0', title: 'Fixture', kind: 'module', state: 'dirty', children: [] } };
  const seed = async (id = 's1', baseMainVersion = null) => {
    const saved = await send(`sessions/${id}`, { operationId: `seed-${id}-${baseMainVersion}`, baseVersion: null, baseMainVersion, sourceCommit: sha, memory: { map, records: {} }, completion: { forged: true } });
    assert.equal(saved.status, 200, JSON.stringify(saved)); return saved.snapshot;
  };
  const complete = snapshot => ({ operationId: `complete-${snapshot.sessionId}-${snapshot.version}`, sessionId: snapshot.sessionId, generation: snapshot.generation, sessionVersion: snapshot.version, sourceCommit: snapshot.sourceCommit });
  const publish = snapshot => ({ operationId: `publish-${snapshot.sessionId}-${snapshot.version}`, sessionId: snapshot.sessionId, sessionVersion: snapshot.version, baseVersion: snapshot.baseMainVersion, expectedMainSha: sha });
  return { root, sha, configuration, send, seed, complete, publish };
}

async function automaticScan(f, overrides = {}) {
  const source = await fs.readFile(new URL('../scripts/cloud/server.mjs', import.meta.url), 'utf8');
  const scanSource = source.slice(source.indexOf('  let automaticPublicationRunning = null;'), source.indexOf('  const validateOperationId = input =>'));
  const calls = { reads: 0, status: 0, publications: 0, errors: [] };
  const scan = runInNewContext(`${scanSource}; publishMergedSessions`, {
    configuredMemory: f.configuration, registry: { projects: [{ id: 'project' }] },
    fs, projectMemoryFile, automaticPublicationMaxBytes: Number.MAX_SAFE_INTEGER, sessionCompletionMatches,
    readMemoryProject: async (...args) => { calls.reads++; return readMemoryProject(...args); },
    publicationState: async (project, view, options) => {
      calls.status++;
      return memoryPublicationStatus(f.configuration, project.id, view.slice('session:'.length), options);
    },
    publishSessionMemory: async (...args) => { calls.publications++; return publishSessionMemory(...args); },
    console: { error: message => calls.errors.push(message) }, ...overrides,
  });
  await scan();
  return calls;
}

test('automatic publication scan reads once and skips absent or stale completion before any Git status check', async t => {
  const f = await fixture(t), session = await f.seed();
  const state = await readMemoryProject(f.configuration, 'project');
  for (const mismatch of ['sessionId', 'generation', 'sessionVersion', 'sourceCommit']) {
    const completion = { sessionId: session.sessionId, generation: session.generation,
      sessionVersion: session.version, sourceCommit: session.sourceCommit };
    completion[mismatch] = mismatch === 'generation' ? 2 : 'stale';
    state.sessions[`stale-${mismatch}`] = { ...session, completion };
  }
  let reads = 0;
  const calls = await automaticScan(f, {
    readMemoryProject: async () => { reads++; return structuredClone(state); },
    publicationState: async () => { throw new Error('Git status must not run without exact completion'); },
    publishSessionMemory: async () => { throw new Error('Publication must not run without exact completion'); },
  });
  assert.equal(reads, 1);
  assert.equal(calls.errors.length, 0, calls.errors.join('\n'));
  assert.equal((await readMemoryProject(f.configuration, 'project')).main, null);
});

test('automatic publication scan publishes a completed merged Session through the original full gate', async t => {
  const f = await fixture(t), session = await f.seed();
  await f.seed('unfinished');
  await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  const calls = await automaticScan(f);
  assert.deepEqual({ reads: calls.reads, status: calls.status, publications: calls.publications, errors: calls.errors },
    { reads: 1, status: 1, publications: 1, errors: [] });
  const state = await readMemoryProject(f.configuration, 'project');
  assert.equal(state.main.memory.map.root.title, 'Fixture');
  assert.equal(state.closedSessions.s1.generation, 1);
  assert.equal(state.sessions.s1, undefined);
  assert.ok(state.sessions.unfinished, 'an unfinished Session remains active');
});

test('automatic publication scan cannot use an earlier completion after an edit during candidate selection', async t => {
  const f = await fixture(t), session = await f.seed();
  await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  let checked = 0, published = 0;
  const calls = await automaticScan(f, {
    publicationState: async (project, view, options) => {
      checked++;
      await commitSessionMap(f.configuration, 'project', 's1', { operationId: 'race-before-status', baseVersion: session.version,
        operations: [{ type: 'update', id: 'T0', fields: { purpose: 'new work invalidates completion' } }] });
      return memoryPublicationStatus(f.configuration, project.id, view.slice('session:'.length), options);
    },
    publishSessionMemory: async () => { published++; throw new Error('Revoked completion must not reach publication'); },
  });
  assert.equal(checked, 1);
  assert.equal(published, 0);
  assert.equal(calls.errors.length, 0, calls.errors.join('\n'));
  const state = await readMemoryProject(f.configuration, 'project');
  assert.equal(state.main, null);
  assert.equal(state.sessions.s1.completion, undefined);
});

test('automatic publication scan rechecks completion under the final write lock after ready status', async t => {
  const f = await fixture(t), session = await f.seed();
  await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  let writes = 0;
  const calls = await automaticScan(f, {
    publishSessionMemory: async (...args) => {
      writes++;
      await commitSessionMap(f.configuration, 'project', 's1', { operationId: 'race-before-write', baseVersion: session.version,
        operations: [{ type: 'update', id: 'T0', fields: { purpose: 'new work after ready status' } }] });
      return publishSessionMemory(...args);
    },
  });
  assert.equal(calls.status, 1);
  assert.equal(writes, 1);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /Session version changed/);
  const state = await readMemoryProject(f.configuration, 'project');
  assert.equal(state.main, null);
  assert.equal(state.sessions.s1.completion, undefined);
  assert.equal(Object.values(state.receipts).some(receipt => receipt.result?.closedSession), false);
});

test('Main ancestry, empty workflow and uploads cannot replace exact human completion', async t => {
  const f = await fixture(t), session = await f.seed();
  assert.equal(session.completion, undefined);
  assert.equal((await memoryPublicationStatus(f.configuration, 'project', 's1')).reason, 'SESSION_COMPLETION_REQUIRED');
  await assert.rejects(publishSessionMemory(f.configuration, 'project', f.publish(session)), { code: 'SESSION_COMPLETION_REQUIRED' });
  assert.equal((await f.send('sessions/s1/complete', f.complete(session))).status, 403);
  await assert.rejects(completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'agent' }), { code: 'FORBIDDEN' });
  for (const invalid of [{ generation: 2 }, { sessionVersion: 'stale' }, { sourceCommit: 'a'.repeat(40) }]) {
    await assert.rejects(completeSessionMemory(f.configuration, 'project', { ...f.complete(session), ...invalid }, { kind: 'human' }), { code: 'VERSION_CONFLICT' });
  }
  const completion = await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  assert.deepEqual(await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' }), completion);
  await assert.rejects(completeSessionMemory(f.configuration, 'project', { ...f.complete(session), generation: 2 }, { kind: 'human' }), { code: 'ID_REUSED' });
  assert.equal((await memoryPublicationStatus(f.configuration, 'project', 's1')).status, 'ready');
  f.configuration.publicationGate = async () => false;
  await assert.rejects(publishSessionMemory(f.configuration, 'project', f.publish(session)), { code: 'TASK_SOURCE_PENDING' });
  assert.equal((await readMemoryProject(f.configuration, 'project')).main, null);
  let checks = 0;
  f.configuration.publicationGate = async () => ++checks === 1;
  await assert.rejects(publishSessionMemory(f.configuration, 'project', f.publish(session)), { code: 'TASK_SOURCE_PENDING' });
  assert.equal(checks, 2, 'task review is checked again after Git verification');
  assert.equal((await readMemoryProject(f.configuration, 'project')).main, null);
  f.configuration.publicationGate = async () => true;
  const published = await publishSessionMemory(f.configuration, 'project', f.publish(session));
  assert.equal(published.closedSession.generation, 1);
  assert.deepEqual(await publishSessionMemory(f.configuration, 'project', f.publish(session)), published);
  const reopened = await f.seed('s1', published.snapshot.version);
  assert.equal(reopened.generation, 2);
  assert.equal(sessionCompletionMatches(reopened), false);
  assert.equal((await memoryPublicationStatus(f.configuration, 'project', 's1')).reason, 'SESSION_COMPLETION_REQUIRED');
  assert.deepEqual(await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' }), completion);
  assert.equal(sessionCompletionMatches((await readMemoryProject(f.configuration, 'project')).sessions.s1), false, 'old completion retry cannot complete a new generation');
});

test('Map edits, full uploads and restores invalidate completion; stale proof does not publish', async t => {
  const f = await fixture(t), first = await f.seed();
  await completeSessionMemory(f.configuration, 'project', f.complete(first), { kind: 'human' });
  await commitSessionMap(f.configuration, 'project', 's1', { operationId: 'edit', baseVersion: first.version, operations: [{ type: 'update', id: 'T0', fields: { purpose: 'new work' } }] });
  let current = (await readMemoryProject(f.configuration, 'project')).sessions.s1;
  assert.equal(current.completion, undefined);
  await completeSessionMemory(f.configuration, 'project', f.complete(current), { kind: 'human' });
  const restored = await f.send('restore', { operationId: 'restore', scope: 'session:s1', baseVersion: current.version, targetVersion: first.version });
  assert.equal(restored.status, 200);
  assert.equal(restored.snapshot.completion, undefined);
  await completeSessionMemory(f.configuration, 'project', f.complete(restored.snapshot), { kind: 'human' });
  const uploaded = await f.send('sessions/s1', { operationId: 'changed-upload', baseVersion: restored.snapshot.version, baseMainVersion: null, sourceCommit: f.sha, memory: restored.snapshot.memory, completion: restored.snapshot.completion });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.snapshot.completion, undefined);
  await assert.rejects(publishSessionMemory(f.configuration, 'project', f.publish(uploaded.snapshot)), { code: 'SESSION_COMPLETION_REQUIRED' });
  const allowed = await f.send('sessions/s1/complete', f.complete(uploaded.snapshot), 'admin-fixture');
  assert.equal(allowed.status, 200);
  assert.equal(sessionCompletionMatches((await readMemoryProject(f.configuration, 'project')).sessions.s1), true);
});

test('workflow revocation and the final publication commit share one lock', async t => {
  const f = await fixture(t), session = await f.seed();
  await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  const reviewFile = path.join(f.root, 'review.json'), reviewLock = `${reviewFile}.lock`;
  await atomicWrite(reviewFile, encode({ approved: true }));
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  f.configuration.commitPublication = async (projectId, observed, write) => {
    assert.equal(projectId, 'project');
    assert.equal(observed.version, session.version);
    assert.equal(sessionCompletionMatches(observed), true);
    entered();
    await withFileLock(reviewLock, async () => {
      if (!(await readJSON(reviewFile)).approved) throw Object.assign(new Error('Review revoked'), { code: 'TASK_SOURCE_PENDING' });
      await write();
    });
  };
  let publication;
  await withFileLock(reviewLock, async () => {
    publication = publishSessionMemory(f.configuration, 'project', f.publish(session));
    publication.catch(() => {});
    await entry;
    assert.equal((await readMemoryProject(f.configuration, 'project')).sessions.s1.version, session.version,
      'a workflow transaction can read memory while publication waits for its lock');
    await atomicWrite(reviewFile, encode({ approved: false }));
  });
  await assert.rejects(publication, { code: 'TASK_SOURCE_PENDING' });
  let state = await readMemoryProject(f.configuration, 'project');
  assert.equal(state.main, null);
  assert.equal(state.sessions.s1.version, session.version);
  assert.equal(Object.values(state.receipts).some(receipt => receipt.result?.closedSession), false);

  await atomicWrite(reviewFile, encode({ approved: true }));
  let revoke;
  f.configuration.commitPublication = async (_id, _session, write) => withFileLock(reviewLock, async () => {
    assert.equal((await readJSON(reviewFile)).approved, true);
    revoke = withFileLock(reviewLock, async () => {
      assert.ok((await readMemoryProject(f.configuration, 'project')).main, 'concurrent revocation only acquires the lock after publication is durable');
      await atomicWrite(reviewFile, encode({ approved: false }));
    });
    await write();
  });
  const published = await publishSessionMemory(f.configuration, 'project', f.publish(session));
  await revoke;
  state = await readMemoryProject(f.configuration, 'project');
  assert.equal(state.main.version, published.snapshot.version);
  assert.equal(state.sessions.s1, undefined);
});

test('a publication wrapper cannot report success without committing, and retries retain the Session', async t => {
  const f = await fixture(t), session = await f.seed();
  await completeSessionMemory(f.configuration, 'project', f.complete(session), { kind: 'human' });
  f.configuration.commitPublication = async () => {};
  await assert.rejects(publishSessionMemory(f.configuration, 'project', f.publish(session)), { code: 'MEMORY_UNAVAILABLE' });
  assert.equal((await readMemoryProject(f.configuration, 'project')).main, null);
  f.configuration.commitPublication = async (_projectId, _session, write) => { await write(); await write(); };
  const published = await publishSessionMemory(f.configuration, 'project', f.publish(session));
  assert.equal(published.committed, true);
  assert.equal((await readMemoryProject(f.configuration, 'project')).closedSessions.s1.publications.length, 1);
});
