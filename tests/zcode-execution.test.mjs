import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CoordinatorConversations } from '../scripts/cloud/coordinator-service.mjs';
import { validateIntegrationConfig, validateIntegrationCommand } from '../scripts/cloud/integration-gateway.mjs';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

test('ZCode execution stays opt-in and bound to an explicit user and template', () => {
  const base = { host: '127.0.0.1', port: 0, token: 'integration-test-credential-not-an-admin-token', teamId: 'TTESTWORKSPACE', projectIds: ['repo'] };
  assert.equal(validateIntegrationConfig(base).actions.includes('conversation.zcode'), false);
  const enabled = validateIntegrationConfig({ ...base, actions: ['conversation.zcode'],
    zcodeExecution: { repo: { templateSessionId: 'zcode-template', userIds: ['UTEST'] } } });
  assert.equal(validateIntegrationCommand(enabled, { id: 'enable-1', type: 'conversation.zcode', projectId: 'repo',
    conversationId: 'chat', teamId: 'TTESTWORKSPACE', userId: 'UTEST', payload: { expectedMode: 'manual' } }).command.type, 'conversation.zcode');
  for (const grant of [{ templateSessionId: 'zcode-template', userIds: [] },
    { templateSessionId: '../wrong', userIds: ['UTEST'] },
    { templateSessionId: 'zcode-template', userIds: ['UTEST'], extra: true }]) {
    assert.throws(() => validateIntegrationConfig({ ...base, zcodeExecution: { repo: grant } }), { code: 'INVALID_INTEGRATION_CONFIG' });
  }
});

test('ZCode conversation enable is idempotent and cannot switch an existing Cursor grant', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-zcode-conversation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const conversations = new CoordinatorConversations(directory), id = await conversations.createChat('create-zcode', { executionMode: 'manual' });
  const grant = { templateSessionId: 'template', configurationHash: 'digest', actor: { kind: 'human' } };
  const request = { operationId: 'enable-zcode', expectedMode: 'manual', grant };
  assert.equal((await conversations.enableZCode(id, request)).executionProvider, 'zcode');
  assert.equal((await conversations.enableZCode(id, request)).executionProvider, 'zcode');
  await assert.rejects(conversations.enableZCode(id, { ...request, grant: { ...grant, templateSessionId: 'other' } }), { code: 'ID_REUSED' });
  await assert.rejects(conversations.enableCursor(id, request), { code: 'CONFLICT' });
  assert.equal((await conversations.get(id)).zcodeExecution.templateSessionId, 'template');
});

test('ZCode gateway enables only a registered local template and rechecks revoked access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-zcode-http-'));
  let cloud;
  t.after(async () => { await cloud?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const templateId = '11111111-1111-4111-8111-111111111111';
  const providerFile = path.join(directory, 'model.json');
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://model.invalid', model: 'synthetic', token: 'synthetic-only' }));
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic-admin', projects: {
    'context-guard': { root: directory, token: 'synthetic-memory', ref: 'refs/heads/main', coordinator: {
      enabled: true, providerFile, bindings: { [templateId]: 'wt-zcode' }, sessionTemplates: [templateId] } },
  } };
  const memoryFile = path.join(memoryConfig.dataDir, digest('context-guard'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'main-1', memory: { records: {}, map: {
    v: 1, bootstrap: 'ready', root: { id: 'T0', title: 'Synthetic project', kind: 'module', state: 'dirty', owns: [], children: [] },
  } } }, sessions: {}, receipts: {}, history: [], events: [], eventCursors: {}, closedSessions: {} }));
  const integrationConfig = { host: '127.0.0.1', port: 0, token: 'synthetic-slack-integration-credential',
    teamId: 'TTEST', projectIds: ['context-guard'], actions: ['conversation.create', 'conversation.zcode', 'conversation.state'],
    zcodeExecution: { 'context-guard': { templateSessionId: templateId, userIds: ['UTEST'] } } };
  cloud = await startCloudServer({ dataDir: directory, port: 0, publicOrigin: 'https://zcode.example',
    memoryConfig, integrationConfig, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/repo' }] },
    coordinatorModelFactory: () => ({ next: async () => ({ stop: 'end_turn', content: [{ type: 'text', text: 'Synthetic reply' }] }) }) });
  const store = new ProtocolStore(path.join(directory, 'interface-v2', digest('123')));
  const principal = { repositoryId: '123', deviceId: 'local-device', agentId: templateId, role: 'executor' };
  const call = async (type, id, conversationId, userId = 'UTEST') => {
    const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST',
      headers: { Authorization: 'Bearer ' + integrationConfig.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, teamId: 'TTEST', userId, projectId: 'context-guard', ...(conversationId ? { conversationId } : {}),
        type, payload: type === 'conversation.zcode' ? { expectedMode: 'manual' } : {} }) });
    return { status: response.status, body: await response.json() };
  };
  const created = await call('conversation.create', 'new-chat');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const conversationId = created.body.data.conversationId;
  assert.equal((await call('conversation.zcode', 'before-binding', conversationId)).status, 403);
  await store.handle(principal, { v: 2, id: 'bind-zcode', type: 'session.bind', payload: {
    sessionId: templateId, worktreeId: 'wt-zcode', agentId: templateId, expectedBindingVersion: '',
  } }, { verifyBinding: () => true });
  await store.rememberSessionNames(principal, [{ id: templateId, generation: 1, platform: 'zcode' }]);
  assert.equal((await call('conversation.zcode', 'wrong-user', conversationId, 'UOTHER')).status, 403);
  const enabled = await call('conversation.zcode', 'enable-zcode', conversationId);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.data.executionProvider, 'zcode');
  assert.deepEqual((await call('conversation.zcode', 'enable-zcode', conversationId)).body, enabled.body);
  integrationConfig.zcodeExecution['context-guard'].userIds = ['UOTHER'];
  assert.equal((await call('conversation.state', 'revoked-state', conversationId)).status, 403);
});
