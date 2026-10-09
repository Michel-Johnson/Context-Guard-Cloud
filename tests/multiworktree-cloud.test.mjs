import { skillRoot, skillImport } from './helpers/skill.mjs';
import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const { resolveProject, saveMainBinding, bindingStatus } = await skillImport('scripts/workbench/project.mjs');
const { startServer } = await skillImport('scripts/workbench/server.mjs');
const { stopServer } = await skillImport('scripts/workbench/cli.mjs');

import { completeSessionMemory, startMemoryServer } from '../scripts/cloud/memory.mjs';
const { memoryConfigPath, sessionMemoryDir } = await skillImport('scripts/workbench/memory.mjs');

import { readJSON, hash } from '../scripts/shared/io.mjs';
const repo = skillRoot;
const fixtureRoot = fileURLToPath(new URL('../temp/', import.meta.url));
import { pythonCommand } from '../.github/scripts/python-command.mjs';
const python = pythonCommand();
import { run as runProcess } from '../.github/scripts/client-protocol.mjs';
function run(command, args, cwd = repo, input) {
  return runProcess(command, args, { cwd, input, timeout: 120_000, allowFailure: true,
    env: { ...process.env, CONTEXT_GUARD_NAMED_WORKBENCH: '0', CONTEXT_GUARD_HEADLESS: '1', CODEX_THREAD_ID: '', CONTEXT_GUARD_DISABLE_WORKBENCH: '1' } });
}
const git = async (root, ...args) => { const r = await run('git', args, root); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); };
const cli = (root, ...args) => run(process.execPath, [path.join(repo, 'scripts/workbench/cli.mjs'), ...args, '--root', root]);
const hookRoots = new Map();
const hook = (root, id, event = 'session-start') => run(python, [path.join(hookRoots.get(root) || repo, 'scripts/context_guard_hook.py'), event, '--platform', 'codex'], root, JSON.stringify({ cwd: root, session_id: id, prompt: '检查绑定', is_background_agent: true }));
async function fixture(t, cleanup = true) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(fixtureRoot, 'binding-'));
  const root = path.join(dir, 'repo'), other = path.join(dir, 'other'); await fs.mkdir(root);
  if (cleanup) t.after(async () => {
    await stopServer(root);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await git(root, 'init', '-b', 'trunk'); await git(root, 'config', 'user.email', 'fixture@example.invalid'); await git(root, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(root, 'README.md'), 'fixture'); await git(root, 'add', 'README.md'); await git(root, 'commit', '-m', 'initial');
  await git(root, 'worktree', 'add', '-b', 'feature', other);
  const installed = path.join(dir, 'installed');
  await fs.cp(path.join(repo, 'scripts'), path.join(installed, 'scripts'), { recursive: true });
  await fs.cp(path.join(repo, 'prototype'), path.join(installed, 'prototype'), { recursive: true });
  hookRoots.set(root, installed); hookRoots.set(other, installed);
  return { dir, root, other };
}
async function initialize(root) {
  const r = await run(python, [path.join(repo, 'scripts/context_guard.py'), 'init', '--root', root]); assert.equal(r.code, 0, r.stderr);
}
async function call(service, route, token, body) {
  const r = await fetch(new URL(route, service.state?.url || service.url), { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
test('a later lifecycle hook recovers Cloud context reads without uploading local Session records', async t => {
  const { dir, root } = await fixture(t, false);
  let memory;
  t.after(async () => {
    await memory?.close().catch(() => {});
    await stopServer(root).catch(() => {});
  });
  await saveMainBinding(root, { mode: 'local', branch: 'trunk' });
  await initialize(root);
  const sessionId = 'hook-cloud-heal';
  const firstSeen = await hook(root, sessionId, 'session-start');
  assert.match(firstSeen.stdout, /no established workbench/i);
  const local = await startServer({ root, port: 0 });
  const registered = await call(local, '/api/session', local.state.adminToken, { sessionId, worktreeRoot: root });
  assert.equal(registered.status, 200, JSON.stringify(registered));
  const recorded = await hook(root, sessionId, 'session-start');
  assert.equal(recorded.code, 0, recorded.stderr);
  const map = { v: 1, project: 'Hook fixture', bootstrap: 'ready', flows: [], root: {
    id: 'REMOTE', title: 'Cloud-only Hook marker', purpose: 'Read established remote context',
    kind: 'module', state: 'dirty', children: [], memoryDocument: 'Remote baseline before outage',
  } };
  await local.close();

  const project = await resolveProject(root);
  const memoryOptions = { dataDir: path.join(dir, 'hook-memory'), adminToken: randomUUID(), projects: { example: { token: randomUUID() } } };
  const memoryFile = path.join(memoryOptions.dataDir, hash('example'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  // The current Hook reads established Main context, never creates a remote
  // Session or uploads notes. Seed synthetic published data before startup.
  const legacyRecords = { 'legacy.md': 'Preserved pre-existing synthetic record' };
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1,
    main: { version: 'main-v1', mainSha: project.head, memory: { map, records: {} } },
    sessions: { [sessionId]: { sessionId, version: 'session-v1', baseMainVersion: 'main-v1',
      memory: { map, records: legacyRecords } } }, receipts: {}, history: [], events: [], eventCursors: {} }));
  memory = await startMemoryServer(memoryOptions);
  const memoryPort = new URL(memory.url).port;
  await fs.mkdir(project.sharedDir, { recursive: true });
  await fs.writeFile(memoryConfigPath(project), JSON.stringify({ url: memory.url, projectId: 'example', token: memoryOptions.projects.example.token }));
  await memory.close(); memory = null;

  const bindingBefore = (await bindingStatus(project, sessionId)).session;
  const notes = path.join(root, '.codex/context/sessions', sessionId + '.md');
  const notesBefore = await fs.readFile(notes, 'utf8');
  const unavailable = await hook(root, sessionId, 'session-start');
  assert.match(unavailable.stdout, /Server memory unavailable or conflicting/i);
  assert.doesNotMatch(unavailable.stdout, /已获取轻量导航|Server memory confirmed/i);
  const offlineNotes = await fs.readFile(notes, 'utf8');
  assert.ok(offlineNotes.startsWith(notesBefore)); assert.ok(offlineNotes.length > notesBefore.length);
  // Change only the stopped synthetic server's published baseline. Restoring
  // this unique marker/version proves a real read, not an old local cache.
  const restoredState = await readJSON(memoryFile);
  restoredState.revision++; restoredState.main.version = 'restored-main-v2';
  restoredState.main.memory.map.root.memoryDocument = 'Remote context after outage';
  await fs.writeFile(memoryFile, JSON.stringify(restoredState));
  memory = await startMemoryServer({ ...memoryOptions, port: Number(memoryPort) });
  const requests = [];
  memory.server.on('request', req => requests.push({ method: req.method, path: req.url }));
  const before = await fs.readFile(memoryFile, 'utf8');
  const healed = await hook(root, sessionId, 'user-prompt-submit');
  assert.equal(healed.code, 0, healed.stderr);
  assert.match(healed.stdout, /已获取轻量导航与项目说明/);
  assert.doesNotMatch(healed.stdout, /Server memory unavailable|Cloud Session sync pending/i);
  const remote = await call(memory, '/v1/projects/example/sessions/' + sessionId, memoryOptions.projects.example.token);
  assert.equal(remote.status, 200, JSON.stringify(remote));
  assert.equal(remote.data.snapshot.sessionId, sessionId);
  assert.deepEqual(remote.data.snapshot.memory.records, legacyRecords);
  assert.equal(remote.data.snapshot.lastSync, undefined);
  assert.equal(await fs.readFile(memoryFile, 'utf8'), before, 'context recovery must not alter Cloud memory or receipts');
  assert.ok(requests.some(request => request.path.startsWith('/v1/projects/example/context?')));
  assert.ok(requests.filter(request => request.path.startsWith('/v1/projects/example/sessions/'))
    .every(request => request.method === 'GET'), 'the Hook cannot upload records or register a remote Session');
  const healedNotes = await fs.readFile(notes, 'utf8');
  assert.ok(healedNotes.startsWith(offlineNotes)); assert.match(healedNotes, /user-prompt-submit/);
  const cache = await readJSON(path.join(sessionMemoryDir(project, sessionId), 'context-cache.json'));
  assert.equal(cache.origin, `${memory.url}\0example`);
  assert.equal(cache.index.version, 'restored-main-v2');
  assert.equal(cache.fragments.REMOTE.node.memoryDocument, 'Remote context after outage');
  assert.deepEqual((await bindingStatus(await resolveProject(root), sessionId)).session, bindingBefore);
});
test('a legacy worktree seed is replaced by the confirmed main baseline without overwriting divergent Session edits', async t => {
  const { dir, root, other } = await fixture(t, false);
  let memory, workbench;
  t.after(async () => {
    await workbench?.close();
    await memory?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await saveMainBinding(root, { mode: 'local', branch: 'trunk' });
  await initialize(root); await initialize(other);
  const mainSha = await git(root, 'rev-parse', 'HEAD');
  const mainMap = { v: 1, project: 'example', bootstrap: 'ready', flows: [], root: { id: 'T0', title: 'Full main', kind: 'module', children: [{ id: 'M1', title: 'Inherited module', kind: 'module', children: [] }] } };
  const options = { dataDir: path.join(dir, 'baseline-memory'), adminToken: randomUUID(), projects: { example: { token: randomUUID(), root, ref: 'refs/heads/trunk' } } };
  memory = await startMemoryServer(options);
  const saved = await call(memory, '/v1/projects/example/sessions/publisher', options.projects.example.token, { operationId: 'baseline-session', baseVersion: null, baseMainVersion: null, sourceCommit: mainSha, memory: { map: mainMap, records: {} } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  await completeSessionMemory(options, 'example', { operationId: 'review-baseline', sessionId: 'publisher', generation: 1, sessionVersion: saved.data.snapshot.version, sourceCommit: mainSha }, { kind: 'human' });
  const published = await call(memory, '/v1/projects/example/publish', options.adminToken, { operationId: 'baseline-publish', baseVersion: null, sessionId: 'publisher', sessionVersion: saved.data.snapshot.version, expectedMainSha: mainSha });
  assert.equal(published.status, 200, JSON.stringify(published));
  const project = await resolveProject(other);
  await fs.mkdir(project.sharedDir, { recursive: true });
  await fs.writeFile(memoryConfigPath(project), JSON.stringify({ url: memory.url, projectId: 'example', token: options.projects.example.token }));
  const legacyMap = { v: 1, project: 'example', bootstrap: 'ready', flows: [], root: { id: 'T0', title: 'Partial worktree', kind: 'module', children: [] } };
  await fs.writeFile(path.join(other, '.codex/context/map.json'), JSON.stringify(legacyMap));
  for (const sessionId of ['legacy-seed', 'divergent-seed']) await hook(other, sessionId);
  const legacyDir = sessionMemoryDir(project, 'legacy-seed');
  await fs.mkdir(legacyDir, { recursive: true }); await fs.writeFile(path.join(legacyDir, 'map.json'), JSON.stringify(legacyMap));
  const divergentDir = sessionMemoryDir(project, 'divergent-seed'), divergentMap = structuredClone(legacyMap);
  divergentMap.root.title = 'Unsynced Session edit';
  await fs.mkdir(divergentDir, { recursive: true }); await fs.writeFile(path.join(divergentDir, 'map.json'), JSON.stringify(divergentMap));
  const remoteDivergent = await call(memory, '/v1/projects/example/sessions/divergent-seed', options.projects.example.token, {
    operationId: 'divergent-session', baseVersion: null, baseMainVersion: null, sourceCommit: mainSha,
    memory: { map: divergentMap, records: { 'sessions/divergent-seed.md': 'preserve me' } },
  });
  assert.equal(remoteDivergent.status, 200, JSON.stringify(remoteDivergent));
  workbench = await startServer({ root, port: 0 });
  const migrated = await call(workbench, '/api/session', workbench.state.adminToken, { sessionId: 'legacy-seed', worktreeRoot: other });
  assert.equal(migrated.status, 200, JSON.stringify(migrated));
  assert.equal((await call(workbench, '/api/state', migrated.data.token)).data.doc.root.children[0].id, 'M1');
  assert.equal((await readJSON(path.join(legacyDir, 'base-main.json'))).version, published.data.snapshot.version);
  assert.deepEqual(await readJSON(path.join(legacyDir, 'before-main-baseline.json')), legacyMap);
  const rejected = await call(workbench, '/api/session', workbench.state.adminToken, { sessionId: 'divergent-seed', worktreeRoot: other });
  assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'SESSION_BASELINE_REQUIRED');
  assert.equal((await bindingStatus(project, 'divergent-seed')).session.bound, false);
  assert.deepEqual(await readJSON(path.join(divergentDir, 'map.json')), divergentMap);
  const refusedRebase = await cli(other, 'memory', 'rebase', '--session', 'divergent-seed');
  assert.notEqual(refusedRebase.code, 0); assert.match(refusedRebase.stdout, /SESSION_BASELINE_REQUIRED/);
  const adoptedResult = await cli(other, 'memory', 'rebase', '--session', 'divergent-seed', '--adopt-main');
  assert.equal(adoptedResult.code, 0, adoptedResult.stdout);
  const adopted = JSON.parse(adoptedResult.stdout);
  assert.equal(adopted.strategy, 'adopt-main');
  assert.deepEqual(await readJSON(adopted.backup), divergentMap);
  assert.deepEqual(await readJSON(path.join(divergentDir, 'map.json')), mainMap);
  assert.equal((await readJSON(path.join(divergentDir, 'base-main.json'))).version, published.data.snapshot.version);
  const adoptedRemote = await call(memory, '/v1/projects/example/sessions/divergent-seed', options.projects.example.token);
  assert.deepEqual(adoptedRemote.data.snapshot.memory.map, mainMap);
  assert.equal(adoptedRemote.data.snapshot.memory.records['sessions/divergent-seed.md'], 'preserve me');
  assert.equal((await readJSON(path.join(divergentDir, 'remote-sync/server-base.json'))).root.title, 'Full main');
  const rebound = await call(workbench, '/api/session', workbench.state.adminToken, { sessionId: 'divergent-seed', worktreeRoot: other });
  assert.equal(rebound.status, 200, JSON.stringify(rebound));
  assert.equal((await call(workbench, '/api/state', rebound.data.token)).data.doc.root.children[0].id, 'M1');
});
test('private memory requires authentication, isolates Sessions, verifies merge and persists CAS receipts', async t => {
  const { dir, root, other } = await fixture(t);
  const mainSha = await git(root, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(other, 'feature.txt'), 'feature'); await git(other, 'add', 'feature.txt'); await git(other, 'commit', '-m', 'unmerged');
  const featureSha = await git(other, 'rev-parse', 'HEAD');
  const options = { dataDir: path.join(dir, 'private-memory'), adminToken: randomUUID(), projects: { example: { token: randomUUID(), root, ref: 'refs/heads/trunk' } } };
  let service = await startMemoryServer(options); t.after(() => service.close());
  const base = '/v1/projects/example/', token = options.projects.example.token;
  const memory = { map: { v: 1, project: 'example', bootstrap: 'pending', flows: [], root: null }, records: { 'sessions/one.md': 'private Session one' } };
  assert.equal((await call(service, base + 'main', '')).status, 401);
  const input = { operationId: 'save-one', baseVersion: null, baseMainVersion: null, sourceCommit: featureSha, memory };
  const saved = await call(service, base + 'sessions/one', token, input); assert.equal(saved.status, 200);
  const review = async snapshot => completeSessionMemory(options, 'example', {
    operationId: `review-${snapshot.sessionId}-${snapshot.version}`, sessionId: snapshot.sessionId,
    generation: snapshot.generation, sessionVersion: snapshot.version, sourceCommit: snapshot.sourceCommit,
  }, { kind: 'human' });
  await review(saved.data.snapshot);
  assert.equal((await call(service, base + 'main', token)).data.snapshot, null);
  assert.equal((await call(service, base + 'sessions/two', token)).data.snapshot, null);
  const publish = { operationId: 'publish-one', baseVersion: null, sessionId: 'one', sessionVersion: saved.data.snapshot.version, expectedMainSha: mainSha };
  const unmerged = await call(service, base + 'publish', token, publish);
  assert.equal(unmerged.status, 409); assert.equal(unmerged.data.error.code, 'NOT_MERGED');
  await git(root, 'merge', '--ff-only', 'feature'); publish.expectedMainSha = featureSha;
  const published = await call(service, base + 'publish', token, publish); assert.equal(published.status, 200, JSON.stringify(published));
  assert.equal(published.data.closedSession.sessionId, 'one');
  assert.equal((await call(service, base + 'sessions/one', token)).data.snapshot, null);
  const closedMapWrite = await call(service, base + 'sessions/one/map', token, { operationId: 'map-after-publish', baseVersion: saved.data.snapshot.version, operations: [{ type: 'update', id: 'T0', fields: { title: 'must fail' } }] });
  assert.equal(closedMapWrite.status, 409); assert.equal(closedMapWrite.data.error.code, 'SESSION_REOPEN_REQUIRED');
  const staleReopen = await call(service, base + 'sessions/one', token, { ...input, operationId: 'stale-reopen', baseVersion: null });
  assert.equal(staleReopen.status, 409); assert.equal(staleReopen.data.error.code, 'SESSION_BASELINE_CONFLICT');
  const secondRoundMemory = { map: memory.map, records: { 'sessions/one.md': 'private Session one, second round' } };
  const reopened = await call(service, base + 'sessions/one', token, { operationId: 'reopen-one', baseVersion: null, baseMainVersion: published.data.snapshot.version, sourceCommit: featureSha, memory: secondRoundMemory });
  assert.equal(reopened.status, 200, JSON.stringify(reopened));
  assert.equal(reopened.data.snapshot.generation, 2);
  assert.equal(reopened.data.snapshot.reopenedFrom, published.data.snapshot.version);
  await review(reopened.data.snapshot);
  const republished = await call(service, base + 'publish', token, { operationId: 'republish-one', baseVersion: published.data.snapshot.version, sessionId: 'one', sessionVersion: reopened.data.snapshot.version, expectedMainSha: featureSha });
  assert.equal(republished.status, 200, JSON.stringify(republished));
  assert.equal(republished.data.closedSession.generation, 2);
  assert.equal(republished.data.closedSession.publications.length, 2);
  assert.deepEqual((await call(service, base + 'publish', token, publish)).data, published.data);
  const secondMemory = { map: memory.map, records: { 'sessions/two.md': 'private Session two' } };
  const savedTwo = await call(service, base + 'sessions/two', token, { operationId: 'save-two', baseVersion: null, baseMainVersion: republished.data.snapshot.version, sourceCommit: featureSha, memory: secondMemory });
  await review(savedTwo.data.snapshot);
  const publishedTwo = await call(service, base + 'publish', token, { operationId: 'publish-two', baseVersion: republished.data.snapshot.version, sessionId: 'two', sessionVersion: savedTwo.data.snapshot.version, expectedMainSha: featureSha });
  assert.equal(publishedTwo.status, 200, JSON.stringify(publishedTwo));
  assert.deepEqual(Object.keys(publishedTwo.data.snapshot.memory.records).sort(), ['sessions/one.md', 'sessions/two.md']);
  await service.close(); service = await startMemoryServer(options);
  assert.deepEqual((await call(service, base + 'sessions/one', token, input)).data, saved.data);
  assert.equal((await call(service, base + 'sessions/one', token, { ...input, memory: { ...memory, records: {} } })).data.error.code, 'ID_REUSED');
  const competing = await Promise.all(['a', 'b'].map(operationId => call(service, base + 'sessions/one', token, { ...input, operationId, baseVersion: saved.data.snapshot.version })));
  assert.deepEqual(competing.map(r => r.status), [409, 409]);
  assert.ok(competing.every(result => result.data.error.code === 'VERSION_CONFLICT'));
  assert.equal((await call(service, base + 'main', token)).data.snapshot.mainSha, featureSha);
  assert.equal((await call(service, base + 'sessions/three', token, { ...input, operationId: 'private', memory: { ...memory, records: { 'private/credentials.json': 'not allowed' } } })).data.error.code, 'PRIVATE_PATH');
});
test('memory CLI lists history and restores a Session with version protection', async t => {
  const { dir, root } = await fixture(t);
  const options = { dataDir: path.join(dir, 'history-memory'), adminToken: randomUUID(), projects: { example: { token: randomUUID() } } };
  const service = await startMemoryServer(options); t.after(() => service.close());
  const token = options.projects.example.token;
  const map = title => ({ v: 1, project: 'example', bootstrap: 'ready', flows: [], root: { id: 'T0', title, kind: 'module', state: 'dirty', children: [] } });
  const first = await call(service, '/v1/projects/example/sessions/one', token, { operationId: 'cli-first', baseVersion: null, baseMainVersion: null, sourceCommit: 'a'.repeat(40), memory: { map: map('First'), records: {} } });
  const second = await call(service, '/v1/projects/example/sessions/one', token, { operationId: 'cli-second', baseVersion: first.data.snapshot.version, baseMainVersion: null, sourceCommit: 'b'.repeat(40), memory: { map: map('Second'), records: {} } });
  const invoke = (args, input) => run(process.execPath, [path.join(repo, 'scripts/workbench/cli.mjs'), ...args, '--root', root], root, input);
  const configured = await invoke(['memory', 'configure', '--input', '-'], JSON.stringify({ url: service.url, projectId: 'example', token }));
  assert.equal(configured.code, 0, configured.stderr);
  const history = await invoke(['memory', 'history', '--scope', 'session:one']);
  assert.equal(history.code, 0, history.stderr);
  assert.deepEqual(JSON.parse(history.stdout).history.map(entry => entry.version), [first.data.snapshot.version, second.data.snapshot.version]);
  const restored = await invoke(['memory', 'restore', '--input', '-'], JSON.stringify({ operationId: 'cli-restore', scope: 'session:one', baseVersion: second.data.snapshot.version, targetVersion: first.data.snapshot.version }));
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).snapshot.memory.map.root.title, 'First');
  const stale = await invoke(['memory', 'restore', '--input', '-'], JSON.stringify({ operationId: 'cli-stale', scope: 'session:one', baseVersion: second.data.snapshot.version, targetVersion: first.data.snapshot.version }));
  assert.notEqual(stale.code, 0); assert.match(stale.stdout, /VERSION_CONFLICT/);
});
