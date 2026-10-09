import { digest, threadKey } from './store.mjs';
import { readSlackHistory } from './history.mjs';
import { MAX_TOTAL_IMAGE_BYTES } from './slack-io.mjs';
import { activeMentions, explicitlyAddressed } from './mentions.mjs';
import { SlackFeedback } from './feedback.mjs';
import { slackReactionEmojis } from '../../../scripts/cloud/slack-reactions.mjs';
import { homeView, nodesOf, modal, formValues, messageBlocks, approvalBlocks, bindingBlocks, projectChoiceBlocks, projectOptions, modelChoiceBlocks, section, plain, escape } from './views.mjs';

const operationId = (id, suffix) => `slack-${digest(`${id}:${suffix}`)}`;
const reactionRejected = new Set(['invalid_name', 'message_not_found', 'channel_not_found', 'not_in_channel', 'no_reaction',
  'is_archived', 'restricted_action', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'missing_scope', 'permission_denied']);
const reactionEventHash = event => digest({ ...event, type: 'message' });
const participationTransient = error => {
  // Authentication, identity and contract failures require attention, even when
  // a proxy supplied an unreadable error body. They are never model silence.
  if (['UNAUTHORIZED', 'FORBIDDEN', 'AUTH_REQUIRED', 'INVALID_ARGUMENT', 'INVALID_INPUT', 'CONFLICT', 'ID_REUSED',
    'UPGRADE_REQUIRED', 'VERSION_MISMATCH', 'IDENTITY_MISMATCH', 'MODEL_ROUTE_CHANGED', 'PROTOCOL_MISMATCH',
    'RELEVANCE_SCOPE_MISMATCH', 'RELEVANCE_ROUTING_LIMIT', 'RELEVANCE_INPUT_LIMIT'].includes(error.code) ||
    /(?:^|_)(?:AUTH|IDENTITY|VERSION|UPGRADE|PERMISSION)(?:_|$)/.test(error.code || '')) return false;
  if (error.status === 409 && ['BUSY', 'COORDINATOR_BUSY'].includes(error.code)) return true;
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 429) return false;
  return Number.isInteger(error.status) && (error.status === 429 || error.status >= 500 && error.status <= 599) ||
    ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'RELEVANCE_INVALID_RESPONSE', 'GATEWAY_BAD_RESPONSE', 'GATEWAY_ERROR', 'BUSY', 'COORDINATOR_BUSY'].includes(error.code) ||
    error.name === 'TimeoutError' || error instanceof TypeError;
};
// A read action is retained by Cloud for provenance/focus, but has no Slack UI.
// Preserve actual text, questions, attachments and other presentation actions.
const hasSlackContent = message => !!(message.text || message.questions?.length || message.attachments?.length ||
  message.actions?.some(action => action && !['map-read', 'node-read', 'slack-reaction', 'binding-proposal', 'conversation-mounted'].includes(action.kind)));
const isMessage = event => ['message', 'app_mention'].includes(event?.type) && !event.bot_id && !event.bot_profile && !event.hidden && (!event.subtype || event.subtype === 'file_share');
const indirectMessage = (event, botUserId) => isMessage(event) && event.user !== botUserId &&
  event.channel_type !== 'im' && !event.channel?.startsWith('D') && !explicitlyAddressed(event, botUserId);
const messageLane = (envelope, resume) => {
  const event = resume || (envelope?.type === 'events_api' ? envelope.body?.event : null);
  return isMessage(event) ? `${event.channel}:${event.thread_ts || event.ts}` : null;
};
export function envelopeId(type, body, fallback) {
  if (isMessage(body.event)) return `message:${body.team_id}:${body.event.channel}:${body.event.ts}`;
  return `${type}:${body.event_id || digest([body.team?.id || body.team_id, body.trigger_id || body.view?.id || fallback, body.view?.hash, body.view?.state?.values, body.actions?.map(action => [action.action_id, action.action_ts, action.value, action.selected_option?.value])])}`;
}
function safeEnvelope(type, body) {
  const copy = structuredClone(body);
  delete copy.token; delete copy.response_url;
  if (copy.response_urls) delete copy.response_urls;
  return { type, body: copy };
}
function contextFrom(binding, userId, id) { return { id, userId, projectId: binding.projectId, conversationId: binding.conversationId }; }

