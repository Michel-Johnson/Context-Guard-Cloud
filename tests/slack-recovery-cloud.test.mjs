import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash, readJSON } from '../scripts/shared/io.mjs';
import { recoveryScope, requireEmptyRecoveryState } from '../scripts/cloud/slack-recovery.mjs';
import { startIntegrationGateway, validateIntegrationConfig, validateIntegrationCommand, INTEGRATION_COMMANDS } from '../scripts/cloud/integration-gateway.mjs';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { coordinatorStep } from '../scripts/cloud/coordinator-model.mjs';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { Gateway } from '../plugins/slack/src/gateway.mjs';

const teamId = 'TTEST', userId = 'UTEST', projectId = 'fixture-project', token = 'synthetic-recovery-private-gateway-credential';
const actor = { kind: 'human', sessionId: `slack:${teamId}:${userId}`, integration: 'slack', teamId, userId, channelId: 'CTEST' };
const operation = (id, suffix) => `slack-${hash(`${id}:${suffix}`)}`;
const inboxId = `message:${teamId}:CTEST:100.1`;
const inputs = [{ id: operation(inboxId, 'submit'), text: '只读解释' }];
const participation = { text: inputs[0].text, inputs, context: [], files: [], routing: { coordinatorUserId: 'UBOT', mentionedUsers: [] } };
const descriptor = { inboxId, memberIds: [inboxId], snapshotHash: 'a'.repeat(64), originalRequest: {
  id: operation(inboxId, 'relevance'), userId, projectId, payload: participation } };
const scope = recoveryScope(descriptor, actor, projectId);
const submission = { id: scope.submitId, inputs, followup: 'steer' };
const result = text => ({ stop: 'end_turn', content: [{ type: 'text', text }] });
const options = { source: 'slack', actor, participation, operatorRecovery: 'approved-recovery', recoveryGuard: requireEmptyRecoveryState };
async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-recovery-cloud-'));
  t.after(() => fs.rm(value, { recursive: true, force: true })); return value;
}

test('Recovery capability is opt-in and raw caller retry budgets, changed identities and missing original proof are rejected', () => {
  const config = { token, teamId, projectIds: [projectId] };
  const preflight = { id: 'recovery-check', type: 'recovery.preflight', teamId, userId, projectId, payload: descriptor };
  assert.throws(() => validateIntegrationCommand(validateIntegrationConfig(config), preflight), { code: 'FORBIDDEN' });
  const allowed = validateIntegrationConfig({ ...config, actions: INTEGRATION_COMMANDS });
  assert.equal(validateIntegrationCommand(allowed, preflight).actor.channelId, 'CTEST');
  const input = { id: scope.submitId, type: 'conversation.submit', teamId, userId, projectId, conversationId: scope.conversationId,
    payload: { inputs, followup: 'steer', slackChannelId: 'CTEST', participation, recovery: { operationId: 'approved-recovery', scope: descriptor } } };
  assert.deepEqual(validateIntegrationCommand(allowed, input).actor, actor);
  for (const wrong of [{ ...input, userId: 'UOTHER' }, { ...input, id: 'different-original-id' },
    { ...input, conversationId: 'some-other-conversation' }, { ...input, payload: { ...input.payload, retryBudget: 1 } },
    { ...preflight, payload: { ...descriptor, path: '/private/anything' } }]) assert.throws(() => validateIntegrationCommand(allowed, wrong));
  for (const [state, journal] of [[{ pending: {} }, null], [{ toolReceipts: { old: {} } }, null], [null, { requests: { old: {} } }],
    [null, { interrupts: { stop: {} } }], [{ messages: [{ role: 'user' }] }, null]]) assert.throws(() => requireEmptyRecoveryState(state, journal), { code: 'UNKNOWN_BUSINESS_EFFECT' });
});

