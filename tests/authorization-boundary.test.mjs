import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { readMemoryView } from '../scripts/cloud/memory.mjs';
import { CoordinatorConversations } from '../scripts/cloud/coordinator-service.mjs';

const node = (id, children = []) => ({ id, title: id, kind: 'module', state: 'dirty', purpose: '',
  memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children, proposal: 'accepted' });

async function fixture(t, { nodeIds = ['ALLOWED', 'DEST'], coordinatorNodeIds, fileWrite = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-auth-boundary-'));
  let server;
  t.after(async () => { await server?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const projectId = 'context-guard', providerFile = path.join(directory, 'provider.json');
  const checkout = path.join(directory, 'checkout');
  await fs.mkdir(checkout);
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://provider.invalid', model: 'test', token: 'synthetic' }));
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic', projects: {
    [projectId]: { root: checkout, token: 'synthetic', ref: 'refs/heads/main', coordinator: {
      enabled: true, mapWrite: true, fileWrite, providerFile, bindings: {},
      ...(coordinatorNodeIds ? { nodeIds: coordinatorNodeIds } : {}),
    } },
  } };
  const memoryFile = path.join(memoryConfig.dataDir, createHash('sha256').update(projectId).digest('hex'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  const root = node('T0', [node('ALLOWED', [node('SECRET_CHILD')]), node('DENIED'), node('DEST')]);
  root.children[0]._inbox = [node('SECRET_INBOX')];
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'v1', memory: {
    map: { v: 1, bootstrap: 'ready', project: 'Lab', flows: [], root }, records: {},
  } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  const conversations = new CoordinatorConversations(path.join(directory, 'coordinators', projectId));
  const manualConversation = await conversations.createChat('private-focus', { executionMode: 'manual' });
  await conversations.setFocus(manualConversation, { nodeId: 'DENIED', kind: 'todo', itemId: 'TD1' });
  server = await startCloudServer({ dataDir: directory, port: 0, browserToken: 'synthetic-browser', memoryConfig,
    browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
    protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/lab', clients: {
      limited: { deviceId: 'limited-device', agentId: 'limited-agent', role: 'coordinator', bindings: {}, nodeIds },
    } }] },
    coordinatorModelFactory: () => ({ next: async () => { throw new Error('Boundary checks must not invoke a model'); } }),
  });
  const login = await fetch(`${server.url}/api/v2/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    v: 2, id: 'login', type: 'auth.open', payload: { repository: 'https://github.com/example/lab', clientId: 'limited', password: 'synthetic-password' },
  }) });
  assert.equal(login.status, 200, await login.clone().text());
  const headers = { Authorization: `Bearer ${login.headers.get('x-context-guard-credential')}`, 'Content-Type': 'application/json' };
  return {
    checkout,
    manualConversation,
    memory: () => readMemoryView(memoryConfig, projectId),
    call: async (name, input, operationId = 'boundary', conversationId) => {
      const response = await fetch(`${server.url}/api/v2/coordinator-tools`, { method: 'POST', headers,
        body: JSON.stringify({ operationId, name, input, ...(conversationId ? { conversationId } : {}) }) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('restricted caller cannot hide a forbidden node deletion behind an allowed nodeId', async t => {
  const f = await fixture(t);
  const result = await f.call('edit_map', { mainVersion: 'v1', actions: [
    { op: 'delete', kind: 'node', id: 'DENIED', nodeId: 'ALLOWED' },
  ] });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'INVALID_ARGUMENT');
  assert.equal((await f.memory()).main.version, 'v1');
});

for (const op of ['delete', 'move']) test(`restricted caller cannot ${op} a subtree containing forbidden descendants`, async t => {
  const f = await fixture(t);
  const action = { op, id: 'ALLOWED', ...(op === 'move' ? { parentId: 'DEST' } : {}) };
  const result = await f.call('edit_map', { mainVersion: 'v1', actions: [action] });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal((await f.memory()).main.version, 'v1');
});

test('node-restricted caller cannot write an arbitrary repository file', async t => {
  const f = await fixture(t, { nodeIds: [], fileWrite: true });
  const result = await f.call('write_file', { path: 'restricted/secret.txt', content: 'unauthorized' });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(await fs.access(path.join(f.checkout, 'restricted/secret.txt')).then(() => true, () => false), false);
});

test('batched movement cannot hide a forbidden node inside a later deletion', async t => {
  const f = await fixture(t);
  const result = await f.call('edit_map', { mainVersion: 'v1', actions: [
    { op: 'move', id: 'DENIED', parentId: 'DEST' }, { op: 'delete', id: 'DEST' },
  ] });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal((await f.memory()).main.version, 'v1');
});

test('restricted read_map removes ungranted child summaries', async t => {
  const f = await fixture(t);
  const result = await f.call('read_map', { nodeId: 'ALLOWED' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data.node.children, []);
  assert.equal(JSON.stringify(result.body).includes('SECRET_CHILD'), false);
});

test('restricted read_map cannot leak ungranted inbox descendants', async t => {
  const f = await fixture(t);
  const result = await f.call('read_map', { nodeId: 'ALLOWED' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(JSON.stringify(result.body).includes('SECRET_INBOX'), false);
});

test('prepare_task cannot inherit a forbidden node from conversation focus', async t => {
  const f = await fixture(t);
  const result = await f.call('prepare_task', { taskId: 'TD1', text: 'Safe request', acceptance: 'Safe result',
    mainVersion: 'v1', nodeIds: ['ALLOWED'] }, 'prepare', f.manualConversation);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal((await f.memory()).main.version, 'v1');
});

test('unrestricted caller cannot exceed the configured Coordinator map scope', async t => {
  const f = await fixture(t, { nodeIds: null, coordinatorNodeIds: ['ALLOWED'] });
  const result = await f.call('edit_map', { mainVersion: 'v1', actions: [
    { op: 'update', id: 'DENIED', title: 'unauthorized' },
  ] });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal((await f.memory()).main.version, 'v1');
});

test('configured Coordinator node scope prevents project file writes by an unrestricted caller', async t => {
  const f = await fixture(t, { nodeIds: null, coordinatorNodeIds: ['ALLOWED'], fileWrite: true });
  const result = await f.call('write_file', { path: 'restricted/secret.txt', content: 'unauthorized' });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(await fs.access(path.join(f.checkout, 'restricted/secret.txt')).then(() => true, () => false), false);
});

test('read_map child summaries use the intersection of project and caller node scopes', async t => {
  const f = await fixture(t, { nodeIds: ['ALLOWED', 'SECRET_CHILD'], coordinatorNodeIds: ['ALLOWED'] });
  const result = await f.call('read_map', { nodeId: 'ALLOWED' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data.node.children, []);
  assert.equal(JSON.stringify(result.body).includes('SECRET_CHILD'), false);
  assert.equal(JSON.stringify(result.body).includes('SECRET_INBOX'), false);
});

test('both project and caller grants preserve the authorized child summary', async t => {
  const nodeIds = ['ALLOWED', 'SECRET_CHILD'];
  const f = await fixture(t, { nodeIds, coordinatorNodeIds: nodeIds });
  const result = await f.call('read_map', { nodeId: 'ALLOWED' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data.node.children.map(child => child.id), ['SECRET_CHILD']);
  assert.equal(JSON.stringify(result.body).includes('SECRET_INBOX'), false);
});
