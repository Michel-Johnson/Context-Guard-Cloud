import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, threadKey } from './store.mjs';
import { hasSlackContent } from './plugin.mjs';
import { recoveryScope, RECOVERY_ERRORS } from '../../../scripts/cloud/slack-recovery.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const human = event => ['message', 'app_mention'].includes(event?.type) && !event.bot_id && !event.bot_profile && !event.hidden &&
  (!event.subtype || event.subtype === 'file_share') && /^[UW][A-Z0-9]{1,31}$/.test(event.user || '');

export function recoveryCandidate(data, inboxId, teamId) {
  const entry = data.inbox[inboxId], batch = entry?.batchId && data.messageBatches?.[entry.batchId];
  const memberIds = batch?.ids || [inboxId];
  if (memberIds[0] !== inboxId || !entry || entry.status !== 'attention' || !RECOVERY_ERRORS.includes(entry.error) ||
      entry.attempts !== 3 || entry.relevanceAttempts !== 3 || entry.relevance || entry.participation || entry.projectResume || !entry.relevanceRequest || batch && !batch.frozen) {
    fail('RECOVERY_NOT_ELIGIBLE', 'Only an unresolved original participation failure may request operator recovery');
  }
  const members = memberIds.map(id => ({ id, item: data.inbox[id] }));
  if (members.some(({ item }) => !item || item.status !== 'attention' || item.relevanceAttempts !== 3 ||
      !RECOVERY_ERRORS.includes(item.error) || item.relevance || item.participation || item.projectResume || item.envelope?.type !== 'events_api' ||
      item.envelope.body?.team_id !== teamId || !human(item.envelope.body.event) || item.envelope.body.event.files?.length)) {
    fail('RECOVERY_NOT_ELIGIBLE', 'Recovery preserves every original human batch member and refuses unresolved attachments');
  }
  const events = members.map(({ item }) => item.envelope.body.event);
  if (events.some(event => event.user !== events[0].user || event.channel !== events[0].channel)) fail('RECOVERY_SCOPE_MISMATCH', 'Recovery cannot mix original actors or channels');
  const request = entry.relevanceRequest;
  const snapshotHash = digest({ members, batch: batch || null });
  const descriptor = { inboxId, memberIds: [...memberIds], snapshotHash, originalRequest: structuredClone(request) };
  const actor = { kind: 'human', sessionId: `slack:${teamId}:${events[0].user}`, integration: 'slack', teamId,
    userId: events[0].user, channelId: events[0].channel };
  const scope = recoveryScope(descriptor, actor, request.projectId);
  if (request.payload.text !== events.map(event => event.text || '').join('\n\n') ||
      request.payload.inputs.some((input, index) => input.text !== (events[index].text || '')) ||
      batch?.projectId && batch.projectId !== request.projectId) fail('RECOVERY_SCOPE_MISMATCH', 'The original snapshot does not match its frozen message batch');
  const rootTs = batch?.rootTs || events[0].thread_ts || events[0].ts;
  const key = threadKey(teamId, events[0].channel, rootTs), binding = data.threads[key];
  if (binding && (binding.projectId !== request.projectId || binding.conversationId !== scope.conversationId)) {
    fail('PROOF_UNAVAILABLE', 'An existing conversation cannot be replaced by the derived new-conversation scope');
  }
  const directKey = digest([teamId, events[0].channel, events[0].user, request.projectId]);
  if (events[0].channel.startsWith('D') && data.directThreads?.[directKey] && data.directThreads[directKey] !== key ||
      entry.replyContext?.answerTo || binding?.pendingQuestionId || binding?.projectSwitch) fail('PROOF_UNAVAILABLE', 'The original scope cannot borrow a later conversation or answer');
  return { descriptor, scope, actor, events: structuredClone(events), projectId: request.projectId, key,
    event: { ...structuredClone(events[0]), ...(rootTs !== events[0].ts ? { thread_ts: rootTs } : {}) },
    original: members.map(({ id, item }) => ({ id, attempts: item.attempts, relevanceAttempts: item.relevanceAttempts, error: item.error })) };
}

