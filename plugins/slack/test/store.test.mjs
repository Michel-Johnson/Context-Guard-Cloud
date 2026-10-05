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
