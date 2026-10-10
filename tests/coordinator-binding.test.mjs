import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorBindings, bindingReplyDecision } from '../scripts/cloud/coordinator-binding.mjs';
import { CoordinatorConversations, CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { buildCoordinatorContext } from '../scripts/cloud/coordinator-context.mjs';

const actor = { kind: 'human', sessionId: 'browser-human' };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-binding-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const conversations = new CoordinatorConversations(directory);
  const conversationId = await conversations.createChat('test-chat', { executionMode: 'manual' });
  const snapshot = { version: 'v1', memory: { map: { root: { id: 'ROOT', title: '项目', purpose: '目标', children: [
    { id: 'ENGINEERING', title: '工程', purpose: '工程边界', children: [ { id: 'TESTING', title: '测试', purpose: '回归' } ] },
    { id: 'READING', title: '阅读', purpose: '页面' },
  ] } } } };
  const make = () => new CoordinatorBindings({ directory, conversations, readMain: async () => snapshot });
  const bindings = make();
  const propose = (operationId, kind = 'todo', nodeId = 'TESTING') => bindings.propose({ mainVersion: snapshot.version,
    nodeId, kind, title: '完善测试', description: '需求' }, { operationId, conversationId, actor });
  const review = (proposal, decision = 'approved', id = 'confirm-' + proposal.id) => ({ id, proposalId: proposal.id, version: proposal.version, decision });
  return { bindings, conversations, conversationId, snapshot, make, propose, review, context: { conversationId, actor } };
}

test('TODO 和 Bug 建议不改变归属，人类确认后只绑定一个主节点且可持久恢复', async t => {
  const f = await fixture(t), original = JSON.stringify(f.snapshot);
  for (const kind of ['todo', 'bug']) {
    const proposal = await f.propose('proposal-' + kind, kind);
    assert.equal(proposal.kind, 'binding-proposal'); assert.equal(proposal.pending, true);
    assert.equal(proposal.reason, '需求');
    assert.equal((await f.make().approvals(f.conversationId)).find(item => item.id === proposal.id).reason, proposal.reason);
    assert.equal((await f.conversations.get(f.conversationId)).kind, kind === 'todo' ? undefined : 'todo');
    assert.equal(proposal.pathText, '项目 → 工程 → 测试');
    assert.doesNotMatch(proposal.pathText, /ROOT|ENGINEERING|TESTING/);
    const result = await f.bindings.review(f.review(proposal), f.context);
    assert.equal(result.decision, 'approved');
    assert.deepEqual(await f.make().review(f.review(proposal), f.context), result);
    const focus = await new CoordinatorConversations(f.conversations.directory).get(f.conversationId);
    assert.equal(focus.nodeId, 'TESTING'); assert.equal(focus.kind, kind); assert.equal(focus.nodeIds, undefined);
  }
  assert.equal(JSON.stringify(f.snapshot), original, '绑定不写 Main 或创建执行 Session');
});

test('旧绑定卡片只更新展示路径，不改已保存版本或审批内容', async t => {
  const f = await fixture(t), proposal = await f.propose('legacy-view');
  const stored = await f.bindings.state();
  stored.proposals[proposal.id].pathText = '项目\n└─ 工程\n  └─ 测试';
  await fs.writeFile(f.bindings.file, JSON.stringify(stored));
  const before = await fs.readFile(f.bindings.file, 'utf8');
  const displayed = (await f.bindings.approvals(f.conversationId))[0];
  assert.equal(displayed.pathText, '项目 → 工程 → 测试'); assert.equal(displayed.version, proposal.version);
  assert.equal(await fs.readFile(f.bindings.file, 'utf8'), before);
});

test('拒绝、冒用身份、过期版本和被替换的建议均不能绑定', async t => {
  const f = await fixture(t), first = await f.propose('first');
  await assert.rejects(f.bindings.review(f.review(first), { ...f.context, actor: { kind: 'human', sessionId: 'other' } }), { code: 'FORBIDDEN' });
  f.snapshot.version = 'v2';
  await assert.rejects(f.bindings.review(f.review(first), f.context), { code: 'VERSION_CONFLICT' });
  const second = await f.propose('second');
  await assert.rejects(f.bindings.review(f.review(first), f.context), { code: 'CONFLICT' });
  await f.bindings.review(f.review(second, 'rejected'), f.context);
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
});

