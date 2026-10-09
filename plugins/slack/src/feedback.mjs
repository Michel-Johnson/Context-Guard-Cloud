import { digest } from './store.mjs';
import { slackStatusEmojis } from '../../../scripts/cloud/slack-reactions.mjs';

export const feedbackEventHash = event => digest({ ...event, type: 'message' });
const human = event => ['message', 'app_mention'].includes(event?.type) && !event.bot_id && !event.bot_profile && !event.hidden &&
  (!event.subtype || event.subtype === 'file_share') && /^[UW][A-Z0-9]{1,31}$/.test(event.user || '') &&
  /^[DCG][A-Z0-9]{1,31}$/.test(event.channel || '') && /^\d+\.\d+$/.test(event.ts || '');
const rejected = new Set(['invalid_name', 'message_not_found', 'channel_not_found', 'not_in_channel', 'is_archived',
  'restricted_action', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'missing_scope', 'permission_denied']);

// 系统状态只与原始 Inbox 消息关联，不依赖尚未建立的项目/模型绑定。
// 每条消息串行处理一个耐久平台操作，结果未知时只恢复原操作。
export class SlackFeedback {
  constructor(plugin) { this.plugin = plugin; this.running = new Set(); }
  get store() { return this.plugin.store; }
  target(envelope) {
    const body = envelope?.body, event = body?.event;
    if (envelope?.type !== 'events_api' || body?.team_id !== this.plugin.teamId || !human(event) || event.user === this.plugin.botUserId) return null;
    return { teamId: body.team_id, userId: event.user, channel: event.channel, timestamp: event.ts, eventHash: feedbackEventHash(event) };
  }
  valid(id, record = this.store.data.feedback?.[id]) {
    const original = this.store.data.inbox[id], body = original?.envelope?.body, event = body?.event;
    return record && original?.envelope?.type === 'events_api' && body.team_id === this.plugin.teamId && human(event) &&
      event.user !== this.plugin.botUserId && record.teamId === body.team_id && record.userId === event.user &&
      record.channel === event.channel && record.timestamp === event.ts && record.eventHash === feedbackEventHash(event);
  }
  async receive(id) {
    const original = this.store.data.inbox[id], target = this.target(original?.envelope);
    if (!target) return;
    await this.store.update(state => {
      const previous = (state.feedback ||= {})[id];
      if (previous) {
        if (Object.entries(target).some(([key, value]) => previous[key] !== value)) throw Object.assign(new Error('反馈目标已改变'), { code: 'ID_REUSED' });
        return;
      }
      state.feedback[id] = { ...target, desired: 'received', revision: 0, inputRevision: -1, controlRevision: -1,
        receivedAt: original.at, savedAt: Date.now(), applied: {}, receipts: [], pending: null };
    });
  }
  async decide(id, desired, { inputRevision = 0, controlRevision = 0, requestId } = {}) {
    if (!Object.hasOwn(slackStatusEmojis, desired) || !this.valid(id)) return;
    await this.store.update(state => {
      const item = state.feedback[id];
      if (inputRevision < item.inputRevision || inputRevision === item.inputRevision && controlRevision < item.controlRevision) return;
      // 新消息使全局输入版本递增，也不能把旧原消息的完成状态重置为处理中。
      if (item.desired === 'completed' && desired !== 'completed' && controlRevision <= item.controlRevision) return;
      if (inputRevision === item.inputRevision && controlRevision === item.controlRevision &&
          ['reply', 'silent'].includes(item.desired) && ['reply', 'silent'].includes(desired) && item.desired !== desired) return;
      if (inputRevision === item.inputRevision && controlRevision === item.controlRevision &&
          (['failed', 'stopped'].includes(item.desired) && ['reply', 'silent', 'completed'].includes(desired) ||
            item.desired === 'silent' && desired === 'completed')) return;
      // 相同已判定轮次的旧 pending 快照不能把状态重置为“已收到”。
      if (desired === 'received' && item.desired !== 'received') return;
      item.inputRevision = inputRevision; item.controlRevision = controlRevision;
      if (item.desired === desired) return;
      item.desired = desired; item.revision++; item.decisionAt = Date.now(); item.requestId = requestId;
    });
  }
  drain() {
    if (this.plugin.stopped) return;
    const entries = Object.entries(this.store.data.feedback || {}).sort(([, a], [, b]) =>
      Number(b.desired === 'received') - Number(a.desired === 'received') || a.savedAt - b.savedAt);
    for (const [id, item] of entries) {
      if (this.plugin.reactions.size >= 8) break;
      if (this.running.has(id) || !this.valid(id, item) || item.pending?.status === 'failed' || item.pending?.status === 'attention' || item.pending?.next > Date.now()) continue;
      const desired = slackStatusEmojis[item.desired];
      if (!item.pending && item.applied[desired] && !Object.keys(item.applied).some(emoji => emoji !== desired && item.applied[emoji])) continue;
      this.running.add(id);
      const task = this.run(id).catch(error => this.plugin.logger.warn('Slack 状态反馈保留', { code: error.code || 'FEEDBACK_JOURNAL_ERROR' }))
        .finally(() => { this.running.delete(id); this.plugin.reactions.delete(task); this.plugin.kick(); });
      this.plugin.reactions.add(task);
    }
  }
  async run(id) {
    for (let steps = 0; steps < 8 && !this.plugin.stopped; steps++) {
      if (!this.valid(id)) return;
      let item = this.store.data.feedback[id], pending = item.pending;
      if (pending && (pending.next > Date.now() || ['failed', 'attention'].includes(pending.status))) return;
      if (!pending) {
        const wanted = slackStatusEmojis[item.desired];
        const remove = Object.keys(item.applied).find(emoji => emoji !== wanted && item.applied[emoji]);
        const method = item.applied[wanted] ? 'remove' : 'add', emoji = method === 'add' ? wanted : remove;
        if (!emoji) return;
        pending = { method, emoji, revision: item.revision, attempts: 0, status: 'pending', next: 0 };
        await this.store.update(state => { state.feedback[id].pending = pending; });
      }
      if (pending.attempts >= 8) { await this.store.update(state => { state.feedback[id].pending.status = 'attention'; }); return; }
      await this.store.update(state => {
        const record = state.feedback[id]; record.firstAttemptAt ||= Date.now();
        record.pending.status = 'sending'; record.pending.attempts++; record.pending.startedAt = Date.now();
      });
      if (this.plugin.stopped || !this.valid(id)) {
        await this.store.update(state => { state.feedback[id].pending.status = 'pending'; state.feedback[id].pending.attempts--; }); return;
      }
      item = this.store.data.feedback[id]; pending = item.pending;
      try {
        await this.plugin.io.call(`reactions.${pending.method}`, { channel: item.channel, timestamp: item.timestamp, name: pending.emoji });
        await this.confirm(id, pending);
      } catch (error) {
        const code = error.data?.error;
        const confirmed = error.code === 'slack_webapi_platform_error' &&
          (pending.method === 'add' && code === 'already_reacted' || pending.method === 'remove' && code === 'no_reaction');
        if (confirmed) { await this.confirm(id, pending); continue; }
        const known = error.code === 'slack_webapi_platform_error' && rejected.has(code);
        await this.store.update(state => {
          const operation = state.feedback[id].pending;
          operation.status = known ? 'failed' : operation.attempts >= 8 ? 'attention' : 'unknown';
          operation.error = error.code || 'REACTION_UNCERTAIN';
          const retryAfter = Number(error.retryAfter);
          operation.next = Date.now() + Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
            Math.min(60000, 1000 * 2 ** operation.attempts));
        });
        return;
      }
    }
  }
  async confirm(id, operation) {
    await this.store.update(state => {
      const item = state.feedback[id];
      item.applied[operation.emoji] = operation.method === 'add';
      item.receipts = [...item.receipts, { method: operation.method, emoji: operation.emoji, revision: operation.revision,
        attempts: operation.attempts, confirmedAt: Date.now() }].slice(-40);
      item.pending = null; item.confirmedAt = Date.now();
    });
  }
}
