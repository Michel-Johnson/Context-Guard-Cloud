import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CursorRoleChannel } from '../scripts/cloud/cursor-role-channel.mjs';
import { createCursorRoleMcpHandler } from '../scripts/cloud/cursor-role-mcp.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { canonical } from '../scripts/shared/protocol.mjs';
import { scopedObjectKey } from '../scripts/shared/protocol-workflow.mjs';
import { hash } from '../scripts/shared/io.mjs';

// Real durable ProtocolStore and protocol transitions. Only the provider/Git
// verifier is synthetic; these tests do not prove actual Cursor task completion.
const executorId = '11111111-1111-4111-8111-111111111111';
const testerId = '22222222-2222-4222-8222-222222222222';
const sourceSha = 'a'.repeat(40), resultSha = 'b'.repeat(40);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-role-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ProtocolStore(path.join(directory, 'protocol'));
  const session = { id: executorId, generation: 1 }, actor = { id: testerId, generation: 1 };
  const executor = { repositoryId: 'repo', deviceId: 'cloud-cursor:project', agentId: executorId, role: 'executor' };
  const tester = { ...executor, agentId: testerId, role: 'executor' };
  const coordinator = { ...executor, agentId: 'coordinator', role: 'coordinator', bindings: { [executorId]: 'executor-tree' } };
  const human = { ...executor, agentId: 'human', role: 'human' };
  let seq = 0, clock = 1700000000000;
  const send = async (principal, type, payload, options = {}) => (await store.handle(principal,
    { v: 2, id: 'fixture-' + ++seq, type, session, payload }, options)).data;
  for (const [principal, id, worktreeId] of [[executor, executorId, 'executor-tree'], [tester, testerId, 'tester-tree']]) {
    await store.handle(principal, { v: 2, id: 'bind-' + id, type: 'session.bind', payload: {
      sessionId: id, agentId: id, worktreeId, expectedBindingVersion: '',
    } }, { verifyBinding: () => true });
  }
  const brief = await send(coordinator, 'brief.submit', { taskId: 'task', text: 'Implement the approved small task' });
  await send(coordinator, 'review.request', { taskId: 'task', kind: 'brief', ...briefFields(brief) });
  await send(human, 'review.result', { kind: 'brief', ...briefFields(brief), decision: 'approved', reason: 'Approved target' });
  await send(coordinator, 'task.assign', { taskId: 'task', briefRef: brief.ref, briefVersion: brief.version,
    sessionId: executorId, nodeIds: ['node'], mainVersion: 'main-1' }, { workflow: { verifyRouting: () => true } });
  const base = { projectId: 'project', repositoryId: 'repo', ownerId: executor.deviceId, session, actor: session,
    worktreeId: 'executor-tree', actorWorktreeId: 'executor-tree', nativeAgentId: 'bc-33333333-3333-4333-8333-333333333333', taskId: 'task', sourceSha };
  const receivers = new Map();
  const scopeKey = scope => hash(canonical(scope));
  const resolver = async scope => receivers.get(scopeKey(scope));
  const channelOptions = { directory: path.join(directory, 'roles'), store, resolveReceiver: resolver, now: () => clock };
  const channel = new CursorRoleChannel(channelOptions);
  const issue = async (phase, extra = {}, options = {}) => {
    const scope = { ...base, phase, ...extra };
    const lease = await channel.issue({ operationId: options.operationId || phase, scope, ...options });
    receivers.set(scopeKey(scope), { active: true, scopeHash: scopeKey(scope), nativeAgentId: scope.nativeAgentId,
      ...(phase === 'ci' ? { executorNativeAgentId: base.nativeAgentId } : {}), runId: 'run-' + phase });
    await channel.activate(lease.token);
    return { ...lease, scope, receiver: receivers.get(scopeKey(scope)) };
  };
  const own = (role, suffix) => `${role === 'ci' ? 'ci' : 'cursor'}:${hash(canonical([role === 'ci' ? testerId : executorId, 'task']))}:${suffix}`;
  const put = (lease, suffix, kind, content = { description: suffix }, id = suffix) => channel.exchange(lease.token,
    { id, type: 'object.put', payload: { ref: own(lease.scope.phase, suffix), kind, baseVersion: '', content } });
  const preparePlan = async () => {
    const lease = await issue('plan');
    const plan = (await put(lease, 'plan', 'plan', { steps: ['Implement', 'Test'] })).data;
    const report = { id: 'plan-ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha } } };
    await channel.exchange(lease.token, report);
    return { lease, plan, report };
  };
  const prepareExecution = async () => {
    const prepared = await preparePlan();
    await send(coordinator, 'review.request', { taskId: 'task', kind: 'plan', ...briefFields(prepared.plan),
      requirementsRef: brief.ref, requirementsVersion: brief.version, rulesVersion: 'rules-1' });
    await send(coordinator, 'review.result', { kind: 'plan', ...briefFields(prepared.plan), decision: 'approved', reason: 'Reviewed exact Plan' });
    const lease = await issue('execution', { plan: prepared.plan });
    return { ...prepared, execution: lease };
  };
  const prepareCi = async () => {
    const prepared = await prepareExecution(), lease = prepared.execution;
    const ciTodo = (await put(lease, 'todo', 'ciTodo', { items: [{ id: 'todo-1', title: 'Independent check' }] })).data;
    const evidence = (await put(lease, 'unit', 'evidence', { command: 'node --test', exitCode: 0 })).data;
    const handoff = { taskId: 'task', stage: 'handoff', data: { sourceSha: resultSha,
      ciTodoRef: ciTodo.ref, unitTestRefs: [evidence.ref], experienceRefs: [] } };
    lease.receiver.verifiedHandoff = { sourceSha: resultSha, proofId: 'synthetic-git-proof', runId: 'run-execution', nativeAgentId: lease.scope.nativeAgentId,
      baseSha: sourceSha, references: { [ciTodo.ref]: ciTodo.version, [evidence.ref]: evidence.version } };
    await channel.exchange(lease.token, { id: 'handoff', type: 'task.report', payload: handoff });
    await send(coordinator, 'ci.request', { taskId: 'task', sourceSha: resultSha,
      ciTodoRef: ciTodo.ref, unitTestRefs: [evidence.ref] }, { workflow: { verifyCiReceiver: () => true } });
    const ci = await issue('ci', { actor, actorWorktreeId: 'tester-tree', sourceSha: resultSha,
      nativeAgentId: 'bc-44444444-4444-4444-8444-444444444444' });
    return { ...prepared, ci, ciTodo, evidence, handoff };
  };
  return { directory, store, channel, channelOptions, base, issue, receivers, resolver, scopeKey, own, put, send, executor, tester, coordinator,
    session, actor, brief, preparePlan, prepareExecution, prepareCi, setClock: value => { clock = value; }, task: () => store.taskRecord(coordinator, session, 'task') };
}
const briefFields = value => ({ ref: value.ref, version: value.version });

