import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CursorRoleFactory, cursorTemplateWorktree } from '../scripts/cloud/cursor-role-factory.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { canonical } from '../scripts/shared/protocol.mjs';
import { hash } from '../scripts/shared/io.mjs';

const templateId = '11111111-1111-4111-8111-111111111111', sourceSha = 'a'.repeat(40), handoffSha = 'b'.repeat(40);
// ProtocolStore, approvals, bindings, durable intents and role channel are real.
// The native provider is a controlled dependency, not real Cursor execution.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-factory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProtocolStore(path.join(directory, 'protocol')), calls = [], runs = new Map();
  let count = 0, allowed = true, uncertain = '';
  const createRun = agentId => { const run = { id: 'run-' + ++count, agentId, status: 'FINISHED' }; runs.set(agentId, run); return run; };
  const provider = {
    create: async input => { calls.push({ method: 'create', input }); const run = createRun(input.agentId);
      if (uncertain === 'create') throw Object.assign(new Error('Synthetic lost confirmation'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true });
      return { agent: { id: input.agentId }, run }; },
    followUp: async (agentId, text, options) => { calls.push({ method: 'followUp', agentId, text, options }); const run = createRun(agentId);
      if (uncertain === 'followUp') throw Object.assign(new Error('Synthetic lost confirmation'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true }); return run; },
    getRun: async (agentId, runId) => { const run = runs.get(agentId); assert.equal(run.id, runId); return run; },
    getAgent: async agentId => ({ id: agentId, latestRunId: runs.get(agentId)?.id }),
    cancel: async (agentId, runId) => { calls.push({ method: 'cancel', agentId, runId });
      if (uncertain === 'cancel') throw Object.assign(new Error('Synthetic lost cancel acknowledgement'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true });
      runs.get(agentId).status = 'CANCELLED'; return {}; },
  };
  const options = { directory: path.join(directory, 'roles'), projectId: 'project', repositoryId: '123', templateSessionId: templateId,
    repositoryUrl: 'https://github.com/example/repo', startingRef: sourceSha, endpoint: 'https://cloud.example/api/role-mcp', store, provider,
    authorizeSource: async () => allowed };
  const factory = new CursorRoleFactory(options);
  const human = { repositoryId: '123', deviceId: 'browser', agentId: 'human', role: 'human' };
  const coordinator = { ...human, role: 'coordinator', agentId: 'coordinator', bindings: { [templateId]: cursorTemplateWorktree(templateId) }, creationTemplates: [templateId] };
  await factory.initialize();
  const input = { taskId: 'task', text: 'Implement the approved fixture task', acceptance: 'A real assertion in the formal test', nodeIds: ['node'], mainVersion: 'main' };
  const project = await store.prepareProjectTask(coordinator, input, 'prepare', 'conversation');
  const reserve = async (approve = true) => {
    if (approve) await store.reviewProjectTask(human, input.taskId, project.brief, { id: 'human-approval', decision: 'approved', reason: 'Synthetic authorized test target' });
    await store.updateProjectTask(coordinator, input.taskId, { stage: 'creating', templateSessionId: templateId });
    const creation = await store.requestSessionCreation(coordinator, { operationId: 'create-task', templateSessionId: templateId, name: 'Test task' });
    await store.updateProjectTask(coordinator, input.taskId, { stage: approve ? 'starting' : 'brief', sessionId: creation.sessionId, creationId: creation.id, templateSessionId: templateId });
    return { id: creation.id, sessionId: creation.sessionId, taskId: input.taskId };
  };
  const assign = async request => {
    const result = await factory.reserveExecutor(request);
    coordinator.bindings[result.session.id] = result.worktreeId;
    await store.submitApprovedTask(coordinator, { operationId: 'dispatch', projectTaskId: input.taskId, session: result.session }, async () => ({
      taskId: input.taskId, text: JSON.stringify({ v: 1, ...input }), nodeIds: input.nodeIds, mainVersion: input.mainVersion,
    }), { verifyRouting: () => true });
    await store.updateProjectTask(coordinator, input.taskId, { stage: 'dispatched' });
    return result;
  };
  const send = async (principal, session, type, payload, extra = {}) => (await store.handle(principal,
    { v: 2, id: 'message-' + ++count, type, session, payload }, extra)).data;
  const approvePlan = async (session, invocation) => {
    const prefix = factory.channel.prefix(invocation.scope);
    const plan = (await factory.channel.exchange(invocation.token, { id: 'plan', type: 'object.put', payload: {
      kind: 'plan', ref: prefix + 'plan', baseVersion: '', content: { steps: ['Implement', 'Test'], paths: ['src/fixture.mjs'] },
    } })).data;
    await factory.channel.exchange(invocation.token, { id: 'plan-ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady',
      data: { planRef: plan.ref, planVersion: plan.version, sourceSha } } });
    await send(coordinator, session, 'review.request', { taskId: 'task', kind: 'plan', ...plan, requirementsRef: (await store.taskRecord(coordinator, session, 'task')).brief.ref,
      requirementsVersion: (await store.taskRecord(coordinator, session, 'task')).brief.version, rulesVersion: 'rules' });
    await send(coordinator, session, 'review.result', { kind: 'plan', ...plan, decision: 'approved', reason: 'Reviewed exact synthetic Plan' });
    return plan;
  };
  return { directory, store, calls, runs, provider, factory, options, human, coordinator, project, reserve, assign, send, approvePlan,
    setAllowed: value => { allowed = value; }, setUncertain: value => { uncertain = value; } };
}

