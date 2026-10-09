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
import { validateMergedParticipation, mergedParticipationMessages, MERGED_PARTICIPATION_POLICY } from '../scripts/cloud/merged-participation.mjs';
import { Gateway } from '../plugins/slack/src/gateway.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { Store } from '../plugins/slack/src/store.mjs';
import { slackStatusEmojis } from '../scripts/cloud/slack-reactions.mjs';

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
      const lastInput = last?.messages?.findLastIndex(message => message.role === 'user' && last.participationRequestIds?.includes(message.requestId)) ?? -1;
      const completed = lastInput >= 0 && !last?.activeTurnId && ['waiting-for-user', 'idle'].includes(last?.status) && !last.pendingInputCount &&
        last.messages.slice(lastInput + 1).some(message => message.role === 'assistant' && !message.partial &&
          (message.text?.trim() || message.questions?.length || message.attachments?.length));
      const desired = last?.status === 'error' ? 'failed' : completed && last.participationDecision === 'reply' ? 'completed' : last?.participationDecision;
      const expectedFeedback = (last?.participationRequestIds || []).map(id => store.data.reactionInputs?.[id]?.inboxId)
        .filter(Boolean).map(id => plugin.store.data.feedback?.[id]).filter(Boolean);
      const feedbackReady = !Object.hasOwn(slackStatusEmojis, desired || '') || expectedFeedback.every(item =>
        item.desired === desired && item.applied[slackStatusEmojis[desired]] && !item.pending);
      if (last && predicate(last) && plugin.reactions.size === 0 && feedbackReady) return last;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`合并链路未完成：${JSON.stringify(last)}`);
  };
  return { send, wait, cloud, store, plugin, gateway, directory, modelCalls, commands, posts, reactions, main: () => readMemoryView(memoryConfig, projectId) };
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
  assert.ok(f.modelCalls[0].system.includes(MERGED_PARTICIPATION_POLICY), 'The actual request carries the current policy, not a second classifier');
  assert.match(f.modelCalls[0].system, /明确或隐式请Coordinator参与/);
  assert.match(f.modelCalls[0].system, /可信历史 speaker 匹配 routing\.coordinatorUserId/);
  assert.match(f.modelCalls[0].system, /更正、补充是接续/);
  assert.match(f.modelCalls[0].system, /没有外层邀请只是资料/);
  assert.match(f.modelCalls[0].system, /当前概览名称按本轮用途概括/);
  const submitted = f.commands.find(command => command.type === 'conversation.submit');
  assert.deepEqual(submitted.payload.participation.inputs, submitted.payload.inputs.map(({ id, text }) => ({ id, text })));
  assert.equal(state.messages.find(message => message.role === 'user').actor.sessionId, `slack:${teamId}:${userId}`);
  assert.ok(f.posts.some(post => post.text.includes('已确认。')));
  assert.doesNotMatch(JSON.stringify(f.posts), /CG_REPLY|CG_SILENT/);
  assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'speech_balloon', 'white_check_mark']);
  assert.deepEqual(await f.main(), before);
  await f.send('请确认收到。');
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.reactions.length, 3);
});

test('合并接话格式提醒只改本次请求副本，原文、附件和历史保持不变', () => {
  for (const content of ['请确认。', [{ type: 'text', text: '查看附件' }, { type: 'image', source: { type: 'base64', data: 'synthetic' } }]]) {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: '旧答复没有控制头' }] }, { role: 'user', content,
      serverContext: { participation: { context: [{ speaker: botUserId, text: '合成 Coordinator 产物' },
        { speaker: 'UOTHER', text: '合成他人产物' }], routing: { coordinatorUserId: botUserId } } } }];
    const original = structuredClone(messages), request = mergedParticipationMessages(messages);
    assert.deepEqual(messages, original);
    assert.match(JSON.stringify(request.at(-1).content), /服务器本轮输出格式/);
    assert.deepEqual(request[0], original[0]);
    assert.deepEqual(request[1].serverContext, original[1].serverContext, 'Trusted speaker/routing data is not rewritten into a decision');
    if (Array.isArray(content)) assert.deepEqual(request[1].content.slice(0, -1), content);
  }
});