test('Recovery authoritative gateway preflight refuses in-flight or accepted legacy single-submit without writing a business receipt', async t => {
  const root = await directory(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const gateway = await startIntegrationGateway({ config: { token, teamId, projectIds: [projectId], actions: INTEGRATION_COMMANDS }, stateDir: root,
    state: async () => ({}), command: async (input, metadata) => {
      if (input.type === 'recovery.preflight') { await metadata.recoveryCheck(); return { noBusinessEffect: true }; }
      entered(); await blocked; return { accepted: true };
    } });
  t.after(async () => { release(); await gateway.close(); });
  const client = new Gateway({ url: gateway.url, token, teamId });
  const old = client.command('conversation.submit', { id: inputs[0].id, userId, projectId, conversationId: scope.conversationId, payload: { text: inputs[0].text } });
  await started;
  const preflight = () => client.command('recovery.preflight', { id: 'check-original', userId, projectId, payload: descriptor });
  await assert.rejects(preflight(), { code: 'UNKNOWN_BUSINESS_EFFECT' });
  release(); await old;
  await assert.rejects(preflight(), { code: 'UNKNOWN_BUSINESS_EFFECT' });
  assert.equal(await readJSON(path.join(root, 'receipts', hash(JSON.stringify([teamId, 'check-original'])) + '.json'), null), null);
});

test('Recovery final admission rechecks inside actual submit lock after a competing ordinary input and after pre-accept hook', async t => {
  const root = await directory(t);
  const service = new CoordinatorService({ directory: root, system: 'fixture', tools: [], execute: async () => {}, model: { next: async () => result('normal') } });
  t.after(() => service.close({ stop: true }));
  await service.submit({ id: 'new-ordinary', text: 'new input wins' }); await service.close();
  await assert.rejects(service.submitBatch(submission, options), { code: 'UNKNOWN_BUSINESS_EFFECT' });
  assert.equal((await service.state()).acceptedRequestIds.includes(inputs[0].id), false);
  const second = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [], execute: async () => {}, model: { next: async () => result('unused') },
    beforeAcceptHumanInput: async () => { const state = await second.readConversation({ messages: [], requests: {}, status: 'idle', toolReceipts: {} });
      state.requests['concurrent-effect'] = 'known'; await second.saveState(state); } });
  t.after(() => second.close({ stop: true }));
  // The guard must re-read disk: a callback cannot make a stale negative view
  // valid by changing persistence behind the local pre-admission object.
  await assert.rejects(second.submitBatch(submission, options), { code: 'UNKNOWN_BUSINESS_EFFECT' });
});