test('Hosted Cursor reserves an independent logical child before any native Run; original human approval is retained', async t => {
  const f = await fixture(t), request = await f.reserve();
  const results = await Promise.all([f.factory.reserveExecutor(request), f.factory.reserveExecutor(request)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].nativeState, 'reserved');
  assert.equal(f.calls.length, 0);
  assert.notEqual(results[0].session.id, templateId);
  assert.notEqual(results[0].worktreeId, cursorTemplateWorktree(templateId));
  const creations = await f.store.sessionCreations(f.human);
  assert.equal(creations[0].state, 'registered');
  assert.equal(creations[0].sessionId, request.sessionId);
  assert.equal((await f.store.projectTasks(f.human))[0].review.id, 'human-approval');
  assert.equal(await f.factory.owns('legacy-claude-session'), false);
  assert.equal(await f.factory.owns(templateId), false);
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.bindings).every(binding => binding.deviceId === 'cloud-cursor:project'), true);
  assert.equal(Object.values(state.queues).flatMap(queue => queue.items).some(item => item.message.type === 'sync.heartbeat'), false);
});

test('Hosted Cursor launches Plan then approved execution on the same Agent and rotates task capabilities', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const invocation = await f.factory.pump(reserved.session, 'task');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'create');
  assert.equal(f.calls[0].input.mode, 'plan'); assert.equal(f.calls[0].input.startingRef, sourceSha);
  assert.deepEqual((await f.factory.channel.context(invocation.token)).session, reserved.session);
  assert.deepEqual(await f.factory.pump(reserved.session, 'task'), invocation, 'stable phase does not launch twice');
  await f.approvePlan(reserved.session, invocation);
  const executing = await f.factory.pump(reserved.session, 'task');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].method, 'followUp');
  assert.equal(f.calls[1].agentId, invocation.scope.nativeAgentId);
  assert.equal(f.calls[1].options.mode, 'agent');
  assert.notEqual(executing.token, invocation.token);
  assert.deepEqual(executing.scope.session, invocation.scope.session);
  await assert.rejects(f.factory.channel.context(invocation.token), { code: 'ROLE_EXPIRED' });
  assert.equal((await f.factory.channel.context(executing.token)).stage, 'executing');
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).acceptanceReview, undefined);
  const reopened = new CursorRoleFactory(f.options);
  assert.equal((await reopened.resolveReceiver(executing.scope)).runId, executing.runId);
  await reopened.pump(reserved.session, 'task'); assert.equal(f.calls.length, 2);
});