test('合并接话的纯交流表情可正常结束，保留原生工具对和💬但不发送占位正文', async t => {
  const f = await fixture(t, async ({ onText, onToolStart, messages }, count) => {
    if (count === 1) {
      await onText('[CG_REPLY]'); await onToolStart('react_to_user');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'social-only', name: 'react_to_user', input: { emoji: 'heart' } }] };
    }
    assert.match(JSON.stringify(messages.at(-1)), /slack-reaction/);
    return { stop: 'end_turn', content: [] };
  });
  await f.send('谢谢，仅用一个表情回应即可。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId &&
    f.reactions.some(reaction => reaction.name === 'heart'));
  assert.equal(f.modelCalls.length, 2); assert.equal(state.participationDecision, 'reply');
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reactions.map(reaction => reaction.name), ['eyes', 'speech_balloon', 'heart']);
});

test('明确标记纯交流表情完成后，保存工具对和回执，不另生成占位正文', async t => {
  const f = await fixture(t, async ({ onText, onToolStart }, count) => {
    assert.equal(count, 1, '明确完整纯交流回应不另生成占位答复');
    await onText('[CG_REPLY]'); await onToolStart('react_to_user');
    return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
      { type: 'tool_use', id: 'social-complete', name: 'react_to_user', input: { emoji: 'wave', replyComplete: true } }] };
  });
  await f.send('只用原生挥手表情打个招呼，不需要正文。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.reactions.some(item => item.name === 'wave'));
  assert.equal(state.participationDecision, 'reply'); assert.equal(f.modelCalls.length, 1); assert.deepEqual(f.posts, []);
  const binding = Object.values(f.store.data.threads)[0];
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'coordinators', projectId, 'chats', binding.conversationId, 'conversation.json'), 'utf8'));
  assert.equal(saved.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(Object.values(saved.toolReceipts).filter(item => item.result?.kind === 'slack-reaction').length, 1);
});

test('读业务工具之后的空结束仍失败，不能用交流表情冒充完整答复', async t => {
  const f = await fixture(t, async ({ onText, onToolStart, system }, count) => {
    if (count === 1) {
      await onText('[CG_REPLY]'); await onToolStart('read_map');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'required-read', name: 'read_map', input: { nodeId: 'T0' } }] };
    }
    if (count === 2) return { stop: 'tool_use', content: [
      { type: 'tool_use', id: 'not-complete', name: 'react_to_user', input: { emoji: 'bulb', replyComplete: true } }] };
    return { stop: 'end_turn', content: [] };
  });
  await f.send('读取测试模块并说明它是什么。');
  const state = await f.wait(state => state.status === 'error' &&
    f.reactions.some(reaction => reaction.name === 'warning'));
  assert.equal(state.error.code, 'MODEL_INVALID_RESPONSE');
});

test('慢模型尚未给出任何标识时已出现👀，确认后才切换状态并发送正文', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async ({ onText }) => {
    await held; await onText('[CG_REPLY]\n已收到你的问题。'); return result('[CG_REPLY]\n已收到你的问题。');
  });
  await f.send('请分析当前问题。');
  const pending = await f.wait(state => state.status === 'running' && state.participationDecision === 'pending' &&
    f.modelCalls.length === 1 && f.reactions.some(reaction => reaction.name === 'eyes'));
  assert.equal(pending.streamingText, ''); assert.deepEqual(f.posts, []);
  const feedback = Object.values(f.store.data.feedback)[0];
  assert.ok(feedback.firstAttemptAt - feedback.savedAt < 1000);
  assert.equal(feedback.desired, 'received'); release();
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.length > 0);
  assert.deepEqual(f.reactions.map(reaction => reaction.name), ['eyes', 'speech_balloon', 'white_check_mark']);
});

