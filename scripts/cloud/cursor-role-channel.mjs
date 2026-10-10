import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { canonical, MAX_MESSAGE_BYTES, validateMessage } from '../shared/protocol.mjs';
import { reduceWorkflow, scopedObjectKey } from '../shared/protocol-workflow.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[a-f0-9]{40}$/;
const capability = /^cgc_[A-Za-z0-9_-]{43}$/;
const nativeId = value => typeof value === 'string' && value.startsWith('bc-') && uuid.test(value.slice(3));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: code === 'INVALID_ARGUMENT' ? 400 : code === 'ROLE_UNAVAILABLE' ? 503 : code === 'ID_REUSED' ? 409 : 403 }); };
const bindingKey = (scope, session) => hash(canonical([scope.repositoryId, session.id]));
export const CURSOR_PLAN_CONTINUATIONS = 2;

function validateScope(scope) {
  const fields = ['projectId', 'repositoryId', 'ownerId', 'session', 'actor', 'worktreeId', 'actorWorktreeId', 'nativeAgentId', 'taskId', 'phase', 'sourceSha', 'plan', 'ciPolicyHash', 'attempt'];
  const validSession = session => record(session) && Object.keys(session).every(key => ['id', 'generation'].includes(key)) && uuid.test(session.id || '') && Number.isSafeInteger(session.generation) && session.generation > 0;
  if (!record(scope) || Object.keys(scope).some(key => !fields.includes(key)) ||
      ['projectId', 'repositoryId', 'ownerId', 'worktreeId', 'actorWorktreeId', 'taskId'].some(key => !bounded(scope[key])) ||
      !validSession(scope.session) || !validSession(scope.actor) || !['plan', 'execution', 'ci'].includes(scope.phase) ||
      scope.attempt !== undefined && (scope.phase !== 'plan' || !Number.isSafeInteger(scope.attempt) || scope.attempt < 1 || scope.attempt > CURSOR_PLAN_CONTINUATIONS) ||
      !nativeId(scope.nativeAgentId) || !sha.test(scope.sourceSha || '') ||
      scope.phase === 'ci' && (scope.actor.id === scope.session.id || scope.actorWorktreeId === scope.worktreeId) ||
      scope.phase !== 'ci' && (canonical(scope.actor) !== canonical(scope.session) || scope.actorWorktreeId !== scope.worktreeId) ||
      scope.phase === 'execution' && (!record(scope.plan) || Object.keys(scope.plan).some(key => !['ref', 'version'].includes(key)) || !bounded(scope.plan.ref) || !bounded(scope.plan.version)) ||
      scope.phase !== 'execution' && scope.plan !== undefined || scope.ciPolicyHash !== undefined && !/^[a-f0-9]{64}$/.test(scope.ciPolicyHash)) fail('INVALID_ARGUMENT', 'Bind a Cursor role to one project, task, registered Session and source revision');
  return structuredClone(scope);
}

// Cloud-owned credential bridge into the existing ProtocolStore. This does not
// schedule agents, approve plans or infer task success from native Run status.
// resolveReceiver must read the private provider ledger, not agent arguments.
export class CursorRoleChannel {
  constructor({ directory, store, resolveReceiver, deferHandoff, deferCi, now = Date.now }) {
    if (!path.isAbsolute(directory || '') || !store || typeof resolveReceiver !== 'function' || typeof now !== 'function' ||
        [deferHandoff, deferCi].some(fn => fn !== undefined && typeof fn !== 'function')) fail('INVALID_ARGUMENT', 'Use private role storage and a trusted receiver resolver');
    this.directory = directory; this.store = store; this.resolveReceiver = resolveReceiver; this.now = now;
    this.deferHandoff = deferHandoff;
    this.deferCi = deferCi;
  }

