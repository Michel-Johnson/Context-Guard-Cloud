import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CursorRoleFactory, cursorTemplateWorktree } from '../scripts/cloud/cursor-role-factory.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { scopedObjectKey } from '../scripts/shared/protocol-workflow.mjs';
import { canonical } from '../scripts/shared/protocol.mjs';
import { cursorReworkId } from '../scripts/cloud/cursor-role-channel.mjs';
import { hash } from '../scripts/shared/io.mjs';

const templateId = '11111111-1111-4111-8111-111111111111', sourceSha = 'a'.repeat(40), handoffSha = 'b'.repeat(40);
// ProtocolStore, approvals, bindings, durable intents and role channel are real.
// The native provider is a controlled dependency, not real Cursor execution.
async function fixture(t, { gitProof, ciPolicy, runStatus = 'FINISHED' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-factory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProtocolStore(path.join(directory, 'protocol')), calls = [], runs = new Map();
  let count = 0, allowed = true, uncertain = '';
  const createRun = agentId => { const run = { id: 'run-' + ++count, agentId, status: runStatus }; runs.set(agentId, run); return run; };
  const provider = {
    create: async input => { calls.push({ method: 'create', input }); const run = createRun(input.agentId);
      if (uncertain === 'create') throw Object.assign(new Error('Synthetic lost confirmation'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true });
      return { agent: { id: input.agentId }, run }; },
    followUp: async (agentId, text, options) => { calls.push({ method: 'followUp', agentId, text, options }); const run = createRun(agentId);
      if (uncertain === 'followUp') throw Object.assign(new Error('Synthetic lost confirmation'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true }); return run; },
    getRun: async (agentId, runId) => { const run = runs.get(agentId); assert.equal(run.id, runId); return run; },
    getAgent: async agentId => ({ id: agentId, latestRunId: runs.get(agentId)?.id }),
    readRunEvents: async () => { throw Object.assign(new Error('Native stream fixture is not configured'), { code: 'SOURCE_UNVERIFIED' }); },
    cancel: async (agentId, runId) => { calls.push({ method: 'cancel', agentId, runId });
      if (uncertain === 'cancel') throw Object.assign(new Error('Synthetic lost cancel acknowledgement'), { code: 'CURSOR_TRANSPORT_ERROR', deliveryUncertain: true });
      runs.get(agentId).status = 'CANCELLED'; return {}; },
  };
  const options = { directory: path.join(directory, 'roles'), projectId: 'project', repositoryId: '123', templateSessionId: templateId,
    repositoryUrl: 'https://github.com/example/repo', startingRef: sourceSha, endpoint: 'https://cloud.example/api/role-mcp', store, provider,
    authorizeSource: async () => allowed, ...(gitProof ? { gitProof } : {}), ...(ciPolicy ? { ciPolicy } : {}) };
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
    runs.get(invocation.scope.nativeAgentId).status = 'FINISHED';
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
  const f = await fixture(t, { runStatus: 'RUNNING' }), reserved = await f.assign(await f.reserve());
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

test('Terminal Cursor Plan continues the original unfinished task with fresh authority, never renewing its expired lease', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  let now = Date.now(); f.factory.channel.now = () => now;
  const original = await f.factory.pump(reserved.session, 'task');
  const oldRef = f.factory.channel.prefix(original.scope) + 'plan';
  await f.factory.channel.exchange(original.token, { id: 'draft-only', type: 'object.put', payload: {
    kind: 'plan', ref: oldRef, baseVersion: '', content: { steps: ['Draft did not report Plan readiness'] },
  } });
  const leaseFile = path.join(f.directory, 'roles', 'capabilities', 'operations', hash(original.id) + '.json');
  const oldLease = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  now += 3600001;
  const next = await f.factory.pump(reserved.session, 'task');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].method, 'followUp');
  assert.equal(f.calls[1].agentId, original.scope.nativeAgentId);
  assert.notEqual(next.runId, original.runId); assert.notEqual(next.id, original.id); assert.notEqual(next.token, original.token);
  assert.deepEqual(next.scope.session, original.scope.session); assert.equal(next.scope.taskId, 'task');
  assert.equal(next.scope.attempt, 1); assert.equal(next.scope.sourceSha, sourceSha);
  const retained = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  assert.equal(retained.expiresAt, oldLease.expiresAt); assert.equal(retained.token, oldLease.token); assert.equal(retained.state, 'revoked');
  await assert.rejects(f.factory.channel.context(original.token), { code: 'ROLE_EXPIRED' });
  const context = await f.factory.channel.context(next.token);
  assert.equal(context.stage, 'assigned'); assert.notEqual(context.writePrefix, f.factory.channel.prefix(original.scope));
  await assert.rejects(f.factory.channel.exchange(next.token, { id: 'old-draft', type: 'object.put', payload: {
    kind: 'plan', ref: oldRef, baseVersion: '', content: { steps: ['Must not overwrite the prior attempt'] },
  } }), { code: 'ROLE_FORBIDDEN' });
  const plan = (await f.factory.channel.exchange(next.token, { id: 'new-plan', type: 'object.put', payload: {
    kind: 'plan', ref: context.writePrefix + 'plan', baseVersion: '', content: { steps: ['Implement', 'Test'], paths: ['src/fixture.mjs'] },
  } })).data;
  await f.factory.channel.exchange(next.token, { id: 'plan-ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady',
    data: { planRef: plan.ref, planVersion: plan.version, sourceSha } } });
  const task = await f.store.taskRecord(f.coordinator, reserved.session, 'task');
  assert.equal(task.stage, 'plan-ready'); assert.equal(task.planReview, undefined);
  assert.equal(await f.factory.pump(reserved.session, 'task'), null, 'The native model cannot approve its own Plan');
  assert.equal((await f.store.projectTasks(f.human))[0].review.id, 'human-approval');
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.length, 2); assert.equal(actor.invocations[0].runId, original.runId);
});

test('Terminal Cursor Plan concurrent pumps and host restart preserve one confirmed continuation', async t => {
  const f = await fixture(t, { runStatus: 'RUNNING' }), reserved = await f.assign(await f.reserve());
  const original = await f.factory.pump(reserved.session, 'task');
  assert.equal((await f.factory.pump(reserved.session, 'task')).id, original.id); assert.equal(f.calls.length, 1);
  f.runs.get(original.scope.nativeAgentId).status = 'FINISHED';
  const [a, b] = await Promise.all([f.factory.pump(reserved.session, 'task'), f.factory.pump(reserved.session, 'task')]);
  assert.equal(a.id, b.id); assert.equal(a.scope.attempt, 1); assert.equal(f.calls.length, 2);
  const reopened = new CursorRoleFactory(f.options);
  assert.equal((await reopened.pump(reserved.session, 'task')).id, a.id); assert.equal(f.calls.length, 2);
  assert.equal((await reopened.resolveReceiver(a.scope)).runId, a.runId);
  assert.equal(await reopened.resolveReceiver(original.scope), null);
});

test('Terminal Cursor Plan uncertain continuation is retained, never repeated or replaced with another Agent', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  await f.factory.pump(reserved.session, 'task'); f.setUncertain('followUp');
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_TRANSPORT_ERROR' });
  const reopened = new CursorRoleFactory(f.options);
  await assert.rejects(reopened.pump(reserved.session, 'task'), { code: 'CURSOR_ACCEPTANCE_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'followUp').length, 1);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'assigned');
});

test('Terminal Cursor Plan observes exact native identity and original approval before any continuation', async t => {
  for (const scenario of ['ERROR', 'EXPIRED', 'RUNNING', 'CANCELLED', 'unknown-status', 'foreign-run', 'foreign-latest', 'read-timeout', 'source-revoked']) await t.test(scenario, async child => {
    const f = await fixture(child), reserved = await f.assign(await f.reserve());
    const original = await f.factory.pump(reserved.session, 'task');
    if (['ERROR', 'EXPIRED', 'RUNNING', 'CANCELLED', 'unknown-status'].includes(scenario)) f.runs.get(original.scope.nativeAgentId).status = scenario;
    if (scenario === 'foreign-run') f.provider.getRun = async () => ({ ...original.run, id: 'another-run' });
    if (scenario === 'foreign-latest') f.provider.getAgent = async () => ({ id: original.scope.nativeAgentId, latestRunId: 'another-run' });
    if (scenario === 'read-timeout') f.provider.getRun = async () => { throw Object.assign(new Error('Synthetic read timeout'), { code: 'CURSOR_TIMEOUT' }); };
    if (scenario === 'source-revoked') f.setAllowed(false);
    const denied = ['foreign-run', 'foreign-latest', 'read-timeout', 'source-revoked'].includes(scenario);
    if (denied) await assert.rejects(f.factory.pump(reserved.session, 'task'));
    else {
      const next = await f.factory.pump(reserved.session, 'task');
      assert.equal(next.id === original.id, !['ERROR', 'EXPIRED'].includes(scenario));
    }
    assert.equal(f.calls.length, ['ERROR', 'EXPIRED'].includes(scenario) ? 2 : 1);
    assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'assigned');
  });
});

test('Terminal Cursor Plan bounds model attempts and rejects malformed or other-phase attempt scopes', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const original = await f.factory.pump(reserved.session, 'task');
  for (const attempt of [0, -1, 3, 1.5, null, '1']) await assert.rejects(f.factory.channel.issue({
    operationId: 'invalid-attempt-' + String(attempt), scope: { ...original.scope, attempt },
  }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.factory.channel.issue({ operationId: 'ci-attempt', scope: { ...original.scope, phase: 'ci', attempt: 1,
    actor: { id: '77777777-7777-4777-8777-777777777777', generation: 1 }, actorWorktreeId: 'independent-ci',
  } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.factory.channel.issue({ operationId: 'execution-attempt', scope: { ...original.scope, phase: 'execution', attempt: 1,
    plan: { ref: 'approved-plan', version: 'approved-version' },
  } }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await f.factory.pump(reserved.session, 'task')).scope.attempt, 1);
  assert.equal((await f.factory.pump(reserved.session, 'task')).scope.attempt, 2);
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_PLAN_CONTINUATION_LIMIT' });
  assert.equal(f.calls.length, 3); assert.equal(f.calls.filter(call => call.method === 'create').length, 1);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'assigned');
});

test('Terminal Cursor Plan reports arriving during native observation win without another Run or lease rotation', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  const original = await f.factory.pump(reserved.session, 'task');
  const object = (await f.factory.channel.exchange(original.token, { id: 'before-observation-plan', type: 'object.put', payload: {
    kind: 'plan', ref: f.factory.channel.prefix(original.scope) + 'plan', baseVersion: '', content: { steps: ['Report is in flight'] },
  } })).data;
  const getRun = f.provider.getRun;
  f.provider.getRun = async (agentId, runId) => {
    await f.factory.channel.exchange(original.token, { id: 'observed-plan-ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady',
      data: { planRef: object.ref, planVersion: object.version, sourceSha } } });
    return getRun(agentId, runId);
  };
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.taskRecord(f.coordinator, reserved.session, 'task')).stage, 'plan-ready');
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'roles', 'capabilities', 'operations', hash(original.id) + '.json'), 'utf8')).state, 'active');
});

