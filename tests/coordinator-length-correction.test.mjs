import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorService, coordinatorCanAutoResume } from '../scripts/cloud/coordinator-service.mjs';
import { CoordinatorModel } from '../scripts/cloud/coordinator-model.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { SlackIO } from '../plugins/slack/src/slack-io.mjs';
import { Store, threadKey } from '../plugins/slack/src/store.mjs';
const text = value => ({ stop: 'end_turn', content: [{ type: 'text', text: value }] });
async function fixture(t, next, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-length-correction-'));
  const writes = [], snapshots = [], plugins = [];
  const settings = { directory, system: 'Test Coordinator', tools: [{ name: 'write' }], model: { next },
    execute: async (name, input) => { writes.push({ name, input }); return { saved: true }; },
    maxModelRetries: 2, retryDelayMs: 0, steerSettleMs: 0, validateReplies: true, ...options };
  const service = new CoordinatorService(settings), save = service.saveState.bind(service);
  service.saveState = async state => { snapshots.push(structuredClone(state)); return save(state); };
  t.after(async () => { for (const plugin of plugins) await plugin.stop(); await service.close({ stop: true }); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, settings, writes, snapshots, directory, plugins };
}
const actor = { kind: 'human', integration: 'slack', teamId: 'TTEST', userId: 'UTEST', channelId: 'DTEST', sessionId: 'slack:TTEST:UTEST' };
async function mirrorFixture(f) {
  const store = await new Store(path.join(f.directory, 'slack')).open();
  const key = threadKey('TTEST', 'DTEST', '100.001');
  await store.bind(key, { channel: 'DTEST', threadTs: '100.001', userId: 'UTEST', projectId: 'fixture', conversationId: 'chat-fixture', ownRequests: ['input'] });
  const calls = [];
  const io = new SlackIO({ store, botUserId: 'UBOT', wait: async () => {}, client: { apiCall: async (method, args) => {
    calls.push({ method, args }); return { ok: true, ts: '101.' + calls.length };
  } } });
  const plugin = new SlackPlugin({ store, teamId: 'TTEST', botUserId: 'UBOT', io, cloudOrigin: 'https://map.example.com',
    gateway: { command: async () => ({ ...await f.service.state(), approvals: [], acceptedRequestIds: ['input'] }) },
    logger: { error(){}, warn(){} } });
  f.plugins.push(plugin);
  return { plugin, key, calls };
}
async function submit(service, source = 'human', value = '简短总结需求', id = 'input') {
  if (source === 'human') return service.submit({ id, text: value });
  return service.submit({ id: 'batch-' + id, inputs: [{ id, text: value }] }, { source: 'slack', actor,
    participation: { text: value, inputs: [{ id, text: value }], context: [], files: [],
      routing: { coordinatorUserId: 'UBOT', mentionedUsers: [], replyToCoordinator: false } } });
}
for (const source of ['human', 'slack']) test(`${source}: long replies are delivered once in full with private quality warnings`, async t => {
  let count = 0;
  const body = '必须保留的正文。'.repeat(300) + '完整结尾';
  const f = await fixture(t, async request => {
    count++; assert.match(JSON.stringify(request.messages), /简短总结需求/);
    assert.doesNotMatch(request.system, /最多60|最多两段|每段.*60/);
    return text((source === 'slack' ? '[CG_REPLY]\n' : '') + body);
  }, { maxSteps: 1, maxModelRetries: 0 });
  await submit(f.service, source); await f.service.close();
  const state = await f.service.state(), stored = await f.service.readConversation();
  assert.equal(count, 1); assert.equal(state.status, 'waiting-for-user'); assert.equal(state.error, null);
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(state.messages.at(-1).text, body);
  assert.deepEqual(stored.performance.models[0].replyWarnings, [
    { code: 'REPLY_PARAGRAPH_LONG', field: 'reply', characters: [...body].length },
  ]);
  assert.doesNotMatch(JSON.stringify(stored.performance), /必须保留的正文|完整结尾|rejectedText/);
  assert.ok(!JSON.stringify(state).includes('replyWarnings'));
  await submit(f.service, source); await f.service.close(); assert.equal(count, 1, 'Same input is not executed again');
  assert.deepEqual(f.writes, []);
});
test('many paragraphs are delivered without correction; explicit detail is not a brevity Bad Case', async t => {
  const body = '第一条。\n\n第二条。\n\n第三条。\n\n第四条。'; let count = 0;
  const f = await fixture(t, async () => { count++; return text(body); });
  await submit(f.service); await f.service.close();
  assert.equal(count, 1); assert.equal((await f.service.state()).messages.at(-1).text, body);
  assert.equal((await f.service.readConversation()).performance.models[0].replyWarnings[0].code, 'REPLY_TOO_MANY_PARAGRAPHS');
  await submit(f.service, 'human', '请完整展开详情', 'details'); await f.service.close();
  assert.equal(count, 2); assert.equal((await f.service.state()).messages.at(-1).text, body);
  assert.equal((await f.service.readConversation()).performance.models[0].replyWarnings, undefined);
});
test('transient faults remain bounded, but a recovered long answer is not regenerated', async t => {
  let count = 0;
  const body = '长'.repeat(61);
  const f = await fixture(t, async () => {
    if (++count <= 2) throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' });
    return text(body);
  });
  await submit(f.service); await f.service.close();
  assert.equal(count, 3); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.state()).messages.at(-1).text, body);
});
test('transient model faults remain bounded instead of retrying forever', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' }); });
  await submit(f.service); await f.service.close();
  assert.equal(count, 3); assert.equal((await f.service.state()).status, 'error'); assert.deepEqual(f.writes, []);
});
test('a completed write followed by a long answer executes once, including original input replay', async t => {
  let count = 0; const body = '保存说明。'.repeat(100);
  const f = await fixture(t, async () => ++count === 1
    ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'write', input: { value: 'confirmed' } }] }
    : text(body));
  await submit(f.service); await f.service.close(); await submit(f.service); await f.service.close();
  assert.equal(count, 2); assert.equal(f.writes.length, 1);
  assert.equal((await f.service.state()).messages.at(-1).text, body);
});
test('human interruption during a long response remains effective', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; await f.service.interrupt({ id: 'stop', expectedTurnId: 'input' }); return text('长'.repeat(200)); });
  await submit(f.service); await f.service.close();
  assert.equal(count, 1); assert.equal((await f.service.state()).status, 'interrupted'); assert.deepEqual(f.writes, []);
  assert.equal((await f.service.state()).messages.filter(m => m.role === 'assistant' && !m.partial).length, 0);
});
test('old exhausted length repair resumes once without the obsolete length feedback', async t => {
  const failed = { status: 'error', activeTurnId: 'input', activeInput: { id: 'input', text: '简短总结需求', source: 'human' },
    messages: [{ role: 'user', requestId: 'input', content: '简短总结需求' }], requests: {}, toolReceipts: {}, steps: 0, modelRetries: 2,
    error: { code: 'MODEL_INVALID_RESPONSE', recoverable: true, diagnostic: { validationCode: 'REPLY_PARAGRAPH_LONG' } },
    modelRepairCode: 'REPLY_PARAGRAPH_LONG', modelRepairText: '长'.repeat(61) };
  assert.equal(coordinatorCanAutoResume(failed), true);
  assert.equal(coordinatorCanAutoResume({ ...failed, pending: { id: 'unresolved' } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, operatorRecovery: { initialAccepted: false } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, error: { ...failed.error, diagnostic: { validationCode: 'TOOL_INVALID' } } }), false);
  let count = 0; const body = '保留完整的恢复正文。'.repeat(30);
  const f = await fixture(t, async request => {
    count++; assert.doesNotMatch(JSON.stringify(request.messages), /rejectedText|REPLY_PARAGRAPH_LONG/);
    assert.doesNotMatch(request.system, /最多60|最多两段/); return text(body);
  });
  await f.service.saveState(failed); f.service.kick(); await f.service.close();
  assert.equal(count, 1); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.state()).messages.at(-1).text, body);
});
test('long answer and its quality record survive restart without another model call', async t => {
  let count = 0; const body = '长'.repeat(100);
  const f = await fixture(t, async () => { count++; return text(body); });
  await submit(f.service); await f.service.close(); await f.service.close({ stop: true });
  const restarted = new CoordinatorService(f.settings); t.after(() => restarted.close({ stop: true }));
  assert.equal((await restarted.state()).messages.at(-1).text, body);
  assert.equal((await restarted.readConversation()).performance.models[0].replyWarnings[0].characters, 100);
  restarted.kick(); await restarted.close(); assert.equal(count, 1);
});
test('long replies cannot bypass internal-ID protection or multiple-tool-question checks', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return text('内容'.repeat(100) + 'NCM1234567890'); },
    { maxModelRetries: 0, context: async () => ({ internalIds: ['NCM1234567890'] }) });
  await submit(f.service); await f.service.close();
  assert.equal(count, 1); assert.equal((await f.service.readConversation()).error.diagnostic.validationCode, 'REPLY_INTERNAL_ID');
  assert.deepEqual(f.writes, []);
  const questions = await fixture(t, async () => ({ stop: 'tool_use', content: [1, 2].map(index =>
    ({ type: 'tool_use', id: 'q-' + index, name: 'ask_user', input: { question: '长问题。'.repeat(50) } })) }),
    { maxModelRetries: 0, tools: [{ name: 'ask_user' }] });
  await submit(questions.service); await questions.service.close();
  assert.equal((await questions.service.readConversation()).error.diagnostic.validationCode, 'MULTIPLE_QUESTIONS');
  assert.deepEqual(questions.writes, []);
});
test('Slack renders the actual long service reply in full, split safely and idempotently', async t => {
  const body = '正文和表情🙂。'.repeat(1500) + '\n\n末尾必须出现';
  let count = 0;
  const f = await fixture(t, async () => { count++; return text('[CG_REPLY]\n' + body); });
  await submit(f.service, 'slack'); await f.service.close();
  const { plugin, key, calls } = await mirrorFixture(f);
  await plugin.mirror(key);
  const posts = calls.filter(call => call.method === 'chat.postMessage');
  assert.ok(posts.length > 1); assert.equal(posts.map(call => call.args.text).join('').replace(/\s/g, ''), body.replace(/\s/g, ''));
  assert.ok(posts.every(call => Buffer.byteLength(call.args.text) <= 4000 && call.args.blocks.length <= 49));
  const before = calls.length; await plugin.mirror(key); assert.equal(calls.length, before); assert.equal(count, 1);
});
const provider = { baseUrl: 'https://model.invalid', model: 'test-model', token: 'synthetic-fixture' };
function truncatedResponse(protocol, body, { tool = false, model = provider.model, open = false } = {}) {
  if (protocol === 'openai') return new Response(JSON.stringify({ model, choices: [{
    finish_reason: 'length', message: { role: 'assistant', content: body,
      ...(tool ? { tool_calls: [{ id: 'unsafe', function: { name: 'write', arguments: '{"incomplete":' } }] } : {}) },
  }] }), { headers: { 'content-type': 'application/json' } });
  const events = [
    { type: 'message_start', message: { model } },
    { type: 'content_block_start', index: 0, content_block: { type: tool ? 'tool_use' : 'text', text: body, id: 'unsafe', name: 'write', input: {} } },
    ...(!open ? [{ type: 'content_block_stop', index: 0 }] : []),
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' },
  ];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}
