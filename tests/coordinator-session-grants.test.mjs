import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CoordinatorSessionGrants } from '../scripts/cloud/coordinator-session-grants.mjs';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { readMemoryView, readMemoryProject } from '../scripts/cloud/memory.mjs';

const node = (id, children = []) => ({ id, title: id, kind: 'module', state: 'dirty', purpose: '',
  memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children, proposal: 'accepted' });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-session-grants-'));
  t.diagnostic(`isolated fixture: ${directory}`);
  const checkout = path.join(directory, 'checkout');
  await fs.mkdir(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  const common = await fs.realpath(execFileSync('git', ['-C', checkout, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim() === '.git' ? path.join(checkout, '.git') : checkout);
  assert.equal(common.startsWith(await fs.realpath(os.tmpdir())), true);
  assert.equal(common.includes('context-guard/.git'), false);
  const projectId = 'context-guard', providerFile = path.join(directory, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://provider.invalid', model: 'synthetic', token: 'synthetic' }));
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic-memory', projects: {
    [projectId]: { root: checkout, token: 'synthetic', ref: 'refs/heads/main', coordinator: {
      enabled: true, mapWrite: true, providerFile, bindings: {},
    } },
  } };
  const memoryFile = path.join(memoryConfig.dataDir, createHash('sha256').update(projectId).digest('hex'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'v1', memory: {
    map: { v: 1, bootstrap: 'ready', project: 'Synthetic', flows: [], root: node('ROOT', [node('ALLOWED'), node('DENIED')]) }, records: {},
  } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  let server;
  const start = async () => {
    server = await startCloudServer({ dataDir: directory, port: 0, adminToken: 'synthetic-admin', browserToken: 'synthetic-browser',
      memoryConfig, browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
      protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/synthetic' }] },
      coordinatorModelFactory: () => ({ next: async () => { throw Error('No model may run in grant tests'); } }),
    });
  };
  await start();
  t.after(async () => { await server?.close(); if (t.passed) await fs.rm(directory, { recursive: true, force: true }); });
  const call = async (route, input, credential = 'synthetic-admin', method = 'POST') => {
    const response = await fetch(server.url + route, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json(), credential: response.headers.get('x-context-guard-credential') };
  };
  const login = await call('/api/v2/messages', { v: 2, id: 'login', type: 'auth.open', payload: {
    repository: 'https://github.com/example/synthetic', clientId: 'synthetic-device', password: 'synthetic-password',
  } });
  assert.equal(login.status, 200);
  const credential = login.credential;
  const bind = await call('/api/v2/messages', { v: 2, id: 'bind', type: 'session.bind', payload: {
    sessionId: 'coordinator-session', worktreeId: 'synthetic-tree', agentId: 'synthetic-agent', expectedBindingVersion: '',
  } }, credential);
  assert.equal(bind.status, 200, JSON.stringify(bind.body));
  const grantStore = new CoordinatorSessionGrants(path.join(directory, 'coordinators', projectId));
  const grantRoute = `/api/workbench/projects/${projectId}/api/coordinator/session-grants`;
  const bindingFile = path.join(directory, 'interface-v2', createHash('sha256').update('123').digest('hex'), 'state.json');
  const { ProtocolStore } = await import('../scripts/shared/protocol-store.mjs');
  const store = new ProtocolStore(path.dirname(bindingFile));
  const binding = await store.registeredBinding({ role: 'human', repositoryId: '123', deviceId: 'cloud-browser', agentId: 'cloud-human' }, 'coordinator-session');
  const session = { id: binding.sessionId, generation: binding.generation };
  const grant = async (overrides = {}) => call(grantRoute, { operationId: 'grant-1', baseVersion: (await grantStore.state()).version,
    action: 'grant', sessionId: session.id, deviceId: binding.deviceId, worktreeId: binding.worktreeId,
    generation: binding.generation, bindingVersion: binding.version, nodeIds: ['ALLOWED'], expiresAt: new Date(Date.now() + 3600000).toISOString(), ...overrides });
  const tool = async (operationId, mainVersion, actions, identity = session) => call('/api/v2/coordinator-tools', {
    operationId, name: 'edit_map', session: identity, input: { mainVersion, actions },
  }, credential);
  return { directory, call, credential, grantRoute, grantStore, grant, tool, binding, session, store,
    memory: () => readMemoryView(memoryConfig, projectId),
    audit: () => readMemoryProject(memoryConfig, projectId),
    restart: async () => { await server.close(); await start(); },
  };
}

test('only an admin can grant the exact current device/Session/worktree binding', async t => {
  const f = await fixture(t);
  const denied = await f.tool('before', 'v1', [{ op: 'update', id: 'ALLOWED', purpose: 'denied' }]);
  assert.equal(denied.status, 403);
  const untrusted = await f.call(f.grantRoute, {}, f.credential);
  assert.equal(untrusted.status, 401);
  for (const fields of [{ deviceId: 'another-device' }, { worktreeId: 'another-tree' }, { generation: 2 }, { bindingVersion: 'f'.repeat(64) }]) {
    assert.equal((await f.grant(fields)).status, 403);
  }
  const granted = await f.grant();
  assert.equal(granted.status, 200, JSON.stringify({ granted: granted.body, binding: f.binding }));
  assert.equal((await f.tool('other-session', 'v1', [{ op: 'update', id: 'ALLOWED', purpose: 'denied' }], { id: 'executor', generation: 1 })).status, 403);
  assert.equal((await f.call('/api/v2/coordinator-tools', { operationId: 'forged-role', name: 'edit_map', role: 'coordinator',
    input: { mainVersion: 'v1', actions: [{ op: 'update', id: 'ALLOWED', purpose: 'denied' }] } }, f.credential)).status, 400);
  assert.equal((await f.memory()).main.version, 'v1');
});

test('authorized Main edits preserve CAS, operation receipts, scope, audit and restart', async t => {
  const f = await fixture(t);
  const granted = await f.grant();
  assert.equal(granted.status, 200, JSON.stringify({ granted: granted.body, binding: f.binding }));
  const capabilities = await f.call('/api/v2/coordinator-capabilities', { session: f.session }, f.credential);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.data.mainWrite, true);
  assert.deepEqual(capabilities.body.data.nodeIds, ['ALLOWED']);
  const actions = [{ op: 'update', id: 'ALLOWED', purpose: 'Verified capability', memoryDocument: '# Synthetic memory\nCurrent synthetic status.' }];
  const first = await f.tool('update-1', 'v1', actions);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.committed, true);
  const version = first.body.data.version;
  assert.equal((await f.tool('update-1', 'v1', actions)).body.data.version, version);
  assert.equal((await f.tool('update-1', 'v1', [{ op: 'update', id: 'ALLOWED', purpose: 'different' }])).status, 409);
  assert.equal((await f.tool('stale', 'v1', actions)).status, 409);
  assert.equal((await f.tool('out-of-scope', version, [{ op: 'update', id: 'DENIED', purpose: 'denied' }])).status, 403);
  const current = await f.memory();
  assert.equal(current.main.memory.map.root.children[0].purpose, 'Verified capability');
  assert.equal(current.main.memory.map.root.children[1].purpose, '');
  assert.equal((await f.audit()).history.at(-1).actor.sessionId, f.session.id);
  assert.equal((await f.audit()).history.at(-1).actor.grantOperationId, 'grant-1');
  assert.equal((await f.grant({ operationId: 'grant-renewal' })).status, 200);
  assert.equal((await f.tool('update-1', 'v1', actions)).body.data.version, version);
  const maximumId = await f.tool('a'.repeat(128), version, actions);
  assert.equal(maximumId.status, 200, JSON.stringify(maximumId.body));
  await f.restart();
  assert.equal((await f.tool('update-1', 'v1', actions)).body.data.version, version);
  const revoke = await f.call(f.grantRoute, { operationId: 'revoke-1', baseVersion: (await f.grantStore.state()).version,
    action: 'revoke', sessionId: f.session.id });
  assert.equal(revoke.status, 200);
  assert.equal((await f.tool('after-revoke', version, actions)).status, 403);
  assert.equal((await f.memory()).main.version, maximumId.body.data.version);
});

test('migration and credential revocation invalidate previously granted Sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.grant()).status, 200);
  const second = await f.call('/api/v2/messages', { v: 2, id: 'other-login', type: 'auth.open', payload: {
    repository: 'https://github.com/example/synthetic', clientId: 'different-device', password: 'synthetic-password',
  } });
  assert.equal(second.status, 200);
  const request = { operationId: 'device-spoof', session: f.session, name: 'edit_map',
    input: { mainVersion: 'v1', actions: [{ op: 'update', id: 'ALLOWED', purpose: 'forbidden' }] } };
  assert.equal((await f.call('/api/v2/coordinator-tools', request, second.credential)).status, 403);
  assert.equal((await f.call('/api/workbench/projects/other-project/api/coordinator/session-grants', {})).status, 404);
  const principal = { repositoryId: '123', deviceId: f.binding.deviceId, agentId: f.binding.agentId, role: 'device' };
  await f.store.handle(principal, { v: 2, id: 'migrate', type: 'session.bind', payload: {
    sessionId: f.session.id, agentId: f.binding.agentId, worktreeId: 'replacement-tree', expectedBindingVersion: f.binding.version,
  } }, { allowMigration: true, verifyBinding: () => true });
  assert.equal((await f.tool('old-generation', 'v1', request.input.actions)).status, 403);
  assert.equal((await f.tool('new-generation-no-grant', 'v1', request.input.actions, { id: f.session.id, generation: 2 })).status, 403);
  const closed = await f.call('/api/v2/messages', { v: 2, id: 'logout', type: 'auth.close', payload: {} }, f.credential);
  assert.equal(closed.status, 200);
  assert.equal((await f.tool('revoked-credential', 'v1', request.input.actions)).status, 401);
  assert.equal((await f.memory()).main.version, 'v1');
});

