import { skillImport } from './helpers/skill.mjs';
import '../.github/scripts/test-environment.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { execFileSync } from 'node:child_process';
import http from 'node:http';

const { MapStore } = await skillImport('scripts/workbench/store.mjs');
const { MemorySyncCoordinator } = await skillImport('scripts/workbench/sync-coordinator.mjs');
const { memoryRequest } = await skillImport('scripts/workbench/memory.mjs');
import { completeSessionMemory, memoryPublicationStatus, readMemoryProject, startMemoryServer } from '../scripts/cloud/memory.mjs';

import { atomicWrite, encode, pause, readJSON } from '../scripts/shared/io.mjs';

const human = { kind: 'human', sessionId: 'workbench' }, agent = { kind: 'agent', sessionId: 'test-session' };
const fixtureRoots = [];

after(async () => {
  const temporary = await fs.realpath(os.tmpdir());
  for (const root of fixtureRoots) {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temporary);
    assert.ok(path.basename(resolved).startsWith('cg-sync-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-sync-'));
  fixtureRoots.push(root);
  const ctx = path.join(root, '.codex/context'); await fs.mkdir(path.join(ctx, 'sessions'), { recursive: true });
  const doc = { v: 1, project: 'test-project', unknownTop: { preserve: true }, root: { id: 'T0', title: '项目', kind: 'module', unknownNode: 42, children: [{ id: 'N1', title: '原始标题', kind: 'work', proposal: 'accepted', memories: [], bugs: [], children: [] }] } };
  await fs.writeFile(path.join(ctx, 'map.json'), encode(doc));
  await fs.writeFile(path.join(ctx, 'sessions.jsonl'), JSON.stringify({ at: '2026-01-01T00:00:00Z', platform: 'codex', session_id: agent.sessionId, thread_name: '真实会话名称', event: 'session-start' }) + '\n');
  return { root, ctx, doc };
}
async function until(fn, timeout = 4000) { const end = Date.now() + timeout; while (!await fn()) { assert.ok(Date.now() < end, 'condition timed out'); await pause(25); } }

for (const stalledHeaders of [false, true]) test(`Legacy sync recovers silent ${stalledHeaders ? 'headers' : 'body'} and polls Cloud-only changes`, { timeout: 25000 }, async t => {
  const f = await fixture(), sharedDir = path.join(f.root, 'shared');
  await fs.mkdir(sharedDir, { recursive: true });
  const service = await startMemoryServer({ dataDir: path.join(f.root, 'cloud'), adminToken: 'admin', projects: { project: { token: 'token' } }, host: '127.0.0.1', port: 0 });
  let connections = 0;
  const stalled = http.createServer((_req, res) => {
    connections++;
    if (!stalledHeaders) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); }
  });
  const sockets = new Set();
  stalled.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  const config = { url: service.url, projectId: 'project', token: 'token' }, project = { sharedDir, head: 'a'.repeat(40) };
  const request = (project, scope, input) => memoryRequest(project, scope, input, config);
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ ...config, url: `http://127.0.0.1:${stalled.address().port}` }));
  await request(project, 'sessions/silent', { operationId: 'seed', baseVersion: null, baseMainVersion: null, sourceCommit: project.head, memory: { map: f.doc, records: {} } });
  const store = await new MapStore(f.root, { file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'runtime'), eventsFile: path.join(f.root, 'events.jsonl') }).init();
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'silent', store, directory: path.join(f.root, 'sync'), request, heartbeatMs: 30, streamIdleMs: 5000, retryMin: 25, retryMax: 100 });
  let initializations = 0;
  const initialize = coordinator.initialize.bind(coordinator);
  coordinator.initialize = async () => { initializations++; return initialize(); };
  t.after(async () => {
    await coordinator.close(); await store.close();
    const stopped = new Promise(resolve => stalled.close(resolve));
    // Aborted fetches may open replacement TCP sockets without sending HTTP.
    // closeAllConnections alone does not cover these pre-request sockets.
    for (const socket of sockets) socket.destroy();
    await stopped; await service.close();
  });
  await coordinator.start();
  await until(() => connections === 1);
  const remote = (await request(project, 'sessions/silent')).snapshot;
  await request(project, 'sessions/silent/map', { operationId: 'cloud-only', baseVersion: remote.version, operations: [{ type: 'update', id: 'N1', fields: { title: 'Cloud-only update' } }] });
  await until(() => store.doc.root.children[0].title === 'Cloud-only update', 3000);
  assert.equal(connections, 1, 'heartbeat repairs a missed notification without waiting for reconnect');
  const highWater = (await request(project, 'sessions/silent/changes?after=0')).highWater;
  await until(() => coordinator.snapshot().cursor === highWater);
  await coordinator.serial;
  const stateStamp = (await fs.stat(coordinator.stateFile)).mtimeMs;
  const reported = [];
  coordinator.on('change', state => reported.push(state.status));
  await until(() => connections >= 2, 10000);
  assert.ok(initializations >= 2, 'reconnect still initializes missing sessions and unqueued local edits');
  assert.equal(reported.includes('offline'), false, 'healthy polling must not flash offline when only SSE stalls');
  assert.equal((await fs.stat(coordinator.stateFile)).mtimeMs, stateStamp, 'healthy fallback reconnect must not rewrite idle state');
  assert.equal(coordinator.managed, false, 'legacy repair must not enable unsupported v2 mode');
});

