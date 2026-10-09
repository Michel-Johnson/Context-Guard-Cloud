import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, digest, threadKey } from '../plugins/slack/src/store.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { SlackRecoveryControl, recoveryCandidate, readRecoveryCapsule } from '../plugins/slack/src/recovery.mjs';
import { recoveryScope } from '../scripts/cloud/slack-recovery.mjs';

// Model/platform replacements only. These tests do not prove native delivery
// or the eligibility of any actual retained production attention record.
const teamId = 'TTEST', userId = 'UTEST', channel = 'CTEST', projectId = 'fixture';
const sourceHash = 'a'.repeat(64), op = (id, suffix) => `slack-${digest(`${id}:${suffix}`)}`;
async function fixture(t, size = 2) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).open();
  await fs.writeFile(path.join(directory, 'process.lock'), String(process.pid));
  const ids = Array.from({ length: size }, (_, index) => `message:${teamId}:${channel}:100.${index + 1}`);
  await store.update(state => {
    state.channels[channel] = projectId;
    state.messageBatches = { [ids[0]]: { ids, projectId, rootTs: '100.1', frozen: true } };
    for (const [index, id] of ids.entries()) state.inbox[id] = { status: 'attention', attempts: 3, relevanceAttempts: 3,
      error: 'RELEVANCE_UNAVAILABLE', batchId: ids[0], at: 10, next: 20,
      envelope: { type: 'events_api', body: { team_id: teamId, event: { type: 'message', channel, user: userId, ts: `100.${index + 1}`, text: `original ${index}` } } } };
    const inputs = ids.map(id => ({ id: op(id, 'submit'), text: state.inbox[id].envelope.body.event.text }));
    state.inbox[ids[0]].relevanceRequest = { id: op(ids[0], 'relevance'), userId, projectId,
      payload: { text: inputs.map(input => input.text).join('\n\n'), inputs, context: [], files: [],
        routing: { coordinatorUserId: 'UBOT', mentionedUsers: [], replyToCoordinator: false } } };
  });
  const calls = [], gateway = { command: async (type, input) => {
    calls.push({ type, ...structuredClone(input) });
    if (type === 'project.list') return { projects: [{ id: projectId }] };
    if (type === 'recovery.preflight') {
      const scope = recoveryScope(input.payload, { teamId, userId }, projectId);
      return { noBusinessEffect: true, scopeHash: scope.fingerprint, conversationId: scope.conversationId };
    }
    if (type === 'conversation.create') return { conversationId: `chat-${digest(input.id)}` };
    if (type === 'conversation.submit') return { accepted: true };
    throw new Error(`Unexpected ${type}`);
  } };
  const plugin = new SlackPlugin({ store, gateway, teamId, botUserId: 'UBOT', cloudOrigin: 'https://fixture.invalid',
    logger: { warn() {} }, io: { call: async method => { assert.equal(method, 'conversations.members'); return { members: [userId] }; } } });
  const control = new SlackRecoveryControl({ plugin, directory, sourceHash });
  plugin.stopped = false;
  t.after(() => plugin.stop());
  const candidate = recoveryCandidate(store.data, ids[0], teamId);
  const request = { v: 1, operationId: 'approved-recovery', mode: 'preflight', inboxId: ids[0],
    snapshotHash: candidate.descriptor.snapshotHash, expectedPid: process.pid, expectedSourceHash: sourceHash, reason: 'explicit isolated approval' };
  return { store, ids, calls, plugin, control, request, candidate, directory };
}