for (const protocol of ['openai', 'anthropic']) test(`${protocol}: known text truncation preserves visible partial once, never completed history or tools`, async t => {
  let count = 0; const body = '[CG_REPLY]\n' + '保留正文。'.repeat(100);
  const model = new CoordinatorModel({ ...provider, protocol, fetch: async () => { count++; return truncatedResponse(protocol, body); } });
  const f = await fixture(t, null, { model });
  await submit(f.service, 'slack'); await f.service.close();
  const state = await f.service.state(), raw = await f.service.readConversation();
  assert.equal(count, 1); assert.equal(state.status, 'error'); assert.equal(state.error.code, 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(state.streamingText, body.slice('[CG_REPLY]\n'.length));
  assert.equal(raw.messages.filter(message => message.role === 'assistant').length, 0); assert.deepEqual(f.writes, []);
  assert.equal(raw.error.recoverable, false); assert.ok(!JSON.stringify(raw.performance).includes('保留正文'));
  await f.service.close({ stop: true });
  const restarted = new CoordinatorService(f.settings); t.after(() => restarted.close({ stop: true }));
  assert.equal((await restarted.state()).streamingText, state.streamingText); assert.equal(count, 1);
  const { plugin, key, calls } = await mirrorFixture(f);
  await plugin.mirror(key);
  assert.ok(calls.some(call => call.method === 'chat.postMessage' && call.args.text.includes('保留正文')));
  const before = calls.length; await plugin.mirror(key); assert.equal(calls.length, before);
});
test('new Slack input after text truncation is accepted without replaying the failed generation', async t => {
  let count = 0;
  const model = new CoordinatorModel({ ...provider, protocol: 'openai', fetch: async () => ++count === 1
    ? truncatedResponse('openai', '[CG_REPLY]\n已有正文')
    : new Response(JSON.stringify({ model: provider.model, choices: [{ finish_reason: 'stop', message: { content: '[CG_REPLY]\n新问题已收到。' } }] }), { headers: { 'content-type': 'application/json' } }) });
  const f = await fixture(t, null, { model });
  await submit(f.service, 'slack'); await f.service.close();
  await submit(f.service, 'slack', '继续', 'next'); await f.service.close();
  assert.equal(count, 2); assert.equal((await f.service.state()).status, 'waiting-for-user');
  assert.equal((await f.service.state()).messages.at(-1).text, '新问题已收到。');
  assert.equal((await f.service.readConversation()).failedTurns[0].code, 'MODEL_OUTPUT_TRUNCATED');
});
test('truncated tools, wrong models and open blocks still fail closed without executing', async () => {
  for (const [protocol, options] of [['openai', { tool: true }], ['anthropic', { tool: true }],
    ['anthropic', { model: 'wrong-model' }], ['openai', { model: 'wrong-model' }], ['anthropic', { open: true }]]) {
    const model = new CoordinatorModel({ ...provider, protocol, fetch: async () => truncatedResponse(protocol, 'body', options) });
    await assert.rejects(model.next({ system: '', messages: [] }), error => {
      assert.equal(error.code, 'MODEL_INVALID_RESPONSE'); assert.notEqual(error.textOnlyTruncation, true); return true;
    });
  }
});
test('provider token budgets use defaults when optional and preserve explicit or required budgets', () => {
  const openai = new CoordinatorModel({ ...provider, protocol: 'openai' });
  assert.equal(Object.hasOwn(JSON.parse(openai.prepareRequest({ system: '', messages: [] })), 'max_tokens'), false);
  assert.equal(JSON.parse(openai.prepareRequest({ system: '', messages: [], maxTokens: 256 })).max_tokens, 256);
  const explicit = new CoordinatorModel({ ...provider, protocol: 'openai', maxTokens: 8192 });
  assert.equal(JSON.parse(explicit.prepareRequest({ system: '', messages: [] })).max_tokens, 8192);
  const anthropic = new CoordinatorModel(provider);
  assert.equal(JSON.parse(anthropic.prepareRequest({ system: '', messages: [] })).max_tokens, 4096);
});