function controlRequest(value) {
  if (!object(value) || Object.keys(value).some(key => !['v', 'operationId', 'mode', 'inboxId', 'snapshotHash', 'expectedPid', 'expectedSourceHash', 'reason'].includes(key)) ||
      value.v !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId || '') || !['preflight', 'apply'].includes(value.mode) ||
      typeof value.inboxId !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotHash || '') ||
      !Number.isSafeInteger(value.expectedPid) || value.expectedPid <= 0 || !/^[a-f0-9]{64}$/.test(value.expectedSourceHash || '') ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) fail('INVALID_OPERATOR_REQUEST', 'Use the fixed scoped operator recovery request');
  return value;
}
export async function operatorDirectory(directory, gid) {
  if (process.platform === 'win32' || !path.isAbsolute(directory)) fail('OPERATOR_CONTROL_UNAVAILABLE', 'Recovery requires a protected Unix operator directory');
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== gid || (metadata.mode & 0o777) !== 0o750 ||
      await fs.realpath(directory) !== path.resolve(directory)) fail('UNSAFE_OPERATOR_DIRECTORY', 'Operator requests must be root-owned and service-readable, never service-writable');
  for (let parent = path.dirname(directory); ; parent = path.dirname(parent)) {
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('UNSAFE_OPERATOR_DIRECTORY', 'Operator directory ancestors must be administrator-owned and not writable by the service');
    if (parent === path.dirname(parent)) break;
  }
  return metadata;
}
export async function recoverySourceHash() {
  const files = ['main.mjs', 'plugin.mjs', 'store.mjs', 'recovery.mjs', 'gateway.mjs',
    '../../../scripts/cloud/slack-recovery.mjs', '../../../scripts/cloud/integration-gateway.mjs',
    '../../../scripts/cloud/server.mjs', '../../../scripts/cloud/coordinator-service.mjs', '../../../scripts/cloud/coordinator-model.mjs'];
  return digest(await Promise.all(files.map(async file => [file, digest(await fs.readFile(new URL(file, import.meta.url), 'utf8'))])));
}
export async function readRecoveryCapsule(directory, filename) {
  if (process.platform === 'win32' || !path.isAbsolute(directory) || !/^[a-f0-9]{64}\.json$/.test(filename)) fail('OPERATOR_CONTROL_UNAVAILABLE', 'Recovery capsules require a protected Unix operator directory');
  const parent = await operatorDirectory(directory, process.getgid());
  const file = path.join(directory, filename), handle = await fs.open(file, 'r');
  try {
    const metadata = await handle.stat(), named = await fs.lstat(file);
    if (!metadata.isFile() || named.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== parent.gid || (metadata.mode & 0o777) !== 0o640 ||
        metadata.ino !== named.ino || metadata.dev !== named.dev || metadata.size > 16 * 1024) fail('UNSAFE_OPERATOR_REQUEST', 'Only the approved root-owned request may authorize recovery');
    const request = controlRequest(JSON.parse(await handle.readFile('utf8')));
    if (filename !== digest(request.operationId) + '.json') fail('INVALID_OPERATOR_REQUEST', 'The capsule filename must bind its stable control ID');
    return request;
  } finally { await handle.close(); }
}

