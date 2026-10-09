import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new Store(directory).open();
}

function platform(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('Store persists receipts and thread bindings across restart without duplicate acceptance', async t => {
  const store = await fixture(t);
  assert.equal(await store.receive('event-1', { text: 'fixture' }), true);
  await store.bind('team:channel:thread', { projectId: 'project', conversationId: 'conversation' });
  const restarted = await new Store(store.directory).open();
  assert.deepEqual(restarted.data, store.data);
  assert.equal(await restarted.receive('event-1', { text: 'duplicate' }), false);
  assert.equal(restarted.data.inbox['event-1'].envelope.text, 'fixture');
  assert.equal(restarted.data.threads['team:channel:thread'].conversationId, 'conversation');
});

test('Windows flushes the temporary file and atomically renames without opening the directory', async t => {
  platform(t, 'win32');
  const store = await fixture(t), steps = [];
  const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    assert.notEqual(file, store.directory, 'Windows must not attempt directory fsync');
    const handle = await open(file, ...args);
    const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
    t.mock.method(handle, 'sync', async () => { steps.push('file-sync'); await sync(); });
    t.mock.method(handle, 'close', async () => { steps.push('file-close'); await close(); });
    return handle;
  });
  t.mock.method(fs, 'rename', async (...args) => { steps.push('rename'); await rename(...args); });
  assert.equal(await store.receive('event-1', {}), true);
  assert.deepEqual(steps, ['file-sync', 'file-close', 'rename']);
  assert.equal((await new Store(store.directory).open()).data.inbox['event-1'].status, 'pending');
});

for (const host of ['win32', 'linux']) {
  test(`${host} file fsync failure rejects acknowledgement and leaves published state unchanged`, async t => {
    platform(t, host);
    const store = await fixture(t);
    const open = fs.open.bind(fs), error = Object.assign(new Error('file flush failed'), { code: 'EPERM' });
    let closed = false, renamed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
      assert.notEqual(file, store.directory, 'failed file flush must never reach directory sync');
      const handle = await open(file, ...args), close = handle.close.bind(handle);
      t.mock.method(handle, 'sync', async () => { throw error; });
      t.mock.method(handle, 'close', async () => { closed = true; await close(); });
      return handle;
    });
    t.mock.method(fs, 'rename', async () => { renamed = true; });
    await assert.rejects(store.receive('event-1', {}), error);
    assert.equal(closed, true);
    assert.equal(renamed, false);
    assert.equal(store.data.inbox['event-1'], undefined);
    await assert.rejects(fs.access(store.file), { code: 'ENOENT' });
    assert.equal((await new Store(store.directory).open()).data.inbox['event-1'], undefined);
  });
}

test('Unix directory fsync failure rejects acknowledgement and closes its handle', async t => {
  platform(t, 'linux');
  const store = await fixture(t), open = fs.open.bind(fs);
  const error = Object.assign(new Error('directory flush failed'), { code: 'EPERM' });
  let directoryClosed = false, directorySynced = false, failDirectory = true;
  t.mock.method(fs, 'open', async (file, ...args) => file !== store.directory ? open(file, ...args) : {
    async sync() { directorySynced = true; if (failDirectory) throw error; },
    async close() { directoryClosed = true; },
  });
  await assert.rejects(store.receive('event-1', {}), error);
  assert.equal(directorySynced, true);
  assert.equal(directoryClosed, true);
  assert.equal(store.data.inbox['event-1'], undefined, 'no in-memory acknowledgement before durable completion');
  // Rename already succeeded: a restart may recover that unacknowledged event.
  // Retrying its original ID must not accept it twice.
  const restarted = await new Store(store.directory).open();
  assert.equal(restarted.data.inbox['event-1'].status, 'pending');
  failDirectory = false;
  assert.equal(await restarted.receive('event-1', {}), false);
});

