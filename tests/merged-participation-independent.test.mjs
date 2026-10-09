import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { CoordinatorModel } from '../scripts/cloud/coordinator-model.mjs';

// Independent acceptance uses the real durable service and a controlled model.
// No external model, Slack transport, production data or credentials are used.
const actor = { kind: 'human', integration: 'slack', teamId: 'TTESTTEAM', userId: 'UTESTHUMAN',
  channelId: 'DTESTDIRECT', sessionId: 'slack:TTESTTEAM:UTESTHUMAN' };
const participation = text => ({ text, inputs: [{ id: 'original', text }], context: [], files: [],
  routing: { coordinatorUserId: 'UCOORD', mentionedUsers: [], replyToCoordinator: false } });
const answer = text => ({ stop: 'end_turn', content: [{ type: 'text', text }] });
const tool = id => ({ type: 'tool_use', id, name: 'write', input: { id } });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

async function fixture(t, next, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-merged-independent-'));
  const writes = [], snapshots = [];
  const service = new CoordinatorService({ directory, system: 'Independent acceptance Coordinator', tools: [{ name: 'write' }],
    model: { next }, execute: async (_name, input) => { writes.push(input); return { saved: true }; },
    steerSettleMs: 0, maxModelRetries: 0, ...options });
  const save = service.saveState.bind(service);
  service.saveState = async state => { snapshots.push(structuredClone(state)); return save(state); };
  t.after(async () => { await service.close({ stop: true }); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, writes, snapshots };
}
async function submit(service, text, options = {}) {
  return service.submit({ id: 'batch', inputs: [{ id: 'original', text }], ...options },
    { source: 'slack', actor, participation: participation(text) });
}
const streamed = snapshots => snapshots.map(state => state.streaming?.text || '').filter(Boolean);

test('格式错误自动恢复两次内成功，原始输入不变且坏正文不展示', async t => {
  let calls = 0;
  const f = await fixture(t, async request => {
    calls++;
    assert.ok(JSON.stringify(request.messages).includes('你好'));
    if (calls === 1) return answer('缺少接话声明');
    if (calls === 2) return answer('[CG_REPLY]\n' + '长'.repeat(61));
    return answer('[CG_REPLY]\n你好，想讨论什么？');
  }, { maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '你好'); await f.service.close();
  const state = await f.service.state(), privateState = await f.service.readConversation();
  assert.equal(calls, 3); assert.equal(state.status, 'waiting-for-user');
  assert.equal(state.messages.filter(message => message.role === 'assistant').at(-1).text, '你好，想讨论什么？');
  assert.ok(streamed(f.snapshots).every(text => !text.includes('缺少接话声明') && !text.includes('长')));
  assert.deepEqual(privateState.performance.models.filter(item => item.errorCode).map(item => item.diagnostic.validationCode),
    ['PARTICIPATION_HEADER_INVALID', 'REPLY_PARAGRAPH_LONG']);
});
test('连续格式失败只尝试三次，不执行工具或声称成功', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return answer('未声明接话'); }, { maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '请处理'); await f.service.close();
  const state = await f.service.state();
  assert.equal(calls, 3); assert.equal(state.status, 'error'); assert.deepEqual(f.writes, []);
  assert.deepEqual(streamed(f.snapshots), []);
});
test('一次提出两个问题时整份工具响应被拒绝，纠正后只保存一个问题', async t => {
  let calls = 0, executed = 0;
  const f = await fixture(t, async () => {
    calls++;
    const content = (calls === 1 ? ['形态？', '范围？'] : ['回答范围是什么？']).map((question, index) =>
      ({ type: 'tool_use', id: 'question-' + index, name: 'reply_ask_user', input: { question, options: ['当前文章', '全站文章'] } }));
    return { stop: 'tool_use', content };
  }, { tools: [{ name: 'ask_user' }], execute: async () => { executed++; return { saved: true }; },
    maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '继续讨论'); await f.service.close();
  const state = await f.service.state();
  assert.equal(calls, 2); assert.equal(executed, 1);
  assert.equal(state.messages.flatMap(message => message.questions || []).length, 1);
});
test('普通问候不能只用表情，纠正后继续文字而不执行原表情', async t => {
  let calls = 0, executed = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { stop: 'tool_use', content: [
    { type: 'tool_use', id: 'reaction', name: 'reply_react_to_user', input: { emoji: 'wave', replyComplete: true } },
  ] } : answer('[CG_REPLY]\n你好，想讨论什么？'), { tools: [{ name: 'react_to_user' }],
    execute: async () => { executed++; return {}; }, maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '你好'); await f.service.close();
  assert.equal(calls, 2); assert.equal(executed, 0); assert.equal((await f.service.state()).status, 'waiting-for-user');
});
test('本轮已执行写入的回执在后续回复重试中保留，不重复写入', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { stop: 'tool_use', content: [
    { type: 'tool_use', id: 'one-write', name: 'reply_write', input: { id: 'value' } },
  ] } : calls === 2 ? answer('长'.repeat(61)) : answer('已保存。'),
  { maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '请保存'); await f.service.close();
  assert.equal(calls, 3); assert.equal(f.writes.length, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
});

test('回复重试生成新的工具ID也复用同轮相同写入回执', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1 || calls === 3) return { stop: 'tool_use', content: [
      { type: 'tool_use', id: 'write-' + calls, name: calls === 1 ? 'reply_write' : 'write', input: calls === 1
        ? { id: 'one-value', details: { first: 1, second: 2 } } : { details: { second: 2, first: 1 }, id: 'one-value' } },
    ] };
    return answer(calls === 2 ? '长'.repeat(61) : '已保存。');
  }, { maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '请保存'); await f.service.close();
  assert.equal(f.writes.length, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
  const state = await f.service.readConversation();
  assert.ok(Object.values(state.toolReceipts).some(item => item.replayedFrom));
});

