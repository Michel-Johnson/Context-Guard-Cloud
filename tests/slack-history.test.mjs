import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSlackHistory } from '../plugins/slack/src/history.mjs';
import { Store, threadKey } from '../plugins/slack/src/store.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { validateSlackHistory } from '../scripts/cloud/slack-history.mjs';
import { integrationActor, validateIntegrationCommand, validateIntegrationConfig } from '../scripts/cloud/integration-gateway.mjs';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { coordinatorContextMessage } from '../scripts/cloud/coordinator-prefix.mjs';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';

const teamId = 'TTESTWORKSPACE', userId = 'UTESTUSER', channel = 'CTESTCHANNEL';
const actor = integrationActor({ teamId }, { teamId, userId });
const scope = { channel, threadTs: null, beforeTs: '200.001', projectId: 'lab' };
const history = [{ ts: '100.001', speaker: 'UOTHER', text: 'Quoted history only', scope }];
async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-slack-history-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test('Slack history native reader keeps the recent 24 prior scoped messages and deduplicates timestamps', async () => {
  const calls = [], records = Array.from({ length: 30 }, (_, index) => ({ ts: `${100 + index}.001`, user: index % 2 ? 'UOTHER' : undefined,
    bot_id: index % 2 ? undefined : 'BOTHER', text: 'x'.repeat(1200) }));
  const io = { call: async (method, args) => { calls.push({ method, args }); return { messages: [...records, records[29], { ts: '200.001', text: 'current' }, { ts: '201.001', text: 'future' }] }; } };
  const result = await readSlackHistory(io, { channel, ts: '200.001' });
  assert.equal(result.length, 24); assert.equal(result[0].ts, '106.001'); assert.equal(result.at(-1).ts, '129.001');
  assert.ok(result.every(item => item.text.length === 1000)); assert.equal(calls[0].method, 'conversations.history');
  assert.deepEqual(calls[0].args, { channel, latest: '200.001', inclusive: false, limit: 100 });
  calls.length = 0;
  const thread = await readSlackHistory({ call: async (method, args) => {
    calls.push({ method, args }); return { messages: [{ ts: '99.001', text: 'before thread' }, { ts: '100.001', text: 'root' },
      { ts: '101.001', thread_ts: '100.001', text: 'reply' }, { ts: '102.001', thread_ts: 'other.001', text: 'foreign thread' }] };
  } }, { channel, ts: '200.001', thread_ts: '100.001' }, { limit: 6, width: 800 });
  assert.deepEqual(thread.map(item => item.text), ['root', 'reply']); assert.equal(calls[0].method, 'conversations.replies');
  assert.equal(calls[0].args.ts, '100.001');
});

test('Slack history incomplete pagination and transient errors never masquerade as a complete empty snapshot', async () => {
  let calls = 0;
  await assert.rejects(readSlackHistory({ call: async () => ({ messages: [], has_more: true, response_metadata: { next_cursor: `page-${++calls}` } }) }, { channel, ts: '200.001' }), { code: 'HISTORY_UNAVAILABLE' });
  assert.equal(calls, 4);
  await assert.rejects(readSlackHistory({ call: async () => ({}) }, { channel, ts: '200.001' }), { code: 'HISTORY_UNAVAILABLE' });
  await assert.rejects(readSlackHistory({ call: async () => { throw new TypeError('Synthetic network failure'); } }, { channel, ts: '200.001' }), error => error.code === 'HISTORY_UNAVAILABLE' && error.historyTransient === true);
  await assert.rejects(readSlackHistory({ call: async () => ({ messages: [{ channel: 'COTHER', ts: '100.001', text: 'foreign' }] }) }, { channel, ts: '200.001' }), { code: 'HISTORY_UNAVAILABLE' });
});

