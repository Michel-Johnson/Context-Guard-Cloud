import path from 'node:path';
import { atomicWrite, readJSON, withFileLock, hash } from '../shared/io.mjs';
import { MapError } from '../shared/map-model.mjs';
import { coordinatorNodePath, coordinatorPathText, coordinatorNodeLabel } from '../shared/coordinator-path.mjs';

const encode = value => JSON.stringify(value, null, 2) + '\n';
const fail = (code, text, status = 409) => { throw new MapError(code, text, status); };
const actorId = actor => actor?.kind === 'human' && typeof actor.sessionId === 'string' && actor.sessionId;
const focus = item => ({ nodeId: item.nodeId || null, kind: item.kind || null, itemId: item.itemId || null });
const pathIdentity = chain => JSON.stringify(chain.map(({ id, title, purpose }) => ({ id, title, purpose })));
export const bindingReplyDecision = (text, { slackAttribution = false, allowBareConfirmation = false } = {}) => {
  // Slack 连接器的固定署名不是指令，也不参与身份判定；仍只接受整句明确确认。
  const body = (slackAttribution ? text.replace(/\s+\*Sent using\* <@[A-Z0-9]{1,32}>\s*$/u, '') : text).trim();
  return /^(同意绑定|确认绑定)[。！!]?$/u.test(body) || allowBareConfirmation && /^(确认|同意)[。！!]?$/u.test(body) ? 'approved' :
    /^(暂不绑定|不绑定|拒绝绑定)[。！!]?$/u.test(body) ? 'rejected' : null;
};
const visible = proposal => ({ id: proposal.id, kind: 'binding-proposal', version: proposal.version,
  conversationId: proposal.conversationId, node: { ...proposal.node, label: coordinatorNodeLabel(proposal.node) },
  path: proposal.path.map(node => ({ ...node, label: coordinatorNodeLabel(node) })), pathText: coordinatorPathText(proposal.path),
  ...(typeof proposal.input.description === 'string' && proposal.input.description.trim() ? { reason: proposal.input.description.trim() } : {}),
  itemKind: proposal.input.kind, title: proposal.input.title, requiresHumanApproval: true,
  pending: !proposal.review, ...(proposal.review ? { decision: proposal.review.decision } : {}) });

