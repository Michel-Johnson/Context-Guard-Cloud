import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorConversations, CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { CoordinatorModel } from '../scripts/cloud/coordinator-model.mjs';

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
  const entered = deferred(); let calls = 0;
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [], execute: async () => {},
    model: { next: async ({ signal, onText }) => {
      if (++calls > 1) return answer('resumed');
      await onText('partial answer'); entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'MODEL_INTERRUPTED' })), { once: true }));
    } } });
  await service.submit({ id: 'start', text: 'original' }); await entered.promise;
  const stop = { id: 'stop', expectedTurnId: 'start' };
  await service.interrupt(stop); await service.close();
  assert.equal((await service.state()).status, 'interrupted');
  assert.equal((await service.state()).partialText, 'partial answer');
  await assert.rejects(service.submit({ id: 'new', text: 'continue', followup: 'steer' }), { code: 'TURN_INTERRUPTED' });
  await service.submit({ id: 'start', text: 'original', retry: true }); await service.close();
  assert.equal((await service.state()).status, 'waiting-for-user'); assert.equal(calls, 2);
  await service.interrupt(stop); assert.equal(calls, 2, 'A replayed stop cannot cancel newer work');
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

test('Steer aborts a live generation, combines durable originals and rejects late stream writes', { timeout: 10000 }, async t => {
  const entered = deferred(), canceled = deferred(), seen = [];
  let lateText;
  const actor = { kind: 'human', teamId: 'T1', userId: 'U1' };
  const service = new CoordinatorService({ directory: await directory(t), system: 'test', tools: [], execute: async () => {},
    model: { next: async ({ messages, signal, onText }) => {
      seen.push(messages);
      if (seen.length > 1) return answer('all corrections included');
      await onText('old streamed text'); lateText = onText; entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { canceled.resolve(); reject(signal.reason); }, { once: true }));
    } } });
  t.after(() => service.close());
  await service.submit({ id: 'original', text: 'original' }, { source: 'slack', actor });
  await entered.promise;
  const batch = { id: 'batch-followup', followup: 'steer', expectedTurnId: 'original', inputs: [
    { id: 'slack-a', text: 'first clarification' }, { id: 'slack-b', text: 'second clarification' },
  ] };
  await service.submit(batch, { source: 'slack', actor });
  await canceled.promise;
  await lateText('late stale overwrite');
  await service.submit(batch, { source: 'slack', actor });
  await service.close();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].filter(message => message.role === 'user').map(message => message.content), ['original', 'first clarification', 'second clarification']);
  const state = await service.state();
  assert.equal(state.status, 'waiting-for-user'); assert.equal(state.pendingInputCount, 0);
  assert.equal(state.messages.filter(message => message.text === 'old streamed text' && message.partial).length, 1);
  assert.equal(state.messages.some(message => message.text === 'late stale overwrite'), false);
  for (const id of ['slack-a', 'slack-b']) assert.deepEqual(state.messages.find(message => message.requestId === id).actor, actor);
  await assert.rejects(service.submit({ ...batch, inputs: [{ id: 'slack-a', text: 'changed' }] }, { source: 'slack', actor }), { code: 'ID_REUSED' });
});

test('Initial batch is accepted atomically with independent identities, retry and restart receipts', { timeout: 10000 }, async t => {
  const root = await directory(t), observed = [];
  const actor = { kind: 'human', teamId: 'T1', userId: 'U1' };
  let calls = 0;
  const options = { directory: root, system: 'test', tools: [], execute: async () => {}, maxModelRetries: 0,
    model: { next: async ({ messages }) => { observed.push(messages); if (++calls === 1) throw Object.assign(new Error('Offline'), { code: 'MODEL_UNAVAILABLE' }); return answer('restored'); } } };
  const service = new CoordinatorService(options);
  const batch = { id: 'batch-start', inputs: [{ id: 'first-original', text: 'first' }, { id: 'second-original', text: 'second' }] };
  await service.submit(batch, { source: 'slack', actor }); await service.close();
  assert.deepEqual(observed[0].map(message => message.content), ['first', 'second']);
  const retry = (await service.state()).retryInput;
  assert.equal(retry.id, 'first-original');
  await service.submit({ ...retry, retry: true }, { source: 'slack', actor }); await service.close();
  assert.deepEqual(observed[1].map(message => message.content), ['first', 'second']);
  const restarted = new CoordinatorService(options);
  await restarted.submit(batch, { source: 'slack', actor }); await restarted.close();
  assert.equal(calls, 2); assert.equal((await restarted.state()).messages.filter(message => message.role === 'user').length, 2);
  await assert.rejects(restarted.submit({ id: 'different-batch', inputs: batch.inputs }, { source: 'slack', actor }), { code: 'ID_REUSED' });
  await assert.rejects(restarted.submit({ id: 'batch-start', text: 'single identity collision' }, { source: 'slack', actor }), { code: 'ID_REUSED' });
  await assert.rejects(restarted.submit({ id: 'invalid-batch', inputs: [{ id: 'valid', text: 'valid' }, { id: 'spoofed', text: 'x', actor }] }, { source: 'slack', actor }), { code: 'INVALID_INPUT' });
  assert.equal((await restarted.state()).acceptedRequestIds.includes('valid'), false, 'Rejected batch saves no partial input');
});

test('Native stream cancellation preserves visible partial text without replaying incomplete thinking or tools', { timeout: 10000 }, async t => {
  const entered = deferred(), observed = [];
  let canceled = 0, requests = 0;
  const encodeEvent = value => `data: ${JSON.stringify(value)}\n\n`;
  const model = new CoordinatorModel({ baseUrl: 'https://provider.example', model: 'model', token: 'synthetic-provider-token',
    fetch: async (_url, input) => {
      observed.push(JSON.parse(input.body));
      if (++requests > 1) return new Response(JSON.stringify({ model: 'model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'corrected' }] }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode([
          { type: 'message_start', message: { model: 'model' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private partial' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'visible partial' } },
        ].map(encodeEvent).join('')));
      }, cancel() { canceled++; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  const service = new CoordinatorService({ directory: await directory(t), model, system: 'test', tools: [], execute: async () => {},
    onStateChange: async () => { if ((await service.state()).streamingText === 'visible partial') entered.resolve(); } });
  t.after(() => service.close());
  await service.submit({ id: 'first', text: 'original' }); await entered.promise;
  await service.submit({ id: 'correction', text: 'corrected requirement', followup: 'steer' }); await service.close();
  assert.equal(canceled, 1); assert.equal(requests, 2);
  assert.equal(JSON.stringify(observed[1]).includes('private partial'), false);
  assert.equal(observed[1].messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'thinking' || block.type === 'tool_use')), false);
  assert.ok((await service.state()).messages.some(message => message.text === 'visible partial' && message.partial));
});

test('Model timeout is distinct from steering and explicit stop', { timeout: 10000 }, async () => {
  const model = new CoordinatorModel({ baseUrl: 'https://provider.example', model: 'model', token: 'synthetic-provider-token', timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({}), { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(model.next({ system: 'test', messages: [] }), { code: 'MODEL_TIMEOUT' });
});