test('接话后真实读工具及交流表情与正文并存，多次模型调用不重置状态', async t => {
  const f = await fixture(t, async ({ onText, onToolStart, system, messages }, count) => {
    assert.match(system, /Slack 交流方式/);
    if (count === 1) {
      await onText('[CG_REPLY]'); await onToolStart('read_map');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'read-first', name: 'read_map', input: { nodeId: 'T0' } }] };
    }
    if (count === 2) {
      assert.match(JSON.stringify(messages.at(-1)), /测试模块/);
      return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'express-idea', name: 'react_to_user', input: { emoji: 'bulb' } }] };
    }
    assert.match(JSON.stringify(messages.at(-1)), /slack-reaction/);
    return result('💡 测试模块只用于隔离验收。');
  });
  await f.send('只读介绍模块，并给出一个想法。');
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('💡')) &&
    f.reactions.some(reaction => reaction.name === 'bulb'));
  assert.equal(f.modelCalls.length, 3);
  assert.deepEqual(f.reactions.map(reaction => reaction.name), ['eyes', 'speech_balloon', 'bulb', 'white_check_mark']);
  assert.equal(Object.values(f.store.data.feedback)[0].revision, 2);
  assert.equal(f.commands.some(command => command.type === 'conversation.relevance'), false);
});

test('单条原消息至多两个交流表情，工具回执明确拒绝超额而不丢必要正文', async t => {
  const f = await fixture(t, async ({ onText, messages }, count) => {
    if (count === 1) {
      await onText('[CG_REPLY]');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        ...['thumbsup', 'heart', 'fire'].map(emoji => ({ type: 'tool_use', id: `emoji-${emoji}`, name: 'react_to_user', input: { emoji } }))] };
    }
    assert.match(JSON.stringify(messages.at(-1)), /INVALID_ARGUMENT/);
    return result('感谢反馈，仍需核对实际结果。');
  });
  await f.send('确认理解，并说明下一步。');
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('核对')) &&
    f.reactions.some(reaction => reaction.name === 'heart'));
  assert.deepEqual(f.reactions.map(reaction => reaction.name), ['eyes', 'speech_balloon', 'thumbsup', 'heart', 'white_check_mark']);
  assert.equal(f.modelCalls.length, 2);
});

test('消息接收即发送👀，控制头确认后切换💬，不等待完整正文；重启不重复发送', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async ({ onText }) => {
    await onText('[CG_REPLY]\n'); await held;
    await onText('[CG_REPLY]\n在的。'); return result('[CG_REPLY]\n在的。');
  });
  await f.send(`<@${botUserId}> 在吗`);
  const pending = await f.wait(state => state.status === 'running' && state.participationDecision === 'reply' && f.reactions.length === 2);
  assert.equal(pending.streamingText, ''); assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'speech_balloon']);
  release(); await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  f.plugin.store = await new Store(path.join(f.directory, 'slack')).open();
  for (const key of Object.keys(f.plugin.store.data.threads)) { await f.plugin.mirror(key); await f.plugin.mirror(key); }
  assert.equal(f.reactions.length, 3);
  assert.equal(Object.values(f.plugin.store.data.feedback).filter(item => item.applied.white_check_mark && !item.applied.speech_balloon && !item.applied.eyes).length, 1);
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
  assert.equal(failed.error.code, 'MODEL_INVALID_RESPONSE'); assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'warning']);
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
  assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'warning', 'eyes', 'speech_balloon', 'white_check_mark']);
  assert.deepEqual(await f.main(), before);
});

test('Slack 合并静默：保存原输入，👀切换🙈，无正文或业务工具，Main 不变', async t => {
  const f = await fixture(t, async ({ onText }) => { await onText?.('[CG_SILENT]'); return result('[CG_SILENT]'); });
  const before = await f.main();
  await f.send('仅通知进度，不用回复。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId);
  assert.equal(state.participationDecision, 'silent'); assert.equal(f.modelCalls.length, 1);
  assert.equal(state.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
  assert.deepEqual(f.posts, []); assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'see_no_evil']); assert.deepEqual(state.approvals, []);
  assert.deepEqual(await f.main(), before);
});