test('Terminal Cursor Plan source, approval and binding revocation during native reads prevent continuation', async t => {
  for (const scenario of ['source', 'approval', 'binding']) await t.test(scenario, async child => {
    const f = await fixture(child), reserved = await f.assign(await f.reserve());
    const original = await f.factory.pump(reserved.session, 'task'), getAgent = f.provider.getAgent;
    f.provider.getAgent = async id => {
      if (scenario === 'source') f.setAllowed(false);
      else await f.store.transaction(state => {
        if (scenario === 'approval') Object.values(state.projectTasks)[0].review.decision = 'rejected';
        else state.bindings[hash(canonical(['123', reserved.session.id]))].generation++;
      });
      return getAgent(id);
    };
    await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(await fs.readFile(f.factory.executorFile(reserved.session.id), 'utf8')).invocations.length, 1);
    assert.equal(original.scope.attempt, undefined);
  });
});

test('Terminal Cursor Plan prepared lease expiry cannot start a native Run when host dispatch resumes', async t => {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  f.factory.authorizeSource = async ({ actor }) => actor.invocations.at(-1)?.state !== 'prepared';
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.equal(f.calls.length, 0);
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(reserved.session.id), 'utf8'));
  const prepared = actor.invocations[0]; assert.equal(prepared.state, 'prepared');
  const file = path.join(f.directory, 'roles', 'capabilities', 'operations', hash(prepared.id) + '.json');
  const lease = JSON.parse(await fs.readFile(file, 'utf8'));
  const reopened = new CursorRoleFactory(f.options); reopened.channel.now = () => lease.expiresAt + 1;
  await assert.rejects(reopened.pump(reserved.session, 'task'), { code: 'ROLE_EXPIRED' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), lease, 'Expiry replay never renews the operation');
});

async function preparedPlanContinuation(t) {
  const f = await fixture(t), reserved = await f.assign(await f.reserve());
  let now = 1700000000000; f.factory.channel.now = () => now;
  const original = await f.factory.pump(reserved.session, 'task');
  f.factory.authorizeSource = async ({ actor }) => !(actor.invocations.at(-1)?.scope.attempt === 1 && actor.invocations.at(-1)?.state === 'prepared');
  await assert.rejects(f.factory.pump(reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(reserved.session.id), 'utf8'));
  const prepared = actor.invocations.at(-1);
  assert.equal(prepared.scope.attempt, 1); assert.equal(prepared.state, 'prepared'); assert.equal(f.calls.length, 1);
  return { ...f, reserved, original, prepared, setClock: value => { now = value; } };
}

test('Terminal Cursor Plan prepared continuation retains cancellation without any follow-up POST', async t => {
  const f = await preparedPlanContinuation(t);
  f.runs.get(f.original.scope.nativeAgentId).status = 'CANCELLED'; f.factory.authorizeSource = async () => true;
  await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.deepEqual(f.calls.map(call => call.method), ['create']);
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.length, 2); assert.deepEqual(actor.invocations.at(-1), f.prepared);
  assert.equal((await f.store.taskRecord(f.coordinator, f.reserved.session, 'task')).stage, 'assigned');
});

test('Terminal Cursor Plan prepared continuation checks current lease after final authority await', async t => {
  for (const scenario of ['expired', 'revoked']) await t.test(scenario, async child => {
    const f = await preparedPlanContinuation(child);
    const file = path.join(f.directory, 'roles', 'capabilities', 'operations', hash(f.prepared.id) + '.json');
    const lease = JSON.parse(await fs.readFile(file, 'utf8')); let checks = 0;
    f.factory.authorizeSource = async ({ actor }) => {
      // The second authority await follows issue() and its initial lease check.
      if (actor.invocations.at(-1)?.scope.attempt === 1 && ++checks === 2) {
        if (scenario === 'expired') f.setClock(lease.expiresAt + 1);
        else await f.factory.channel.revoke(f.prepared.token);
      }
      return true;
    };
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'ROLE_EXPIRED' });
    assert.deepEqual(f.calls.map(call => call.method), ['create'], 'No POST may precede the expiry/revocation failure');
    const retained = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(retained.expiresAt, lease.expiresAt); assert.equal(retained.token, lease.token);
    assert.equal(retained.state, 'revoked');
    const actor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
    assert.equal(actor.invocations.length, 2); assert.equal(actor.invocations.at(-1).state, 'failed');
    assert.equal(actor.invocations.at(-1).runId, undefined);
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_FAILED' });
    assert.equal(f.calls.length, 1);
  });
});

test('Terminal Cursor Plan lease cannot expire during final lock cleanup before POST', async t => {
  const f = await preparedPlanContinuation(t); f.factory.authorizeSource = async () => true;
  const withLease = f.factory.channel.withLease.bind(f.factory.channel);
  f.factory.channel.withLease = async (...args) => {
    const expiresAt = await withLease(...args); f.setClock(expiresAt + 1); return expiresAt;
  };
  await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'ROLE_EXPIRED' });
  assert.deepEqual(f.calls.map(call => call.method), ['create']);
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.at(-1).state, 'failed'); assert.equal(actor.invocations.at(-1).runId, undefined);
});

test('Terminal Cursor Plan rechecks source authority after dispatch intent is saved', async t => {
  const f = await preparedPlanContinuation(t);
  f.factory.authorizeSource = async ({ actor }) => actor.invocations.at(-1)?.state !== 'dispatching';
  await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.deepEqual(f.calls.map(call => call.method), ['create']);
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.at(-1).state, 'failed'); assert.equal(actor.invocations.at(-1).runId, undefined);
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

async function handoffFixture(t, verify, { ciPolicy, trustedChecks, ciTodoItems = [{ id: 'CI-1', title: 'Independent check' }] } = {}) {
  const inspected = [], f = await fixture(t, { ciPolicy, gitProof: { ...(trustedChecks ? { trustedChecks } : {}), verify: async input => {
    inspected.push(input);
    return verify ? verify(input, f) : { repository: 'example/repo', branch: 'cursor/task', baseSha: sourceSha, sourceSha: handoffSha, files: ['src/fixture.mjs'] };
  } } });
  const reserved = await f.assign(await f.reserve()), plan = await f.factory.pump(reserved.session, 'task');
  await f.approvePlan(reserved.session, plan);
  const invocation = await f.factory.pump(reserved.session, 'task'), prefix = f.factory.channel.prefix(invocation.scope);
  const put = async (name, kind, content) => (await f.factory.channel.exchange(invocation.token, { id: 'handoff-' + name,
    type: 'object.put', payload: { kind, ref: prefix + name, baseVersion: '', content } })).data;
  const todo = await put('todo', 'ciTodo', { items: ciTodoItems });
  const evidence = await put('unit', 'evidence', { observation: 'Executor module tests, not independent CI' });
  const input = { id: 'original-handoff', type: 'task.report', payload: { taskId: 'task', stage: 'handoff',
    data: { sourceSha: handoffSha, ciTodoRef: todo.ref, unitTestRefs: [evidence.ref], experienceRefs: [] } } };
  return Object.assign(f, { reserved, invocation, input, todo, evidence, inspected });
}

test('Original Cursor handoff is deferred, verified and applied through the same task message after native termination', async t => {
  const f = await handoffFixture(t);
  f.runs.get(f.invocation.scope.nativeAgentId).status = 'RUNNING';
  const replies = await Promise.all([f.factory.channel.exchange(f.invocation.token, f.input), f.factory.channel.exchange(f.invocation.token, f.input)]);
  assert.deepEqual(replies[0], replies[1]); assert.equal(replies[0].data.state, 'proof-pending');
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'executing');
  assert.deepEqual(await f.factory.pump(f.reserved.session, 'task'), { state: 'proof-pending' });
  assert.equal(f.inspected.length, 0); assert.equal(f.calls.length, 2);
  f.runs.get(f.invocation.scope.nativeAgentId).status = 'FINISHED';
  const reopened = new CursorRoleFactory(f.options);
  const ci = await reopened.pump(f.reserved.session, 'task');
  assert.equal(ci.nativeState, 'reserved'); assert.equal(f.calls.length, 2);
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'awaiting-ci'); assert.deepEqual(task.handoff, f.input.payload.data);
  assert.deepEqual(task.references, { [f.todo.ref]: f.todo.version, [f.evidence.ref]: f.evidence.version });
  assert.equal(task.ci, undefined); assert.equal(task.acceptanceReview, undefined);
  assert.equal(f.inspected.length, 1); assert.equal(f.inspected[0].run.id, f.invocation.runId);
  assert.deepEqual(f.inspected[0].approvedPaths, ['src/fixture.mjs']);
  await reopened.pump(f.reserved.session, 'task'); assert.equal(f.inspected.length, 1);
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.cursorRoleHandoffs).length, 1);
  const queue = Object.values(state.queues).flatMap(queue => queue.items);
  assert.equal(queue.filter(item => item.message.type === 'task.report' && item.message.payload.stage === 'handoff').length, 1);
});

const ciPolicy = { checks: [{ todoId: 'CI-1', testId: 'fixed-formal-test', argv: ['node', '--test', '--test-reporter=tap', 'tests/fixture.mjs'],
  name: 'Formal tests', appId: 15368, workflowPath: '.github/workflows/ci.yml', workflowBlobSha: 'd'.repeat(40), testStep: 'Run formal tests' }] };
