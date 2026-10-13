import path from 'node:path';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { canonical, fail, payloadRules } from '../shared/protocol.mjs';
import { MapError } from '../shared/map-model.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const registeredId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const version = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export class CoordinatorSessionGrants {
  constructor(directory, { now = Date.now } = {}) {
    this.file = path.join(directory, 'session-grants.json');
    this.now = now;
  }
  async read() {
    return readJSON(this.file, { revision: 0, grants: {}, receipts: {}, audit: [] });
  }
  public(state) {
    return { version: hash(encode({ revision: state.revision, grants: state.grants })), grants: Object.values(state.grants) };
  }
  async state() { return this.public(await this.read()); }
  async change(input, bindingFor, actor) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => ![
      'operationId', 'baseVersion', 'action', 'sessionId', 'deviceId', 'worktreeId', 'generation', 'bindingVersion', 'nodeIds', 'expiresAt',
    ].includes(key)) || !identifier(input.operationId) || !version(input.baseVersion) || !registeredId(input.sessionId) ||
      !['grant', 'revoke'].includes(input.action)) fail('INVALID_ARGUMENT', 'Provide a versioned Session grant or revocation');
    if (input.action === 'grant' && (!registeredId(input.deviceId) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !(input.nodeIds === null || Array.isArray(input.nodeIds) && input.nodeIds.length > 0 && input.nodeIds.length <= 1000 &&
        input.nodeIds.every(identifier) && new Set(input.nodeIds).size === input.nodeIds.length) ||
      typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) {
      fail('INVALID_ARGUMENT', 'Provide the registered device, worktree, generation, node scope and expiration');
    }
    if (input.action === 'grant') payloadRules['session.bind']({ sessionId: input.sessionId, agentId: input.sessionId,
      worktreeId: input.worktreeId, expectedBindingVersion: input.bindingVersion });
    if (input.action === 'revoke' && Object.keys(input).some(key => !['operationId', 'baseVersion', 'action', 'sessionId'].includes(key))) {
      fail('INVALID_ARGUMENT', 'Revocation accepts only the Session and operation identity');
    }
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.read(), key = hash(input.operationId), fingerprint = hash(canonical(input));
      const previous = state.receipts[key];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', 'Grant operation ID belongs to another request');
        return previous.result;
      }
      if (input.baseVersion !== this.public(state).version) throw new MapError('VERSION_CONFLICT', 'Session grants changed; read their current version', 409);
      if (input.action === 'grant') {
        if (Date.parse(input.expiresAt) <= this.now()) fail('INVALID_ARGUMENT', 'Grant expiration must be in the future');
        const binding = await bindingFor(input.sessionId);
        if (!binding || ['deviceId', 'worktreeId', 'generation'].some(key => binding[key] !== input[key]) || binding.version !== input.bindingVersion) {
          fail('FORBIDDEN', 'Grant must match the current registered Session binding');
        }
        state.grants[hash(input.sessionId)] = { sessionId: input.sessionId, deviceId: binding.deviceId, worktreeId: binding.worktreeId,
          generation: binding.generation, bindingVersion: binding.version, nodeIds: input.nodeIds, expiresAt: input.expiresAt,
          operationId: input.operationId };
      } else delete state.grants[hash(input.sessionId)];
      state.revision++;
      const at = new Date(this.now()).toISOString(), result = { version: this.public(state).version, operationId: input.operationId,
        persistedAt: at, sessionId: input.sessionId, grant: state.grants[hash(input.sessionId)] || null };
      state.audit.push({ action: input.action, sessionId: input.sessionId, operationId: input.operationId, actor, at,
        ...(input.action === 'grant' ? { grant: state.grants[hash(input.sessionId)] } : {}) });
      state.receipts[key] = { fingerprint, result };
      await atomicWrite(this.file, encode(state));
      return result;
    });
  }
  async authorize(principal, session, bindingFor) {
    if (!session || Object.keys(session).some(key => !['id', 'generation'].includes(key)) || !registeredId(session.id) ||
      !Number.isSafeInteger(session.generation) || session.generation < 1) fail('FORBIDDEN', 'A registered Coordinator Session is required');
    const grant = (await this.read()).grants[hash(session.id)];
    const binding = await bindingFor(session.id);
    if (!grant || Date.parse(grant.expiresAt) <= this.now() || !binding ||
      grant.deviceId !== principal.deviceId || binding.deviceId !== principal.deviceId || grant.sessionId !== session.id ||
      grant.generation !== session.generation || binding.generation !== session.generation ||
      grant.worktreeId !== binding.worktreeId || grant.bindingVersion !== binding.version) {
      fail('FORBIDDEN', 'Coordinator Session grant is absent, expired, revoked or bound elsewhere');
    }
    return grant;
  }
  async withAuthorized(principal, session, bindingFor, commit) {
    // Revocation and Main commits share this lock, so a revoked grant cannot commit later.
    return withFileLock(this.file + '.lock', async () => commit(await this.authorize(principal, session, bindingFor)));
  }
}
