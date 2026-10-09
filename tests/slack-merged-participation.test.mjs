import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { readMemoryView } from '../scripts/cloud/memory.mjs';
import { validateIntegrationCommand } from '../scripts/cloud/integration-gateway.mjs';
import { validateMergedParticipation, mergedParticipationMessages } from '../scripts/cloud/merged-participation.mjs';
import { Gateway } from '../plugins/slack/src/gateway.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { Store } from '../plugins/slack/src/store.mjs';

// 真实插件、HTTP 网关、持久化和工具；模型及 Slack 平台 IO 为替身。
// 不使用生产数据、账号或凭据，不把此测试称为真实 Slack 验收。
const teamId = 'TTESTTEAM', userId = 'UTESTUSER', projectId = 'fixture-project';
const token = 'synthetic-merged-integration-token';
const botUserId = 'UCOORD';
const participation = (id, text) => ({ text, inputs: [{ id, text }], files: [], context: [],
  routing: { coordinatorUserId: botUserId, mentionedUsers: [], replyToCoordinator: false } });
const result = text => ({ stop: 'end_turn', content: [{ type: 'text', text }] });

async function fixture(t, next) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-slack-merged-'));
  const providerFile = path.join(directory, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ token: 'synthetic', baseUrl: 'https://fixture.invalid', model: 'fixture-model' }));
  await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2,
    projects: [{ id: projectId, name: '测试项目', description: '隔离验收' }] }));
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic-admin',
    projects: { [projectId]: { root: directory, ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {} } } } };
  const file = legacyProjectMemoryFile(memoryConfig.dataDir, projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ revision: 1, main: { version: 'fixture-main', memory: { records: {}, map: {
    project: '测试项目', root: { id: 'T0', title: '测试模块', kind: 'module', state: 'dirty', owns: ['src/'],
      memoryDocument: '已确认：测试模块只用于隔离验收。', children: [], todos: [], bugs: [] },
  } } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  const modelCalls = [], commands = [], posts = [], reactions = [];
  const cloud = await startCloudServer({ dataDir: directory, host: '127.0.0.1', port: 0, privateAccess: true,
    browserToken: 'synthetic-browser', adminToken: 'synthetic-server', memoryConfig,
    protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/fixture' }] },
    integrationConfig: { host: '127.0.0.1', port: 0, token, teamId, projectIds: [projectId] },
    coordinatorModelFactory: () => ({ model: 'fixture-model', next: async request => {
      modelCalls.push(request); return next(request, modelCalls.length);
    } }),
  });
  const store = await new Store(path.join(directory, 'slack')).open();
  await store.update(state => { state.channels.CTEST = projectId; state.preferences[userId] = projectId; });
  const gateway = new Gateway({ url: cloud.integrationUrl, token, teamId });
  const command = gateway.command.bind(gateway);
  gateway.command = async (type, args) => { commands.push({ type, ...structuredClone(args) }); return command(type, args); };
  const plugin = new SlackPlugin({ store, gateway, teamId, botUserId, cloudOrigin: cloud.url, collectMs: 0, maxCollectMs: 0,
    logger: { warn() {}, error() {} }, io: {
      post: async input => { posts.push(input); return `${1000 + posts.length}.001`; },
      update: async (_channel, _ts, text, blocks) => { posts.push({ text, blocks, updated: true }); },
      call: async (method, input) => {
        if (method === 'reactions.add') { reactions.push(input); return {}; }
        if (method === 'users.info') return { user: { id: input.user, is_bot: false } };
        if (method === 'conversations.info') return { channel: { id: input.channel, user: userId } };
        return { messages: [] };
      },
    } });
  t.after(async () => { await plugin.stop(); await cloud.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const send = (text, ts = '100.001', extra = {}) => plugin.receive({ type: 'events_api', body: { team_id: teamId,
    event: { type: 'message', channel: 'CTEST', user: userId, ts, text, ...extra } }, ack: async () => {} });
  const wait = async predicate => {
    plugin.stopped = false;
    const deadline = Date.now() + 5000;
    let last;
    while (Date.now() < deadline) {
      await plugin.tick();
      const binding = Object.values(store.data.threads)[0];
      if (binding) last = await command('conversation.state', { id: `state-${Date.now()}`, userId, projectId, conversationId: binding.conversationId });
      if (last && predicate(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`合并链路未完成：${JSON.stringify(last)}`);
  };
  return { send, wait, cloud, store, plugin, directory, modelCalls, commands, posts, reactions, main: () => readMemoryView(memoryConfig, projectId) };
}

test('Slack 合并简单答复：一次主模型调用，原身份不变，控制头不外发，重复事件不再调用', async t => {
  const f = await fixture(t, async ({ onText }) => {
    for (const text of ['[CG_', '[CG_REPLY]', '[CG_REPLY]\n已确认。']) await onText?.(text);
    return result('[CG_REPLY]\n已确认。');
  });
  const before = await f.main();
  await f.send('请确认收到。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('已确认。')));
  assert.equal(state.participationDecision, 'reply');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.commands.some(command => command.type === 'conversation.relevance'), false);
  assert.equal(f.modelCalls[0].tools.length > 0, true);
  assert.match(f.modelCalls[0].system, /Slack 合并接话协议/);
  const submitted = f.commands.find(command => command.type === 'conversation.submit');
  assert.deepEqual(submitted.payload.participation.inputs, submitted.payload.inputs.map(({ id, text }) => ({ id, text })));
  assert.equal(state.messages.find(message => message.role === 'user').actor.sessionId, `slack:${teamId}:${userId}`);
  assert.ok(f.posts.some(post => post.text.includes('已确认。')));
  assert.doesNotMatch(JSON.stringify(f.posts), /CG_REPLY|CG_SILENT/);
  assert.deepEqual(f.reactions, [{ channel: 'CTEST', timestamp: '100.001', name: 'eyes' }]);
  assert.deepEqual(await f.main(), before);
  await f.send('请确认收到。');
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.reactions.length, 1);
});

test('合并接话格式提醒只改本次请求副本，原文、附件和历史保持不变', () => {
  for (const content of ['请确认。', [{ type: 'text', text: '查看附件' }, { type: 'image', source: { type: 'base64', data: 'synthetic' } }]]) {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: '旧答复没有控制头' }] }, { role: 'user', content }];
    const original = structuredClone(messages), request = mergedParticipationMessages(messages);
    assert.deepEqual(messages, original);
    assert.match(JSON.stringify(request.at(-1).content), /服务器本轮输出格式/);
    assert.deepEqual(request[0], original[0]);
    if (Array.isArray(content)) assert.deepEqual(request[1].content.slice(0, -1), content);
  }
});

