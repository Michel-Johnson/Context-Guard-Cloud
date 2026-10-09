import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';

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