test('失败后的显式恢复提高控制代次，旧失败快照不能覆盖恢复后已送达的✅', async t => {
  const f = await fixture(t, async ({ onText }, count) => {
    const text = count === 1 ? '没有控制头' : '[CG_REPLY]\n恢复成功。'; await onText(text); return result(text);
  });
  await f.send('请确认。'); const failed = await f.wait(state => state.status === 'error');
  const binding = Object.values(f.store.data.threads)[0];
  await f.plugin.resumeChat('original-identity-retry', { channel_id: 'CTEST', text: `resume ${binding.conversationId}` }, userId);
  const restored = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('恢复成功')));
  assert.ok(restored.controlRevision > failed.controlRevision);
  const before = f.reactions.length;
  for (const key of Object.keys(f.store.data.threads)) await f.plugin.queueReadReactions(key, failed);
  await Promise.all([...f.plugin.reactions]);
  assert.equal(f.reactions.length, before); assert.equal(Object.values(f.store.data.feedback)[0].desired, 'completed');
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

test('Slack 合并纯表情：读取原生回执后空续轮结束，无占位正文或空历史，重启仍精确一次', async t => {
  const f = await fixture(t, async ({ onText, onToolStart, messages }, calls) => {
    if (calls === 1) {
      await onText?.('[CG_REPLY]'); await onToolStart?.('react_to_user');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'social-heart', name: 'react_to_user', input: { emoji: 'heart' } }] };
    }
    if (calls === 2) {
      const receipt = JSON.parse(messages.at(-1).content[0].content);
      assert.equal(receipt.status, 'intent'); assert.equal(receipt.kind, 'slack-reaction');
      assert.doesNotMatch(JSON.stringify(receipt), /delivered|approved|passed/);
      return { stop: 'end_turn', content: [] };
    }
    assert.equal(messages.some(message => message.role === 'assistant' && message.content.length === 0), false);
    return result('[CG_REPLY]\n新的问题已收到。');
  });
  const before = await f.main();
  await f.send('只用表情回应，不需要解释。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId &&
    Object.values(f.plugin.store.data.reactionOutbox || {}).some(item => item.emoji === 'heart' && item.status === 'sent'));
  assert.equal(f.modelCalls.length, 2); assert.equal(state.participationDecision, 'reply');
  assert.equal(f.commands.some(command => command.type === 'conversation.relevance'), false);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reactions.filter(reaction => reaction.name === 'heart'), [{ channel: 'CTEST', timestamp: '100.001', name: 'heart' }]);
  const binding = Object.values(f.store.data.threads)[0];
  const file = path.join(f.directory, 'coordinators', projectId, 'chats', binding.conversationId, 'conversation.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')), assistant = raw.messages.find(message => message.role === 'assistant');
  assert.equal(raw.messages.length, 3); assert.equal(assistant.requestId, raw.activeInput.id);
  assert.equal(assistant.actor.userId, userId); assert.equal(raw.messages.at(-1).content[0].tool_use_id, 'social-heart');
  assert.equal(Object.values(raw.toolReceipts)[0].result.status, 'intent');
  assert.doesNotMatch(JSON.stringify(raw.messages), /CG_REPLY|CG_SILENT/);
  f.plugin.store = await new Store(path.join(f.directory, 'slack')).open();
  for (const key of Object.keys(f.plugin.store.data.threads)) { await f.plugin.mirror(key); await f.plugin.mirror(key); }
  await Promise.allSettled([...f.plugin.reactions]); await f.plugin.store.tail;
  assert.equal(f.reactions.filter(reaction => reaction.name === 'heart').length, 1); assert.deepEqual(f.posts, []);
  await f.send('现在请简短回复。', '100.002', { thread_ts: '100.001' });
  await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId && f.posts.some(post => post.text.includes('新的问题已收到')));
  assert.equal(f.modelCalls.length, 3);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.toolReceipts, raw.toolReceipts); assert.deepEqual(await f.main(), before);
});