test('Workbench coordinator automatically syncs one Session in both directions and survives an outage', async t => {
  const f = await fixture();
  const sharedDir = path.join(f.root, 'shared');
  const dataDir = path.join(f.root, 'memory-data');
  await fs.mkdir(sharedDir, { recursive: true });
  const configuration = { dataDir, adminToken: 'memory-admin', projects: { project: { token: 'project-token' } } };
  let service = await startMemoryServer({ ...configuration, host: '127.0.0.1', port: 0 });
  let store, coordinator;
  t.after(async () => {
    await coordinator?.close().catch(() => {});
    await store?.close().catch(() => {});
    await service.close().catch(() => {});
  });
  const port = Number(new URL(service.url).port);
  const project = { sharedDir, head: 'a'.repeat(40) };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  await memoryRequest(project, 'sessions/session-sync', {
    operationId: 'coordinator-seed', baseVersion: null, baseMainVersion: null, sourceCommit: project.head,
    memory: { map: f.doc, records: {} },
  });
  store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'store-runtime'), eventsFile: path.join(f.root, 'store-events.jsonl'),
  }).init();
  const syncDir = path.join(f.root, 'session-sync');
  let holdAcknowledgement = false, releaseAcknowledgement = null;
  const request = async (...args) => {
    const result = await memoryRequest(...args);
    if (holdAcknowledgement && String(args[1]).endsWith('/map')) await new Promise(resolve => { releaseAcknowledgement = resolve; });
    return result;
  };
  coordinator = new MemorySyncCoordinator({ project, sessionId: 'session-sync', store, directory: syncDir, request, retryMin: 25, retryMax: 100 });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'synced');

  holdAcknowledgement = true;
  await store.commit({ baseVersion: store.version, operationId: 'local-session-edit', operations: [{ type: 'update', id: 'N1', fields: { title: '本地自动上传' } }] }, human);
  await until(async () => (await memoryRequest(project, 'sessions/session-sync')).snapshot.memory.map.root.children[0].title === '本地自动上传');
  await until(() => !!releaseAcknowledgement);
  assert.equal(coordinator.snapshot().status, 'syncing', 'server persistence without an acknowledged response is not synced');
  assert.equal(coordinator.snapshot().pending, 1);
  holdAcknowledgement = false; releaseAcknowledgement();
  await until(() => coordinator.snapshot().status === 'synced');

  const remote = (await memoryRequest(project, 'sessions/session-sync')).snapshot;
  await memoryRequest(project, 'sessions/session-sync/map', {
    operationId: 'remote-session-edit', baseVersion: remote.version,
    operations: [{ type: 'update', id: 'N1', fields: { purpose: '云端自动下发' } }],
  });
  await until(() => store.doc.root.children[0].purpose === '云端自动下发');

  await service.close();
  await store.commit({ baseVersion: store.version, operationId: 'offline-session-edit', operations: [{ type: 'update', id: 'N1', fields: { title: '断网期间保留' } }] }, human);
  await until(async () => !!await readJSON(path.join(syncDir, 'remote-sync/outbox.json'), null));
  await until(() => coordinator.snapshot().pending === 1);
  service = await startMemoryServer({ ...configuration, host: '127.0.0.1', port });
  await until(async () => (await memoryRequest(project, 'sessions/session-sync')).snapshot.memory.map.root.children[0].title === '断网期间保留', 6000);
  await until(() => coordinator.snapshot().status === 'synced');

  // A process that starts while Cloud is unavailable must retry initialization,
  // not wait forever for an SSE event that may never be emitted.
  await coordinator.close(); await service.close();
  await store.commit({ baseVersion: store.version, operationId: 'cold-offline-edit', operations: [{ type: 'update', id: 'N1', fields: { title: '冷启动断网保留' } }] }, human);
  coordinator = new MemorySyncCoordinator({ project, sessionId: 'session-sync', store, directory: syncDir, request, retryMin: 25, retryMax: 100 });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'offline');
  service = await startMemoryServer({ ...configuration, host: '127.0.0.1', port });
  await until(async () => (await memoryRequest(project, 'sessions/session-sync')).snapshot.memory.map.root.children[0].title === '冷启动断网保留', 6000);
  await until(() => coordinator.snapshot().status === 'synced');
  await coordinator.close(); await store.close();
});