test('Cursor role leases start dormant; concurrent issuance and restart preserve scope, expiry and revocation', async t => {
  const f = await fixture(t), scope = { ...f.base, phase: 'plan' };
  const request = { operationId: 'stable', scope, ttlMs: 60000 };
  const leases = await Promise.all([f.channel.issue(request), f.channel.issue(request)]);
  assert.deepEqual(leases[0], leases[1]);
  assert.equal(leases[0].state, 'dormant');
  await assert.rejects(f.channel.context(leases[0].token), { code: 'ROLE_UNAVAILABLE' });
  await assert.rejects(f.channel.activate(leases[0].token), { code: 'ROLE_UNAVAILABLE' });
  await assert.rejects(f.channel.issue({ ...request, scope: { ...scope, taskId: 'other' } }), { code: 'ID_REUSED' });
  f.receivers.set(f.scopeKey(scope), { active: true, scopeHash: f.scopeKey(scope), nativeAgentId: scope.nativeAgentId, runId: 'run-plan' });
  await f.channel.activate(leases[0].token);
  const restarted = new CursorRoleChannel(f.channelOptions);
  assert.equal((await restarted.context(leases[0].token)).taskId, 'task');
  f.setClock(1700000060000);
  await assert.rejects(restarted.context(leases[0].token), { code: 'ROLE_EXPIRED' });
  assert.equal((await restarted.issue(request)).expiresAt, leases[0].expiresAt, 'replay does not renew');
  await restarted.revoke(leases[0].token);
  assert.equal((await restarted.issue(request)).state, 'revoked');
  await assert.rejects(restarted.activate(leases[0].token), { code: 'ROLE_EXPIRED' });
  if (process.platform !== 'win32') {
    const operationFile = path.join(f.directory, 'roles', 'operations', hash('stable') + '.json');
    assert.equal((await fs.stat(operationFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(f.directory, 'roles'))).mode & 0o777, 0o700);
  }
});