test('Recovery accepts the complete actual legacy absent-binding schema, not invented provenance or null conversation', async t => {
  const f = await fixture(t);
  assert.equal(f.candidate.scope.legacyFormat, 'f692b3-classified-batch-v1');
  assert.deepEqual(f.candidate.scope.inputIds, f.ids.map(id => op(id, 'submit')));
  assert.equal(f.candidate.scope.fingerprint, recoveryScope(f.candidate.descriptor, { userId, teamId, extra: 'not identity' }, projectId).fingerprint);
  for (const conversationId of [undefined, null, 'existing-chat', '']) {
    const descriptor = structuredClone(f.candidate.descriptor); descriptor.originalRequest.conversationId = conversationId;
    assert.throws(() => recoveryScope(descriptor, { teamId, userId }, projectId), { code: 'PROOF_UNAVAILABLE' });
  }
  for (const mutate of [data => { delete data.inbox[f.ids[0]].relevanceRequest; },
    data => { data.inbox[f.ids[1]].envelope.body.event.user = 'UOTHER'; },
    data => { data.inbox[f.ids[1]].envelope.body.event.text = 'changed'; },
    data => { data.inbox[f.ids[1]].envelope.body.event.files = [{ id: 'FUNKNOWN' }]; },
    data => { data.messageBatches[f.ids[0]].frozen = false; },
    data => { data.inbox[f.ids[0]].relevance = { respond: false }; },
    data => { data.inbox[f.ids[0]].relevanceRequest.payload.unknown = true; }]) {
    const data = structuredClone(f.store.data); mutate(data);
    assert.throws(() => recoveryCandidate(data, f.ids[0], teamId));
  }
});

test('Approved recovery retains attention counters and immutable original snapshot through preflight, submit and duplicate apply', async t => {
  const f = await fixture(t), before = structuredClone(f.store.data.inbox), batch = structuredClone(f.store.data.messageBatches);
  const preflight = await f.control.handleApproved(f.request); assert.equal(preflight.status, 'preflighted'); assert.equal(preflight.epoch, 0);
  assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 0);
  const apply = { ...f.request, mode: 'apply' };
  assert.equal((await f.control.handleApproved(apply)).status, 'accepted');
  assert.equal((await f.control.handleApproved(apply)).status, 'accepted');
  assert.deepEqual(f.store.data.inbox, before); assert.deepEqual(f.store.data.messageBatches, batch);
  assert.equal(f.store.data.recoveries[apply.operationId].epoch, 1);
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits.length, 1);
  assert.equal(submits[0].id, op(f.ids[0], 'batch-submit'));
  assert.deepEqual(submits[0].payload.inputs, f.candidate.scope.participation.inputs);
  assert.deepEqual(submits[0].payload.participation, before[f.ids[0]].relevanceRequest.payload);
  assert.equal(submits[0].payload.history, undefined); assert.equal(submits[0].payload.retryBudget, undefined);
  assert.equal(submits[0].userId, userId);
  await assert.rejects(f.control.handleApproved({ ...apply, reason: 'different approval' }), { code: 'ID_REUSED' });
});

test('Lost recovery ACK replays persisted identical transport once per owner without another epoch or touching original inbox', async t => {
  const f = await fixture(t, 1), original = structuredClone(f.store.data.inbox), delegate = f.plugin.gateway.command;
  let fail = true;
  f.plugin.gateway.command = async (type, input) => {
    const result = await delegate(type, input);
    if (type === 'conversation.submit' && fail) { fail = false; throw Object.assign(new Error('lost ACK'), { code: 'GATEWAY_ERROR' }); }
    return result;
  };
  await f.control.handleApproved(f.request);
  const apply = { ...f.request, mode: 'apply' };
  assert.equal((await f.control.handleApproved(apply)).status, 'unknown');
  const reopened = await new Store(f.directory).open(); f.plugin.store = reopened;
  const restarted = new SlackRecoveryControl({ plugin: f.plugin, directory: f.directory, sourceHash });
  assert.equal((await restarted.handleApproved(apply)).status, 'accepted');
  assert.equal((await restarted.handleApproved(apply)).status, 'accepted');
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits.length, 2);
  assert.deepEqual(submits[0], submits[1]); assert.deepEqual(reopened.data.inbox, original);
  assert.equal(reopened.data.recoveries[apply.operationId].epoch, 1);
});

