import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorConversations, CoordinatorService, publicMessages } from '../scripts/cloud/coordinator-service.mjs';
import { CoordinatorModel, coordinatorModelMessages } from '../scripts/cloud/coordinator-model.mjs';
import { hash } from '../scripts/shared/io.mjs';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const answer = text => ({ stop: 'end_turn', content: [{ type: 'text', text }] });
const tool = id => ({ type: 'tool_use', id, name: 'write', input: { id } });
async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-steer-'));
  t.after(() => fs.rm(value, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return value;
}

test('Conversation focus survives restart for automatic chats, Main, legacy and Session without creating items', async t => {
  const root = await directory(t), registry = new CoordinatorConversations(root);
  const automatic = await registry.createChat('automatic-focus');
  const manual = await registry.createChat('manual-focus', { executionMode: 'manual' });
  const session = await registry.ensureSession('focus-session');
  for (const id of [automatic, manual, 'main', 'legacy', session]) {
    await registry.setFocus(id, { nodeId: 'N1', kind: 'bug', itemId: 'old-item', title: 'Old topic' });
    await registry.setFocus(id, { nodeId: 'N2', kind: 'todo', title: 'New topic' });
    const restarted = new CoordinatorConversations(root), focused = await restarted.get(id);
    assert.equal(focused.nodeId, 'N2'); assert.equal(focused.kind, 'todo'); assert.equal(focused.title, 'New topic');
    assert.equal(focused.itemId, undefined, 'Changing node focus must clear an obsolete item identity');
    assert.equal((await restarted.list()).find(value => value.id === id).nodeId, 'N2');
  }
  const saved = await registry.state();
  assert.deepEqual(saved.items, {}, 'Mounting focus never creates a work item');
  assert.deepEqual(saved.tasks, {}, 'Mounting focus never creates an execution task');
  assert.equal((await registry.get(manual)).executionMode, 'manual');
  assert.equal((await registry.get(automatic)).executionMode, undefined, 'Automatic mode is not downgraded');
  await assert.rejects(registry.setFocus('unknown', { nodeId: 'N1', kind: 'todo' }), { code: 'FORBIDDEN' });
  await assert.rejects(registry.setFocus('main', { nodeId: '', kind: 'todo' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(registry.setFocus('main', { nodeId: 'N1', kind: 'unknown' }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await registry.get('main')).nodeId, 'N2', 'Rejected updates retain the last saved focus');
});

test('A published terminal turn drains its runner before accepting the next message', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), draining = deferred();
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [],
    execute: async () => {}, model: { next: async () => answer('done') } });
  t.after(() => { release.resolve(); return service.close(); });
  const save = service.saveState.bind(service); let terminalWrites = 0;
  service.saveState = async state => {
    await save(state);
    if (state.status === 'waiting-for-user' && !state.activeTurnId && ++terminalWrites === 2) {
      entered.resolve(); await release.promise;
    }
  };
  await service.submit({ id: 'first', text: 'first message' }); await entered.promise;
  const runner = service.running;
  service.running = { then(resolve, reject) { draining.resolve(); return runner.then(resolve, reject); }, catch: runner.catch.bind(runner) };
  const next = service.submit({ id: 'second', text: 'second message' });
  await Promise.race([draining.promise, next.then(() => assert.fail('Cannot accept before the old runner exits'))]);
  release.resolve(); assert.equal((await next).accepted, true); await service.close();
  const state = await service.state();
  assert.equal(state.status, 'waiting-for-user');
  assert.deepEqual(state.messages.filter(message => message.role === 'user').map(message => message.requestId), ['first', 'second']);
});