  async issue({ operationId, scope, ttlMs = 3600000 }) {
    if (!bounded(operationId) || !Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > 3600000) fail('INVALID_ARGUMENT', 'Use a stable operation and bounded role lifetime');
    scope = validateScope(scope);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const operation = hash(operationId), file = path.join(this.directory, 'operations', operation + '.json');
    const fingerprint = hash(canonical({ scope, ttlMs }));
    return withFileLock(file + '.lock', async () => {
      let lease = await readJSON(file, null);
      if (lease && lease.fingerprint !== fingerprint) fail('ID_REUSED', 'Role operation belongs to another delegation');
      if (!lease) {
        lease = { format: 1, fingerprint, scope, scopeHash: hash(canonical(scope)), token: 'cgc_' + randomBytes(32).toString('base64url'),
          state: 'dormant', expiresAt: this.now() + ttlMs };
        await atomicWrite(file, encode(lease));
      }
      // Reconstructing this index after a lost issue response does not renew or
      // reactivate a lease. The operation file is its only mutable authority.
      await atomicWrite(path.join(this.directory, 'tokens', hash(lease.token) + '.json'), encode({ operation }));
      return { token: lease.token, expiresAt: lease.expiresAt, state: lease.state };
    });
  }

  async withLease(token, action, { active = true } = {}) {
    if (!capability.test(token || '')) fail('ROLE_FORBIDDEN', 'Use the scoped Cursor role capability');
    const index = await readJSON(path.join(this.directory, 'tokens', hash(token) + '.json'), null);
    if (!/^[a-f0-9]{64}$/.test(index?.operation || '')) fail('ROLE_FORBIDDEN', 'Cursor delegation is unknown');
    const file = path.join(this.directory, 'operations', index.operation + '.json');
    return withFileLock(file + '.lock', async () => {
      const lease = await readJSON(file, null);
      if (!lease || lease.format !== 1 || lease.token !== token || hash(canonical(lease.scope)) !== lease.scopeHash) fail('ROLE_FORBIDDEN', 'Cursor delegation is invalid');
      if (lease.state === 'revoked' || !Number.isSafeInteger(lease.expiresAt) || this.now() >= lease.expiresAt) fail('ROLE_EXPIRED', 'Cursor delegation was revoked or expired');
      if (active && lease.state !== 'active') fail('ROLE_UNAVAILABLE', 'Cursor receiver has not been confirmed');
      return action(lease, file);
    });
  }

  async receiver(lease, state) {
    const receiver = await this.resolveReceiver(structuredClone(lease.scope), state);
    if (!receiver || receiver.active !== true || receiver.scopeHash !== lease.scopeHash || receiver.nativeAgentId !== lease.scope.nativeAgentId || !bounded(receiver.runId) ||
        lease.scope.phase === 'ci' && (!nativeId(receiver.executorNativeAgentId) || receiver.executorNativeAgentId === lease.scope.nativeAgentId) ||
        lease.runId && receiver.runId !== lease.runId) fail('ROLE_UNAVAILABLE', 'Cursor receiver or native Run changed');
    return receiver;
  }

  async activate(token) {
    return this.withLease(token, async (lease, file) => {
      const receiver = await this.receiver(lease);
      lease.state = 'active'; lease.runId = receiver.runId;
      await atomicWrite(file, encode(lease));
      return { state: lease.state, expiresAt: lease.expiresAt };
    }, { active: false });
  }

  async revoke(token) {
    // Revocation must also work after expiry; preserve the original receipt.
    if (!capability.test(token || '')) fail('ROLE_FORBIDDEN', 'Use the scoped Cursor role capability');
    const index = await readJSON(path.join(this.directory, 'tokens', hash(token) + '.json'), null);
    if (!/^[a-f0-9]{64}$/.test(index?.operation || '')) fail('ROLE_FORBIDDEN', 'Cursor delegation is unknown');
    const file = path.join(this.directory, 'operations', index.operation + '.json');
    return withFileLock(file + '.lock', async () => {
      const lease = await readJSON(file, null);
      if (!lease || lease.token !== token) fail('ROLE_FORBIDDEN', 'Cursor delegation is invalid');
      lease.state = 'revoked';
      await atomicWrite(file, encode(lease));
      return { state: 'revoked' };
    });
  }