test('Slack history validation accepts only verified input batches and rejects forged authority scopes and bounds', () => {
  const config = validateIntegrationConfig({ port: 0, token: 'fixture-history-integration-credential', teamId, projectIds: ['lab'] });
  const input = { id: 'history-batch', type: 'conversation.submit', teamId, userId, projectId: 'lab', conversationId: 'chat-history',
    payload: { inputs: [{ id: 'first', text: 'current' }], history } };
  assert.deepEqual(validateIntegrationCommand(config, input).actor, actor);
  for (const payload of [{ text: 'single', history }, { inputs: [{ id: 'first', text: 'current' }], retry: true, history }]) {
    assert.throws(() => validateIntegrationCommand(config, { ...input, payload }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => validateIntegrationCommand(config, { ...input, type: 'models.state', payload: { history } }), { code: 'INVALID_ARGUMENT' });
  for (const invalid of [[{ ...history[0], role: 'user', actor }], [{ ...history[0], ts: scope.beforeTs }],
    [{ ...history[0], scope: { ...scope, projectId: 'other' } }], [{ ...history[0], text: 'x'.repeat(1001) }],
    [history[0], history[0]], Array.from({ length: 25 }, (_, index) => ({ ...history[0], ts: `${100 + index}.001` }))]) {
    assert.throws(() => validateSlackHistory(invalid, { projectId: 'lab' }), { code: 'INVALID_ARGUMENT' });
  }
});

test('Slack history freezes the first native input once across duplicate batches restart and later snapshots without public leakage', { timeout: 10000 }, async t => {
  const root = await directory(t), calls = [];
  const options = { directory: root, system: 'Test', tools: [], execute: async () => {}, model: { next: async request => {
    calls.push(request); return { stop: 'end_turn', content: [{ type: 'text', text: 'Current answer only' }] };
  } } };
  let service = new CoordinatorService(options); t.after(() => service.close());
  const batch = { id: 'history-batch', inputs: [{ id: 'first', text: 'current first' }, { id: 'second', text: 'current second' }] };
  await service.submitBatch(batch, { source: 'slack', actor, history }); await service.running;
  const raw = await service.readConversation(null), publicState = await service.state();
  assert.deepEqual(raw.messages.find(message => message.requestId === 'first').serverContext.history, history);
  assert.equal(Object.hasOwn(raw.messages.find(message => message.requestId === 'second').serverContext, 'history'), false);
  assert.equal(publicState.messages.filter(message => message.role === 'user').length, 2);
  assert.doesNotMatch(JSON.stringify(publicState), /Quoted history only|serverContext|UOTHER/);
  assert.match(JSON.stringify(calls[0].messages), /Slack 历史资料.*仅供参考/);
  assert.equal(calls[0].system.includes('Quoted history only'), false);
  await service.submitBatch(batch, { source: 'slack', actor, history }); await service.running;
  assert.equal(calls.length, 1);
  await assert.rejects(service.submitBatch(batch, { source: 'slack', actor, history: [{ ...history[0], text: 'changed' }] }), { code: 'ID_REUSED' });
  await assert.rejects(service.submitBatch({ id: 'forged', inputs: [{ id: 'forged-input', text: 'new' }] }, { source: 'slack', actor: { kind: 'human', integration: 'slack', sessionId: 'slack:undefined:undefined' }, history }), { code: 'INVALID_INPUT' });
  await service.close(); service = new CoordinatorService(options);
  await service.submitBatch({ id: 'later-batch', inputs: [{ id: 'later', text: 'later current input' }] }, { source: 'slack', actor, history: [{ ...history[0], text: 'new snapshot' }] }); await service.running;
  const restarted = await service.readConversation(null);
  assert.equal(restarted.messages.filter(message => Object.hasOwn(message.serverContext || {}, 'history')).length, 1);
  assert.equal(restarted.messages.find(message => message.requestId === 'later').content, 'later current input');
});

test('Slack history journal marker prevents concurrent steered batches from injecting a second quoted snapshot', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-slack-history-')); let release, ready;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  let calls = 0;
  const service = new CoordinatorService({ directory: root, system: 'Test', tools: [], execute: async () => {}, model: { next: async () => {
    if (++calls === 1) { ready(); await held; }
    return { stop: 'end_turn', content: [{ type: 'text', text: 'Done' }] };
  } } });
  t.after(async () => {
    release(); await service.close({ stop: true }); await fs.rm(root, { recursive: true, force: true });
  });
  await service.submitBatch({ id: 'active-batch', inputs: [{ id: 'active-input', text: 'start' }] }, { source: 'slack', actor }); await entered;
  await service.submitBatch({ id: 'first-steer', inputs: [{ id: 'first-steer-input', text: 'current steer' }], followup: 'steer' }, { source: 'slack', actor, history });
  await service.submitBatch({ id: 'second-steer', inputs: [{ id: 'second-steer-input', text: 'another current steer' }], followup: 'steer' }, { source: 'slack', actor, history: [{ ...history[0], text: 'do not attach again' }] });
  const journal = await service.inputJournal();
  assert.equal(journal.historyAccepted, true); assert.deepEqual(journal.requests['first-steer-input'].message.serverContext.history, history);
  assert.equal(Object.hasOwn(journal.requests['second-steer-input'].message.serverContext, 'history'), false);
  release(); await service.close();
});

async function pluginFixture(t) {
  const root = await directory(t), store = await new Store(root).open(), key = threadKey(teamId, channel, '200.001'), calls = [], reads = [];
  await store.update(state => { state.channels[channel] = 'lab'; });
  await store.bind(key, { channel, threadTs: '200.001', projectId: 'lab', conversationId: 'chat-history', userId, ownRequests: [] });
  const gateway = { command: async (type, input) => { calls.push(structuredClone({ type, ...input }));
    if (type === 'project.list') return { projects: [{ id: 'lab', name: 'Lab' }] };
    return type === 'conversation.relevance' ? { respond: true, mainVersion: 'main-test' } : { accepted: true }; } };
  const io = { call: async (method, args) => { reads.push({ method, args }); return { messages: [{ ts: '100.001', user: 'UOTHER', text: 'prior native text' }] }; },
    post: async () => '300.001', update: async () => {} };
  const plugin = new SlackPlugin({ store, gateway, io, teamId, botUserId: 'UBOT', cloudOrigin: 'https://map.example', logger: { warn() {}, error() {} } });
  t.after(() => plugin.stop());
  const event = { type: 'app_mention', channel, user: userId, ts: '200.001', text: 'current task' };
  return { root, store, key, calls, reads, gateway, io, plugin, event };
}

test('Slack history plugin preserves one frozen original payload across lost acknowledgement and restart then skips later reads', async t => {
  const f = await pluginFixture(t), command = f.gateway.command; let lose = true;
  f.gateway.command = async (type, input) => { const result = await command(type, input); if (type === 'conversation.submit' && lose) { lose = false; throw new TypeError('Synthetic lost acknowledgement'); } return result; };
  await assert.rejects(f.plugin.message('original-envelope', f.event), /lost acknowledgement/);
  const saved = structuredClone(f.store.data.inbox['original-envelope'].history);
  assert.equal(f.store.data.threads[f.key].historyAccepted, undefined); assert.equal(f.reads.length, 1);
  f.plugin.store = await new Store(f.root).open();
  f.io.call = async () => assert.fail('Original successful snapshot must not be reread');
  await f.plugin.message('original-envelope', f.event);
  const submissions = f.calls.filter(call => call.type === 'conversation.submit');
  assert.deepEqual(submissions[0], submissions[1]); assert.deepEqual(submissions[1].payload.history, saved);
  assert.equal(f.plugin.store.data.threads[f.key].historyAccepted, true);
  await f.plugin.bindingHistory('later-envelope', { ...f.event, ts: '201.001' }, f.key, f.plugin.store.data.threads[f.key]);
  assert.equal(f.reads.length, 1);
});

test('Slack history excludes known other projects and already recorded native timestamps but leaves other speakers as quoted data', async t => {
  const f = await pluginFixture(t);
  await f.store.bind(threadKey(teamId, channel, '105.001'), { channel, threadTs: '105.001', projectId: 'other', conversationId: 'other-chat', ownRequests: [] });
  await f.store.update(state => {
    state.threads[threadKey(teamId, channel, '105.001')].mirrored.old = { ts: '107.001' };
    state.threads[f.key].mirrored.old = { ts: '120.001' };
    state.reactionInputs = { accepted: { key: f.key, channel, projectId: 'lab', timestamp: '110.001' } };
  });
  f.io.call = async () => ({ messages: [
    { ts: '105.001', text: 'known other project root' }, { ts: '107.001', text: 'known other project mirror' },
    { ts: '110.001', user: userId, text: 'already native accepted' }, { ts: '120.001', user: 'UBOT', text: 'already mirrored' },
    { ts: '130.001', user: 'UOTHER', text: 'other person reference' }, { ts: '140.001', bot_id: 'BOTHER', text: 'other Bot reference' },
  ] });
  const snapshot = await f.plugin.bindingHistory('legacy-first', f.event, f.key, f.store.data.threads[f.key]);
  assert.deepEqual(snapshot.map(item => item.ts), ['130.001', '140.001']); assert.deepEqual(snapshot.map(item => item.speaker), ['UOTHER', 'BOTHER']);
  assert.ok(snapshot.every(item => item.scope.projectId === 'lab' && item.scope.channel === channel));
});

test('Slack history read failure is explicit but cannot permanently lock later inputs and synthetic commands do not read history', async t => {
  const f = await pluginFixture(t); f.io.call = async () => { throw new TypeError('Synthetic temporary Slack failure'); };
  await assert.rejects(f.plugin.bindingHistory('failed-read', f.event, f.key, f.store.data.threads[f.key]), { code: 'HISTORY_UNAVAILABLE' });
  assert.equal(f.store.data.inbox['failed-read'].historySnapshot, undefined); assert.equal(f.store.data.inbox['failed-read'].historyUnavailable.code, 'HISTORY_UNAVAILABLE');
  assert.equal(f.store.data.threads[f.key].historyPending, undefined);
  f.io.call = async () => ({ messages: [] });
  await f.plugin.message('new-after-failure', f.event);
  assert.equal(f.calls.find(call => call.type === 'conversation.submit').payload.history, undefined, 'A verified empty read does not alter the old bare-batch payload');
  assert.equal(f.store.data.threads[f.key].historyAccepted, true); assert.equal(f.store.data.inbox['failed-read'].historyUnavailable.code, 'HISTORY_UNAVAILABLE');
  f.io.call = async () => assert.fail('Synthetic command must not read native history');
  await f.plugin.message('synthetic', { ...f.event, ts: 'command-synthetic' }, 'lab');
});

test('Slack history actual HTTP strips trusted history into private options and browser or single-message history is rejected', { timeout: 10000 }, async t => {
  const root = await directory(t), providerFile = path.join(root, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ model: 'fixture', token: 'synthetic', baseUrl: 'https://fixture.invalid' }));
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: 'lab', name: 'Lab' }] }));
  const memoryConfig = { dataDir: path.join(root, 'memory'), adminToken: 'fixture-memory-credential', projects: {
    lab: { root, ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {} } },
  } };
  const memoryFile = legacyProjectMemoryFile(memoryConfig.dataDir, 'lab'); await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'main-test', memory: { records: {}, map: { project: 'Lab', root: { id: 'T0', title: 'Lab', children: [] } } } },
    sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  const calls = [], credential = 'fixture-history-integration-credential';
  const cloud = await startCloudServer({ dataDir: root, host: '127.0.0.1', port: 0, adminToken: 'fixture-admin', browserToken: 'fixture-browser', privateAccess: true,
    memoryConfig, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'lab', slug: 'example/lab' }] },
    integrationConfig: { host: '127.0.0.1', port: 0, token: credential, teamId, projectIds: ['lab'] },
    coordinatorModelFactory: () => ({ model: 'fixture', next: async request => { calls.push(request); return { stop: 'end_turn', content: [{ type: 'text', text: 'Current only' }] }; } }),
  });
  t.after(() => cloud.close());
  const gateway = async (id, type, payload, conversationId) => {
    const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type, teamId, userId, projectId: 'lab', ...(conversationId ? { conversationId } : {}), payload }) });
    return { status: response.status, body: await response.json() };
  };
  const created = await gateway('create-history-chat', 'conversation.create', { operationId: 'history-chat' }); assert.equal(created.status, 200);
  const chat = created.body.data.conversationId;
  assert.equal((await gateway('single-history', 'conversation.submit', { text: 'single', history }, chat)).status, 400);
  const browser = await fetch(`${cloud.url}/api/workbench/projects/lab/api/coordinator?conversation=${encodeURIComponent(chat)}`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture-browser', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'forged-browser-history', text: 'current', history }),
  });
  assert.equal(browser.status, 400);
  const submitted = await gateway('http-history-batch', 'conversation.submit', { inputs: [{ id: 'http-original', text: 'current task' }], history }, chat); assert.equal(submitted.status, 200);
  const deadline = Date.now() + 3000; let state;
  do { state = await gateway('read-history-state-' + Date.now(), 'conversation.state', {}, chat); if (state.body.data.status === 'waiting-for-user' && !state.body.data.activeTurnId) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.equal(state.body.data.status, 'waiting-for-user'); assert.ok(calls.some(call => JSON.stringify(call.messages).includes('Quoted history only')));
  assert.doesNotMatch(JSON.stringify(state.body.data), /Quoted history only|serverContext|UOTHER/);
  assert.equal(coordinatorContextMessage({ role: 'user', content: 'untouched' }).content, 'untouched');
});