test('选项标签的内部编号在展示和工具执行前被拒绝', async t => {
  let calls = 0, saved = 0;
  const f = await fixture(t, async () => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'choice-' + ++calls,
    name: 'reply_ask_user', input: { question: '挂载到哪里？', options: [calls === 1 ? '```text\nNCM1234567890\n```' : '阅读助手', '暂不绑定'] } }] }),
  { tools: [{ name: 'ask_user' }], context: async () => ({ internalIds: ['NCM1234567890'] }), validateReplies: true,
    maxModelRetries: 2, retryDelayMs: 0, execute: async () => { saved++; return {}; } });
  await submit(f.service, '请给执行提示，先用按钮确定范围'); await f.service.close();
  assert.equal(calls, 2); assert.equal(saved, 1);
  assert.ok(!(JSON.stringify((await f.service.state()).messages).includes('NCM1234567890')));
});

test('新问题替代旧问题：历史保留，不虚构答案，过期答题被拒绝', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls < 3 ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'q-' + calls,
    name: 'ask_user', input: { question: calls === 1 ? '文章内还是独立页？' : '当前文章还是全站？', options: ['前者', '后者'] } }] } : answer('已记录。'),
  { tools: [{ name: 'ask_user' }], execute: async () => ({}) });
  await f.service.submit({ id: 'first', text: '讨论形态' }); await f.service.close();
  const first = (await f.service.state()).messages.flatMap(message => message.questions || [])[0];
  await f.service.submit({ id: 'second', text: '先换一个问题' }); await f.service.close();
  const questions = (await f.service.state()).messages.flatMap(message => message.questions || []);
  assert.equal(questions[0].superseded, true); assert.equal(questions[0].answer, null);
  assert.equal(questions.filter(question => !question.answer && !question.superseded).length, 1);
  await assert.rejects(f.service.submit({ id: 'old-answer', text: '前者', answerTo: first.id }), { code: 'CONFLICT' });
  await f.service.submit({ id: 'current-answer', text: '后者', answerTo: questions[1].id }); await f.service.close();
  assert.equal((await f.service.state()).messages.flatMap(message => message.questions || [])[1].answer.text, '后者');
  assert.equal(Object.keys((await f.service.readConversation()).answers).length, 1);
});

