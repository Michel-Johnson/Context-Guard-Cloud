import { hash } from '../shared/io.mjs';
import { MapError } from '../shared/map-model.mjs';

const fail = (code, message) => { throw new MapError(code, message, 409); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const operation = (id, suffix) => `slack-${hash(`${id}:${suffix}`)}`;
export const RECOVERY_ERRORS = Object.freeze(['RELEVANCE_UNAVAILABLE', 'RELEVANCE_INVALID_RESPONSE']);

// Derive only the original message's known transport IDs. This is not a
// general receipt reader and never accepts filesystem paths or arbitrary IDs.
export function recoveryScope(payload, actor, projectId) {
  if (!object(payload) || Object.keys(payload).some(key => !['inboxId', 'memberIds', 'snapshotHash', 'originalRequest'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(payload.snapshotHash || '') || !Array.isArray(payload.memberIds) ||
      !payload.memberIds.length || payload.memberIds.length > 20 || payload.memberIds[0] !== payload.inboxId ||
      new Set(payload.memberIds).size !== payload.memberIds.length || !object(payload.originalRequest)) {
    fail('RECOVERY_SNAPSHOT_INVALID', 'Recovery requires the exact original frozen text batch');
  }
  const pattern = new RegExp(`^message:${actor.teamId}:([DCG][A-Z0-9]{1,31}):(\\d+\\.\\d+)$`);
  const matches = payload.memberIds.map(id => typeof id === 'string' && id.match(pattern));
  if (matches.some(match => !match) || matches.some(match => match[1] !== matches[0][1]) ||
      matches.some((match, index) => index && Number(match[2]) <= Number(matches[index - 1][2]))) {
    fail('RECOVERY_SCOPE_MISMATCH', 'Recovery members must retain the original workspace, channel and order');
  }
  const inputIds = payload.memberIds.map(id => operation(id, 'submit'));
  const request = payload.originalRequest;
  // The actual f692b3 legacy writer persisted conversationId iff it had an
  // existing binding, before requesting classification. Absence is meaningful
  // only for this complete schema; null/undefined/unknown keys are not proof.
  if (Object.hasOwn(request, 'conversationId') || Object.keys(request).some(key => !['id', 'userId', 'projectId', 'payload'].includes(key)) ||
      request.id !== operation(payload.inboxId, 'relevance') || request.userId !== actor.userId ||
      typeof request.projectId !== 'string' || !request.projectId || projectId !== undefined && request.projectId !== projectId || !object(request.payload)) {
    fail('PROOF_UNAVAILABLE', 'The original legacy request does not prove its supported new-conversation path');
  }
  const part = request.payload;
  if (Object.keys(part).some(key => !['text', 'inputs', 'files', 'context', 'routing'].includes(key)) ||
      !Array.isArray(part.inputs) || part.inputs.length !== inputIds.length || part.inputs.some((input, index) =>
      !object(input) || Object.keys(input).some(key => !['id', 'text'].includes(key)) || input.id !== inputIds[index] || typeof input.text !== 'string') ||
      part.text !== part.inputs.map(input => input.text).join('\n\n') || !Array.isArray(part.files) || part.files.length || !Array.isArray(part.context) ||
      !object(part.routing) || !Array.isArray(part.routing.mentionedUsers)) {
    fail('RECOVERY_SNAPSHOT_INVALID', 'Recovery cannot invent missing input, routing, history or attachment data');
  }
  const createId = operation(payload.inboxId, 'create'), submitId = operation(payload.inboxId, 'batch-submit');
  return { inboxId: payload.inboxId, channelId: matches[0][1], inputIds, createId, submitId,
    conversationId: `chat-${hash(createId)}`, businessIds: [...new Set([submitId, ...inputIds])],
    participation: structuredClone(part), legacyFormat: 'f692b3-classified-batch-v1',
    snapshotHash: payload.snapshotHash, fingerprint: hash(JSON.stringify({ payload,
      actor: { teamId: actor.teamId, userId: actor.userId, channelId: matches[0][1] } })) };
}

export function requireEmptyRecoveryState(state, journal) {
  if (state !== null && state !== undefined && !object(state) || journal !== null && journal !== undefined && !object(journal) ||
      state?.messages !== undefined && !Array.isArray(state.messages) ||
      ['requests', 'batches', 'toolReceipts'].some(key => state?.[key] !== undefined && !object(state[key])) ||
      ['requests', 'batches', 'interrupts'].some(key => journal?.[key] !== undefined && !object(journal[key])) ||
      state?.activeTurnId || state?.activeInput || state?.pending || state?.status === 'interrupted' || state?.messages?.length ||
      state?.consumedInputRevision > 0 || journal?.revision > 0 || journal?.controlRevision > 0 ||
      Object.keys(state?.requests || {}).length || Object.keys(state?.batches || {}).length || Object.keys(state?.toolReceipts || {}).length ||
      Object.keys(journal?.requests || {}).length || Object.keys(journal?.batches || {}).length || Object.keys(journal?.interrupts || {}).length) {
    fail('UNKNOWN_BUSINESS_EFFECT', 'The original scope has accepted or unresolved effects; no new recovery projection is allowed');
  }
}
