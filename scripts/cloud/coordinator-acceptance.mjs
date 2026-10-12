import { validateMessage, fail } from '../shared/protocol.mjs';

// Browser and Slack use the same exact-result human review gate. Transport
// authority is assigned by the host, never by model output or request fields.
export async function reviewCoordinatorAcceptance({ input, conversationId, bindings, store, principal, owner, simulated = false, actor }) {
  if (!input || Object.keys(input).some(key => !['id','sessionId','taskId','ref','version','decision','reason','generation'].includes(key)) ||
      !Object.hasOwn(bindings, input.sessionId)) fail('INVALID_ARGUMENT', 'Select an assigned task and exact CI result');
  if (actor && actor.kind !== 'human') fail('FORBIDDEN', 'Acceptance requires verified human authority');
  const binding = await store.registeredBinding(principal, input.sessionId);
  if (!binding) fail('NOT_FOUND', 'Session is not registered');
  if (input.generation !== undefined && input.generation !== binding.generation) fail('CONFLICT', 'Acceptance Session generation changed');
  const session = { id:input.sessionId, generation:binding.generation };
  const task = await store.taskRecord(principal, session, input.taskId);
  if (conversationId !== 'main' && await owner(input.sessionId, input.taskId) !== conversationId) fail('FORBIDDEN', 'Task belongs to another conversation');
  if (task.ci?.ref !== input.ref || task.ci?.version !== input.version || task.ci?.verdict !== 'passed') fail('CONFLICT', 'Acceptance must reference the current passed CI result');
  if (typeof input.reason !== 'string' || !input.reason.trim()) fail('INVALID_ARGUMENT', 'Record the human acceptance result or rejection reason');
  const message = validateMessage({v:2,id:input.id,type:'review.result',session,payload:{kind:'acceptance',ref:input.ref,version:input.version,
    decision:input.decision,reason:(simulated?'[模拟人工验收] ':'')+input.reason}});
  return (await store.handle(actor ? {...principal,agentId:actor.sessionId} : principal,message)).data;
}