test('Slack 合并纯表情：模型已结束不等于原生投递确认，失回保留 unknown 后精确恢复', async t => {
  const f = await fixture(t, async ({ onText, onToolStart }, calls) => {
    if (calls === 1) {
      await onText?.('[CG_REPLY]'); await onToolStart?.('react_to_user');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' },
        { type: 'tool_use', id: 'social-wave', name: 'react_to_user', input: { emoji: 'wave' } }] };
    }
    return { stop: 'end_turn', content: [] };
  });
  const before = await f.main(), native = f.plugin.io.call; let attempts = 0;
  f.plugin.io.call = async (method, input) => {
    if (method === 'reactions.add' && input.name === 'wave' && ++attempts === 1) throw new Error('synthetic lost acknowledgement');
    return native(method, input);
  };
  await f.send('仅用表情确认收到。');
  const state = await f.wait(state => state.status === 'waiting-for-user' && !state.activeTurnId &&
    Object.values(f.plugin.store.data.reactionOutbox || {}).some(item => item.emoji === 'wave' && item.status === 'unknown'));
  assert.equal(f.modelCalls.length, 2); assert.deepEqual(f.posts, []); assert.equal(attempts, 1);
  assert.equal(state.messages.find(message => message.actions?.some(action => action.emoji === 'wave')).actions[0].status, 'intent');
  f.plugin.store = await new Store(path.join(f.directory, 'slack')).open();
  await f.plugin.store.update(data => { for (const record of Object.values(data.reactionOutbox)) if (record.emoji === 'wave') record.next = 0; });
  for (const key of Object.keys(f.plugin.store.data.threads)) await f.plugin.mirror(key);
  await Promise.allSettled([...f.plugin.reactions]); await f.plugin.store.tail;
  const record = Object.values(f.plugin.store.data.reactionOutbox).find(item => item.emoji === 'wave');
  assert.equal(record.status, 'sent'); assert.equal(record.timestamp, '100.001'); assert.equal(record.userId, userId);
  assert.equal(attempts, 2); assert.deepEqual(f.reactions.filter(item => item.name === 'wave'), [{ channel: 'CTEST', timestamp: '100.001', name: 'wave' }]);
  for (const key of Object.keys(f.plugin.store.data.threads)) await f.plugin.mirror(key);
  await Promise.allSettled([...f.plugin.reactions]); assert.equal(attempts, 2);
  assert.equal(f.modelCalls.length, 2); assert.deepEqual(f.posts, []); assert.deepEqual(await f.main(), before);
});

test('Slack 未决定接话便返回工具：失败关闭，显示真实错误而不是🙈', async t => {
  const f = await fixture(t, async ({ onToolStart }) => {
    await onToolStart?.('read_map');
    return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'missing-decision', name: 'read_map', input: {} }] };
  });
  const before = await f.main();
  await f.send('仅存档，不要回复。');
  const state = await f.wait(state => state.status === 'error');
  assert.equal(state.error.code, 'MODEL_INVALID_RESPONSE'); assert.equal(state.participationDecision, 'pending');
  assert.ok(f.posts.some(post => /处理失败/.test(post.text)));
  assert.deepEqual(f.reactions.map(item => item.name), ['eyes', 'warning']); assert.deepEqual(await f.main(), before);
});

test('Slack 原生接话工具通过 HTTP 查询 Main，业务参数与原生历史保持原样', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ tools, onToolStart }) => {
    if (++calls === 1) {
      assert.ok(tools.some(tool => tool.name === 'reply_read_map'));
      await onToolStart?.('reply_read_map');
      return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'native-declared-read', name: 'reply_read_map', input: { nodeId: 'T0' } }] };
    }
    assert.ok(tools.some(tool => tool.name === 'read_map'));
    return result('已读取项目。');
  });
  const before = await f.main(); await f.send('请查询项目资料。');
  const state = await f.wait(value => value.status === 'waiting-for-user' && !value.activeTurnId && f.posts.some(post => post.text.includes('已读取项目。')));
  assert.equal(state.participationDecision, 'reply'); assert.equal(f.modelCalls.length, 2);
  assert.equal(f.commands.some(command => command.type === 'conversation.relevance'), false);
  assert.deepEqual(await f.main(), before);
  assert.doesNotMatch(JSON.stringify(f.posts), /reply_read_map|CG_REPLY|CG_SILENT/);
  const second = f.modelCalls[1].messages;
  assert.equal(second.find(message => message.role === 'assistant').content[0].name, 'reply_read_map');
  const receipt = second.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
  assert.equal(JSON.parse(receipt.content[0].content).kind, 'map-read');
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