test('Workbench coordinator automatically reopens the same Session after its prior generation is published', async t => {
  const f = await fixture();
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.codex/context/map.json');
  git('commit', '-m', 'baseline');
  const head = git('rev-parse', 'HEAD');
  const sharedDir = path.join(f.root, 'generation-shared');
  const configuration = {
    dataDir: path.join(f.root, 'generation-memory'),
    adminToken: 'memory-admin',
    projects: { project: { token: 'project-token', root: f.root, ref: 'refs/heads/main' } },
  };
  await fs.mkdir(sharedDir, { recursive: true });
  const service = await startMemoryServer(configuration);
  const project = { sharedDir, head };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  const seeded = await memoryRequest(project, 'sessions/reusable-session', {
    operationId: 'reusable-seed', baseVersion: null, baseMainVersion: null, sourceCommit: head,
    memory: { map: f.doc, records: {} },
  });
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'generation-store-runtime'), eventsFile: path.join(f.root, 'generation-store-events.jsonl'),
  }).init();
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'reusable-session', store, directory: path.join(f.root, 'generation-sync'), retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); await service.close().catch(() => {}); });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'synced');
  await completeSessionMemory(configuration, 'project', { operationId: 'review-reusable', sessionId: 'reusable-session', generation: 1, sessionVersion: seeded.snapshot.version, sourceCommit: head }, human);
  const published = await memoryRequest(project, 'publish', {
    operationId: 'reusable-publish', baseVersion: null, sessionId: 'reusable-session', sessionVersion: seeded.snapshot.version, expectedMainSha: head,
  });
  assert.equal((await memoryPublicationStatus(configuration, 'project', 'reusable-session')).status, 'published');
  await store.commit({ baseVersion: store.version, operationId: 'second-round-local-edit', operations: [{ type: 'update', id: 'N1', fields: { title: '第二轮开发' } }] }, human);
  await until(async () => (await memoryRequest(project, 'sessions/reusable-session')).snapshot?.memory.map.root.children[0].title === '第二轮开发', 6000);
  await until(() => coordinator.snapshot().status === 'synced');
  const reopened = (await memoryRequest(project, 'sessions/reusable-session')).snapshot;
  assert.equal(reopened.generation, 2);
  assert.equal(reopened.reopenedFrom, published.snapshot.version);
  assert.equal((await memoryPublicationStatus(configuration, 'project', 'reusable-session')).reason, 'SESSION_COMPLETION_REQUIRED');
  assert.equal((await readMemoryProject(configuration, 'project')).closedSessions['reusable-session'].publications.length, 1);
});

