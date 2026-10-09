import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCoordinatorContext } from '../scripts/cloud/coordinator-context.mjs';
import { coordinatorPrefix, coordinatorInputContext } from '../scripts/cloud/coordinator-prefix.mjs';
import { CoordinatorService, CoordinatorConversations } from '../scripts/cloud/coordinator-service.mjs';
import { coordinatorModelMessages, coordinatorStep } from '../scripts/cloud/coordinator-model.mjs';
import { hash } from '../scripts/shared/io.mjs';

const tools = [{ name: 'read_map', input_schema: { type: 'object', properties: {} } }];
const answer = { stop: 'end_turn', content: [{ type: 'text', text: '收到' }],
  usage: { input_tokens: 100, cache_read_input_tokens: 1000 } };
function snapshot(version = 'v1', status = 'pending') {
  return { version, memory: { map: { root: { id: 'T0', title: 'Project', memoryDocument: '项目概览',
    children: [{ id: 'N1', title: 'Login', memoryDocument: '模块记忆',
      todos: [{ id: 'TD1', title: 'Refresh token', status }], children: [] },
    { id: 'N2', title: 'Other', memoryDocument: '不可见记忆', children: [] }] } } } };
}
const item = { id: 'item-1', nodeId: 'N1', kind: 'todo', itemId: 'TD1' };
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cache-prefix-'));
  const calls = [];
  const service = new CoordinatorService({ directory, system: 'role', tools,
    execute: async () => ({}), context: async () => buildCoordinatorContext(snapshot()),
    model: { next: async request => { calls.push(structuredClone({ system: request.system, tools: request.tools, messages: request.messages }));
      return structuredClone(answer); } }, ...options });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, service, calls };
}

test('Main version and task changes update only the trailing context, not the stable project prefix', () => {
  const a = buildCoordinatorContext(snapshot(), { conversation: item });
  const b = buildCoordinatorContext(snapshot('v2', 'done'), { conversation: item });
  assert.equal(a.staticText, b.staticText);
  assert.equal(a.staticVersion, b.staticVersion);
  assert.doesNotMatch(a.staticText, /v1|pending|当前事项/);
  assert.match(b.dynamicText, /Main 版本：v2/);
  assert.match(b.dynamicText, /状态：done/);
  assert.match(b.dynamicText, /模块记忆/);
  assert.equal(coordinatorPrefix('role', a, tools), coordinatorPrefix('role', b, tools));
  const overview = snapshot(); overview.memory.map.root.children[0].todos[0].desc = '旧用途资料';
  const first = buildCoordinatorContext(overview);
  overview.memory.map.root.children[0].todos[0].desc = '新用途资料';
  const second = buildCoordinatorContext(overview);
  assert.match(first.dynamicText, /用途摘录：旧用途资料/); assert.match(second.dynamicText, /用途摘录：新用途资料/);
  assert.equal(first.staticText, second.staticText); assert.equal(first.staticVersion, second.staticVersion);
  assert.equal(coordinatorPrefix('role', first, tools), coordinatorPrefix('role', second, tools));
});

test('Memory, navigation, roles and permitted tool profiles invalidate their own content versions', () => {
  const base = coordinatorPrefix('role', buildCoordinatorContext(snapshot()), tools);
  for (const change of [s => { s.memory.map.root.memoryDocument += '新约束'; },
    s => { s.memory.map.root.children[0].title = 'Authentication'; }]) {
    const changed = snapshot(); change(changed);
    assert.notEqual(coordinatorPrefix('role', buildCoordinatorContext(changed), tools).prefixHash, base.prefixHash);
  }
  assert.notEqual(coordinatorPrefix('new role', buildCoordinatorContext(snapshot()), tools).prefixHash, base.prefixHash);
  assert.notEqual(coordinatorPrefix('role', buildCoordinatorContext(snapshot()), []).prefixHash, base.prefixHash);
  assert.ok(Object.isFrozen(base.tools[0].input_schema));
  assert.deepEqual(tools[0].input_schema, { type: 'object', properties: {} }, 'caller-owned definitions are not mutated');
});

test('Restricted focus cannot read an unassigned module even if a conversation refers to it', () => {
  const context = buildCoordinatorContext(snapshot(), { nodeIds: ['N1'], conversation: { ...item, nodeId: 'N2' } });
  assert.doesNotMatch(context.text, /不可见记忆|Other \[N2\]/);
});

test('Missing Map produces stable unavailable context and preserves its version separately', () => {
  const a = buildCoordinatorContext({ version: 'a' }), b = buildCoordinatorContext({ version: 'b' });
  assert.equal(a.staticVersion, b.staticVersion);
  assert.match(a.dynamicText, /暂不可用/); assert.equal(b.version, 'b');
});