async function ciFixture(t, { nativeFailed = false, machineFailed = false, aggregateFailed = false, unavailable = false, ciTodoItems } = {}) {
  const machine = [{ name: 'Formal tests', sourceSha: handoffSha, conclusion: machineFailed ? 'failure' : 'success',
    runConclusion: machineFailed || aggregateFailed ? 'failure' : 'success', testConclusion: machineFailed ? 'failure' : 'success' }], workflowCalls = [];
  const f = await handoffFixture(t, null, { ciPolicy, ciTodoItems, trustedChecks: async input => {
    workflowCalls.push(input);
    if (unavailable) throw Object.assign(new Error('Synthetic workflow pending'), { code: 'SOURCE_UNVERIFIED' });
    return machine;
  } });
  await f.factory.channel.exchange(f.invocation.token, f.input); await f.factory.pump(f.reserved.session, 'task');
  await f.send(f.coordinator, f.reserved.session, 'ci.request', { taskId: 'task', sourceSha: handoffSha, ciTodoRef: f.todo.ref, unitTestRefs: [f.evidence.ref] },
    { workflow: { verifyCiReceiver: (state, _p, session) => f.factory.hasCiReceiver(state, session) } });
  const file = f.factory.ciFile(f.reserved.session, 'task', handoffSha);
  const typedObservation = async (agentId, runId) => {
    const actor = JSON.parse(await fs.readFile(f.nativeObservationFile || file, 'utf8'));
    assert.equal(actor.nativeAgentId, agentId); assert.equal(actor.invocations.at(-1).runId, runId);
    const failed = f.nativeFailedOverride ?? nativeFailed;
    const commands = actor.commands.map((spec, index) => ({ event: 'tool_call', data: {
      callId: 'actual-command-' + index, name: 'run_terminal_cmd', status: 'completed', args: { command: spec.command },
      result: { isBackground: false, success: { command: spec.command, stdout: 'CG_CURSOR_PROOF ' + JSON.stringify({
        format: 1, nonce: spec.nonce, sourceSha: actor.sourceSha, argv: spec.argv, before: { sha: actor.sourceSha, clean: true }, after: { sha: actor.sourceSha, clean: true },
        exitCode: failed ? 1 : 0, signal: null, spawnError: null,
        stdout: `# tests 1\n# pass ${failed ? 0 : 1}\n# fail ${failed ? 1 : 0}\n# cancelled 0\n# skipped 0\n# todo 0\n`, stderr: '',
      }) + '\n' } },
    } }));
    return { agentId, runId, complete: true, events: [...commands, { event: 'result', data: { runId, status: 'FINISHED' } }] };
  };
  f.provider.readRunEvents = typedObservation;
  return Object.assign(f, { machine, workflowCalls, file, typedObservation });
}
async function ciProposal(f, { verdict = 'passed', status = 'passed', reproduction = false, idPrefix = '', revision = handoffSha } = {}) {
  const invocation = await f.factory.pump(f.reserved.session, 'task'), context = await f.factory.channel.context(invocation.token);
  const put = async name => (await f.factory.channel.exchange(invocation.token, { id: idPrefix + 'ci-' + name, type: 'object.put',
    payload: { kind: 'evidence', ref: context.writePrefix + name, baseVersion: '', content: { sourceSha: revision, observation: 'Controlled provider evidence, not a real vendor test' } } })).data;
  const evidence = await put('evidence'), reproductionRef = reproduction ? (await put('reproduction')).ref : undefined;
  const input = { id: idPrefix + 'original-ci-result', type: 'ci.result', payload: { taskId: 'task', sourceSha: revision, verdict,
    checks: [{ todoId: 'CI-1', testId: 'fixed-formal-test', status, evidenceRef: evidence.ref, ...(reproductionRef ? { reproductionRef } : {}) }] } };
  return { invocation, context, input, evidence };
}

async function reworkFixture(t, { humanRejection = false } = {}) {
  const f = await ciFixture(t, { nativeFailed: !humanRejection, machineFailed: !humanRejection });
  const p = await ciProposal(f, humanRejection ? {} : { verdict: 'failed', status: 'failed', reproduction: true });
  await f.factory.channel.exchange(p.invocation.token, p.input);
  await f.factory.pump(f.reserved.session, 'task');
  let task = await f.store.taskRecord(f.coordinator, f.reserved.session, 'task');
  if (humanRejection) {
    await f.send(f.human, f.reserved.session, 'review.result', { kind: 'acceptance', ref: task.ci.ref, version: task.ci.version,
      decision: 'rejected', reason: 'The agreed empty-search behavior is missing' });
    task = await f.store.taskRecord(f.coordinator, f.reserved.session, 'task');
  }
  assert.equal(task.stage, humanRejection ? 'acceptance-rejected' : 'ci-failed');
  const beforeExecutor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
  const beforeTester = JSON.parse(await fs.readFile(f.file, 'utf8'));
  await f.send(f.coordinator, f.reserved.session, 'task.rework', {
    taskId: 'task', sourceSha: handoffSha, ciResultRef: task.ci.ref,
    failedTestIds: humanRejection ? [] : ['fixed-formal-test'],
    reason: humanRejection ? task.acceptanceReview.reason : 'Fix the independently verified failure',
  });
  return Object.assign(f, { failedTask: task, oldProposal: p, beforeExecutor, beforeTester });
}

async function reworkPlan(f) {
  const next = await f.factory.pump(f.reserved.session, 'task');
  assert.ok(next, 'Coordinator-approved rework must not silently return null');
  const context = await f.factory.channel.context(next.token);
  const plan = (await f.factory.channel.exchange(next.token, { id: context.writePrefix + 'put-plan', type: 'object.put',
    payload: { kind: 'plan', ref: context.writePrefix + 'plan', baseVersion: '', content: {
      steps: ['Read original failure evidence', 'Fix and independently retest'], paths: ['src/fixture.mjs'],
    } } })).data;
  await f.factory.channel.exchange(next.token, { id: context.writePrefix + 'plan-ready', type: 'task.report',
    payload: { taskId: 'task', stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha: handoffSha } } });
  return { next, context, plan };
}

test('Coordinator rework returns the original Executor to a new Plan and preserves failed evidence', async t => {
  for (const humanRejection of [false, true]) await t.test(humanRejection ? 'human rejection' : 'CI failure', async t => {
    const f = await reworkFixture(t, { humanRejection });
    const originalFollowUp = f.provider.followUp;
    f.provider.followUp = async (...args) => { const run = await originalFollowUp(...args); run.status = 'RUNNING'; return run; };
    const before = f.calls.length;
    const first = await f.factory.pump(f.reserved.session, 'task');
    assert.ok(first, 'Coordinator-approved rework must not silently return null');
    assert.equal(first.scope.phase, 'plan'); assert.equal(first.scope.sourceSha, handoffSha);
    assert.equal(first.scope.nativeAgentId, f.invocation.scope.nativeAgentId);
    assert.equal(first.scope.taskId, 'task'); assert.match(first.scope.reworkId, /^[a-f0-9]{64}$/);
    const reopened = new CursorRoleFactory(f.options);
    const repeated = await Promise.all([reopened.pump(f.reserved.session, 'task'), f.factory.pump(f.reserved.session, 'task')]);
    assert.ok(repeated.every(item => item.id === first.id)); assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1).method, 'followUp'); assert.equal(f.calls.at(-1).options.mode, 'plan');
    assert.match(f.calls.at(-1).text, /immutable CI result\/reproduction/);
    const context = await f.factory.channel.context(first.token);
    assert.equal(context.rework.ciResultRef, f.failedTask.ci.ref);
    assert.deepEqual(context.rework.failedTestIds, humanRejection ? [] : ['fixed-formal-test']);
    assert.notEqual(context.writePrefix, f.factory.channel.prefix(f.beforeExecutor.invocations[0].scope));
    for (const ref of context.references.filter(ref => ref.ref !== f.failedTask.plan.ref && ref.ref !== f.failedTask.brief.ref)) {
      assert.ok((await f.factory.channel.exchange(first.token, { id: hash(context.writePrefix + ref.ref), type: 'object.read', payload: ref })).ok);
    }
    await assert.rejects(f.factory.channel.exchange(first.token, { id: 'rework-overwrite', type: 'object.put', payload: {
      kind: 'plan', ref: f.failedTask.plan.ref, baseVersion: f.failedTask.plan.version, content: { steps: ['Erase old evidence'] },
    } }), { code: 'ROLE_FORBIDDEN' });
    const executor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
    assert.deepEqual(executor.invocations.slice(0, -1), f.beforeExecutor.invocations);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.beforeTester);
    assert.deepEqual((await f.store.taskRecord(f.coordinator, f.reserved.session, 'task')).ci, f.failedTask.ci);
  });
});

test('Rework must be reviewed before execution and then uses a fresh independent Tester even for the same SHA', async t => {
  for (const resultSha of [handoffSha, 'c'.repeat(40)]) await t.test(resultSha === handoffSha ? 'same SHA' : 'new commit SHA', async t => {
  const f = await reworkFixture(t), { next, context, plan } = await reworkPlan(f);
  const before = f.calls.length;
  assert.equal(await f.factory.pump(f.reserved.session, 'task'), null);
  assert.equal(f.calls.length, before, 'submitted but unapproved Plan never starts implementation');
  await f.send(f.coordinator, f.reserved.session, 'review.request', { taskId: 'task', kind: 'plan', ...plan,
    requirementsRef: f.failedTask.brief.ref, requirementsVersion: f.failedTask.brief.version, rulesVersion: 'rules' });
  await f.send(f.coordinator, f.reserved.session, 'review.result', { kind: 'plan', ...plan, decision: 'approved', reason: 'Reviewed original failure and new scope' });
  const execution = await f.factory.pump(f.reserved.session, 'task');
  assert.equal(execution.scope.phase, 'execution'); assert.equal(execution.scope.sourceSha, handoffSha);
  assert.equal(execution.scope.nativeAgentId, next.scope.nativeAgentId);
  await assert.rejects(f.factory.channel.context(next.token), { code: 'ROLE_EXPIRED' });
  const prefix = f.factory.channel.prefix(execution.scope);
  const put = async (name, kind, content) => (await f.factory.channel.exchange(execution.token, {
    id: prefix + 'put-' + name, type: 'object.put', payload: { kind, ref: prefix + name, baseVersion: '', content },
  })).data;
  const todo = await put('todo', 'ciTodo', { items: [{ id: 'CI-1', title: 'Independent check' }] });
  const evidence = await put('unit', 'evidence', { observation: 'Rework module validation, vendor controlled' });
  f.factory.gitProof.verify = async input => ({ repository: 'example/repo', branch: 'cursor/task', baseSha: input.baseSha,
    sourceSha: input.sourceSha, files: ['src/fixture.mjs'] });
  await f.factory.channel.exchange(execution.token, { id: prefix + 'handoff', type: 'task.report',
    payload: { taskId: 'task', stage: 'handoff', data: { sourceSha: resultSha, ciTodoRef: todo.ref, unitTestRefs: [evidence.ref], experienceRefs: [] } } });
  const reservation = await f.factory.pump(f.reserved.session, 'task');
  assert.notEqual(reservation.session.id, f.oldProposal.invocation.scope.actor.id);
  assert.notEqual(reservation.session.id, f.reserved.session.id);
  await f.send(f.coordinator, f.reserved.session, 'ci.request', { taskId: 'task', sourceSha: resultSha, ciTodoRef: todo.ref, unitTestRefs: [evidence.ref] },
    { workflow: { verifyCiReceiver: (state, _p, session) => f.factory.hasCiReceiver(state, session) } });
  const tester = await f.factory.pump(f.reserved.session, 'task');
  assert.equal(tester.scope.reworkId, execution.scope.reworkId);
  assert.notEqual(tester.scope.nativeAgentId, f.oldProposal.invocation.scope.nativeAgentId);
  assert.notEqual(tester.scope.nativeAgentId, execution.scope.nativeAgentId);
  assert.equal(tester.scope.sourceSha, resultSha);
  assert.equal((await f.store.taskRecord(f.coordinator, f.reserved.session, 'task')).stage, 'testing');
  f.nativeObservationFile = f.factory.ciFile(f.reserved.session, 'task', resultSha, execution.scope.reworkId);
  f.nativeFailedOverride = false;
  for (const check of f.machine) Object.assign(check, { sourceSha: resultSha, conclusion: 'success', runConclusion: 'success', testConclusion: 'success' });
  const passed = await ciProposal(f, { idPrefix: 'rework-', revision: resultSha });
  await f.factory.channel.exchange(passed.invocation.token, passed.input);
  await f.factory.pump(f.reserved.session, 'task');
  const verified = await f.store.taskRecord(f.coordinator, f.reserved.session, 'task');
  assert.equal(verified.stage, 'awaiting-merge'); assert.equal(verified.ci.verdict, 'passed');
  assert.notEqual(verified.ci.ref, f.failedTask.ci.ref);
  assert.equal(verified.acceptanceReview, undefined, 'technical retest never invents human acceptance');
  assert.equal(f.calls.filter(call => call.method === 'create').length, 3, 'original Executor, original Tester, rework Tester only');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.beforeTester);
  assert.equal(context.rework.sourceSha, handoffSha);
  // A later human rejection is a distinct Coordinator decision, not another
  // retry of the old failure. Its namespace cannot revive the previous lease.
  await f.send(f.human, f.reserved.session, 'review.result', { kind: 'acceptance', ref: verified.ci.ref, version: verified.ci.version,
    decision: 'rejected', reason: 'The required interaction is still missing' });
  await f.send(f.coordinator, f.reserved.session, 'task.rework', { taskId: 'task', sourceSha: resultSha,
    ciResultRef: verified.ci.ref, failedTestIds: [], reason: 'The required interaction is still missing' });
  await assert.rejects(f.factory.channel.context(tester.token), { code: 'ROLE_FORBIDDEN' });
  const second = await f.factory.pump(f.reserved.session, 'task');
  assert.equal(second.scope.phase, 'plan'); assert.equal(second.scope.sourceSha, resultSha);
  assert.equal(second.scope.nativeAgentId, next.scope.nativeAgentId);
  assert.notEqual(second.scope.reworkId, next.scope.reworkId);
  assert.notEqual(f.factory.channel.prefix(second.scope), context.writePrefix);
  });
});