test('Hosted Cursor denies a reservation without the exact approved project task and preserves unrelated bindings', async t => {
  const f = await fixture(t), request = await f.reserve(false);
  const before = await f.store.transaction(value => value, { readOnly: true });
  await assert.rejects(f.factory.reserveExecutor(request), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.deepEqual(await f.store.transaction(value => value, { readOnly: true }), before);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.factory.reserveExecutor({ ...request, sessionId: templateId }), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.equal((await f.store.registeredBinding(f.human, templateId)).worktreeId, cursorTemplateWorktree(templateId));
});

test('Hosted Cursor template conflicts never migrate an existing local Session', async t => {
  const f = await fixture(t);
  const unrelatedId = '99999999-9999-4999-8999-999999999999';
  const local = { repositoryId: '123', deviceId: 'local-device', agentId: unrelatedId, role: 'executor' };
  await f.store.handle(local, { v: 2, id: 'local-bind', type: 'session.bind', payload: {
    sessionId: unrelatedId, agentId: unrelatedId, worktreeId: 'local-tree', expectedBindingVersion: '',
  } }, { verifyBinding: () => true });
  const factory = new CursorRoleFactory({ ...f.options, templateSessionId: unrelatedId });
  await assert.rejects(factory.initialize(), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.equal((await f.store.registeredBinding(f.human, unrelatedId)).deviceId, 'local-device');
  assert.equal(f.calls.length, 0);
});

test('Hosted Cursor will not execute an unreviewed Plan, changed source access or a busy native Run', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const plan = await f.factory.pump(reserved.session, 'task');
  const prefix = f.factory.channel.prefix(plan.scope);
  const object = (await f.factory.channel.exchange(plan.token, { id: 'plan', type: 'object.put', payload: {
    kind: 'plan', ref: prefix + 'plan', baseVersion: '', content: { steps: ['Test'] },
  } })).data;
  await f.factory.channel.exchange(plan.token, { id: 'ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady',
    data: { planRef: object.ref, planVersion: object.version, sourceSha } } });
  assert.equal(await f.factory.pump(reserved.session, 'task'), null); assert.equal(f.calls.length, 1);
  const task = await f.store.taskRecord(f.coordinator, reserved.session, 'task');
  await f.send(f.coordinator, reserved.session, 'review.request', { taskId: 'task', kind: 'plan', ...object,
    requirementsRef: task.brief.ref, requirementsVersion: task.brief.version, rulesVersion: 'rules' });
  await f.send(f.coordinator, reserved.session, 'review.result', { kind: 'plan', ...object, decision: 'approved', reason: 'Synthetic approval' });
  f.setAllowed(false);
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' }); assert.equal(f.calls.length, 1);
  f.setAllowed(true); f.runs.get(plan.scope.nativeAgentId).status = 'RUNNING';
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_BUSY' }); assert.equal(f.calls.length, 1);
});

test('Hosted Cursor unknown native acceptance does not create a replacement Agent or repeat follow-up', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const plan = await f.factory.pump(reserved.session, 'task'); await f.approvePlan(reserved.session, plan);
  f.setUncertain('followUp');
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_TRANSPORT_ERROR' });
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ACCEPTANCE_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'followUp').length, 1);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'executing');
});

test('Hosted Cursor reserves an independent CI receiver before ci.request and starts a new Agent only after testing', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const plan = await f.factory.pump(reserved.session, 'task'); await f.approvePlan(reserved.session, plan);
  const executing = await f.factory.pump(reserved.session, 'task');
  const principal = f.factory.principal(reserved.session.id), prefix = f.factory.channel.prefix(executing.scope);
  const todo = await f.send(principal, reserved.session, 'object.put', { kind: 'ciTodo', ref: prefix + 'todo', baseVersion: '', content: { items: [{ id: 'todo-1', title: 'Independent integration check' }] } });
  const evidence = await f.send(principal, reserved.session, 'object.put', { kind: 'evidence', ref: prefix + 'unit', baseVersion: '', content: { exitCode: 0 } });
  // Seed the verified handoff through the real workflow for routing tests only.
  // This is not a substitute for the still-unimplemented provider/Git verifier.
  await f.send(principal, reserved.session, 'task.report', { taskId: 'task', stage: 'handoff', data: { sourceSha: handoffSha,
    ciTodoRef: todo.ref, unitTestRefs: [evidence.ref], experienceRefs: [] } });
  const before = await f.store.transaction(state => f.factory.hasCiReceiver(state, reserved.session), { readOnly: true });
  assert.equal(before, false);
  const ci = await f.factory.pump(reserved.session, 'task');
  assert.equal(ci.nativeState, 'reserved'); assert.equal(f.calls.length, 2);
  assert.notEqual(ci.session.id, reserved.session.id); assert.notEqual(ci.worktreeId, reserved.worktreeId);
  assert.equal(await f.store.transaction(state => f.factory.hasCiReceiver(state, reserved.session), { readOnly: true }), true);
  await f.send(f.coordinator, reserved.session, 'ci.request', { taskId: 'task', sourceSha: handoffSha, ciTodoRef: todo.ref,
    unitTestRefs: [evidence.ref] }, { workflow: { verifyCiReceiver: (state, _principal, session) => f.factory.hasCiReceiver(state, session) } });
  const invocation = await f.factory.pump(reserved.session, 'task');
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].method, 'create');
  assert.notEqual(f.calls[2].input.agentId, plan.scope.nativeAgentId);
  assert.equal(f.calls[2].input.startingRef, handoffSha);
  const context = await f.factory.channel.context(invocation.token);
  assert.deepEqual(context.actor, ci.session); assert.deepEqual(context.session, reserved.session);
  assert.equal(context.sourceSha, handoffSha);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'testing', 'vendor FINISHED does not mark CI passed');
});