test('裸确认只有宿主锁定当前具体候选时才生效，冒用和过期仍被拒绝', async t => {
  const f = await fixture(t), proposal = await f.propose('bare-confirm');
  assert.equal(bindingReplyDecision('确认'), null);
  assert.equal(bindingReplyDecision('确认', { allowBareConfirmation: true }), 'approved');
  assert.equal(bindingReplyDecision('旧消息：“确认”', { allowBareConfirmation: true }), null);
  assert.equal(await f.bindings.naturalReview('确认', { id: 'no-reference', ...f.context }), null);
  assert.equal(await f.bindings.naturalReview('确认', { id: 'wrong-actor', ...f.context,
    actor: { kind: 'human', sessionId: 'other' }, reference: proposal, allowBareConfirmation: true }), null);
  const result = await f.bindings.naturalReview('确认', { id: 'current-confirm', ...f.context, reference: proposal, allowBareConfirmation: true });
  assert.equal(result.decision, 'approved');
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
});

test('相同候选已有有效确认时复用审批，不再次要求确认或改变焦点', async t => {
  const f = await fixture(t), first = await f.propose('one');
  await f.bindings.review(f.review(first), f.context);
  const before = await f.conversations.get(f.conversationId);
  const repeated = await f.propose('same-candidate-new-operation');
  assert.equal(repeated.pending, false); assert.equal(repeated.decision, 'approved');
  assert.equal(repeated.id, first.id);
  assert.deepEqual(await f.conversations.get(f.conversationId), before);
  assert.equal((await f.bindings.approvals(f.conversationId)).length, 1);
  f.snapshot.version = 'unrelated-main-update';
  const revisedReason = await f.bindings.propose({ mainVersion: f.snapshot.version, nodeId: 'TESTING', kind: 'todo',
    title: '完善测试', description: '新的说明，但归属未变' }, { operationId: 'same-scope-new-reason', ...f.context });
  assert.equal(revisedReason.id, first.id); assert.equal(revisedReason.pending, false);
  await f.bindings.withStableFocus(f.conversationId, () => true);
  f.snapshot.memory.map.root.children[0].children[0].purpose = '改变后的职责';
  await assert.rejects(f.bindings.withStableFocus(f.conversationId, () => assert.fail('失效绑定不得进入brief')), { code: 'APPROVAL_REQUIRED' });
});