  async mcpSession(token, { projectId, action, protocolVersion } = {}) {
    if (!['initialize', 'initialized', 'check'].includes(action)) fail('INVALID_ARGUMENT', 'Use the MCP lifecycle operations');
    return this.withLease(token, async (lease, file) => {
      if (lease.scope.projectId !== projectId) fail('ROLE_FORBIDDEN', 'Cursor delegation belongs to another project');
      // Discovery is safe before the provider confirms CREATE. No task data or
      // writes are available until activate() saves the confirmed native Run.
      if (action === 'initialize') {
        const supported = ['2025-03-26', '2025-06-18', '2025-11-25'];
        const version = supported.includes(protocolVersion) ? protocolVersion : supported.at(-1);
        if (lease.mcp && lease.mcp.protocolVersion !== version) fail('INVALID_ARGUMENT', 'Use a new role delegation when changing the negotiated MCP version');
        lease.mcp ||= { protocolVersion: version, initialized: false };
        await atomicWrite(file, encode(lease));
      } else {
        if (!lease.mcp || protocolVersion && protocolVersion !== lease.mcp.protocolVersion) fail('INVALID_ARGUMENT', 'Initialize MCP and use the negotiated version');
        if (action === 'initialized') {
          lease.mcp.initialized = true;
          await atomicWrite(file, encode(lease));
        } else if (!lease.mcp.initialized) fail('INVALID_ARGUMENT', 'Send notifications/initialized before calling tools');
      }
      return { phase: lease.scope.phase, protocolVersion: lease.mcp.protocolVersion };
    }, { active: false });
  }

  principal(scope) {
    return { repositoryId: scope.repositoryId, deviceId: scope.ownerId, agentId: scope.actor.id,
      role: scope.phase === 'ci' ? 'ci' : 'executor', ...(scope.phase === 'ci' ? { bindings: { [scope.session.id]: scope.worktreeId } } : {}) };
  }

  task(state, scope, principal) {
    const executor = state.bindings[bindingKey(scope, scope.session)], actor = state.bindings[bindingKey(scope, scope.actor)];
    if (!executor || executor.generation !== scope.session.generation || executor.worktreeId !== scope.worktreeId || executor.deviceId !== scope.ownerId ||
        executor.agentId !== scope.session.id || !actor || actor.generation !== scope.actor.generation || actor.deviceId !== scope.ownerId ||
        actor.agentId !== scope.actor.id || actor.worktreeId !== scope.actorWorktreeId) fail('ROLE_FORBIDDEN', 'Cursor Session or worktree binding changed');
    const task = state.tasks[scopedObjectKey(principal, scope.session, 'task:' + scope.taskId)];
    if (!task || task.repositoryId !== scope.repositoryId || canonical(task.session) !== canonical(scope.session) || task.briefReview?.decision !== 'approved') fail('ROLE_FORBIDDEN', 'Cursor task does not have the original approved requirement');
    if (scope.phase === 'plan') {
      if (!['assigned', 'plan-ready', 'plan-rejected', 'rework'].includes(task.stage)) fail('ROLE_FORBIDDEN', 'Cursor Plan phase ended');
    } else if (scope.phase === 'execution') {
      if (task.stage !== 'executing' || task.planReview?.decision !== 'approved' || canonical(task.plan) !== canonical(scope.plan) || task.sourceSha !== scope.sourceSha) fail('ROLE_FORBIDDEN', 'Cursor execution does not match the current approved Plan and base revision');
    } else if (task.stage !== 'testing' || task.sourceSha !== scope.sourceSha || task.handoff?.sourceSha !== scope.sourceSha) fail('ROLE_FORBIDDEN', 'Cursor CI does not match the current handoff');
    return task;
  }

  refs(task, scope) {
    return [task.brief, task.plan, ...(scope.phase === 'ci' ? Object.entries(task.references || {}).map(([ref, version]) => ({ ref, version })) : [])].filter(Boolean);
  }
  // Task IDs may themselves contain separators. Fixed hashing of the tuple
  // prevents a "task" delegation from owning objects for "task:other".
  prefix(scope) { return `${scope.phase === 'ci' ? 'ci' : 'cursor'}:${hash(canonical([scope.actor.id, scope.taskId]))}:${scope.attempt ? `attempt-${scope.attempt}:` : ''}`; }