test('只刷新线程轮询时间不写盘，业务字段变化仍耐久保存', async t => {
  const store = await fixture(t), key = 'thread';
  await store.bind(key, { projectId: 'project', conversationId: 'conversation', status: 'idle', nextPoll: 0 });
  const before = await fs.readFile(store.file), rename = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(fs, 'rename', async (...args) => { writes++; return rename(...args); });
  assert.equal(await store.updateThread(key, thread => { thread.nextPoll = 1234; thread.nextItemPoll = 5678; return 'clock'; }), 'clock');
  assert.equal(writes, 0); assert.deepEqual(await fs.readFile(store.file), before);
  assert.equal(store.data.threads[key].nextPoll, 1234);
  assert.equal((await new Store(store.directory).open()).data.threads[key].nextPoll, 0, '重启只提前只读核对，不丢业务状态');
  await store.updateThread(key, thread => { thread.pendingQuestionId = 'question'; thread.nextPoll = 9999; });
  assert.equal(writes, 1);
  const restarted = await new Store(store.directory).open();
  assert.equal(restarted.data.threads[key].pendingQuestionId, 'question'); assert.equal(restarted.data.threads[key].nextPoll, 9999);
});

test('无变化事务和重复已保存输入不写盘，新输入仍在耐久发布后返回', async t => {
  const store = await fixture(t);
  await store.receive('original-input', { text: 'original synthetic text' });
  const before = await fs.readFile(store.file), originalState = store.data, rename = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(fs, 'rename', async (...args) => { writes++; return rename(...args); });
  assert.equal(await store.update(state => { state.inbox['original-input'].status = 'pending'; return 'existing'; }), 'existing');
  assert.equal(await store.receive('original-input', { text: 'different replay body' }), false);
  assert.equal(writes, 0); assert.equal(store.data, originalState); assert.deepEqual(await fs.readFile(store.file), before);
  assert.equal(await store.receive('new-input', { text: 'new synthetic text' }), true);
  assert.equal(writes, 1);
  const restarted = await new Store(store.directory).open();
  assert.equal(restarted.data.inbox['original-input'].envelope.text, 'original synthetic text');
  assert.equal(restarted.data.inbox['new-input'].status, 'pending');
});

test('线程时钟更新与全局回执共用串行队列，不丢新输入或复活删除的线程', async t => {
  const store = await fixture(t), key = 'thread';
  await store.bind(key, { projectId: 'project', conversationId: 'conversation' });
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const clock = store.updateThread(key, async thread => { entered(); await gate; thread.nextPoll = 1234; });
  await ready;
  const receipt = store.receive('new-input', { text: 'synthetic' });
  release(); await Promise.all([clock, receipt]);
  assert.equal(store.data.inbox['new-input'].status, 'pending'); assert.equal(store.data.threads[key].nextPoll, 1234);
  assert.deepEqual((await new Store(store.directory).open()).data, store.data);
  await store.update(data => { delete data.threads[key]; });
  await store.updateThread(key, () => assert.fail('已删除线程不能重新建立'));
  assert.equal((await new Store(store.directory).open()).data.threads[key], undefined);
});

test('线程业务字段必须 fsync，失败不发布内存状态且原队列可继续', async t => {
  const store = await fixture(t), key = 'thread';
  await store.bind(key, { projectId: 'project', conversationId: 'conversation', live: false });
  const original = await fs.readFile(store.file), open = fs.open.bind(fs);
  let rejectSync = true;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), sync = handle.sync.bind(handle);
    t.mock.method(handle, 'sync', async () => { if (rejectSync) throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' }); return sync(); });
    return handle;
  });
  await assert.rejects(store.updateThread(key, thread => { thread.live = true; thread.inputRevision = 2; }), { code: 'EIO' });
  assert.equal(store.data.threads[key].live, false); assert.deepEqual(await fs.readFile(store.file), original);
  rejectSync = false;
  await store.updateThread(key, thread => { thread.live = true; thread.inputRevision = 2; });
  assert.equal((await new Store(store.directory).open()).data.threads[key].inputRevision, 2);
});

test('空闲更新只复制目标线程，保留其余记录和业务身份的耐久校验', async t => {
  const store = await fixture(t);
  await store.bind('one', { projectId: 'one', conversationId: 'conversation-one' });
  await store.bind('two', { projectId: 'two', conversationId: 'conversation-two' });
  await store.update(data => { data.threads.one.mirrored.reply = { ts: '1.1' }; });
  const inbox = store.data.inbox, other = store.data.threads.two;
  await store.updateThread('one', thread => { thread.nextPoll = 1000; });
  assert.equal(store.data.inbox, inbox); assert.equal(store.data.threads.two, other);
  await assert.rejects(store.updateThread('one', thread => { thread.projectId = 'changed'; throw new Error('synthetic callback failure'); }), /synthetic callback failure/);
  assert.equal(store.data.threads.one.projectId, 'one');
  await store.updateThread('one', thread => { thread.mirrored.reply.hash = 'delivered'; });
  assert.equal((await new Store(store.directory).open()).data.threads.one.mirrored.reply.hash, 'delivered');
});