test('Recovery refuses new pending inputs, changed scope or owner and requires authoritative proof and separate reviewed preflight', async t => {
  const f = await fixture(t);
  await assert.rejects(f.control.handleApproved({ ...f.request, expectedPid: process.pid + 1 }), { code: 'STALE_OPERATOR_OWNER' });
  await assert.rejects(f.control.handleApproved({ ...f.request, expectedSourceHash: 'b'.repeat(64) }), { code: 'STALE_OPERATOR_OWNER' });
  const apply = { ...f.request, mode: 'apply' };
  assert.equal((await f.control.handleApproved(apply)).code, 'PRECHECK_REQUIRED');
  assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 0);
  const g = await fixture(t);
  await g.store.update(state => { state.inbox.new = { status: 'pending', envelope: { type: 'events_api', body: { event: {
    type: 'message', channel, ts: '101.1', thread_ts: '100.1', user: userId, text: 'new ordinary request' } } } }; });
  assert.equal((await g.control.handleApproved(g.request)).code, 'RECOVERY_BUSY');
  assert.equal(g.store.data.inbox.new.status, 'pending');
  const h = await fixture(t); h.plugin.gateway.command = async type => type === 'project.list' ? { projects: [{ id: projectId }] } : { noBusinessEffect: false };
  assert.equal((await h.control.handleApproved(h.request)).code, 'PROOF_UNAVAILABLE');
  await assert.rejects(readRecoveryCapsule(h.directory, 'not-a-capsule'), { code: 'OPERATOR_CONTROL_UNAVAILABLE' });
  await assert.rejects(readRecoveryCapsule(h.directory, digest(h.request.operationId) + '.json'), {
    code: process.platform === 'win32' ? 'OPERATOR_CONTROL_UNAVAILABLE' : 'UNSAFE_OPERATOR_DIRECTORY' });
  const race = await fixture(t); await race.control.handleApproved(race.request);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  race.plugin.io.call = async () => { entered(); await wait; return { members: [userId] }; };
  const applying = race.control.handleApproved({ ...race.request, mode: 'apply' });
  await started;
  await race.store.update(state => { state.inbox.later = { status: 'pending', envelope: { type: 'events_api', body: { event: {
    type: 'message', channel, user: userId, ts: '101.1', thread_ts: '100.1', text: 'new ordinary input' } } } }; });
  const lane = race.plugin.entryLane(race.store.data.inbox[race.ids[0]]);
  race.plugin.messageLanes.set(lane, 'new-ordinary-owner'); release();
  assert.equal((await applying).code, 'RECOVERY_BUSY');
  assert.equal(race.plugin.messageLanes.get(lane), 'new-ordinary-owner');
  assert.equal(race.calls.filter(call => ['conversation.create', 'conversation.submit'].includes(call.type)).length, 0);
});