test('Rework does not resend uncertain native acceptance or dispatch after access is revoked', async t => {
  for (const scenario of ['unknown', 'revoked', 'busy', 'invalid-cycle']) await t.test(scenario, async t => {
    const f = await reworkFixture(t), before = f.calls.length;
    if (scenario === 'unknown') {
      f.setUncertain('followUp');
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_TRANSPORT_ERROR' });
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ACCEPTANCE_UNKNOWN' });
      assert.equal(f.calls.length, before + 1);
    } else if (scenario === 'revoked') {
      f.setAllowed(false); await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
      assert.equal(f.calls.length, before);
    } else if (scenario === 'busy') {
      f.runs.get(f.invocation.scope.nativeAgentId).status = 'RUNNING';
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_BUSY' });
      assert.equal(f.calls.length, before);
    } else {
      const invocation = await f.factory.pump(f.reserved.session, 'task');
      await assert.rejects(f.factory.channel.issue({ operationId: 'bad-rework-cycle', scope: { ...invocation.scope, reworkId: 'invalid' } }), { code: 'INVALID_ARGUMENT' });
      const wrong = await f.factory.channel.issue({ operationId: 'wrong-rework-cycle', scope: { ...invocation.scope, reworkId: 'f'.repeat(64) } });
      await assert.rejects(f.factory.channel.context(wrong.token), { code: 'ROLE_UNAVAILABLE' });
      const state = await f.store.transaction(value => value, { readOnly: true });
      const wrongScope = { ...invocation.scope, reworkId: 'f'.repeat(64) };
      assert.throws(() => f.factory.channel.task(state, wrongScope, f.factory.channel.principal(wrongScope)), { code: 'ROLE_FORBIDDEN' });
      assert.equal(invocation.scope.reworkId, cursorReworkId(await f.store.taskRecord(f.coordinator, f.reserved.session, 'task')));
    }
  });
});
test('A verified CI contradiction can request one original Tester correction without rewriting its proposal or accepting its verdict', async t => {
  const f = await ciFixture(t, { aggregateFailed: true }), p = await ciProposal(f);
  await f.factory.channel.exchange(p.invocation.token, p.input);
  const before = JSON.parse(await fs.readFile(f.file, 'utf8'));
  const next = await f.factory.pump(f.reserved.session, 'task');
  assert.equal(f.calls.length, 4); assert.equal(f.calls[3].method, 'followUp');
  assert.equal(f.calls[3].agentId, p.invocation.scope.nativeAgentId);
  assert.match(f.calls[3].text, /CI result correction/);
  assert.match(f.calls[3].text, /reproduction/);
  assert.notEqual(next.runId, p.invocation.runId); assert.notEqual(next.token, p.invocation.token);
  assert.equal(next.scope.ciAttempt, 1); assert.equal(next.scope.createAttempt, undefined);
  assert.deepEqual(next.scope.session, p.invocation.scope.session);
  assert.equal(next.scope.sourceSha, handoffSha);
  const retained = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(retained.invocations[0], before.invocations[0]);
  assert.equal((await f.factory.channel.context(next.token)).testPolicy.checks[0].machineStatus, 'failed');
  await assert.rejects(f.factory.channel.context(p.invocation.token), { code: 'ROLE_EXPIRED' });
  await assert.rejects(f.factory.channel.exchange(next.token, { id: 'overwrite-old-ci', type: 'object.put', payload: {
    kind: 'evidence', ref: p.evidence.ref, baseVersion: p.evidence.version, content: {},
  } }), { code: 'ROLE_FORBIDDEN' });
  await new CursorRoleFactory(f.options).continueCiResult(f.reserved.session, 'task', p.invocation.runId);
  assert.equal(f.calls.length, 4);
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(task.acceptanceReview, undefined);
  const corrected = await ciProposal(f, { idPrefix: 'correction-', verdict: 'failed', status: 'failed', reproduction: true });
  await f.factory.channel.exchange(corrected.invocation.token, corrected.input);
  await f.factory.pump(f.reserved.session, 'task');
  const final = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(final.stage, 'ci-failed'); assert.equal(final.ci.verdict, 'failed');
  assert.equal(final.acceptanceReview, undefined); assert.equal(f.calls.length, 4);
});
test('CI result correction refuses unverified, revoked, migrated, cancelled or unrelated authority without native follow-up', async t => {
  for (const scenario of ['wrong-run', 'no-native-proof', 'revoked', 'source-lost', 'approval-lost', 'cancelled', 'other-latest', 'evidence-drift', 'binding-drift']) await t.test(scenario, async child => {
    const f = await ciFixture(child, { aggregateFailed: true }), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (scenario === 'revoked') await f.factory.channel.revoke(p.invocation.token);
    if (scenario === 'source-lost') f.setAllowed(false);
    if (scenario === 'approval-lost') await f.store.transaction(state => { Object.values(state.projectTasks)[0].review.decision = 'rejected'; });
    if (scenario === 'cancelled') f.runs.get(p.invocation.scope.nativeAgentId).status = 'CANCELLED';
    if (scenario === 'other-latest') f.provider.getAgent = async agentId => ({ id: agentId, latestRunId: 'external-run' });
    if (scenario === 'no-native-proof') f.provider.readRunEvents = async () => ({ complete: false, events: [] });
    if (scenario === 'evidence-drift') f.provider.readRunEvents = async (...args) => {
      const observed = await f.typedObservation(...args);
      await f.factory.channel.exchange(p.invocation.token, { id: 'change-ci-evidence', type: 'object.put', payload: {
        kind: 'evidence', ref: p.evidence.ref, baseVersion: p.evidence.version, content: { changed: true },
      } });
      return observed;
    };
    if (scenario === 'binding-drift') f.provider.readRunEvents = async (...args) => {
      const observed = await f.typedObservation(...args), principal = f.factory.principal(f.reserved.session.id);
      const binding = await f.store.registeredBinding(principal, f.reserved.session.id);
      await f.store.handle(principal, { v: 2, id: 'ci-correction-binding-move', type: 'session.bind', payload: {
        sessionId: f.reserved.session.id, agentId: f.reserved.session.id, worktreeId: 'another-worktree', expectedBindingVersion: binding.version,
      } }, { allowMigration: true, verifyBinding: () => true });
      return observed;
    };
    await assert.rejects(f.factory.continueCiResult(f.reserved.session, 'task', scenario === 'wrong-run' ? 'another-run' : p.invocation.runId));
    assert.equal(f.calls.length, 3);
    const actor = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.equal(actor.invocations.length, 1); assert.equal(actor.ciCorrection, undefined);
    const task = await f.store.transaction(state => state.tasks[scopedObjectKey(f.human, f.reserved.session, 'task:task')], { readOnly: true });
    assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(task.acceptanceReview, undefined);
  });
});
test('CI result correction retains unknown acknowledgement, one-attempt budget and prepared-expiry boundaries', async t => {
  for (const scenario of ['unknown', 'budget', 'prepared-expired', 'lease-issue-crash']) await t.test(scenario, async child => {
    const f = await ciFixture(child, { aggregateFailed: true }), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (scenario === 'unknown') {
      f.setUncertain('followUp');
      await assert.rejects(f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId), { code: 'CURSOR_TRANSPORT_ERROR' });
      await assert.rejects(new CursorRoleFactory(f.options).continueCiResult(f.reserved.session, 'task', p.invocation.runId), { code: 'CURSOR_ACCEPTANCE_UNKNOWN' });
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'CURSOR_ACCEPTANCE_UNKNOWN' });
      assert.equal(f.calls.length, 4);
    } else if (scenario === 'lease-issue-crash') {
      const issue = f.factory.channel.issue.bind(f.factory.channel); let crash = true;
      f.factory.channel.issue = async input => {
        const lease = await issue(input);
        if (input.scope.ciAttempt && crash) { crash = false; throw Object.assign(new Error('Synthetic crash before new intent'), { code: 'INJECTED_CRASH' }); }
        return lease;
      };
      await assert.rejects(f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId), { code: 'INJECTED_CRASH' });
      await f.factory.channel.context(p.invocation.token);
      assert.equal(f.calls.length, 3);
      await new CursorRoleFactory(f.options).continueCiResult(f.reserved.session, 'task', p.invocation.runId);
      assert.equal(f.calls.length, 4);
    } else if (scenario === 'prepared-expired') {
      const transaction = f.store.transaction.bind(f.store); let crash = true;
      f.store.transaction = async (...args) => {
        const actor = JSON.parse(await fs.readFile(f.file, 'utf8'));
        if (actor.invocations.at(-1)?.scope.ciAttempt && actor.invocations.at(-1).state === 'prepared' && crash) {
          crash = false; throw Object.assign(new Error('Synthetic crash after durable intent'), { code: 'INJECTED_CRASH' });
        }
        return transaction(...args);
      };
      await assert.rejects(f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId), { code: 'INJECTED_CRASH' });
      f.factory.channel.now = () => Date.now() + 7200000;
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'ROLE_EXPIRED' });
      assert.equal(f.calls.length, 3);
    } else {
      await f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId);
      const wrong = await ciProposal(f, { idPrefix: 'wrong-correction-' });
      await f.factory.channel.exchange(wrong.invocation.token, wrong.input);
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
      await f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId);
      assert.equal(f.calls.length, 4);
    }
    const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
    assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(task.acceptanceReview, undefined);
  });
});
test('Concurrent or interrupted CI result corrections cannot duplicate native dispatch or ignore final authority changes', async t => {
  for (const scenario of ['concurrent', 'final-source-lost', 'final-binding-drift', 'final-run-drift', 'scope-invalid']) await t.test(scenario, async child => {
    const f = await ciFixture(child, { aggregateFailed: true }), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (scenario === 'scope-invalid') {
      for (const scope of [{ ...p.invocation.scope, createAttempt: undefined, ciAttempt: 2 },
        { ...p.invocation.scope, createAttempt: 1, ciAttempt: 1 },
        { ...p.invocation.scope, phase: 'plan', createAttempt: undefined, ciAttempt: 1 }]) {
        await assert.rejects(f.factory.channel.issue({ operationId: 'invalid-correction', scope }), { code: 'INVALID_ARGUMENT' });
      }
    } else if (scenario === 'concurrent') {
      const results = await Promise.allSettled([f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId),
        new CursorRoleFactory(f.options).continueCiResult(f.reserved.session, 'task', p.invocation.runId)]);
      assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(f.calls.length, 4);
      assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).invocations.length, 2);
    } else {
      const getAgent = f.provider.getAgent; let changed = false;
      f.provider.getAgent = async agentId => {
        const actor = JSON.parse(await fs.readFile(f.file, 'utf8'));
        if (actor.ciCorrection && !changed) {
          changed = true;
          if (scenario === 'final-source-lost') f.setAllowed(false);
          if (scenario === 'final-binding-drift') {
            const principal = f.factory.principal(f.reserved.session.id), binding = await f.store.registeredBinding(principal, f.reserved.session.id);
            await f.store.handle(principal, { v: 2, id: 'move-binding-before-correction-post', type: 'session.bind', payload: {
              sessionId: f.reserved.session.id, agentId: f.reserved.session.id, worktreeId: 'other-worktree', expectedBindingVersion: binding.version,
            } }, { allowMigration: true, verifyBinding: () => true });
          }
          if (scenario === 'final-run-drift') return { id: agentId, latestRunId: 'unrelated-run' };
        }
        return getAgent(agentId);
      };
      await assert.rejects(f.factory.continueCiResult(f.reserved.session, 'task', p.invocation.runId));
      assert.equal(changed, true);
    }
    if (scenario !== 'concurrent') assert.equal(f.calls.length, 3);
    const task = await f.store.transaction(state => state.tasks[scopedObjectKey(f.human, f.reserved.session, 'task:task')], { readOnly: true });
    assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(task.acceptanceReview, undefined);
  });
});
test('Mapped original CI TODO aliases launch and return through real Core without replacing handoff versions', async t => {
  for (const identity of [{ todoId: 'CI-1' }, { id: 'CI-1' }, { id: 'CI-1', todoId: 'CI-1' }]) await t.test(JSON.stringify(identity), async child => {
    const item = { ...identity, testId: ciPolicy.checks[0].testId, argv: ciPolicy.checks[0].argv, number: 1 };
    const f = await ciFixture(child, { ciTodoItems: [item] }), before = await f.store.taskRecord(f.human, f.reserved.session, 'task');
    assert.match(f.factory.prompt(f.invocation.scope, {}), /write CI TODO items as \{id: check.todoId, testId: check.testId, argv: check.argv\}/);
    assert.match(f.factory.prompt(f.invocation.scope, {}), /number is only a display label, never identity/);
    const p = await ciProposal(f);
    assert.equal(f.calls.length, 3); assert.equal(f.workflowCalls.length, 1);
    await f.factory.channel.exchange(p.invocation.token, p.input); await f.factory.pump(f.reserved.session, 'task');
    const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
    assert.equal(task.stage, 'awaiting-merge'); assert.equal(task.ci.verdict, 'passed'); assert.equal(task.acceptanceReview, undefined);
    assert.deepEqual(task.references, before.references); assert.deepEqual(task.planReview, before.planReview);
    assert.equal(task.sourceSha, handoffSha); assert.notEqual(task.ciTodoResult.version, f.todo.version);
    const state = await f.store.transaction(value => value, { readOnly: true });
    const todo = state.objects[scopedObjectKey(f.human, f.reserved.session, f.todo.ref)];
    assert.deepEqual(todo.versions[f.todo.version].content.items, [item]);
    assert.deepEqual(todo.versions[task.ciTodoResult.version].content.items, [{ ...item, status: 'done', testIds: [ciPolicy.checks[0].testId] }]);
    await f.factory.pump(f.reserved.session, 'task'); assert.equal(f.calls.length, 3); assert.equal(f.workflowCalls.length, 2);
  });
});
test('Conflicting or incomplete TODO mappings fail before workflow reads or another paid native Run', async t => {
  const item = { todoId: 'CI-1', testId: ciPolicy.checks[0].testId, argv: ciPolicy.checks[0].argv };
  const cases = [[{ ...item, id: 'different' }], [{ ...item, id: '' }], [{ todoId: 'CI-1' }],
    [{ ...item, testId: 'wrong' }], [{ ...item, argv: ['node', '--test', 'tests/another.mjs'] }],
    [{ ...item }, { id: 'CI-1' }], [{ id: 'CI-1', testId: 'wrong', argv: item.argv }],
    [{ id: 'CI-1', testId: item.testId }]];
  for (const [index, ciTodoItems] of cases.entries()) await t.test(String(index), async child => {
    const f = await ciFixture(child, { ciTodoItems }), before = await f.store.taskRecord(f.human, f.reserved.session, 'task');
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
    assert.equal(f.calls.length, 2); assert.equal(f.workflowCalls.length, 0);
    assert.deepEqual(await f.store.taskRecord(f.human, f.reserved.session, 'task'), before);
    const tester = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.equal(tester.state, 'reserved'); assert.equal(tester.invocations.length, 0);
  });
});

