import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startCloudServer, createWorkbenchPasswordHash, authorizeCiReceiver, authorizeCiTransaction } from '../scripts/cloud/server.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { canonical } from '../scripts/shared/protocol.mjs';
import { scopedObjectKey } from '../scripts/shared/protocol-workflow.mjs';
import { skillImport } from './helpers/skill.mjs';

const { DeviceConnection } = await skillImport('scripts/workbench/protocol-device.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const header = tuple => Buffer.from(canonical(tuple)).toString('base64url');

// Real Cloud HTTP/authentication, bindings and Core reducers; approvals are
// synthetic fixture preconditions, not production approval or native proof.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-ci-task-'));
  const repositoryId = '123', dataDir = path.join(directory, 'cloud');
  const receivers = { ci: { executorSessionId: 'developer', worktreeId: 'ci-tree' } };
  const cloud = await startCloudServer({ dataDir, port: 0, browserToken: 'synthetic-browser',
    browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
    protocolConfig: { repositories: [{ slug: 'example/repo', repositoryId, projectId: 'fixture' }] },
    memoryConfig: { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic-admin', projects: {
      fixture: { token: 'synthetic-only', coordinator: { enabled: false, ciReceivers: receivers } },
    } },
  });
  const device = new DeviceConnection({ directory: path.join(directory, 'device'), origin: cloud.url, allowLoopback: true });
  t.after(async () => { await device.close(); await cloud.close(); }); // Preserve owned evidence; do not clean user files.
  await device.connect({ v: 2, id: 'connect', type: 'auth.open', payload: {
    repository: 'https://github.com/example/repo', password: 'synthetic-password', clientId: 'fixture-device' } });
  const bind = (id, tree) => device.send({ v: 2, id: 'bind-' + id, type: 'session.bind', payload: {
    sessionId: id, worktreeId: tree, agentId: id, expectedBindingVersion: '' } });
  const { session } = await bind('developer', 'developer-tree'); await bind('ci', 'ci-tree');
  const store = new ProtocolStore(path.join(dataDir, 'interface-v2', digest(repositoryId)));
  const registered = await store.registeredBinding({ repositoryId, deviceId: 'browser', agentId: 'human', role: 'human' }, session.id);
  const executor = { repositoryId, deviceId: registered.deviceId, agentId: 'device-host', role: 'device' };
  const coordinator = { ...executor, deviceId: 'coordinator', agentId: 'original-coordinator', role: 'coordinator', bindings: { developer: registered.worktreeId } };
  const human = { repositoryId, deviceId: 'browser', agentId: 'human', role: 'human' };
  let sequence = 0;
  const send = async (principal, type, payload, options) => (await store.handle(principal, {
    v: 2, id: 'setup-' + ++sequence, type, session, payload }, options)).data;
  const brief = await send(coordinator, 'brief.submit', { taskId: 'task', text: 'Verify isolated task' });
  await send(coordinator, 'review.request', { taskId: 'task', kind: 'brief', ref: brief.ref, version: brief.version });
  await send(human, 'review.result', { kind: 'brief', ref: brief.ref, version: brief.version, decision: 'approved', reason: 'Synthetic precondition' });
  await send(coordinator, 'task.assign', { taskId: 'task', briefRef: brief.ref, briefVersion: brief.version,
    sessionId: session.id, nodeIds: ['T0'], mainVersion: 'main-1' }, { workflow: { verifyRouting: () => true } });
  const put = (ref, kind, content, baseVersion = '') => send(executor, 'object.put', { ref, kind, content, baseVersion });
  const plan = await put('plan', 'plan', { paths: ['tests'], steps: ['Verify'] });
  const planSourceSha = 'a'.repeat(40), sourceSha = 'b'.repeat(40);
  await send(executor, 'task.report', { taskId: 'task', stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha: planSourceSha } });
  await send(coordinator, 'review.request', { taskId: 'task', kind: 'plan', ref: plan.ref, version: plan.version,
    requirementsRef: brief.ref, requirementsVersion: brief.version, rulesVersion: 'rules-1' });
  const approval = await send(coordinator, 'review.result', { kind: 'plan', ref: plan.ref, version: plan.version, decision: 'approved', reason: 'Synthetic plan' });
  const todo = await put('todo', 'ciTodo', { items: [{ id: 'CI-1', title: 'One declared check' }] });
  const unit = await put('unit', 'evidence', { fixture: 'unit output' });
  await send(executor, 'task.report', { taskId: 'task', stage: 'handoff', data: { sourceSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } });
  await send(coordinator, 'ci.request', { taskId: 'task', sourceSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref] });
  const tuple = { taskId: 'task', planRef: plan.ref, planVersion: plan.version, planSourceSha,
    approvalReceiptId: approval.receiptId, sourceSha, ciTodoRef: todo.ref, ciTodoVersion: todo.version };
  const credential = JSON.parse(await fs.readFile(device.file, 'utf8')).credential;
  const request = async (type, payload, { id = 'http-' + ++sequence, expectation = tuple, ci = 'ci', auth = credential, target = session, browser = false } = {}) => {
    const response = await fetch(cloud.url + '/api/v2/messages?project=fixture', { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(browser ? { Cookie: 'cg_workbench=synthetic-browser' } : { Authorization: `Bearer ${auth}` }),
      ...(ci ? { 'X-Context-Guard-CI-Session': ci } : {}),
      ...(expectation === null ? {} : { 'X-Context-Guard-CI-Task': typeof expectation === 'string' ? expectation : header(expectation) }),
    }, body: JSON.stringify({ v: 2, id, type, session: target, payload }) });
    return { status: response.status, body: await response.json(), authorized: response.headers.get('x-context-guard-ci-task-authorized') };
  };
  const unchangedRejection = async (type, payload, options, code = 'FORBIDDEN') => {
    const before = await fs.readFile(store.file, 'utf8'), result = await request(type, payload, options);
    assert.equal(result.body.ok, false, JSON.stringify(result)); assert.equal(result.body.error.code, code, JSON.stringify(result));
    assert.equal(result.authorized, null, 'an error or rejected scope must never acknowledge task authorization');
    assert.equal(await fs.readFile(store.file, 'utf8'), before, 'rejection must not mutate Task, objects, scope or receipts');
  };
  const evidence = { kind: 'evidence', ref: 'ci:ci:observation', baseVersion: '', content: { observed: 'synthetic-only' } };
  const result = { taskId: 'task', sourceSha, verdict: 'passed', checks: [{ testId: 'test-1', todoId: 'CI-1', status: 'passed', evidenceRef: evidence.ref }] };
  return { store, session, tuple, todo, unit, plan, evidence, result, request, unchangedRejection, put, send, executor, coordinator, receivers };
}