test('grant operation retries are idempotent and revocation waits for an authorized commit', async t => {
  const f = await fixture(t), baseVersion = (await f.grantStore.state()).version;
  const input = { operationId: 'grant-stable', baseVersion, action: 'grant', sessionId: f.session.id,
    deviceId: f.binding.deviceId, worktreeId: f.binding.worktreeId, generation: f.binding.generation,
    bindingVersion: f.binding.version, nodeIds: ['ALLOWED'], expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const accepted = await f.call(f.grantRoute, input);
  assert.equal(accepted.status, 200);
  assert.deepEqual((await f.call(f.grantRoute, input)).body, accepted.body);
  assert.equal((await f.call(f.grantRoute, { ...input, nodeIds: null })).status, 409);
  assert.equal((await f.call(f.grantRoute, { operationId: 'stale-grant', baseVersion, action: 'revoke', sessionId: f.session.id })).status, 409);
  let entered, release;
  const started = new Promise(resolve => entered = resolve), blocked = new Promise(resolve => release = resolve);
  const principal = { repositoryId: '123', deviceId: f.binding.deviceId, agentId: f.binding.agentId, role: 'device' };
  const commit = f.grantStore.withAuthorized(principal, f.session, id => f.store.registeredBinding(principal, id), async () => {
    entered(); await blocked; return 'authorized-commit';
  });
  await started;
  const revoking = f.call(f.grantRoute, { operationId: 'revoke-stable', baseVersion: accepted.body.version, action: 'revoke', sessionId: f.session.id });
  assert.equal((await f.grantStore.state()).grants.length, 1);
  release();
  assert.equal(await commit, 'authorized-commit');
  assert.equal((await revoking).status, 200);
  assert.equal((await f.tool('no-later-commit', 'v1', [{ op: 'update', id: 'ALLOWED', purpose: 'denied' }])).status, 403);
});

test('Main commit fences concurrent Session migration, credential close and grant revocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.grant()).status, 200);
  const { ProtocolStore } = await import('../scripts/shared/protocol-store.mjs');
  const { ProtocolAuth } = await import('../scripts/cloud/protocol-auth.mjs');
  let reached, release, bindReached, closeReached, revokeReached;
  const paused = new Promise(resolve => reached = resolve), barrier = new Promise(resolve => release = resolve);
  const bindingRequested = new Promise(resolve => bindReached = resolve), closeRequested = new Promise(resolve => closeReached = resolve),
    revokeRequested = new Promise(resolve => revokeReached = resolve);
  const authorize = CoordinatorSessionGrants.prototype.authorize;
  let checks = 0;
  t.mock.method(CoordinatorSessionGrants.prototype, 'authorize', async function (...args) {
    const grant = await authorize.apply(this, args);
    if (++checks === 3) { reached(); await barrier; }
    return grant;
  });
  const handle = ProtocolStore.prototype.handle, close = ProtocolAuth.prototype.close, change = CoordinatorSessionGrants.prototype.change;
  t.mock.method(ProtocolStore.prototype, 'handle', function (principal, message, ...args) {
    if (message.id === 'concurrent-migration') bindReached();
    return handle.call(this, principal, message, ...args);
  });
  t.mock.method(ProtocolAuth.prototype, 'close', function (...args) { closeReached(); return close.apply(this, args); });
  t.mock.method(CoordinatorSessionGrants.prototype, 'change', function (input, ...args) {
    if (input.operationId === 'concurrent-revoke') revokeReached();
    return change.call(this, input, ...args);
  });
  const edit = f.tool('commit-before-revocation', 'v1', [{ op: 'update', id: 'ALLOWED', purpose: 'committed-before-revocation' }]);
  await paused;
  const completed = [];
  const migrating = f.call('/api/v2/messages', { v: 2, id: 'concurrent-migration', type: 'session.bind', payload: {
    sessionId: f.session.id, agentId: f.binding.agentId, worktreeId: 'replacement-tree', expectedBindingVersion: f.binding.version,
  } }, f.credential).then(result => { completed.push('migration'); return result; });
  const closing = f.call('/api/v2/messages', { v: 2, id: 'concurrent-close', type: 'auth.close', payload: {} }, f.credential)
    .then(result => { completed.push('close'); return result; });
  const revoking = f.call(f.grantRoute, { operationId: 'concurrent-revoke', baseVersion: (await f.grantStore.state()).version,
    action: 'revoke', sessionId: f.session.id }).then(result => { completed.push('revoke'); return result; });
  await Promise.all([bindingRequested, closeRequested, revokeRequested]);
  assert.deepEqual(completed, []);
  assert.equal((await f.memory()).main.version, 'v1');
  release();
  const [committed, migrated, closed, revoked] = await Promise.all([edit, migrating, closing, revoking]);
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
  assert.equal(closed.status, 200);
  assert.equal(revoked.status, 200);
  assert.equal((await f.memory()).main.memory.map.root.children[0].purpose, 'committed-before-revocation');
  assert.equal((await f.tool('after-close', committed.body.data.version, [{ op: 'update', id: 'ALLOWED', purpose: 'forbidden' }])).status, 401);
});

test('concurrent Main writers commit once and stale grants or other credentials fail closed', async t => {
  const f = await fixture(t);
  const granted = await f.grant();
  assert.equal(granted.status, 200, JSON.stringify({ granted: granted.body, binding: f.binding }));
  const results = await Promise.all(['one', 'two'].map(id => f.tool(id, 'v1', [{ op: 'update', id: 'ALLOWED', purpose: id }])));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const state = await f.grantStore.read();
  state.grants[createHash('sha256').update(f.session.id).digest('hex')].expiresAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(f.grantStore.file, JSON.stringify(state));
  const version = (await f.memory()).main.version;
  assert.equal((await f.tool('expired', version, [{ op: 'update', id: 'ALLOWED', purpose: 'expired' }])).status, 403);
  assert.equal((await f.call('/api/v2/coordinator-capabilities', { session: f.session }, 'unregistered')).status, 401);
  assert.equal((await f.memory()).main.version, version);
});
