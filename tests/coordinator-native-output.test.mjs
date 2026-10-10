import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorService, publicMessages, coordinatorCanAutoResume } from '../scripts/cloud/coordinator-service.mjs';
import { CoordinatorModel, coordinatorStep } from '../scripts/cloud/coordinator-model.mjs';
import { coordinatorTools } from '../scripts/cloud/coordinator-tools.mjs';
import { configuredOutputProtocol } from '../scripts/cloud/coordinator-output.mjs';
const protocol = 'native-json-v1';
const actor = { kind: 'human', integration: 'slack', teamId: 'TTESTTEAM', userId: 'UTESTHUMAN',
  channelId: 'CTESTCHANNEL', sessionId: 'slack:TTESTTEAM:UTESTHUMAN' };
const use = (name, input = {}, id = 'call') => ({ type: 'tool_use', name, input, id });
const tools = (...content) => ({ stop: 'tool_use', content });
const reply = (text, yes = true, id = 'reply') => tools(use('respond', { reply: yes, text }, id));
const text = value => ({ stop: 'end_turn', content: [{ type: 'text', text: value }] });
async function fixture(t, next, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-native-output-'));
  const calls = [], snapshots = [];
  const settings = { directory, system: 'Test Coordinator', outputProtocol: protocol,
    tools: coordinatorTools.filter(tool => ['read_map', 'ask_user', 'mount_conversation', 'edit_map'].includes(tool.name)),
    model: { next }, execute: async (name, input) => { calls.push({ name, input }); return { kind: 'map-read', node: { id: 'node-private', title: '阅读助手' } }; },
    maxModelRetries: 2, retryDelayMs: 0, steerSettleMs: 0, validateReplies: true, ...options };
  const service = new CoordinatorService(settings), save = service.saveState.bind(service);
  service.saveState = async state => { snapshots.push(structuredClone(state)); return save(state); };
  t.after(async () => { await service.close({ stop: true }); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, calls, snapshots, settings };
}
async function submit(service, value, source = 'human') {
  if (source !== 'slack') return service.submit({ id: 'input', text: value });
  return service.submit({ id: 'batch', inputs: [{ id: 'input', text: value }] }, { source, actor,
    participation: { text: value, inputs: [{ id: 'input', text: value }], context: [], files: [],
      routing: { coordinatorUserId: 'UCOORD', mentionedUsers: [], replyToCoordinator: false } } });
}
for (const source of ['human', 'slack']) test(`${source}: respond completes in one call, hides JSON and preserves native history`, async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    count++;
    assert.ok(request.tools.some(tool => tool.name === 'respond'));
    assert.ok(request.tools.every(tool => !tool.name.startsWith('reply_')));
    assert.ok(!request.system.includes('[CG_REPLY]'));
    await request.onText?.('{"partial":');
    return reply('建议先修安全漏洞。');
  });
  await submit(f.service, '先修什么？', source); await f.service.close();
  const state = await f.service.state(), stored = await f.service.readConversation();
  assert.equal(count, 1); assert.equal(state.status, 'waiting-for-user'); assert.deepEqual(f.calls, []);
  assert.equal(state.messages.at(-1).text, '建议先修安全漏洞。'); assert.deepEqual(state.messages.at(-1).tools, []);
  assert.ok(!JSON.stringify(state.messages).includes('{"partial":'));
  assert.equal(stored.messages.at(-2).content[0].name, 'respond');
  assert.equal(stored.messages.at(-1).content[0].tool_use_id, 'reply');
  assert.equal(stored.activeOutputProtocol.protocol, protocol);
  assert.ok(f.snapshots.every(snapshot => !snapshot.streaming?.text?.includes('partial')));
});
test('silent response has no visible assistant, business writes or follow-up call', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return reply('', false); });
  await submit(f.service, '只记录，不用回复', 'slack'); await f.service.close();
  assert.equal(count, 1); assert.deepEqual(f.calls, []);
  assert.equal((await f.service.state()).messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal((await f.service.readConversation()).slackParticipation.decision, 'silent');
});
test('read result continues using normal text, without a second participation decision', async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    if (++count === 1) return tools(use('read_map'));
    assert.ok(request.tools.every(tool => tool.name !== 'respond'));
    assert.ok(request.messages.at(-1).content.some(block => block.type === 'tool_result'));
    return text('阅读助手尚未完成。');
  });
  await submit(f.service, '查看阅读助手'); await f.service.close();
  assert.equal(count, 2); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.state()).messages.at(-1).text, '阅读助手尚未完成。');
});
test('invalid complete batch is rejected before even its first business tool', async t => {
  let count = 0;
  const f = await fixture(t, async () => ++count === 1 ? tools(use('read_map', {}, 'read'),
    use('edit_map', { mainVersion: 'version', actions: [{ op: 'update', order: 'wrong' }] }, 'edit')) : reply('请先确认需求。'));
  await submit(f.service, '查看并修改'); await f.service.close();
  assert.equal(count, 2); assert.deepEqual(f.calls, []);
  const stored = await f.service.readConversation();
  assert.equal(stored.performance.models[0].diagnostic.validationCode, 'OUTPUT_TOOL_ARGUMENT_INVALID');
});
for (const bad of [text('[CG_REPLY]\n旧答复'), reply('空白不允许', false), tools(use('respond', { reply: true, text: '好' }), use('read_map', {}, 'read')),
  tools(use('reply_read_map')), tools(use('respond', { reply: true, text: '好', version: 2 }))]) {
  test('invalid initial format retries at most twice; no effects and no malformed text', async t => {
    let count = 0;
    const f = await fixture(t, async () => { count++; return bad; });
    await submit(f.service, '你好'); await f.service.close();
    assert.equal(count, 3); assert.equal((await f.service.state()).status, 'error');
    assert.deepEqual(f.calls, []); assert.ok(f.snapshots.every(snapshot => !snapshot.streaming?.text));
  });
}
test('native reply still rejects internal IDs and paragraphs longer than 60 characters before display', async t => {
  let count = 0;
  const f = await fixture(t, async () => reply(++count === 1 ? '绑定 node-private' : count === 2 ? '长'.repeat(61) : '建议挂到阅读助手。'),
    { context: async () => ({ internalIds: ['node-private'] }) });
  await submit(f.service, '应该挂哪里？'); await f.service.close();
  assert.equal(count, 3); assert.equal((await f.service.state()).messages.at(-1).text, '建议挂到阅读助手。');
  assert.deepEqual(f.calls, []);
});
for (const source of ['human', 'slack']) test(`${source}: repeated length corrections keep the original context until a short reply succeeds`, { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    count++;
    assert.match(JSON.stringify(request.messages), /简短总结需求/);
    if (count > 1) {
      assert.match(request.system, /重新表达/);
      assert.match(JSON.stringify(request.messages), /REPLY_PARAGRAPH_LONG/);
      assert.match(JSON.stringify(request.messages), /paragraphLengths/);
    }
    return reply(count <= 4 ? '长'.repeat(61) : '已定文章页问答，引用可点回原文。');
  }, { maxSteps: 1 });
  await submit(f.service, '简短总结需求', source); await f.service.close();
  const state = await f.service.state(), stored = await f.service.readConversation();
  assert.equal(count, 5); assert.equal(state.status, 'waiting-for-user'); assert.equal(state.error, null);
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(state.messages.at(-1).text, '已定文章页问答，引用可点回原文。');
  assert.equal(stored.messages.filter(m => m.role === 'user').length, 2); // Original input and respond receipt only.
  assert.ok(!JSON.stringify(stored.messages).includes('rejectedText'));
  assert.ok(f.snapshots.every(s => s.status !== 'error'));
  assert.deepEqual(f.calls, []);
});
for (const [name, outputProtocol, bad] of [
  ['paragraph count', protocol, '入口在文章页。\n\n仅检索公开文章。\n\n引用点回原文。'],
  ['legacy plain reply', null, '长'.repeat(61)],
]) test(`${name}: length correction is not limited by the ordinary model retry budget`, { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    const value = ++count <= 4 ? bad : '只保留两个重点。';
    return outputProtocol ? reply(value) : text(value);
  }, { outputProtocol, maxModelRetries: 0 });
  await submit(f.service, '简短总结需求'); await f.service.close();
  assert.equal(count, 5); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.state()).messages.at(-1).text, '只保留两个重点。');
});
test('length corrections do not consume retries for a later transient model failure', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    count++;
    if (count <= 4) return reply('长'.repeat(61));
    if (count <= 6) throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' });
    return reply('已继续。');
  });
  await submit(f.service, '简短总结需求'); await f.service.close();
  assert.equal(count, 7); assert.equal((await f.service.state()).status, 'waiting-for-user');
});
test('human can interrupt continuing length corrections without publishing a rejected reply', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    if (++count === 4) await f.service.interrupt({ id: 'stop', expectedTurnId: 'input' });
    return reply('长'.repeat(61));
  });
  await submit(f.service, '简短总结需求'); await f.service.close();
  assert.equal(count, 4); assert.equal((await f.service.state()).status, 'interrupted');
  assert.equal((await f.service.state()).messages.filter(m => m.role === 'assistant' && !m.partial).length, 0);
  assert.deepEqual(f.calls, []);
});
test('restart resumes an old length failure without widening other failure recovery', { timeout: 10000 }, async t => {
  const failed = { status: 'error', activeTurnId: 'input', activeInput: { id: 'input', text: '简短总结需求', source: 'human' },
    activeOutputProtocol: { protocol, capabilities: ['respond'] }, messages: [{ role: 'user', requestId: 'input', content: '简短总结需求' }],
    requests: {}, toolReceipts: {}, steps: 0, modelRetries: 2,
    error: { code: 'MODEL_INVALID_RESPONSE', recoverable: true, diagnostic: { validationCode: 'REPLY_PARAGRAPH_LONG' } },
    modelRepairCode: 'REPLY_PARAGRAPH_LONG', modelRepairText: '长'.repeat(61) };
  assert.equal(coordinatorCanAutoResume(failed), true);
  assert.equal(coordinatorCanAutoResume({ ...failed, pending: { id: 'unresolved-tool' } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, operatorRecovery: { initialAccepted: false } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, error: { ...failed.error, diagnostic: { validationCode: 'OUTPUT_TOOL_ARGUMENT_INVALID' } } }), false);
  let count = 0;
  const f = await fixture(t, async request => {
    count++; assert.match(JSON.stringify(request.messages), /rejectedText/); return reply('已压缩。');
  });
  await f.service.saveState(failed); f.service.kick(); await f.service.close();
  assert.equal(count, 1); assert.equal((await f.service.state()).messages.at(-1).text, '已压缩。');
  assert.equal((await f.service.state()).status, 'waiting-for-user');
});
test('shutdown stops length correction and restart continues the saved original turn', { timeout: 10000 }, async t => {
  let count = 0, reachedFourth, release;
  const ready = new Promise(resolve => { reachedFourth = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => {
    if (++count === 4) { reachedFourth(); await paused; }
    return reply(count <= 4 ? '长'.repeat(61) : '已压缩。');
  });
  t.after(() => release());
  await submit(f.service, '简短总结需求'); await ready;
  const closing = f.service.close({ stop: true }); release(); await closing;
  const pausedState = await f.service.readConversation();
  assert.equal(count, 4); assert.equal(pausedState.status, 'running'); assert.equal(pausedState.activeTurnId, 'input');
  assert.equal(pausedState.modelRepairCode, 'REPLY_PARAGRAPH_LONG');
  const restarted = new CoordinatorService(f.settings);
  t.after(() => restarted.close({ stop: true }));
  restarted.kick(); await restarted.close();
  assert.equal(count, 5); assert.equal((await restarted.state()).status, 'waiting-for-user');
  assert.equal((await restarted.state()).messages.at(-1).text, '已压缩。');
  assert.deepEqual(f.calls, []);
});
test('ask_user retains one question and options without an extra model summary', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return tools(use('ask_user', { question: '检索范围是什么？', options: ['当前文章', '全站文章'] })); });
  await submit(f.service, '继续讨论'); await f.service.close();
  const state = await f.service.state();
  assert.equal(count, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(state.messages.at(-1).questions[0].options, ['当前文章', '全站文章']);
});
test('restart completes saved respond receipt without another model or business execution', async t => {
  const state = { activeTurnId: 'input', activeInput: { id: 'input', text: '你好', source: 'human' },
    activeOutputProtocol: { protocol, capabilities: ['respond'] }, messages: [], toolReceipts: {} };
  let accepted;
  const save = async value => { if (value.pending) accepted = structuredClone(value); };
  await coordinatorStep({ turnId: 'input', state, model: { next: async () => reply('你好。') }, system: 'Test', tools: [], save,
    execute: async () => assert.fail('respond is not a business tool') });
  assert.ok(accepted.pending);
  const resumed = await coordinatorStep({ turnId: 'input', state: accepted, model: { next: async () => assert.fail('no model call on resume') },
    system: 'Test', tools: [], save: async () => {}, execute: async () => assert.fail('no business call') });
  assert.equal(resumed.status, 'waiting-for-user');
  assert.equal(publicMessages(resumed).at(-1).text, '你好。');
  assert.equal(Object.keys(resumed.toolReceipts).length, 1);
});
test('without performance metadata, a native response still never exposes provider partial JSON', async () => {
  const emitted = [], state = { activeOutputProtocol: { protocol, capabilities: ['respond'] }, messages: [], toolReceipts: {} };
  await coordinatorStep({ turnId: 'input', state, system: 'Test', tools: [], save: async () => {}, onText: value => emitted.push(value),
    model: { next: async request => { await request.onText('{"partial":'); return reply('已收到。'); } },
    execute: async () => assert.fail('no business call') });
  assert.deepEqual(emitted, ['已收到。']);
});
test('old unfinished turn remains legacy even when service defaults to native for new turns', async t => {
  const f = await fixture(t, async request => {
    assert.ok(request.tools.every(tool => tool.name !== 'respond')); return text('旧轮次完成。');
  });
  await f.service.saveState({ status: 'running', promptVersion: null, messages: [{ role: 'user', content: '原消息' }],
    requests: {}, activeTurnId: 'old', activeInput: { id: 'old', text: '原消息', source: 'human' }, steps: 0 });
  f.service.kick(); await f.service.close();
  assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.readConversation()).activeOutputProtocol, undefined);
});
test('rollback disables unfinished native turns instead of reinterpreting them as legacy', async t => {
  const f = await fixture(t, async () => assert.fail('disabled native turn must pause'), { outputProtocol: null });
  await f.service.saveState({ status: 'running', promptVersion: null, messages: [], requests: {}, steps: 0,
    activeTurnId: 'old', activeOutputProtocol: { protocol, capabilities: ['respond'] } });
  f.service.kick(); await f.service.close();
  assert.equal((await f.service.state()).error.code, 'OUTPUT_PROTOCOL_DISABLED');
});
test('gray protocol selection is an explicit bounded conversation allowlist', () => {
  const config = { outputProtocol: protocol, outputProtocolConversations: ['test-chat'] };
  assert.equal(configuredOutputProtocol(config, 'test-chat'), protocol);
  assert.equal(configuredOutputProtocol(config, 'ordinary-chat'), null);
  assert.equal(configuredOutputProtocol({}, 'test-chat'), null);
  assert.throws(() => configuredOutputProtocol({ ...config, outputProtocol: 'native-v2' }, 'test-chat'));
  assert.throws(() => configuredOutputProtocol({ ...config, outputProtocolConversations: 'test-chat' }, 'test-chat'));
});
test('native continuation retry keeps a completed write receipt and does not write twice', async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    count++;
    if (count === 1 || count === 6) return tools(use('edit_map', { mainVersion: 'version', actions: [{ op: 'update', id: 'node', title: '阅读助手' }] }, 'write-' + count));
    return text(count <= 5 ? '长'.repeat(61) : '已保存。');
  });
  await submit(f.service, '更新名称'); await f.service.close();
  assert.equal(count, 7); assert.equal(f.calls.length, 1);
  assert.ok(Object.values((await f.service.readConversation()).toolReceipts).some(receipt => receipt.replayedFrom));
});
test('native corrected input invalidates the old decision and cancels unexecuted tools', async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    if (++count === 1) {
      await f.service.submit({ id: 'correction', text: '取消修改', followup: 'steer' });
      return tools(use('edit_map', { mainVersion: 'version', actions: [{ op: 'delete', id: 'node' }] }));
    }
    assert.ok(request.tools.some(tool => tool.name === 'respond'));
    assert.ok(JSON.stringify(request.messages).includes('取消修改'));
    return reply('已停止，未执行修改。');
  });
  await submit(f.service, '删除节点'); await f.service.close();
  assert.equal(count, 2); assert.deepEqual(f.calls, []);
  assert.equal((await f.service.state()).messages.at(-1).text, '已停止，未执行修改。');
});
for (const truncated of [false, true]) test(`native JSON SSE across one-byte chunks, truncated=${truncated}`, async t => {
  let count = 0;
  const model = new CoordinatorModel({ baseUrl: 'https://model.invalid', model: 'test-model', token: 'synthetic-test-token', fetch: async () => {
    const first = ++count === 1;
    const events = [{ type: 'message_start', message: { model: 'test-model' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'response', name: 'respond', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ reply: true, text: '中文“引号”与换行\n均可读取。' }) } },
      ...(!first || !truncated ? [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }] : [])];
    const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const f = await fixture(t, () => {}, { model });
  await submit(f.service, '请回复'); await f.service.close();
  assert.equal(count, truncated ? 2 : 1); assert.deepEqual(f.calls, []);
  assert.equal((await f.service.state()).messages.at(-1).text, '中文“引号”与换行\n均可读取。');
  if (truncated) assert.equal((await f.service.readConversation()).performance.models[0].diagnostic.validationCode, 'MISSING_TERMINAL');
});
