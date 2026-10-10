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

test('重复反馈快照不写盘，新输入位置变化仍保存且不重复平台回应', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1, controlRevision: 0, requestId: 'original' }); await f.settle();
  const before = await fs.readFile(f.store.file), calls = f.calls.length, rename = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(fs, 'rename', async (...args) => { writes++; return rename(...args); });
  for (let index = 0; index < 5; index++) {
    await f.plugin.feedback.receive(id);
    await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1, controlRevision: 0 });
  }
  assert.equal(writes, 0); assert.deepEqual(await fs.readFile(f.store.file), before); assert.equal(f.calls.length, calls);
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 2, controlRevision: 0 });
  assert.equal(writes, 1);
  assert.equal((await new Store(f.directory).open()).data.feedback[id].inputRevision, 2);
});
for (const [desired, emoji] of [['silent', 'see_no_evil'], ['reply', 'speech_balloon'], ['completed', 'white_check_mark'], ['failed', 'warning'], ['stopped', 'stop_sign']]) {
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
test('回复完成后换成对勾，旧接话快照和新消息的全局版本不能重置旧原消息', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 }); await f.settle();
  await f.plugin.feedback.decide(id, 'completed', { inputRevision: 1 }); await f.settle();
  assert.deepEqual([...f.present], [`${channel}:100.001:white_check_mark`]);
  assert.deepEqual(f.calls.slice(-2).map(c => [c.method, c.name]), [['reactions.add', 'white_check_mark'], ['reactions.remove', 'speech_balloon']]);
  const count = f.calls.length;
  for (const desired of ['received', 'reply', 'silent', 'failed', 'stopped']) {
    await f.plugin.feedback.decide(id, desired, { inputRevision: 2, controlRevision: 0 });
  }
  await f.receive(); await f.settle();
  assert.equal(f.calls.length, count); assert.equal(f.store.data.feedback[id].desired, 'completed');
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 2, controlRevision: 1 }); await f.settle();
  assert.deepEqual([...f.present], [`${channel}:100.001:speech_balloon`]);
});
test('失败或停止不能被同代次的迟到完成快照标成对勾', async t => {
  for (const terminal of ['failed', 'stopped']) {
    const f = await fixture(t), id = await f.receive(); await f.settle();
    await f.plugin.feedback.decide(id, terminal, { inputRevision: 1 }); await f.settle();
    await f.plugin.feedback.decide(id, 'completed', { inputRevision: 1 }); await f.settle();
    assert.equal(f.store.data.feedback[id].desired, terminal);
    assert.equal(f.calls.some(c => c.name === 'white_check_mark'), false);
  }
});
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

async function restartFeedback(t, f) {
  await f.plugin.stop();
  const store = await new Store(f.directory).open();
  const plugin = new SlackPlugin({ store, io: f.io, gateway: f.plugin.gateway,
    teamId: team, botUserId: bot, cloudOrigin: 'https://example.invalid', logger: { warn() {}, error() {} } });
  plugin.kick = () => {}; plugin.stopped = false;
  t.after(() => plugin.stop());
  return { plugin, store, settle: async () => {
    plugin.feedback.drain(); await Promise.all([...plugin.reactions]); await store.tail;
  } };
}

test('重复反馈决定和既有接收只复制原记录，不复制整个账本或重发平台操作', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  await f.plugin.feedback.decide(id, 'completed', { inputRevision: 2 }); await f.settle();
  const original = await fs.readFile(f.store.file), state = f.store.data, count = f.calls.length;
  const clone = structuredClone, copies = [];
  t.mock.method(globalThis, 'structuredClone', value => {
    assert.equal(value, f.store.data.feedback[id], '只复制当前反馈，不复制 Inbox、其他线程或整份账本');
    copies.push(value); return clone(value);
  });
  await f.plugin.feedback.receive(id);
  await f.plugin.feedback.decide(id, 'completed', { inputRevision: 2 });
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 });
  await f.settle();
  assert.equal(copies.length, 3); assert.equal(f.store.data, state);
  assert.equal(f.calls.length, count); assert.deepEqual(await fs.readFile(f.store.file), original);
});

test('反馈队列内再次核验原目标，迟到决定不借用被改变的消息身份', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const preceding = f.store.update(async state => { entered(); await gate; state.feedback[id].userId = 'UOTHER'; });
  await ready;
  const decision = f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 });
  release(); await Promise.all([preceding, decision]);
  assert.equal(f.store.data.feedback[id].desired, 'received');
  await assert.rejects(f.plugin.feedback.receive(id), { code: 'ID_REUSED' });
  const restarted = await new Store(f.directory).open();
  assert.equal(restarted.data.feedback[id].desired, 'received');
  assert.equal(restarted.data.feedback[id].userId, 'UOTHER');
});