// This controller runs inside the existing Slack process and writes only
// through its serial Store owner. The operator never edits state.json.
export class SlackRecoveryControl {
  constructor({ plugin, directory, sourceHash, readApproved = readRecoveryCapsule }) {
    Object.assign(this, { plugin, directory, sourceHash, readApproved }); this.active = null;
  }
  localIdle(candidate) {
    const { plugin } = this, { event, projectId, descriptor, key } = candidate;
    if (plugin.stopped) fail('RECOVERY_BUSY', 'The existing Slack owner is stopping');
    if (plugin.routedThreadKey(event) !== key) fail('RECOVERY_SCOPE_MISMATCH', 'A later project route cannot receive the original recovery');
    if (candidate.scope.participation.routing.coordinatorUserId !== plugin.botUserId) fail('RECOVERY_SCOPE_MISMATCH', 'The original Coordinator recipient changed');
    if (descriptor.memberIds.some(id => plugin.processing.has(id)) || plugin.messageLanes.has(plugin.entryLane(plugin.store.data.inbox[descriptor.inboxId])) ||
        Object.values(plugin.store.data.inbox).some(item => item.status === 'pending' && plugin.entryLane(item) === plugin.entryLane(plugin.store.data.inbox[descriptor.inboxId]))) {
      fail('RECOVERY_BUSY', 'New ordinary inputs have priority over this historical recovery');
    }
    const binding = plugin.store.data.threads[key];
    const currentProject = binding?.projectId || (event.channel.startsWith('D') ? plugin.store.data.preferences[event.user] : plugin.store.data.channels[event.channel]);
    if (currentProject !== projectId) fail('RECOVERY_SCOPE_MISMATCH', 'The original project is no longer current');
    if (recoveryCandidate(plugin.store.data, descriptor.inboxId, plugin.teamId).descriptor.snapshotHash !== descriptor.snapshotHash) {
      fail('RECOVERY_SNAPSHOT_CHANGED', 'The frozen original snapshot changed while checking permission');
    }
  }
  async scopeCurrent(candidate) {
    const { plugin } = this, { event, projectId, descriptor } = candidate;
    this.localIdle(candidate);
    if (!(await plugin.loadProjects(event.user, descriptor.inboxId)).some(project => project.id === projectId && (!project.private || event.channel.startsWith('D')))) {
      fail('RECOVERY_SCOPE_MISMATCH', 'The original project is no longer available in this channel');
    }
    if (event.channel.startsWith('D')) {
      if ((await plugin.io.call('conversations.info', { channel: event.channel })).channel?.user !== event.user) fail('FORBIDDEN', 'The original direct conversation is no longer verified');
    } else {
      let cursor = '', found = false;
      for (let page = 0; page < 4; page++) {
        const response = await plugin.io.call('conversations.members', { channel: event.channel, limit: 200, ...(cursor ? { cursor } : {}) });
        if (response.members?.includes(event.user)) { found = true; break; }
        cursor = response.response_metadata?.next_cursor || ''; if (!cursor) break;
      }
      if (!found) fail('FORBIDDEN', 'Current membership in the original channel could not be verified');
    }
    this.localIdle(candidate);
  }
  async handleApproved(value) {
    const request = controlRequest(value), { plugin } = this, { operationId } = request;
    if (request.expectedPid !== process.pid || request.expectedSourceHash !== this.sourceHash ||
        Number(await fs.readFile(path.join(plugin.store.directory, 'process.lock'), 'utf8')) !== process.pid) fail('STALE_OPERATOR_OWNER', 'The approved source and single process owner must still match');
    const fingerprint = digest({ ...request, mode: undefined, expectedPid: undefined });
    let previous = plugin.store.data.recoveries?.[operationId];
    if (previous && previous.fingerprint !== fingerprint) fail('ID_REUSED', 'Operator ID belongs to another target or approval');
    if (previous && ['dispatching', 'unknown'].includes(previous.status) && request.mode === 'apply' && previous.transport && previous.replayOwnerPid !== process.pid) {
      const candidate = recoveryCandidate(plugin.store.data, request.inboxId, plugin.teamId);
      if (candidate.descriptor.snapshotHash !== request.snapshotHash) fail('RECOVERY_SNAPSHOT_CHANGED', 'The original frozen recovery snapshot changed');
      await this.scopeCurrent(candidate);
      this.localIdle(candidate);
      const lane = plugin.entryLane(plugin.store.data.inbox[request.inboxId]);
      plugin.messageLanes.set(lane, `recovery:${operationId}`);
      try {
        await plugin.store.update(state => { state.recoveries[operationId].replayOwnerPid = process.pid; });
        await plugin.gateway.command('conversation.submit', structuredClone(previous.transport));
        await plugin.store.update(state => Object.assign(state.recoveries[operationId], { status: 'accepted', key: candidate.key, inputIds: candidate.scope.inputIds }));
      } catch (error) { await plugin.store.update(state => {
        const audit = state.recoveries[operationId], code = error.code || 'RECOVERY_UNAVAILABLE';
        audit.firstFailure ||= { code, phase: audit.status, at: Date.now() }; audit.code ||= code;
        Object.assign(audit, { status: 'unknown', latestCode: code });
      }); } finally { if (plugin.messageLanes.get(lane) === `recovery:${operationId}`) plugin.messageLanes.delete(lane); }
      return plugin.store.data.recoveries[operationId];
    }
    if (previous && !['checking', 'preflighted'].includes(previous.status)) return previous;
    if (request.mode === 'preflight' && previous?.status === 'preflighted') return previous;
    if (!previous) await plugin.store.update(state => {
      (state.recoveries ||= {})[operationId] = { fingerprint, inboxId: request.inboxId, snapshotHash: request.snapshotHash,
        reason: request.reason, ownerPid: process.pid, sourceHash: this.sourceHash, status: 'checking', epoch: 0, at: Date.now() };
    });
    let lane;
    try {
      const candidate = recoveryCandidate(plugin.store.data, request.inboxId, plugin.teamId);
      if (candidate.descriptor.snapshotHash !== request.snapshotHash) fail('RECOVERY_SNAPSHOT_CHANGED', 'The exact approved original snapshot is no longer current');
      await this.scopeCurrent(candidate);
      const proof = await plugin.gateway.command('recovery.preflight', { id: `recover-check-${digest(operationId)}`, userId: candidate.actor.userId,
        projectId: candidate.projectId, payload: candidate.descriptor });
      if (!proof.noBusinessEffect || proof.conversationId !== candidate.scope.conversationId || proof.scopeHash !== candidate.scope.fingerprint) fail('PROOF_UNAVAILABLE', 'Authoritative recovery proof is missing or does not match the original scope');
      if (request.mode === 'preflight') {
        await plugin.store.update(state => Object.assign(state.recoveries[operationId], { status: 'preflighted', original: candidate.original, format: candidate.scope.legacyFormat, proofHash: proof.scopeHash }));
      } else {
        if (!previous || previous.status !== 'preflighted') fail('PRECHECK_REQUIRED', 'Review the formal preflight before applying one recovery attempt');
        await this.scopeCurrent(candidate);
        if (recoveryCandidate(plugin.store.data, request.inboxId, plugin.teamId).descriptor.snapshotHash !== request.snapshotHash) fail('RECOVERY_SNAPSHOT_CHANGED', 'The approved original scope changed before dispatch');
        this.localIdle(candidate);
        lane = plugin.entryLane(plugin.store.data.inbox[request.inboxId]);
        plugin.messageLanes.set(lane, `recovery:${operationId}`);
        await plugin.store.update(state => Object.assign(state.recoveries[operationId], { status: 'dispatching', epoch: 1, descriptor: candidate.descriptor }));
        await plugin.message(request.inboxId, candidate.event, candidate.projectId, candidate.events, { operationId,
          descriptor: candidate.descriptor, conversationId: candidate.scope.conversationId });
        await plugin.store.update(state => Object.assign(state.recoveries[operationId], { status: 'accepted', key: candidate.key, inputIds: candidate.scope.inputIds }));
      }
    } catch (error) {
      await plugin.store.update(state => {
        const audit = state.recoveries[operationId], code = error.code || 'RECOVERY_UNAVAILABLE';
        audit.firstFailure ||= { code, phase: audit.status, at: Date.now() }; audit.code ||= code;
        Object.assign(audit, { status: audit.epoch ? 'unknown' : 'refused', latestCode: code });
      });
    } finally { if (lane && plugin.messageLanes.get(lane) === `recovery:${operationId}`) plugin.messageLanes.delete(lane); }
    return plugin.store.data.recoveries[operationId];
  }
  poll() {
    if (this.active || this.plugin.stopped) return;
    this.active = this.run().catch(error => this.plugin.logger.warn('Operator recovery unavailable', { code: error.code || 'RECOVERY_UNAVAILABLE' })).finally(() => { this.active = null; });
  }
  async run() {
    const files = (await fs.readdir(this.directory)).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
    if (files.length > 32) fail('OPERATOR_CAPACITY', 'Operator recovery is limited to 32 retained capsules; no requests are silently skipped');
    for (const file of files) {
      if (this.plugin.stopped) return;
      try { await this.handleApproved(await this.readApproved(this.directory, file)); }
      catch (error) { this.plugin.logger.warn('Operator recovery request rejected', { code: error.code || 'RECOVERY_UNAVAILABLE' }); }
    }
    for (const [operationId, audit] of Object.entries(this.plugin.store.data.recoveries || {})) if (audit.status === 'accepted') {
      const binding = this.plugin.store.data.threads[audit.key];
      if (!binding) continue;
      const state = await this.plugin.command('conversation.state', binding, binding.userId, `recover-state-${digest(operationId)}`);
      let status;
      if (['error', 'interrupted'].includes(state.status)) status = state.status === 'error' ? 'unavailable' : 'stopped';
      else if (state.participationRequestIds?.some(id => !audit.inputIds.includes(id))) status = 'superseded';
      else if (!state.activeTurnId && state.status === 'waiting-for-user' && state.participationRequestIds?.length &&
          state.participationRequestIds.length === audit.inputIds.length &&
          ['reply', 'silent'].includes(state.participationDecision)) {
        const messages = state.messages.filter(message => message.role === 'assistant' && audit.inputIds.includes(message.requestId) && !message.partial);
        const deliveryDone = messages.every(message => {
          const actions = message.actions || [];
          // The switch adapter replaces this message with its dedicated result
          // and never creates a raw-body slot. Unsupported mixed actions stay
          // unconfirmed; a switch ACK cannot stand in for another presentation.
          const switches = actions.filter(action => action?.kind === 'project-switch');
          if (switches.length) return actions.length === 1 && typeof switches[0].actionId === 'string' && !!switches[0].actionId &&
            this.plugin.store.data.projectSwitches?.[`project-switch-${digest([audit.key, switches[0].actionId])}`]?.announced === true;
          if (hasSlackContent(message) && !binding.mirrored[message.id]?.ts) return false;
          return actions.every(action => action?.kind === 'binding-proposal' ? typeof action.id === 'string' && !!action.id &&
            !!binding.mirrored[`binding:${action.id}`]?.ts : true);
        });
        const actions = messages.flatMap(message => (message.actions || []).filter(action => action.kind === 'slack-reaction'));
        const reactionsDone = actions.every(action => this.plugin.store.data.reactionOutbox?.[`reaction-${digest([audit.key, action.actionId])}`]?.status === 'sent');
        if (state.participationDecision === 'silent' || messages.length && deliveryDone && reactionsDone) status = 'completed';
      }
      if (status) await this.plugin.store.update(value => Object.assign(value.recoveries[operationId], { status, completedAt: Date.now() }));
    }
  }
  async close() { await this.active; }
}
