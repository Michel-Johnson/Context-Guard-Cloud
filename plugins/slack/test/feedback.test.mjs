import '../../../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { SlackPlugin, envelopeId } from '../src/plugin.mjs';
import { slackReactionEmojis, slackStatusEmojis } from '../../../scripts/cloud/slack-reactions.mjs';

const team = 'TTEST', user = 'UTEST', bot = 'UBOT', channel = 'CTEST';
const event = extras => ({ type: 'message', channel, user, ts: '100.001', text: '收到后请判断是否回应', ...extras });
const platformError = error => Object.assign(Error('synthetic'), { code: 'slack_webapi_platform_error', data: { error } });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-slack-feedback-'));
  const store = await new Store(directory).open(), calls = [], present = new Set();
  const io = { call: async (method, input) => {
    calls.push({ method, ...input });
    const key = `${input.channel}:${input.timestamp}:${input.name}`;
    if (method === 'reactions.add') {
      if (present.has(key)) throw platformError('already_reacted'); present.add(key);
    } else if (method === 'reactions.remove') {
      if (!present.has(key)) throw platformError('no_reaction'); present.delete(key);
    }
    return {};
  } };
  const plugin = new SlackPlugin({ store, io, gateway: { command() { assert.fail('接收反馈不能等候或调用模型/Cloud'); } },
    teamId: team, botUserId: bot, cloudOrigin: 'https://example.invalid', logger: { warn() {}, error() {} } });
  plugin.kick = () => {}; plugin.stopped = false;
  t.after(async () => { await plugin.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const receive = async (e = event(), bodyTeam = team) => {
    const body = { team_id: bodyTeam, event: e }, id = envelopeId('events_api', body, 'synthetic-envelope');
    let acknowledged = false;
    await plugin.receive({ type: 'events_api', body, ack: async () => { acknowledged = true; } });
    assert.equal(acknowledged, true); return id;
  };
  const settle = async () => {
    for (let round = 0; round < 20; round++) {
      plugin.feedback.drain(); await Promise.all([...plugin.reactions]);
      if (!plugin.reactions.size) return;
    }
    assert.fail('反馈未收敛');
  };
  return { plugin, store, io, calls, present, directory, receive, settle };
}

test('真人新消息在无项目绑定、模型未启动和合批未到期时已有耐久 👀', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  assert.equal(Object.keys(f.store.data.threads).length, 0);
  assert.equal(f.store.data.inbox[id].status, 'pending');
  assert.ok(f.store.data.messageBatches[id].readyAt > f.store.data.inbox[id].at);
  assert.deepEqual(f.calls.map(c => [c.method, c.name]), [['reactions.add', 'eyes']]);
  assert.ok(f.store.data.feedback[id].firstAttemptAt - f.store.data.feedback[id].savedAt < 1000);
  assert.equal(f.store.data.feedback[id].applied.eyes, true);
});
test('原消息与👀意图一次持久提交，崩溃重启而无 Slack 重投仍可发送', async t => {
  const f = await fixture(t); f.plugin.stopped = true;
  let writes = 0; const update = f.store.update.bind(f.store);
  f.store.update = operation => { writes++; return update(operation); };
  const id = await f.receive(); assert.equal(writes, 1);
  const reopened = await new Store(f.directory).open();
  assert.ok(reopened.data.inbox[id]); assert.ok(reopened.data.feedback[id]);
  f.plugin.store = reopened; f.plugin.stopped = false;
  await f.settle(); assert.deepEqual(f.calls.map(c => c.name), ['eyes']);
});
for (const [desired, emoji] of [['silent', 'see_no_evil'], ['reply', 'speech_balloon'], ['failed', 'warning'], ['stopped', 'stop_sign']]) {
  test(`状态 ${desired} 先确认 ${emoji} 再移除仅本机器人 👀`, async t => {
    const f = await fixture(t), id = await f.receive(); await f.settle();
    await f.plugin.feedback.decide(id, desired, { inputRevision: 1, controlRevision: 0, requestId: 'original' }); await f.settle();
    assert.deepEqual(f.calls.map(c => [c.method, c.name]), [['reactions.add', 'eyes'], ['reactions.add', emoji], ['reactions.remove', 'eyes']]);
    assert.deepEqual([...f.present], [`${channel}:100.001:${emoji}`]);
    await f.plugin.feedback.decide(id, desired, { inputRevision: 1, controlRevision: 0 }); await f.settle();
    assert.equal(f.calls.length, 3, '工具续轮和重复状态不重复发送');
    assert.equal(f.calls.some(c => c.user !== undefined), false, '移除 API 不指定其他反应者');
  });
}
test('同一增量或迟到眼睛不能覆盖更新的决定，未知结果始终恢复原目标', async t => {
  const f = await fixture(t); let release, entered;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const call = f.io.call; f.io.call = async (method, input) => { if (method === 'reactions.add' && input.name === 'eyes') { entered(); await held; } return call(method, input); };
  t.after(() => release());
  const id = await f.receive(); await started;
  await f.plugin.feedback.decide(id, 'silent', { inputRevision: 2 });
  f.plugin.feedback.drain(); assert.equal(f.plugin.feedback.running.size, 1);
  release(); await f.settle();
  assert.deepEqual([...f.present], [`${channel}:100.001:see_no_evil`]);
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 }); await f.settle();
  assert.equal(f.calls.length, 3, '旧 revision 不回滚状态');
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 2 }); await f.settle();
  assert.equal(f.calls.length, 3, '相同 revision 的冲突终态不回滚状态');
});
test('重复事件与等价 app_mention 不重置已完成状态', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 }); await f.settle();
  await f.receive(event({ type: 'app_mention' })); await f.receive(); await f.settle();
  assert.equal(f.calls.length, 3); assert.equal(f.store.data.feedback[id].desired, 'reply');
});
test('失败/停止同版本不被旧决定覆盖，显式恢复的更高控制代次可接话', async t => {
  for (const terminal of ['failed', 'stopped']) {
    const f = await fixture(t), id = await f.receive(); await f.settle();
    await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1, controlRevision: 0 }); await f.settle();
    await f.plugin.feedback.decide(id, terminal, { inputRevision: 1, controlRevision: 0 }); await f.settle();
    const count = f.calls.length;
    for (const stale of ['reply', 'silent']) await f.plugin.feedback.decide(id, stale, { inputRevision: 1, controlRevision: 0 });
    await f.settle(); assert.equal(f.calls.length, count); assert.equal(f.store.data.feedback[id].desired, terminal);
    await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1, controlRevision: 1 }); await f.settle();
    assert.deepEqual([...f.present], [`${channel}:100.001:speech_balloon`]);
  }
});
for (const [label, extra, wrongTeam] of [['其他工作区', {}, 'TOTHER'], ['机器人', { bot_id: 'B1' }],
  ['自己', { user: bot }], ['编辑通知', { subtype: 'message_changed' }], ['隐藏事件', { hidden: true }],
  ['无真实用户', { user: 'invalid' }], ['无原生时间戳', { ts: 'command-1' }]]) {
  test(`不为 ${label} 创建反馈或扩大接收范围`, async t => {
    const f = await fixture(t); await f.receive(event(extra), wrongTeam || team); await f.settle();
    assert.deepEqual(f.calls, []); assert.deepEqual(f.store.data.feedback || {}, {});
  });
}
test('原事件篡改或伪造目标在平台调用前被拒绝', async t => {
  const f = await fixture(t); f.plugin.stopped = true; const id = await f.receive();
  await f.store.update(s => { s.inbox[id].envelope.body.event.user = 'UOTHER'; });
  f.plugin.stopped = false; await f.settle(); assert.deepEqual(f.calls, []);
  await f.store.update(s => { delete s.inbox[id]; });
  assert.equal(!!f.plugin.feedback.valid(id), false);
  await f.settle(); assert.deepEqual(f.calls, []);
});
test('失回与重启保留原平台操作，already_reacted / no_reaction 视为确认', async t => {
  const f = await fixture(t); let lose = true; const call = f.io.call;
  f.io.call = async (method, input) => { const result = await call(method, input); if (lose) { lose = false; throw TypeError('synthetic lost ack'); } return result; };
  const id = await f.receive(); await f.settle();
  assert.equal(f.store.data.feedback[id].pending.status, 'unknown');
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.store.update(s => { s.feedback[id].pending.next = 0; });
  await f.settle(); assert.equal(f.plugin.store.data.feedback[id].applied.eyes, true);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]);
  await f.plugin.feedback.decide(id, 'silent', { inputRevision: 1 });
  f.present.delete(`${channel}:100.001:eyes`); await f.settle();
  assert.equal(f.plugin.store.data.feedback[id].pending, null);
  assert.deepEqual([...f.present], [`${channel}:100.001:see_no_evil`]);
});
test('429 按 Retry-After 退避，永久权限拒绝不盲目重试', async t => {
  for (const kind of ['limited', 'forbidden']) {
    const f = await fixture(t); const call = f.io.call; let first = true;
    f.io.call = async (method, input) => {
      if (first) { first = false; if (kind === 'limited') throw Object.assign(Error(), { code: 'slack_webapi_rate_limited_error', retryAfter: 5 }); throw platformError('missing_scope'); }
      return call(method, input);
    };
    const id = await f.receive(); await f.settle(); const pending = f.store.data.feedback[id].pending;
    assert.equal(pending.status, kind === 'limited' ? 'unknown' : 'failed');
    if (kind === 'limited') {
      assert.ok(pending.next - pending.startedAt >= 5000); await f.store.update(s => { s.feedback[id].pending.next = 0; });
      await f.settle(); assert.equal(f.store.data.feedback[id].applied.eyes, true);
    } else { await f.settle(); assert.equal(f.calls.length, 0); }
  }
});
test('八槽并发和停用不丢待发意图，不越过在途请求预算', async t => {
  const f = await fixture(t); let release; const held = new Promise(r => { release = r; }); const call = f.io.call;
  f.io.call = async (method, input) => { await held; return call(method, input); }; t.after(() => release());
  for (let index = 0; index < 10; index++) await f.receive(event({ ts: `100.${String(index + 1).padStart(3, '0')}` }));
  assert.equal(f.plugin.reactions.size, 8); assert.equal(Object.keys(f.store.data.feedback).length, 10);
  f.plugin.stopped = true; release(); await Promise.all([...f.plugin.reactions]);
  assert.equal(f.calls.length, 8); f.plugin.stopped = false; await f.settle(); assert.equal(f.calls.length, 10);
});
test('状态与交流表情命名空间分离，原白名单和新增选项均保留', () => {
  assert.equal(slackReactionEmojis.length, 17);
  assert.ok(['thumbsup', 'heart', 'handshake', 'bulb', 'fire', 'joy', 'rocket'].every(name => slackReactionEmojis.includes(name)));
  assert.ok(Object.values(slackStatusEmojis).every(name => !slackReactionEmojis.includes(name)));
});