test('Workbench coordinator rebases append-only Session and Main changes and clears the preserved reopen conflict', async t => {
  const f = await fixture();
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.codex/context/map.json');
  git('commit', '-m', 'baseline');
  const firstHead = git('rev-parse', 'HEAD');
  const sharedDir = path.join(f.root, 'advanced-generation-shared');
  const syncDir = path.join(f.root, 'advanced-generation-sync');
  const configuration = {
    dataDir: path.join(f.root, 'advanced-generation-memory'),
    adminToken: 'memory-admin',
    projects: { project: { token: 'project-token', root: f.root, ref: 'refs/heads/main' } },
  };
  await fs.mkdir(path.join(syncDir, 'remote-sync'), { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  const service = await startMemoryServer(configuration);
  const project = { sharedDir, head: firstHead };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));

  const first = await memoryRequest(project, 'sessions/reopen-session', {
    operationId: 'reopen-first', baseVersion: null, baseMainVersion: null, sourceCommit: firstHead,
    memory: { map: f.doc, records: {} },
  });
  await completeSessionMemory(configuration, 'project', { operationId: 'review-reopen', sessionId: 'reopen-session', generation: 1, sessionVersion: first.snapshot.version, sourceCommit: firstHead }, human);
  const firstMain = await memoryRequest(project, 'publish', {
    operationId: 'reopen-first-publish', baseVersion: null, sessionId: 'reopen-session',
    sessionVersion: first.snapshot.version, expectedMainSha: firstHead,
  });

  const mainDoc = structuredClone(f.doc);
  mainDoc.root.children[0].memories.push({ archiveKey: 'main-memory', text: 'Main append' });
  await fs.writeFile(path.join(f.ctx, 'map.json'), encode(mainDoc));
  git('add', '.codex/context/map.json');
  git('commit', '-m', 'advance main');
  project.head = git('rev-parse', 'HEAD');
  const advancing = await memoryRequest(project, 'sessions/main-advance-session', {
    operationId: 'main-advance', baseVersion: null, baseMainVersion: firstMain.snapshot.version, sourceCommit: project.head,
    memory: { map: mainDoc, records: {} },
  });
  await completeSessionMemory(configuration, 'project', { operationId: 'review-advance', sessionId: 'main-advance-session', generation: 1, sessionVersion: advancing.snapshot.version, sourceCommit: project.head }, human);
  const advancedMain = await memoryRequest(project, 'publish', {
    operationId: 'main-advance-publish', baseVersion: firstMain.snapshot.version, sessionId: 'main-advance-session',
    sessionVersion: advancing.snapshot.version, expectedMainSha: project.head,
  });

  const localDoc = structuredClone(f.doc);
  localDoc.root.children[0].memories.push({ archiveKey: 'local-memory', text: 'Local append' });
  await fs.writeFile(path.join(f.ctx, 'map.json'), encode(localDoc));
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'advanced-generation-store-runtime'), eventsFile: path.join(f.root, 'advanced-generation-events.jsonl'),
  }).init();
  await atomicWrite(path.join(syncDir, 'remote-sync/server-base.json'), encode(f.doc));
  await atomicWrite(path.join(syncDir, 'remote-sync/conflict.json'), encode({
    code: 'MAIN_ADVANCED_BEFORE_SESSION_REOPEN', base: f.doc, local: localDoc, remote: mainDoc, at: new Date().toISOString(),
  }));
  await atomicWrite(path.join(syncDir, 'remote-sync/state.json'), encode({
    configured: true, status: 'conflict', pending: 0, cursor: 0, serverVersion: null,
    error: null, conflict: { code: 'MAIN_ADVANCED_BEFORE_SESSION_REOPEN', at: new Date().toISOString() },
  }));
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'reopen-session', store, directory: syncDir, managed: true, retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); await service.close().catch(() => {}); });
  await coordinator.start();
  await until(async () => (await memoryRequest(project, 'sessions/reopen-session')).snapshot?.generation === 2
    && coordinator.snapshot().status === 'synced', 6000);
  const reopened = (await memoryRequest(project, 'sessions/reopen-session')).snapshot;
  assert.equal(reopened.baseMainVersion, advancedMain.snapshot.version);
  assert.deepEqual(reopened.memory.map.root.children[0].memories.map(item => item.archiveKey), ['local-memory', 'main-memory']);
  assert.equal(await readJSON(path.join(syncDir, 'remote-sync/conflict.json'), null), null);
  assert.equal(coordinator.snapshot().conflict, null);
});

