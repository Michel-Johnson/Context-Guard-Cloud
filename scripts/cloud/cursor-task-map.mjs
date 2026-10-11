import { entries } from '../shared/map-model.mjs';
import { contextDocument, contextSlice } from '../shared/context-tree.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Core's ACL and Session-item projection remain authoritative. A task delegates
// only its assigned subtrees, not project-wide reads or any Main write.
export function cursorTaskMapRead(snapshot, task, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['nodeId', 'expectedVersion'].includes(key)) ||
      Object.values(input).some(value => typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)))
    fail('INVALID_ARGUMENT', 'Use only a node ID and optional observed Map version');
  if (input.expectedVersion && input.expectedVersion !== snapshot?.version) fail('CONFLICT', 'Map changed; reread task navigation');
  const roots = task?.assignment?.nodeIds;
  if (!task?.session?.id || !Array.isArray(roots) || !roots.length) fail('ROLE_FORBIDDEN', 'Task has no assigned Map scope');
  const scoped = contextDocument(snapshot, { sessionId: task.session.id });
  const index = entries(scoped.memory.map.root), allowed = new Set();
  const visit = node => {
    allowed.add(node.id);
    for (const child of [...(node.children || []), ...(node._inbox || [])]) visit(child);
  };
  for (const id of roots) {
    const node = index.get(id)?.node;
    if (!node) fail('ROLE_FORBIDDEN', 'An assigned task node is no longer readable');
    visit(node);
  }
  const identity = { taskId: task.id, version: snapshot.version, approvedMainVersion: task.assignment.mainVersion };
  if (!input.nodeId) return { ...identity, nodes: [...new Set(roots)].map(id => {
    const node = index.get(id).node;
    return { nodeId: id, title: node.title, purpose: node.purpose,
      children: [...(node.children || []), ...(node._inbox || [])].map(child => ({ nodeId: child.id, title: child.title })) };
  }) };
  if (!allowed.has(input.nodeId)) fail('ROLE_FORBIDDEN', 'Read only the original task assigned subtrees');
  const visibleFlow = flow => allowed.has(flow.from) && allowed.has(flow.to);
  scoped.memory.map.flows = (scoped.memory.map.flows || []).filter(visibleFlow);
  scoped.memory.map.root.flows = (scoped.memory.map.root.flows || []).filter(visibleFlow);
  return { ...identity, ...contextSlice(scoped, input.nodeId) };
}