test('scoped CI HTTP validates the exact current Task, approved Plan baseline and final handoff before frozen reads', async t => {
  const f = await fixture(t), payload = { ref: f.todo.ref, version: f.todo.version };
  const before = await fs.readFile(f.store.file, 'utf8'), read = await f.request('object.read', payload);
  assert.equal(read.status, 200, JSON.stringify(read)); assert.equal(read.body.data.kind, 'ciTodo');
  assert.equal(read.authorized, digest(canonical(f.tuple)));
  assert.equal(await fs.readFile(f.store.file, 'utf8'), before, 'read-only authorization cannot add a scope sidecar');
  assert.notEqual(f.tuple.planSourceSha, f.tuple.sourceSha);
  for (const field of Object.keys(f.tuple)) {
    const value = ['sourceSha', 'planSourceSha'].includes(field) ? 'c'.repeat(40) : 'foreign';
    await f.unchangedRejection('object.read', payload, { expectation: { ...f.tuple, [field]: value } });
  }
  for (const expectation of ['not-base64!', header({ ...f.tuple, verified: true }), header({ ...f.tuple, taskId: '' })]) {
    await f.unchangedRejection('object.read', payload, { expectation }, 'INVALID_ARGUMENT');
  }
  await f.unchangedRejection('object.read', payload, { ci: null });
  await f.unchangedRejection('object.read', payload, { auth: 'synthetic-browser' }, 'UNAUTHORIZED');
  await f.unchangedRejection('object.read', payload, { browser: true });
  await f.unchangedRejection('object.read', { ref: f.plan.ref, version: f.plan.version });
});