// 这是现有对话的确认记录，不写 Main，也不创建执行 Session。
export class CoordinatorBindings {
  constructor({ directory, readMain, conversations, nodeIds = null }) {
    this.file = path.join(directory, 'binding-reviews.json');
    Object.assign(this, { readMain, conversations, nodeIds });
  }
  async state() { return readJSON(this.file, { proposals: {}, reviews: {}, pending: {} }); }
  async withStableFocus(conversationId, action) {
    return withFileLock(this.file + '.lock', async () => {
      const current = await this.conversations.get(conversationId), state = await this.state();
      const approved = Object.values(state.proposals).find(proposal => current.bindingApproval === 'binding-confirm:' + proposal.id);
      if (!approved || approved.conversationId !== conversationId || approved.review?.decision !== 'approved' ||
          approved.input.nodeId !== current.nodeId || approved.input.kind !== current.kind) fail('APPROVAL_REQUIRED', '请先确认当前需求的主节点');
      const snapshot = await this.readMain(), chain = coordinatorNodePath(snapshot.memory.map.root, current.nodeId, { nodeIds: this.nodeIds });
      if (pathIdentity(chain) !== pathIdentity(approved.path)) fail('APPROVAL_REQUIRED', '节点路径或职责已变化，请重新确认归属');
      return action(current);
    });
  }
  async approvals(conversationId) {
    return Object.values((await this.state()).proposals).filter(item => item.conversationId === conversationId).map(visible);
  }
  async notifications(conversationId) {
    return Object.values((await this.state()).proposals).filter(item => item.conversationId === conversationId &&
      item.review?.result && !item.review.notified).map(item => item.review.result);
  }
  async acknowledge(proposalId, conversationId) {
    await withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), proposal = state.proposals[proposalId];
      if (!proposal || proposal.conversationId !== conversationId || !proposal.review?.result) fail('NOT_FOUND', '绑定确认回执不存在', 404);
      proposal.review.notified = true;
      await atomicWrite(this.file, encode(state));
    });
  }
  async naturalReview(text, { id, conversationId, actor, reference, slackAttribution = false, allowBareConfirmation = false }) {
    const decision = bindingReplyDecision(text, { slackAttribution, allowBareConfirmation });
    if (!decision || !actorId(actor)) return null;
    const state = await this.state(), proposal = state.proposals[reference?.id || state.pending[conversationId]];
    if (!proposal || proposal.actorId !== actorId(actor)) return null;
    return this.review({ id: 'binding-reply:' + hash(id), proposalId: proposal.id, version: reference?.version || proposal.version, decision }, { conversationId, actor, humanInputId: id });
  }
  async propose(input, { operationId, conversationId, actor }) {
    if (!actorId(actor)) fail('FORBIDDEN', '仅人类当前对话可以提出绑定', 403);
    const fingerprint = hash(JSON.stringify({ input, conversationId, actor: actorId(actor) }));
    const id = 'binding-' + hash(operationId);
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), previous = state.proposals[id];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', '此绑定请求已用于其他内容');
        return visible(previous);
      }
      const snapshot = await this.readMain();
      if (snapshot.version !== input.mainVersion) fail('VERSION_CONFLICT', 'Map 已变化，请重新读取候选节点');
      const chain = coordinatorNodePath(snapshot.memory.map.root, input.nodeId, { nodeIds: this.nodeIds });
      const node = chain.at(-1), before = await this.conversations.get(conversationId);
      const confirmed = !state.pending[conversationId] && Object.values(state.proposals).find(proposal =>
        proposal.conversationId === conversationId && proposal.actorId === actorId(actor) && pathIdentity(proposal.path) === pathIdentity(chain) &&
        proposal.review?.decision === 'approved' && before.bindingApproval === 'binding-confirm:' + proposal.id &&
        before.nodeId === input.nodeId && before.kind === input.kind);
      if (confirmed) return visible(confirmed);
      const proposal = { id, fingerprint, conversationId, actorId: actorId(actor), input: structuredClone(input),
        before: focus(before), node: { id: node.id, title: node.title, purpose: node.purpose, label: coordinatorNodeLabel(node) },
        path: chain.map(node => ({ id: node.id, title: node.title, purpose: node.purpose, label: coordinatorNodeLabel(node) })),
        pathText: coordinatorPathText(chain) };
      proposal.version = hash(JSON.stringify(proposal));
      const pending = state.proposals[state.pending[conversationId]];
      if (pending && !pending.review) pending.review = { decision: 'superseded' };
      state.proposals[id] = proposal; state.pending[conversationId] = id;
      await atomicWrite(this.file, encode(state));
      return visible(proposal);
    });
  }
  async review(input, { conversationId, actor, humanInputId }) {
    if (!input || Object.keys(input).some(key => !['id', 'proposalId', 'version', 'decision'].includes(key)) ||
        typeof input.id !== 'string' || !input.id || input.id.length > 160 || typeof input.proposalId !== 'string' ||
        typeof input.version !== 'string' || !['approved', 'rejected'].includes(input.decision)) fail('INVALID_ARGUMENT', '请确认具体的绑定建议', 400);
    if (!actorId(actor)) fail('FORBIDDEN', '绑定必须由人类确认', 403);
    const fingerprint = hash(JSON.stringify({ proposalId: input.proposalId, version: input.version,
      decision: input.decision, conversationId, actorId: actorId(actor) }));
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), previous = state.reviews[input.id];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', '确认请求已用于其他内容');
        return previous.result;
      }
      const proposal = state.proposals[input.proposalId];
      if (!proposal || proposal.conversationId !== conversationId) fail('NOT_FOUND', '此对话没有该绑定建议', 404);
      if (proposal.actorId !== actorId(actor)) fail('FORBIDDEN', '只能由提出需求的人确认绑定', 403);
      if (proposal.version !== input.version) fail('VERSION_CONFLICT', '绑定建议已变化');
      if (proposal.review) {
        if (proposal.review.decision !== input.decision || proposal.review.fingerprint !== fingerprint) fail('CONFLICT', '该建议已处理');
        state.reviews[input.id] = { fingerprint, result: proposal.review.result };
        await atomicWrite(this.file, encode(state)); return proposal.review.result;
      }
      if (state.pending[conversationId] !== proposal.id) fail('CONFLICT', '已有更新的绑定建议');
      const approvalId = 'binding-confirm:' + proposal.id;
      if (input.decision === 'approved') {
        const snapshot = await this.readMain(), current = await this.conversations.get(conversationId);
        // 已提交的焦点可恢复失回；后续改绑仍由 setFocus 的 CAS 拒绝覆盖。
        if (current.bindingApproval !== approvalId && snapshot.version !== proposal.input.mainVersion) fail('VERSION_CONFLICT', 'Map 已变化，请重新确认路径');
        coordinatorNodePath(snapshot.memory.map.root, proposal.input.nodeId, { nodeIds: this.nodeIds });
        await this.conversations.setFocus(conversationId, { nodeId: proposal.input.nodeId, kind: proposal.input.kind,
          title: proposal.input.title, expectedFocus: proposal.before, bindingApproval: approvalId });
      }
      const result = { proposalId: proposal.id, decision: input.decision, node: proposal.node,
        path: proposal.path, pathText: proposal.pathText, conversationId,
        ...(humanInputId ? { humanInputId } : {}),
        message: input.decision === 'approved' ? '已确认绑定到' + coordinatorNodeLabel(proposal.node) : '暂不绑定，继续讨论' };
      proposal.review = { decision: input.decision, fingerprint, result };
      delete state.pending[conversationId]; state.reviews[input.id] = { fingerprint, result };
      await atomicWrite(this.file, encode(state));
      return result;
    });
  }
}