test('接话控制头一确认就发送原消息👀，不等待完整正文；重启及重复镜像不重复发送', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async ({ onText }) => {
    await onText('[CG_REPLY]\n'); await held;
    await onText('[CG_REPLY]\n在的。'); return result('[CG_REPLY]\n在的。');
  });
  await f.send(`<@${botUserId}> 在吗`);
  const pending = await f.wait(state => state.status === 'running' && state.participationDecision === 'reply' && f.reactions.length === 1);
  assert.equal(pending.streamingText, ''); assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reactions, [{ channel: 'CTEST', timestamp: '100.001', name: 'eyes' }]);
  release(); await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  f.plugin.store = await new Store(path.join(f.directory, 'slack')).open();
  for (const key of Object.keys(f.plugin.store.data.threads)) { await f.plugin.mirror(key); await f.plugin.mirror(key); }
  assert.equal(f.reactions.length, 1);
  assert.equal(Object.values(f.plugin.store.data.reactionOutbox).filter(item => item.emoji === 'eyes' && item.status === 'sent').length, 1);
});

test('无控制头的失败轮次不锁死线程，新消息接续且保留原失败、输入指纹和回执', async t => {
  const f = await fixture(t, async ({ onText, messages }, count) => {
    assert.match(JSON.stringify(messages.at(-1)), /服务器本轮输出格式/);
    if (count === 1) { await onText('无控制头的正文'); return result('无控制头的正文'); }
    await onText('[CG_REPLY]\n在的。'); return result('[CG_REPLY]\n在的。');
  });
  const before = await f.main();
  await f.send('测试');
  const failed = await f.wait(state => state.status === 'error');
  assert.equal(failed.error.code, 'MODEL_INVALID_RESPONSE'); assert.deepEqual(f.reactions, []);
  const binding = Object.values(f.store.data.threads)[0];
  const file = path.join(f.directory, 'coordinators', projectId, 'chats', binding.conversationId, 'conversation.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  await f.send(`<@${botUserId}> 在吗`, '100.002', { thread_ts: '100.001' });
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && state.messages.some(message => message.text === '在的。'));
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.failedTurns[0].turnId, failed.activeTurnId);
  assert.equal(saved.failedTurns[0].code, 'MODEL_INVALID_RESPONSE');
  assert.deepEqual(saved.requests[failed.activeTurnId], original.requests[failed.activeTurnId]);
  assert.deepEqual(saved.toolReceipts, original.toolReceipts);
  assert.equal(f.modelCalls.length, 2);
  assert.equal(Object.values(f.store.data.inbox).every(entry => entry.status === 'done'), true);
  assert.deepEqual(f.reactions, [{ channel: 'CTEST', timestamp: '100.002', name: 'eyes' }]);
  assert.deepEqual(await f.main(), before);
});