test('Cursor Plan bridge reads only immutable task references and returns Plan to the original protocol task', async t => {
  const f = await fixture(t), { lease, plan, report } = await f.preparePlan();
  const read = await f.channel.exchange(lease.token, { id: 'read-brief', type: 'object.read', payload: briefFields(f.brief) });
  assert.equal(read.data.kind, 'brief');
  assert.equal(read.data.content.text, 'Implement the approved small task');
  assert.equal((await f.task()).stage, 'plan-ready');
  assert.deepEqual((await f.task()).plan, plan);
  assert.deepEqual((await f.channel.exchange(lease.token, report)).data.plan, undefined);
  const state = await f.store.transaction(value => value, { readOnly: true });
  const notices = Object.values(state.queues).flatMap(queue => queue.items).filter(item => item.message.type === 'task.report');
  assert.equal(notices.length, 1, 'Plan replay does not notify twice');
  assert.deepEqual(notices[0].message.session, f.session);
  const context = await f.channel.context(lease.token);
  assert.equal(context.phase, 'plan');
  assert.equal(context.stage, 'plan-ready');
  assert.equal(JSON.stringify(context).includes(lease.token), false);
  await assert.rejects(f.put(lease, 'replacement', 'plan'), { code: 'ROLE_FORBIDDEN' });
});