export class SlackPlugin {
  constructor({ store, gateway, io, teamId, cloudOrigin, botUserId, pollMs = 1000, collectMs = 800, maxCollectMs = 2000, logger = console }) {
    this.store = store; this.gateway = gateway; this.io = io; this.teamId = teamId; this.cloudOrigin = new URL(cloudOrigin).origin; this.botUserId = botUserId;
    this.pollMs = Math.max(1000, pollMs); this.logger = logger; this.projects = new Map(); this.maps = new Map(); this.stopped = true; this.active = null;
    this.collectMs = collectMs; this.maxCollectMs = maxCollectMs;
    this.processing = new Map();
    this.classifying = new Set();
    this.messageLanes = new Map();
    this.reactions = new Set();
    this.reactionActions = new Set();
    this.userIdentities = new Map();
    this.identityTasks = new Set();
    this.eventStreams = new Map(); this.eventRetry = new Map(); this.eventTasks = new Set(); this.kickRequested = false;
    this.feedback = new SlackFeedback(this);
  }
  async receive({ type, body, envelope_id, ack }) {
    const team = body.team_id || body.team?.id || body.event?.team;
    if (team !== this.teamId) { await ack(); return; }
    // Options must be returned in the Socket Mode acknowledgement, not queued
    // behind model work. Query the current directory for the actual operator.
    if (type === 'interactive' && body.type === 'block_suggestion') {
      let options = [];
      try { options = await this.suggestProjects(body, envelope_id); }
      catch (error) { this.logger.warn('Slack project options unavailable', { code: error.code || 'PROJECT_OPTIONS_UNAVAILABLE' }); }
      await ack({ options }); return;
    }
    const id = envelopeId(type, body, envelope_id);
    if (Object.keys(this.store.data.inbox).length > 50000 && !this.store.data.inbox[id]) throw new Error('Slack journal capacity exceeded');
    const envelope = safeEnvelope(type, body);
    const fresh = await this.store.receive(id, envelope, { collectMs: this.collectMs, maxCollectMs: this.maxCollectMs,
      feedback: this.feedback.target(envelope) });
    this.feedback.drain();
    await ack(type === 'slash_commands' ? { text: '已收到，正在处理。' } : undefined);
    // Modal trigger IDs expire quickly. Do not place them behind model polling
    // or attachment downloads; the journal is still durable before execution.
    if (fresh && !this.stopped && (type === 'slash_commands' || type === 'interactive')) {
      this.processing.set(id, this.runEntry(id, this.store.data.inbox[id]).finally(() => this.processing.delete(id)));
    }
    this.kick();
  }
  start() { this.stopped = false; this.kick(); }
  async stop() {
    this.stopped = true; clearTimeout(this.timer);
    const streams = [...this.eventStreams.values()];
    for (const stream of streams) stream.controller.abort();
    if (this.active) await this.active;
    await Promise.allSettled([...this.processing.values(), ...this.reactions, ...this.eventTasks]);
    await Promise.allSettled([...this.identityTasks]);
    await this.store.tail;
  }
  readReaction(event) {
    // The durable input/Cloud acknowledgement is the business receipt. An
    // optional Slack reaction must never hold up mirroring a ready answer.
    if (this.stopped || this.reactions.size >= 8) return;
    const pending = Promise.resolve().then(() => this.io.call('reactions.add', { channel: event.channel, timestamp: event.ts, name: 'eyes' }))
      .catch(() => {}).finally(() => this.reactions.delete(pending));
    this.reactions.add(pending);
  }
  async queueReactions(key, message, messages, { read = false } = {}) {
    const ready = [];
    if (message.role !== 'assistant') return ready;
    if (message.partial) {
      for (const action of message.actions || []) if (action.kind === 'slack-reaction') {
        const id = `reaction-${digest([key, action.actionId])}`;
        if (this.store.data.reactionOutbox?.[id]?.status === 'pending') await this.store.update(state => {
          if (state.reactionOutbox[id].status === 'pending') state.reactionOutbox[id].status = 'superseded';
        });
      }
      return ready;
    }
    const binding = this.store.data.threads[key];
    for (const action of message.actions || []) {
      if (action.kind !== 'slack-reaction') continue;
      const actor = action.actor, input = this.store.data.reactionInputs?.[action.requestId];
      const original = input && this.store.data.inbox[input.inboxId];
      const event = original?.projectResume?.event || original?.envelope?.body?.event;
      const source = messages.find(item => item.role === 'user' && item.requestId === action.requestId);
      if (!action.actionId || !(read ? action.emoji === 'eyes' : slackReactionEmojis.includes(action.emoji)) || action.status !== 'intent' ||
          message.source !== 'slack' || message.requestId !== action.requestId || source?.source !== 'slack' ||
          actor?.kind !== 'human' || actor.integration !== 'slack' || actor.teamId !== this.teamId ||
          actor.sessionId !== `slack:${this.teamId}:${actor.userId}` || source.actor?.userId !== actor.userId ||
          source.actor?.teamId !== this.teamId || source.actor?.kind !== 'human' || source.actor?.integration !== 'slack' ||
          source.actor?.sessionId !== actor.sessionId || message.actor?.sessionId !== actor.sessionId ||
          !input || input.key !== key || input.projectId !== binding.projectId || input.conversationId !== binding.conversationId ||
          !binding.ownRequests?.includes(action.requestId) || input.userId !== actor.userId || !isMessage(event) ||
          event.user !== actor.userId || event.channel !== binding.channel || input.channel !== binding.channel || event.ts !== input.timestamp ||
          !/^\d+\.\d+$/.test(event.ts || '') || original.envelope?.body?.team_id !== this.teamId ||
          reactionEventHash(event) !== input.eventHash) continue;
      const id = `reaction-${digest([key, read ? `read:${action.actionId}` : action.actionId])}`;
      const target = { key, requestId: action.requestId, projectId: binding.projectId, conversationId: binding.conversationId,
        channel: input.channel, timestamp: input.timestamp, userId: input.userId, emoji: action.emoji };
      await this.store.update(state => {
        const previous = (state.reactionOutbox ||= {})[id], fingerprint = digest(target);
        if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error('Reaction intent changed'), { code: 'ID_REUSED' });
        state.reactionOutbox[id] ||= { ...target, fingerprint, status: 'pending', attempts: 0, next: 0 };
      });
      ready.push(id);
    }
    return ready;
  }
  async queueReadReactions(key, state, { completed = false, requestIds = state.participationRequestIds } = {}) {
    if (!Array.isArray(requestIds) || requestIds.length > 20) return [];
    const ready = [], messages = state.messages || [];
    const desired = state.status === 'error' ? 'failed' : state.status === 'interrupted' ? 'stopped' :
      completed && state.participationDecision === 'reply' ? 'completed' : state.participationDecision;
    if (!['reply', 'completed', 'silent', 'failed', 'stopped'].includes(desired)) return ready;
    const binding = this.store.data.threads[key];
    for (const requestId of new Set(requestIds)) {
      if (!state.acceptedRequestIds?.includes(requestId)) continue;
      const source = messages.find(message => message.role === 'user' && message.requestId === requestId);
      const input = this.store.data.reactionInputs?.[requestId], actor = source?.actor;
      if (!binding || source?.source !== 'slack' || actor?.kind !== 'human' || actor.integration !== 'slack' || actor.teamId !== this.teamId ||
          actor.sessionId !== `slack:${this.teamId}:${actor.userId}` || !binding.ownRequests?.includes(requestId) ||
          !input || input.key !== key || input.projectId !== binding.projectId || input.conversationId !== binding.conversationId ||
          input.userId !== actor.userId || input.channel !== binding.channel || !this.feedback.valid(input.inboxId) ||
          this.store.data.feedback[input.inboxId].timestamp !== input.timestamp || this.store.data.feedback[input.inboxId].userId !== actor.userId ||
          this.store.data.feedback[input.inboxId].eventHash !== input.eventHash) continue;
      await this.feedback.decide(input.inboxId, desired, { requestId, inputRevision: state.inputRevision, controlRevision: state.controlRevision });
    }
    this.feedback.drain();
    return ready;
  }
  drainReactions(ready = new Set()) {
    if (this.stopped) return;
    for (const [id, record] of Object.entries(this.store.data.reactionOutbox || {})) {
      if (this.reactions.size >= 8) break;
      if (this.reactionActions.has(id) || !['pending', 'sending', 'unknown'].includes(record.status) || record.next > Date.now()) continue;
      // A never-started intent needs this cycle's fresh public state. Bootstrap
      // and saturation must not race ahead of a saved superseded generation.
      if (record.status === 'pending' && !ready.has(id)) continue;
      const binding = this.store.data.threads[record.key];
      if (!binding || binding.projectId !== record.projectId || binding.conversationId !== record.conversationId || binding.channel !== record.channel) continue;
      this.reactionActions.add(id);
      const pending = (async () => {
        // Persist the original destination before any platform call. A crash or
        // lost acknowledgement replays only this same user/message/emoji.
        if (record.attempts >= 8) {
          await this.store.update(state => { state.reactionOutbox[id].status = 'attention'; });
          return;
        }
        await this.store.update(state => { const item = state.reactionOutbox[id]; item.status = 'sending'; item.attempts++; });
        if (this.stopped) {
          await this.store.update(state => { state.reactionOutbox[id].status = 'pending'; state.reactionOutbox[id].attempts--; });
          return;
        }
        try {
          await this.io.call('reactions.add', { channel: record.channel, timestamp: record.timestamp, name: record.emoji });
          await this.store.update(state => { state.reactionOutbox[id].status = 'sent'; });
        } catch (error) {
          const confirmed = error.code === 'slack_webapi_platform_error' && error.data?.error === 'already_reacted';
          // Platform fatal/internal errors may have applied the reaction. Only
          // precise permanent rejections and exhausted SDK 429 are non-delivery.
          const known = error.code === 'slack_webapi_rate_limited_error' || error.code === 'slack_webapi_platform_error' && reactionRejected.has(error.data?.error);
          await this.store.update(state => {
            const item = state.reactionOutbox[id];
            item.status = confirmed ? 'sent' : known ? 'failed' : item.attempts >= 8 ? 'attention' : 'unknown';
            if (!confirmed) { item.error = error.code || 'REACTION_UNCERTAIN'; item.next = Date.now() + Math.min(60000, 1000 * 2 ** item.attempts); }
          });
        }
      })().catch(error => this.logger.warn('Slack reaction retained', { code: error.code || 'REACTION_JOURNAL_ERROR' }))
        .finally(() => { this.reactions.delete(pending); this.reactionActions.delete(id); });
      this.reactions.add(pending);
    }
  }
  kick() {
    if (this.stopped) return;
    if (this.active) { this.kickRequested = true; return; }
    clearTimeout(this.timer);
    this.active = this.tick().catch(error => this.logger.error('Slack plugin cycle failed', { code: error.code || 'PLUGIN_ERROR' })).finally(() => {
      this.active = null;
      if (!this.stopped) {
        const deadlines = Object.entries(this.store.data.messageBatches || {}).filter(([id, batch]) => !batch.frozen && this.store.data.inbox[id]?.status === 'pending').map(([, batch]) => Math.max(0, batch.readyAt - Date.now()));
        const delay = this.kickRequested ? 0 : Math.min(this.pollMs, ...deadlines);
        this.kickRequested = false; this.timer = setTimeout(() => this.kick(), delay);
      }
    });
  }
  entryLane(item) {
    const event = item.projectResume?.event || item.envelope?.body?.event;
    if (!isMessage(event)) return null;
    const batch = item.batchId && this.store.data.messageBatches?.[item.batchId];
    const direct = event.channel_type === 'im' || event.channel?.startsWith('D');
    return direct ? `${event.channel}:direct:${event.user}:${batch?.projectId || this.store.data.preferences[event.user] || ''}` :
      `${event.channel}:${event.thread_ts || batch?.rootTs || event.ts}`;
  }
  async tick() {
    this.feedback.drain();
    this.drainReactions();
    const occupied = new Set(this.messageLanes.keys());
    const pending = Object.entries(this.store.data.inbox).filter(([id, item]) => {
      if (item.status !== 'pending' || this.processing.has(id)) return false;
      const batch = item.batchId && this.store.data.messageBatches?.[item.batchId];
      if (batch && (batch.ids[0] !== id || !batch.frozen && batch.readyAt > Date.now())) return false;
      const lane = this.entryLane(item);
      if (lane && occupied.has(lane)) return false;
      if (lane) occupied.add(lane);
      // A later correction must not overtake this thread's earlier BUSY retry.
      return item.next <= Date.now();
    });
    const needsClassification = entry => entry.envelope?.type === 'events_api' && indirectMessage(entry.envelope.body.event, this.botUserId);
    const runnable = id => {
      const current = this.store.data.inbox[id];
      if (!current || current.status !== 'pending' || current.next > Date.now() || this.processing.has(id)) return false;
      const lane = this.entryLane(current);
      if (!lane) return true;
      if (this.messageLanes.has(lane)) return false;
      for (const [earlierId, earlier] of Object.entries(this.store.data.inbox)) {
        if (earlierId === id) break;
        if (earlier.status === 'pending' && this.entryLane(earlier) === lane) return false;
      }
      return true;
    };
    const run = (id, entry, classifying = false) => {
      // Interactive choices can requeue an earlier request while this cycle
      // awaits another operation. Never execute a stale pending snapshot.
      if (!runnable(id)) return Promise.resolve();
      entry = this.store.data.inbox[id];
      const lane = this.entryLane(entry);
      if (lane) this.messageLanes.set(lane, id);
      if (classifying) this.classifying.add(id);
      const running = this.runEntry(id, entry).finally(() => {
        this.processing.delete(id); this.classifying.delete(id);
        if (lane && this.messageLanes.get(lane) === id) this.messageLanes.delete(lane);
        if (classifying) this.kick();
      });
      this.processing.set(id, running); return running;
    };
    // Overheard messages must not put model latency in front of explicit calls,
    // interactive actions or existing conversation mirroring.
    for (const [id, entry] of pending.filter(([, entry]) => needsClassification(entry)).slice(0, Math.max(0, 2 - this.classifying.size))) {
      if (this.stopped) return;
      run(id, entry, true);
    }
    for (const [id, entry] of pending.filter(([, entry]) => !needsClassification(entry)).slice(0, 8)) {
      if (this.stopped) return;
      await run(id, entry);
    }
    const bindings = Object.entries(this.store.data.threads);
    if (this.stopped) return;
    for (const [key, stream] of this.eventStreams) {
      const binding = this.store.data.threads[key];
      if (!binding || !(binding.live || binding.awaitingReplyId || stream.latest) || binding.conversationId !== stream.conversationId || binding.projectId !== stream.projectId) {
        stream.latest = null;
        stream.controller.abort();
        this.eventStreams.delete(key);
      }
    }
    if (!bindings.length) return;
    for (const [key, binding] of bindings) if (binding.live || binding.awaitingReplyId) this.watchEvents(key, binding);
    // Only due links consume the four-request budget. Keep live replies ahead
    // of dormant history, while reserving a slot for other due conversations.
    // Oldest due deadlines win within each group; a completed poll advances its
    // deadline, so sustained activity cannot starve another due thread.
    const due = bindings.filter(([key, binding]) => {
      const stream = this.eventStreams.get(key);
      return (binding.nextPoll || 0) <= Date.now() && (!stream?.lastEventAt || stream.latest || Date.now() - stream.lastFallbackAt >= 15000);
    })
      .sort(([, a], [, b]) => (a.nextPoll || 0) - (b.nextPoll || 0));
    const hot = due.filter(([, binding]) => binding.awaitingReplyId || binding.live);
    const idle = due.filter(([, binding]) => !binding.awaitingReplyId && !binding.live);
    const selected = hot.slice(0, idle.length ? 3 : 4);
    selected.push(...idle.slice(0, 4 - selected.length));
    for (const [key] of selected) {
      if (this.stopped) return;
      try { await this.mirror(key); }
      catch (error) { this.logger.warn('Slack mirror failed', { code: error.code || 'MIRROR_ERROR' }); await this.store.update(state => { state.threads[key].nextPoll = Date.now() + 30000; state.threads[key].error = error.code || 'MIRROR_ERROR'; }); }
    }
  }
  watchEvents(key, binding) {
    if (this.stopped || typeof this.gateway.events !== 'function' || this.eventStreams.has(key) || this.eventStreams.size >= 4 || (this.eventRetry.get(key) || 0) > Date.now()) return;
    const stream = { controller: new AbortController(), projectId: binding.projectId, conversationId: binding.conversationId, lastFallbackAt: Date.now(), latest: null };
    this.eventStreams.set(key, stream);
    stream.promise = (async () => {
      try {
        for await (const state of this.gateway.events({ userId: binding.userId, projectId: stream.projectId, conversationId: stream.conversationId, signal: stream.controller.signal })) {
          const current = this.store.data.threads[key];
          if (this.stopped || stream.controller.signal.aborted || current?.projectId !== stream.projectId || current?.conversationId !== stream.conversationId) break;
          if (state?.conversationId !== stream.conversationId) throw Object.assign(new Error('Event scope mismatch'), { code: 'GATEWAY_EVENT_INVALID' });
          stream.latest = state; stream.lastEventAt = Date.now();
          await this.store.update(data => {
            const thread = data.threads[key];
            if (thread?.projectId === stream.projectId && thread?.conversationId === stream.conversationId) thread.nextPoll = 0;
          });
          this.kick();
        }
      } catch (error) {
        if (!stream.controller.signal.aborted && !this.stopped) this.logger.warn('Slack event stream failed; polling retained', { code: error.code || 'GATEWAY_STREAM' });
      } finally {
        if (this.eventStreams.get(key) === stream) this.eventStreams.delete(key);
        if (!stream.controller.signal.aborted) this.eventRetry.set(key, Date.now() + 30000);
        if (!this.stopped) this.kick();
      }
    })();
    this.eventTasks.add(stream.promise);
    const released = () => this.eventTasks.delete(stream.promise);
    stream.promise.then(released, released);
  }
  async runEntry(id, entry) {
    let members = [id];
    try {
      let batch = entry.batchId && this.store.data.messageBatches?.[entry.batchId];
      if (batch) {
        batch = await this.store.update(state => { const current = state.messageBatches[entry.batchId]; current.frozen = true; return structuredClone(current); });
        members = [...batch.ids];
        const events = members.map(inputId => this.store.data.inbox[inputId].projectResume?.event || this.store.data.inbox[inputId].envelope.body.event)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
        const resumed = this.store.data.inbox[id].projectResume;
        await this.message(id, { ...events[0], ...(batch.rootTs !== events[0].ts ? { thread_ts: batch.rootTs } : {}) }, resumed?.projectId || batch.projectId, events);
      } else await this.process(id, entry.envelope);
      await this.store.update(state => { for (const member of members) { state.inbox[member].status = 'done'; state.inbox[member].doneAt = Date.now(); } });
    } catch (error) {
      const classificationFailure = error.participationFailure === true;
      const event = entry.projectResume?.event || entry.envelope?.body?.event;
      // Context capture can fail before the frozen snapshot exists. An ordinary
      // message still has no permission to publish an error into its thread.
      const mergedFailure = !!this.store.data.inbox[id]?.participation || isMessage(event) && !event.ts?.startsWith('command-');
      const deliveryTransient = ['DELIVERY_UNCERTAIN', 'SLACK_UPLOAD_UNAVAILABLE', 'slack_webapi_http_error',
        'slack_webapi_rate_limited_error', 'slack_webapi_request_error'].includes(error.code);
      const transient = error.historyTransient === true || (classificationFailure ? participationTransient(error) : mergedFailure
        ? participationTransient(error) || deliveryTransient :
        ['BUSY', 'COORDINATOR_BUSY', 'GATEWAY_ERROR', 'DELIVERY_UNCERTAIN', 'SLACK_UPLOAD_UNAVAILABLE', 'slack_webapi_http_error', 'slack_webapi_rate_limited_error', 'slack_webapi_request_error'].includes(error.code) || error.name === 'TimeoutError' || error instanceof TypeError || error.modelSelectionUncertain === true);
      const retryAfter = Number(error.retryAfter ?? error.data?.retry_after ?? 0);
      const validDelay = Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 86400;
      await this.store.update(state => {
        for (const member of members) {
          const item = state.inbox[member]; item.attempts++; item.error = error.code || 'PLUGIN_ERROR';
          if (classificationFailure) item.relevanceAttempts = (item.relevanceAttempts || 0) + 1;
          item.status = transient && validDelay && (classificationFailure ? item.relevanceAttempts < 3 : item.attempts < 8) ? 'pending' : 'attention';
          item.next = Date.now() + Math.max(Math.min(60000, 1000 * 2 ** item.attempts), validDelay ? retryAfter * 1000 : 0);
        }
      });
      this.logger.warn('Slack operation failed', { id: digest(id).slice(0, 12), code: error.code || 'PLUGIN_ERROR' });
      for (const member of members) {
        const feedback = this.store.data.feedback?.[member];
        if (this.store.data.inbox[member]?.status === 'attention' && this.feedback.valid(member)) {
          await this.feedback.decide(member, 'failed', { inputRevision: Math.max(0, feedback.inputRevision), controlRevision: Math.max(0, feedback.controlRevision) });
        }
      }
      this.feedback.drain();
      if (this.store.data.inbox[id]?.status === 'attention' && this.feedback.valid(id) && !error.silent) {
        await this.io.post({ id: operationId(id, 'intake-failed'), channel: event.channel, threadTs: event.thread_ts || event.ts,
          text: 'Coordinator 暂时无法处理这条消息，请稍后重试。原消息仍保留。' }).catch(() => {});
      }
      if (!transient && !error.silent && !mergedFailure) await this.reportError(id, entry.envelope.body, error).catch(() => {});
    }
  }
  async command(type, binding, userId, id, payload = {}) { return this.gateway.command(type, { ...contextFrom(binding, userId, id), payload }); }
  async process(id, { type, body }) {
    const resumed = this.store.data.inbox[id]?.projectResume;
    if (resumed) return this.store.data.inbox[id]?.modelMenuIntent
      ? this.showModelMenu(id, resumed.event, resumed.projectId) : this.message(id, resumed.event, resumed.projectId);
    const userId = body.user?.id || body.user_id || body.event?.user;
    if (type === 'events_api') {
      if (body.event?.type === 'app_home_opened') return this.publishHome(userId, id);
      if (body.event?.type === 'link_shared') return this.unfurl(id, body.event);
      if (isMessage(body.event) && body.event.user !== this.botUserId) return this.message(id, body.event, this.store.data.inbox[id]?.requestedProjectId || null);
      return;
    }
    if (type === 'slash_commands') {
      if (body.command !== '/cg') return;
      if (body.text?.trim() === 'model') {
        const event = { type: 'app_mention', channel: body.channel_id, user: userId, ts: `command-${digest(id).slice(0, 12)}`, text: '/cg model' };
        await this.store.update(state => { state.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 }; state.inbox[id].modelMenuIntent = true; });
        return this.showModelMenu(id, event);
      }
      if (/^stop(?:\s|$)/.test(body.text?.trim() || '')) return this.stopChat(id, body, userId);
      if (/^resume(?:\s|$)/.test(body.text?.trim() || '')) return this.resumeChat(id, body, userId);
      const projectId = this.store.data.channels[body.channel_id] || this.store.data.preferences[userId];
      const binding = { channel: body.channel_id, threadTs: null, projectId };
      if (body.text?.trim().startsWith('ask ')) return this.message(id, { type: 'app_mention', user: userId, channel: body.channel_id, ts: `command-${digest(id).slice(0, 12)}`, text: body.text.trim().slice(4) });
      return this.startChat(id, body, userId, { projectId, text: body.text?.trim() || '你好，我想和你讨论项目。' });
    }
    if (type !== 'interactive') return;
    if (body.type === 'view_submission') return this.submitForm(id, body, userId);
    if (body.type === 'shortcut' || body.type === 'message_action') {
      const originalThread = body.channel?.id && (body.message?.thread_ts || body.message?.ts);
      const prior = originalThread && this.store.data.threads[threadKey(this.teamId, body.channel.id, originalThread)];
      const projectId = prior?.projectId || this.store.data.channels[body.channel?.id] || this.store.data.preferences[userId];
      return this.startChat(id, body, userId, { projectId, kind: body.callback_id?.startsWith('cg_bug') ? 'bug' : 'todo', initialText: body.message?.text || '' });
    }
    for (const action of body.actions || []) {
      if (action.action_id === 'form_project') { await this.selectFormProject(id, body, userId, action.selected_option?.value); continue; }
      if (action.action_id === 'select_project') {
        const projectId = action.selected_option?.value;
        const projects = await this.loadProjects(userId, id);
        if (!projects.some(project => project.id === projectId)) throw Object.assign(new Error('项目已删除或停止开放，请重新选择'), { code: 'NOT_FOUND' });
        await this.store.update(state => { state.preferences[userId] = projectId; });
        await this.publishHome(userId, id); continue;
      }
      if (action.action_id === 'connect_project_menu') {
        const requestId = action.block_id?.startsWith('projects:') ? action.block_id.slice('projects:'.length) : '';
        await this.connectProject(id, body, userId, { requestId, projectId: action.selected_option?.value }, { dynamic: true }); continue;
      }
      let value; try { value = JSON.parse(action.value || '{}'); } catch { throw new Error('Invalid interaction'); }
      if (action.action_id === 'model_open') await this.openModelMenu(id, body, userId, value);
      else if (/^model_select:\d{1,2}$/.test(action.action_id)) await this.selectModelMenu(id, body, userId, value);
      else if (/^connect_project:\d{1,3}$/.test(action.action_id)) await this.connectProject(id, body, userId, value);
      else if (['open_item', 'open_item:todo', 'open_item:bug', 'start_chat'].includes(action.action_id)) await this.startChat(id, body, userId, value);
      else if (action.action_id === 'open_memory') await this.startChat(id, body, userId, { ...value, kind: 'memory' });
      else if (action.action_id === 'open_binding') await this.startChat(id, body, userId, { ...value, text: '你好，我想和你讨论项目。' });
      else if (action.action_id === 'open_answer') {
        const binding = this.store.data.threads[value.key];
        if (binding) await this.io.post({ id: operationId(id, 'answer-guide'), channel: binding.channel, threadTs: binding.threadTs, text: '直接在这个线程回复你的想法即可，不需要填写表单。' });
      }
      else if (action.action_id === 'reject_brief') await this.review(id, userId, value, 'rejected', '用户要求继续讨论并修改 brief');
      else if (action.action_id === 'answer_question') await this.answer(id, userId, value);
      else if (action.action_id === 'approve_brief') await this.review(id, userId, value, 'approved', '用户在 Slack 中确认 brief');
      else if (action.action_id === 'approve_binding') await this.reviewBinding(id, userId, value, 'approved');
      else if (action.action_id === 'reject_binding') await this.reviewBinding(id, userId, value, 'rejected');
      else if (action.action_id === 'export_prompt') await this.exportPrompt(id, userId, value);
    }
  }
  async loadProjects(userId, id, timeoutMs = 20000) { const result = await this.gateway.command('project.list', { id: operationId(id, 'projects'), userId, timeoutMs }); this.projects.set(userId, result.projects || []); return result.projects || []; }
  async suggestProjects(body, id) {
    if (!['select_project', 'connect_project_menu'].includes(body.action_id)) return [];
    const userId = body.user?.id;
    if (body.action_id === 'connect_project_menu') {
      const requestId = body.block_id?.startsWith('projects:') ? body.block_id.slice('projects:'.length) : '';
      const original = this.store.data.inbox[requestId];
      if (!original || original.projectPromptEvent?.user !== userId || body.channel?.id !== original.projectPromptEvent.channel ||
          body.message?.ts !== original.projectPromptTs || original.projectResume) return [];
    }
    const projects = await this.loadProjects(userId, id, 2000);
    return projectOptions(body.view?.type === 'home' || body.channel?.id?.startsWith('D') ? projects : projects.filter(project => !project.private), body.value || '');
  }
  validModelCatalog(value) {
    if (!value || !/^[a-f0-9]{64}$/.test(value.version || '') || !Array.isArray(value.options) || !value.options.length || value.options.length > 20 ||
        value.options.some(option => !/^[a-zA-Z0-9_-]{1,128}$/.test(option.id || '') || typeof option.label !== 'string' || !option.label || typeof option.model !== 'string') ||
        new Set(value.options.map(option => option.id)).size !== value.options.length || !value.options.some(option => option.id === value.selectedId)) {
      throw Object.assign(new Error('已配置模型目录暂不可用'), { code: 'GATEWAY_BAD_RESPONSE' });
    }
    const route = value.currentRoute;
    if (route && (!['text', 'vision'].includes(route.kind) || route.model !== null && (typeof route.model !== 'string' || route.model.length > 2048) ||
        route.providerId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(route.providerId))) {
      throw Object.assign(new Error('当前模型路由暂不可用'), { code: 'GATEWAY_BAD_RESPONSE' });
    }
    return { version: value.version, selectedId: value.selectedId, options: value.options.map(({ id, label, model }) => ({ id, label, model })),
      ...(route ? { currentRoute: { kind: route.kind, model: route.model, ...(route.providerId ? { providerId: route.providerId } : {}) } } : {}) };
  }
  async saveModelMenu(id, catalog, context) {
    await this.store.update(state => {
      state.modelMenus ||= {};
      state.modelMenus[id] ||= { id, ...context, ...this.validModelCatalog(catalog), status: 'open' };
    });
    return this.store.data.modelMenus[id];
  }
  async showModelMenu(id, event, expectedProjectId = null) {
    const direct = event.channel?.startsWith('D'), projectId = expectedProjectId || (direct ? this.store.data.preferences[event.user] : this.store.data.channels[event.channel]);
    if (!projectId) return this.chooseProject(id, event);
    const menuId = `model-menu-${digest(id)}`;
    let menu = this.store.data.modelMenus?.[menuId];
    if (!menu) {
      const catalog = await this.gateway.command('models.state', { id: operationId(id, 'models'), userId: event.user, projectId });
      menu = await this.saveModelMenu(menuId, catalog, { projectId, userId: event.user, channel: event.channel,
        threadTs: event.ts?.startsWith('command-') ? undefined : event.thread_ts || event.ts });
    }
    if (menu.projectId !== projectId || menu.userId !== event.user || menu.channel !== event.channel) throw Object.assign(new Error('模型菜单所属项目已改变'), { code: 'CONFLICT' });
    const ts = await this.io.post({ id: operationId(menuId, 'card'), channel: menu.channel, threadTs: menu.threadTs,
      text: '项目默认文字模型', blocks: modelChoiceBlocks(menu) });
    await this.store.update(state => { state.modelMenus[menuId].ts = ts; });
  }
  async selectModelMenu(id, body, userId, value) {
    const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
    if (!value || Object.keys(value).some(key => !['menuId', 'providerId'].includes(key))) throw conflict('模型选择卡已失效');
    let menu = this.store.data.modelMenus?.[value.menuId];
    if (!menu || menu.userId !== userId || menu.channel !== body.channel?.id) throw Object.assign(new Error('只能确认自己在原项目打开的模型菜单'), { code: 'FORBIDDEN' });
    if (!menu.ts) throw Object.assign(new Error('模型菜单仍在发送，请等待原消息确认'), { code: 'BUSY' });
    if (body.message?.ts !== menu.ts) throw conflict('请在原模型选择卡确认');
    const currentProject = menu.key ? this.store.data.threads[menu.key]?.projectId : menu.channel.startsWith('D') ? this.store.data.preferences[userId] : this.store.data.channels[menu.channel];
    if (currentProject !== menu.projectId) throw conflict('当前项目关联已改变，请重新打开模型菜单');
    if (!menu.options.some(option => option.id === value.providerId)) throw Object.assign(new Error('只能选择已配置模型'), { code: 'INVALID_ARGUMENT' });
    // An unknown earlier write must replay its original receipt before a current
    // selection can be called a no-op. Only a genuinely new choice may read it.
    if (!menu.selection && value.providerId === menu.selectedId) {
      const current = this.validModelCatalog(await this.gateway.command('models.state', { id: operationId(id, 'current-model'), userId, projectId: menu.projectId }));
      if (current.version !== menu.version) return this.refreshModelMenu(menu, userId, current);
      await this.store.update(state => { Object.assign(state.modelMenus[menu.id], current, { status: 'unchanged' }); });
      return this.io.update(menu.channel, menu.ts, '当前模型未改变。', modelChoiceBlocks(this.store.data.modelMenus[menu.id]));
    }
    await this.store.update(state => {
      const current = state.modelMenus[menu.id];
      if (current.selection && current.selection.providerId !== value.providerId) throw conflict('原模型选择尚需核对，请勿替换原操作');
      current.selection ||= { id: operationId(`${menu.id}:${userId}:${value.providerId}`, 'model-select'), providerId: value.providerId, baseVersion: menu.version };
    });
    menu = this.store.data.modelMenus[menu.id];
    let result;
    try {
      result = this.validModelCatalog(await this.gateway.command('models.select', { id: menu.selection.id, userId, projectId: menu.projectId,
        payload: { providerId: menu.selection.providerId, baseVersion: menu.selection.baseVersion } }));
    } catch (error) {
      if (error.code !== 'VERSION_CONFLICT') {
        error.modelSelectionUncertain = !['INVALID_ARGUMENT', 'ID_REUSED', 'INVALID_COORDINATOR_CONFIG', 'MODEL_SETTINGS_UNAVAILABLE'].includes(error.code) && participationTransient(error);
        if (!error.modelSelectionUncertain) await this.store.update(state => { state.modelMenus[menu.id].error = error.code || 'MODEL_SELECTION_FAILED'; });
        throw error;
      }
      return this.refreshModelMenu(menu, userId, await this.gateway.command('models.state', { id: operationId(menu.id, 'refresh'), userId, projectId: menu.projectId }));
    }
    await this.store.update(state => { Object.assign(state.modelMenus[menu.id], result, { status: 'applied' }); });
    await this.io.update(menu.channel, menu.ts, '原模型选择已确认（历史回执），不代表当前项目默认。可打开自己的模型菜单查看当前设置。', modelChoiceBlocks(this.store.data.modelMenus[menu.id]));
  }
  async openModelMenu(id, body, userId, value) {
    const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
    if (!value || Object.keys(value).some(key => key !== 'menuId') || !/^model-menu-[a-f0-9]{64}$/.test(value.menuId || '') ||
        !/^[UW][A-Z0-9]{1,31}$/.test(userId || '')) throw conflict('模型菜单入口已失效');
    const original = this.store.data.modelMenus?.[value.menuId];
    if (!original || original.channel !== body.channel?.id || !original.ts || body.message?.ts !== original.ts) throw conflict('请在原模型卡打开菜单');
    const thread = body.message?.thread_ts;
    if (original.threadTs ? thread !== original.threadTs : thread && thread !== original.ts) throw conflict('模型菜单线程已改变');
    const binding = original.key && this.store.data.threads[original.key];
    if (original.key && (!binding || original.key !== threadKey(this.teamId, original.channel, original.threadTs) ||
        binding.channel !== original.channel || binding.threadTs !== original.threadTs)) throw conflict('模型菜单线程关联已改变');
    const projectId = binding ? binding.projectId : original.channel.startsWith('D') ? this.store.data.preferences[userId] : this.store.data.channels[original.channel];
    if (projectId !== original.projectId) throw conflict('当前项目关联已改变');
    // Opening is read-only. The original uncertain selection remains owned by
    // its saved operation and Inbox recovery, never by a different clicker.
    if (original.selection && original.status !== 'applied' && !original.error) throw Object.assign(new Error('请等待原模型选择结果核对'), { code: 'BUSY' });
    const menuId = `model-menu-${digest([id, original.id, userId])}`;
    let menu = this.store.data.modelMenus?.[menuId];
    if (!menu) {
      const catalog = await this.gateway.command('models.state', { id: operationId(id, 'open-models'), userId, projectId });
      menu = await this.saveModelMenu(menuId, catalog, { userId, projectId, channel: original.channel,
        threadTs: original.threadTs || original.ts, ...(original.key ? { key: original.key } : {}) });
    }
    if (menu.userId !== userId || menu.projectId !== projectId || menu.channel !== original.channel ||
        menu.threadTs !== (original.threadTs || original.ts)) throw conflict('模型菜单所属项目已改变');
    if (menu.ts) return;
    const ts = await this.io.post({ id: operationId(menuId, 'card'), channel: menu.channel, threadTs: menu.threadTs,
      text: '项目默认文字模型', blocks: modelChoiceBlocks(menu) });
    await this.store.update(state => { state.modelMenus[menuId].ts = ts; });
  }
  async refreshModelMenu(menu, userId, catalog) {
    await this.store.update(state => { state.modelMenus[menu.id].error = 'VERSION_CONFLICT'; });
    const refreshed = await this.saveModelMenu(`model-menu-${digest([menu.id, catalog.version])}`, catalog, {
      userId, projectId: menu.projectId, channel: menu.channel, threadTs: menu.threadTs, ...(menu.key ? { key: menu.key } : {}),
      ...(menu.currentRoute ? { currentRoute: menu.currentRoute } : {}) });
    const ts = await this.io.post({ id: operationId(refreshed.id, 'card'), channel: menu.channel, threadTs: menu.threadTs,
      text: '模型设置已改变，请按当前目录重新选择。', blocks: modelChoiceBlocks(refreshed) });
    await this.store.update(state => { state.modelMenus[refreshed.id].ts = ts; });
  }
  async naturalModelMenus(key, message, userId) {
    const binding = this.store.data.threads[key], menus = [];
    for (const action of message.actions || []) if (action.kind === 'model-selection') {
      const id = `model-menu-${digest([key, message.id || digest(message), action.actionId])}`;
      menus.push(await this.saveModelMenu(id, action, { key, userId, projectId: binding.projectId, channel: binding.channel, threadTs: binding.threadTs }));
    }
    return menus;
  }
  async startChat(id, body, userId, context = {}) {
    let channel = body.channel?.id || body.channel_id;
    if (!channel) channel = (await this.io.call('conversations.open', { users: userId })).channel?.id;
    if (!/^[CGD][A-Z0-9]{6,}$/.test(channel || '')) throw new Error('无法打开对话，请直接私聊 Coordinator');
    const direct = channel.startsWith('D');
    const sourceThread = body.message?.thread_ts || body.message?.ts;
    const prior = sourceThread && this.store.data.threads[threadKey(this.teamId, channel, sourceThread)];
    if (prior && context.projectId && context.projectId !== prior.projectId) throw Object.assign(new Error('原线程不能切换项目'), { code: 'CONFLICT' });
    const projectId = prior?.projectId || context.projectId || (direct ? this.store.data.preferences[userId] : this.store.data.channels[channel]);
    if (projectId) {
      const projects = await this.loadProjects(userId, id);
      const selected = projects.find(project => project.id === projectId);
      if (!selected || selected.private && !direct) throw Object.assign(new Error('此项目无法在该频道访问，请在私聊重新选择'), { code: 'FORBIDDEN' });
      await this.store.update(state => {
        if (prior) return;
        if (!direct && state.channels[channel] && state.channels[channel] !== projectId) throw Object.assign(new Error('频道已关联另一个项目'), { code: 'CONFLICT' });
        if (direct) state.preferences[userId] = projectId;
        else state.channels[channel] ||= projectId;
      });
    }
    let text = context.text || (context.kind === 'memory' ? '我想和你讨论修改项目记忆。' : context.kind === 'bug' ? '我想和你讨论一个 Bug。' : '我想和你讨论一条 TODO。');
    if (context.nodeId || context.itemId) text += `\n当前事项定位：${context.nodeId || ''} / ${context.itemId || ''}。请先从 Map 核对内容。`;
    if (context.initialText) text += `\n我选中的消息是：\n${context.initialText}`;
    const requestId = `chat-${digest(id)}`, event = { type: 'app_mention', user: userId, channel, ts: `command-${digest(id).slice(0, 12)}`, text,
      ...(prior ? { thread_ts: sourceThread } : {}), ...(direct ? { channel_type: 'im' } : {}), ...(body.message?.files?.length ? { files: body.message.files } : {}) };
    await this.store.update(state => {
      state.inbox[requestId] ||= { envelope: { type: 'events_api', body: { team_id: this.teamId, event } },
        ...(projectId ? { requestedProjectId: projectId } : {}), status: 'pending', attempts: 0, at: Date.now(), next: 0 };
    });
    this.kick();
  }
  async readProject(projectId, userId, id) { const result = await this.gateway.command('project.read', { id: operationId(id, 'read'), userId, projectId }); this.maps.set(projectId, result); return result; }
  async publishHome(userId, id) {
    const projects = await this.loadProjects(userId, id), projectId = this.store.data.preferences[userId];
    const project = projectId && projects.some(item => item.id === projectId) ? await this.readProject(projectId, userId, id) : null;
    return this.io.call('views.publish', { user_id: userId, view: homeView({ projects, project, cloudOrigin: this.cloudOrigin, userId }) });
  }
  async chooseProject(id, event) {
    const direct = event.channel_type === 'im' || event.channel?.startsWith('D');
    const available = await this.loadProjects(event.user, id), projects = direct ? available : available.filter(project => !project.private);
    await this.store.update(state => {
      state.inbox[id] ||= { status: 'done', attempts: 0, at: Date.now(), next: 0 };
      state.inbox[id].envelope ||= { type: 'events_api', body: { team_id: this.teamId, event: structuredClone(event) } };
      state.inbox[id].projectPromptEvent ||= structuredClone(event);
      state.inbox[id].projectPromptProjects ||= projects.map(project => project.id);
      state.inbox[id].projectPromptChoices ||= projects.map(project => ({ id: project.id, name: project.name || project.id }));
    });
    const choices = this.store.data.inbox[id].projectPromptChoices;
    const ts = await this.io.post({ id: operationId(id, 'choose'), channel: event.channel,
      threadTs: event.ts?.startsWith('command-') ? undefined : event.thread_ts || event.ts,
      text: choices.length ? '请选择要讨论的项目，选好后我会继续处理刚才的问题。' : '目前没有开放的项目；新建或授权后，打开下方菜单重新查询。私有项目请在 Coordinator 私聊中选择。',
      blocks: projectChoiceBlocks(choices, id, direct) });
    await this.store.update(state => { state.inbox[id].projectPromptTs = ts; });
  }
  async connectProject(id, body, userId, value, { dynamic = false } = {}) {
    const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' });
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['requestId', 'projectId'].includes(key))) throw conflict('项目选择已失效，请重新提问');
    const entry = this.store.data.inbox[value.requestId], event = entry?.projectPromptEvent;
    if (!event || event.user !== userId || body.channel?.id !== event.channel || body.message?.ts !== entry.projectPromptTs) throw conflict('请由原提问者在原消息中选择项目');
    if (!dynamic && !entry.projectPromptProjects?.includes(value.projectId)) throw conflict('项目不在这条消息的选项中');
    const resumedEvent = event.ts?.startsWith('command-') ? { ...event, ts: entry.projectPromptTs } : event;
    const lane = messageLane(null, resumedEvent);
    if (this.messageLanes.has(lane)) throw Object.assign(new Error('正在处理这条线程，请保留原请求重试'), { code: 'BUSY' });
    this.messageLanes.set(lane, id);
    try {
      const projects = await this.loadProjects(userId, id), selected = projects.find(project => project.id === value.projectId);
      if (!selected) throw conflict('该项目已停止开放，请重新选择');
      const direct = event.channel_type === 'im' || event.channel?.startsWith('D');
      if (selected.private && !direct) throw conflict('私有 Map 项目请在 Coordinator 私聊中选择');
      const info = await this.io.call('conversations.info', { channel: event.channel });
      if (direct ? info.channel?.user !== userId : !(await this.channelMembers(event.channel)).includes(userId)) throw conflict('只能关联自己所在的频道或自己的私聊');
      await this.store.update(state => {
        const original = state.inbox[value.requestId], current = direct ? state.preferences[userId] : state.channels[event.channel];
        if (original.selectedProjectId && original.selectedProjectId !== value.projectId || current && current !== value.projectId) throw conflict('关联已改变，请重新提问；旧选项不会覆盖当前项目');
        original.selectedProjectId = value.projectId;
        if (direct) state.preferences[userId] = value.projectId;
        else {
          state.channels[event.channel] = value.projectId;
          state.preferences[userId] ||= value.projectId;
        }
        // Requeue the original request through the normal durable FIFO lane.
        // A repeated click cannot reset its backoff or execute it a second time.
        if (!original.projectResume) {
          original.projectResume = { event: structuredClone(resumedEvent), projectId: value.projectId };
          original.status = 'pending'; original.next = 0; delete original.doneAt;
        }
      });
      await this.io.update(event.channel, entry.projectPromptTs, `已关联 ${selected.name || selected.id}，接下来继续处理刚才的问题。`,
        [{ type: 'section', text: plain(`已关联 ${selected.name || selected.id}。刚才的问题已排入当前线程，回复会出现在这里。`, 2900) }]);
      await this.publishHome(userId, id);
    } finally {
      if (this.messageLanes.get(lane) === id) this.messageLanes.delete(lane);
      this.kick();
    }
  }
  routedThreadKey(event) {
    let key = threadKey(this.teamId, event.channel, event.thread_ts || event.ts);
    if (!event.channel?.startsWith('D')) return key;
    const visited = new Set();
    for (;;) {
      if (visited.has(key)) throw Object.assign(new Error('项目切换路径出现循环'), { code: 'CONFLICT' });
      visited.add(key);
      const route = this.store.data.projectRoutes?.[digest([key, event.user])];
      if (!route || Number(event.ts) <= Number(route.afterTs)) return key;
      const target = this.store.data.threads[route.targetKey];
      if (!target || target.channel !== event.channel || target.userId !== event.user) throw Object.assign(new Error('项目切换记录与私聊不一致'), { code: 'CONFLICT' });
      key = route.targetKey;
    }
  }
  async applyProjectSwitch(key, message, messages, snapshot) {
    const action = message.actions?.find(action => action.kind === 'project-switch');
    if (!action || message.role !== 'assistant' || message.partial || snapshot.activeTurnId || snapshot.pendingInputCount ||
        !['waiting-for-user', 'idle'].includes(snapshot.status)) return null;
    const binding = this.store.data.threads[key], actor = action.actor;
    const input = this.store.data.reactionInputs?.[action.requestId], original = input && this.store.data.inbox[input.inboxId];
    const event = original?.projectResume?.event || original?.envelope?.body?.event;
    const source = messages.find(item => item.role === 'user' && item.requestId === action.requestId);
    if (!binding?.channel.startsWith('D') || actor?.channelId !== binding.channel || actor.kind !== 'human' || actor.integration !== 'slack' ||
        actor.teamId !== this.teamId || actor.sessionId !== `slack:${this.teamId}:${actor.userId}` ||
        message.source !== 'slack' || message.requestId !== action.requestId || message.actor?.sessionId !== actor.sessionId ||
        source?.source !== 'slack' || source.actor?.sessionId !== actor.sessionId || source.actor?.channelId !== binding.channel ||
        action.sourceProjectId !== binding.projectId || action.sourceConversationId !== binding.conversationId ||
        !input || input.key !== key || input.projectId !== binding.projectId || input.conversationId !== binding.conversationId ||
        input.userId !== actor.userId || input.channel !== binding.channel || !binding.ownRequests?.includes(action.requestId) ||
        !isMessage(event) || event.user !== actor.userId || event.channel !== binding.channel || event.ts !== input.timestamp ||
        !/^\d+\.\d+$/.test(event.ts || '') || original.envelope?.body?.team_id !== this.teamId || reactionEventHash(event) !== input.eventHash ||
        action.status !== 'pending' || !action.actionId || !action.projectId || !action.conversationId) {
      return { status: 'rejected', error: 'UNVERIFIED_INPUT' };
    }
    const id = `project-switch-${digest([key, action.actionId])}`, fingerprint = digest(action);
    let record = this.store.data.projectSwitches?.[id];
    if (record && record.fingerprint !== fingerprint) throw Object.assign(new Error('项目切换回执内容改变'), { code: 'ID_REUSED' });
    if (!record) {
      await this.store.update(state => {
        state.projectSwitches ||= {};
        state.projectSwitches[id] ||= { id, fingerprint, status: 'pending', expectedPreference: state.preferences[actor.userId], action };
      });
      record = this.store.data.projectSwitches[id];
    }
    if (record.status !== 'pending') return record;
    try {
      if (this.store.data.preferences[actor.userId] !== record.expectedPreference || record.expectedPreference !== binding.projectId) {
        throw Object.assign(new Error('私聊已选择另一个项目'), { code: 'CONFLICT' });
      }
      const target = (await this.loadProjects(actor.userId, id)).find(project => project.id === action.projectId);
      if (!target) throw Object.assign(new Error('目标项目已不可用'), { code: 'NOT_FOUND' });
      const info = await this.io.call('conversations.info', { channel: binding.channel });
      if (info.channel?.user !== actor.userId) throw Object.assign(new Error('只能切换自己的私聊'), { code: 'FORBIDDEN' });
      const targetBinding = { channel: binding.channel, userId: actor.userId, projectId: target.id, conversationId: action.conversationId };
      await this.command('conversation.state', targetBinding, actor.userId, operationId(id, 'target-state'));
      const root = await this.io.post({ id: operationId(id, 'root'), channel: binding.channel, text: `${target.name || '项目'} · 项目对话` });
      const targetKey = threadKey(this.teamId, binding.channel, root);
      await this.store.update(state => {
        if (state.projectSwitches[id].status === 'applied') return;
        if (state.preferences[actor.userId] !== record.expectedPreference) throw Object.assign(new Error('切换期间项目选择改变'), { code: 'CONFLICT' });
        state.threads[targetKey] ||= { ...targetBinding, threadTs: root, mirrored: {}, cursor: null, ownRequests: [], at: Date.now(),
          projectSwitch: id, ...(target.mapNodeId ? { mapNodeId: target.mapNodeId } : {}) };
        state.projectRoutes ||= {};
        state.projectRoutes[digest([key, actor.userId])] = { targetKey, afterTs: input.timestamp, actionId: action.actionId };
        state.preferences[actor.userId] = target.id;
        state.directThreads ||= {};
        state.directThreads[digest([this.teamId, binding.channel, actor.userId, target.id])] = targetKey;
        Object.assign(state.projectSwitches[id], { status: 'applied', name: target.name, targetKey, root });
      });
      return this.store.data.projectSwitches[id];
    } catch (error) {
      if (this.store.data.projectSwitches[id]?.status === 'applied') return this.store.data.projectSwitches[id];
      if (['FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNAUTHORIZED'].includes(error.code)) {
        await this.store.update(state => { Object.assign(state.projectSwitches[id], { status: 'rejected', error: error.code }); });
        return this.store.data.projectSwitches[id];
      }
      throw error;
    }
  }
  async ensureBinding(id, event, expectedProjectId = null) {
    const rootTs = event.thread_ts || event.ts;
    let key = this.routedThreadKey(event), existing = this.store.data.threads[key];
    const direct = event.channel_type === 'im' || event.channel?.startsWith('D');
    const projectId = direct ? this.store.data.preferences[event.user] : this.store.data.channels[event.channel];
    const directKey = digest([this.teamId, event.channel, event.user, projectId]);
    if (direct && !event.thread_ts && !event.ts?.startsWith('command-')) {
      const currentKey = this.store.data.directThreads?.[directKey];
      if (currentKey && this.store.data.threads[currentKey]) { key = currentKey; existing = this.store.data.threads[key]; }
    }
    if (existing) {
      if (!direct) {
        const project = (await this.loadProjects(event.user, id)).find(project => project.id === existing.projectId);
        if (!project || project.private) throw Object.assign(new Error('此项目无法在该频道访问，请在私聊重新选择'), { code: 'FORBIDDEN' });
      }
      if (expectedProjectId && existing.projectId !== expectedProjectId) throw Object.assign(new Error('Thread project changed after the relevance decision'), { code: 'CONFLICT', silent: true });
      return [key, existing];
    }
    const explicit = explicitlyAddressed(event, this.botUserId);
    if (!direct && !explicit && !this.store.data.inbox[id]?.participation && !this.store.data.inbox[id]?.relevance?.respond) return [];
    if (expectedProjectId && projectId !== expectedProjectId) throw Object.assign(new Error('Channel project changed after the relevance decision'), { code: 'CONFLICT', silent: true });
    if (!projectId) {
      await this.chooseProject(id, event);
      return [];
    }
    const selected = (await this.loadProjects(event.user, id)).find(project => project.id === projectId);
    if (!selected || selected.private && !direct) throw Object.assign(new Error('此项目无法在该频道访问，请在私聊重新选择'), { code: 'FORBIDDEN' });
    // Slash command has no message timestamp. Create a real root message first.
    const threadTs = rootTs?.startsWith('command-') ? await this.io.post({ id: operationId(id, 'root'), channel: event.channel, text: `Coordinator · ${selected.name || '项目对话'}` }) : rootTs;
    key = threadKey(this.teamId, event.channel, threadTs);
    const created = await this.gateway.command('conversation.create', { id: operationId(id, 'create'), userId: event.user, projectId, payload: { operationId: operationId(id, 'create') } });
    const binding = await this.store.bind(key, { channel: event.channel, threadTs, projectId, conversationId: created.conversationId, userId: event.user, ownRequests: [],
      ...(created.mapNodeId ? { mapNodeId: created.mapNodeId } : {}) });
    if (direct) await this.store.update(state => { state.directThreads ||= {}; state.directThreads[directKey] = key; });
    return [key, binding];
  }
  historyFilter(event, projectId, key, deduplicate = false) {
    const excluded = new Set(), foreignRoots = new Set();
    for (const [threadId, thread] of Object.entries(this.store.data.threads)) if (thread.channel === event.channel) {
      const foreign = projectId && thread.projectId !== projectId;
      if (foreign) foreignRoots.add(thread.threadTs);
      if (foreign || deduplicate && threadId === key) {
        for (const item of Object.values(thread.mirrored || {})) excluded.add(item.ts);
        if (thread.liveStream) excluded.add(thread.liveStream.ts);
      }
    }
    for (const input of Object.values(this.store.data.reactionInputs || {})) if (input.channel === event.channel &&
      (projectId && input.projectId !== projectId || deduplicate && input.key === key)) excluded.add(input.timestamp);
    return message => !excluded.has(message.ts) && !foreignRoots.has(message.thread_ts || message.ts);
  }
  async slackHistorySnapshot(id, event, projectId, key) {
    const scope = { channel: event.channel, threadTs: event.thread_ts || null, beforeTs: event.ts, projectId };
    const saved = this.store.data.inbox[id]?.historySnapshot;
    if (saved && !saved.error) {
      if (digest(saved.scope) !== digest(scope)) throw Object.assign(new Error('Slack history scope changed'), { code: 'HISTORY_UNAVAILABLE' });
      return saved;
    }
    let entries;
    try { entries = await readSlackHistory(this.io, event, { accept: this.historyFilter(event, projectId, key) }); }
    catch (error) {
      await this.store.update(state => {
        state.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
        state.inbox[id].historyUnavailable = { scope, code: 'HISTORY_UNAVAILABLE' };
      });
      throw error;
    }
    const snapshot = { scope, entries };
    await this.store.update(state => {
      state.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
      state.inbox[id].historySnapshot = snapshot;
      delete state.inbox[id].historyUnavailable;
    });
    return this.store.data.inbox[id].historySnapshot;
  }
  async recentThreadContext(event, id = null, projectId = null, key = null) {
    if (!event.thread_ts) return [];
    try {
      const entries = id && !this.store.data.threads[key]?.historyAccepted ? (await this.slackHistorySnapshot(id, event, projectId, key)).entries :
        await readSlackHistory(this.io, event, { limit: 6, width: 800, accept: this.historyFilter(event, projectId, key) });
      return entries.slice(-6).map(({ speaker, text }) => ({ speaker, text: text.slice(0, 800) }));
    } catch (error) { throw Object.assign(new Error('Recent thread context is unavailable within the bounded read; no relevance decision was made'), {
      code: 'RELEVANCE_CONTEXT_INCOMPLETE', ...(error.historyTransient ? { historyTransient: true } : {}),
    }); }
  }
  async bindingHistory(id, event, key, binding) {
    const saved = this.store.data.inbox[id]?.history;
    if (saved !== undefined) return saved;
    if (binding.historyAccepted) return undefined;
    await this.store.update(state => {
      const thread = state.threads[key];
      if (thread.projectId !== binding.projectId || thread.channel !== event.channel) throw Object.assign(new Error('Slack history binding changed'), { code: 'HISTORY_UNAVAILABLE' });
    });
    const snapshot = await this.slackHistorySnapshot(id, event, binding.projectId, key);
    const accept = this.historyFilter(event, binding.projectId, key, true);
    const history = snapshot.entries.filter(item => accept({ ...item, thread_ts: snapshot.scope.threadTs })).map(item => ({ ...item, scope: snapshot.scope }));
    await this.store.update(state => { state.inbox[id].history ||= history; });
    return this.store.data.inbox[id].history;
  }
  async privateConversationContext(id, event, binding) {
    const state = await this.command('conversation.state', binding, event.user, operationId(id, 'participation-context'));
    if (state?.conversationId && state.conversationId !== binding.conversationId) throw Object.assign(new Error('Conversation context scope mismatch'), { code: 'RELEVANCE_SCOPE_MISMATCH' });
    const context = []; let source;
    for (const message of state.messages || []) {
      if (message.role === 'user') source = message.source;
      if (message.source === 'workflow' || source === 'workflow' || String(message.text || '').trimStart().startsWith('[服务器工作流事件') || !message.text) continue;
      let speaker;
      if (message.role === 'assistant') speaker = this.botUserId;
      else if (message.role === 'user' && message.actor?.kind === 'human' && /^[UW][A-Z0-9]{1,79}$/.test(message.actor.userId || '')) speaker = message.actor.userId;
      if (speaker) context.push({ speaker, text: String(message.text).slice(0, 800) });
    }
    return context.slice(-6);
  }
  async mentionRoute(id, event) {
    const saved = this.store.data.inbox[id]?.routingMetadata;
    if (saved) return structuredClone(saved);
    const mentions = activeMentions(event.text);
    if (mentions.length > 8) throw Object.assign(new Error('Too many message recipients'), { code: 'RELEVANCE_ROUTING_LIMIT', silent: true });
    const mentionedUsers = await Promise.all(mentions.map(async userId => {
      if (userId === this.botUserId) return { id: userId, isBot: true };
      let entry = this.userIdentities.get(userId);
      if (!entry || entry.expires <= Date.now()) {
        if (this.identityTasks.size >= 8) return { id: userId, isBot: null };
        if (this.userIdentities.size >= 256) this.userIdentities.delete(this.userIdentities.keys().next().value);
        entry = { expires: Date.now() + 300000 };
        const lookup = Promise.resolve().then(async () => {
          try {
            const result = this.io.identity ? await this.io.identity(userId) : await this.io.call('users.info', { user: userId });
            if (result.user?.id !== userId || typeof result.user.is_bot !== 'boolean') throw new Error('Invalid Slack identity');
            return result.user.is_bot || result.user.is_app_user === true;
          } catch { return null; }
        });
        this.identityTasks.add(lookup); lookup.then(() => this.identityTasks.delete(lookup));
        entry.value = (async () => {
          let timer;
          try {
            const value = await Promise.race([lookup, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
            if (value === null) entry.expires = Date.now() + 30000;
            return value;
          } finally { clearTimeout(timer); }
        })();
        this.userIdentities.set(userId, entry);
      }
      const bot = await entry.value;
      return { id: userId, isBot: bot };
    }));
    const metadata = { coordinatorUserId: this.botUserId, mentionedUsers };
    await this.store.update(state => {
      state.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
      state.inbox[id].routingMetadata = metadata;
    });
    return structuredClone(metadata);
  }
  async message(id, event, expectedProjectId = null, events = [event]) {
    const direct = event.channel_type === 'im' || event.channel?.startsWith('D');
    const explicit = explicitlyAddressed(event, this.botUserId);
    const synthetic = event.ts?.startsWith('command-');
    if (events.reduce((count, item) => count + (item.files || []).length, 0) > 6) throw Object.assign(new Error('每批消息最多 6 个附件'), { silent: !direct && !explicit });
    const text = events.map(item => String(item.text || '')).join('\n\n');
    if (text.length > 8000 && !synthetic) throw Object.assign(new Error('每批消息正文最多 8000 字符'), { code: 'RELEVANCE_INPUT_LIMIT', silent: !direct && !explicit });
    const inputIds = events.map(item => events.length === 1 ? operationId(id, 'submit') : operationId(envelopeId('events_api', { team_id: this.teamId, event: item }), 'submit'));
    const batchInputs = events.map((item, index) => ({ id: inputIds[index], text: String(item.text || '') }));
    if (direct && !synthetic) {
      const currentKey = event.thread_ts ? this.routedThreadKey(event) :
        this.store.data.directThreads?.[digest([this.teamId, event.channel, event.user, this.store.data.preferences[event.user]])];
      const observedSwitch = this.eventStreams.get(currentKey)?.latest?.messages?.some(message =>
        message.actions?.some(action => action.kind === 'project-switch'));
      const pendingSwitch = Object.values(this.store.data.projectSwitches || {}).some(record =>
        record.status === 'pending' && record.action.sourceProjectId === this.store.data.threads[currentKey]?.projectId &&
        record.action.sourceConversationId === this.store.data.threads[currentKey]?.conversationId);
      if (observedSwitch || pendingSwitch) await this.mirror(currentKey);
    }
    if (!synthetic) {
      const directKey = digest([this.teamId, event.channel, event.user, this.store.data.preferences[event.user]]);
      const originalKey = threadKey(this.teamId, event.channel, event.thread_ts || event.ts);
      const existingKey = direct && !event.thread_ts ? this.store.data.directThreads?.[directKey] : this.routedThreadKey(event);
      const existing = this.store.data.threads[existingKey];
      const projectId = existing?.projectId || (direct ? this.store.data.preferences[event.user] : this.store.data.channels[event.channel]);
      if (!projectId) { if (direct || explicit) await this.chooseProject(id, event); return; }
      if (expectedProjectId && projectId !== expectedProjectId) throw Object.assign(new Error('Project changed after accepting this message batch'), { code: 'CONFLICT', silent: true });
      let participation = this.store.data.inbox[id]?.participation;
      const legacy = !participation && this.store.data.inbox[id]?.relevance;
      if (legacy) {
        // 旧提交可能已接受但 ACK 丢失；不能给同一操作增添新字段。
        // 只恢复已持久保存的原分类/批次，不再调用分类模型。
        const request = this.store.data.inbox[id]?.relevanceRequest;
        if (typeof legacy.respond !== 'boolean' || typeof legacy.mainVersion !== 'string' ||
            legacy.projectId !== projectId || request?.projectId !== projectId || request.userId !== event.user ||
            request.payload?.text !== text || JSON.stringify(request.payload?.inputs) !== JSON.stringify(batchInputs)) {
          throw Object.assign(new Error('旧接话记录与原消息批次不一致'), { code: 'ID_REUSED', silent: true });
        }
        if (!legacy.respond) return;
      } else if (!participation) {
        const context = direct && existing && (!event.thread_ts || existingKey !== originalKey)
          ? await this.privateConversationContext(id, event, existing) : await this.recentThreadContext(event, id, projectId, existingKey);
        const routing = await this.mentionRoute(id, { ...event, text });
        routing.replyToCoordinator = context.at(-1)?.speaker === this.botUserId;
        participation = { projectId, payload: { text, inputs: batchInputs.map(({ id, text }) => ({ id, text })), context, routing,
          files: events.flatMap(item => item.files || []).map(file => ({
            name: String(file.name || file.title || '').slice(0, 200), mimeType: String(file.mimetype || '').slice(0, 100) })) } };
        await this.store.update(state => {
          state.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
          state.inbox[id].participation = participation;
        });
      }
      const currentBinding = this.store.data.threads[existingKey];
      const currentProject = currentBinding?.projectId || (direct ? this.store.data.preferences[event.user] : this.store.data.channels[event.channel]);
      const acceptedProject = legacy?.projectId || participation.projectId;
      if (acceptedProject !== currentProject) throw Object.assign(new Error('Channel project changed before submission'), { code: 'CONFLICT', silent: true });
      expectedProjectId = acceptedProject;
    }
    const [key, binding] = await this.ensureBinding(id, event, expectedProjectId);
    if (!binding) return;
    const attachments = [], downloads = []; let imageBytes = 0;
    for (const [index, item] of events.entries()) for (const file of item.files || []) {
      const input = await this.io.download(file);
      if (input.mimeType.startsWith('image/')) imageBytes += Buffer.byteLength(input.base64, 'base64');
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw Object.assign(new Error('同一条消息的图片总计不得超过 5 MiB'), { code: 'ATTACHMENT_TOO_LARGE' });
      downloads.push({ file, input, index });
    }
    // Validate the complete turn before persisting any attachment into Cloud.
    for (const { file, input, index } of downloads) {
      const uploaded = await this.command('attachment.upload', binding, event.user, operationId(inputIds[index], `file:${file.id}`), input);
      const reference = { id: uploaded.id }; attachments.push(reference);
      (batchInputs[index].attachments ||= []).push(reference);
    }
    if (!text.trim() && !attachments.length) return;
    const history = synthetic || binding.projectSwitch ? undefined : await this.bindingHistory(id, event, key, binding);
    const requestId = operationId(id, 'batch-submit');
    let replyContext = this.store.data.inbox[id]?.replyContext;
    if (!replyContext) {
      let question;
      if (binding.pendingQuestionId) {
        const state = await this.command('conversation.state', binding, event.user, operationId(id, 'reply-context'));
        question = (state.messages || []).flatMap(message => message.questions || []).find(question => question.id === binding.pendingQuestionId && !question.answer);
      }
      replyContext = { answerTo: question?.id || null };
      await this.store.update(state => { state.inbox[id] ||= { status: 'done', attempts: 0, at: Date.now(), next: 0 }; state.inbox[id].replyContext = replyContext; });
    }
    if (replyContext?.answerTo) batchInputs[0].answerTo = replyContext.answerTo;
    await this.store.update(state => {
      const item = state.threads[key];
      for (const [index, inputId] of inputIds.entries()) {
        if (!item.ownRequests.includes(inputId)) item.ownRequests.push(inputId);
        const original = events[index];
        if (/^\d+\.\d+$/.test(original.ts || '') && isMessage(original)) {
          const inboxId = events.length === 1 ? id : envelopeId('events_api', { team_id: this.teamId, event: original });
          const received = state.inbox[inboxId], receivedEvent = received?.projectResume?.event || received?.envelope?.body?.event;
          if (!isMessage(receivedEvent) || received.envelope?.body?.team_id !== this.teamId || reactionEventHash(receivedEvent) !== reactionEventHash(original)) continue;
          const target = { key, projectId: binding.projectId, conversationId: binding.conversationId, channel: original.channel,
            timestamp: original.ts, userId: original.user, eventHash: reactionEventHash(original), inboxId };
          const previous = (state.reactionInputs ||= {})[inputId];
          // Optional reactions must not reject an existing business submission.
          // An ambiguous mapping is not rewritten or borrowed as a new target.
          if (previous && digest(previous) !== digest(target)) continue;
          state.reactionInputs[inputId] ||= target;
        }
      }
      item.nextPoll = 0;
    });
    const participation = this.store.data.inbox[id]?.participation?.payload;
    await this.command('conversation.submit', binding, event.user, requestId, { inputs: batchInputs, followup: 'steer', slackChannelId: event.channel,
      ...(participation ? { participation } : {}), ...(history?.length ? { history } : {}) });
    await this.store.update(state => {
      state.threads[key].awaitingReplyId = inputIds.at(-1); state.threads[key].nextPoll = 0;
      if (history !== undefined) state.threads[key].historyAccepted = true;
    });
    if (replyContext?.answerTo) await this.store.update(state => { if (state.threads[key].pendingQuestionId === replyContext.answerTo) delete state.threads[key].pendingQuestionId; });
    // 普通消息是否接话由本轮模型决定，不在决定前添加“处理中”反应。
    if (!participation) for (const item of events) if (!item.ts?.startsWith('command-')) this.readReaction(item);
  }
  async openForm(triggerId, userId, id, kind, context) {
    const draftId = `draft-${digest(id)}`, binding = context.key && this.store.data.threads[context.key];
    const projectId = binding?.projectId || context.projectId || this.store.data.preferences[userId];
    const projects = this.projects.get(userId) || [];
    let project = projectId && this.maps.get(projectId);
    if (['item', 'memory'].includes(kind) && projectId) project ||= await this.readProject(projectId, userId, id);
    const node = project && nodesOf(project.map).find(item => item.id === context.nodeId);
    const item = node && (node[context.kind === 'bug' ? 'bugs' : 'todos'] || []).find(item => item.id === context.itemId);
    const draft = { userId, kind, context: { ...context, projectId }, project, createdAt: Date.now() };
    await this.store.update(state => { state.drafts[draftId] = draft; });
    let fields, initial = {}, title;
    const projectField = { id: 'project', label: '项目', options: projects.map(item => ({ label: item.name || item.id, value: item.id })) };
    if (kind === 'binding') {
      fields = [projectField, { id: 'channel', label: '关联频道 ID（D 私聊无需填）', optional: true }, { id: 'conversation', label: '关联已有 Cloud 对话 ID（可留空）', optional: true }, { id: 'thread', label: '已有线程时间戳（关联对话时填写）', optional: true }]; title = '关联项目 / Cloud 对话';
      initial = { project: projectId, channel: context.channel || '', thread: context.threadTs || '' };
    } else if (kind === 'answer' || kind === 'reject') {
      fields = [{ id: 'text', label: kind === 'answer' ? '回答' : '退回原因', multiline: true }]; title = kind === 'answer' ? '回答 Coordinator' : '退回 brief';
    } else if (kind === 'memory') {
      if ((node?.memoryDocument || '').length > 2900) throw new Error('记忆超过 Slack 表单长度，请在工作台编辑完整文档；不会截断原文');
      fields = [projectField, { id: 'node', label: '节点 ID（见 Home 导航）' }, { id: 'text', label: '节点 memory.md（替换全文，保留六部分标题）', multiline: true }]; title = '编辑节点记忆'; initial = { project: projectId, node: context.nodeId || '', text: node?.memoryDocument || '' };
    } else {
      const statuses = context.kind === 'bug' ? ['open', 'fixed', 'resolved', 'unfixable'] : ['pending', 'processing', 'done'];
      const itemText = context.kind === 'bug' ? item?.phenomenon || item?.description || item?.desc || item?.text : item?.description || item?.desc || item?.text;
      if ((itemText || '').length > 2900) throw new Error('事项正文超过 Slack 表单长度，请在工作台编辑；不会截断原文');
      fields = [projectField, { id: 'node', label: '节点 ID（见 Home 导航）' }, { id: 'title', label: '标题' }, { id: 'text', label: '需求 / 现象及验收要求', multiline: true, optional: true }, { id: 'status', label: '状态', options: statuses.map(value => ({ label: value, value })) }]; title = context.kind === 'bug' ? 'Bug' : 'TODO';
      initial = { project: projectId, node: context.nodeId || '', title: item?.title || '', text: itemText || context.initialText?.slice(0, 2900) || '', status: statuses.includes(item?.status) ? item.status : statuses[0] };
    }
    if (fields.some(field => field.options && !field.options.length)) throw new Error('请先打开 App Home 加载可用项目');
    await this.io.call('views.open', { trigger_id: triggerId, view: modal({ callback: `cg_${kind}`, draftId, title, fields, initial }) });
  }
  async submitForm(id, body, userId) {
    const draftId = body.view.private_metadata, draft = this.store.data.drafts[draftId];
    if (!draft || draft.userId !== userId || Date.now() - draft.createdAt > 86400000) throw new Error('表单已失效，请重新打开');
    const values = formValues(body.view), context = draft.context;
    if (draft.kind === 'answer') return this.answer(id, userId, { ...context, text: values.text });
    if (draft.kind === 'reject') return this.review(id, userId, context, 'rejected', values.text);
    const projectId = values.project;
    const projects = this.projects.get(userId) || await this.loadProjects(userId, id);
    if (!projects.some(item => item.id === projectId)) throw new Error('项目不在开放列表');
    if (draft.kind === 'binding') {
      if (values.channel && !/^[CGD][A-Z0-9]{6,}$/.test(values.channel)) throw new Error('请输入 Slack 频道 ID');
      if (values.channel) {
        // Only a channel the bot and submitting user can see can be bound.
        const info = await this.io.call('conversations.info', { channel: values.channel });
        if (values.channel.startsWith('D')) {
          if (info.channel?.user !== userId) throw new Error('只能关联自己的私聊');
        } else {
          const members = await this.channelMembers(values.channel);
          if (!members.includes(userId)) throw new Error('只能关联自己所在的频道');
        }
        await this.store.update(state => { state.channels[values.channel] = projectId; });
      }
      await this.store.update(state => { state.preferences[userId] = projectId; });
      if (values.conversation) {
        if (!values.channel || !/^\d+\.\d+$/.test(values.thread)) throw new Error('关联已有对话需要频道和有效线程时间戳');
        const bound = await this.gateway.command('conversation.bind', { id: operationId(id, 'bind'), userId, projectId, payload: { conversationId: values.conversation } });
        await this.store.bind(threadKey(this.teamId, values.channel, values.thread), { channel: values.channel, threadTs: values.thread, projectId, conversationId: bound.conversationId, userId, ownRequests: [] });
      }
      await this.publishHome(userId, id); return;
    }
    if (draft.project?.id !== projectId) throw new Error('项目已改变，请先选择项目并重新打开表单');
    const node = nodesOf(draft.project.map).find(node => node.id === values.node);
    if (!node) throw new Error('节点不存在，请刷新 Home');
    let fields;
    if (draft.kind === 'memory') {
      fields = { memoryDocument: values.text };
    } else {
      const field = context.kind === 'bug' ? 'bugs' : 'todos', items = structuredClone(node[field] || []);
      const index = items.findIndex(item => item.id === context.itemId);
      if (context.itemId && index < 0) throw new Error('事项不存在，请刷新 Home');
      const item = { ...(index >= 0 ? items[index] : { executionMode: 'manual' }), id: context.itemId || `${context.kind === 'bug' ? 'B' : 'TD'}-slack-${digest(id).slice(0, 20)}`, title: values.title, text: values.text, status: values.status };
      item.description = values.text;
      if (context.kind === 'bug') item.phenomenon = values.text;
      if (Object.hasOwn(item, 'desc')) item.desc = values.text;
      if (index >= 0) items[index] = item; else items.push(item);
      fields = { [field]: items };
    }
    await this.gateway.command('map.write', { id: operationId(id, 'write'), userId, projectId, payload: { baseVersion: draft.project.version, operations: [{ type: 'update', id: node.id, fields }] } });
    await this.store.update(state => { delete state.drafts[draftId]; });
    await this.publishHome(userId, id);
  }
  async selectFormProject(id, body, userId, projectId) {
    const draftId = body.view?.private_metadata, draft = this.store.data.drafts[draftId];
    if (!draft || draft.userId !== userId) throw new Error('表单已失效');
    const projects = this.projects.get(userId) || await this.loadProjects(userId, id);
    if (!projects.some(project => project.id === projectId)) throw new Error('项目不在开放列表');
    if (draft.context.itemId && draft.context.projectId !== projectId) throw new Error('编辑已有事项不能跨项目移动');
    const project = await this.readProject(projectId, userId, id);
    await this.store.update(state => { state.drafts[draftId].project = project; state.drafts[draftId].context.projectId = projectId; });
    // A project switch pins a fresh server version and retains typed prose.
    const view = { type: 'modal', callback_id: body.view.callback_id, private_metadata: draftId, title: body.view.title, submit: body.view.submit, close: body.view.close, blocks: structuredClone(body.view.blocks) };
    const values = formValues(body.view);
    for (const block of view.blocks) {
      if (block.block_id === 'project') block.element.initial_option = block.element.options.find(option => option.value === projectId);
      else if (block.element?.type === 'plain_text_input' && values[block.block_id]) block.element.initial_value = values[block.block_id];
    }
    await this.io.call('views.update', { view_id: body.view.id, hash: body.view.hash, view });
  }
  async channelMembers(channel) {
    let cursor; const members = [];
    for (let page = 0; page < 20; page++) { const result = await this.io.call('conversations.members', { channel, limit: 200, ...(cursor ? { cursor } : {}) }); members.push(...(result.members || [])); cursor = result.response_metadata?.next_cursor; if (!cursor) return members; }
    throw new Error('无法核对频道成员，请使用更小的频道');
  }
  async stopChat(id, body, userId) {
    let target = this.store.data.inbox[id]?.interruptTarget;
    if (!target) {
      const conversationId = body.text.trim().split(/\s+/)[1];
      const candidates = Object.entries(this.store.data.threads).filter(([, binding]) =>
        binding.channel === body.channel_id && binding.userId === userId &&
        (conversationId ? binding.conversationId === conversationId : binding.live || binding.awaitingReplyId));
      if (candidates.length !== 1) throw Object.assign(new Error(candidates.length ? '当前频道有多个对话，请使用 /cg stop <对话ID>' : '当前频道没有可停止的已关联对话'), { code: 'AMBIGUOUS_CONVERSATION' });
      const [key, binding] = candidates[0];
      const state = await this.command('conversation.state', binding, userId, operationId(id, 'stop-state'));
      if (!state.activeTurnId || state.status === 'interrupted') throw Object.assign(new Error('目标对话当前没有正在执行的轮次'), { code: 'NO_ACTIVE_TURN' });
      target = { key, projectId: binding.projectId, conversationId: binding.conversationId, expectedTurnId: state.activeTurnId };
      await this.store.update(data => {
        data.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
        data.inbox[id].interruptTarget = target;
      });
    }
    const binding = this.store.data.threads[target.key];
    if (!binding || binding.projectId !== target.projectId || binding.conversationId !== target.conversationId) throw Object.assign(new Error('对话关联已改变，停止请求未转交给其他对话'), { code: 'CONFLICT' });
    await this.command('conversation.interrupt', binding, userId, operationId(id, 'interrupt'), { expectedTurnId: target.expectedTurnId });
    await this.store.update(data => { data.threads[target.key].nextPoll = 0; });
  }
  async resumeChat(id, body, userId) {
    let target = this.store.data.inbox[id]?.resumeTarget;
    if (!target) {
      const conversationId = body.text.trim().split(/\s+/)[1];
      const candidates = Object.entries(this.store.data.threads).filter(([, binding]) =>
        binding.channel === body.channel_id && binding.userId === userId &&
        (conversationId ? binding.conversationId === conversationId : ['interrupted', 'error'].includes(binding.status)));
      if (candidates.length !== 1) throw Object.assign(new Error(candidates.length ? '当前频道有多个对话，请使用 /cg resume <对话ID>' : '当前频道没有可恢复的已关联对话'), { code: 'AMBIGUOUS_CONVERSATION' });
      const [key, binding] = candidates[0];
      const state = await this.command('conversation.state', binding, userId, operationId(id, 'resume-state'));
      if (!['interrupted', 'error'].includes(state.status) || !state.retryInput?.id) throw Object.assign(new Error('目标对话没有可恢复的停止轮次'), { code: 'INVALID_RETRY' });
      target = { key, projectId: binding.projectId, conversationId: binding.conversationId, expectedTurnId: state.retryInput.id };
      await this.store.update(data => {
        data.inbox[id] ||= { status: 'pending', attempts: 0, at: Date.now(), next: 0 };
        data.inbox[id].resumeTarget = target;
      });
    }
    const binding = this.store.data.threads[target.key];
    if (!binding || binding.projectId !== target.projectId || binding.conversationId !== target.conversationId) throw Object.assign(new Error('对话关联已改变，恢复请求未转交给其他对话'), { code: 'CONFLICT' });
    // Cloud restores the original input and trusted actor. A new transport ID
    // cannot be mistaken for the original successful submit receipt.
    await this.command('conversation.submit', binding, userId, operationId(id, 'resume'), { retry: true, expectedTurnId: target.expectedTurnId,
      slackChannelId: binding.channel });
    await this.store.update(data => { data.threads[target.key].awaitingReplyId = target.expectedTurnId; data.threads[target.key].nextPoll = 0; });
  }
  async answer(id, userId, value) {
    const binding = this.store.data.threads[value.key]; if (!binding) throw new Error('Unknown Slack thread');
    const requestId = operationId(id, 'answer');
    await this.store.update(state => { if (!state.threads[value.key].ownRequests.includes(requestId)) state.threads[value.key].ownRequests.push(requestId); state.threads[value.key].nextPoll = 0; });
    await this.command('conversation.submit', binding, userId, requestId, { text: value.text, answerTo: value.questionId, followup: 'steer' });
    await this.store.update(state => { state.threads[value.key].awaitingReplyId = requestId; state.threads[value.key].nextPoll = 0; });
  }
  async review(id, userId, value, decision, reason) {
    const binding = this.store.data.threads[value.key]; if (!binding) throw new Error('Unknown Slack thread');
    const result = await this.command('brief.review', binding, userId, operationId(id, 'review'), { proposalId: value.proposalId, decision, reason, version: value.version });
    const confirmed = 'brief 已确认，Main 事项已保存。请将执行提示粘贴到 Claude Code CLI 或 Cursor；开发记录只保存在本地。';
    await this.io.post({ id: operationId(id, 'review-result'), channel: binding.channel, threadTs: binding.threadTs, text: decision === 'approved' ? confirmed : 'brief 已退回。直接在这个线程告诉我你想怎么修改。',
      ...(decision === 'approved' ? { blocks: [section(confirmed), { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '导出执行提示' }, action_id: 'export_prompt', value: JSON.stringify({ key: value.key, proposalId: value.proposalId }) }] }] } : {}) });
    await this.store.update(state => { state.threads[value.key].nextPoll = 0; });
    if (decision === 'approved' && result.itemId && result.nodeId) await this.store.update(state => {
      const thread = state.threads[value.key]; thread.watchedItems ||= {};
      thread.watchedItems[result.itemId] ||= { nodeId: result.nodeId, kind: result.kind || 'todo', status: null }; thread.nextItemPoll = 0;
    });
    return result;
  }
  async reviewBinding(id, userId, value, decision) {
    const binding = this.store.data.threads[value.key];
    if (!binding) throw new Error('Unknown Slack thread');
    const result = await this.command('binding.review', binding, userId, operationId(id, 'binding-review'),
      { proposalId: value.proposalId, version: value.version, decision });
    await this.io.post({ id: operationId(id, 'binding-result'), channel: binding.channel, threadTs: binding.threadTs, text: result.message });
    await this.store.update(data => { data.threads[value.key].nextPoll = 0; });
    return result;
  }
  async exportPrompt(id, userId, value) {
    const binding = this.store.data.threads[value.key]; if (!binding) throw new Error('Unknown Slack thread');
    const prompt = await this.command('prompt.read', binding, userId, operationId(id, 'prompt'), { proposalId: value.proposalId });
    await this.io.uploadPrompt({ id: operationId(id, 'file-export'), channel: binding.channel, threadTs: binding.threadTs, ...prompt });
  }
  async mirror(key) {
    const binding = this.store.data.threads[key];
    if (!binding) return;
    const stream = this.eventStreams.get(key);
    const sameScope = stream && !stream.controller.signal.aborted && stream.projectId === binding.projectId && stream.conversationId === binding.conversationId;
    const cached = sameScope ? stream.latest : null;
    if (stream) { stream.latest = null; stream.lastFallbackAt = Date.now(); }
    const state = cached || await this.command('conversation.state', binding, binding.userId, operationId(`${key}:${Date.now()}`, 'state'));
    if (Number.isSafeInteger(binding.controlRevision) && binding.controlRevision > 0 &&
        (!Number.isSafeInteger(state.controlRevision) || state.controlRevision < binding.controlRevision)) return;
    if (Number.isSafeInteger(state.inputRevision) && Number.isSafeInteger(binding.inputRevision) &&
        (state.inputRevision < binding.inputRevision || state.inputRevision === binding.inputRevision &&
          Number.isSafeInteger(state.consumedInputRevision) && state.consumedInputRevision < (binding.consumedInputRevision || 0))) return;
    const messages = state.messages || [];
    const userRequestIds = messages.filter(message => message.role === 'user' && message.requestId).map(message => message.requestId);
    const accepted = state.acceptedRequestIds || [];
    const lastRequestId = userRequestIds.at(-1) || state.activeTurnId;
    // Context loading happens before submission takes the lock. receivedAt is
    // diagnostic wall time, not a revision; use the existing append history.
    // Legacy snapshots without visible user identities have no append-order
    // proof. Retain polling compatibility rather than guessing their order.
    if (binding.lastStateRequestId && userRequestIds.length && lastRequestId !== binding.lastStateRequestId &&
        !userRequestIds.includes(binding.lastStateRequestId) && !accepted.includes(binding.lastStateRequestId)) return;
    // Polling and event snapshots may complete out of order. A turn that was
    // durably settled cannot become a partial stream again (including restart).
    if (state.activeTurnId && binding.settledRequestIds?.includes(state.activeTurnId)) return;
    const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
    let currentRequest = null, currentActor = null;
    const entries = messages.map((message, index) => {
      if (message.role === 'user') {
        currentRequest = message.requestId;
        currentActor = message.source === 'slack' && message.actor?.kind === 'human' && message.actor.teamId === this.teamId &&
          /^[UW][A-Z0-9]{1,31}$/.test(message.actor.userId || '') ? message.actor.userId : null;
      }
      const requestId = message.requestId || (message.role === 'assistant' ? currentRequest : null);
      const id = message.id || digest(message);
      const actor = message.actor;
      const assistantActor = message.role === 'assistant' && !message.partial && message.source === 'slack' &&
        actor?.kind === 'human' && actor.integration === 'slack' && actor.teamId === this.teamId &&
        /^[UW][A-Z0-9]{1,31}$/.test(actor.userId || '') && actor.sessionId === `slack:${this.teamId}:${actor.userId}` &&
        !!message.requestId && binding.ownRequests?.includes(message.requestId) ? actor.userId : null;
      return { message, index, requestId, id, userId: assistantActor || (requestId === currentRequest ? currentActor : null) };
    });
    const streamIdFor = (turnId, revision) => `stream:${turnId}${Number.isSafeInteger(revision) ? `:${revision}` : ''}`;
    const ownsStream = (id, turnId) => id === streamIdFor(turnId) ||
      id.startsWith(`${streamIdFor(turnId)}:`) && /^\d+$/.test(id.slice(streamIdFor(turnId).length + 1));
    const occupiedSlot = (thread, ts) => Object.entries(thread.mirrored).some(([id, entry]) => !id.startsWith('stream:') && entry.ts === ts);
    // Older bindings retained only the latest pointer. Recover its real slot,
    // while the persisted stream keys retain previews from earlier turns.
    const retained = this.store.data.threads[key].liveStream;
    if (retained?.turnId && !occupiedSlot(this.store.data.threads[key], retained.ts)) {
      const slotId = Object.entries(this.store.data.threads[key].mirrored).find(([id, entry]) =>
        ownsStream(id, retained.turnId) && entry.ts === retained.ts && !entry.consumedBy)?.[0] || streamIdFor(retained.turnId);
      if (!this.store.data.threads[key].mirrored[slotId] || retained.slotId !== slotId && this.store.data.threads[key].mirrored[slotId].ts === retained.ts) {
        await this.store.update(data => {
          const thread = data.threads[key];
          thread.mirrored[slotId] ||= { ts: retained.ts, turnId: retained.turnId, text: retained.text, interrupted: retained.interrupted };
          thread.liveStream.slotId = slotId;
        });
      }
    }
    const streamFor = (turnId, partial = false, slotId = null) => {
      if (!turnId) return null;
      const thread = this.store.data.threads[key];
      const slot = Object.entries(thread.mirrored).find(([id, entry]) => (!slotId || id === slotId) && ownsStream(id, turnId) && !entry.consumedBy &&
        !occupiedSlot(thread, entry.ts) && !(partial && state.status === 'running' && state.activeTurnId === turnId &&
          id === streamIdFor(turnId, state.consumedInputRevision)));
      return slot ? { ...slot[1], slotId: slot[0], turnId } : null;
    };
    const readyReactions = new Set(await this.queueReadReactions(key, state));
    this.drainReactions(readyReactions);
    for (const { message, index, requestId, id, userId } of entries) {
      if (message.actions?.some(action => action.kind === 'project-switch')) {
        const switched = await this.applyProjectSwitch(key, message, messages, state);
        if (switched) {
          if (switched.announced) continue;
          const text = switched.status === 'applied' ? `已切换到 ${switched.name}。后续消息会使用该项目的独立上下文，原项目记录保留。` :
            '项目没有切换：选择已改变、目标不可用或来源无法验证。请重新说要切换到哪个项目。';
          let resultSlot = switched.resultSlot;
          if (!resultSlot) {
            const oldSlot = this.store.data.threads[key].liveStream;
            resultSlot = oldSlot?.turnId === requestId ? { ts: oldSlot.ts } : { post: true };
            if (switched.id) await this.store.update(data => { data.projectSwitches[switched.id].resultSlot = resultSlot; });
          }
          if (resultSlot.ts) {
            await this.io.update(binding.channel, resultSlot.ts, text, messageBlocks({ text }, key));
          } else await this.io.post({ id: operationId(`${key}:${id}`, 'switch-result'), channel: binding.channel, threadTs: binding.threadTs, text, blocks: messageBlocks({ text }, key) });
          if (switched.id) await this.store.update(data => {
            data.projectSwitches[switched.id].announced = true;
            if (data.threads[key].liveStream?.ts === resultSlot.ts) delete data.threads[key].liveStream;
          });
        }
        continue;
      }
      try { for (const id of await this.queueReactions(key, message, messages)) readyReactions.add(id); }
      catch (error) { this.logger.warn('Slack reaction intent retained in Cloud', { code: error.code || 'REACTION_JOURNAL_ERROR' }); }
      if (!hasSlackContent(message)) continue;
      const partial = message.role === 'assistant' && message.partial === true;
      if (message.role === 'user' && (message.source === 'workflow' || String(message.text || '').trimStart().startsWith('[服务器工作流事件'))) continue;
      if (message.role === 'user' && this.store.data.threads[key].ownRequests.includes(message.requestId)) continue;
      if (!partial && state.status === 'running' && state.streamingText && index === lastAssistant && requestId === state.activeTurnId) continue;
      const stream = message.role === 'assistant' ? streamFor(requestId, partial) : null;
      const settled = !state.activeTurnId && ['waiting-for-user', 'idle'].includes(state.status) && !state.pendingInputCount;
      // A model step can save waiting-for-user before the service clears the
      // turn ID. Keep the existing partial message until that durable boundary
      // settles, rather than posting a second final and later updating both.
      if (!partial && stream && message.role === 'assistant' && stream.turnId === requestId && !settled) continue;
      const display = partial ? { ...message, text: `部分回复（已被补充调整，非最终答案）：\n${message.text || ''}` } : message;
      const modelMenus = await this.naturalModelMenus(key, message, userId);
      const blocks = messageBlocks(display, key, { cloudOrigin: this.cloudOrigin, projectId: binding.projectId, mapNodeId: binding.mapNodeId, modelMenus });
      const content = digest({ format: 'plain-text-v2', message,
        ...(partial ? { partialProjection: 1 } : {}),
        ...(blocks.some(block => block.type === 'actions') ? { nodeLinks: blocks.filter(block => block.type === 'actions') } : {}),
        ...(message.questions?.length ? { questionRender: blocks } : {}), ...(modelMenus.length ? { modelMenuRender: blocks } : {}) }),
        prior = this.store.data.threads[key].mirrored[id];
      // A legacy partial can refresh its own display once, but never a slot
      // since assigned to another formal message by chronological rotation.
      if (partial && prior && Object.entries(this.store.data.threads[key].mirrored).some(([otherId, entry]) =>
        otherId !== id && !otherId.startsWith('stream:') && entry.ts === prior.ts)) continue;
      // Older versions could append an earlier model step after the stream.
      // Rotate those occupied slots forward until a pending reply consumes the
      // final slot, without deleting Slack history or duplicating the content.
      const moveEarlier = !partial && !!stream && settled && message.role === 'assistant' && stream.turnId === requestId &&
        !!prior && Number(prior.ts) > Number(stream.ts) && entries.some(entry =>
          entry.message.role === 'assistant' && entry.requestId === stream.turnId &&
          hasSlackContent(entry.message) &&
          !this.store.data.threads[key].mirrored[entry.id]);
      if (prior?.hash === content && !moveEarlier) continue;
      const text = `${message.role === 'user' ? '工作台用户' : 'Coordinator'}：${display.text || (modelMenus.length ? '项目默认文字模型菜单' : message.actions?.length ? '节点入口' : '附件')}`;
      // The retained placeholder has the earliest Slack timestamp. Finalize
      // it with the first pending reply, then append later model steps in order.
      const retainPartial = partial && !!stream && !prior && stream.turnId === requestId;
      const replaceStream = !partial && !!stream && (!prior || moveEarlier) && message.role === 'assistant' && settled && stream.turnId === requestId;
      const existingTs = replaceStream || retainPartial ? stream.ts : prior?.ts;
      const ts = existingTs ? (await this.io.update(binding.channel, existingTs, text, blocks), existingTs) : await this.io.post({ id: operationId(`${key}:${id}`, 'mirror'), channel: binding.channel, threadTs: binding.threadTs, text, blocks });
      await this.store.update(data => {
        data.threads[key].mirrored[id] = { ts, hash: content };
        for (const menu of modelMenus) data.modelMenus[menu.id].ts = ts;
        if (moveEarlier) {
          data.threads[key].mirrored[stream.slotId].ts = prior.ts;
          if (data.threads[key].liveStream?.slotId === stream.slotId) data.threads[key].liveStream.ts = prior.ts;
        } else if (replaceStream || retainPartial) {
          data.threads[key].mirrored[stream.slotId].consumedBy = id;
          if (data.threads[key].liveStream?.slotId === stream.slotId) delete data.threads[key].liveStream;
        }
      });
    }
    this.drainReactions(readyReactions);
    if (state.streamingText && state.status === 'running') {
      const streamId = streamIdFor(state.activeTurnId, state.consumedInputRevision), thread = this.store.data.threads[key],
        prior = thread.mirrored[streamId], content = digest({ format: 'plain-text-v2', partialProjection: 1, text: state.streamingText });
      // A delayed stream never writes over a slot already assigned to a reply.
      if (!prior?.consumedBy && (!prior || !occupiedSlot(thread, prior.ts))) {
        let ts = prior?.ts;
        if (prior?.hash !== content) {
          const text = `Coordinator：${state.streamingText}`;
          const blocks = messageBlocks({ text: state.streamingText, partial: true }, key, { cloudOrigin: this.cloudOrigin, projectId: binding.projectId });
          ts = prior?.ts ? (await this.io.update(binding.channel, prior.ts, text, blocks), prior.ts) : await this.io.post({ id: operationId(`${key}:${streamId}`, 'stream'), channel: binding.channel, threadTs: binding.threadTs, text, blocks });
        }
        if (prior?.hash !== content || thread.liveStream?.slotId !== streamId) await this.store.update(data => {
          data.threads[key].mirrored[streamId] = { ts, hash: content, turnId: state.activeTurnId, revision: state.consumedInputRevision, text: state.streamingText };
          data.threads[key].liveStream = { ts, slotId: streamId, turnId: state.activeTurnId, text: state.streamingText };
        });
      }
    }
    if (state.status === 'error' && state.activeTurnId) {
      const slotId = streamIdFor(state.activeTurnId, state.consumedInputRevision);
      const thread = this.store.data.threads[key];
      const stream = Number.isSafeInteger(state.consumedInputRevision) || thread.liveStream?.slotId === slotId && thread.liveStream.turnId === state.activeTurnId
        ? streamFor(state.activeTurnId, false, slotId) : null;
      const partial = state.streamingText || state.partialText || stream?.text;
      if (stream && partial) {
        const failedHash = digest({ partialProjection: 1, text: partial, code: state.error?.code || 'UNKNOWN' });
        if (stream.failedHash !== failedHash) {
          const text = `Coordinator 部分回复（生成失败，非最终答案）：\n${partial}`;
          await this.io.update(binding.channel, stream.ts, text, messageBlocks({ text, partial: true }, key, { cloudOrigin: this.cloudOrigin, projectId: binding.projectId }));
          await this.store.update(data => {
            data.threads[key].mirrored[stream.slotId].failedHash = failedHash;
            if (data.threads[key].liveStream?.slotId === stream.slotId) data.threads[key].liveStream.failedHash = failedHash;
          });
        }
      }
    }
    if (state.status === 'interrupted') {
      const turnId = state.activeTurnId || binding.lastStateRequestId;
      const stream = streamFor(turnId, false, streamIdFor(turnId, state.consumedInputRevision)) || streamFor(turnId);
      if (stream && !stream.interrupted) {
        const partial = stream.text || state.partialText || state.streamingText;
        if (partial) {
          const text = `Coordinator 已停止（部分回复，非最终答案）：\n${partial}`;
          await this.io.update(binding.channel, stream.ts, text, messageBlocks({ text, partial: true }, key));
        }
        await this.store.update(data => {
          data.threads[key].mirrored[stream.slotId].interrupted = true;
          if (data.threads[key].liveStream?.slotId === stream.slotId) data.threads[key].liveStream.interrupted = true;
        });
      }
      const noticeId = `interrupted:${state.activeTurnId || binding.lastStateRequestId}`;
      if (!this.store.data.threads[key].mirrored[noticeId]) {
        const ts = await this.io.post({ id: operationId(`${key}:${noticeId}`, 'notice'), channel: binding.channel, threadTs: binding.threadTs,
          text: '当前轮次已停止。已完成的操作和部分回复保留；未处理的补充仍保留，不会自动继续。' });
        await this.store.update(data => { data.threads[key].mirrored[noticeId] = { ts }; });
      }
    } else if (!['pending', 'silent'].includes(state.participationDecision) && state.status === 'running' && Number.isSafeInteger(state.inputRevision) && state.inputRevision > 1 &&
        (state.pendingInputCount > 0 || binding.inputNotice)) {
      const text = state.pendingInputCount > 0 ? `已保存 ${state.pendingInputCount} 条补充，等待纳入当前轮次。` : '补充已纳入当前轮次，仍在处理。';
      const prior = binding.inputNotice;
      if (prior?.text !== text) {
        const ts = prior?.ts ? (await this.io.update(binding.channel, prior.ts, text), prior.ts) :
          await this.io.post({ id: operationId(`${key}:${state.inputRevision}`, 'input-notice'), channel: binding.channel, threadTs: binding.threadTs, text });
        await this.store.update(data => { data.threads[key].inputNotice = { ts, text }; });
      }
    }
    if (binding.inputNotice && state.status !== 'running') {
      const text = state.status === 'interrupted' ? '当前轮次已停止，未处理补充仍保留。' : state.status === 'error' ?
        '当前轮次失败，补充和操作回执仍保留。' : state.pendingInputCount > 0 ? '补充已保存，尚未全部处理。' :
        '本轮已结束，请以实际回复和操作回执为准。';
      if (binding.inputNotice.text !== text) {
        await this.io.update(binding.channel, binding.inputNotice.ts, text);
        await this.store.update(data => { data.threads[key].inputNotice.text = text; });
      }
    }
    for (const approval of state.approvals || []) {
      if (approval.kind === 'binding-proposal') {
        const id = `binding:${approval.id}`, hash = digest(approval), prior = this.store.data.threads[key].mirrored[id];
        if (prior?.hash === hash || approval.pending === false && !prior) continue;
        const text = approval.pending ? 'Coordinator：请确认需求的主节点' :
          approval.decision === 'approved' ? '已确认绑定到' + approval.node.title : approval.decision === 'superseded' ? '已有新的绑定建议' : '暂不绑定，继续讨论';
        const blocks = approval.pending ? bindingBlocks(approval, key) : [section(text)];
        const ts = prior?.ts ? (await this.io.update(binding.channel, prior.ts, text, blocks), prior.ts) :
          await this.io.post({ id: operationId(`${key}:${id}`, 'binding-card'), channel: binding.channel, threadTs: binding.threadTs, text, blocks });
        await this.store.update(data => { data.threads[key].mirrored[id] = { ts, hash }; });
        continue;
      }
      if (approval.manual !== true) continue;
      const id = `approval:${approval.id}`, hash = digest(approval), prior = this.store.data.threads[key].mirrored[id];
      if (prior?.hash === hash) continue;
      if (approval.pending === false && !prior) continue;
      const resolved = approval.pending === false;
      const text = approval.stale ? '主节点已改绑，这份需求说明已过期，请重新整理。' :
        resolved ? `brief 已${approval.decision === 'approved' ? '确认' : '退回'}` : 'Coordinator：等待人工确认 brief';
      const blocks = resolved ? [section(text), ...(approval.decision === 'approved' ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '导出执行提示' }, action_id: 'export_prompt', value: JSON.stringify({ key, proposalId: approval.id }) }] }] : [])] : approvalBlocks(approval, key);
      const ts = prior?.ts ? (await this.io.update(binding.channel, prior.ts, text, blocks), prior.ts) : await this.io.post({ id: operationId(`${key}:${id}`, 'card'), channel: binding.channel, threadTs: binding.threadTs, text, blocks });
      await this.store.update(data => { data.threads[key].mirrored[id] = { ts, hash }; });
      if (resolved && approval.decision === 'approved' && approval.itemId && approval.nodeId) await this.store.update(data => {
        const thread = data.threads[key]; thread.watchedItems ||= {}; thread.watchedItems[approval.itemId] ||= { nodeId: approval.nodeId, kind: approval.kind || 'todo', status: null };
      });
    }
    if (Object.keys(this.store.data.threads[key].watchedItems || {}).length && (this.store.data.threads[key].nextItemPoll || 0) <= Date.now()) await this.notifyItemChanges(key);
    const ownsFeedback = state.participationRequestIds?.some(id => this.feedback.valid(this.store.data.reactionInputs?.[id]?.inboxId));
    if (state.status === 'error' && (ownsFeedback || !['pending', 'silent'].includes(state.participationDecision))) await this.io.post({ id: operationId(`${key}:${state.activeTurnId}:${state.error?.code}`, 'error'), channel: binding.channel, threadTs: binding.threadTs,
      text: ownsFeedback ? 'Coordinator 当前处理失败，请稍后重试。原消息与已完成操作仍保留。' : `Coordinator 当前失败：${state.error?.code || 'UNKNOWN'}。请在工作台查看并重试；不会显示假成功。` });
    // 模型结束不等于 Slack 送达。只用当前批次之后已发送的正式回答/卡片作证据，
    // 续写时回答仍归最初请求，不能仅匹配最后一条补充的 requestId。
    const batch = state.participationRequestIds || [], currentThread = this.store.data.threads[key];
    const lastInputIndex = messages.findLastIndex(message => message.role === 'user' && batch.includes(message.requestId));
    const delivered = lastInputIndex >= 0 && entries.findLast(({ message, index, id }) => {
      const actor = message.actor, source = messages.find(item => item.role === 'user' && item.requestId === message.requestId);
      if (index <= lastInputIndex || message.role !== 'assistant' || message.partial || message.source !== 'slack' ||
          !currentThread.ownRequests?.includes(message.requestId) || actor?.kind !== 'human' || actor.integration !== 'slack' ||
          actor.teamId !== this.teamId || actor.sessionId !== `slack:${this.teamId}:${actor.userId}` ||
          source?.source !== 'slack' || source.actor?.sessionId !== actor.sessionId) return false;
      if (hasSlackContent(message) && currentThread.mirrored[id]?.ts) return true;
      return (message.actions || []).some(action => action.kind === 'binding-proposal' &&
        currentThread.mirrored[`binding:${action.id}`]?.ts || action.kind === 'project-switch' &&
        this.store.data.projectSwitches?.[`project-switch-${digest([key, action.actionId])}`]?.announced === true);
    });
    if (delivered && !state.activeTurnId && ['waiting-for-user', 'idle'].includes(state.status) && !state.pendingInputCount) {
      const firstInputIndex = messages.findIndex(message => message.role === 'user' && message.requestId === delivered.requestId);
      const completedRequests = messages.slice(firstInputIndex, lastInputIndex + 1)
        .filter(message => message.role === 'user' && message.source === 'slack' && accepted.includes(message.requestId))
        .map(message => message.requestId);
      try {
        for (let start = 0; start < completedRequests.length; start += 20) {
          await this.queueReadReactions(key, state, { completed: true, requestIds: completedRequests.slice(start, start + 20) });
        }
      }
      catch (error) { this.logger.warn('Slack 完成状态保留', { code: error.code || 'FEEDBACK_JOURNAL_ERROR' }); }
    }
    const openQuestions = messages.flatMap(message => message.questions || []).filter(question => !question.answer);
    await this.store.update(data => {
      const thread = data.threads[key];
      thread.status = state.status;
      if (lastRequestId) thread.lastStateRequestId = lastRequestId;
      thread.live = state.status === 'running' || !!state.activeTurnId && !['error', 'interrupted'].includes(state.status);
      for (const field of ['inputRevision', 'consumedInputRevision', 'controlRevision', 'pendingInputCount']) if (Number.isSafeInteger(state[field])) thread[field] = state[field];
      if (!state.activeTurnId && ['waiting-for-user', 'idle'].includes(state.status)) {
        const completed = state.acceptedRequestIds || [];
        thread.settledRequestIds = [...new Set([...(thread.settledRequestIds || []), ...completed])].slice(-100);
      }
      if (!thread.live && !state.pendingInputCount && state.status !== 'interrupted' && state.acceptedRequestIds?.includes(thread.awaitingReplyId)) delete thread.awaitingReplyId;
      if (state.status === 'interrupted') delete thread.awaitingReplyId;
      const pending = this.eventStreams.get(key);
      thread.nextPoll = pending?.latest && !pending.controller.signal.aborted && pending.projectId === thread.projectId && pending.conversationId === thread.conversationId
        ? 0 : Date.now() + (thread.live || thread.awaitingReplyId ? this.pollMs : 15000); thread.error = null;
      if (Object.values(data.reactionOutbox || {}).some(item => item.key === key && item.status === 'pending')) thread.nextPoll = Math.min(thread.nextPoll, Date.now() + this.pollMs);
      thread.pendingQuestionId = openQuestions.length === 1 ? openQuestions[0].id : null;
    });
  }
  async notifyItemChanges(key) {
    const thread = this.store.data.threads[key], project = await this.readProject(thread.projectId, thread.userId, `${key}:${Date.now()}`);
    const nodes = nodesOf(project.map);
    for (const [itemId, watch] of Object.entries(thread.watchedItems || {})) {
      const node = nodes.find(node => node.id === watch.nodeId), item = node?.[watch.kind === 'bug' ? 'bugs' : 'todos']?.find(item => item.id === itemId);
      const status = item ? item.status || (watch.kind === 'bug' ? 'open' : 'pending') : 'removed';
      if (watch.status && watch.status !== status) await this.io.post({ id: operationId(`${key}:${itemId}:${project.version}:${status}`, 'item-status'), channel: thread.channel, threadTs: thread.threadTs,
        text: `${item?.title || (watch.kind === 'bug' ? '已关联 Bug' : '已关联 TODO')}：${watch.status} → ${status}` });
      await this.store.update(data => { data.threads[key].watchedItems[itemId].status = status; });
    }
    await this.store.update(data => { data.threads[key].nextItemPoll = Date.now() + 30000; });
  }
  async unfurl(id, event) {
    const binding = this.store.data.threads[threadKey(this.teamId, event.channel, event.thread_ts || event.message_ts)];
    const projectId = binding?.projectId || this.store.data.channels[event.channel] || this.store.data.preferences[event.user];
    if (!projectId) return;
    const unfurls = {};
    for (const link of (event.links || []).slice(0, 5)) {
      let url; try { url = new URL(link.url); } catch { continue; }
      if (url.origin !== this.cloudOrigin || url.pathname !== `/projects/${encodeURIComponent(projectId)}`) continue;
      const project = await this.readProject(projectId, event.user, id);
      unfurls[link.url] = { blocks: [{ ...section(`*${escape(project.name || projectId)}*\n${nodesOf(project.map).length} 个 Map 节点 · Main`),
        // Keep exact version provenance in non-visible block identity, not prose.
        block_id: `map-preview:${digest([id, event.channel, event.message_ts, link.url, project.version])}` }] };
    }
    if (Object.keys(unfurls).length) await this.io.call('chat.unfurl', { channel: event.channel, ts: event.message_ts, unfurls });
  }
  async reportError(id, body, error) {
    const channel = body.channel?.id || body.channel_id || body.event?.channel || body.container?.channel_id;
    const threadTs = body.event?.thread_ts || body.event?.ts || body.message?.thread_ts || body.message?.ts;
    const user = body.user?.id || body.user_id || body.event?.user;
    if (channel) await this.io.call('chat.postEphemeral', { channel, user, ...(threadTs ? { thread_ts: threadTs } : {}), text: `操作失败（${error.code || 'INVALID_OPERATION'}）：${error.message}. 未提交的表单保留，请刷新后重开。` });
    else {
      const dm = await this.io.call('conversations.open', { users: user });
      await this.io.post({ id: operationId(id, 'report'), channel: dm.channel.id, text: `操作失败（${error.code || 'INVALID_OPERATION'}）：${error.message}` });
    }
  }
}