test('Recovery initial provider failure has one opportunity, ordinary retries remain, later business model rounds remain legal', async t => {
  for (const code of ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE']) {
    let calls = 0;
    const service = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [], execute: async () => {}, retryDelayMs: 0,
      model: { next: async () => { calls++; throw Object.assign(new Error('fixture provider failure'), { code }); } } });
    await service.submitBatch(submission, options); await service.close();
    assert.equal(calls, 1); assert.equal((await service.state()).status, 'error'); assert.equal((await service.state()).error.code, code);
    assert.equal((await service.readConversation(null)).operatorRecovery.initialAttempted, true);
    assert.equal((await service.readConversation(null)).operatorRecovery.initialAccepted, false);
    const restarted = new CoordinatorService({ directory: path.dirname(service.file), system: 'fixture', tools: [], execute: async () => {},
      model: { next: async () => assert.fail('Uncertain initial request cannot be replayed automatically') } });
    restarted.kick(); await restarted.close();
    assert.equal((await restarted.state()).error.code, code);
  }
  let ordinaryCalls = 0;
  const ordinary = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [], execute: async () => {}, retryDelayMs: 0,
    model: { next: async () => { ordinaryCalls++; if (ordinaryCalls < 3) throw Object.assign(new Error('temporary'), { code: 'MODEL_TIMEOUT' }); return result('normal'); } } });
  await ordinary.submit({ id: 'ordinary', text: 'normal' }); await ordinary.close(); assert.equal(ordinaryCalls, 3);
  const silent = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [], execute: async () => assert.fail('No silent business'),
    model: { next: async () => result('[CG_SILENT]') } });
  await silent.submitBatch(submission, options); await silent.close();
  assert.equal((await silent.state()).participationDecision, 'silent');
  assert.equal((await silent.readConversation(null)).operatorRecovery.initialAccepted, true);
  let calls = 0, executions = 0;
  const tool = { type: 'tool_use', id: 'original-read', name: 'read', input: {} };
  const declared = { ...tool, name: 'reply_read' }, operationId = `coordinator:${hash(`${inputs[0].id}:${declared.id}`)}`;
  const recovery = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [{ name: 'read' }],
    execute: async (name, args, metadata) => {
      assert.equal(name, 'read'); assert.deepEqual(args, declared.input); assert.equal(metadata.operationId, operationId);
      const accepted = await recovery.readConversation(null);
      assert.equal(accepted.operatorRecovery.initialAccepted, true, 'Acceptance and complete alias are durable before business execution');
      assert.deepEqual(accepted.messages.at(-1).content, [declared]);
      executions++; return { read: true };
    }, model: { next: async request => {
      if (++calls === 1) {
        assert.deepEqual(request.tools.map(tool => tool.name), ['reply_read']);
        await request.onToolStart?.('reply_read');
        return { stop: 'tool_use', content: [declared] };
      }
      assert.deepEqual(request.tools.map(tool => tool.name), ['read']);
      assert.deepEqual(request.messages.find(message => message.role === 'assistant').content, [declared]);
      const originalResult = request.messages.find(message => message.role === 'user' && Array.isArray(message.content) &&
        message.content.some(block => block.type === 'tool_result'));
      assert.equal(originalResult.content[0].tool_use_id, declared.id); assert.deepEqual(JSON.parse(originalResult.content[0].content), { read: true });
      return result('继续原工具结果');
    } } });
  await recovery.submitBatch(submission, options); await recovery.close(); assert.equal(calls, 2); assert.equal(executions, 1);
  const native = await recovery.readConversation(null);
  assert.equal(native.operatorRecovery.initialAccepted, true);
  assert.deepEqual(native.messages.find(message => message.role === 'assistant').content, [declared]);
  assert.equal(native.toolReceipts[operationId].fingerprint, hash(JSON.stringify({ name: declared.name, input: declared.input })));
  assert.deepEqual(native.toolReceipts[operationId].result, { read: true });
  for (const mode of ['stop', 'steer']) {
    let entered, calls = 0, effects = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const controlled = new CoordinatorService({ directory: await directory(t), system: 'fixture', tools: [{ name: 'read' }],
      execute: async () => { effects++; return { read: true }; }, steerSettleMs: 0,
      model: { next: async request => {
        if (++calls === 1) return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]\n' }, tool] };
        if (calls > 2) return result('[CG_REPLY]\n新消息优先');
        return new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); entered(); });
      } } });
    t.after(() => controlled.close({ stop: true }));
    await controlled.submitBatch(submission, options); await started;
    if (mode === 'stop') await controlled.interrupt({ id: 'human-stop', expectedTurnId: inputs[0].id }, { source: 'slack', actor });
    else {
      const next = [{ id: 'new-human-input', text: '新要求' }];
      await controlled.submitBatch({ id: 'new-human-batch', inputs: next, followup: 'steer' }, { source: 'slack', actor,
        participation: { ...participation, text: next[0].text, inputs: next } });
    }
    await controlled.close();
    const persisted = await controlled.readConversation(null);
    assert.equal(effects, 1); assert.equal(Object.keys(persisted.toolReceipts).length, 1);
    if (mode === 'stop') { assert.equal(persisted.status, 'interrupted'); assert.equal(persisted.operatorRecovery.initialAccepted, true); assert.equal(calls, 2); }
    else {
      assert.equal(persisted.activeInput.id, inputs[0].id, 'Original first input remains the immutable tool/retry target');
      assert.equal(persisted.activeRequestIds.includes('new-human-input'), true);
      assert.deepEqual((await controlled.state()).participationRequestIds, ['new-human-input']);
      assert.equal(persisted.operatorRecovery, undefined); assert.equal(calls, 3);
      const receipt = Object.values(persisted.toolReceipts)[0]; assert.deepEqual(receipt.result, { read: true });
    }
  }
});