test('Cursor Plan cannot approve itself, run execution, impersonate Sessions or read another task', async t => {
  const f = await fixture(t), lease = await f.issue('plan');
  const before = await f.store.transaction(state => state, { readOnly: true });
  const rejected = [
    { id: 'review', type: 'review.result', payload: { kind: 'brief', ...briefFields(f.brief), decision: 'approved', reason: 'self' } },
    { id: 'progress', type: 'task.report', payload: { taskId: 'task', stage: 'progress', data: { seq: 1, summary: 'too early' } } },
    { id: 'cross-task', type: 'task.report', payload: { taskId: 'other', stage: 'planReady', data: { planRef: f.own('plan', 'plan'), planVersion: 'v', sourceSha } } },
    { id: 'other-kind', type: 'object.put', payload: { ref: f.own('plan', 'evidence'), kind: 'evidence', baseVersion: '', content: {} } },
    { id: 'other-ref', type: 'object.put', payload: { ref: 'other-plan', kind: 'plan', baseVersion: '', content: {} } },
    { id: 'read-other', type: 'object.read', payload: { ref: 'other-plan', version: 'v' } },
  ];
  for (const request of rejected) await assert.rejects(f.channel.exchange(lease.token, request), { code: 'ROLE_FORBIDDEN' });
  for (const field of ['session', 'generation', 'principal', 'role', 'root']) {
    await assert.rejects(f.channel.exchange(lease.token, { id: 'override-' + field, type: 'object.read', payload: briefFields(f.brief), [field]: 'forged' }), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(await f.store.transaction(state => state, { readOnly: true }), before, 'denials do not mutate tasks, objects or receipts');
});

test('Cursor object namespaces distinguish separator-containing task IDs in the same Session', async t => {
  const f = await fixture(t), lease = await f.issue('plan');
  const otherScope = { ...lease.scope, taskId: 'task:other' };
  const otherRef = f.channel.prefix(otherScope) + 'unit';
  const legacyAmbiguous = `cursor:${executorId}:task:other:unit`;
  assert.notEqual(f.channel.prefix(otherScope), f.channel.prefix(lease.scope));
  const object = await f.send(f.executor, 'object.put', { kind: 'plan', ref: otherRef, baseVersion: '', content: { private: 'other task' } });
  for (const ref of [otherRef, legacyAmbiguous]) {
    await assert.rejects(f.channel.exchange(lease.token, { id: 'read-' + hash(ref), type: 'object.read', payload: { ref, version: object.version } }), { code: 'ROLE_FORBIDDEN' });
    await assert.rejects(f.channel.exchange(lease.token, { id: 'overwrite-' + hash(ref), type: 'object.put',
      payload: { ref, kind: 'plan', baseVersion: object.version, content: { overwritten: true } } }), { code: 'ROLE_FORBIDDEN' });
  }
  assert.deepEqual((await f.send(f.executor, 'object.read', briefFields(object))).content, { private: 'other task' });
});

test('Cursor execution requires the exact approved Plan; cached object writes cannot outlive task interruption', async t => {
  const f = await fixture(t), { execution, lease: planLease, plan } = await f.prepareExecution();
  await assert.rejects(f.channel.context(planLease.token), { code: 'ROLE_FORBIDDEN' });
  const wrong = await f.issue('execution', { plan: { ...plan, version: 'wrong' } }, { operationId: 'wrong-version' });
  await assert.rejects(f.channel.context(wrong.token), { code: 'ROLE_FORBIDDEN' });
  const put = { id: 'unit', type: 'object.put', payload: { ref: f.own('execution', 'unit'), kind: 'evidence', baseVersion: '', content: { exitCode: 0 } } };
  const first = await f.channel.exchange(execution.token, put);
  assert.deepEqual(await f.channel.exchange(execution.token, put), first);
  await assert.rejects(f.channel.exchange(execution.token, { ...put, payload: { ...put.payload, content: { exitCode: 1 } } }), { code: 'ID_REUSED' });
  await f.send(f.executor, 'task.report', { taskId: 'task', stage: 'interrupted', data: { reason: 'test interruption', occurredAt: new Date().toISOString() } });
  await assert.rejects(f.channel.exchange(execution.token, put), { code: 'ROLE_FORBIDDEN' });
  assert.equal((await f.task()).stage, 'interrupted');
});

test('Cursor handoff rejects source self-reports and foreign evidence before changing task stage', async t => {
  const f = await fixture(t), { execution } = await f.prepareExecution();
  const todo = (await f.put(execution, 'todo', 'ciTodo', { items: [{ id: 'todo-1' }] })).data;
  const unit = (await f.put(execution, 'unit', 'evidence')).data;
  const request = { id: 'handoff', type: 'task.report', payload: { taskId: 'task', stage: 'handoff',
    data: { sourceSha: resultSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } } };
  await assert.rejects(f.channel.exchange(execution.token, request), { code: 'SOURCE_UNVERIFIED' });
  assert.equal((await f.task()).stage, 'executing');
  execution.receiver.verifiedHandoff = { proofId: 'synthetic-source', sourceSha, runId: 'run-execution', nativeAgentId: execution.scope.nativeAgentId,
    baseSha: sourceSha, references: { [todo.ref]: todo.version, [unit.ref]: unit.version } };
  await assert.rejects(f.channel.exchange(execution.token, request), { code: 'SOURCE_UNVERIFIED' });
  execution.receiver.verifiedHandoff.sourceSha = resultSha;
  await assert.rejects(f.channel.exchange(execution.token, { ...request, payload: { ...request.payload,
    data: { ...request.payload.data, unitTestRefs: ['foreign-evidence'] } } }), { code: 'ROLE_FORBIDDEN' });
  const result = await f.channel.exchange(execution.token, request);
  assert.equal(result.data.stage, 'awaiting-ci');
  assert.equal((await f.task()).sourceSha, resultSha);
  assert.deepEqual((await f.task()).handoff, request.payload.data);
});

test('Cursor CI is an independent actor; only handed-off immutable references and own evidence are readable', async t => {
  const f = await fixture(t), { ci, ciTodo, evidence, execution } = await f.prepareCi();
  const context = await f.channel.context(ci.token);
  assert.deepEqual(context.actor, f.actor);
  assert.deepEqual(context.session, f.session);
  assert.equal(context.sourceSha, resultSha);
  for (const ref of [ciTodo, evidence]) {
    assert.ok(context.references.some(item => canonical(item) === canonical(ref)));
    const read = await f.channel.exchange(ci.token, { id: 'read-' + ref.ref, type: 'object.read', payload: briefFields(ref) });
    assert.equal(read.data.version, ref.version);
  }
  await assert.rejects(f.put(ci, 'plan', 'plan'), { code: 'ROLE_FORBIDDEN' });
  await assert.rejects(f.channel.context(execution.token), { code: 'ROLE_FORBIDDEN' });
  const written = (await f.put(ci, 'result', 'evidence', { command: 'node --test', exitCode: 0 })).data;
  assert.equal((await f.channel.exchange(ci.token, { id: 'read-own', type: 'object.read', payload: briefFields(written) })).data.kind, 'evidence');
  await assert.rejects(f.channel.exchange(ci.token, { id: 'wrong-version', type: 'object.read', payload: { ...ciTodo, version: 'old' } }), { code: 'ROLE_FORBIDDEN' });
  for (const extra of [{ actor: f.session }, { actorWorktreeId: 'executor-tree' }]) {
    await assert.rejects(f.channel.issue({ operationId: 'bad-ci', scope: { ...ci.scope, ...extra } }), { code: 'INVALID_ARGUMENT' });
  }
});

test('Cursor CI cannot mark tests passed from FINISHED or its own source claim; proof must match exact Run and checks', async t => {
  const f = await fixture(t), { ci } = await f.prepareCi();
  const evidence = (await f.put(ci, 'result', 'evidence', { exitCode: 0 })).data;
  const payload = { taskId: 'task', sourceSha: resultSha, verdict: 'passed', checks: [
    { testId: 'CI-1', todoId: 'todo-1', status: 'passed', evidenceRef: evidence.ref },
  ] };
  const request = { id: 'ci-result', type: 'ci.result', payload };
  ci.receiver.status = 'FINISHED';
  await assert.rejects(f.channel.exchange(ci.token, request), { code: 'SOURCE_UNVERIFIED' });
  ci.receiver.verifiedCi = { proofId: 'synthetic-native-tests', runId: 'another-run', nativeAgentId: ci.scope.nativeAgentId,
    references: { [evidence.ref]: evidence.version }, ...payload };
  await assert.rejects(f.channel.exchange(ci.token, request), { code: 'SOURCE_UNVERIFIED' });
  ci.receiver.verifiedCi.runId = 'run-ci';
  await assert.rejects(f.channel.exchange(ci.token, { ...request, payload: { ...payload, sourceSha } }), { code: 'SOURCE_UNVERIFIED' });
  await assert.rejects(f.channel.exchange(ci.token, { ...request, payload: { ...payload, checks: [{ ...payload.checks[0], testId: 'forged' }] } }), { code: 'SOURCE_UNVERIFIED' });
  assert.equal((await f.task()).stage, 'testing');
  const result = await f.channel.exchange(ci.token, request);
  assert.equal(result.data.stage, 'awaiting-merge');
  const task = await f.task();
  assert.equal(task.ci.verdict, 'passed');
  assert.equal(task.acceptanceReview, undefined, 'native terminal never becomes human acceptance');
});

test('Cursor CI failed reproduction must belong to the Tester, not Executor evidence', async t => {
  const f = await fixture(t), { ci, evidence: executorEvidence } = await f.prepareCi();
  const evidence = (await f.put(ci, 'failed', 'evidence', { exitCode: 1 })).data;
  const payload = { taskId: 'task', sourceSha: resultSha, verdict: 'failed', checks: [
    { testId: 'CI-1', todoId: 'todo-1', status: 'failed', evidenceRef: evidence.ref, reproductionRef: executorEvidence.ref },
  ] };
  ci.receiver.verifiedCi = { proofId: 'synthetic-native-failure', runId: 'run-ci', nativeAgentId: ci.scope.nativeAgentId,
    references: { [evidence.ref]: evidence.version }, ...payload };
  await assert.rejects(f.channel.exchange(ci.token, { id: 'failed-result', type: 'ci.result', payload }), { code: 'ROLE_FORBIDDEN' });
  payload.checks[0].reproductionRef = evidence.ref;
  ci.receiver.verifiedCi.checks = structuredClone(payload.checks);
  const result = await f.channel.exchange(ci.token, { id: 'failed-result', type: 'ci.result', payload });
  assert.equal(result.data.stage, 'ci-failed');
});

test('Cursor trusted CI proof cannot be reused after its evidence ref changes to a newer version', async t => {
  const f = await fixture(t), { ci } = await f.prepareCi();
  const evidence = (await f.put(ci, 'result', 'evidence', { exitCode: 0 })).data;
  const payload = { taskId: 'task', sourceSha: resultSha, verdict: 'passed', checks: [
    { testId: 'CI-1', todoId: 'todo-1', status: 'passed', evidenceRef: evidence.ref },
  ] };
  ci.receiver.verifiedCi = { proofId: 'synthetic-v1-proof', nativeAgentId: ci.scope.nativeAgentId, runId: 'run-ci',
    references: { [evidence.ref]: evidence.version }, ...payload };
  const latest = (await f.channel.exchange(ci.token, { id: 'replace-evidence', type: 'object.put', payload: {
    kind: 'evidence', ref: evidence.ref, baseVersion: evidence.version, content: { exitCode: 1, unverified: true },
  } })).data;
  assert.notEqual(latest.version, evidence.version);
  await assert.rejects(f.channel.exchange(ci.token, { id: 'result-after-change', type: 'ci.result', payload }), { code: 'SOURCE_UNVERIFIED' });
  assert.equal((await f.task()).stage, 'testing');
  assert.equal((await f.task()).ci, undefined);
});

test('Cursor trusted handoff proof rejects prior Run, wrong base and changed evidence versions', async t => {
  const f = await fixture(t), { execution } = await f.prepareExecution();
  const todo = (await f.put(execution, 'todo', 'ciTodo', { items: [{ id: 'todo-1' }] })).data;
  const unit = (await f.put(execution, 'unit', 'evidence')).data;
  const payload = { taskId: 'task', stage: 'handoff', data: { sourceSha: resultSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } };
  const proof = { proofId: 'synthetic-handoff-proof', runId: 'run-execution', nativeAgentId: execution.scope.nativeAgentId,
    sourceSha: resultSha, baseSha: sourceSha, references: { [todo.ref]: todo.version, [unit.ref]: unit.version } };
  for (const extra of [{ runId: 'old-run' }, { baseSha: resultSha }, { nativeAgentId: 'bc-99999999-9999-4999-8999-999999999999' },
    { references: { ...proof.references, [unit.ref]: 'unverified-version' } }]) {
    execution.receiver.verifiedHandoff = { ...proof, ...extra };
    await assert.rejects(f.channel.exchange(execution.token, { id: 'proof-reject-' + hash(canonical(extra)), type: 'task.report', payload }), { code: 'SOURCE_UNVERIFIED' });
  }
  assert.equal((await f.task()).stage, 'executing');
});

test('Cursor CI physical independence includes native Agent identity, not just logical IDs and worktrees', async t => {
  const f = await fixture(t), { ci } = await f.prepareCi();
  ci.receiver.executorNativeAgentId = ci.scope.nativeAgentId;
  await assert.rejects(f.channel.context(ci.token), { code: 'ROLE_UNAVAILABLE' });
  ci.receiver.executorNativeAgentId = f.base.nativeAgentId;
  ci.receiver.nativeAgentId = f.base.nativeAgentId;
  await assert.rejects(f.channel.context(ci.token), { code: 'ROLE_UNAVAILABLE' });
});

test('Cursor lease rejects changed project, worktree, generation, provider Run and revoked credential replay', async t => {
  const f = await fixture(t), lease = await f.issue('plan');
  for (const extra of [{ projectId: 'other-project' }, { repositoryId: 'other-repo' }, { worktreeId: 'other-tree', actorWorktreeId: 'other-tree' },
    { session: { ...f.session, generation: 2 }, actor: { ...f.session, generation: 2 } }]) {
    const scope = { ...lease.scope, ...extra };
    const delegated = await f.channel.issue({ operationId: hash(canonical(extra)), scope });
    if (extra.projectId) {
      // The backend resolver knows only its actual project; no cross-project echo.
      await assert.rejects(f.channel.activate(delegated.token), { code: 'ROLE_UNAVAILABLE' });
    } else {
      f.receivers.set(f.scopeKey(scope), { scopeHash: f.scopeKey(scope), nativeAgentId: scope.nativeAgentId, active: true, runId: 'other' });
      await f.channel.activate(delegated.token);
      await assert.rejects(f.channel.context(delegated.token), { code: 'ROLE_FORBIDDEN' });
    }
  }
  const request = { id: 'plan', type: 'object.put', payload: { ref: f.own('plan', 'plan'), kind: 'plan', baseVersion: '', content: {} } };
  await f.channel.exchange(lease.token, request);
  lease.receiver.runId = 'changed-native-run';
  await assert.rejects(f.channel.exchange(lease.token, request), { code: 'ROLE_UNAVAILABLE' });
  lease.receiver.runId = 'run-plan';
  await f.channel.revoke(lease.token);
  await assert.rejects(f.channel.exchange(lease.token, request), { code: 'ROLE_EXPIRED' });
});

for (const change of ['native', 'expiry']) test(`Cursor permissions recheck ${change} inside the task transaction after waiting for its lock`, async t => {
  const f = await fixture(t), lease = await f.issue('plan');
  let release, entered, waiting, receiverCalls = 0;
  const resolver = f.channel.resolveReceiver;
  f.channel.resolveReceiver = scope => { receiverCalls++; return resolver(scope); };
  const blocker = new Promise(resolve => { release = resolve; });
  const acquired = new Promise(resolve => { entered = resolve; });
  const queued = new Promise(resolve => { waiting = resolve; });
  const lock = f.store.transaction(async () => { entered(); await blocker; });
  await acquired;
  const handle = f.store.handle.bind(f.store);
  f.store.handle = (...args) => { waiting(); return handle(...args); }; // Observe, do not replace, the real store.
  const request = { id: 'waiting', type: 'object.put', payload: { ref: f.own('plan', 'waiting'), kind: 'plan', baseVersion: '', content: {} } };
  const pending = f.channel.exchange(lease.token, request);
  // The outer lease was validated before handle() was called. The receiver
  // must still wait for the inner task transaction before doing its lookup.
  await queued;
  assert.equal(receiverCalls, 0);
  if (change === 'native') lease.receiver.runId = 'changed-during-lock';
  else f.setClock(1700003600000);
  release(); await lock;
  await assert.rejects(pending, { code: change === 'native' ? 'ROLE_UNAVAILABLE' : 'ROLE_EXPIRED' });
  assert.equal(receiverCalls, 1);
  assert.equal((await f.task()).stage, 'assigned');
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(state.objects[scopedObjectKey(f.executor, f.session, request.payload.ref)], undefined);
});

async function mcpFixture(t, f, projectId = 'project') {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/cursor-role-mcp`;
  handler = createCursorRoleMcpHandler({ channel: f.channel, projectId, endpoint, allowLoopback: true });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = async (token, input, extra = {}) => {
    const response = await fetch(endpoint + (extra.query || ''), { method: extra.method || 'POST', headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      ...extra.headers,
    }, ...(extra.method && extra.method !== 'POST' ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const initialize = token => request(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-native-client', version: '1' },
  } });
  const initialized = token => request(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
  return { request, initialize, initialized };
}

test('Cursor role MCP real HTTP discovery can precede native confirmation; task tools require active delegation', async t => {
  const f = await fixture(t), scope = { ...f.base, phase: 'plan' };
  const lease = await f.channel.issue({ operationId: 'native-create', scope });
  const mcp = await mcpFixture(t, f);
  assert.equal((await mcp.request(lease.token, { jsonrpc: '2.0', id: 'early', method: 'tools/list' })).status, 400);
  const init = await mcp.initialize(lease.token);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.headers.get('cache-control'), 'no-store');
  const ready = await mcp.initialized(lease.token);
  assert.equal(ready.status, 202); assert.equal(ready.body, null);
  const list = await mcp.request(lease.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['context_guard_context', 'context_guard_exchange']);
  assert.deepEqual(list.body.result.tools[1].inputSchema.properties.type.enum, ['object.read', 'object.put', 'task.report']);
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_guard_context', arguments: {} } };
  const dormant = await mcp.request(lease.token, call);
  assert.equal(dormant.body.result.isError, true);
  assert.equal(JSON.parse(dormant.body.result.content[0].text).error.code, 'ROLE_UNAVAILABLE');
  f.receivers.set(f.scopeKey(scope), { active: true, scopeHash: f.scopeKey(scope), nativeAgentId: scope.nativeAgentId, runId: 'confirmed-run' });
  await f.channel.activate(lease.token);
  const context = await mcp.request(lease.token, call);
  assert.equal(context.body.result.structuredContent.taskId, 'task');
  assert.deepEqual(context.body.result.structuredContent.session, f.session);
  assert.equal(context.body.result.structuredContent.writePrefix, f.channel.prefix(scope));
  const exchange = args => mcp.request(lease.token, { ...call, id: 4, params: { name: 'context_guard_exchange', arguments: args } });
  const put = await exchange({ id: 'mcp-plan', type: 'object.put', payload: { kind: 'plan', ref: f.channel.prefix(scope) + 'plan', baseVersion: '', content: { steps: ['Implement', 'Test'] } } });
  const plan = put.body.result.structuredContent.data;
  assert.ok(plan.version);
  const report = { id: 'mcp-ready', type: 'task.report', payload: { taskId: 'task', stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha } } };
  const first = await exchange(report);
  assert.equal(first.body.result.structuredContent.data.stage, 'plan-ready');
  assert.deepEqual(await exchange(report), first);
  assert.deepEqual((await f.task()).plan, plan);
  assert.equal((await f.task()).planReview, undefined, 'native MCP cannot approve its own Plan');
  // Lifecycle is persisted with the capability, not just in HTTP process RAM.
  const second = await mcpFixture(t, { ...f, channel: new CursorRoleChannel(f.channelOptions) });
  assert.equal((await second.request(lease.token, call)).body.result.structuredContent.stage, 'plan-ready');
});

test('Cursor role MCP rejects browser authority, foreign projects, malformed transport and admin APIs', async t => {
  const f = await fixture(t), lease = await f.issue('plan'), mcp = await mcpFixture(t, f);
  const input = { jsonrpc: '2.0', id: 'request', method: 'tools/list' };
  for (const [extra, status] of [
    [{ headers: { Authorization: 'Bearer administrator' } }, 401],
    [{ headers: { Origin: 'https://foreign.invalid' } }, 403],
    [{ headers: { Cookie: 'cg_workbench=human' } }, 403],
    [{ query: '?token=private' }, 403],
    [{ headers: { 'MCP-Protocol-Version': 'unknown' } }, 400],
    [{ headers: { Accept: 'application/json' } }, 406],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ method: 'GET' }, 405],
  ]) assert.equal((await mcp.request(lease.token, input, extra)).status, status);
  assert.equal((await mcp.request(lease.token, '{not-json')).body.error.code, -32700);
  assert.equal((await mcp.request(lease.token, [input])).body.error.code, -32600);
  const other = await mcpFixture(t, f, 'other-project');
  assert.equal((await other.initialize(lease.token)).status, 403);
  await mcp.initialize(lease.token); await mcp.initialized(lease.token);
  const unknown = await mcp.request(lease.token, { ...input, method: 'session.bind' });
  assert.equal(unknown.body.error.code, -32601);
  const forged = await mcp.request(lease.token, { ...input, method: 'tools/call', params: { name: 'context_guard_context', arguments: { sessionId: 'other' } } });
  assert.equal(forged.body.error.code, -32602);
  const forbidden = await mcp.request(lease.token, { ...input, method: 'tools/call', params: { name: 'context_guard_exchange', arguments: {
    id: 'review', type: 'review.result', payload: { kind: 'brief', ...briefFields(f.brief), decision: 'approved', reason: 'self' },
  } } });
  assert.equal(forbidden.body.result.isError, true);
  assert.equal(JSON.parse(forbidden.body.result.content[0].text).error.code, 'ROLE_FORBIDDEN');
  assert.equal((await f.task()).stage, 'assigned');
  const tooLarge = await mcp.request(lease.token, '"' + 'x'.repeat(300000) + '"');
  assert.equal(tooLarge.status, 413);
  await f.channel.revoke(lease.token);
  assert.equal((await mcp.request(lease.token, input)).status, 401);
});