  authorize(state, principal, message, lease, receiver) {
    if (this.now() >= lease.expiresAt) fail('ROLE_EXPIRED', 'Cursor delegation expired while waiting for the task transaction');
    const scope = lease.scope, task = this.task(state, scope, principal), p = message.payload;
    const own = ref => typeof ref === 'string' && ref.startsWith(this.prefix(scope)) && ref.length > this.prefix(scope).length;
    if (message.type === 'object.read') {
      const object = state.objects[scopedObjectKey(principal, scope.session, p.ref)]?.versions?.[p.version];
      if (!this.refs(task, scope).some(ref => ref.ref === p.ref && ref.version === p.version) && !(own(p.ref) && object)) fail('ROLE_FORBIDDEN', 'Read only this task\'s immutable references and own objects');
      return;
    }
    if (message.type === 'object.put') {
      const kinds = scope.phase === 'plan' ? ['plan'] : scope.phase === 'ci' ? ['evidence'] : ['evidence', 'ciTodo', 'experience'];
      if (!own(p.ref) || !kinds.includes(p.kind) || scope.phase === 'plan' && task.stage === 'plan-ready') fail('ROLE_FORBIDDEN', 'Write only this role\'s task objects');
      return;
    }
    if (p.taskId !== scope.taskId) fail('ROLE_FORBIDDEN', 'Cursor delegation belongs to another task');
    if (message.type === 'task.report' && scope.phase !== 'ci') {
      if (scope.phase === 'plan' && p.stage === 'planReady' && own(p.data?.planRef) && p.data.sourceSha === scope.sourceSha) return;
      if (scope.phase === 'execution' && p.stage === 'progress') return;
      if (scope.phase === 'execution' && p.stage === 'handoff') {
        const proof = receiver.verifiedHandoff;
        if (!proof || !bounded(proof.proofId) || proof.runId !== lease.runId || proof.nativeAgentId !== scope.nativeAgentId ||
            proof.baseSha !== scope.sourceSha || !sha.test(proof.sourceSha || '') || proof.sourceSha !== p.data?.sourceSha) fail('SOURCE_UNVERIFIED', 'Handoff needs a trusted provider and Git revision proof');
        if (!own(p.data.ciTodoRef) || !p.data.unitTestRefs.every(own) || !p.data.experienceRefs.every(own)) fail('ROLE_FORBIDDEN', 'Handoff references belong to another role or task');
        this.verifyEvidenceVersions(state, principal, scope, proof, [p.data.ciTodoRef, ...p.data.unitTestRefs, ...p.data.experienceRefs]);
        if (proof.messageHash) {
          const input = { id: message.id, type: message.type, payload: message.payload };
          if (proof.messageHash !== hash(canonical(input)) || proof.taskVersion !== task.version) fail('SOURCE_UNVERIFIED', 'The original handoff or task changed after verification');
          // This marker commits with the original reducer and retry receipt.
          // A crash after acceptance can be observed without replaying a stale
          // phase or trusting an adapter-only "applied" flag.
          state.cursorRoleHandoffs ||= {};
          state.cursorRoleHandoffs[proof.proofId] = { scopeHash: lease.scopeHash, runId: lease.runId, messageHash: proof.messageHash };
        }
        return;
      }
    }
    if (message.type === 'ci.result' && scope.phase === 'ci') {
      const proof = receiver.verifiedCi;
      if (!proof || !bounded(proof.proofId) || proof.runId !== lease.runId || proof.sourceSha !== scope.sourceSha ||
          proof.nativeAgentId !== scope.nativeAgentId ||
          p.sourceSha !== proof.sourceSha || p.verdict !== proof.verdict || canonical(p.checks) !== canonical(proof.checks)) fail('SOURCE_UNVERIFIED', 'CI needs independent native Run and test evidence for the exact revision');
      if (p.checks.some(check => !own(check.evidenceRef) || check.reproductionRef && !own(check.reproductionRef))) fail('ROLE_FORBIDDEN', 'CI evidence belongs to another role or task');
      this.verifyEvidenceVersions(state, principal, scope, proof, p.checks.flatMap(check => [check.evidenceRef, check.reproductionRef].filter(Boolean)));
      if (proof.messageHash) {
        if (proof.messageHash !== hash(canonical({ id: message.id, type: message.type, payload: message.payload })) ||
            proof.taskVersion !== task.version || proof.ciPolicyHash !== scope.ciPolicyHash) fail('SOURCE_UNVERIFIED', 'Original CI proposal, task or trusted test policy changed');
        state.cursorRoleCiResults ||= {};
        state.cursorRoleCiResults[proof.proofId] = { scopeHash: lease.scopeHash, runId: lease.runId, messageHash: proof.messageHash };
      }
      return;
    }
    fail('ROLE_FORBIDDEN', 'Cursor roles cannot approve, assign, control tasks or write Main');
  }