test('Recovery native acceptance and assistant share one save before started tool interruption and never on ask-user preparation', async t => {
  const root = await directory(t), file = path.join(root, 'checkpoint.json'); let modelCalls = 0, effects = 0;
  const call = { type: 'tool_use', id: 'stable-tool', name: 'read', input: {} };
  const state = { messages: [], activeTurnId: 'original', activeInput: { id: 'original', source: 'human' },
    operatorRecovery: { initialAttempted: true, initialAccepted: false }, status: 'running' };
  const save = value => fs.writeFile(file, JSON.stringify(value));
  const accepted = value => { value.operatorRecovery.initialAccepted = true; };
  let startedId;
  await assert.rejects(coordinatorStep({ turnId: 'original', state, system: 'fixture', tools: [{ name: 'read' }], save, onModelAccepted: accepted,
    model: { next: async () => { modelCalls++; return { stop: 'tool_use', content: [call] }; } }, execute: async (_name, _input, metadata) => {
      effects++; startedId = metadata.operationId; throw Object.assign(new Error('process interrupted after durable external receipt'), { code: 'TOOL_RESULT_UNKNOWN' }); } }), { code: 'TOOL_RESULT_UNKNOWN' });
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(persisted.operatorRecovery.initialAccepted, true); assert.equal(persisted.pending.stop, 'tool_use');
  assert.equal(persisted.messages.at(-1).content[0].id, call.id);
  await coordinatorStep({ turnId: 'original', state: persisted, system: 'fixture', tools: [{ name: 'read' }], save,
    model: { next: async () => assert.fail('Pending original native tool does not need a second initial model') },
    execute: async (_name, _input, metadata) => { assert.equal(metadata.operationId, startedId); return { originalDurableEffect: true }; } });
  assert.equal(modelCalls, 1); assert.equal(effects, 1); assert.equal(Object.keys(persisted.toolReceipts).length, 1);
  const preparation = { messages: [], activeTurnId: 'ask', activeInput: { id: 'ask', source: 'human' }, operatorRecovery: { initialAttempted: true, initialAccepted: false } };
  await assert.rejects(coordinatorStep({ turnId: 'ask', state: preparation, system: 'fixture', tools: [{ name: 'ask_user' }], save, onModelAccepted: accepted,
    model: { next: async () => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'ask-call', name: 'ask_user', input: {} }] }) },
    onToolStart: async () => { await save(preparation); throw new Error('preparing-question crash'); }, execute: async () => assert.fail('Not started') }));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).operatorRecovery.initialAccepted, false); assert.equal(preparation.messages.length, 0);
});

test('Recovery formal Cloud HTTP proof and exact-ID replay use current merged path without classifier or private flags in public state', async t => {
  const root = await directory(t), providerFile = path.join(root, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ token: 'synthetic', baseUrl: 'https://fixture.invalid', model: 'fixture-model' }));
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: projectId, name: 'fixture' }] }));
  const memoryConfig = { dataDir: path.join(root, 'memory'), adminToken: 'synthetic-admin', projects: { [projectId]: {
    root, ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {} } } } };
  const file = legacyProjectMemoryFile(memoryConfig.dataDir, projectId); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ revision: 1, main: { version: 'fixture-main', memory: { records: {}, map: { project: 'fixture', root: {
    id: 'T0', title: 'fixture', kind: 'module', owns: ['src/'], memoryDocument: '只读夹具', children: [], todos: [], bugs: [] } } } },
    sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  let models = 0;
  const cloud = await startCloudServer({ dataDir: root, host: '127.0.0.1', port: 0, privateAccess: true, browserToken: 'synthetic-browser', adminToken: 'synthetic-server', memoryConfig,
    protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/lab' }] },
    integrationConfig: { host: '127.0.0.1', port: 0, token, teamId, projectIds: [projectId], actions: INTEGRATION_COMMANDS },
    coordinatorModelFactory: () => ({ model: 'fixture-model', next: async request => { models++; assert.match(request.system, /\[CG_REPLY\]/); return result('[CG_REPLY]\n完整解释'); } }) });
  let closed = false; t.after(() => { if (!closed) return cloud.close(); });
  const client = new Gateway({ url: cloud.integrationUrl, token, teamId });
  const proof = await client.command('recovery.preflight', { id: 'original-proof', userId, projectId, payload: descriptor });
  assert.equal(proof.noBusinessEffect, true); assert.equal(proof.scopeHash, scope.fingerprint); assert.equal(models, 0);
  const created = await client.command('conversation.create', { id: scope.createId, userId, projectId, payload: { operationId: scope.createId } });
  assert.equal(created.conversationId, scope.conversationId);
  const input = { id: scope.submitId, userId, projectId, conversationId: scope.conversationId, payload: {
    inputs, followup: 'steer', slackChannelId: 'CTEST', participation, recovery: { operationId: 'approved-recovery', scope: descriptor } } };
  assert.equal((await client.command('conversation.submit', input)).accepted, true);
  assert.equal((await client.command('conversation.submit', input)).accepted, true);
  const publicState = await client.command('conversation.state', { id: 'state-public', userId, projectId, conversationId: scope.conversationId });
  assert.equal(Object.hasOwn(publicState, 'operatorRecovery'), false);
  await cloud.close(); // Drains the original accepted runner, not a provider probe.
  closed = true;
  assert.equal(models, 1);
  const receipts = await fs.readdir(path.join(root, 'integration-gateway', 'receipts'));
  assert.equal(receipts.includes(hash(JSON.stringify([teamId, 'original-proof'])) + '.json'), false);
});