test('Legacy rejected independent CI create recovers once on the same Agent after exact vendor absence', async t => {
  const f = await ciFixture(t, {ciTodoItems:[{todoId:'CI-1',testId:ciPolicy.checks[0].testId,argv:ciPolicy.checks[0].argv}]}), before = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  const create = f.provider.create, getAgent = f.provider.getAgent;
  f.provider.create = async input => {f.calls.push({method:'create',input});throw Object.assign(new Error('Old coarse rejection without status'), {code:'CURSOR_HTTP_ERROR'});};
  await assert.rejects(f.factory.pump(f.reserved.session,'task'),{code:'CURSOR_HTTP_ERROR'});
  const failed = JSON.parse(await fs.readFile(f.file,'utf8')), original = failed.invocations[0];
  const leaseFile = path.join(f.directory,'roles','capabilities','operations',hash(original.id)+'.json'), oldLease = JSON.parse(await fs.readFile(leaseFile,'utf8'));
  f.provider.create = create;
  let absentReads=0;
  f.provider.getAgent = async id => {if(id===failed.nativeAgentId&&!f.runs.has(id)){absentReads++;throw Object.assign(new Error('Not found'),{code:'CURSOR_NOT_FOUND',httpStatus:404});}return getAgent(id);};
  const [a,b] = await Promise.all([f.factory.pump(f.reserved.session,'task'),f.factory.pump(f.reserved.session,'task')]);
  assert.equal(a.id,b.id);assert.equal(a.scope.createAttempt,1);assert.notEqual(a.token,original.token);
  assert.equal(a.scope.nativeAgentId,failed.nativeAgentId);assert.deepEqual(a.scope.actor,original.scope.actor);assert.deepEqual(a.scope.session,original.scope.session);
  assert.equal(a.scope.sourceSha,handoffSha);assert.equal(a.scope.ciPolicyHash,original.scope.ciPolicyHash);assert.equal(absentReads,1);
  assert.equal(f.calls.length,4);assert.equal(f.calls.at(-1).method,'create');assert.equal(f.calls.at(-1).input.agentId,failed.nativeAgentId);
  const retained = JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.equal(retained.invocations.length,2);assert.deepEqual(retained.invocations[0],original);assert.deepEqual(retained.commands,failed.commands);
  assert.deepEqual(JSON.parse(await fs.readFile(leaseFile,'utf8')),oldLease);await assert.rejects(f.factory.channel.context(original.token),{code:'ROLE_EXPIRED'});
  assert.notEqual((await f.factory.channel.context(a.token)).writePrefix,f.factory.channel.prefix(original.scope));
  assert.deepEqual(await f.store.taskRecord(f.human,f.reserved.session,'task'),before,'No new approval, source or business result');
  const reopened=new CursorRoleFactory(f.options);assert.equal((await reopened.pump(f.reserved.session,'task')).id,a.id);assert.equal(f.calls.length,4);
  const p=await ciProposal(f);assert.equal(p.invocation.id,a.id);
  await f.factory.channel.exchange(p.invocation.token,p.input);await reopened.pump(f.reserved.session,'task');
  const completed=await f.store.taskRecord(f.human,f.reserved.session,'task');
  assert.equal(completed.stage,'awaiting-merge');assert.equal(completed.ci.verdict,'passed');assert.equal(completed.acceptanceReview,undefined);
  assert.equal(completed.sourceSha,before.sourceSha);assert.deepEqual(completed.references,before.references);assert.deepEqual(completed.planReview,before.planReview);
  assert.equal(f.calls.length,4);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).invocations[0],original);
});