test('Hosted Cursor refuses replay after an actual execution binding migrates to a new generation', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const plan = await f.factory.pump(reserved.session, 'task');
  const binding = await f.store.registeredBinding(f.human, reserved.session.id);
  await f.store.handle(f.factory.principal(reserved.session.id), { v: 2, id: 'authorized-migration-fixture', type: 'session.bind', payload: {
    sessionId: reserved.session.id, agentId: reserved.session.id, worktreeId: 'another-owned-tree', expectedBindingVersion: binding.version,
  } }, { verifyBinding: () => true, allowMigration: true });
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  await assert.rejects(f.factory.channel.context(plan.token), { code: 'ROLE_FORBIDDEN' });
  assert.equal(f.calls.length, 1);
});

test('Hosted capabilities recheck original template, human approval and current source access inside the task transaction', async t => {
  for (const revoked of ['template', 'approval', 'source']) await t.test(revoked, async child => {
    const f = await fixture(child), reserved = await f.assign(await f.reserve());
    const plan = await f.factory.pump(reserved.session, 'task');
    const message = { id: 'saved-plan-write', type: 'object.put', payload: { kind: 'plan', ref: f.factory.channel.prefix(plan.scope) + 'plan',
      baseVersion: '', content: { steps: ['Formal fixture'] } } };
    await f.factory.channel.exchange(plan.token, message);
    if (revoked === 'source') f.setAllowed(false);
    else await f.store.transaction(state => {
      if (revoked === 'template') state.bindings[hash(canonical(['123', templateId]))].generation++;
      else Object.values(state.projectTasks)[0].review.decision = 'rejected';
    });
    const before = await f.store.transaction(state => state, { readOnly: true });
    await assert.rejects(f.factory.channel.context(plan.token), { code: 'ROLE_UNAVAILABLE' });
    await assert.rejects(f.factory.channel.exchange(plan.token, message), { code: 'ROLE_UNAVAILABLE' });
    await assert.rejects(f.factory.channel.exchange(plan.token, { ...message, id: 'new-write', payload: { ...message.payload, ref: message.payload.ref + '-new' } }), { code: 'ROLE_UNAVAILABLE' });
    assert.deepEqual(await f.store.transaction(state => state, { readOnly: true }), before);
    assert.equal(f.calls.length, 1);
  });
});

test('Hosted task cancellation stops only its saved native Run and reports the original control after termination', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const invocation = await f.factory.pump(reserved.session, 'task');
  f.runs.get(invocation.scope.nativeAgentId).status = 'RUNNING';
  const task = await f.store.taskRecord(f.coordinator, reserved.session, 'task');
  await f.send(f.coordinator, reserved.session, 'task.control', { taskId: 'task', action: 'cancel', expectedVersion: task.version, data: { reason: 'Synthetic cancellation' } });
  await f.factory.pump(reserved.session, 'task');
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'cancelled');
  const cancel = f.calls.filter(call => call.method === 'cancel');
  assert.equal(cancel.length, 1); assert.equal(cancel[0].agentId, invocation.scope.nativeAgentId); assert.equal(cancel[0].runId, invocation.runId);
  await f.factory.pump(reserved.session, 'task'); assert.equal(f.calls.filter(call => call.method === 'cancel').length, 1);
  await assert.rejects(f.factory.channel.context(invocation.token), { code: 'ROLE_EXPIRED' });
});

test('Unknown hosted cancellation never repeats POST or reports a running task as cancelled', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const invocation = await f.factory.pump(reserved.session, 'task');
  f.runs.get(invocation.scope.nativeAgentId).status = 'RUNNING';
  const task = await f.store.taskRecord(f.coordinator, reserved.session, 'task');
  await f.send(f.coordinator, reserved.session, 'task.control', { taskId: 'task', action: 'cancel', expectedVersion: task.version, data: { reason: 'Synthetic cancellation' } });
  f.setUncertain('cancel');
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_TRANSPORT_ERROR' });
  assert.deepEqual(await f.factory.pump(reserved.session, 'task'), { state: 'stopping' });
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'cancelling');
  assert.equal(f.calls.filter(call => call.method === 'cancel').length, 1);
  f.runs.get(invocation.scope.nativeAgentId).status = 'CANCELLED';
  await f.factory.pump(reserved.session, 'task');
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'cancelled');
  assert.equal(f.calls.filter(call => call.method === 'cancel').length, 1);
});

test('A definitely rejected hosted launch remains an explicit failure, not a successful replay or another paid request', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  f.provider.create = async input => { f.calls.push({ method: 'create', input }); throw Object.assign(new Error('Synthetic rate limit'), { code: 'CURSOR_RATE_LIMITED' }); };
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_RATE_LIMITED' });
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_FAILED' });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'assigned');
});