test('Steer durably accepts a batch during generation and suppresses stale tool execution', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), inputs = [], executed = [];
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [{ name: 'write' }],
    execute: async name => { executed.push(name); return {}; }, model: { next: async input => {
      inputs.push(input.messages); if (inputs.length === 1) { entered.resolve(); await release.promise;
        return { stop: 'tool_use', content: [{ type: 'text', text: 'old partial' }, tool('old')] }; }
      return answer('combined answer');
    } } });
  t.after(() => service.close());
  await service.submit({ id: 'start', text: 'original' }); await entered.promise;
  await service.submit({ id: 'a', text: 'correction a', followup: 'steer' });
  await service.submit({ id: 'b', text: 'correction b', followup: 'steer' });
  const extraInputs = Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, text: `additional requirement ${index}`, followup: 'steer' }));
  for (const input of extraInputs) await service.submit(input);
  await service.submit({ id: 'b', text: 'correction b', followup: 'steer' });
  assert.equal((await service.state()).pendingInputCount, 10);
  await assert.rejects(service.submit({ id: 'b', text: 'changed', followup: 'steer' }), { code: 'ID_REUSED' });
  await assert.rejects(service.submit({ id: 'stale', text: 'x', followup: 'steer', expectedTurnId: 'other' }), { code: 'STALE_TURN' });
  release.resolve(); await service.close();
  assert.equal(inputs.length, 2); assert.deepEqual(executed, []);
  const texts = inputs[1].filter(item => typeof item.content === 'string').map(item => item.content);
  assert.ok(texts.includes('original')); assert.ok(texts.includes('correction a')); assert.ok(texts.includes('correction b'));
  for (const input of extraInputs) assert.equal(texts.filter(text => text === input.text).length, 1);
  const state = await service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(state.pendingInputCount, 0);
  assert.equal(state.inputRevision, state.consumedInputRevision);
  assert.equal(state.messages.find(item => item.text === 'old partial').partial, true);
});

test('Steer waits for the started tool receipt and does not start remaining stale tools', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), executed = []; let models = 0;
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [{ name: 'write' }],
    execute: async (_name, input) => { executed.push(input.id); entered.resolve(); await release.promise; return { saved: true }; },
    model: { next: async () => ++models === 1 ? { stop: 'tool_use', content: [tool('first'), tool('second')] } : answer('corrected') } });
  await service.submit({ id: 'start', text: 'original' }); await entered.promise;
  await service.submit({ id: 'correction', text: 'stop the second write', followup: 'steer' });
  release.resolve(); await service.close();
  assert.deepEqual(executed, ['first']); assert.equal(models, 2);
  const saved = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.equal(Object.values(saved.toolReceipts).filter(item => item.result?.saved).length, 1);
  const assistantIndex = saved.messages.findIndex(item => item.role === 'assistant');
  assert.ok(Array.isArray(saved.messages[assistantIndex + 1].content), 'Tool results remain adjacent to their assistant calls');
});

test('Explicit interruption preserves partial text and requires an original-identity resume', { timeout: 10000 }, async t => {
  const entered = deferred(), inputs = []; let calls = 0;
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [], execute: async () => {},
    model: { next: async ({ signal, onText, messages }) => {
      inputs.push(messages);
      if (++calls > 1) return answer('resumed');
      await onText('partial answer'); entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'MODEL_INTERRUPTED' })), { once: true }));
    } } });
  await service.submit({ id: 'start', text: 'original' }); await entered.promise;
  const stop = { id: 'stop', expectedTurnId: 'start' };
  await service.interrupt(stop); await service.close();
  assert.equal((await service.state()).status, 'interrupted');
  assert.equal((await service.state()).partialText, 'partial answer');
  const partial = (await service.state()).messages.find(message => message.partial);
  assert.equal(partial?.text, 'partial answer');
  await assert.rejects(service.submit({ id: 'new', text: 'continue', followup: 'steer' }), { code: 'TURN_INTERRUPTED' });
  await service.submit({ id: 'start', text: 'original', retry: true }); await service.close();
  assert.equal((await service.state()).status, 'waiting-for-user'); assert.equal(calls, 2);
  assert.deepEqual((await service.state()).messages.map(message => message.text), ['original', 'partial answer', 'resumed']);
  assert.ok(!JSON.stringify(inputs[1]).includes('partial answer'), 'An aborted response is display history, not a committed model message');
  await service.interrupt(stop); assert.equal(calls, 2, 'A replayed stop cannot cancel newer work');
  await service.submit({ id: 'next', text: 'next turn' }); await service.close();
  const restarted = new CoordinatorService({ directory: path.dirname(service.file), system: 'test', tools: [], execute: async () => {}, model: service.model });
  const history = (await restarted.state()).messages;
  assert.equal(history.filter(message => message.id === partial.id).length, 1);
  assert.deepEqual(history.map(message => message.text), ['original', 'partial answer', 'resumed', 'next turn', 'resumed']);
  assert.equal(history[1].partial, true);
});