test('Fresh turns append Main snapshots and delivery metadata without rewriting earlier native history', async t => {
  let current = snapshot();
  const { service, calls } = await setup(t, { context: async () => buildCoordinatorContext(current, { conversation: item }) });
  await service.submit({ id: 'first', text: '进度如何' }, { source: 'slack', actor: {
    kind: 'human', integration: 'slack', teamId: 'TTEST', userId: 'UTEST', sessionId: 'slack:TTEST:UTEST',
  } }); await service.running;
  const original = JSON.parse(await fs.readFile(service.file, 'utf8')).messages;
  current = snapshot('v2', 'done');
  await service.submit({ id: 'second', text: '现在呢' }); await service.running;
  assert.equal(calls[0].system, calls[1].system);
  assert.deepEqual(calls[1].messages.slice(0, 1), calls[0].messages);
  assert.match(calls[0].messages[0].content, /输出来源：slack[\s\S]*状态：pending/);
  assert.match(calls[1].messages.at(-1).content, /输出来源：human[\s\S]*Main 版本：v2[\s\S]*状态：done/);
  const raw = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.deepEqual(raw.messages.slice(0, original.length), original);
  assert.equal(raw.messages[0].content, '进度如何', 'UI content stays natural language');
  assert.equal(raw.performance.models[0].prefix.systemHash, hash(calls[1].system));
  assert.equal((await service.state()).performance, undefined);
});

test('Retry after a provider failure reuses the accepted snapshot despite later Main changes', async t => {
  let current = snapshot(), n = 0; const calls = [];
  const { service } = await setup(t, { maxModelRetries: 0, context: async () => buildCoordinatorContext(current),
    model: { next: async request => { calls.push({ system: request.system, messages: structuredClone(request.messages) });
      if (++n === 1) throw Object.assign(new Error('synthetic'), { code: 'MODEL_UNAVAILABLE' });
      return structuredClone(answer); } } });
  await service.submit({ id: 'retry', text: '检查' }); await service.running;
  current = snapshot('v2', 'done');
  await service.submit({ id: 'retry', text: '检查', retry: true }); await service.running;
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(JSON.parse(await fs.readFile(service.file, 'utf8')).messages.filter(m => m.role === 'user').length, 1);
});

test('Main overview purpose enters fresh inputs but cannot rewrite accepted retry snapshots or cached envelopes', async t => {
  let current = snapshot(), attempts = 0; const calls = [];
  current.memory.map.root.children[0].todos[0].desc = '旧用途资料 v1.2，期限 2027-02-03';
  const { service } = await setup(t, { maxModelRetries: 0, context: async () => buildCoordinatorContext(current),
    model: { next: async request => {
      calls.push(structuredClone({ system: request.system, tools: request.tools, messages: request.messages }));
      if (++attempts === 1) throw Object.assign(new Error('synthetic'), { code: 'MODEL_UNAVAILABLE' });
      return structuredClone(answer);
    } } });
  await service.submit({ id: 'overview-first', text: '有哪些待办' }); await service.running;
  const accepted = JSON.parse(await fs.readFile(service.file, 'utf8')).messages[0];
  assert.equal(accepted.content, '有哪些待办');
  assert.match(calls[0].messages[0].content, /用途摘录：旧用途资料 v1.2，期限 2027-02-03/);
  current = snapshot('v2'); current.memory.map.root.children[0].todos[0].description = '新用途资料 v2.3，期限 2027-06-07';
  await service.submit({ id: 'overview-first', text: '有哪些待办', retry: true }); await service.running;
  assert.deepEqual(calls[1], calls[0], 'Retry uses the original accepted data, not latest item purposes');
  const before = JSON.parse(await fs.readFile(service.file, 'utf8')).messages;
  await service.submit({ id: 'overview-second', text: '现在呢' }); await service.running;
  assert.equal(calls.length, 3, 'No new model rewriting or formatting round is introduced');
  assert.equal(calls[2].system, calls[0].system); assert.deepEqual(calls[2].tools, calls[0].tools);
  assert.match(calls[2].messages.at(-1).content, /用途摘录：新用途资料 v2.3，期限 2027-06-07/);
  const after = JSON.parse(await fs.readFile(service.file, 'utf8')).messages;
  assert.deepEqual(after.slice(0, before.length), before); assert.deepEqual(after[0], accepted);
  assert.equal(after.filter(message => message.role === 'user').length, 2);
});

