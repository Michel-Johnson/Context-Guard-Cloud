import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { canonical } from '../shared/protocol.mjs';
import { scopedObjectKey } from '../shared/protocol-workflow.mjs';
import { CursorRoleChannel } from './cursor-role-channel.mjs';
import { cursorRunTerminal, validateCursorSource } from './cursor-provider.mjs';
import { CursorGitProof, cursorApprovedPaths } from './cursor-git-proof.mjs';
import { cursorProofCommand, verifyCursorNativeProof } from './cursor-native-proof.mjs';
import { validateCursorCiPolicy, cursorCiRequirements, cursorCiOutcome, cursorCiCoverage } from './cursor-ci-policy.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: code === 'INVALID_CURSOR_ROLES' ? 400 : code === 'CURSOR_ROLE_CONFLICT' ? 409 : 503 }); };
const bindingKey = (repositoryId, id) => hash(canonical([repositoryId, id]));
const taskKey = (repositoryId, session, id) => scopedObjectKey({ repositoryId }, session, 'task:' + id);
export const cursorTemplateWorktree = id => `cursor-cloud-template:${id}`;

// A hosted receiver for the existing Coordinator scheduler. Reservations are
// logical workspace handles, NOT a claim that Cursor has created a VM or Run.
// Cursor remains the harness; business tasks and approvals stay in ProtocolStore.
export class CursorRoleFactory {
  constructor({ directory, projectId, repositoryId, templateSessionId, repositoryUrl, startingRef, model,
    endpoint, store, provider, authorizeSource, gitProof, githubTokenFile, ciPolicy, allowLoopback = false }) {
    validateCursorSource({ repositoryUrl, startingRef, model });
    let url;
    try { url = new URL(endpoint); } catch { fail('INVALID_CURSOR_ROLES', 'Configure a fixed role MCP endpoint'); }
    if (!path.isAbsolute(directory || '') || !projectId || !repositoryId || !uuid.test(templateSessionId || '') || !sha.test(startingRef) ||
        !store || !provider || typeof authorizeSource !== 'function' || url.username || url.password || url.search || url.hash ||
        url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('INVALID_CURSOR_ROLES', 'Configure an explicitly authorized hosted Cursor template');
    Object.assign(this, { directory, projectId, repositoryId, templateSessionId, repositoryUrl, startingRef, model, endpoint, store, provider, authorizeSource });
    this.gitProof = gitProof || new CursorGitProof({ repository: new URL(repositoryUrl).pathname.slice(1).replace(/\.git$/, ''), tokenFile: githubTokenFile });
    if (typeof this.gitProof.verify !== 'function') fail('INVALID_CURSOR_ROLES', 'Configure the source host verifier');
    this.ciPolicy = ciPolicy === undefined ? null : validateCursorCiPolicy(ciPolicy);
    this.ciPolicyHash = this.ciPolicy ? hash(canonical(this.ciPolicy)) : '';
    if (this.ciPolicy && (typeof this.gitProof.trustedChecks !== 'function' || typeof provider.readRunEvents !== 'function')) fail('INVALID_CURSOR_ROLES', 'CI policy requires trusted workflow reads and scoped native observations');
    this.ownerId = 'cloud-cursor:' + projectId;
    this.channel = new CursorRoleChannel({ directory: path.join(directory, 'capabilities'), store,
      resolveReceiver: (scope, state) => this.resolveReceiver(scope, state), deferHandoff: (token, snapshot) => this.deferHandoff(token, snapshot),
      ...(this.ciPolicy ? { deferCi: (token, snapshot) => this.deferCi(token, snapshot) } : {}) });
  }

  principal(id, role = 'executor') { return { repositoryId: this.repositoryId, deviceId: this.ownerId, agentId: id, role }; }
  observer() { return this.principal('hosted-role-controller', 'human'); } // Read-only internal project observer; never issues human decisions.
  executorFile(id) {
    if (!uuid.test(id || '') || id === this.templateSessionId) fail('CURSOR_ROLE_CONFLICT', 'Use a reserved child Session, not the template');
    return path.join(this.directory, 'executors', id + '.json');
  }
  ciFile(session, taskId, sourceSha) { return path.join(this.directory, 'testers', hash(canonical([session, taskId, sourceSha])) + '.json'); }
  actorFile(scope) { return scope.phase === 'ci' ? this.ciFile(scope.session, scope.taskId, scope.sourceSha) : this.executorFile(scope.session.id); }

  async initialize() {
    const principal = this.principal(this.templateSessionId), worktreeId = cursorTemplateWorktree(this.templateSessionId);
    return this.store.handle(principal, { v: 2, id: 'cursor-template:' + this.templateSessionId, type: 'session.bind', payload: {
      sessionId: this.templateSessionId, agentId: this.templateSessionId, worktreeId, expectedBindingVersion: '',
    } }, {
      verifyBinding: (p, payload) => p.repositoryId === this.repositoryId && p.deviceId === this.ownerId &&
        p.agentId === this.templateSessionId && payload.sessionId === this.templateSessionId && payload.worktreeId === worktreeId,
      authorize: state => {
        const existing = state.bindings[bindingKey(this.repositoryId, this.templateSessionId)];
        if (existing && (existing.deviceId !== this.ownerId || existing.agentId !== this.templateSessionId || existing.worktreeId !== worktreeId)) fail('CURSOR_ROLE_CONFLICT', 'Template is already assigned; preserve its existing binding');
      },
    });
  }

  creation(state, request) {
    const creation = state.sessionCreations?.[request.id];
    const result = creation?.result, template = state.bindings[bindingKey(this.repositoryId, this.templateSessionId)];
    const task = Object.values(state.projectTasks || {}).find(item => item.repositoryId === this.repositoryId && item.taskId === request.taskId);
    if (!creation || creation.repositoryId !== this.repositoryId || creation.deviceId !== this.ownerId ||
        !['pending', 'registered'].includes(result?.state) || result.sessionId !== request.sessionId || result.templateSessionId !== this.templateSessionId ||
        !template || template.deviceId !== this.ownerId || template.agentId !== this.templateSessionId || template.worktreeId !== cursorTemplateWorktree(this.templateSessionId) ||
        creation.templateWorktreeId !== template.worktreeId || !task || task.review?.decision !== 'approved' || task.reviewIssuer?.role !== 'human' ||
        task.sessionId !== request.sessionId || task.creationId !== request.id || !['starting', 'dispatched'].includes(task.stage) || task.templateSessionId !== this.templateSessionId) fail('CURSOR_ROLE_CONFLICT', 'The hosted reservation must belong to this exact approved project task and creation');
    return task;
  }

  async reserveExecutor(request) {
    if (!request || Object.keys(request).some(key => !['id', 'sessionId', 'taskId'].includes(key)) || !/^[a-f0-9]{64}$/.test(request.id || '') || !request.taskId) fail('INVALID_CURSOR_ROLES', 'Use the original Coordinator creation');
    const file = this.executorFile(request.sessionId), fingerprint = hash(canonical({ request, repositoryId: this.repositoryId, template: this.templateSessionId, repositoryUrl: this.repositoryUrl, sourceSha: this.startingRef }));
    return withFileLock(file + '.lock', async () => {
      const approval = await this.store.transaction(state => this.creation(state, request), { readOnly: true });
      let actor = await readJSON(file, null);
      if (actor && actor.fingerprint !== fingerprint) fail('CURSOR_ROLE_CONFLICT', 'Reserved Session belongs to another Cursor task or source');
      if (!actor) {
        const nativeAgentId = 'bc-' + randomUUID();
        const template = await this.store.registeredBinding(this.observer(), this.templateSessionId);
        actor = { format: 1, kind: 'executor', fingerprint, request, approval: { brief: approval.brief, review: approval.review },
          ciPolicyHash: this.ciPolicyHash,
          templateGeneration: template.generation,
          session: { id: request.sessionId, generation: 1 }, nativeAgentId, worktreeId: 'cursor-cloud:' + nativeAgentId,
          sourceSha: this.startingRef, state: 'reserved', invocations: [] };
        await atomicWrite(file, encode(actor));
      }
      const reply = await this.store.handle(this.principal(actor.session.id), { v: 2, id: 'cursor-reserve:' + request.id, type: 'session.bind', payload: {
        sessionId: actor.session.id, agentId: actor.session.id, worktreeId: actor.worktreeId, expectedBindingVersion: '',
      } }, {
        verifyBinding: (p, payload) => p.deviceId === this.ownerId && p.agentId === actor.session.id &&
          payload.sessionId === actor.session.id && payload.worktreeId === actor.worktreeId && actor.worktreeId !== cursorTemplateWorktree(this.templateSessionId),
        authorize: state => {
          const current = this.creation(state, request);
          if (canonical({ brief: current.brief, review: current.review }) !== canonical(actor.approval)) fail('CURSOR_ROLE_CONFLICT', 'The original human requirement changed');
          const previous = state.bindings[bindingKey(this.repositoryId, actor.session.id)];
          if (previous && (previous.deviceId !== this.ownerId || previous.agentId !== actor.session.id || previous.worktreeId !== actor.worktreeId)) fail('CURSOR_ROLE_CONFLICT', 'Preserve the existing execution binding');
        },
      });
      actor.session = reply.data.session;
      await atomicWrite(file, encode(actor));
      return { session: actor.session, worktreeId: actor.worktreeId, nativeState: actor.state };
    });
  }

  requireActor(state, actor) {
    const binding = state.bindings[bindingKey(this.repositoryId, actor.session.id)];
    if (!binding || binding.deviceId !== this.ownerId || binding.agentId !== actor.session.id || binding.worktreeId !== actor.worktreeId || binding.generation !== actor.session.generation) fail('CURSOR_ROLE_CONFLICT', 'Hosted actor binding changed');
  }
  currentTask(state, actor, taskId) {
    this.requireActor(state, actor);
    if ((actor.ciPolicyHash || '') !== this.ciPolicyHash) fail('CURSOR_ROLE_CONFLICT', 'The original task trusted CI policy changed');
    const session = actor.kind === 'ci' ? actor.executorSession : actor.session;
    const task = state.tasks[taskKey(this.repositoryId, session, taskId)];
    if (!task || task.briefReview?.decision !== 'approved') fail('CURSOR_ROLE_CONFLICT', 'Use the original approved execution task');
    const project = Object.values(state.projectTasks || {}).find(item => item.repositoryId === this.repositoryId && item.taskId === taskId && item.sessionId === session.id);
    if (!project || project.review?.decision !== 'approved' || project.reviewIssuer?.role !== 'human') fail('CURSOR_ROLE_CONFLICT', 'Original project approval is unavailable');
    const template = state.bindings[bindingKey(this.repositoryId, this.templateSessionId)];
    if (!template || template.deviceId !== this.ownerId || template.agentId !== this.templateSessionId || template.worktreeId !== cursorTemplateWorktree(this.templateSessionId) || template.generation !== actor.templateGeneration ||
        canonical({ brief: project.brief, review: project.review }) !== canonical(actor.approval)) fail('CURSOR_ROLE_CONFLICT', 'Hosted template or original approval changed');
    return task;
  }

  async reserveCi(session, taskId) {
    const executor = await readJSON(this.executorFile(session.id), null);
    if (!executor || canonical(executor.session) !== canonical(session)) fail('CURSOR_ROLE_CONFLICT', 'CI requires its registered hosted Executor');
    const task = await this.store.transaction(state => this.currentTask(state, executor, taskId), { readOnly: true });
    if (!['awaiting-ci', 'testing'].includes(task.stage) || !sha.test(task.handoff?.sourceSha || '') || task.handoff.sourceSha !== task.sourceSha) fail('CURSOR_ROLE_CONFLICT', 'Reserve CI only after the verified original handoff');
    const file = this.ciFile(session, taskId, task.sourceSha);
    return withFileLock(file + '.lock', async () => {
      let actor = await readJSON(file, null);
      if (!actor) {
        const nativeAgentId = 'bc-' + randomUUID();
        actor = { format: 1, kind: 'ci', session: { id: randomUUID(), generation: 1 }, executorSession: session, taskId,
          ciPolicyHash: executor.ciPolicyHash || '',
          approval: executor.approval, templateGeneration: executor.templateGeneration,
          nativeAgentId, executorNativeAgentId: executor.nativeAgentId, worktreeId: 'cursor-cloud:' + nativeAgentId,
          executorWorktreeId: executor.worktreeId, sourceSha: task.sourceSha, handoff: structuredClone(task.handoff), state: 'reserved', invocations: [] };
        if (this.ciPolicy) actor.commands = this.ciPolicy.checks.map(check => {
          const nonce = hash(randomUUID()), argv = check.argv;
          return { todoId: check.todoId, testId: check.testId, nonce, argv, command: cursorProofCommand({ nonce, argv, sourceSha: task.sourceSha }) };
        });
        await atomicWrite(file, encode(actor));
      }
      const reply = await this.store.handle(this.principal(actor.session.id, 'ci'), { v: 2, id: 'cursor-ci-reserve:' + hash(canonical([session, taskId, actor.sourceSha])), type: 'session.bind', payload: {
        sessionId: actor.session.id, agentId: actor.session.id, worktreeId: actor.worktreeId, expectedBindingVersion: '',
      } }, {
        verifyBinding: (p, payload) => p.deviceId === this.ownerId && payload.agentId === actor.session.id && payload.worktreeId === actor.worktreeId && actor.worktreeId !== executor.worktreeId && actor.nativeAgentId !== executor.nativeAgentId,
        authorize: state => {
          const current = this.currentTask(state, executor, taskId);
          if (!['awaiting-ci', 'testing'].includes(current.stage) || current.sourceSha !== actor.sourceSha || canonical(current.handoff) !== canonical(actor.handoff)) fail('CURSOR_ROLE_CONFLICT', 'CI handoff changed during reservation');
          const prior = state.bindings[bindingKey(this.repositoryId, actor.session.id)];
          if (prior && (prior.deviceId !== this.ownerId || prior.agentId !== actor.session.id || prior.worktreeId !== actor.worktreeId)) fail('CURSOR_ROLE_CONFLICT', 'Preserve the existing Tester binding');
        },
      });
      actor.session = reply.data.session; await atomicWrite(file, encode(actor));
      return { session: actor.session, worktreeId: actor.worktreeId, nativeState: actor.state };
    });
  }

  async hasCiReceiver(state, session) {
    const executor = await readJSON(this.executorFile(session.id), null);
    if (!executor || canonical(session) !== canonical(executor.session)) return false;
    const tasks = Object.values(state.tasks || {}).filter(task => task.repositoryId === this.repositoryId && canonical(task.session) === canonical(session) && ['awaiting-ci', 'testing'].includes(task.stage));
    if (tasks.length !== 1) return false;
    const task = tasks[0], actor = await readJSON(this.ciFile(session, task.id, task.sourceSha), null);
    if (!actor || actor.kind !== 'ci' || actor.executorNativeAgentId !== executor.nativeAgentId || actor.nativeAgentId === executor.nativeAgentId || actor.worktreeId === executor.worktreeId || actor.sourceSha !== task.handoff?.sourceSha || canonical(actor.handoff) !== canonical(task.handoff)) return false;
    try { this.requireActor(state, executor); this.requireActor(state, actor); return true; } catch { return false; }
  }

  scope(actor, task, phase) {
    const session = actor.kind === 'ci' ? actor.executorSession : actor.session;
    return { projectId: this.projectId, repositoryId: this.repositoryId, ownerId: this.ownerId, session, actor: actor.session,
      worktreeId: actor.kind === 'ci' ? actor.executorWorktreeId : actor.worktreeId, actorWorktreeId: actor.worktreeId,
      nativeAgentId: actor.nativeAgentId, taskId: task.id, phase,
      ...(this.ciPolicyHash ? { ciPolicyHash: this.ciPolicyHash } : {}),
      sourceSha: phase === 'plan' ? actor.sourceSha : task.sourceSha, ...(phase === 'execution' ? { plan: task.plan } : {}) };
  }
  async authorizeLaunch(state, actor, taskId, phase) {
    const task = this.currentTask(state, actor, taskId);
    if (phase === 'plan' && task.stage !== 'assigned' || phase === 'execution' && (task.stage !== 'executing' || task.planReview?.decision !== 'approved' || task.sourceSha !== actor.sourceSha) ||
        phase === 'ci' && (actor.kind !== 'ci' || task.stage !== 'testing' || task.sourceSha !== actor.sourceSha || canonical(task.handoff) !== canonical(actor.handoff))) fail('CURSOR_ROLE_CONFLICT', 'Cursor launch does not match the current approved stage and revision');
    if (!await this.authorizeSource({ state, actor: structuredClone(actor), task: structuredClone(task) })) fail('CURSOR_ROLE_CONFLICT', 'Approved source or template access changed');
    return task;
  }

  prompt(scope, actor) {
    const common = `You are the ${scope.phase === 'ci' ? 'independent Tester' : 'Executor'} of the original Context Guard Coordinator task ${scope.taskId}. Never start a separate user chat, approve a requirement or Plan, or write Main. Use context_guard_context, then context_guard_exchange object.read for immutable references. When testPolicy is present, include its fixed todoId/testId/argv mapping in your Plan and CI TODO; never invent coverage. Identity is fixed by MCP, never include Session/principal fields. Use the returned writePrefix and stable message IDs. If ROLE_UNAVAILABLE appears during native startup, retry the SAME MCP operation, do not create a new task. Source revision: ${scope.sourceSha}.`;
    if (scope.phase === 'plan') return common + ' This Run is Plan-only. Do not modify source. Write one own kind:plan object with steps, paths, validation and acceptance, then task.report stage:planReady with planRef/planVersion and the specified sourceSha. Stop after that; Coordinator must review the exact Plan before implementation.';
    if (scope.phase === 'ci') return common + ' Read the handed-off CI TODO and test evidence. Test only this exact source in this independent environment; do not change business source. Write own evidence objects and submit ci.result with sourceSha, verdict and numbered checks. A proof-pending response saves only that original CI proposal: end this Run for host verification, never replace the ID or claim acceptance. A success statement or FINISHED is not business acceptance; unverifiable evidence must remain incomplete.' +
      (this.ciPolicy ? ' Execute each exact host command once with run_terminal_cmd (not backgrounded), keeping its nonce and actual result. Never alter business source or command argv. Preserve failed reproduction evidence and use the fixed todoId/testId mapping. Commands: ' + JSON.stringify(actor.commands.map(({ todoId, testId, command }) => ({ todoId, testId, command }))) : '');
    return common + ' Read only the approved Plan version before implementation. Implement and run module tests, commit and push only your own Cursor branch (never main), then read the actual commit SHA. Write own kind:ciTodo with uniquely numbered items and kind:evidence/experience objects. Submit task.report stage:handoff with the actual sourceSha, ciTodoRef, unitTestRefs and experienceRefs. A proof-pending response saves only that original proposal: stop this Run so the host can verify it, do not send a replacement ID or claim completion. This is not human acceptance. SOURCE_UNVERIFIED means the evidence is not yet verified; do not report task completion.';
  }

  async ciFacts(actor) {
    const executor = await readJSON(this.executorFile(actor.executorSession.id), null);
    const handoff = executor?.invocations.at(-1)?.handoff;
    if (!handoff?.facts || handoff.facts.sourceSha !== actor.sourceSha || !await this.acceptedHandoff(executor, executor.invocations.at(-1))) fail('SOURCE_UNVERIFIED', 'CI requires the original verified source branch');
    return this.gitProof.trustedChecks({ sourceSha: actor.sourceSha, branch: handoff.facts.branch, requiredChecks: cursorCiRequirements(this.ciPolicy) });
  }

  async prepareCi(file) {
    const actor = await readJSON(file, null);
    if (!actor || !this.ciPolicy) return;
    if (actor.invocations.length) return; // Never prepare another native Run.
    await this.store.transaction(async state => {
      const task = await this.authorizeLaunch(state, actor, actor.taskId, 'ci');
      const todo = state.objects[scopedObjectKey(this.principal(actor.session.id, 'ci'), actor.executorSession, task.handoff.ciTodoRef)];
      const version = todo?.versions?.[todo.latest];
      if (version?.kind !== 'ciTodo' || todo.latest !== task.references[task.handoff.ciTodoRef]) fail('SOURCE_UNVERIFIED', 'The original CI TODO changed');
      cursorCiCoverage(this.ciPolicy, version.content.items);
    }, { readOnly: true });
    if (actor.nextFactsAt > Date.now()) fail('SOURCE_UNVERIFIED', 'The declared workflow result is still pending');
    let facts;
    try { facts = await this.ciFacts(actor); }
    catch (cause) {
      await withFileLock(file + '.lock', async () => {
        const latest = await readJSON(file, null);
        if (!latest.invocations.length && latest.sourceSha === actor.sourceSha) {
          latest.nextFactsAt = Date.now() + 30000; await atomicWrite(file, encode(latest));
        }
      });
      throw cause;
    }
    await withFileLock(file + '.lock', async () => {
      const latest = await readJSON(file, null);
      await this.store.transaction(state => this.authorizeLaunch(state, latest, latest.taskId, 'ci'), { readOnly: true });
      if (!latest.invocations.length) { latest.machineFacts = facts; delete latest.nextFactsAt; await atomicWrite(file, encode(latest)); }
    });
  }

  async deferCi(token, snapshot) {
    cursorCiCoverage(this.ciPolicy, snapshot.items);
    const checks = snapshot.input.payload.checks;
    if (checks.length !== this.ciPolicy.checks.length || checks.some(check => !this.ciPolicy.checks.some(policy => policy.todoId === check.todoId && policy.testId === check.testId))) fail('SOURCE_UNVERIFIED', 'The CI proposal does not match the declared numbered test mapping');
    const file = this.actorFile(snapshot.scope), fingerprint = this.handoffIdentity(snapshot);
    return withFileLock(file + '.lock', async () => {
      const actor = await readJSON(file, null), invocation = actor?.invocations.at(-1);
      if (!invocation || invocation.token !== token || invocation.state !== 'confirmed' || invocation.runId !== snapshot.runId || canonical(invocation.scope) !== canonical(snapshot.scope)) fail('CURSOR_ROLE_CONFLICT', 'Keep the confirmed independent CI invocation');
      const current = await this.channel.ciSnapshot(token, snapshot.input);
      if (this.handoffIdentity(current) !== fingerprint) fail('SOURCE_UNVERIFIED', 'CI changed before the original proposal was saved');
      if (invocation.ciProposal && invocation.ciProposal.fingerprint !== fingerprint) fail('ID_REUSED', 'The native CI invocation already has another proposal');
      invocation.ciProposal ||= { state: 'pending', fingerprint, snapshot: structuredClone(snapshot) };
      await atomicWrite(file, encode(actor));
      return { id: snapshot.input.id, ok: true, data: { state: 'proof-pending', taskId: snapshot.scope.taskId, sourceSha: snapshot.scope.sourceSha } };
    });
  }

  async acceptedCi(actor, invocation) {
    const pending = invocation?.ciProposal;
    if (!pending?.proof) return false;
    return this.store.transaction(async state => {
      const task = this.currentTask(state, actor, invocation.scope.taskId);
      if (!await this.authorizeSource({ state, actor: structuredClone(actor), task: structuredClone(task) })) fail('CURSOR_ROLE_CONFLICT', 'Source access changed');
      const applied = state.cursorRoleCiResults?.[pending.proof.proofId];
      return !!applied && applied.scopeHash === invocation.id && applied.runId === invocation.runId && applied.messageHash === hash(canonical(pending.snapshot.input));
    }, { readOnly: true });
  }

  async verifyCi(file) {
    const actor = await readJSON(file, null), invocation = actor?.invocations.at(-1), pending = invocation?.ciProposal;
    if (!pending) return null;
    if (await this.acceptedCi(actor, invocation)) return { state: 'ci-accepted' };
    const { snapshot } = pending;
    const observedAccepted = async () => {
      const latest = await readJSON(file, null), owned = latest?.invocations.at(-1);
      return owned?.id === invocation.id && await this.acceptedCi(latest, owned);
    };
    let current;
    try { current = await this.channel.ciSnapshot(invocation.token, snapshot.input); }
    catch (cause) { if (await observedAccepted()) return { state: 'ci-accepted' }; throw cause; }
    if (this.handoffIdentity(current) !== pending.fingerprint) fail('SOURCE_UNVERIFIED', 'Original CI evidence or task changed');
    const run = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
    if (run.agentId !== actor.nativeAgentId || run.id !== invocation.runId) fail('SOURCE_UNVERIFIED', 'Observe only the original independent CI Run');
    if (!cursorRunTerminal(run)) return { state: 'proof-pending' };
    if (run.status !== 'FINISHED' || (await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== invocation.runId) fail('SOURCE_UNVERIFIED', 'The independent native CI Run is unverified');
    // Read both observers outside ALL authority locks. Native output alone is
    // not an immutable-source attestation; exact-source pinned workflow facts
    // and explicit numbered coverage are independently required.
    const observation = await this.provider.readRunEvents(actor.nativeAgentId, invocation.runId);
    const native = actor.commands.map(spec => verifyCursorNativeProof({ observation, run, ...spec, sourceSha: actor.sourceSha }));
    const facts = await this.ciFacts(actor);
    const expected = snapshot.input.payload.checks.map(proposal => {
      const index = this.ciPolicy.checks.findIndex(policy => policy.todoId === proposal.todoId && policy.testId === proposal.testId), policy = this.ciPolicy.checks[index];
      const machine = cursorCiOutcome(facts, policy.name), status = machine === 'incomplete' ? 'incomplete' : native[index].testOutcome === 'failed' || machine === 'failed' ? 'failed' : 'passed';
      return { ...proposal, status };
    });
    const verdict = expected.some(check => check.status === 'incomplete') ? 'incomplete' : expected.some(check => check.status === 'failed') ? 'failed' : 'passed';
    if (canonical(expected) !== canonical(snapshot.input.payload.checks) || snapshot.input.payload.verdict !== verdict) fail('SOURCE_UNVERIFIED', 'The CI proposal contradicts actual execution or declared workflow coverage');
    const completed = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
    if (completed.agentId !== actor.nativeAgentId || completed.id !== invocation.runId || completed.status !== 'FINISHED' ||
        (await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== invocation.runId) fail('SOURCE_UNVERIFIED', 'The native CI identity changed during verification');
    const proof = { proofId: hash(canonical([pending.fingerprint, native, facts])), nativeAgentId: actor.nativeAgentId, runId: invocation.runId,
      sourceSha: actor.sourceSha, verdict, checks: expected, references: snapshot.references, taskVersion: snapshot.taskVersion,
      messageHash: hash(canonical(snapshot.input)), ciPolicyHash: this.ciPolicyHash };
    const ready = await withFileLock(file + '.lock', async () => {
      const latest = await readJSON(file, null), owned = latest?.invocations.at(-1);
      if (!owned || owned.id !== invocation.id || owned.runId !== invocation.runId || owned.token !== invocation.token || owned.state !== 'confirmed' || owned.ciProposal?.fingerprint !== pending.fingerprint) fail('CURSOR_ROLE_CONFLICT', 'Original CI invocation changed');
      if (await this.acceptedCi(latest, owned)) return false;
      let rechecked;
      try { rechecked = await this.channel.ciSnapshot(invocation.token, snapshot.input); }
      catch (cause) { if (await this.acceptedCi(latest, owned)) return false; throw cause; }
      if (this.handoffIdentity(rechecked) !== pending.fingerprint) fail('SOURCE_UNVERIFIED', 'Original CI changed during verification');
      owned.ciProposal.proof = proof; owned.ciProposal.observation = native; owned.ciProposal.machineFacts = facts;
      await atomicWrite(file, encode(latest)); return true;
    });
    if (!ready) return { state: 'ci-accepted' };
    try { return (await this.channel.exchange(invocation.token, snapshot.input)).data; }
    catch (cause) { if (await observedAccepted()) return { state: 'ci-accepted' }; throw cause; }
  }

  handoffIdentity(snapshot) {
    const { verified, ...identity } = snapshot;
    return hash(canonical(identity));
  }

  async deferHandoff(token, snapshot) {
    cursorApprovedPaths(snapshot.approvedPaths);
    const file = this.actorFile(snapshot.scope), fingerprint = this.handoffIdentity(snapshot);
    return withFileLock(file + '.lock', async () => {
      const actor = await readJSON(file, null), invocation = actor?.invocations.at(-1);
      if (!invocation || invocation.token !== token || invocation.state !== 'confirmed' || invocation.runId !== snapshot.runId ||
          canonical(invocation.scope) !== canonical(snapshot.scope)) fail('CURSOR_ROLE_CONFLICT', 'Preserve the exact confirmed handoff invocation');
      const current = await this.channel.handoffSnapshot(token, snapshot.input);
      if (this.handoffIdentity(current) !== fingerprint) fail('SOURCE_UNVERIFIED', 'Handoff changed before its proposal was saved');
      if (invocation.handoff && invocation.handoff.fingerprint !== fingerprint) fail('ID_REUSED', 'This native invocation already has a different handoff proposal');
      invocation.handoff ||= { state: 'pending', fingerprint, snapshot: structuredClone(snapshot) };
      await atomicWrite(file, encode(actor));
      return { id: snapshot.input.id, ok: true, data: { state: 'proof-pending', taskId: snapshot.scope.taskId, sourceSha: snapshot.input.payload.data.sourceSha } };
    });
  }

  async acceptedHandoff(actor, invocation) {
    const pending = invocation.handoff;
    if (!pending?.proof) return false;
    return this.store.transaction(async state => {
      const task = this.currentTask(state, actor, invocation.scope.taskId);
      if (!await this.authorizeSource({ state, actor: structuredClone(actor), task: structuredClone(task) })) fail('CURSOR_ROLE_CONFLICT', 'Source access changed');
      const applied = state.cursorRoleHandoffs?.[pending.proof.proofId];
      return !!applied && applied.scopeHash === invocation.id && applied.runId === invocation.runId &&
        applied.messageHash === hash(canonical(pending.snapshot.input));
    }, { readOnly: true });
  }

  async verifyHandoff(file) {
    const actor = await readJSON(file, null), invocation = actor?.invocations.at(-1), pending = invocation?.handoff;
    if (!pending) return null;
    if (await this.acceptedHandoff(actor, invocation)) return { state: 'handoff-accepted' };
    const { snapshot } = pending;
    let current;
    try { current = await this.channel.handoffSnapshot(invocation.token, snapshot.input); }
    catch (cause) {
      const latest = await readJSON(file, null), owned = latest?.invocations.at(-1);
      if (owned?.id === invocation.id && await this.acceptedHandoff(latest, owned)) return { state: 'handoff-accepted' };
      throw cause;
    }
    if (this.handoffIdentity(current) !== pending.fingerprint) fail('SOURCE_UNVERIFIED', 'Original handoff evidence or task changed');
    // Network reads run outside actor, capability and ProtocolStore locks.
    // Repeated pumps inspect the same confirmed Run, never create a model Run.
    const run = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
    if (run.agentId !== actor.nativeAgentId || run.id !== invocation.runId) fail('SOURCE_UNVERIFIED', 'Native handoff belongs to another Run');
    if (!cursorRunTerminal(run)) return { state: 'proof-pending' };
    if (run.status !== 'FINISHED' || (await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== invocation.runId) fail('SOURCE_UNVERIFIED', 'Original native handoff did not finish in its saved Run');
    const facts = await this.gitProof.verify({ run, baseSha: snapshot.scope.sourceSha,
      sourceSha: snapshot.input.payload.data.sourceSha, approvedPaths: snapshot.approvedPaths });
    if (facts.baseSha !== snapshot.scope.sourceSha || facts.sourceSha !== snapshot.input.payload.data.sourceSha) fail('SOURCE_UNVERIFIED', 'Git facts do not match the original proposal');
    const completed = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
    if (completed.agentId !== actor.nativeAgentId || completed.id !== invocation.runId || completed.status !== 'FINISHED' ||
        (await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== invocation.runId) fail('SOURCE_UNVERIFIED', 'Native handoff changed during the Git read');
    const proof = { proofId: hash(canonical([pending.fingerprint, facts, invocation.runId])), nativeAgentId: actor.nativeAgentId,
      runId: invocation.runId, baseSha: facts.baseSha, sourceSha: facts.sourceSha, references: snapshot.references,
      taskVersion: snapshot.taskVersion, messageHash: hash(canonical(snapshot.input)) };
    const ready = await withFileLock(file + '.lock', async () => {
      const latest = await readJSON(file, null), owned = latest?.invocations.at(-1);
      if (!owned || owned.id !== invocation.id || owned.runId !== invocation.runId || owned.token !== invocation.token || owned.state !== 'confirmed' ||
          owned.handoff?.fingerprint !== pending.fingerprint) fail('CURSOR_ROLE_CONFLICT', 'Handoff invocation changed during verification');
      if (await this.acceptedHandoff(latest, owned)) return false;
      let rechecked;
      try { rechecked = await this.channel.handoffSnapshot(invocation.token, snapshot.input); }
      catch (cause) { if (await this.acceptedHandoff(latest, owned)) return false; throw cause; }
      if (this.handoffIdentity(rechecked) !== pending.fingerprint) fail('SOURCE_UNVERIFIED', 'Original handoff changed during verification');
      owned.handoff.proof = proof; owned.handoff.facts = facts;
      await atomicWrite(file, encode(latest));
      return true;
    });
    if (!ready) return { state: 'handoff-accepted' };
    // Release the actor lock before the original capability exchange. Its core
    // transaction rechecks authority and writes the acceptance marker atomically.
    try { return (await this.channel.exchange(invocation.token, snapshot.input)).data; }
    catch (cause) {
      const latest = await readJSON(file, null);
      if (await this.acceptedHandoff(latest, latest.invocations.at(-1))) return { state: 'handoff-accepted' };
      throw cause;
    }
  }

  async launch(file, actor, taskId, phase) {
    let task = await this.store.transaction(state => this.authorizeLaunch(state, actor, taskId, phase), { readOnly: true });
    const scope = this.scope(actor, task, phase), operationId = hash(canonical(scope));
    let invocation = actor.invocations.find(item => item.id === operationId);
    if (invocation) {
      // A lost follow-up confirmation has no client Run ID. Do not POST again
      // or adopt the Agent's unrelated latest Run to make the ledger look ready.
      if (['dispatching', 'unknown'].includes(invocation.state)) fail('CURSOR_ACCEPTANCE_UNKNOWN', 'Preserve the original invocation and inspect its native result');
      if (invocation.state === 'confirmed') return invocation;
      if (invocation.state !== 'prepared') fail('CURSOR_ROLE_FAILED', 'The saved invocation failed or was stopped; preserve its receipt rather than silently retrying');
    }
    const previous = invocation ? actor.invocations.at(-2) : actor.invocations.at(-1);
    if (previous) {
      const run = await this.provider.getRun(actor.nativeAgentId, previous.runId);
      if (!cursorRunTerminal(run)) fail('CURSOR_ROLE_BUSY', 'Wait for the current native Run');
      if ((await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== previous.runId) fail('CURSOR_ROLE_CONFLICT', 'The native Agent was used outside the saved task');
      await this.channel.revoke(previous.token);
    }
    const lease = await this.channel.issue({ operationId, scope });
    if (!invocation) {
      invocation = { id: operationId, scope, token: lease.token, state: 'prepared', mode: phase === 'plan' ? 'plan' : 'agent' };
      actor.invocations.push(invocation); await atomicWrite(file, encode(actor));
    }
    // Persist the authorization tuple in the SAME transaction as the task
    // check, not in a second authoritative task state machine or native status.
    await this.store.transaction(async state => {
      task = await this.authorizeLaunch(state, actor, taskId, phase);
      if (canonical(this.scope(actor, task, phase)) !== canonical(scope)) fail('CURSOR_ROLE_CONFLICT', 'Plan or source changed before native dispatch');
      state.cursorRoleLaunches ||= {};
      state.cursorRoleLaunches[hash(canonical([this.repositoryId, operationId]))] = { scopeHash: operationId, taskVersion: task.version,
        briefReview: task.briefReview, planReview: task.planReview || null, state: 'authorized' };
    });
    // Final current-state check before a network side effect. A concurrent
    // revocation AFTER this boundary invalidates all callbacks, not time travel.
    await this.store.transaction(state => this.authorizeLaunch(state, actor, taskId, phase), { readOnly: true });
    invocation.state = 'dispatching'; await atomicWrite(file, encode(actor));
    const mcpServers = [{ name: 'context_guard', type: 'http', url: this.endpoint, headers: { Authorization: 'Bearer ' + lease.token } }];
    try {
      const run = previous ? await this.provider.followUp(actor.nativeAgentId, this.prompt(scope, actor), { mode: invocation.mode, mcpServers })
        : (await this.provider.create({ agentId: actor.nativeAgentId, repositoryUrl: this.repositoryUrl, startingRef: scope.sourceSha,
          name: phase === 'ci' ? 'Context Guard independent Tester' : 'Context Guard Executor', text: this.prompt(scope, actor), mode: invocation.mode, mcpServers,
          ...(this.model ? { model: this.model } : {}) })).run;
      invocation.runId = run.id; invocation.run = run; invocation.state = 'confirmed'; actor.state = 'confirmed';
      await atomicWrite(file, encode(actor));
      await this.store.transaction(state => this.authorizeLaunch(state, actor, taskId, phase), { readOnly: true });
      await this.channel.activate(lease.token);
      return invocation;
    } catch (cause) {
      invocation.state = cause.deliveryUncertain ? 'unknown' : invocation.runId ? 'invalidated' : 'failed';
      invocation.error = String(cause.code || 'CURSOR_ROLE_FAILED').slice(0, 100); await atomicWrite(file, encode(actor));
      if (!cause.deliveryUncertain) await this.channel.revoke(lease.token);
      throw cause;
    }
  }

  async pump(session, taskId) {
    const executorFile = this.executorFile(session.id), executor = await readJSON(executorFile, null);
    if (!executor || canonical(executor.session) !== canonical(session)) return null;
    const control = await this.store.transaction(state => {
      this.requireActor(state, executor);
      return state.tasks[taskKey(this.repositoryId, session, taskId)];
    }, { readOnly: true });
    if (['cancelling', 'interrupted'].includes(control?.stage)) return this.stopTask(executorFile, executor, control);
    let task = await this.store.transaction(state => this.currentTask(state, executor, taskId), { readOnly: true });
    if (executor.invocations.at(-1)?.handoff) {
      const result = await this.verifyHandoff(executorFile);
      task = await this.store.transaction(state => this.currentTask(state, executor, taskId), { readOnly: true });
      if (task.stage === 'executing') return result;
    }
    const ciFile = this.ciFile(session, taskId, task.sourceSha), ci = await readJSON(ciFile, null);
    if (ci?.invocations.at(-1)?.ciProposal) {
      const result = await this.verifyCi(ciFile);
      task = await this.store.transaction(state => this.currentTask(state, executor, taskId), { readOnly: true });
      if (task.stage === 'testing') return result;
    }
    if (task.stage === 'awaiting-ci') return this.reserveCi(session, taskId);
    const phase = task.stage === 'assigned' ? 'plan' : task.stage === 'executing' ? 'execution' : task.stage === 'testing' ? 'ci' : null;
    if (!phase) return null;
    const file = phase === 'ci' ? this.ciFile(session, taskId, task.sourceSha) : executorFile;
    if (phase === 'ci' && this.ciPolicy) await this.prepareCi(file);
    return withFileLock(file + '.lock', async () => {
      const actor = await readJSON(file, null);
      if (!actor) fail('CURSOR_ROLE_CONFLICT', 'Reserve the independent receiver before CI dispatch');
      return this.launch(file, actor, taskId, phase);
    });
  }

  async stopActor(file, expected, control) {
    return withFileLock(file + '.lock', async () => {
      const actor = await readJSON(file, null);
      if (!actor || canonical(actor.session) !== canonical(expected.session) || actor.nativeAgentId !== expected.nativeAgentId) fail('CURSOR_ROLE_CONFLICT', 'Stop only the original owned actor');
      const invocation = actor.invocations.at(-1);
      if (!invocation) return true; // Only a logical reservation, no native POST.
      if (invocation.scope.taskId !== control.id) fail('CURSOR_ROLE_CONFLICT', 'Stop belongs to another task');
      if (['dispatching', 'unknown'].includes(invocation.state)) fail('CURSOR_ACCEPTANCE_UNKNOWN', 'Unknown native acceptance cannot be guessed or stopped by latest Agent state');
      if (invocation.state === 'prepared' || invocation.state === 'failed' && !invocation.runId) {
        await this.channel.revoke(invocation.token);
        invocation.state = 'invalidated'; await atomicWrite(file, encode(actor)); return true;
      }
      if (!invocation.runId) fail('CURSOR_ACCEPTANCE_UNKNOWN', 'Native stop requires the saved confirmed Run');
      await this.channel.revoke(invocation.token);
      let run = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
      if (!cursorRunTerminal(run)) {
        if ((await this.provider.getAgent(actor.nativeAgentId)).latestRunId !== invocation.runId) fail('CURSOR_ROLE_CONFLICT', 'Never stop an unrelated native Run');
        if (!invocation.stop) {
          // Save intent first. An unknown cancel acknowledgement permits GET
          // observation only, never repeated POST or adoption of another Run.
          invocation.stop = { state: 'requested', controlId: control.control?.id || null };
          await atomicWrite(file, encode(actor));
          try { await this.provider.cancel(actor.nativeAgentId, invocation.runId); }
          catch (cause) {
            invocation.stop.state = cause.deliveryUncertain ? 'unknown' : 'rejected';
            invocation.stop.error = String(cause.code || 'CURSOR_STOP_FAILED').slice(0, 100);
            await atomicWrite(file, encode(actor)); throw cause;
          }
        }
        run = await this.provider.getRun(actor.nativeAgentId, invocation.runId);
      }
      if (!cursorRunTerminal(run)) return false;
      invocation.stop = { ...invocation.stop, state: 'confirmed', status: run.status, runId: run.id };
      invocation.state = 'invalidated'; actor.state = 'stopped'; await atomicWrite(file, encode(actor));
      return true;
    });
  }

  async stopTask(file, executor, task) {
    const stopped = await this.stopActor(file, executor, task);
    const ciFile = this.ciFile(executor.session, task.id, task.sourceSha);
    const ci = await readJSON(ciFile, null);
    const ciStopped = !ci || await this.stopActor(ciFile, ci, task);
    if (!stopped || !ciStopped) return { state: 'stopping' };
    if (task.stage === 'interrupted') return { state: 'stopped' }; // No automatic resume or new model Run.
    return (await this.store.handle(this.principal(executor.session.id), { v: 2,
      id: 'cursor-native-stop:' + hash(canonical([executor.session, task.id, task.control.id])), type: 'task.report', session: executor.session,
      payload: { taskId: task.id, stage: 'cancelled', data: { controlId: task.control.id } },
    }, { authorize: state => {
      this.requireActor(state, executor);
      const current = state.tasks[taskKey(this.repositoryId, executor.session, task.id)];
      if (!current || current.control?.id !== task.control.id || !['cancelling', 'cancelled'].includes(current.stage)) fail('CURSOR_ROLE_CONFLICT', 'Control changed before the native stop report');
    } })).data;
  }

  async resolveReceiver(scope, state) {
    if (scope.projectId !== this.projectId || scope.repositoryId !== this.repositoryId || scope.ownerId !== this.ownerId) return null;
    const actor = await readJSON(this.actorFile(scope), null);
    if (!actor || canonical(actor.session) !== canonical(scope.actor) || actor.nativeAgentId !== scope.nativeAgentId || actor.worktreeId !== scope.actorWorktreeId) return null;
    const invocation = actor.invocations.find(item => item.id === hash(canonical(scope)) && canonical(item.scope) === canonical(scope));
    if (!invocation || invocation.state !== 'confirmed' || !invocation.runId || actor.invocations.at(-1) !== invocation) return null;
    const authorized = async current => {
      try {
        const task = this.currentTask(current, actor, scope.taskId);
        return await this.authorizeSource({ state: current, actor: structuredClone(actor), task: structuredClone(task) });
      } catch (cause) {
        if (cause.code === 'CURSOR_ROLE_CONFLICT') return false;
        throw cause;
      }
    };
    // The channel passes its existing transaction snapshot. Do not reacquire
    // ProtocolStore while callbacks already hold it; activation is outside it.
    if (!await (state ? authorized(state) : this.store.transaction(authorized, { readOnly: true }))) return null;
    return { active: true, scopeHash: invocation.id, nativeAgentId: actor.nativeAgentId, runId: invocation.runId,
      ...(invocation.handoff?.proof ? { verifiedHandoff: invocation.handoff.proof } : {}),
      ...(invocation.ciProposal?.proof ? { verifiedCi: invocation.ciProposal.proof } : {}),
      ...(this.ciPolicy ? { testPolicy: { checks: this.ciPolicy.checks.map(policy => ({ todoId: policy.todoId, testId: policy.testId, argv: policy.argv,
        ...(actor.kind === 'ci' ? { machineStatus: cursorCiOutcome(actor.machineFacts || [], policy.name),
          command: actor.commands.find(command => command.todoId === policy.todoId).command } : {}) })) } } : {}),
      ...(actor.kind === 'ci' ? { executorNativeAgentId: actor.executorNativeAgentId } : {}) };
  }

  async owns(sessionId) {
    if (!uuid.test(sessionId || '') || sessionId === this.templateSessionId) return false;
    return !!await readJSON(this.executorFile(sessionId), null);
  }
}
