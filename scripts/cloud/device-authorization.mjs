import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { fail } from '../shared/protocol.mjs';
import { repositorySlug } from './protocol-auth.mjs';

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const equal = (a, b) => secretPattern.test(a || '') && secretPattern.test(b || '') && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Pending requests survive until a human decides. Secrets are hashed; credentials are
// issued only after browser approval and are never retained in this ledger.
export class DeviceAuthorization {
  constructor({ directory, authorizeRepository, issueDevice, now = Date.now, lifetimeMs = 600000 }) {
    this.file = path.join(directory, 'device-authorizations.json');
    this.authorizeRepository = authorizeRepository; this.issueDevice = issueDevice;
    this.now = now; this.lifetimeMs = lifetimeMs; this.attempts = new Map();
  }
  limit(address) {
    const time = this.now(), prior = this.attempts.get(address);
    for (const [key, value] of this.attempts) if (value.until <= time) this.attempts.delete(key);
    if (prior?.until > time && prior.count >= 20 || !prior && this.attempts.size >= 10000) fail('FORBIDDEN', 'Authorization attempts temporarily rate limited');
    this.attempts.set(address, { count: prior?.until > time ? prior.count + 1 : 1, until: prior?.until > time ? prior.until : time + 60000 });
  }
  async transaction(action) {
    return withFileLock(this.file + '.lock', async () => {
      const state = await readJSON(this.file, { grants: {} });
      const before = encode(state);
      for (const grant of Object.values(state.grants)) {
        grant.requestId ||= randomUUID();
        grant.createdAt ??= null;
        if (grant.status === 'pending' && !grant.claimed) {
          grant.csrfExpiresAt ??= grant.expiresAt || 0;
          grant.expiresAt = null;
        }
      }
      const result = await action(state);
      const after = encode(state);
      if (after !== before) await atomicWrite(this.file, after);
      return result;
    });
  }
  async start(input, address, persistent = false) {
    this.limit(address);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['repository', 'clientId', 'deviceCode', 'label'].includes(k)) ||
        typeof input.clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientId) || !secretPattern.test(input.deviceCode) ||
        typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\x00-\x1f]/.test(input.label)) fail('INVALID_ARGUMENT', 'Invalid device authorization request');
    const slug = repositorySlug(input.repository), repositoryId = await this.authorizeRepository(slug);
    if (!repositoryId) fail('FORBIDDEN', 'Repository is not authorized');
    return this.transaction(async state => {
      const key = hash(input.deviceCode), time = this.now();
      let grant = state.grants[key];
      if (grant && (grant.repository !== slug || grant.repositoryId !== repositoryId || grant.clientId !== input.clientId || grant.label !== input.label)) fail('ID_REUSED', 'Authorization request identity changed');
      if (grant?.claimed) fail('UNAUTHORIZED', 'Authorization was already claimed; start a new request', { reason: 'authorization-already-claimed' });
      if (grant?.status === 'denied') fail('FORBIDDEN', 'Device authorization was declined', { reason: 'authorization-denied' });
      if (grant?.status === 'approved' && grant.expiresAt <= time) fail('UNAUTHORIZED', 'Authorization claim expired; start a new request', { reason: 'authorization-expired' });
      if (!grant) {
        let pending = 0;
        for (const existing of Object.values(state.grants)) if (!existing.claimed && existing.status === 'pending' && await this.authorizeRepository(existing.repository) === existing.repositoryId) pending++;
        if (pending >= 1000) fail('UNAVAILABLE', 'Too many pending authorizations');
        let userCode;
        do {
          const bytes = randomBytes(4).toString('hex').toUpperCase(); userCode = bytes.slice(0, 4) + '-' + bytes.slice(4);
        } while (Object.values(state.grants).some(value => value.userCode === userCode));
        grant = state.grants[key] = { repository: slug, repositoryId, clientId: input.clientId, label: input.label,
          requestId: randomUUID(), createdAt: new Date(time).toISOString(), userCode, csrf: randomBytes(32).toString('base64url'), csrfExpiresAt: time + this.lifetimeMs, expiresAt: null, status: 'pending' };
      }
      const unlimited = persistent && grant.status === 'pending';
      const expiresAt = grant.status === 'pending' ? time + this.lifetimeMs : grant.expiresAt;
      return { requestId: grant.requestId, status: grant.status, ...(persistent ? { persistent: unlimited } : {}), userCode: grant.userCode,
        expiresAt: unlimited ? null : new Date(expiresAt).toISOString(), expiresIn: unlimited ? null : Math.ceil((expiresAt - time) / 1000), interval: 5 };
    });
  }
  async view(code, address) {
    this.limit(address);
    if (!codePattern.test(code || '')) fail('INVALID_ARGUMENT', 'Invalid authorization code');
    return this.transaction(async state => {
      const grant = Object.values(state.grants).find(value => value.userCode === code);
      if (!grant) fail('NOT_FOUND', 'Authorization was not found');
      if (await this.authorizeRepository(grant.repository) !== grant.repositoryId) fail('FORBIDDEN', 'Repository access revoked', { reason: 'repository-access-revoked' });
      return { ...grant, status: grant.status === 'approved' && grant.expiresAt <= this.now() ? 'expired' : grant.status };
    });
  }
  async list(repository, repositoryId, summary = false) {
    return this.transaction(async state => {
      if (await this.authorizeRepository(repository) !== repositoryId) fail('FORBIDDEN', 'Repository access revoked', { reason: 'repository-access-revoked' });
      const requests = Object.values(state.grants).filter(grant => grant.repository === repository && grant.repositoryId === repositoryId && grant.status === 'pending' && !grant.claimed)
        .map(({ requestId, repository, label, status, createdAt }) => ({ requestId, repository, label, status, createdAt }));
      return summary ? { count: requests.length } : { count: requests.length, requests };
    });
  }
  async detail(requestId, repository, repositoryId) {
    return this.transaction(async state => {
      const grant = Object.values(state.grants).find(value => value.requestId === requestId && value.repository === repository && value.repositoryId === repositoryId);
      if (!grant) fail('NOT_FOUND', 'Authorization was not found');
      if (await this.authorizeRepository(repository) !== repositoryId) fail('FORBIDDEN', 'Repository access revoked', { reason: 'repository-access-revoked' });
      const safe = { requestId, repository, label: grant.label, status: grant.claimed ? 'claimed' : grant.status === 'approved' && grant.expiresAt <= this.now() ? 'expired' : grant.status, createdAt: grant.createdAt };
      if (grant.status === 'pending' && !grant.claimed) {
        grant.csrf = randomBytes(32).toString('base64url'); grant.csrfExpiresAt = this.now() + this.lifetimeMs;
        return { ...safe, userCode: grant.userCode, csrf: grant.csrf };
      }
      return safe;
    });
  }
  async decide({ userCode, csrf, decision, repository, repositoryId }, address) {
    this.limit(address);
    if (!codePattern.test(userCode || '') || !['approve', 'deny'].includes(decision)) fail('INVALID_ARGUMENT', 'Invalid authorization decision');
    return this.transaction(async state => {
      const grant = Object.values(state.grants).find(value => value.userCode === userCode);
      if (repository !== undefined && (!grant || grant.repository !== repository || grant.repositoryId !== repositoryId)) fail('NOT_FOUND', 'Authorization was not found');
      if (!grant || !equal(csrf, grant.csrf) || grant.csrfExpiresAt <= this.now()) fail('FORBIDDEN', 'Authorization form expired; reload it');
      if (grant.claimed || grant.status !== 'pending') fail('CONFLICT', 'Authorization already decided');
      if (await this.authorizeRepository(grant.repository) !== grant.repositoryId) fail('FORBIDDEN', 'Repository access revoked', { reason: 'repository-access-revoked' });
      grant.status = decision === 'approve' ? 'approved' : 'denied';
      grant.expiresAt = decision === 'approve' ? this.now() + this.lifetimeMs : null;
      return { status: grant.status };
    });
  }
  async poll(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'deviceCode') || !secretPattern.test(input.deviceCode)) fail('INVALID_ARGUMENT', 'Invalid authorization claim');
    return this.transaction(async state => {
      const grant = state.grants[hash(input.deviceCode)];
      if (!grant) fail('UNAUTHORIZED', 'Authorization expired; start a new request', { reason: 'authorization-expired' });
      if (grant.claimed) fail('UNAUTHORIZED', 'Authorization already claimed; if its reply was lost, start a new request', { reason: 'authorization-already-claimed' });
      if (grant.status === 'denied') fail('FORBIDDEN', 'Device authorization was declined', { reason: 'authorization-denied' });
      if (await this.authorizeRepository(grant.repository) !== grant.repositoryId) fail('FORBIDDEN', 'Repository access revoked', { reason: 'repository-access-revoked' });
      if (grant.status === 'pending') return { data: { status: 'pending', interval: 5 } };
      if (grant.expiresAt <= this.now()) fail('UNAUTHORIZED', 'Authorization claim expired; start a new request', { reason: 'authorization-expired' });
      // Persist consumption before issuing. A crash cannot make the same grant
      // issue twice; an uncertain claim requires a new browser authorization.
      grant.claimed = true;
      await atomicWrite(this.file, encode(state));
      return this.issueDevice(`https://github.com/${grant.repository}`, grant.clientId);
    });
  }
}