test('Managed coordinator bootstraps a closed Session and accepts changes already present on Main', async t => {
  const f = await fixture();
  const oldDoc = structuredClone(f.doc);
  const publishedDoc = structuredClone(f.doc);
  publishedDoc.root.children[0].title = '已经进入 Main';
  await fs.writeFile(path.join(f.ctx, 'map.json'), encode(publishedDoc));
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.codex/context/map.json');
  git('commit', '-m', 'published baseline');
  const head = git('rev-parse', 'HEAD');
  const sharedDir = path.join(f.root, 'managed-shared');
  const syncDir = path.join(f.root, 'managed-session-sync');
  const configuration = {
    dataDir: path.join(f.root, 'managed-memory'),
    adminToken: 'memory-admin',
    projects: { project: { token: 'project-token', root: f.root, ref: 'refs/heads/main' } },
  };
  await fs.mkdir(path.join(syncDir, 'remote-sync'), { recursive: true });
  const service = await startMemoryServer(configuration);
  const project = { sharedDir, head };
  await fs.mkdir(sharedDir, { recursive: true });
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  const seeded = await memoryRequest(project, 'sessions/managed-session', {
    operationId: 'managed-seed', baseVersion: null, baseMainVersion: null, sourceCommit: head,
    memory: { map: publishedDoc, records: {} },
  });
  await completeSessionMemory(configuration, 'project', { operationId: 'review-managed', sessionId: 'managed-session', generation: 1, sessionVersion: seeded.snapshot.version, sourceCommit: head }, human);
  await memoryRequest(project, 'publish', {
    operationId: 'managed-publish', baseVersion: null, sessionId: 'managed-session',
    sessionVersion: seeded.snapshot.version, expectedMainSha: head,
  });
  await atomicWrite(path.join(syncDir, 'remote-sync/server-base.json'), encode(oldDoc));
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'managed-store-runtime'), eventsFile: path.join(f.root, 'managed-store-events.jsonl'),
  }).init();
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'managed-session', store, directory: syncDir, managed: true,
    display: async () => ({ name: '真实 Codex 任务', platform: 'codex' }), retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); await service.close().catch(() => {}); });
  await coordinator.start();
  await until(async () => (await memoryRequest(project, 'sessions/managed-session')).snapshot?.generation === 2
    && coordinator.snapshot().status === 'synced' && !coordinator.snapshot().conflict, 6000);
  const reopened = (await memoryRequest(project, 'sessions/managed-session')).snapshot;
  assert.equal(reopened.memory.map.root.children[0].title, '已经进入 Main');
  assert.deepEqual(reopened.memory.display, { name: '真实 Codex 任务', platform: 'codex' });
  // Bootstrap can start another upload/reconcile after the first synced snapshot.
  await until(() => coordinator.snapshot().status === 'synced' && coordinator.snapshot().conflict === null, 2000);
  assert.equal(coordinator.abort, null, 'managed mode must not open a per-Session event stream');
});

