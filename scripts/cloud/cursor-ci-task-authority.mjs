import { canonical, fail } from '../shared/protocol.mjs';
import { hash } from '../shared/io.mjs';
import { scopedObjectKey } from '../shared/protocol-workflow.mjs';

const fields = ['taskId', 'planRef', 'planVersion', 'planSourceSha', 'approvalReceiptId', 'sourceSha', 'ciTodoRef', 'ciTodoVersion'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const forbidden = () => fail('FORBIDDEN', 'The original CI task authorization changed');

// This expectation only narrows an already authenticated device delegation.
// It is not a credential, native isolation proof, or permission to approve CI.
export function parseCursorCiTaskHeader(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_ARGUMENT', 'Invalid CI task expectation');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('INVALID_ARGUMENT', 'Invalid CI task expectation');
  let tuple;
  try { tuple = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_ARGUMENT', 'Invalid CI task expectation'); }
  validateTuple(tuple);
  // Canonical encoding also rejects duplicate JSON keys and ambiguous bytes.
  if (bytes.toString('utf8') !== canonical(tuple)) fail('INVALID_ARGUMENT', 'Invalid CI task expectation');
  return tuple;
}

function validateTuple(tuple) {
  if (!record(tuple) || Object.keys(tuple).length !== fields.length || fields.some(field => !Object.hasOwn(tuple, field)) ||
      fields.some(field => typeof tuple[field] !== 'string' || !tuple[field].length ||
        tuple[field].length > (field.endsWith('Version') ? 4096 : 128) || /[\x00-\x1f\x7f]/.test(tuple[field])) ||
      !['sourceSha', 'planSourceSha'].every(field => /^[a-f0-9]{40}$/.test(tuple[field]))) {
    fail('INVALID_ARGUMENT', 'Invalid CI task expectation');
  }
}

export function authorizeCursorCiTask(state, principal, message) {
  const receiptKey = hash(canonical([principal.repositoryId, principal.deviceId, principal.agentId, message.id]));
  const pinned = state.cursorCiTaskScopes?.[receiptKey], tuple = principal.ciTaskExpectation;
  // The saved scope cannot be bypassed by omitting its header on a retry.
  if (!tuple && !pinned) return;
  if (!tuple || principal.role !== 'ci' || !message.session || !['object.read', 'object.put', 'ci.result'].includes(message.type)) forbidden();
  validateTuple(tuple);
  const receipt = message.type === 'object.read' ? null : state.receipts[receiptKey];
  if (receipt && receipt.fingerprint !== hash(canonical(message))) fail('ID_REUSED', 'Request ID already has different content');
  if (receipt && !pinned || pinned && !receipt) forbidden(); // Never upgrade a legacy acceptance or repair corrupted state.
  const ci = state.bindings[hash(canonical([principal.repositoryId, principal.agentId]))];
  const executor = state.bindings[hash(canonical([principal.repositoryId, message.session.id]))];
  if (!ci || !executor || ci.version !== principal.ciBindingVersion || ci.deviceId !== principal.deviceId ||
      executor.deviceId !== principal.deviceId || executor.generation !== message.session.generation ||
      ci.worktreeId === executor.worktreeId || principal.bindings?.[message.session.id] !== executor.worktreeId) forbidden();
  const scope = { expectationHash: hash(canonical(tuple)), sessionHash: hash(canonical(message.session)),
    ciBindingVersion: ci.version, executorBindingVersion: executor.version };
  if (pinned && canonical(pinned) !== canonical(scope)) forbidden();
  const task = state.tasks[scopedObjectKey(principal, message.session, `task:${tuple.taskId}`)];
  if (!task || task.repositoryId !== principal.repositoryId || canonical(task.session) !== canonical(message.session) ||
      task.plan?.ref !== tuple.planRef || task.plan.version !== tuple.planVersion || task.planSourceSha !== tuple.planSourceSha ||
      task.planReview?.ref !== tuple.approvalReceiptId || task.planReview.version !== tuple.approvalReceiptId ||
      task.planReview.decision !== 'approved' || task.sourceSha !== tuple.sourceSha || task.handoff?.sourceSha !== tuple.sourceSha ||
      task.handoff.ciTodoRef !== tuple.ciTodoRef || task.references?.[tuple.ciTodoRef] !== tuple.ciTodoVersion) forbidden();
  const object = ref => state.objects[scopedObjectKey(principal, message.session, ref)];
  const plan = object(tuple.planRef)?.versions?.[tuple.planVersion];
  const approval = object(tuple.approvalReceiptId)?.versions?.[tuple.approvalReceiptId];
  const issued = Object.values(state.receipts).some(value => value.reply?.ok === true &&
    value.reply.data?.taskId === task.id && value.reply.data.stage === 'executing' &&
    value.reply.data.receiptId === tuple.approvalReceiptId && value.reply.data.version === tuple.approvalReceiptId);
  if (plan?.kind !== 'plan' || approval?.kind !== 'reviewReceipt' || !issued ||
      approval.content?.kind !== 'plan' || approval.content.decision !== 'approved' ||
      approval.content.ref !== tuple.planRef || approval.content.version !== tuple.planVersion ||
      approval.content.receiptId !== tuple.approvalReceiptId || typeof approval.content.issuer !== 'string' ||
      !approval.content.issuer || approval.content.issuer === principal.agentId) forbidden();
  if (message.type === 'ci.result' && receipt) {
    // Core annotates TODO and advances the Task on acceptance. A lost ACK can
    // read that exact historical result, but cannot authorize a new operation.
    if (!['awaiting-merge', 'ci-failed'].includes(task.stage) || !receipt.reply?.ok ||
        message.payload.taskId !== task.id || message.payload.sourceSha !== tuple.sourceSha ||
        task.ci?.ref !== receipt.reply.data?.ref || task.ci.version !== receipt.reply.data.version ||
        task.ci.verdict !== message.payload.verdict) forbidden();
    const result = object(task.ci.ref)?.versions?.[task.ci.version], references = result?.content?.references;
    if (result?.kind !== 'ciResult' || !record(references) ||
        canonical(result.content) !== canonical({ ...message.payload, references })) forbidden();
    for (const check of message.payload.checks) for (const ref of [check.evidenceRef, check.reproductionRef].filter(Boolean)) {
      if (!ref.startsWith(`ci:${principal.agentId}:`) || !references[ref] || object(ref)?.versions?.[references[ref]]?.kind !== 'evidence') forbidden();
    }
    return;
  }
  const active = Object.values(state.tasks).filter(value => value.repositoryId === principal.repositoryId &&
    canonical(value.session) === canonical(message.session) && value.busy && value.stage === 'testing');
  const todo = object(tuple.ciTodoRef);
  if (active.length !== 1 || active[0].id !== task.id || !task.busy || task.stage !== 'testing' ||
      todo?.latest !== tuple.ciTodoVersion || todo.versions?.[tuple.ciTodoVersion]?.kind !== 'ciTodo') forbidden();
  if (message.type === 'ci.result' && (message.payload.taskId !== task.id || message.payload.sourceSha !== tuple.sourceSha ||
      message.payload.checks.some(check => [check.evidenceRef, check.reproductionRef].filter(Boolean)
        .some(ref => !ref.startsWith(`ci:${principal.agentId}:`))))) forbidden();
  if (message.type !== 'object.read' && !receipt) {
    // Only a write transaction may pin a new operation. ProtocolStore commits
    // this alongside its reducer effects and receipt, or rolls back all three.
    state.cursorCiTaskScopes ||= {};
    state.cursorCiTaskScopes[receiptKey] = scope;
  }
}