test('Legacy CI create recovery refuses visible or unverified vendor state and revoked original authority', async t => {
  for(const kind of ['exists','read-timeout','wrong-404','source-revoked','revoked-during-read','new-diagnostic','uncertain','second-failure']) await t.test(kind,async child=>{
    const f=await ciFixture(child), create=f.provider.create;
    f.provider.create=async input=>{f.calls.push({method:'create',input});throw Object.assign(new Error('Rejected fixture'),{code:'CURSOR_HTTP_ERROR',...(kind==='new-diagnostic'?{httpStatus:400,providerErrorCode:'validation_error'}:{}),...(kind==='uncertain'?{deliveryUncertain:true}:{})});};
    await assert.rejects(f.factory.pump(f.reserved.session,'task'));
    if(kind==='source-revoked')f.setAllowed(false);
    f.provider.getAgent=async()=>{if(kind==='exists')return {id:'existing-native-agent',latestRunId:'foreign'};if(kind==='revoked-during-read')f.setAllowed(false);throw Object.assign(new Error('Read boundary'),{code:kind==='read-timeout'?'CURSOR_TIMEOUT':'CURSOR_NOT_FOUND',httpStatus:kind==='wrong-404'?403:404});};
    if(kind!=='second-failure')f.provider.create=create;
    if(kind==='second-failure'){await assert.rejects(f.factory.pump(f.reserved.session,'task'));assert.equal(f.calls.length,4);await assert.rejects(f.factory.pump(f.reserved.session,'task'));assert.equal(f.calls.length,4);}
    else {await assert.rejects(f.factory.pump(f.reserved.session,'task'));assert.equal(f.calls.length,3);}
    const task=await f.store.taskRecord(f.human,f.reserved.session,'task');assert.equal(task.stage,'testing');assert.equal(task.ci,undefined);assert.equal(task.acceptanceReview,undefined);
  });
});

test('Legacy CI create recovery rejects invalid scopes and never renews a prepared expired lease', async t => {
  const f=await ciFixture(t),create=f.provider.create;
  f.provider.create=async input=>{f.calls.push({method:'create',input});throw Object.assign(new Error('Legacy rejection'),{code:'CURSOR_HTTP_ERROR'});};
  await assert.rejects(f.factory.pump(f.reserved.session,'task'));
  const actor=JSON.parse(await fs.readFile(f.file,'utf8')),original=actor.invocations[0];
  for(const createAttempt of [0,-1,3,1.5,null,'1'])await assert.rejects(f.factory.channel.issue({operationId:'invalid-create-'+String(createAttempt),scope:{...original.scope,createAttempt}}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(f.factory.channel.issue({operationId:'plan-create-attempt',scope:{...f.invocation.scope,phase:'plan',plan:undefined,createAttempt:1}}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(f.factory.channel.issue({operationId:'execution-create-attempt',scope:{...f.invocation.scope,createAttempt:1}}),{code:'INVALID_ARGUMENT'});
  f.provider.create=create;f.provider.getAgent=async()=>{throw Object.assign(new Error('Absent'),{code:'CURSOR_NOT_FOUND',httpStatus:404});};
  const authorize=f.factory.authorizeSource;
  f.factory.authorizeSource=async input=>await authorize(input)&&!(input.actor.invocations.at(-1)?.scope.createAttempt===1);
  await assert.rejects(f.factory.pump(f.reserved.session,'task'),{code:'CURSOR_ROLE_CONFLICT'});
  const prepared=JSON.parse(await fs.readFile(f.file,'utf8')).invocations.at(-1);assert.equal(prepared.state,'prepared');assert.equal(prepared.scope.createAttempt,1);
  const leaseFile=path.join(f.directory,'roles','capabilities','operations',hash(prepared.id)+'.json'),lease=JSON.parse(await fs.readFile(leaseFile,'utf8'));
  f.factory.authorizeSource=authorize;f.factory.channel.now=()=>lease.expiresAt;
  await assert.rejects(f.factory.pump(f.reserved.session,'task'),{code:'ROLE_EXPIRED'});assert.equal(f.calls.length,3);
  assert.deepEqual(JSON.parse(await fs.readFile(leaseFile,'utf8')),lease);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).invocations[0],original);
  assert.equal((await f.store.taskRecord(f.human,f.reserved.session,'task')).stage,'testing');
});

async function sourceRejectedCi(t) {
  const f=await ciFixture(t),create=f.provider.create,getAgent=f.provider.getAgent;let rejects=0;
  f.provider.create=async input=>{f.calls.push({method:'create',input});rejects++;throw Object.assign(new Error('Controlled create refusal'),{code:'CURSOR_HTTP_ERROR',...(rejects>1?{httpStatus:400,providerErrorCode:'validation_error'}:{})});};
  f.provider.getAgent=async id=>{if(!f.runs.has(id))throw Object.assign(new Error('Absent'),{code:'CURSOR_NOT_FOUND',httpStatus:404});return getAgent(id);};
  await assert.rejects(f.factory.pump(f.reserved.session,'task'));await assert.rejects(f.factory.pump(f.reserved.session,'task'));
  f.provider.create=create;f.sourceProof={repository:'example/repo',sourceSha:handoffSha,branch:'cursor/task',number:25};
  f.factory.gitProof.sourcePullRequest=async()=>structuredClone(f.sourceProof);
  return f;
}
test('Exact source PR availability recovers the original rejected Tester once without losing CI gates',async t=>{
  const f=await sourceRejectedCi(t),old=JSON.parse(await fs.readFile(f.file,'utf8')),before=await f.store.taskRecord(f.human,f.reserved.session,'task');
  const invocation=await f.factory.pump(f.reserved.session,'task');assert.equal(invocation.scope.createAttempt,2);assert.equal(f.calls.length,5);
  assert.equal(invocation.scope.nativeAgentId,old.nativeAgentId);assert.deepEqual(invocation.sourceAvailability,f.sourceProof);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).invocations.slice(0,2),old.invocations);
  assert.deepEqual(await f.store.taskRecord(f.human,f.reserved.session,'task'),before);
  const p=await ciProposal(f);await f.factory.channel.exchange(p.invocation.token,p.input);await f.factory.pump(f.reserved.session,'task');
  const task=await f.store.taskRecord(f.human,f.reserved.session,'task');assert.equal(task.ci.verdict,'passed');assert.equal(task.stage,'awaiting-merge');assert.equal(task.acceptanceReview,undefined);
  assert.deepEqual(task.planReview,before.planReview);assert.deepEqual(task.references,before.references);assert.equal(f.calls.length,5);
});
test('Exact source PR final read refuses a migrated original Executor before native create',async t=>{
  const f=await sourceRejectedCi(t);let reads=0;
  f.factory.gitProof.sourcePullRequest=async()=>{
    if(++reads===2){
      const binding=await f.store.registeredBinding(f.human,f.reserved.session.id);
      await f.store.handle(f.factory.principal(f.reserved.session.id),{v:2,id:'source-proof-executor-migration',type:'session.bind',payload:{
        sessionId:f.reserved.session.id,agentId:f.reserved.session.id,worktreeId:'another-owned-tree',expectedBindingVersion:binding.version,
      }},{verifyBinding:()=>true,allowMigration:true});
    }
    return structuredClone(f.sourceProof);
  };
  let rejection;try{await f.factory.pump(f.reserved.session,'task');}catch(error){rejection=error;}
  assert.equal(reads,2);assert.equal(f.calls.length,4,'Do not create a native Run after the original Executor binding changed');
  assert.equal(rejection?.code,'CURSOR_ROLE_CONFLICT');
});
test('Exact source PR recovery refuses missing proof, drift, revoked authority and another failed retry',async t=>{
  for(const kind of ['missing','wrong-source','foreign-repo','changed-pr','revoked','exists','second-failure'])await t.test(kind,async child=>{
    const f=await sourceRejectedCi(child);let reads=0;
    f.factory.gitProof.sourcePullRequest=async()=>{reads++;if(kind==='missing')throw Object.assign(new Error('No PR'),{code:'SOURCE_UNVERIFIED'});if(kind==='revoked')f.setAllowed(false);return {...f.sourceProof,...(kind==='wrong-source'?{sourceSha:baseSha}:{}),...(kind==='foreign-repo'?{repository:'other/repo'}:{}),...(kind==='changed-pr'&&reads>1?{number:26}:{})};};
    if(kind==='exists')f.provider.getAgent=async()=>({id:'visible-agent'});
    if(kind==='second-failure')f.provider.create=async input=>{f.calls.push({method:'create',input});throw Object.assign(new Error('Still rejected'),{code:'CURSOR_HTTP_ERROR',httpStatus:400,providerErrorCode:'validation_error'});};
    await assert.rejects(f.factory.pump(f.reserved.session,'task'));assert.equal(f.calls.length,kind==='second-failure'?5:4);
    await assert.rejects(f.factory.pump(f.reserved.session,'task'));assert.equal(f.calls.length,kind==='second-failure'?5:4);
    const task=await f.store.taskRecord(f.human,f.reserved.session,'task');assert.equal(task.stage,'testing');assert.equal(task.ci,undefined);assert.equal(task.acceptanceReview,undefined);
  });
});
test('Rejected native CI create stores only safe status and documented code with its original failure receipt', async t => {
  const f=await ciFixture(t);
  f.provider.create=async input=>{f.calls.push({method:'create',input});throw Object.assign(new Error('Do not save provider text'),{code:'CURSOR_HTTP_ERROR',httpStatus:400,providerErrorCode:'validation_error',details:'fixture-private-diagnostic'});};
  await assert.rejects(f.factory.pump(f.reserved.session,'task'),{code:'CURSOR_HTTP_ERROR'});
  const actor=JSON.parse(await fs.readFile(f.file,'utf8')),i=actor.invocations.at(-1);
  assert.equal(i.error,'CURSOR_HTTP_ERROR');assert.equal(i.httpStatus,400);assert.equal(i.providerErrorCode,'validation_error');assert.equal(i.runId,undefined);
  assert.equal(JSON.stringify(actor).includes('fixture-private-diagnostic'),false);assert.equal(JSON.stringify(actor).includes('Do not save provider text'),false);
  await assert.rejects(f.factory.pump(f.reserved.session,'task'),{code:'CURSOR_ROLE_FAILED'});assert.equal(f.calls.length,3);
});
test('Independent Cursor CI original proposal reaches the original task only with native observation AND declared exact-source workflow facts', async t => {
  const f = await ciFixture(t), p = await ciProposal(f);
  assert.notEqual(p.invocation.scope.nativeAgentId, f.invocation.scope.nativeAgentId);
  assert.notEqual(p.context.actor.id, f.reserved.session.id); assert.equal(p.context.testPolicy.checks[0].machineStatus, 'passed');
  assert.match(p.context.testPolicy.checks[0].command, /CG_CURSOR_PROOF/);
  f.runs.get(p.invocation.scope.nativeAgentId).status = 'RUNNING';
  assert.equal((await f.factory.channel.exchange(p.invocation.token, p.input)).data.state, 'proof-pending');
  assert.deepEqual(await f.factory.pump(f.reserved.session, 'task'), { state: 'proof-pending' });
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'testing');
  f.runs.get(p.invocation.scope.nativeAgentId).status = 'FINISHED';
  const reopened = new CursorRoleFactory(f.options); await reopened.pump(f.reserved.session, 'task');
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'awaiting-merge'); assert.equal(task.ci.verdict, 'passed'); assert.equal(task.acceptanceReview, undefined);
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.cursorRoleCiResults).length, 1); assert.equal(f.calls.length, 3);
  assert.equal(f.workflowCalls.length, 2); assert.equal(f.workflowCalls.every(call => call.sourceSha === handoffSha && call.branch === 'cursor/task'), true);
  await reopened.pump(f.reserved.session, 'task'); assert.equal(f.calls.length, 3); assert.equal(f.workflowCalls.length, 2);
});
test('Host verifies an original finished CI proposal after delegate expiry without renewing or exposing its capability', async t => {
  const f = await ciFixture(t), p = await ciProposal(f);
  await f.factory.channel.exchange(p.invocation.token, p.input);
  const leaseFile = path.join(f.factory.channel.directory, 'operations', hash(p.invocation.id) + '.json');
  const originalLease = await fs.readFile(leaseFile, 'utf8');
  f.factory.channel.now = () => Date.now() + 7200000;
  await assert.rejects(f.factory.channel.context(p.invocation.token), { code: 'ROLE_EXPIRED' });
  await assert.rejects(f.factory.channel.exchange(p.invocation.token, p.input), { code: 'ROLE_EXPIRED' });
  await f.factory.pump(f.reserved.session, 'task');
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'awaiting-merge'); assert.equal(task.ci.verdict, 'passed');
  assert.equal(task.acceptanceReview, undefined); assert.equal(f.calls.length, 3);
  assert.equal(await fs.readFile(leaseFile, 'utf8'), originalLease, 'Original expired delegation must remain byte-identical');
  await assert.rejects(f.factory.channel.context(p.invocation.token), { code: 'ROLE_EXPIRED' });
  await f.factory.pump(f.reserved.session, 'task'); assert.equal(f.calls.length, 3);
});