test('scoped CI writes pin retry identity and binding epochs before reusing an accepted Core receipt', async t => {
  const f = await fixture(t), id = 'fixed-observation';
  const accepted = await f.request('object.put', f.evidence, { id }); assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.authorized, digest(canonical(f.tuple)));
  const snapshot = await fs.readFile(f.store.file, 'utf8');
  assert.deepEqual(await f.request('object.put', f.evidence, { id }), accepted);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), snapshot);
  await f.unchangedRejection('object.put', f.evidence, { id, expectation: null });
  await f.unchangedRejection('object.put', f.evidence, { id, expectation: { ...f.tuple, taskId: 'other' } });
  await f.unchangedRejection('object.put', { ...f.evidence, content: { changed: true } }, { id }, 'ID_REUSED');
  const binding = await f.store.registeredBinding(f.executor, 'ci');
  // A real two-step same-device rebind returns to the same configured root,
  // but cannot restore the first operation's original server binding epoch.
  const rebind = async (tree, version, id) => (await f.store.handle(f.executor, { v: 2, id, type: 'session.bind', payload: {
    sessionId: 'ci', agentId: 'ci', worktreeId: tree, expectedBindingVersion: version } }, { verifyBinding: () => true, allowMigration: true })).data;
  const moved = await rebind('temporary-ci-tree', binding.version, 'move-ci');
  await rebind('ci-tree', moved.bindingVersion, 'return-ci');
  await f.unchangedRejection('object.put', f.evidence, { id });
});

test('scoped CI cannot use legacy receipts or changed TODO as current authorization', async t => {
  const f = await fixture(t);
  const legacy = await f.request('object.put', f.evidence, { id: 'legacy', expectation: null }); assert.equal(legacy.status, 200);
  assert.equal(legacy.authorized, null, 'ordinary CI remains unscoped and cannot issue the new acknowledgement');
  await f.unchangedRejection('object.put', f.evidence, { id: 'legacy' });
  await f.put(f.todo.ref, 'ciTodo', { items: [{ id: 'later', title: 'Unassigned version' }] }, f.todo.version);
  await f.unchangedRejection('object.read', { ref: f.todo.ref, version: f.todo.version });
  await f.unchangedRejection('object.put', { ...f.evidence, ref: 'ci:ci:new' });
});

test('scoped CI rechecks Task stages, approval provenance and missing legacy baseline on the current snapshot', async t => {
  const mutations = [
    state => { state.tasks[Object.keys(state.tasks)[0]].stage = 'interrupted'; },
    state => { state.tasks[Object.keys(state.tasks)[0]].busy = false; },
    state => { delete state.tasks[Object.keys(state.tasks)[0]].planSourceSha; },
    state => { state.tasks[Object.keys(state.tasks)[0]].planReview.decision = 'rejected'; },
    state => { const task = state.tasks[Object.keys(state.tasks)[0]];
      state.objects[scopedObjectKey({ repositoryId: '123' }, task.session, task.planReview.ref)].versions[task.planReview.version].content.issuer = 'ci'; },
    state => { for (const [key, value] of Object.entries(state.receipts)) if (value.reply?.data?.receiptId && value.reply.data.stage === 'executing') delete state.receipts[key]; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    await f.store.transaction(state => { mutate(state); return null; });
    await f.unchangedRejection('object.read', { ref: f.todo.ref, version: f.todo.version });
    await f.unchangedRejection('object.put', f.evidence);
  }
});

test('scoped CI result lost ACK replays only its exact terminal receipt, not new work or rework', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('object.put', f.evidence)).status, 200);
  const accepted = await f.request('ci.result', f.result, { id: 'fixed-result' }); assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.authorized, digest(canonical(f.tuple)));
  const task = await f.store.taskRecord(f.coordinator, f.session, 'task');
  assert.equal(task.stage, 'awaiting-merge'); assert.notEqual(task.ciTodoResult.version, f.tuple.ciTodoVersion);
  const snapshot = await fs.readFile(f.store.file, 'utf8');
  assert.deepEqual(await f.request('ci.result', f.result, { id: 'fixed-result' }), accepted);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), snapshot, 'terminal ACK is historical and does not reapply the result');
  await f.unchangedRejection('ci.result', f.result, { id: 'fresh-result' });
  await f.unchangedRejection('ci.result', f.result, { id: 'fixed-result', expectation: null });
  await f.unchangedRejection('object.put', { ...f.evidence, ref: 'ci:ci:late' });
  await f.unchangedRejection('object.read', { ref: f.todo.ref, version: f.todo.version });
  await f.send(f.coordinator, 'task.control', { taskId: 'task', action: 'cancel', expectedVersion: task.version, data: { reason: 'Synthetic end' } });
  await f.unchangedRejection('ci.result', f.result, { id: 'fixed-result' });
});