test('长回复纠正不能丢失尚未执行的绑定动作，成功后只保存一次', async t => {
  let calls = 0, saved = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 2) return answer('[CG_REPLY]\n建议绑定到阅读助手。');
    return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]\n' + (calls === 1 ? '长'.repeat(61) : '建议绑定到阅读助手，请确认。') },
      { type: 'tool_use', id: 'mount-' + calls, name: 'reply_mount_conversation', input: {} }] };
  }, { tools: [{ name: 'mount_conversation' }], validateReplies: true, maxModelRetries: 2, retryDelayMs: 0,
    execute: async () => { saved++; return { kind: 'binding-proposal', pending: true }; } });
  await submit(f.service, '给博客增加阅读助手'); await f.service.close();
  assert.equal(calls, 3); assert.equal(saved, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
});

test('完整人工brief审批卡成功后直接等待确认，不追加模型复述', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++; return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'brief', name: 'reply_prepare_task', input: {} }] };
  }, { tools: [{ name: 'prepare_task' }], validateReplies: true,
    execute: async () => ({ manual: true, pending: true, requiresHumanApproval: true }) });
  await submit(f.service, '整理需求'); await f.service.close();
  assert.equal(calls, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.ok(Object.values((await f.service.readConversation()).toolReceipts).some(item => item.result.manual));
});

test('审批确认通知不是用户索要详情，模型收到专门的短回执约束', async t => {
  const f = await fixture(t, async request => {
    assert.match(request.system, /服务器确认回执/);
    assert.match(request.system, /不重新输出brief或执行提示/);
    return answer('已保存需求，执行提示可从卡片导出。');
  }, { validateReplies: true });
  await f.service.submit({ id: 'review-notice', text: '人工已确认brief，可导出完整执行提示。' }, { source: 'workflow' });
  await f.service.close();
  assert.equal((await f.service.state()).status, 'waiting-for-user');
});