test('Expired delegate host verification retains current revocation, source access and aggregate CI gates', async t => {
  for (const change of ['revoked', 'source-access', 'aggregate-failed']) await t.test(change, async child => {
    const f = await ciFixture(child, { aggregateFailed: change === 'aggregate-failed' }), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (change === 'revoked') await f.factory.channel.revoke(p.invocation.token);
    if (change === 'source-access') f.setAllowed(false);
    f.factory.channel.now = () => Date.now() + 7200000;
    if (change === 'aggregate-failed') assert.equal((await f.factory.pump(f.reserved.session, 'task')).scope.ciAttempt, 1);
    else await assert.rejects(f.factory.pump(f.reserved.session, 'task'), error => ['ROLE_EXPIRED', 'ROLE_UNAVAILABLE', 'CURSOR_ROLE_CONFLICT'].includes(error.code));
    const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
    assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(f.calls.length, change === 'aggregate-failed' ? 4 : 3);
  });
});

test('Host completion rejects missing proof, another message and binding migration after native observation', async t => {
  for (const change of ['no-proof', 'another-message', 'migrated-executor']) await t.test(change, async child => {
    const f = await ciFixture(child), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    f.factory.channel.now = () => Date.now() + 7200000;
    const actor = JSON.parse(await fs.readFile(f.file, 'utf8')), invocation = actor.invocations.at(-1);
    if (change === 'no-proof') await assert.rejects(f.factory.channel.hostCiExchange(invocation, p.input), { code: 'SOURCE_UNVERIFIED' });
    if (change === 'another-message') await assert.rejects(f.factory.channel.hostCiExchange(invocation, { ...p.input, id: 'another-message' }), { code: 'ROLE_FORBIDDEN' });
    if (change === 'migrated-executor') {
      const original = f.provider.readRunEvents;
      f.provider.readRunEvents = async (...args) => {
        const observed = await original(...args);
        const principal = f.factory.principal(f.reserved.session.id);
        const binding = await f.store.registeredBinding(principal, f.reserved.session.id);
        await f.store.handle(principal, { v: 2, id: 'move-executor-after-native-read', type: 'session.bind', payload: {
          sessionId: f.reserved.session.id, agentId: f.reserved.session.id, worktreeId: 'another-worktree', expectedBindingVersion: binding.version,
        } }, { allowMigration: true, verifyBinding: () => true });
        return observed;
      };
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), error => ['ROLE_FORBIDDEN', 'ROLE_UNAVAILABLE', 'CURSOR_ROLE_CONFLICT'].includes(error.code));
    }
    const state = await f.store.transaction(value => value, { readOnly: true });
    const task = state.tasks[scopedObjectKey(f.human, f.reserved.session, 'task:task')];
    assert.equal(task.stage, 'testing'); assert.equal(task.ci, undefined); assert.equal(f.calls.length, 3);
    assert.equal(Object.keys(state.cursorRoleCiResults || {}).length, 0);
  });
});

test('CI cannot invent numbered coverage, reuse another message ID or replace the saved native proposal', async t => {
  const f = await ciFixture(t), p = await ciProposal(f);
  await assert.rejects(f.factory.channel.exchange(p.invocation.token, { ...p.input, id: 'ci-evidence' }), { code: 'ID_REUSED' });
  await assert.rejects(f.factory.channel.exchange(p.invocation.token, { ...p.input, payload: { ...p.input.payload,
    checks: [{ ...p.input.payload.checks[0], testId: 'invented-test' }] } }), { code: 'SOURCE_UNVERIFIED' });
  await f.factory.channel.exchange(p.invocation.token, p.input);
  await assert.rejects(f.factory.channel.exchange(p.invocation.token, { ...p.input, id: 'replacement-ci' }), { code: 'ID_REUSED' });
  await f.factory.pump(f.reserved.session, 'task'); assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).ci.verdict, 'passed');
});
test('Actual failed native or workflow tests cannot be promoted by FINISHED or a passing CI proposal', async t => {
  for (const failure of ['native', 'workflow']) await t.test(failure, async child => {
    const f = await ciFixture(child, { nativeFailed: failure === 'native', machineFailed: failure === 'workflow' }), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    assert.equal((await f.factory.pump(f.reserved.session, 'task')).scope.ciAttempt, 1);
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'testing'); assert.equal(f.calls.length, 4);
  });
});
test('A truthful failed independent CI preserves owned reproduction evidence and original task failure', async t => {
  const f = await ciFixture(t, { nativeFailed: true, machineFailed: true }), p = await ciProposal(f, { verdict: 'failed', status: 'failed', reproduction: true });
  await f.factory.channel.exchange(p.invocation.token, p.input); await f.factory.pump(f.reserved.session, 'task');
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'ci-failed'); assert.equal(task.ci.verdict, 'failed'); assert.equal(f.calls.length, 3);
});
test('Mapped alias CI honestly returns aggregate workflow failure even when its exact job and native command pass', async t => {
  const item = { todoId: 'CI-1', testId: ciPolicy.checks[0].testId, argv: ciPolicy.checks[0].argv };
  const f = await ciFixture(t, { aggregateFailed: true, ciTodoItems: [item] });
  const p = await ciProposal(f, { verdict: 'failed', status: 'failed', reproduction: true });
  assert.equal(p.context.testPolicy.checks[0].machineStatus, 'failed');
  assert.equal(f.machine[0].conclusion, 'success'); assert.equal(f.machine[0].testConclusion, 'success');
  await f.factory.channel.exchange(p.invocation.token, p.input); await f.factory.pump(f.reserved.session, 'task');
  const task = await f.store.taskRecord(f.human, f.reserved.session, 'task');
  assert.equal(task.stage, 'ci-failed'); assert.equal(task.ci.verdict, 'failed'); assert.equal(task.review, undefined);
  assert.equal(task.acceptanceReview, undefined); assert.equal(f.calls.length, 3);
  const state = await f.store.transaction(value => value, { readOnly: true });
  const todo = state.objects[scopedObjectKey(f.human, f.reserved.session, f.todo.ref)];
  assert.deepEqual(todo.versions[f.todo.version].content.items, [item]);
  assert.deepEqual(todo.versions[task.ciTodoResult.version].content.items, [{ ...item, status: 'pending', testIds: [item.testId] }]);
  const ci = state.objects[scopedObjectKey(f.human, f.reserved.session, task.ci.ref)].versions[task.ci.version];
  assert.equal(ci.content.checks[0].reproductionRef, p.input.payload.checks[0].reproductionRef);
});
test('Pending workflow facts do not launch CI, and a policy change cannot reauthorize an existing role', async t => {
  const f = await ciFixture(t, { unavailable: true });
  for (let i = 0; i < 2; i++) await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
  assert.equal(f.calls.length, 2); assert.equal(f.workflowCalls.length, 1);
  const reopened = new CursorRoleFactory({ ...f.options, ciPolicy: { checks: [{ ...ciPolicy.checks[0], testStep: 'Different test step' }] } });
  await assert.rejects(reopened.pump(f.reserved.session, 'task'), { code: 'CURSOR_ROLE_CONFLICT' });
  assert.equal(f.calls.length, 2);
});
test('A missing or malformed original CI TODO cannot launch an independent native Run', async t => {
  for (const mode of ['missing', 'kind', 'coverage']) await t.test(mode, async child => {
    const f = await ciFixture(child);
    await f.store.transaction(state => {
      const key = hash(canonical(['123', f.reserved.session.id, f.reserved.session.generation, f.todo.ref]));
      const todo = state.objects[key];
      if (mode === 'missing') delete state.objects[key];
      else if (mode === 'kind') todo.versions[todo.latest].kind = 'evidence';
      else todo.versions[todo.latest].content.items[0].id = 'unconfigured-todo';
    });
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
    assert.equal(f.calls.length, 2); assert.equal(f.workflowCalls.length, 0);
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'testing');
  });
});
test('CI evidence or host identity drift during observer reads cannot commit a CI verdict', async t => {
  for (const drift of ['evidence', 'run']) await t.test(drift, async child => {
    const f = await ciFixture(child), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    f.provider.readRunEvents = async (...args) => {
      const observed = await f.typedObservation(...args);
      if (drift === 'run') f.provider.getAgent = async agentId => ({ id: agentId, latestRunId: 'external-run' });
      else await f.factory.channel.exchange(p.invocation.token, { id: 'new-ci-evidence', type: 'object.put', payload: { kind: 'evidence', ref: p.evidence.ref,
        baseVersion: p.evidence.version, content: { changed: true } } });
      return observed;
    };
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'testing'); assert.equal(f.calls.length, 3);
  });
});
test('Concurrent CI verifiers and a lost acknowledgement commit only the original result once', async t => {
  for (const mode of ['concurrent', 'lost-ack']) await t.test(mode, async child => {
    const f = await ciFixture(child), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (mode === 'lost-ack') {
      const exchange = f.factory.channel.exchange.bind(f.factory.channel);
      f.factory.channel.exchange = async (...args) => { const reply = await exchange(...args);
        if (args[1].type === 'ci.result') throw Object.assign(new Error('Synthetic lost CI reply after commit'), { code: 'ACK_UNKNOWN' });
        return reply;
      };
      await f.factory.pump(f.reserved.session, 'task');
      await new CursorRoleFactory(f.options).pump(f.reserved.session, 'task');
    } else await Promise.all([f.factory.pump(f.reserved.session, 'task'), new CursorRoleFactory(f.options).pump(f.reserved.session, 'task')]);
    const state = await f.store.transaction(value => value, { readOnly: true });
    assert.equal(Object.values(state.cursorRoleCiResults).length, 1);
    assert.equal(Object.values(state.queues).flatMap(queue => queue.items).filter(item => item.message.type === 'ci.result').length, 1);
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).ci.verdict, 'passed'); assert.equal(f.calls.length, 3);
  });
});
test('Revoked native CI capability or human approval cannot accept a saved passing proposal', async t => {
  for (const mode of ['capability', 'approval']) await t.test(mode, async child => {
    const f = await ciFixture(child), p = await ciProposal(f);
    await f.factory.channel.exchange(p.invocation.token, p.input);
    if (mode === 'capability') await f.factory.channel.revoke(p.invocation.token);
    else await f.store.transaction(state => { Object.values(state.projectTasks)[0].review.decision = 'rejected'; });
    await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: mode === 'capability' ? 'ROLE_EXPIRED' : 'CURSOR_ROLE_CONFLICT' });
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'testing'); assert.equal(f.calls.length, 3);
  });
});
test('Private CI policy rejects command injection, missing trusted workflow identity, duplicate IDs and oversized contexts before native calls', async t => {
  const f = await fixture(t), cases = [
    { checks: [] }, { checks: [{ ...ciPolicy.checks[0], argv: ['node', 'test\nother-command'] }] },
    { checks: [{ ...ciPolicy.checks[0], appId: 999 }] }, { checks: [{ ...ciPolicy.checks[0], workflowBlobSha: '' }] },
    { checks: [ciPolicy.checks[0], ciPolicy.checks[0]] },
    { checks: [{ ...ciPolicy.checks[0], argv: Array.from({ length: 10 }, () => 'x'.repeat(1000)) }] },
  ];
  for (const policy of cases) assert.throws(() => new CursorRoleFactory({ ...f.options, ciPolicy: policy }), { code: 'SOURCE_UNVERIFIED' });
  assert.equal(f.calls.length, 0);
});