test('same Core transaction rolls back scoped retry pin and effects when persistence fails', async t => {
  const f = await fixture(t), message = { v: 2, id: 'commit-failure', type: 'object.put', session: f.session, payload: f.evidence };
  const ci = await authorizeCiReceiver({ principal: f.executor, ciSessionId: 'ci', message, receivers: f.receivers, store: f.store });
  const principal = { ...ci, ciTaskExpectation: f.tuple }, before = await fs.readFile(f.store.file, 'utf8');
  const failing = new ProtocolStore(path.dirname(f.store.file), { beforeCommit: () => { throw new Error('synthetic persistence failure'); } });
  await assert.rejects(failing.handle(principal, message, { authorize: authorizeCiTransaction }), /synthetic persistence failure/);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), before);
  const accepted = await f.request('object.put', f.evidence, { id: message.id }); assert.equal(accepted.status, 200);
  const state = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
  assert.equal(Object.keys(state.cursorCiTaskScopes || {}).length, 1, 'the accepted effect and task expectation are persisted together');
  assert.equal(state.objects[scopedObjectKey(ci, f.session, f.evidence.ref)].latest, accepted.body.data.version);
});

test('later real rework cannot attach its new approved Plan tuple to the earlier result ID', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('object.put', f.evidence)).status, 200);
  const payload = { ...f.result, verdict: 'incomplete', checks: [{ ...f.result.checks[0], status: 'incomplete' }] };
  const accepted = await f.request('ci.result', payload, { id: 'earlier-result' }); assert.equal(accepted.status, 200);
  const earlier = await f.store.taskRecord(f.coordinator, f.session, 'task');
  assert.equal(earlier.stage, 'ci-failed');
  assert.deepEqual(await f.request('ci.result', payload, { id: 'earlier-result' }), accepted);
  await f.send(f.coordinator, 'task.rework', { taskId: 'task', sourceSha: f.tuple.sourceSha,
    ciResultRef: earlier.ci.ref, failedTestIds: ['test-1'], reason: 'Synthetic rework' });
  await f.unchangedRejection('ci.result', payload, { id: 'earlier-result' });
  const plan = await f.put('plan', 'plan', { paths: ['tests'], steps: ['Rework check'] }, f.plan.version);
  await f.send(f.executor, 'task.report', { taskId: 'task', stage: 'planReady', data: {
    planRef: plan.ref, planVersion: plan.version, sourceSha: f.tuple.sourceSha } });
  await f.send(f.coordinator, 'review.request', { taskId: 'task', kind: 'plan', ref: plan.ref, version: plan.version,
    requirementsRef: earlier.brief.ref, requirementsVersion: earlier.brief.version, rulesVersion: 'rules-1' });
  const approval = await f.send(f.coordinator, 'review.result', { kind: 'plan', ref: plan.ref, version: plan.version, decision: 'approved', reason: 'Synthetic rework approval' });
  const todo = await f.put('todo', 'ciTodo', { items: [{ id: 'CI-1', title: 'Reworked check' }] }, earlier.ciTodoResult.version);
  await f.send(f.executor, 'task.report', { taskId: 'task', stage: 'handoff', data: {
    sourceSha: f.tuple.sourceSha, ciTodoRef: todo.ref, unitTestRefs: [f.unit.ref], experienceRefs: [] } });
  await f.send(f.coordinator, 'ci.request', { taskId: 'task', sourceSha: f.tuple.sourceSha, ciTodoRef: todo.ref, unitTestRefs: [f.unit.ref] });
  const tuple = { ...f.tuple, planVersion: plan.version, planSourceSha: f.tuple.sourceSha,
    approvalReceiptId: approval.receiptId, ciTodoVersion: todo.version };
  assert.equal((await f.request('object.read', { ref: todo.ref, version: todo.version }, { expectation: tuple })).status, 200);
  await f.unchangedRejection('ci.result', payload, { id: 'earlier-result' });
  await f.unchangedRejection('ci.result', payload, { id: 'earlier-result', expectation: tuple });
});