  verifyEvidenceVersions(state, principal, scope, proof, refs) {
    const expected = Object.fromEntries([...new Set(refs)].map(ref => [ref, state.objects[scopedObjectKey(principal, scope.session, ref)]?.latest]));
    if (Object.values(expected).some(version => !bounded(version)) || !record(proof.references) || canonical(proof.references) !== canonical(expected)) fail('SOURCE_UNVERIFIED', 'Evidence changed after the trusted revision and test verification');
  }

  async context(token) {
    return this.withLease(token, async lease => {
      const scope = lease.scope, principal = this.principal(scope);
      return this.store.transaction(async state => {
        const task = this.task(state, scope, principal);
        const receiver = await this.receiver(lease, state);
        if (this.now() >= lease.expiresAt) fail('ROLE_EXPIRED', 'Cursor delegation expired');
        return { taskId: task.id, actor: scope.actor, session: scope.session, phase: scope.phase, stage: task.stage,
          sourceSha: scope.sourceSha, writePrefix: this.prefix(scope), brief: task.brief, assignment: task.assignment, plan: task.plan, references: this.refs(task, scope),
          ...(receiver.testPolicy ? { testPolicy: receiver.testPolicy } : {}) };
      }, { readOnly: true });
    });
  }

  async handoffSnapshot(token, input) {
    return this.withLease(token, async lease => {
      const scope = lease.scope, principal = this.principal(scope);
      const message = validateMessage({ v: 2, id: input.id, type: input.type, session: scope.session, payload: structuredClone(input.payload) });
      if (scope.phase !== 'execution' || message.type !== 'task.report' || message.payload.stage !== 'handoff' || message.payload.taskId !== scope.taskId) fail('ROLE_FORBIDDEN', 'Defer only this Executor\'s original handoff');
      return this.store.transaction(async state => {
        const task = this.task(state, scope, principal), receiver = await this.receiver(lease, state);
        if (this.now() >= lease.expiresAt) fail('ROLE_EXPIRED', 'Cursor delegation expired');
        // Match ProtocolStore's authenticated identity tuple. This is only a
        // preflight read, covered against its actual receipt writer below;
        // the final exchange remains the sole authority for accepting the ID.
        const receipt = state.receipts[hash(canonical([principal.repositoryId, principal.deviceId, principal.agentId, message.id]))];
        if (receipt && receipt.fingerprint !== hash(canonical(message))) fail('ID_REUSED', 'The original request ID already belongs to a different message');
        const data = message.payload.data;
        const refs = [...new Set([data.ciTodoRef, ...data.unitTestRefs, ...data.experienceRefs])];
        if (refs.some(ref => !ref.startsWith(this.prefix(scope)) || ref.length <= this.prefix(scope).length)) fail('ROLE_FORBIDDEN', 'Handoff references belong to another role or task');
        // Exercise the SAME semantic reducer on a throwaway snapshot. Nothing
        // is written or emitted; missing objects/kinds cannot enter the ledger.
        try { await reduceWorkflow(structuredClone(state), principal, message, () => 0); }
        catch (cause) { if (cause.code === 'NOT_FOUND') fail('SOURCE_UNVERIFIED', 'Handoff references or versions are unavailable'); throw cause; }
        const references = Object.fromEntries(refs.map(ref => [ref, state.objects[scopedObjectKey(principal, scope.session, ref)].latest]));
        const plan = state.objects[scopedObjectKey(principal, scope.session, scope.plan.ref)]?.versions[scope.plan.version];
        return { scope, runId: receiver.runId, input: structuredClone(input), references,
          taskVersion: task.version, approvedPaths: plan?.content?.paths, verified: !!receiver.verifiedHandoff };
      }, { readOnly: true });
    });
  }