test('Deferred Cursor handoff rejects another request, malformed or foreign references without replacing its saved proposal', async t => {
  const f = await handoffFixture(t);
  await assert.rejects(f.factory.channel.exchange(f.invocation.token, { ...f.input, payload: { ...f.input.payload,
    data: { ...f.input.payload.data, ciTodoRef: 'foreign' } } }), { code: 'ROLE_FORBIDDEN' });
  await assert.rejects(f.factory.channel.exchange(f.invocation.token, { ...f.input, payload: { ...f.input.payload,
    data: { ...f.input.payload.data, sourceSha: 'bad-sha' } } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.factory.channel.exchange(f.invocation.token, { ...f.input, id: 'handoff-unit' }), { code: 'ID_REUSED' });
  const actor = JSON.parse(await fs.readFile(f.factory.executorFile(f.reserved.session.id), 'utf8'));
  assert.equal(actor.invocations.at(-1).handoff, undefined, 'A consumed ID cannot reserve a poisoned proposal');
  await f.factory.channel.exchange(f.invocation.token, f.input);
  await assert.rejects(f.factory.channel.exchange(f.invocation.token, { ...f.input, id: 'replacement-handoff' }), { code: 'ID_REUSED' });
  await f.factory.pump(f.reserved.session, 'task');
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'awaiting-ci'); assert.equal(f.calls.length, 2);
});

test('Git read failure retains the original Cursor proposal and cannot start another model or fabricate CI', async t => {
  let available = false;
  const f = await handoffFixture(t, input => {
    if (!available) throw Object.assign(new Error('Synthetic unavailable source host'), { code: 'SOURCE_UNVERIFIED' });
    return { baseSha: input.baseSha, sourceSha: input.sourceSha, branch: 'cursor/task', repository: 'example/repo', files: ['src/fixture.mjs'] };
  });
  await f.factory.channel.exchange(f.invocation.token, f.input);
  for (let i = 0; i < 2; i++) await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
  assert.equal(f.calls.length, 2); assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'executing');
  available = true; await new CursorRoleFactory(f.options).pump(f.reserved.session, 'task');
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'awaiting-ci'); assert.equal(f.calls.length, 2);
});

test('Deferred handoff fails closed after authority, version, native identity or Plan paths drift', async t => {
  for (const changed of ['evidence', 'task-version', 'template', 'source-access', 'capability', 'native-run', 'latest-run', 'run-failed', 'paths']) await t.test(changed, async child => {
    const f = await handoffFixture(child);
    if (changed === 'paths') {
      await f.store.transaction(state => { state.objects[hash(canonical(['123', f.reserved.session.id, f.reserved.session.generation, f.invocation.scope.plan.ref]))].versions[f.invocation.scope.plan.version].content.paths = ['../outside']; });
      await assert.rejects(f.factory.channel.exchange(f.invocation.token, f.input), { code: 'SOURCE_UNVERIFIED' });
    } else {
      await f.factory.channel.exchange(f.invocation.token, f.input);
      if (changed === 'source-access') f.setAllowed(false);
      else if (changed === 'capability') await f.factory.channel.revoke(f.invocation.token);
      else if (changed === 'native-run') f.provider.getRun = async agentId => ({ agentId, id: 'another-run', status: 'FINISHED' });
      else if (changed === 'latest-run') f.provider.getAgent = async agentId => ({ id: agentId, latestRunId: 'another-run' });
      else if (changed === 'run-failed') f.runs.get(f.invocation.scope.nativeAgentId).status = 'ERROR';
      else await f.store.transaction(state => {
        if (changed === 'template') state.bindings[hash(canonical(['123', templateId]))].generation++;
        else if (changed === 'task-version') Object.values(state.tasks)[0].version = 'new-progress-version';
        else state.objects[hash(canonical(['123', f.reserved.session.id, f.reserved.session.generation, f.evidence.ref]))].latest = 'missing-evidence';
      });
      const code = ({ evidence: 'SOURCE_UNVERIFIED', 'task-version': 'SOURCE_UNVERIFIED', template: 'CURSOR_ROLE_CONFLICT',
        'source-access': 'ROLE_UNAVAILABLE', capability: 'ROLE_EXPIRED' })[changed] || 'SOURCE_UNVERIFIED';
      await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code });
    }
    assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'executing');
    assert.equal(f.calls.length, 2);
  });
});

test('Concurrent hosted verifiers apply one original handoff and preserve the same independent CI reservation', async t => {
  const f = await handoffFixture(t);
  await f.factory.channel.exchange(f.invocation.token, f.input);
  const reopened = new CursorRoleFactory(f.options);
  const results = await Promise.all([f.factory.pump(f.reserved.session, 'task'), reopened.pump(f.reserved.session, 'task')]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].nativeState, 'reserved');
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.cursorRoleHandoffs).length, 1);
  assert.equal(Object.values(state.queues).flatMap(queue => queue.items).filter(item => item.message.type === 'task.report' && item.message.payload.stage === 'handoff').length, 1);
  assert.equal(f.calls.length, 2);
});

test('Lost handoff acknowledgement is resolved from its atomic core marker, not a model retry or adapter flag', async t => {
  const f = await handoffFixture(t);
  await f.factory.channel.exchange(f.invocation.token, f.input);
  const exchange = f.factory.channel.exchange.bind(f.factory.channel);
  f.factory.channel.exchange = async (...args) => {
    const reply = await exchange(...args);
    if (args[1].type === 'task.report' && reply.data.stage === 'awaiting-ci') throw Object.assign(new Error('Synthetic lost reply after core commit'), { code: 'ACK_UNKNOWN' });
    return reply;
  };
  await f.factory.pump(f.reserved.session, 'task');
  await new CursorRoleFactory(f.options).pump(f.reserved.session, 'task');
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.cursorRoleHandoffs).length, 1);
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'awaiting-ci');
  assert.equal(f.inspected.length, 1); assert.equal(f.calls.length, 2);
});

test('Git verification holds no task or capability lock; evidence changed during the read is not applied', async t => {
  const f = await handoffFixture(t, async (input, fixture) => {
    // Actual exchange succeeds while the source read is in flight. A lock
    // inversion would hang this test rather than produce the expected refusal.
    await fixture.factory.channel.exchange(fixture.invocation.token, { id: 'changed-unit-during-git', type: 'object.put',
      payload: { kind: 'evidence', ref: fixture.evidence.ref, baseVersion: fixture.evidence.version, content: { changed: true } } });
    return { baseSha: input.baseSha, sourceSha: input.sourceSha, repository: 'example/repo', branch: 'cursor/task', files: [] };
  });
  await f.factory.channel.exchange(f.invocation.token, f.input);
  await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'executing'); assert.equal(f.calls.length, 2);
});

test('A native Agent reused while Git is being read cannot authorize the original pending handoff', async t => {
  const f = await handoffFixture(t, (input, fixture) => {
    fixture.provider.getAgent = async agentId => ({ id: agentId, latestRunId: 'external-later-run' });
    return { baseSha: input.baseSha, sourceSha: input.sourceSha, repository: 'example/repo', branch: 'cursor/task', files: [] };
  });
  await f.factory.channel.exchange(f.invocation.token, f.input);
  await assert.rejects(f.factory.pump(f.reserved.session, 'task'), { code: 'SOURCE_UNVERIFIED' });
  assert.equal((await f.store.taskRecord(f.human, f.reserved.session, 'task')).stage, 'executing'); assert.equal(f.calls.length, 2);
});