test('Legacy interrupted buffer is retained on resume without rewriting native transcript or compaction', async t => {
  const root = await directory(t), inputs = [];
  const service = new CoordinatorService({ directory: root, system: 'test', tools: [], execute: async () => {},
    model: { next: async input => { inputs.push(input.messages); return answer('legacy fragment'); } } });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(service.file, JSON.stringify({ messages: [{ role: 'user', content: 'original', requestId: 'old' }],
    requests: {}, activeTurnId: 'old', activeInput: { id: 'old', text: 'original', source: 'human' },
    status: 'interrupted', partialText: 'legacy fragment', controlRevision: 2, toolReceipts: {} }));
  // Recreate the accepted legacy fingerprint through the normal submit contract.
  const disk = JSON.parse(await fs.readFile(service.file, 'utf8'));
  disk.requests.old = hash('original');
  await fs.writeFile(service.file, JSON.stringify(disk));
  const before = (await service.state()).messages;
  assert.equal(before[1]?.partial, true);
  await service.submit({ id: 'old', text: 'original', retry: true }); await service.close();
  assert.equal(inputs[0].length, 1);
  const history = (await service.state()).messages;
  assert.deepEqual(history.map(message => [message.text, !!message.partial]),
    [['original', false], ['legacy fragment', true], ['legacy fragment', false]]);
  assert.equal(history[1].id, before[1].id);
  const saved = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.equal(saved.messages.length, 2, 'Native model transcript never includes the aborted buffer');
  assert.equal(saved.partialText, '');
});

test('Display projection does not duplicate a committed interrupted tool response or invent empty output', () => {
  const messages = [{ role: 'user', content: 'request' }, { role: 'assistant', superseded: true,
    content: [{ type: 'text', text: 'tool progress' }, tool('write')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write', content: '{}' }] }];
  const state = { messages, activeTurnId: 'start', status: 'interrupted', partialText: 'tool progress' };
  assert.equal(publicMessages(state).filter(message => message.text === 'tool progress').length, 1);
  assert.equal(publicMessages({ ...state, messages: [messages[0]], partialText: '' }).length, 1);
});

test('Repeated stops keep distinct attempts, stable ordering and compacted model context', { timeout: 10000 }, async t => {
  const root = await directory(t), entered = [deferred(), deferred()]; let calls = 0;
  const service = new CoordinatorService({ directory: root, system: 'test', tools: [], execute: async () => {},
    model: { next: async ({ signal, onText }) => {
      const index = calls++;
      if (index > 1) return answer('completed');
      await onText('same prefix'); entered[index].resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'MODEL_INTERRUPTED' })), { once: true }));
    } } });
  for (let index = 0; index < 2; index++) {
    await service.submit({ id: 'start', text: 'original', ...(index ? { retry: true } : {}) }); await entered[index].promise;
    await service.interrupt({ id: `stop-${index}`, expectedTurnId: 'start' }); await service.close();
    await service.interrupt({ id: `stop-${index}`, expectedTurnId: 'start' });
  }
  await service.submit({ id: 'start', text: 'original', retry: true }); await service.close();
  const saved = JSON.parse(await fs.readFile(service.file, 'utf8'));
  const partials = (await service.state()).messages.filter(message => message.partial);
  assert.equal(partials.length, 2); assert.equal(new Set(partials.map(message => message.id)).size, 2);
  assert.deepEqual((await service.state()).messages.map(message => message.text), ['original', 'same prefix', 'same prefix', 'completed']);
  saved.compaction = { through: 1, summary: 'historical request', sourceHash: hash(JSON.stringify(saved.messages.slice(0, 1))) };
  assert.equal(coordinatorModelMessages(saved).length, 2);
  assert.equal(publicMessages(saved).filter(message => message.partial).length, 2);
});

