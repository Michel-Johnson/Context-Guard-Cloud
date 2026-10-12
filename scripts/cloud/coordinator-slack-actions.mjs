import path from 'node:path';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { MapError } from '../shared/map-model.mjs';

const fail = (code, message) => { throw new MapError(code, message, 409); };
export const isSlackOperator = actor => actor?.kind === 'human' && actor.integration === 'slack' &&
  /^[TE][A-Z0-9]{1,31}$/.test(actor.teamId || '') && /^[UW][A-Z0-9]{1,31}$/.test(actor.userId || '') &&
  actor.sessionId === `slack:${actor.teamId}:${actor.userId}`;

// 模型和按钮共用真实版本、业务入口；模型不能填写操作者或任意命令。
export function coordinatorSlackActions(state, catalog) {
  const actions = [];
  const add = (label, type, payload) => actions.push({ id: `button-${hash(encode({ type, payload }))}`, label, type, payload });
  if (state.executionMode === 'manual') {
    if (state.zcodeAvailable) add('启用本地 ZCode', 'conversation.zcode', { expectedMode: 'manual' });
    if (state.cursorAvailable) add('启用 Cursor', 'conversation.cursor', { expectedMode: 'manual' });
  }
  for (const proposal of state.approvals || []) {
    const label = proposal.title || proposal.node?.label || proposal.node?.title || proposal.text?.split('\n')[0] || '当前方案';
    if (proposal.pending && !proposal.stale) {
      for (const decision of ['approved', 'rejected']) add(`${decision === 'approved' ? '确认' : '退回'}${label}`,
        proposal.kind === 'binding-proposal' ? 'binding.review' : 'brief.review',
        { proposalId: proposal.id, version: proposal.version || proposal.brief?.version, decision,
          ...(proposal.kind === 'binding-proposal' ? {} : { reason: 'Coordinator 根据当前对话代操作' }) });
    } else if (proposal.manual && proposal.decision === 'approved' && !proposal.stale) {
      add(`导出${label}的执行提示`, 'prompt.read', { proposalId: proposal.id });
    }
  }
  for (const review of state.acceptances || []) for (const decision of ['approved', 'rejected']) {
    add(`${decision === 'approved' ? '验收通过' : '退回结果'}：${review.title || '当前任务'}`, 'acceptance.review',
      { sessionId: review.sessionId, generation: review.generation, taskId: review.taskId, ref: review.ci.ref, version: review.ci.version,
        decision, reason: 'Coordinator 根据当前对话代操作' });
  }
  for (const option of catalog?.options || []) add(`切换到${option.label}`, 'models.select', { providerId: option.id, baseVersion: catalog.version });
  return actions;
}

export class CoordinatorSlackActions {
  constructor(directory) { this.directory = directory; }
  file(id) {
    if (typeof id !== 'string' || !id) fail('INVALID_ARGUMENT', 'Use a stable action ID');
    return path.join(this.directory, `${hash(id)}.json`);
  }
  async prepare({ id, actor, requestId, projectId, conversationId, action }) {
    if (!isSlackOperator(actor) || !requestId) fail('FORBIDDEN', 'Use the verified current Slack operator');
    const file = this.file(id), fingerprint = hash(encode({ actor, requestId, projectId, conversationId, action }));
    return withFileLock(file + '.lock', async () => {
      const old = await readJSON(file, null);
      if (old && old.fingerprint !== fingerprint) fail('ID_REUSED', 'Delegated action changed');
      if (!old) await atomicWrite(file, encode({ id, fingerprint, actor, requestId, projectId, conversationId, action,
        performedBy: 'coordinator', status: 'queued', createdAt: new Date().toISOString() }));
      return { kind: 'slack-operation', actionId: id, requestId, actor, label: action.label, status: old?.status || 'queued',
        instruction: '宿主将执行与按钮相同的操作；这是已保存请求，不是成功回执。不再让用户点击或去客户端启用。' };
    });
  }
  async apply({ id, actor, projectId, conversationId, authorize, execute }) {
    const file = this.file(id);
    return withFileLock(file + '.lock', async () => {
      const item = await readJSON(file, null);
      if (!item || !isSlackOperator(actor) || item.actor.sessionId !== actor.sessionId ||
          item.projectId !== projectId || item.conversationId !== conversationId) fail('FORBIDDEN', 'Action belongs to another operator or conversation');
      await authorize(item);
      if (item.status === 'applied') return item.result;
      const data = await execute(item.action, item.actor, item.id);
      const result = { performedBy: 'coordinator', label: item.action.label, status: 'applied', data };
      await atomicWrite(file, encode({ ...item, status: 'applied', result, appliedAt: new Date().toISOString() }));
      return result;
    });
  }
}