test('会话能力锁不批准任务，未确认的焦点仍不能准备 brief', async t => {
  const f = await fixture(t), before = await f.conversations.get(f.conversationId);
  let focusActions = 0;
  await assert.rejects(f.bindings.withStableFocus(f.conversationId, () => { focusActions++; }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(focusActions, 0);
  assert.deepEqual(await f.bindings.withStableConversation(f.conversationId, current => current), before);
  assert.deepEqual(await f.conversations.get(f.conversationId), before);
  assert.deepEqual(await f.bindings.state(), { proposals: {}, reviews: {}, pending: {} });

  // 复用同一绑定锁，待提出的建议不能插入能力切换期间。
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const held = f.bindings.withStableConversation(f.conversationId, async current => {
    entered(); await gate;
    assert.deepEqual(await f.bindings.state(), { proposals: {}, reviews: {}, pending: {} });
    return current;
  });
  await started;
  const proposed = f.propose('after-capability-lock');
  release();
  assert.deepEqual(await held, before);
  assert.equal((await proposed).pending, true);
  await assert.rejects(f.bindings.withStableFocus(f.conversationId, () => { focusActions++; }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(focusActions, 0);
});

test('绑定后的失回可恢复，但旧确认不能覆盖后来人工改绑', async t => {
  const f = await fixture(t), proposal = await f.propose('lost-ack');
  const save = f.conversations.setFocus.bind(f.conversations); let failed = false;
  f.conversations.setFocus = async (...args) => { const result = await save(...args); if (!failed) { failed = true; throw new Error('synthetic lost ack'); } return result; };
  await assert.rejects(f.bindings.review(f.review(proposal), f.context), /synthetic/);
  const result = await f.make().review(f.review(proposal), f.context); assert.equal(result.decision, 'approved');
  const other = await f.propose('new-focus', 'todo', 'READING');
  await f.bindings.review(f.review(other), f.context);
  await f.make().review(f.review(proposal), f.context);
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'READING');
});

test('自然语言确认仅作用于当前人的待确认建议，引用或普通提问不算同意', async t => {
  const f = await fixture(t); await f.propose('natural');
  for (const text of ['解释一下如何同意绑定', '旧消息：“同意绑定”', '换个节点']) {
    assert.equal(await f.bindings.naturalReview(text, { id: text, ...f.context }), null);
  }
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
  const result = await f.bindings.naturalReview('同意绑定', { id: 'human-reply', ...f.context });
  assert.equal(result.decision, 'approved'); assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
});

test('Slack 固定署名不阻止整句确认，也不授予身份或让引用变成确认', async t => {
  const suffix = ' *Sent using* <@U0C681J4XMW>', text = '同意绑定' + suffix;
  assert.equal(bindingReplyDecision(text), null);
  assert.equal(bindingReplyDecision(text, { slackAttribution: true }), 'approved');
  assert.equal(bindingReplyDecision('暂不绑定' + suffix, { slackAttribution: true }), 'rejected');
  for (const body of ['旧消息：“同意绑定”', '解释一下同意绑定', '同意绑定，但先别执行', '同意绑定 *Sent using* @未知']) {
    assert.equal(bindingReplyDecision(body + suffix, { slackAttribution: true }), null);
  }
  const f = await fixture(t); await f.propose('slack-footer');
  assert.equal(await f.bindings.naturalReview(text, { id: 'browser-text', ...f.context }), null);
  assert.equal(await f.bindings.naturalReview(text, { id: 'foreign-text', ...f.context,
    actor: { kind: 'human', sessionId: 'another-human' }, slackAttribution: true }), null);
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
  const result = await f.bindings.naturalReview(text, { id: 'slack-text', ...f.context, slackAttribution: true });
  assert.equal(result.decision, 'approved');
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
});

test('已提交的绑定回执在重启后等待通知，确认通知后不再重复', async t => {
  const f = await fixture(t), proposal = await f.propose('notification');
  const result = await f.bindings.review(f.review(proposal), f.context);
  assert.deepEqual(await f.make().notifications(f.conversationId), [result]);
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
  await f.make().acknowledge(proposal.id, f.conversationId);
  assert.deepEqual(await f.make().notifications(f.conversationId), []);
  assert.deepEqual(await f.make().review(f.review(proposal), f.context), result);
  assert.deepEqual(await f.make().notifications(f.conversationId), []);
});

async function dialogueFixture(t, options = {}) {
  const f = await fixture(t), calls = [], accepted = [];
  f.snapshot.memory.map.root.memoryDocument = '项目约束正文';
  f.snapshot.memory.map.root.children[0].memoryDocument = '工程约束正文';
  f.snapshot.memory.map.root.children[0].children[0].memoryDocument = '测试约束正文';
  const context = async () => {
    const pending = (await f.bindings.approvals(f.conversationId)).find(item => item.pending);
    return { ...buildCoordinatorContext(f.snapshot, { conversation: await f.conversations.get(f.conversationId) }),
      bindingRef: pending ? { id: pending.id, version: pending.version } : null };
  };
  const service = new CoordinatorService({ directory: path.join(f.conversations.directory, 'service'), system: 'role', tools: [], execute: async () => ({}),
    context, beforeAcceptHumanInput: async ({ inputs, context: original, source, actor }) => {
      accepted.push({ ids: inputs.map(input => input.id), source, actor });
      if (!original.bindingRef || !['human', 'slack'].includes(source) || actor?.kind !== 'human') return original;
      const slackAttribution = source === 'slack';
      const last = [...inputs].reverse().find(input => bindingReplyDecision(input.text, { slackAttribution }));
      if (last) await f.bindings.naturalReview(last.text, { id: last.id, ...f.context, actor, reference: original.bindingRef, slackAttribution });
      return context();
    }, model: { next: async request => { calls.push(structuredClone({ system: request.system, messages: request.messages }));
      return { stop: 'end_turn', content: [{ type: 'text', text: '继续讨论' }] }; } }, ...options });
  t.after(() => service.close());
  return { ...f, service, accepted, calls };
}

test('过期、无效与重复消息在确认前被拦截；有效确认的模型输入立即切换路径', async t => {
  const f = await dialogueFixture(t); await f.propose('gated');
  await assert.rejects(f.service.submit({ id: 'stale', text: '同意绑定', expectedTurnId: 'old-turn' }, { actor }), { code: 'STALE_TURN' });
  await assert.rejects(f.service.submit({ id: 'invalid', text: '同意绑定', answerTo: 'missing-question' }, { actor }), { code: 'NOT_FOUND' });
  assert.equal(f.accepted.length, 0); assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
  await f.service.submit({ id: 'approved-input', text: '同意绑定' }, { actor }); await f.service.running;
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
  for (const body of ['工程约束正文', '测试约束正文']) assert.equal(JSON.stringify(f.calls[0]).split(body).length - 1, 1);
  assert.equal((await f.bindings.notifications(f.conversationId))[0].humanInputId, 'approved-input');
  await f.service.submit({ id: 'approved-input', text: '同意绑定' }, { actor }); await f.service.running;
  assert.equal(f.accepted.length, 1); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.submit({ id: 'approved-input', text: '暂不绑定' }, { actor }), { code: 'ID_REUSED' });
});

test('Slack 批量消息按最后一个明确决定确认，重复批次不重复确认', async t => {
  const f = await dialogueFixture(t), slackActor = { kind: 'human', integration: 'slack', teamId: 'TTEST', userId: 'UTEST', sessionId: 'slack:TTEST:UTEST' };
  await f.bindings.propose({ mainVersion: 'v1', nodeId: 'TESTING', kind: 'bug', title: '回归缺陷' }, {
    operationId: 'slack-proposal', conversationId: f.conversationId, actor: slackActor });
  const input = { id: 'slack-batch', inputs: [{ id: 'earlier', text: '暂不绑定 *Sent using* <@U0C681J4XMW>' }, { id: 'latest', text: '同意绑定 *Sent using* <@U0C681J4XMW>' }] };
  await f.service.submit(input, { source: 'slack', actor: slackActor }); await f.service.running;
  assert.equal((await f.conversations.get(f.conversationId)).nodeId, 'TESTING');
  assert.deepEqual(f.accepted[0].ids, ['earlier', 'latest']);
  assert.match(f.calls[0].system, /测试约束正文/);
  assert.match(JSON.stringify(f.calls[0].messages), /Sent using/, '原始消息留在聊天记录，署名不充当身份凭据');
  await f.service.submit(input, { source: 'slack', actor: slackActor }); await f.service.running;
  assert.equal(f.accepted.length, 1); assert.equal(f.calls.length, 1);
});

test('忙碌拒绝不触发绑定确认，失败轮重试保持原快照且不再次确认', async t => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); let modelCalls = 0;
  const f = await dialogueFixture(t, { maxModelRetries: 0, model: { next: async () => {
    modelCalls++; await barrier;
    if (modelCalls === 1) throw Object.assign(new Error('synthetic unavailable'), { code: 'MODEL_UNAVAILABLE' });
    return { stop: 'end_turn', content: [{ type: 'text', text: '已恢复' }] };
  } } });
  await f.service.submit({ id: 'original', text: '讨论一下' }, { actor });
  await f.propose('busy-proposal');
  await assert.rejects(f.service.submit({ id: 'busy', text: '同意绑定' }, { actor }), { code: 'COORDINATOR_BUSY' });
  assert.equal(f.accepted.length, 1); assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
  release(); await f.service.running;
  await f.service.submit({ id: 'original', text: '讨论一下', retry: true }, { actor }); await f.service.running;
  assert.equal(f.accepted.length, 1); assert.equal((await f.conversations.get(f.conversationId)).nodeId, undefined);
});