test('反馈更新只复制目标记录，无变化不换账本，回执变化仍耐久保存', async t => {
  const store = await fixture(t);
  await store.receive('one', { text: 'synthetic' }, { feedback: { channel: 'CTEST', timestamp: '1.1' } });
  await store.receive('two', { text: 'other synthetic' }, { feedback: { channel: 'CTEST', timestamp: '1.2' } });
  const originalState = store.data, inbox = store.data.inbox, other = store.data.feedback.two;
  const clone = structuredClone, copies = [], rename = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(globalThis, 'structuredClone', value => {
    assert.notEqual(value, store.data, '不复制整个账本'); copies.push(value); return clone(value);
  });
  t.mock.method(fs, 'rename', async (...args) => { writes++; return rename(...args); });
  assert.equal(await store.updateFeedback('one', item => { item.desired = 'received'; return 'unchanged'; }), 'unchanged');
  assert.equal(store.data, originalState); assert.equal(writes, 0);
  await store.updateFeedback('one', item => { item.pending = { status: 'unknown', attempts: 1 }; });
  assert.equal(writes, 1); assert.equal(store.data.inbox, inbox); assert.equal(store.data.feedback.two, other);
  assert.deepEqual(copies, [originalState.feedback.one, originalState.feedback.one]);
  const restarted = await new Store(store.directory).open();
  assert.equal(restarted.data.feedback.one.pending.status, 'unknown');
  assert.equal(restarted.data.feedback.two.timestamp, '1.2');
});

test('反馈事务与新输入共用串行队列，读取最新记录，删除后不复活', async t => {
  const store = await fixture(t);
  await store.receive('one', {}, { feedback: { channel: 'CTEST', timestamp: '1.1' } });
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const preceding = store.update(async state => { entered(); await gate; state.feedback.one.inputRevision = 3; });
  await ready;
  const changed = store.updateFeedback('one', item => { assert.equal(item.inputRevision, 3); item.desired = 'reply'; });
  const accepted = store.receive('two', {}, { feedback: { channel: 'CTEST', timestamp: '1.2' } });
  release(); await Promise.all([preceding, changed, accepted]);
  assert.equal(store.data.feedback.one.desired, 'reply');
  assert.equal(store.data.inbox.two.status, 'pending'); assert.equal(store.data.feedback.two.desired, 'received');
  assert.deepEqual((await new Store(store.directory).open()).data, store.data);
  const removed = store.update(state => { delete state.feedback.one; });
  const late = store.updateFeedback('one', () => assert.fail('已删除记录不能重新建立'));
  await Promise.all([removed, late]);
  assert.equal((await new Store(store.directory).open()).data.feedback.one, undefined);
});

test('反馈保存与回调失败均不发布内存状态，原串行队列仍可继续', async t => {
  const store = await fixture(t);
  await store.receive('one', {}, { feedback: { channel: 'CTEST', timestamp: '1.1' } });
  const original = await fs.readFile(store.file), open = fs.open.bind(fs);
  let rejectSync = true;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), sync = handle.sync.bind(handle);
    t.mock.method(handle, 'sync', async () => { if (rejectSync) throw Object.assign(Error('synthetic fsync failure'), { code: 'EIO' }); return sync(); });
    return handle;
  });
  await assert.rejects(store.updateFeedback('one', item => { item.pending = { status: 'sending' }; }), { code: 'EIO' });
  assert.equal(store.data.feedback.one.pending, null); assert.deepEqual(await fs.readFile(store.file), original);
  await assert.rejects(store.updateFeedback('one', item => { item.channel = 'OTHER'; throw Error('synthetic callback failure'); }), /synthetic callback failure/);
  assert.equal(store.data.feedback.one.channel, 'CTEST');
  rejectSync = false;
  await store.updateFeedback('one', item => { item.pending = { status: 'unknown' }; });
  assert.equal((await new Store(store.directory).open()).data.feedback.one.pending.status, 'unknown');
});