test('Managed coordinator adds display metadata to an existing Session without changing its source commit', async t => {
  const f = await fixture();
  const sharedDir = path.join(f.root, 'display-shared');
  await fs.mkdir(sharedDir, { recursive: true });
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({
    url: 'http://127.0.0.1:1', projectId: 'project', token: 'test-token',
  }));
  const originalSource = 'a'.repeat(40);
  let remote = { version: 'session-v1', baseMainVersion: 'main-v1', sourceCommit: originalSource, memory: { map: f.doc, records: { 'sessions/s.md': 'preserve' } } };
  const request = async (_project, scope, input) => {
    if (scope === 'sessions/existing-session' && !input) return { snapshot: structuredClone(remote) };
    if (scope === 'sessions/existing-session' && input) {
      assert.equal(input.operationId.startsWith('session-display:existing-session:'), true);
      assert.equal(input.baseVersion, remote.version);
      remote = { ...input, version: 'session-v2' };
      return { snapshot: structuredClone(remote) };
    }
    throw new Error(`Unexpected scope ${scope}`);
  };
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'display-store-runtime'), eventsFile: path.join(f.root, 'display-store-events.jsonl'),
  }).init();
  const coordinator = new MemorySyncCoordinator({ project: { sharedDir, head: 'b'.repeat(40) }, sessionId: 'existing-session', store,
    directory: path.join(f.root, 'display-session-sync'), request, managed: true,
    display: async () => ({ name: 'CI', platform: 'codex' }), retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'synced');
  assert.deepEqual(remote.memory.display, { name: 'CI', platform: 'codex' });
  assert.deepEqual(remote.memory.records, { 'sessions/s.md': 'preserve' });
  assert.equal(remote.sourceCommit, originalSource);
});

test('Workbench coordinator migrates a confirmed legacy main baseline before reopening a Session', async t => {
  const f = await fixture();
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.codex/context/map.json');
  git('commit', '-m', 'baseline');
  const head = git('rev-parse', 'HEAD');
  const sharedDir = path.join(f.root, 'legacy-shared');
  const syncDir = path.join(f.root, 'legacy-session-sync');
  const configuration = {
    dataDir: path.join(f.root, 'legacy-memory'),
    adminToken: 'memory-admin',
    projects: { project: { token: 'project-token', root: f.root, ref: 'refs/heads/main' } },
  };
  await fs.mkdir(sharedDir, { recursive: true });
  const service = await startMemoryServer(configuration);
  const project = { sharedDir, head };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  const seeded = await memoryRequest(project, 'sessions/legacy-session', {
    operationId: 'legacy-seed', baseVersion: null, baseMainVersion: null, sourceCommit: head,
    memory: { map: f.doc, records: {} },
  });
  await completeSessionMemory(configuration, 'project', { operationId: 'review-legacy', sessionId: 'legacy-session', generation: 1, sessionVersion: seeded.snapshot.version, sourceCommit: head }, human);
  const published = await memoryRequest(project, 'publish', {
    operationId: 'legacy-publish', baseVersion: null, sessionId: 'legacy-session',
    sessionVersion: seeded.snapshot.version, expectedMainSha: head,
  });
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'legacy-store-runtime'), eventsFile: path.join(f.root, 'legacy-store-events.jsonl'),
  }).init();
  await store.commit({
    baseVersion: store.version, operationId: 'legacy-local-edit',
    operations: [{ type: 'update', id: 'N1', fields: { title: '保留的本地开发' } }],
  }, human);
  await fs.mkdir(path.join(syncDir, 'remote-sync'), { recursive: true });
  await atomicWrite(path.join(syncDir, 'base-main.json'), encode({ version: published.snapshot.version, map: f.doc }));
  await atomicWrite(path.join(syncDir, 'remote-sync/conflict.json'), encode({
    code: 'SESSION_MAIN_BASELINE_REQUIRED', base: null, local: store.doc, remote: f.doc,
    at: new Date().toISOString(),
  }));
  await atomicWrite(path.join(syncDir, 'remote-sync/state.json'), encode({
    configured: true, status: 'conflict', pending: 0, cursor: 0, serverVersion: null,
    error: null, conflict: { code: 'SESSION_MAIN_BASELINE_REQUIRED', at: new Date().toISOString() },
  }));
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'legacy-session', store, directory: syncDir, retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); await service.close().catch(() => {}); });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'synced');
  const reopened = (await memoryRequest(project, 'sessions/legacy-session')).snapshot;
  assert.equal(reopened.generation, 2);
  assert.equal(reopened.memory.map.root.children[0].title, '保留的本地开发');
  assert.equal(coordinator.snapshot().conflict, null);
  assert.equal(await readJSON(path.join(syncDir, 'remote-sync/conflict.json'), null), null);
  assert.deepEqual(await readJSON(path.join(syncDir, 'remote-sync/server-base.json')), reopened.memory.map);
});