test('A new aborted stream equal to an earlier committed checkpoint is not mistaken for a duplicate', { timeout: 10000 }, async t => {
  const entered = [deferred(), deferred()], release = deferred(); let calls = 0;
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [], execute: async () => {},
    model: { next: async ({ signal, onText }) => {
      const index = calls++;
      if (index > 1) return answer('complete');
      await onText('same prefix'); entered[index].resolve();
      if (!index) { await release.promise; return answer('same prefix'); }
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'MODEL_INTERRUPTED' })), { once: true }));
    } } });
  t.after(() => { release.resolve(); return service.close(); });
  await service.submit({ id: 'start', text: 'original' }); await entered[0].promise;
  await service.interrupt({ id: 'checkpoint-stop', expectedTurnId: 'start' }); release.resolve(); await service.close();
  assert.equal((await service.state()).messages.filter(message => message.partial).length, 1);
  await service.submit({ id: 'start', text: 'original', retry: true }); await entered[1].promise;
  await service.interrupt({ id: 'stream-stop', expectedTurnId: 'start' }); await service.close();
  assert.equal((await service.state()).messages.filter(message => message.partial).length, 2);
  await service.submit({ id: 'start', text: 'original', retry: true }); await service.close();
  assert.deepEqual((await service.state()).messages.map(message => message.text), ['original', 'same prefix', 'same prefix', 'complete']);
});

test('Stopping during a business tool preserves its receipt and never starts or repeats stale tools', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), executed = [];
  let calls = 0;
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [{ name: 'write' }],
    execute: async (_name, input) => { executed.push(input.id); entered.resolve(); await release.promise; return { saved: true }; },
    model: { next: async () => ++calls === 1 ? { stop: 'tool_use', content: [tool('first'), tool('second')] } : answer('resumed safely') } });
  t.after(() => service.close());
  await service.submit({ id: 'start', text: 'original' }); await entered.promise;
  await service.interrupt({ id: 'stop-tool', expectedTurnId: 'start' });
  assert.deepEqual(executed, ['first']);
  release.resolve(); await service.close();
  assert.equal((await service.state()).status, 'interrupted');
  let persisted = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.equal(Object.values(persisted.toolReceipts).filter(receipt => receipt.result?.saved).length, 1);
  assert.equal(persisted.pending, null);
  await service.submit({ id: 'start', text: 'original', retry: true }); await service.close();
  persisted = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.deepEqual(executed, ['first']);
  assert.equal(Object.values(persisted.toolReceipts).filter(receipt => receipt.result?.saved).length, 1);
  assert.equal((await service.state()).status, 'waiting-for-user');
});

test('Accepted follow-ups survive a service restart without duplicate transcript entries', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), root = await directory(t);
  const options = { directory: root, system: 'test', tools: [], execute: async () => {} };
  const first = new CoordinatorService({ ...options, model: { next: async () => { entered.resolve(); await release.promise; return answer('partial'); } } });
  await first.submit({ id: 'start', text: 'original' }); await entered.promise;
  await first.submit({ id: 'saved', text: 'durable correction', followup: 'steer' });
  first.stopping = true; release.resolve(); await first.close();
  let observed;
  const restarted = new CoordinatorService({ ...options, model: { next: async ({ messages }) => { observed = messages; return answer('recovered'); } } });
  restarted.kick(); await restarted.close();
  assert.equal(observed.filter(item => item.content === 'durable correction').length, 1);
  assert.equal((await restarted.state()).pendingInputCount, 0);
});

test('Native model distinguishes user cancellation from timeout and releases the request', { timeout: 10000 }, async () => {
  const entered = deferred(), controller = new AbortController();
  const model = new CoordinatorModel({ baseUrl: 'https://provider.example', model: 'model', token: 'synthetic-provider-token',
    fetch: async (_url, { signal }) => { entered.resolve(); return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }); } });
  const result = model.next({ system: 'test', messages: [], signal: controller.signal });
  await entered.promise; controller.abort();
  await assert.rejects(result, { code: 'MODEL_INTERRUPTED' });
});