test('真实SSE解析中的接话标记错误保留原因并自动恢复，而非被回调边界吞掉', async t => {
  let attempts = 0;
  const model = new CoordinatorModel({ baseUrl: 'https://model.invalid', model: 'test-model', token: 'synthetic-test-token', fetch: async () => {
    const text = ++attempts === 1 ? '未声明接话' : '[CG_REPLY]\n你好。';
    const events = [
      { type: 'message_start', message: { model: 'test-model', usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const f = await fixture(t, () => {}, { model, maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '你好'); await f.service.close();
  assert.equal(attempts, 2); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.readConversation()).performance.models[0].diagnostic.validationCode, 'PARTICIPATION_HEADER_INVALID');
});

for (const [scenario, validationCode] of [['invalid-json', 'TOOL_INVALID'], ['array-input', 'TOOL_INVALID'], ['truncated', 'MISSING_TERMINAL']])
test(`真实SSE ${scenario} 自动恢复，非法参数或截断不执行工具`, async t => {
  let attempts = 0;
  const model = new CoordinatorModel({ baseUrl: 'https://model.invalid', model: 'test-model', token: 'synthetic-test-token', fetch: async () => {
    const first = ++attempts === 1;
    const events = first ? [
      { type: 'message_start', message: { model: 'test-model' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bad', name: 'reply_write', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: scenario === 'array-input' ? '[]' : scenario === 'invalid-json' ? '{' : '{}' } },
      ...(scenario === 'truncated' ? [] : [{ type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]),
    ] : [
      { type: 'message_start', message: { model: 'test-model' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '[CG_REPLY]\n已收到。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const f = await fixture(t, () => {}, { model, maxModelRetries: 2, retryDelayMs: 0, validateReplies: true });
  await submit(f.service, '请处理'); await f.service.close();
  assert.equal(attempts, 2); assert.deepEqual(f.writes, []); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.readConversation()).performance.models[0].diagnostic.validationCode, validationCode);
});

for (const name of ['ask_user', 'mount_conversation', 'show_model_menu']) test(`接话别名 ${name} 执行后等待人类，不追加模型总结`, async t => {
  let calls = 0;
  const input = name === 'ask_user' ? { question: '绑定到主页模块，可以吗？', options: ['可以', '暂不绑定'] } : {};
  const native = { type: 'tool_use', id: 'wait', name: `reply_${name}`, input };
  const f = await fixture(t, async () => {
    calls++;
    return calls === 1 ? { stop: 'tool_use', content: [native] } : answer('不应出现的额外总结。');
  }, { tools: [{ name }], execute: async (actual, args) => {
    assert.equal(actual, name); assert.deepEqual(args, input); return { saved: true };
  } });
  await submit(f.service, '先展示确认，不继续处理。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 1);
  assert.deepEqual((await f.service.readConversation()).messages.find(message => message.role === 'assistant').content, [native]);
  if (name === 'ask_user') {
    const question = state.messages.at(-1).questions[0];
    assert.equal(state.messages.at(-1).text, input.question); assert.deepEqual(question.options, input.options);
    assert.ok(f.snapshots.some(snapshot => snapshot.activity?.kind === 'preparing-question'));
    await f.service.submit({ id: 'answer', text: '可以', answerTo: question.id }); await f.service.close();
    const restored = await f.service.state();
    assert.deepEqual(restored.messages.flatMap(message => message.questions || []).find(item => item.id === question.id).answer,
      { text: '可以', requestId: 'answer' });
    assert.equal(calls, 2); assert.equal(restored.approvals.length, 0, '提问答复不是事项批准');
  }
});

test('接话别名纯表情完成后只执行一轮，原生工具对及精确回执保留', async t => {
  let calls = 0;
  const native = { type: 'tool_use', id: 'social-complete', name: 'reply_react_to_user', input: { emoji: 'wave', replyComplete: true } };
  const f = await fixture(t, async () => {
    calls++;
    return calls === 1 ? { stop: 'tool_use', content: [native] } : answer('不应出现的占位正文。');
  }, { tools: [{ name: 'react_to_user' }], execute: async (name, input, { operationId }) => {
    assert.equal(name, 'react_to_user'); assert.deepEqual(input, native.input);
    return { kind: 'slack-reaction', actionId: operationId, emoji: 'wave', status: 'intent' };
  } });
  await submit(f.service, '只挥手，不需要正文。'); await f.service.close();
  assert.equal(calls, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
  const raw = await f.service.readConversation();
  assert.deepEqual(raw.messages.at(-2).content, [native]); assert.equal(raw.messages.at(-1).content[0].tool_use_id, native.id);
  const receipt = Object.values(raw.toolReceipts)[0];
  assert.equal(receipt.result.requestId, 'original'); assert.deepEqual(receipt.result.actor, actor);
  assert.ok(receipt.result.actionId.startsWith('coordinator:')); assert.deepEqual(streamed(f.snapshots), []);
});

test('普通网页来源不能借用接话工具别名获得执行权限', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ tools }) => {
    assert.equal(tools[0].name, 'write');
    return ++calls === 1 ? { stop: 'tool_use', content: [{ ...tool('forged'), name: 'reply_write' }] } : answer('此工具未开放。');
  });
  await f.service.submit({ id: 'browser', text: '测试' }, { source: 'human', actor: { kind: 'human', sessionId: 'browser-human' } });
  await f.service.close(); assert.deepEqual(f.writes, []);
  const raw = await f.service.readConversation();
  assert.ok(Object.values(raw.toolReceipts).some(receipt => receipt.isError && receipt.result.error.code === 'TOOL_FORBIDDEN'));
});

test('群组没有项目切换权限时，接话别名也不能调用项目工具', async t => {
  const f = await fixture(t, async ({ tools, onToolStart }) => {
    assert.equal(tools.some(tool => tool.name === 'reply_switch_project'), false);
    await onToolStart?.('reply_switch_project');
    return { stop: 'tool_use', content: [{ ...tool('forged-project'), name: 'reply_switch_project' }] };
  }, { tools: [{ name: 'write' }, { name: 'switch_project' }] });
  const text = '测试项目切换';
  await f.service.submit({ id: 'batch', inputs: [{ id: 'original', text }] },
    { source: 'slack', actor: { ...actor, channelId: 'CTESTPUBLIC' }, participation: participation(text) });
  await f.service.close(); assert.equal((await f.service.state()).status, 'error'); assert.deepEqual(f.writes, []);
});

test('显式选择接话工具：不增加分类轮次，业务参数和原生回执保持原样', async t => {
  let calls = 0;
  const native = { ...tool('declared'), name: 'reply_write' };
  const f = await fixture(t, async ({ tools, onToolStart, onText }) => {
    if (++calls === 1) {
      assert.equal(tools[0].name, 'reply_write'); assert.equal(tools[0].input_schema, undefined);
      await onToolStart?.('reply_write'); await onText?.('正在执行已授权的修改。');
      assert.deepEqual(streamed(f.snapshots), [], '响应尚未确认前不发布正文');
      return { stop: 'tool_use', content: [native, { type: 'text', text: '正在执行已授权的修改。' }] };
    }
    assert.equal(tools[0].name, 'write', '接续轮恢复原工具定义');
    return answer('已保存。');
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 2);
  assert.deepEqual(f.writes, [{ id: 'declared' }], '业务参数不变');
  const raw = await f.service.readConversation();
  assert.deepEqual(raw.messages.find(message => message.role === 'assistant').content[0], native, '原生工具输入保持原样');
  assert.ok(streamed(f.snapshots).includes('正在执行已授权的修改。'));
});

for (const name of ['write', 'reply_unknown', 'reply_reply_write', 'reply_']) test(`未选择本轮明确接话工具（${name}）时无正文、无执行`, async t => {
  const input = { id: 'denied' };
  const f = await fixture(t, async ({ onToolStart, onText }) => {
    await onToolStart?.('write'); await onText?.('未验证的正文。');
    return { stop: 'tool_use', content: [{ ...tool('denied'), name, input }, { type: 'text', text: '未验证的正文。' }] };
  });
  await submit(f.service, '仅供知悉，不要修改。'); await f.service.close();
  assert.equal((await f.service.state()).status, 'error');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
});

test('工具声明与静默文本冲突时拒绝执行', async t => {
  const f = await fixture(t, async ({ onToolStart, onText }) => {
    await onToolStart?.('write'); await onText?.('[CG_SILENT]');
    return { stop: 'tool_use', content: [{ ...tool('contradiction'), name: 'reply_write' }, { type: 'text', text: '[CG_SILENT]' }] };
  });
  await submit(f.service, '仅供知悉，不用回复。'); await f.service.close();
  assert.equal((await f.service.state()).status, 'error');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
});

test('同轮后续工具含非法声明时，整轮都不执行', async t => {
  const f = await fixture(t, async ({ onToolStart }) => {
    await onToolStart?.('write');
    return { stop: 'tool_use', content: [
      { ...tool('first'), name: 'reply_write' },
      { ...tool('second'), name: 'reply_unknown' },
    ] };
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  assert.equal((await f.service.state()).status, 'error'); assert.deepEqual(f.writes, []);
});

test('工具声明未收齐时的新静默更正阻止旧轮执行', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, async ({ onToolStart, signal }) => {
    if (++calls > 1) return answer('[CG_SILENT]');
    await onToolStart?.('write'); entered.resolve();
    await Promise.race([release.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return { stop: 'tool_use', content: [{ ...tool('stale'), name: 'reply_write' }] };
  });
  await submit(f.service, '执行已授权的修改。'); await entered.promise;
  const correction = '更正：不用回复，也不要修改。';
  await f.service.submit({ id: 'corrected-batch', followup: 'steer', expectedTurnId: 'original', inputs: [{ id: 'correction', text: correction }] },
    { source: 'slack', actor, participation: { ...participation(correction), inputs: [{ id: 'correction', text: correction }] } });
  release.resolve(); await f.service.close();
  assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
});

for (const terminal of [true, false]) test(`原生 SSE 工具声明须在完整响应后才能执行（终止事件：${terminal}）`, async t => {
  let calls = 0;
  const requests = [];
  const model = new CoordinatorModel({ baseUrl: 'https://provider.invalid', model: 'fixture', token: 'synthetic', fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (++calls > 1) return new Response(JSON.stringify({ model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: '已保存。' }] }), { headers: { 'content-type': 'application/json' } });
    const frames = [{ type: 'message_start', message: { model: 'fixture', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'wire', name: 'reply_write', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ id: 'wire' }) } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ...(terminal ? [{ type: 'message_stop' }] : [])];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const f = await fixture(t, async () => { throw new Error('unused'); }, { model });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, terminal ? 'waiting-for-user' : 'error');
  assert.deepEqual(f.writes, terminal ? [{ id: 'wire' }] : []);
  assert.equal(calls, terminal ? 2 : 1);
    if (terminal) assert.equal(requests[1].messages.find(message => message.role === 'assistant').content[0].name, 'reply_write');
});

test('Independent merged reply uses one model round, strips every split control prefix and preserves original identity', async t => {
  let calls = 0;
  const text = '[CG_REPLY]\n已收到你的问题。';
  const f = await fixture(t, async ({ onText }) => {
    calls++;
    for (let end = 1; end <= text.length; end++) await onText?.(text.slice(0, end));
    return answer(text);
  });
  await submit(f.service, '请确认收到。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(calls, 1); assert.equal(state.status, 'waiting-for-user'); assert.deepEqual(f.writes, []);
  assert.ok(streamed(f.snapshots).length > 0, 'Reply body must stream before terminal persistence');
  for (const fragment of streamed(f.snapshots)) assert.ok('已收到你的问题。'.startsWith(fragment), 'Only stripped body may be publicly streamed');
  assert.equal(state.messages.find(message => message.role === 'assistant')?.text, '已收到你的问题。');
  assert.equal(state.messages.find(message => message.role === 'user')?.requestId, 'original');
  assert.equal(state.messages.find(message => message.role === 'user')?.actor.userId, actor.userId);
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged silence is terminal, has no assistant, no stream and no tool side effects', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ onText }) => { calls++; await onText?.('[CG_'); await onText?.('[CG_SILENT]'); return answer('[CG_SILENT]'); });
  await submit(f.service, '仅供知悉，不用回复。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(calls, 1); assert.equal(state.status, 'waiting-for-user'); assert.equal(state.activeTurnId, null);
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

for (const [name, result] of [
  ['missing header', { stop: 'tool_use', content: [{ type: 'text', text: '我现在修改。' }, tool('missing')] }],
  ['silent with tool', { stop: 'tool_use', content: [{ type: 'text', text: '[CG_SILENT]' }, tool('silent-tool')] }],
  ['silent with extra body', answer('[CG_SILENT]\n我不回复。')],
  ['unknown header', { stop: 'tool_use', content: [{ type: 'text', text: '[CG_OTHER]\n修改' }, tool('unknown')] }],
]) test(`Independent merged ${name} fails closed without public stream or executed tool`, async t => {
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    await onText?.(text);
    if (result.stop === 'tool_use') await onToolStart?.('write');
    return result;
  });
  await submit(f.service, '不要修改，仅供知悉。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'error'); assert.equal(state.error?.code, 'MODEL_INVALID_RESPONSE');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
});

test('Independent merged tool result continuation does not require a second decision header', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    if (++calls === 1) {
      await onText?.('[CG_REPLY]\n'); await onToolStart?.('write');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]\n' }, tool('saved-once')] };
    }
    await onText?.('修改已保存。'); return answer('修改已保存。');
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 2); assert.equal(f.writes.length, 1);
  assert.equal(state.messages.filter(message => message.role === 'assistant').at(-1)?.text, '修改已保存。');
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged exact no-newline reply marker accepts a native tool boundary without exposing the marker', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    if (++calls === 1) {
      await onText?.('[CG_'); await onText?.('[CG_REPLY]'); await onToolStart?.('write');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' }, tool('native-no-newline')] };
    }
    await onText?.('已保存。'); return answer('已保存。');
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 2);
  assert.deepEqual(f.writes, [{ id: 'native-no-newline' }]);
  assert.ok(streamed(f.snapshots).every(fragment => fragment === '已保存。'));
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged incomplete reply marker cannot activate native tool execution', async t => {
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    await onText?.('[CG_REP'); await onToolStart?.('write');
    return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REP' }, tool('partial-marker')] };
  });
  await submit(f.service, '请修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'error'); assert.equal(state.error?.code, 'MODEL_INVALID_RESPONSE');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
});

test('Independent merged reply marker alone cannot complete an empty text answer', async t => {
  const f = await fixture(t, async ({ onText }) => { await onText?.('[CG_REPLY]'); return answer('[CG_REPLY]'); });
  await submit(f.service, '请回复。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'error'); assert.equal(state.error?.code, 'MODEL_INVALID_RESPONSE');
  assert.deepEqual(f.writes, []); assert.deepEqual(streamed(f.snapshots), []);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0);
});

test('Independent merged continuation strips a repeated reply marker across every stream boundary', async t => {
  let calls = 0;
  const text = '[CG_REPLY]\n工具执行完成。';
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    if (++calls === 1) {
      await onText?.('[CG_REPLY]'); await onToolStart?.('write');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' }, tool('continuation-prefix')] };
    }
    for (let end = 1; end <= text.length; end++) await onText?.(text.slice(0, end));
    return answer(text);
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 2); assert.equal(f.writes.length, 1);
  assert.ok(streamed(f.snapshots).length > 0);
  assert.ok(streamed(f.snapshots).every(fragment => '工具执行完成。'.startsWith(fragment)));
  assert.equal(state.messages.filter(message => message.role === 'assistant').at(-1)?.text, '工具执行完成。');
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged continuation cannot change an accepted reply to silent or execute additional tools', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ onText, onToolStart }) => {
    if (++calls === 1) {
      await onText?.('[CG_REPLY]'); await onToolStart?.('write');
      return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]' }, tool('already-saved')] };
    }
    await onText?.('[CG_SILENT]'); await onToolStart?.('write');
    return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_SILENT]' }, tool('must-not-save')] };
  });
  await submit(f.service, '执行已授权的修改。'); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'error'); assert.equal(state.error?.code, 'MODEL_INVALID_RESPONSE'); assert.equal(calls, 2);
  assert.deepEqual(f.writes, [{ id: 'already-saved' }]); assert.deepEqual(streamed(f.snapshots), []);
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged steer rechecks current correction and prevents stale reply tools', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, async ({ signal, onText }) => {
    if (++calls > 1) return answer('[CG_SILENT]');
    await onText?.('[CG_REPLY]\n'); entered.resolve();
    await Promise.race([release.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    return { stop: 'tool_use', content: [{ type: 'text', text: '[CG_REPLY]\n' }, tool('stale-write')] };
  });
  await submit(f.service, '请修改。'); await entered.promise;
  const correction = '更正：不用回复，也不要修改。';
  await f.service.submit({ id: 'corrected-batch', followup: 'steer', expectedTurnId: 'original', inputs: [{ id: 'correction', text: correction }] },
    { source: 'slack', actor, participation: { ...participation(correction), inputs: [{ id: 'correction', text: correction }] } });
  release.resolve(); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(calls, 2); assert.deepEqual(f.writes, []);
  assert.deepEqual(state.messages.filter(message => message.role === 'user').map(message => message.requestId), ['original', 'correction']);
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT/);
});

test('Independent merged participation metadata cannot be accepted from an untrusted source', async t => {
  const f = await fixture(t, async () => answer('should not run'));
  await assert.rejects(f.service.submit({ id: 'batch', inputs: [{ id: 'original', text: 'test' }] },
    { source: 'human', actor, participation: participation('test') }), error => error.code === 'INVALID_INPUT' || error.code === 'FORBIDDEN');
  assert.equal((await f.service.state()).messages.length, 0);
});

test('Independent merged cancellation never retains a returned raw protocol prefix as visible partial history', { timeout: 10000 }, async t => {
  const entered = deferred();
  const f = await fixture(t, async ({ signal, onText }) => {
    await onText?.('[CG_'); entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    // A provider adapter may resolve late instead of rejecting cancellation.
    return answer('[CG_REPLY]\nlate answer that was never visibly streamed');
  });
  await submit(f.service, '请回复。'); await entered.promise;
  await f.service.interrupt({ id: 'stop-original', expectedTurnId: 'original' }); await f.service.close();
  const state = await f.service.state();
  assert.equal(state.status, 'interrupted'); assert.deepEqual(streamed(f.snapshots), []); assert.deepEqual(f.writes, []);
  assert.doesNotMatch(JSON.stringify(state), /CG_REPLY|CG_SILENT|late answer/);
});