  async exchange(token, input) {
    if (!record(input) || Object.keys(input).some(key => !['id', 'type', 'payload'].includes(key)) ||
        !bounded(input.id) || !bounded(input.type) || !record(input.payload) || Buffer.byteLength(JSON.stringify(input)) > MAX_MESSAGE_BYTES) fail('INVALID_ARGUMENT', 'Send only a bounded message ID, type and payload');
    if (this.deferHandoff && input.type === 'task.report' && input.payload.stage === 'handoff') {
      const snapshot = await this.handoffSnapshot(token, input);
      // Release the capability/ProtocolStore locks before touching the actor
      // ledger. Factory launch takes actor -> capability, never the reverse.
      if (!snapshot.verified) return this.deferHandoff(token, snapshot);
    }
    if (this.deferCi && input.type === 'ci.result') {
      const snapshot = await this.ciSnapshot(token, input);
      if (!snapshot.verified) return this.deferCi(token, snapshot);
    }
    return this.withLease(token, async lease => {
      const scope = lease.scope;
      return this.store.handle(this.principal(scope), { v: 2, id: input.id, type: input.type, session: scope.session, payload: structuredClone(input.payload) }, {
        // The core invokes this inside its task transaction BEFORE retry replay.
        // A saved success must not outlive a Plan change or role revocation.
        authorize: async (state, principal, message) => {
          this.task(state, scope, principal);
          this.authorize(state, principal, message, lease, await this.receiver(lease, state));
        },
      });
    });
  }

  async ciSnapshot(token, input) {
    return this.withLease(token, async lease => {
      const scope = lease.scope, principal = this.principal(scope);
      const message = validateMessage({ v: 2, id: input.id, type: input.type, session: scope.session, payload: structuredClone(input.payload) });
      if (scope.phase !== 'ci' || message.type !== 'ci.result' || message.payload.taskId !== scope.taskId || message.payload.sourceSha !== scope.sourceSha) fail('ROLE_FORBIDDEN', 'Defer only the original independent CI result');
      return this.store.transaction(async state => {
        const task = this.task(state, scope, principal), receiver = await this.receiver(lease, state);
        if (this.now() >= lease.expiresAt) fail('ROLE_EXPIRED', 'Cursor delegation expired');
        const receipt = state.receipts[hash(canonical([principal.repositoryId, principal.deviceId, principal.agentId, message.id]))];
        if (receipt && receipt.fingerprint !== hash(canonical(message))) fail('ID_REUSED', 'The original request ID belongs to another message');
        const refs = [...new Set(message.payload.checks.flatMap(check => [check.evidenceRef, check.reproductionRef].filter(Boolean)))];
        if (refs.some(ref => !ref.startsWith(this.prefix(scope)) || ref.length <= this.prefix(scope).length)) fail('ROLE_FORBIDDEN', 'CI evidence belongs to another role or task');
        try { await reduceWorkflow(structuredClone(state), principal, message, () => 0); }
        catch (cause) { if (cause.code === 'NOT_FOUND') fail('SOURCE_UNVERIFIED', 'CI evidence or versions are unavailable'); throw cause; }
        const todo = state.objects[scopedObjectKey(principal, scope.session, task.handoff.ciTodoRef)];
        return { scope, runId: receiver.runId, input: structuredClone(input), taskVersion: task.version,
          todoVersion: todo.latest, items: todo.versions[todo.latest].content.items,
          references: Object.fromEntries(refs.map(ref => [ref, state.objects[scopedObjectKey(principal, scope.session, ref)].latest])), verified: !!receiver.verifiedCi };
      }, { readOnly: true });
    });
  }
}