test('完成对勾添加失回后重启确认原操作，再移除本机器人接话状态', async t => {
  const f = await fixture(t), id = await f.receive(); await f.settle();
  await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 }); await f.settle();
  const otherReaction = `${channel}:100.001:speech_balloon:UOTHER`;
  f.present.add(otherReaction);
  const call = f.io.call, attempts = []; let lose = true;
  f.io.call = async (method, input) => {
    attempts.push({ method, ...input });
    const result = await call(method, input);
    if (lose && method === 'reactions.add' && input.name === 'white_check_mark') {
      lose = false; throw TypeError('synthetic completed add acknowledgement lost');
    }
    return result;
  };
  await f.plugin.feedback.decide(id, 'completed', { inputRevision: 1 }); await f.settle();
  const pending = structuredClone(f.store.data.feedback[id].pending);
  assert.equal(pending.status, 'unknown'); assert.equal(pending.method, 'add');
  assert.equal(pending.emoji, 'white_check_mark'); assert.equal(pending.attempts, 1);
  assert.equal(f.store.data.feedback[id].applied.speech_balloon, true);
  assert.deepEqual(attempts, [{ method: 'reactions.add', channel, timestamp: '100.001', name: 'white_check_mark' }]);
  assert.ok(f.present.has(`${channel}:100.001:speech_balloon`));
  assert.ok(f.present.has(`${channel}:100.001:white_check_mark`));

  const resumed = await restartFeedback(t, f);
  assert.deepEqual(resumed.store.data.feedback[id].pending, pending);
  await resumed.store.update(state => { state.feedback[id].pending.next = 0; });
  await resumed.settle();
  assert.deepEqual(attempts, [attempts[0], attempts[0],
    { method: 'reactions.remove', channel, timestamp: '100.001', name: 'speech_balloon' }]);
  const record = resumed.store.data.feedback[id];
  assert.equal(record.desired, 'completed'); assert.equal(record.pending, null);
  assert.equal(record.applied.white_check_mark, true); assert.equal(record.applied.speech_balloon, false);
  assert.deepEqual(record.receipts.slice(-2).map(receipt => [receipt.method, receipt.emoji, receipt.attempts]),
    [['add', 'white_check_mark', 2], ['remove', 'speech_balloon', 1]]);
  assert.deepEqual([...f.present].sort(), [otherReaction, `${channel}:100.001:white_check_mark`].sort());
  assert.ok(attempts.every(operation => operation.user === undefined));
  await resumed.settle(); assert.equal(attempts.length, 3, '重复恢复不重发已确认状态');
});

for (const failure of ['lost-ack', 'rate-limited']) {
  test(`完成后移除接话状态 ${failure}，重启只恢复原目标且保留他人反应`, async t => {
    const f = await fixture(t), id = await f.receive(); await f.settle();
    await f.plugin.feedback.decide(id, 'reply', { inputRevision: 1 }); await f.settle();
    const otherReactions = [`${channel}:100.001:speech_balloon:UOTHER`, `${channel}:100.001:heart:UOTHER`];
    for (const reaction of otherReactions) f.present.add(reaction);
    const call = f.io.call, attempts = []; let first = true;
    f.io.call = async (method, input) => {
      attempts.push({ method, ...input });
      if (first && method === 'reactions.remove' && input.name === 'speech_balloon') {
        first = false;
        if (failure === 'rate-limited') throw Object.assign(Error('synthetic remove limited'), {
          code: 'slack_webapi_rate_limited_error', retryAfter: 7 });
        await call(method, input); throw TypeError('synthetic completed remove acknowledgement lost');
      }
      return call(method, input);
    };
    await f.plugin.feedback.decide(id, 'completed', { inputRevision: 1 }); await f.settle();
    const pending = structuredClone(f.store.data.feedback[id].pending);
    assert.equal(pending.status, 'unknown'); assert.equal(pending.method, 'remove');
    assert.equal(pending.emoji, 'speech_balloon'); assert.equal(pending.attempts, 1);
    assert.equal(f.store.data.feedback[id].applied.white_check_mark, true);
    assert.equal(f.store.data.feedback[id].applied.speech_balloon, true, '未知移除不伪造确认');
    assert.equal(f.present.has(`${channel}:100.001:speech_balloon`), failure === 'rate-limited');
    if (failure === 'rate-limited') assert.ok(pending.next - pending.startedAt >= 7000);
    assert.deepEqual(attempts, [
      { method: 'reactions.add', channel, timestamp: '100.001', name: 'white_check_mark' },
      { method: 'reactions.remove', channel, timestamp: '100.001', name: 'speech_balloon' },
    ]);

    const resumed = await restartFeedback(t, f);
    assert.deepEqual(resumed.store.data.feedback[id].pending, pending);
    await resumed.settle(); assert.equal(attempts.length, 2, '退避期内重启不绕过原截止时间');
    await resumed.store.update(state => { state.feedback[id].pending.next = 0; });
    await resumed.settle();
    assert.deepEqual(attempts[2], attempts[1], '失回或限流都只重放同频道、时间戳、表情的移除操作');
    const record = resumed.store.data.feedback[id];
    assert.equal(record.desired, 'completed'); assert.equal(record.pending, null);
    assert.equal(record.applied.white_check_mark, true); assert.equal(record.applied.speech_balloon, false);
    assert.deepEqual(record.receipts.slice(-2).map(receipt => [receipt.method, receipt.emoji, receipt.attempts]),
      [['add', 'white_check_mark', 1], ['remove', 'speech_balloon', 2]]);
    assert.deepEqual([...f.present].sort(), [...otherReactions, `${channel}:100.001:white_check_mark`].sort());
    assert.ok(attempts.every(operation => operation.user === undefined));
    await resumed.settle(); assert.equal(attempts.length, 3, '已确认移除不再重放');
  });
}
