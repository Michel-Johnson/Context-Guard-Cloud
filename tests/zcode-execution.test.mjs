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
  let cloud, delegate = false, delegateCalls = 0;
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
    teamId: 'TTEST', projectIds: ['context-guard'], actions: ['conversation.create', 'conversation.zcode', 'conversation.state', 'conversation.submit', 'conversation.operator-action'],
    zcodeExecution: { 'context-guard': { templateSessionId: templateId, userIds: ['UTEST'] } } };
  cloud = await startCloudServer({ dataDir: directory, port: 0, publicOrigin: 'https://zcode.example',
    memoryConfig, integrationConfig, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/repo' }] },
    coordinatorModelFactory: () => ({ next: async ({ messages }) => {
      if (!delegate) return { stop: 'end_turn', content: [{ type: 'text', text: 'Synthetic reply' }] };
      delegateCalls++;
      const input = delegateCalls === 1 ? {} : { actionId: JSON.parse(messages.at(-1).content[0].content).actions.find(x => x.type === 'conversation.zcode').id };
      return { stop: 'tool_use', content: [{ type: 'tool_use', id: `delegate-${delegateCalls}`,
        name: delegateCalls === 1 ? 'get_slack_actions' : 'perform_slack_action', input }] };
    } }) });
  const store = new ProtocolStore(path.join(directory, 'interface-v2', digest('123')));
  const principal = { repositoryId: '123', deviceId: 'local-device', agentId: templateId, role: 'executor' };
  const call = async (type, id, conversationId, userId = 'UTEST', payload) => {
    const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST',
      headers: { Authorization: 'Bearer ' + integrationConfig.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, teamId: 'TTEST', userId, projectId: 'context-guard', ...(conversationId ? { conversationId } : {}),
        type, payload: payload || (type === 'conversation.zcode' ? { expectedMode: 'manual' } : {}) }) });
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
  integrationConfig.zcodeExecution['context-guard'].userIds = ['UTEST'];
  delegate = true;
  const delegatedChat = (await call('conversation.create', 'delegated-chat')).body.data.conversationId;
  const submitted = await call('conversation.submit', 'actual-slack-request', delegatedChat, 'UTEST',
    { text: '直接启用本地执行，不让我去客户端操作', slackChannelId: 'CTEST' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  let state;
  for (let count = 0; count < 50; count++) {
    state = (await call('conversation.state', 'read-delegated-state', delegatedChat)).body.data;
    if (!state.activeTurnId && state.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.status, 'waiting-for-user', JSON.stringify(state.error));
  const action = state.messages.flatMap(message => message.actions || []).find(item => item.kind === 'slack-operation');
  assert.ok(action, 'Actual Cloud model tool must create durable host intent');
  const result = await call('conversation.operator-action', 'host-apply', delegatedChat, 'UTEST', { actionId: action.actionId });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'applied');
  assert.equal(result.body.data.performedBy, 'coordinator');
  assert.equal((await call('conversation.state', 'final-state', delegatedChat)).body.data.executionProvider, 'zcode');
  assert.deepEqual((await call('conversation.operator-action', 'host-apply', delegatedChat, 'UTEST', { actionId: action.actionId })).body, result.body);
});
