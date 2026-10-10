import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorService, coordinatorCanAutoResume } from '../scripts/cloud/coordinator-service.mjs';
const text = value => ({ stop: 'end_turn', content: [{ type: 'text', text: value }] });
async function fixture(t, next, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-length-correction-'));
  const writes = [], snapshots = [];
  const settings = { directory, system: 'Test Coordinator', tools: [{ name: 'write' }], model: { next },
    execute: async (name, input) => { writes.push({ name, input }); return { saved: true }; },
    maxModelRetries: 2, retryDelayMs: 0, steerSettleMs: 0, validateReplies: true, ...options };
  const service = new CoordinatorService(settings), save = service.saveState.bind(service);
  service.saveState = async state => { snapshots.push(structuredClone(state)); return save(state); };
  t.after(async () => { await service.close({ stop: true }); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, settings, writes, snapshots };
}
async function submit(service, source = 'human') {
  const value = '简短总结需求';
  if (source === 'human') return service.submit({ id: 'input', text: value });
  return service.submit({ id: 'batch', inputs: [{ id: 'input', text: value }] }, { source: 'slack',
    actor: { kind: 'human', integration: 'slack', teamId: 'TTEST', userId: 'UTEST', channelId: 'DTEST', sessionId: 'slack:TTEST:UTEST' },
    participation: { text: value, inputs: [{ id: 'input', text: value }], context: [], files: [],
      routing: { coordinatorUserId: 'UBOT', mentionedUsers: [], replyToCoordinator: false } } });
}
for (const source of ['human', 'slack']) test(`${source}: repeated oversized replies retain the original input until a short reply succeeds`, { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    count++; assert.match(JSON.stringify(request.messages), /简短总结需求/);
    if (count > 1) {
      assert.match(JSON.stringify(request.messages), /REPLY_PARAGRAPH_LONG/);
      assert.match(JSON.stringify(request.messages), /rejectedText/);
      assert.match(request.system, /重新表达/);
    }
    return text((source === 'slack' ? '[CG_REPLY]\n' : '') + (count <= 4 ? '长'.repeat(61) : '文章页问答，引用可点回原文。'));
  }, { maxSteps: 1, maxModelRetries: 0 });
  await submit(f.service, source); await f.service.close();
  const state = await f.service.state(), stored = await f.service.readConversation();
  assert.equal(count, 5); assert.equal(state.status, 'waiting-for-user'); assert.equal(state.error, null);
  assert.equal(state.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(state.messages.at(-1).text, '文章页问答，引用可点回原文。');
  assert.equal(stored.messages.filter(m => m.role === 'user').length, 1);
  assert.ok(!JSON.stringify(stored.messages).includes('rejectedText'));
  assert.ok(f.snapshots.every(s => s.status !== 'error')); assert.deepEqual(f.writes, []);
});
test('too many paragraphs are corrected beyond the ordinary retry budget', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => text(++count <= 4 ? '入口在文章页。\n\n仅检索公开文章。\n\n引用点回原文。' : '只保留两个重点。'));
  await submit(f.service); await f.service.close();
  assert.equal(count, 5); assert.equal((await f.service.state()).messages.at(-1).text, '只保留两个重点。');
});
test('length correction does not consume later transient failure retries', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    if (++count <= 4) return text('长'.repeat(61));
    if (count <= 6) throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' });
    return text('已继续。');
  });
  await submit(f.service); await f.service.close();
  assert.equal(count, 7); assert.equal((await f.service.state()).status, 'waiting-for-user');
});
test('transient model faults remain bounded instead of retrying forever', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; throw Object.assign(new Error('synthetic timeout'), { code: 'MODEL_TIMEOUT' }); });
  await submit(f.service); await f.service.close();
  assert.equal(count, 3); assert.equal((await f.service.state()).status, 'error'); assert.deepEqual(f.writes, []);
});
test('continued length correction reuses a completed write even if the model changes its call ID', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    count++;
    if (count === 1 || count === 6) return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'write-' + count, name: 'write', input: { value: 'confirmed' } }] };
    return text(count <= 5 ? '长'.repeat(61) : '已保存。');
  });
  await submit(f.service); await f.service.close();
  assert.equal(count, 7); assert.equal(f.writes.length, 1);
  assert.ok(Object.values((await f.service.readConversation()).toolReceipts).some(r => r.replayedFrom));
  assert.equal((await f.service.state()).messages.at(-1).text, '已保存。');
});
test('human can interrupt length correction after more than two rejected replies', { timeout: 10000 }, async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    if (++count === 4) await f.service.interrupt({ id: 'stop', expectedTurnId: 'input' });
    return text('长'.repeat(61));
  });
  await submit(f.service); await f.service.close();
  assert.equal(count, 4); assert.equal((await f.service.state()).status, 'interrupted'); assert.deepEqual(f.writes, []);
  assert.equal((await f.service.state()).messages.filter(m => m.role === 'assistant' && !m.partial).length, 0);
});
test('restart recovers an old exhausted length correction without widening other recovery', { timeout: 10000 }, async t => {
  const failed = { status: 'error', activeTurnId: 'input', activeInput: { id: 'input', text: '简短总结需求', source: 'human' },
    messages: [{ role: 'user', requestId: 'input', content: '简短总结需求' }], requests: {}, toolReceipts: {}, steps: 0, modelRetries: 2,
    error: { code: 'MODEL_INVALID_RESPONSE', recoverable: true, diagnostic: { validationCode: 'REPLY_PARAGRAPH_LONG' } },
    modelRepairCode: 'REPLY_PARAGRAPH_LONG', modelRepairText: '长'.repeat(61) };
  assert.equal(coordinatorCanAutoResume(failed), true);
  assert.equal(coordinatorCanAutoResume({ ...failed, pending: { id: 'unresolved' } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, operatorRecovery: { initialAccepted: false } }), false);
  assert.equal(coordinatorCanAutoResume({ ...failed, error: { ...failed.error, diagnostic: { validationCode: 'TOOL_INVALID' } } }), false);
  const f = await fixture(t, async request => { assert.match(JSON.stringify(request.messages), /rejectedText/); return text('已压缩。'); });
  await f.service.saveState(failed); f.service.kick(); await f.service.close();
  assert.equal((await f.service.state()).status, 'waiting-for-user'); assert.equal((await f.service.state()).messages.at(-1).text, '已压缩。');
});
test('shutdown stops length correction and restart continues the saved original turn', { timeout: 10000 }, async t => {
  let count = 0, reached, release;
  const ready = new Promise(resolve => { reached = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => {
    if (++count === 4) { reached(); await paused; }
    return text(count <= 4 ? '长'.repeat(61) : '已压缩。');
  });
  t.after(() => release()); await submit(f.service); await ready;
  const closing = f.service.close({ stop: true }); release(); await closing;
  assert.equal(count, 4); assert.equal((await f.service.readConversation()).modelRepairCode, 'REPLY_PARAGRAPH_LONG');
  const restarted = new CoordinatorService(f.settings); t.after(() => restarted.close({ stop: true }));
  restarted.kick(); await restarted.close();
  assert.equal(count, 5); assert.equal((await restarted.state()).messages.at(-1).text, '已压缩。'); assert.deepEqual(f.writes, []);
});