test('Workbench coordinator clears a stale baseline conflict when the Session generation already exists', async t => {
  const f = await fixture();
  const sharedDir = path.join(f.root, 'legacy-active-shared');
  const syncDir = path.join(f.root, 'legacy-active-session-sync');
  const configuration = {
    dataDir: path.join(f.root, 'legacy-active-memory'),
    adminToken: 'memory-admin',
    projects: { project: { token: 'project-token' } },
  };
  await fs.mkdir(sharedDir, { recursive: true });
  const service = await startMemoryServer(configuration);
  const project = { sharedDir, head: 'a'.repeat(40) };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  const remote = await memoryRequest(project, 'sessions/legacy-active-session', {
    operationId: 'legacy-active-seed', baseVersion: null, baseMainVersion: null, sourceCommit: project.head,
    memory: { map: f.doc, records: {} },
  });
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'legacy-active-store-runtime'), eventsFile: path.join(f.root, 'legacy-active-store-events.jsonl'),
  }).init();
  await fs.mkdir(path.join(syncDir, 'remote-sync'), { recursive: true });
  await atomicWrite(path.join(syncDir, 'base-main.json'), encode({ version: remote.snapshot.version, map: f.doc }));
  await atomicWrite(path.join(syncDir, 'remote-sync/conflict.json'), encode({
    code: 'SESSION_MAIN_BASELINE_REQUIRED', base: null, local: store.doc, remote: f.doc,
    at: new Date().toISOString(),
  }));
  await atomicWrite(path.join(syncDir, 'remote-sync/state.json'), encode({
    configured: true, status: 'conflict', pending: 0, cursor: 0, serverVersion: null,
    error: null, conflict: { code: 'SESSION_MAIN_BASELINE_REQUIRED', at: new Date().toISOString() },
  }));
  const coordinator = new MemorySyncCoordinator({ project, sessionId: 'legacy-active-session', store, directory: syncDir, retryMin: 25, retryMax: 100 });
  t.after(async () => { await coordinator.close().catch(() => {}); await store.close().catch(() => {}); await service.close().catch(() => {}); });
  await coordinator.start();
  await until(() => coordinator.snapshot().status === 'synced');
  assert.equal(coordinator.snapshot().serverVersion, remote.snapshot.version);
  assert.equal(coordinator.snapshot().conflict, null);
  assert.equal(await readJSON(path.join(syncDir, 'remote-sync/conflict.json'), null), null);
  assert.deepEqual(await readJSON(path.join(syncDir, 'remote-sync/server-base.json')), f.doc);
});