test('Recovery accepted is not completed until exact original terminal decision and native final mirror receipts', async t => {
  const f = await fixture(t, 1); await f.control.handleApproved(f.request); await f.control.handleApproved({ ...f.request, mode: 'apply' });
  let state = { status: 'running', activeTurnId: f.candidate.scope.inputIds[0] };
  f.plugin.command = async () => state;
  // Capsule input is an approved controller test seam, not fake Slack events.
  f.control.readApproved = async () => ({ ...f.request, mode: 'apply' });
  const filename = digest(f.request.operationId) + '.json'; await fs.writeFile(path.join(f.directory, filename), '{}');
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted');
  const key = threadKey(teamId, channel, '100.1'), inputId = f.candidate.scope.inputIds[0];
  state = { status: 'waiting-for-user', activeTurnId: null, participationRequestIds: [inputId], participationDecision: 'reply',
    messages: [{ id: 'final-original', role: 'assistant', requestId: inputId, text: 'final' }] };
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted');
  await f.store.update(data => { data.threads[key].mirrored['final-original'] = { ts: '200.1', hash: 'formal-original-receipt' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  assert.equal(f.store.data.inbox[f.ids[0]].status, 'attention');
  const reset = async messages => {
    state.messages = messages.map(message => ({ role: 'assistant', requestId: inputId, ...message }));
    await f.store.update(data => { data.recoveries[f.request.operationId].status = 'accepted'; data.threads[key].mirrored = {}; data.projectSwitches = {}; });
  };
  const card = { kind: 'binding-proposal', id: 'original-proposal' };
  await reset([{ id: 'binding-only', text: '', actions: [card] }]);
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Pending binding card is not delivery');
  await f.store.update(data => { data.threads[key].mirrored['binding:other-proposal'] = { ts: '201.1' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Another card cannot acknowledge this proposal');
  await f.store.update(data => { data.threads[key].mirrored['binding:original-proposal'] = { ts: '202.1', hash: 'formal-card' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  assert.equal(f.store.data.threads[key].mirrored['binding-only'], undefined, 'No empty assistant slot is required');
  await reset([{ id: 'text-and-card', text: '请确认', actions: [card] }]);
  await f.store.update(data => { data.threads[key].mirrored['binding:original-proposal'] = { ts: '203.1' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Card ACK cannot mask missing text');
  await f.store.update(data => { delete data.threads[key].mirrored['binding:original-proposal']; data.threads[key].mirrored['text-and-card'] = { ts: '204.1' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Text ACK cannot mask missing card');
  await f.store.update(data => { data.threads[key].mirrored['binding:original-proposal'] = { ts: '203.1' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  await reset([{ id: 'mounted-only', text: '', actions: [{ kind: 'conversation-mounted' }] }]);
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed', 'Mounted-only receipt never waits for a nonexistent empty post');
  const switching = { kind: 'project-switch', actionId: 'original-switch' }, switchKey = `project-switch-${digest([key, switching.actionId])}`;
  await reset([{ id: 'switch-only', text: '', actions: [switching] }]);
  await f.store.update(data => { data.projectSwitches[switchKey] = { status: 'applied', announced: false }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted');
  await f.store.update(data => { data.projectSwitches[switchKey].announced = true; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  await reset([{ id: 'text-and-switch', text: '原正文', actions: [switching] }]);
  await f.store.update(data => { data.projectSwitches[switchKey] = { status: 'applied', announced: false }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Dedicated switch result is not yet acknowledged');
  await f.store.update(data => { data.projectSwitches[switchKey].announced = true; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  assert.equal(f.store.data.threads[key].mirrored['text-and-switch'], undefined, 'Switch adapter replaces body with its dedicated result, never a raw slot');
  await reset([{ id: 'unsupported-mixed-switch', text: '', actions: [switching, card] }]);
  await f.store.update(data => { data.projectSwitches[switchKey] = { status: 'applied', announced: true };
    data.threads[key].mirrored['binding:original-proposal'] = { ts: '205.1' }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted', 'Unsupported mixed switch actions fail closed, even with unrelated receipts');
  for (const message of [{ id: 'question', questions: [{ id: 'original-question', text: '确认？' }] }, { id: 'attachment', attachments: [{ id: 'original-file' }] }]) {
    await reset([message]);
    await f.store.update(data => { data.threads[key].mirrored[message.id] = 'truthy-but-not-a-receipt'; });
    await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted');
    await f.store.update(data => { data.threads[key].mirrored[message.id] = { ts: '206.1' }; });
    await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  }
  const reaction = { kind: 'slack-reaction', actionId: 'original-reaction' }, reactionKey = `reaction-${digest([key, reaction.actionId])}`;
  await reset([{ id: 'reaction-only', text: '', actions: [reaction] }]);
  await f.store.update(data => { data.reactionOutbox = { [reactionKey]: { status: 'pending' } }; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'accepted');
  await f.store.update(data => { data.reactionOutbox[reactionKey].status = 'sent'; });
  await f.control.run(); assert.equal(f.store.data.recoveries[f.request.operationId].status, 'completed');
  assert.equal(f.store.data.inbox[f.ids[0]].status, 'attention');
  assert.equal(f.store.data.inbox[f.ids[0]].attempts, 3); assert.equal(f.store.data.inbox[f.ids[0]].error, 'RELEVANCE_UNAVAILABLE');
});
