import { canonical } from '../shared/protocol.mjs';
import { workItemAssignedTo } from '../shared/map-model.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

function index(document) {
  if (!object(document?.root) || !Array.isArray(document.flows || [])) return null;
  const nodes = new Map(), pending = [[document.root, []]];
  while (pending.length) {
    const [node, parents] = pending.pop();
    if (!object(node) || !text(node.id) || nodes.has(node.id) || parents.length > 64 || nodes.size >= 10000 ||
        node.children !== undefined && !Array.isArray(node.children)) return null;
    nodes.set(node.id, { node, parents });
    for (const child of node.children || []) pending.push([child, [...parents, node.id]]);
  }
  if ((document.flows || []).some(flow => !object(flow) || !nodes.has(flow.from) || !nodes.has(flow.to))) return null;
  return nodes;
}

function parentContext(node) {
  // A parent's constraints/access apply to descendants. Its child listing and
  // unrelated work-item activity do not change the approved Task context.
  const { children, todos, bugs, ideas, dormant, ...context } = node;
  return context;
}

function documentContext(document) {
  // updated is Map bookkeeping, not a task requirement. Unknown fields remain
  // protected; do not infer that an unrecognized global policy is harmless.
  const { root, flows, updated, unassigned_bugs, ...context } = document;
  return context;
}

function taskNode(node, sessionId, sourceItem) {
  const result = { ...node, children: (node.children || []).map(child => taskNode(child, sessionId, sourceItem)) };
  for (const [field, kind] of [['todos', 'todo'], ['bugs', 'bug']]) {
    if (node[field] !== undefined && !Array.isArray(node[field])) throw Error('Invalid work items');
    result[field] = (node[field] || []).filter(item => workItemAssignedTo(item, sessionId) ||
      sourceItem?.kind === kind && sourceItem.nodeId === node.id && sourceItem.itemId === item.id);
  }
  return result;
}

function sourceRecord(nodes, sourceItem) {
  if (!sourceItem) return null;
  if (!['todo', 'bug'].includes(sourceItem.kind) || !text(sourceItem.nodeId) || !text(sourceItem.itemId)) throw Error('Invalid original work item');
  const list = nodes.get(sourceItem.nodeId)?.node[sourceItem.kind === 'todo' ? 'todos' : 'bugs'];
  const matches = Array.isArray(list) ? list.filter(item => item.id === sourceItem.itemId) : [];
  if (matches.length !== 1) throw Error('Original work item unavailable');
  return matches[0];
}

function projection(document, nodes, roots, scope, sessionId, sourceItem) {
  const selected = [...roots].sort().map(id => {
    const found = nodes.get(id);
    return { id, node: taskNode(found.node, sessionId, sourceItem), parents: found.parents.map(parent => ({ id: parent, context: parentContext(nodes.get(parent).node) })) };
  });
  const flows = (document.flows || []).filter(flow => scope.has(flow.from) || scope.has(flow.to)).map(canonical).sort();
  return canonical({ document: documentContext(document), selected, flows, sourceItem: sourceRecord(nodes, sourceItem) });
}

// The immutable assigned version is retained. Only server-held Main history can
// prove its original context. Current grants, bindings and node permissions are
// still checked by the caller at every launch/completion; this grants no access.
export function cursorTaskMainScopeUnchanged(memory, task, { sourceItem } = {}) {
  try {
    const assignment = task?.assignment, current = memory?.main;
    if (!text(task?.session?.id) || !text(current?.version) || !text(assignment?.mainVersion) || !Array.isArray(assignment.nodeIds) ||
        !assignment.nodeIds.length || assignment.nodeIds.length > 100 || assignment.nodeIds.some(id => !text(id)) ||
        new Set(assignment.nodeIds).size !== assignment.nodeIds.length) return false;
    const currentDocument = current.memory?.map, currentNodes = index(currentDocument);
    if (!currentNodes || assignment.nodeIds.some(id => !currentNodes.has(id))) return false;
    sourceRecord(currentNodes, sourceItem);
    if (current.version === assignment.mainVersion) return true;
    const originals = Array.isArray(memory.history) ? memory.history.filter(entry => entry.scope === 'main' &&
      entry.snapshot?.version === assignment.mainVersion).map(entry => entry.snapshot.memory) : [];
    if (!originals.length || originals.some(document => canonical(document) !== canonical(originals[0]))) return false;
    const originalDocument = originals[0]?.map, originalNodes = index(originalDocument);
    if (!originalNodes || assignment.nodeIds.some(id => !originalNodes.has(id))) return false;
    // Other Main memory fields may contain global constraints or referenced
    // records. Unknown storage is not silently classified as unrelated.
    const { map: oldMap, ...oldMemory } = originals[0];
    const { map: currentMap, ...currentMemory } = current.memory;
    if (canonical(oldMemory) !== canonical(currentMemory)) return false;
    // Include declared dependencies (and their descendants) transitively. Both
    // graphs participate, so adding/removing a relevant edge cannot evade review.
    const roots = new Set([...assignment.nodeIds, ...(sourceItem ? [sourceItem.nodeId] : [])]), scope = new Set(), pending = [...roots];
    const edges = new Map();
    for (const flow of [...(originalDocument.flows || []), ...(currentDocument.flows || [])]) {
      for (const [from, to] of [[flow.from, flow.to], [flow.to, flow.from]]) {
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from).add(to);
      }
    }
    while (pending.length) {
      const id = pending.pop(); if (scope.has(id)) continue;
      scope.add(id);
      const before = originalNodes.get(id), after = currentNodes.get(id);
      if (!before || !after) return false;
      for (const child of [...(before.node.children || []), ...(after.node.children || [])]) pending.push(child.id);
      for (const related of edges.get(id) || []) { roots.add(related); pending.push(related); }
    }
    // Avoid serializing the same subtree once per descendant.
    for (const id of [...roots]) {
      if (originalNodes.get(id).parents.some(parent => roots.has(parent))) roots.delete(id);
    }
    return projection(originalDocument, originalNodes, roots, scope, task.session.id, sourceItem) ===
      projection(currentDocument, currentNodes, roots, scope, task.session.id, sourceItem);
  } catch { return false; }
}