test('Workbench coordinator preserves local, remote, and base documents on a same-field conflict', async t => {
  const f = await fixture();
  const sharedDir = path.join(f.root, 'conflict-shared'), dataDir = path.join(f.root, 'conflict-memory');
  await fs.mkdir(sharedDir, { recursive: true });
  const configuration = { dataDir, adminToken: 'memory-admin', projects: { project: { token: 'project-token' } } };
  const service = await startMemoryServer({ ...configuration, host: '127.0.0.1', port: 0 });
  t.after(async () => { await service.close().catch(() => {}); });
  const project = { sharedDir, head: 'b'.repeat(40) };
  await atomicWrite(path.join(sharedDir, 'memory-client.json'), encode({ url: service.url, projectId: 'project', token: 'project-token' }));
  await memoryRequest(project, 'sessions/conflict-session', {
    operationId: 'conflict-seed', baseVersion: null, baseMainVersion: null, sourceCommit: project.head,
    memory: { map: f.doc, records: {} },
  });
  const store = await new MapStore(f.root, {
    file: path.join(f.ctx, 'map.json'), runtime: path.join(f.root, 'conflict-store-runtime'), eventsFile: path.join(f.root, 'conflict-store-events.jsonl'),
  }).init();
  const syncDir = path.join(f.root, 'conflict-session-sync');
  let coordinator = new MemorySyncCoordinator({ project, sessionId: 'conflict-session', store, directory: syncDir, retryMin: 25, retryMax: 100 });
  await coordinator.start(); await until(() => coordinator.snapshot().status === 'synced'); await coordinator.close();

  await store.commit({ baseVersion: store.version, operationId: 'conflict-local', operations: [{ type: 'update', id: 'N1', fields: { title: '本地标题' } }] }, human);
  const remote = (await memoryRequest(project, 'sessions/conflict-session')).snapshot;
  await memoryRequest(project, 'sessions/conflict-session/map', {
    operationId: 'disjoint-remote', baseVersion: remote.version,
    operations: [{ type: 'update', id: 'N1', fields: { purpose: '云端用途' } }],
  });
  coordinator = new MemorySyncCoordinator({ project, sessionId: 'conflict-session', store, directory: syncDir, retryMin: 25, retryMax: 100 });
  await coordinator.start(); await until(() => coordinator.snapshot().status === 'synced');
  let mergedRemote = (await memoryRequest(project, 'sessions/conflict-session')).snapshot;
  assert.equal(store.doc.root.children[0].title, '本地标题');
  assert.equal(store.doc.root.children[0].purpose, '云端用途');
  assert.equal(mergedRemote.memory.map.root.children[0].title, '本地标题');
  assert.equal(mergedRemote.memory.map.root.children[0].purpose, '云端用途');
  await coordinator.close();

  await store.commit({ baseVersion: store.version, operationId: 'same-field-local', operations: [{ type: 'update', id: 'N1', fields: { title: '本地冲突标题' } }] }, human);
  mergedRemote = (await memoryRequest(project, 'sessions/conflict-session')).snapshot;
  await memoryRequest(project, 'sessions/conflict-session/map', {
    operationId: 'same-field-remote', baseVersion: mergedRemote.version,
    operations: [{ type: 'update', id: 'N1', fields: { title: '云端标题' } }],
  });
  coordinator = new MemorySyncCoordinator({ project, sessionId: 'conflict-session', store, directory: syncDir, retryMin: 25, retryMax: 100 });
  await coordinator.start(); await until(() => coordinator.snapshot().status === 'conflict');
  const conflict = await readJSON(path.join(syncDir, 'remote-sync/conflict.json'));
  assert.equal(conflict.base.root.children[0].title, '本地标题');
  assert.equal(conflict.local.root.children[0].title, '本地冲突标题');
  assert.equal(conflict.remote.root.children[0].title, '云端标题');
  assert.equal(store.doc.root.children[0].title, '本地冲突标题', 'conflict must not overwrite the local draft');
  await coordinator.close(); await store.close();
});