test('Legacy persisted contexts remain readable without guessing or rearranging their content', () => {
  const old = { version: 'old', text: '\nlegacy project state' };
  assert.ok(coordinatorPrefix('role', old, tools).system.endsWith(old.text));
  assert.equal(coordinatorModelMessages({ messages: [{ role: 'user', content: 'legacy input' }] })[0].content, 'legacy input');
});

test('Continuation inherits the exact prefix and transcript; a short child note only enters the new input', async t => {
  const { directory, service, calls } = await setup(t);
  await service.submit({ id: 'parent-first', text: '分析登录模块' }); await service.running;
  await new CoordinatorConversations(directory).continueIn('legacy', 'main');
  const childCalls = [];
  const child = new CoordinatorService({ directory: path.join(directory, 'main'), system: 'role', tools,
    context: async () => buildCoordinatorContext(snapshot('v2')), execute: async () => ({}),
    model: { next: async request => { childCalls.push(request); return structuredClone(answer); } } });
  t.after(() => child.close());
  assert.equal(childCalls.length, 0, 'creating continuation does not call provider');
  await child.submit({ id: 'child-first', text: '你是调查分身，不修改项目。\n调查竞态' }); await child.running;
  assert.equal(childCalls[0].system, calls[0].system);
  assert.deepEqual(childCalls[0].tools, calls[0].tools);
  assert.deepEqual(childCalls[0].messages.slice(0, 1), calls[0].messages);
  assert.match(childCalls[0].messages.at(-1).content, /你是调查分身/);
  assert.equal(JSON.parse(await fs.readFile(service.file, 'utf8')).messages.length, 2);
});

test('Native private blocks and paired tool receipts stay byte-equivalent across appended turns', async t => {
  let n = 0; const calls = [];
  const privateBlock = { type: 'thinking', thinking: 'synthetic private', signature: 'opaque' };
  const model = { next: async request => { calls.push(structuredClone(request.messages));
    return ++n === 1 ? { stop: 'tool_use', content: [privateBlock, { type: 'tool_use', id: 'read', name: 'read_map', input: {} }] }
      : structuredClone(answer); } };
  const { service } = await setup(t, { model });
  await service.submit({ id: 'tools', text: '读取模块' }); await service.running;
  await service.submit({ id: 'next', text: '继续' }); await service.running;
  assert.deepEqual(calls[1][1].content[0], privateBlock);
  assert.equal(calls[1][2].content[0].tool_use_id, 'read');
  assert.deepEqual(calls[2].slice(0, calls[1].length), calls[1]);
});

test('History compaction preserves static envelope and untouched retained tail, rejecting corrupted hashes', () => {
  const messages = [{ role: 'user', content: 'older' }, { role: 'assistant', content: answer.content },
    { role: 'user', content: 'new', serverContext: coordinatorInputContext(buildCoordinatorContext(snapshot('v2')), 'human') }];
  const original = structuredClone(messages);
  const state = { messages, compaction: { through: 2, summary: '旧讨论', sourceHash: hash(JSON.stringify(messages.slice(0, 2))) } };
  assert.deepEqual(coordinatorModelMessages(state).at(-1), coordinatorModelMessages({ messages }).at(-1));
  assert.deepEqual(messages, original);
  state.compaction.sourceHash = 'invalid';
  assert.throws(() => coordinatorModelMessages(state), { code: 'INVALID_COMPACTION' });
});

test('Stable catalog does not authorize Slack-only tools for a browser or forged actor', async () => {
  const catalog = [{ name: 'react_to_user' }, { name: 'show_model_menu' }];
  for (const name of catalog.map(t => t.name)) {
    const state = { activeTurnId: 't', activeInput: { id: 't', source: 'human' }, messages: [], toolReceipts: {} };
    await coordinatorStep({ turnId: 't', state, system: 'role', tools: catalog, save: async () => {},
      execute: () => assert.fail('Forbidden tool must not execute'), model: { next: async request => {
        assert.deepEqual(request.tools, catalog);
        return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'forged', name, input: {} }] };
      } } });
    assert.equal(Object.values(state.toolReceipts)[0].result.error.code, 'TOOL_FORBIDDEN');
  }
});

test('Diagnostics contain hashes, not prompts; OpenAI cache usage is recorded without inventing unavailable metrics', async () => {
  const state = { activeTurnId: 't', messages: [{ role: 'user', content: 'private text' }], toolReceipts: {} };
  await coordinatorStep({ turnId: 't', state, system: 'private system', tools, save: async () => {}, execute: async () => {},
    model: { next: async () => ({ ...answer, usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 } } }) } });
  const metric = state.performance.models[0];
  assert.equal(metric.cacheReadTokens, 1000); assert.equal(metric.inputTokens, 1200);
  assert.match(metric.prefix.envelopeHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(metric), /private text|private system/);
});