test('Slack 合并静默：保存原输入，一次主模型调用，无外发、无业务工具、Main 不变', async t => {
  const f = await fixture(t, async ({ onText }) => { await onText?.('[CG_SILENT]'); return result('[CG_SILENT]'); });
  const before = await f.main();
  await f.send('仅通知进度，不用回复。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  assert.equal(state.participationDecision, 'silent'); assert.equal(f.modelCalls.length, 1);
  assert.equal(state.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
  assert.deepEqual(f.posts, []); assert.deepEqual(f.reactions, []); assert.deepEqual(state.approvals, []);
  assert.deepEqual(await f.main(), before);
});

test('Slack 合并工具答复：同轮决定后调用真实 read_map，续轮不重复决策', async t => {
  const f = await fixture(t, async ({ onText, onToolStart, system, messages }, calls) => {
    if (calls === 1) {
      // 原生工具块紧接完整标识时，模型可能不输出尾部换行。
      await onText?.('[CG_REPLY]'); await onToolStart?.('read_map');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'fixture-read', name: 'read_map', input: { nodeId: 'T0' } }] };
    }
    assert.doesNotMatch(system, /Slack 合并接话协议/);
    assert.match(JSON.stringify(messages.at(-1)), /测试模块/);
    return result('测试模块只用于隔离验收。');
  });
  const before = await f.main();
  await f.send('请只读介绍测试模块。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('只用于隔离验收')));
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.commands.some(command => command.type === 'conversation.relevance'), false);
  assert.ok(state.messages.some(message => message.actions?.some(action => action.kind === 'node-read')));
  assert.ok(f.posts.some(post => post.text.includes('只用于隔离验收')));
  assert.doesNotMatch(JSON.stringify(f.posts), /CG_REPLY|CG_SILENT/);
  assert.deepEqual(await f.main(), before);
});

test('Slack 未决定接话便返回工具：失败关闭，不把模型失败通知发到原线程', async t => {
  const f = await fixture(t, async ({ onToolStart }) => {
    await onToolStart?.('read_map');
    assert.fail('工具起始必须被拒绝');
  });
  const before = await f.main();
  await f.send('仅存档，不要回复。');
  const state = await f.wait(state => state.status === 'error');
  assert.equal(state.error.code, 'MODEL_INVALID_RESPONSE'); assert.equal(state.participationDecision, 'pending');
  assert.deepEqual(f.posts, []); assert.deepEqual(f.reactions, []); assert.deepEqual(await f.main(), before);
});

test('合并接话参考校验：拒绝空项、错序、改文、重试夹带及伪造身份', () => {
  const config = { teamId, projectIds: [projectId], actions: ['conversation.submit'] };
  const input = { id: 'batch', teamId, userId, projectId, conversationId: 'fixture-chat', type: 'conversation.submit',
    payload: { inputs: [{ id: 'original', text: '请确认。' }], participation: participation('original', '请确认。') } };
  assert.equal(validateIntegrationCommand(config, input).actor.userId, userId);
  for (const payload of [
    { ...input.payload, inputs: [null] },
    { ...input.payload, inputs: [{ id: 'different', text: '请确认。' }] },
    { ...input.payload, inputs: [{ id: 'original', text: '修改。' }] },
    { ...input.payload, retry: true },
    { ...input.payload, actor: { kind: 'human' } },
  ]) assert.throws(() => validateIntegrationCommand(config, { ...input, payload }), error => error.code === 'INVALID_ARGUMENT');
});

test('服务层接话参考拒绝非法 Slack 身份格式，不得回落到未受保护的模型路径', () => {
  const inputs = [{ id: 'original', text: '请确认。' }], snapshot = participation('original', '请确认。');
  for (const [badTeam, badUser] of [['bad-team', userId], [teamId, 'bad-user'], [undefined, undefined]]) {
    const actor = { kind: 'human', integration: 'slack', teamId: badTeam, userId: badUser,
      sessionId: `slack:${badTeam}:${badUser}` };
    assert.throws(() => validateMergedParticipation(snapshot, inputs, { source: 'slack', actor }), error => error.code === 'INVALID_INPUT');
  }
});
