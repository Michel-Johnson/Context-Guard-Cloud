import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { CoordinatorConversations, CoordinatorService, CoordinatorInbox } from '../scripts/cloud/coordinator-service.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';

test('Cloud close waits for in-flight automatic publication before releasing its data directory', { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-shutdown-'));
  const memory = path.join(root, 'memory');
  let entered, release, armed = false, stopped = false;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const stat = fs.stat;
  const interception = t.mock.method(fs, 'stat', async (file, ...args) => {
    if (armed && String(file).startsWith(memory + path.sep)) {
      armed = false; entered(); await blocked;
    }
    return stat(file, ...args);
  });
  let service;
  try {
    service = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir: root, adminToken: 'fixture-admin',
      memoryConfig: { dataDir: memory, adminToken: 'fixture-memory', projects: { 'context-guard': { token: 'fixture-project' } } } });
    armed = true;
    let deadline;
    try { await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Automatic publication did not start')), 3000); })]); }
    finally { clearTimeout(deadline); }
    const closed = service.close().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stopped, false, 'close must not release files while publication still uses them');
    release(); await closed;
    await service.close();
    assert.equal(stopped, true);
  } finally {
    release(); interception.mock.restore();
    await service?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Cloud close drains an interrupted HTTP write before restart and preserves its committed result', { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-request-drain-'));
  let entered, release, service, stopped = false;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const options = { host: '127.0.0.1', port: 0, dataDir: root, adminToken: 'fixture-admin' };
  try {
    service = await startCloudServer({ ...options, async faultInjector(stage) {
      if (stage === 'transaction-prepared') { entered(); await blocked; }
    } });
    const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
    const request = fetch(`${service.url}/api/projects/context-guard/commits`, {
      method: 'POST', headers, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ baseVersion: null, operationId: 'shutdown-write', operations: [{ type: 'initialize', project: 'Fixture', node: { id: 'T0', title: 'Drained write', kind: 'module', state: 'dirty', children: [] } }] }),
    }).then(response => response.text(), () => null);
    let timer;
    try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Write did not start')), 3000); })]); }
    finally { clearTimeout(timer); }
    const closing = service.close().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(stopped, false, 'socket closure is not completion of the write');
    release(); await closing; await request;
    service = await startCloudServer(options);
    const response = await fetch(`${service.url}/api/projects/context-guard/map`, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).document.root.title, 'Drained write');
  } finally {
    release(); await service?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// HTTP, Coordinator initialization and persistence are real. Only the paid
// provider and one owned persistence-read timing boundary are controlled.
for (const boundary of ['list', 'get']) test(`Cloud close drains delayed Coordinator ${boundary} startup and retires the old provider before restart`, { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-coordinator-startup-drain-'));
  const memory = path.join(root, 'memory'), providerFile = path.join(root, 'provider.json');
  let entered, release, service, closeRequested = false, closed = false, lateFactories = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const method = CoordinatorConversations.prototype[boundary];
  const interception = t.mock.method(CoordinatorConversations.prototype, boundary, async function (...args) {
    if (this.directory === path.join(root, 'coordinators', 'context-guard')) { entered(); await blocked; }
    return method.apply(this, args);
  });
  try {
    await fs.writeFile(providerFile, JSON.stringify({ model: 'fixture-model', token: 'synthetic', baseUrl: 'https://fixture.invalid' }));
    const memoryFile = legacyProjectMemoryFile(memory, 'context-guard');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'main-initial', memory: { records: {}, map: {
      project: 'Fixture', root: { id: 'T0', title: 'Restart ownership fixture', kind: 'module', state: 'dirty', owns: [], children: [] },
    } } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
    const options = { host: '127.0.0.1', port: 0, dataDir: root, adminToken: 'fixture-admin', browserToken: 'fixture-browser', privateAccess: true,
      memoryConfig: { dataDir: memory, adminToken: 'fixture-memory', projects: { 'context-guard': {
        token: 'fixture-project', root, ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {} },
      } } }, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/fixture' }] },
      coordinatorModelFactory: () => {
        if (closeRequested) lateFactories++;
        return { next: async () => assert.fail('Retired provider must not consume the new server input') };
      },
    };
    service = await startCloudServer(options);
    let timer;
    try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Coordinator startup barrier was not reached')), 3000); })]); }
    finally { clearTimeout(timer); }
    closeRequested = true;
    const closing = service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const prematureClose = closed;
    release(); await closing;
    // Allow an untracked initializer to expose itself on the unfixed source.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prematureClose, false, 'close cannot release persistence while Coordinator startup still owns it');
    assert.equal(lateFactories, 0, 'No old provider may be constructed once shutdown begins');
    interception.mock.restore();
    const before = await fs.readFile(memoryFile, 'utf8');
    let newModelCalls = 0;
    service = await startCloudServer({ ...options, coordinatorModelFactory: () => ({ next: async () => {
      newModelCalls++; return { stop: 'end_turn', content: [{ type: 'text', text: '新服务已处理本轮输入。' }] };
    } }) });
    const url = service.url + '/api/workbench/projects/context-guard/api/coordinator?conversation=main';
    const headers = { Authorization: 'Bearer fixture-browser', 'Content-Type': 'application/json' };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ id: 'restart-owned-input', text: '请由新服务回答。' }) });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 3000; let final;
    while (Date.now() < deadline) {
      final = await (await fetch(url, { headers })).json();
      if (final.status === 'waiting-for-user' && !final.activeTurnId && final.acceptedRequestIds.includes('restart-owned-input')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(final.status, 'waiting-for-user');
    assert.equal(final.messages.at(-1).text, '新服务已处理本轮输入。');
    assert.equal(newModelCalls, 1, 'The new generation alone handles the original durable input');
    assert.equal(lateFactories, 0);
    assert.equal(await fs.readFile(memoryFile, 'utf8'), before, 'Read-only restart must not change Main');
  } finally {
    release(); interception.mock.restore(); await service?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Cloud close cannot cycle between a late Coordinator initializer and its own Inbox', { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-coordinator-inbox-cycle-'));
  let releaseInitializer, enteredInitializer, reachedSelfWait, releaseCleanup, mainReturned;
  const held = new Promise(resolve => { releaseInitializer = resolve; });
  const reached = new Promise(resolve => { enteredInitializer = resolve; });
  const selfWait = new Promise(resolve => { reachedSelfWait = resolve; });
  const cleanupOnly = new Promise(resolve => { releaseCleanup = resolve; });
  const mainReady = new Promise(resolve => { mainReturned = resolve; });
  let service, initializing, pumping, closing, pumpRequested = false, mainGets = 0, closed = false;
  const state = CoordinatorService.prototype.state, get = CoordinatorConversations.prototype.get;
  const hooks = [t.mock.method(CoordinatorService.prototype, 'state', async function (...args) {
    if (this.file === path.join(root, 'coordinators', 'context-guard', 'conversation.json')) {
      initializing = this; enteredInitializer(); await held;
    }
    return state.apply(this, args);
  }), t.mock.method(CoordinatorConversations.prototype, 'get', async function (...args) {
    const result = await get.apply(this, args);
    if (pumpRequested && this.directory === path.join(root, 'coordinators', 'context-guard')) {
      if (args[0] === 'main' && ++mainGets === 2) setImmediate(mainReturned);
      if (args[0] === 'legacy') {
        // Main must finish both cached-get checks first. Otherwise a sibling
        // failure at shutdown could reject Promise.all and conceal this cycle.
        await mainReady; setImmediate(reachedSelfWait);
      }
    }
    return result;
  })];
  const bounded = async (promise, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 1500); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const memory = path.join(root, 'memory'), providerFile = path.join(root, 'provider.json');
    await fs.writeFile(providerFile, JSON.stringify({ model: 'fixture-model', token: 'synthetic', baseUrl: 'https://fixture.invalid' }));
    const file = legacyProjectMemoryFile(memory, 'context-guard'); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ revision: 1, main: { version: 'main-initial', memory: { records: {}, map: {
      project: 'Fixture', root: { id: 'T0', title: 'Fixture', kind: 'module', state: 'dirty', owns: [], children: [] },
    } } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
    const before = await fs.readFile(file, 'utf8');
    service = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir: root, adminToken: 'fixture-admin', browserToken: 'fixture-browser', privateAccess: true,
      memoryConfig: { dataDir: memory, adminToken: 'fixture-memory', projects: { 'context-guard': {
        token: 'fixture-project', root, ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {} },
      } } }, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/fixture' }] },
      coordinatorModelFactory: () => ({ next: async () => assert.fail('No model input is authorized') }),
    });
    await bounded(reached, 'Legacy initialization checkpoint was not reached');
    const main = await fetch(service.url + '/api/workbench/projects/context-guard/api/coordinator?conversation=main', { headers: { Authorization: 'Bearer fixture-browser' } });
    assert.equal(main.status, 200); await main.json();
    const inbox = initializing.inbox;
    if (inbox instanceof CoordinatorInbox) {
      // Exercise the actual failing dependency on old source. Cleanup escape
      // is held through every assertion and released only in finally.
      const closeInbox = inbox.close;
      hooks.push(t.mock.method(inbox, 'close', function (...args) { return Promise.race([closeInbox.apply(this, args), cleanupOnly]); }));
      pumpRequested = true; pumping = inbox.pump();
      await bounded(selfWait, 'Inbox did not reach its own cached initialization');
      assert.equal(mainGets, 2); assert.ok(inbox.running);
    }
    closing = service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const prematureClose = closed;
    releaseInitializer();
    await bounded(closing, 'Initialization waits for Inbox close while Inbox waits for the same initializer');
    await pumping;
    assert.equal(prematureClose, false, 'Shutdown still owns the blocked initializer');
    assert.equal(inbox, undefined, 'Do not register Inbox listeners before final asynchronous initialization checks');
    assert.equal(initializing.inbox, undefined, 'Shutdown cannot install a late Inbox');
    assert.equal(await fs.readFile(file, 'utf8'), before, 'Shutdown must preserve Main');
  } finally {
    releaseInitializer(); releaseCleanup();
    if (closing) await closing; else await service?.close();
    await pumping;
    for (const hook of hooks) hook.mock.restore();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
