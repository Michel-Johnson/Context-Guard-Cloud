import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorTaskMapRead } from '../scripts/cloud/cursor-task-map.mjs';

function fixture() {
  const snapshot = { version: 'current', memory: { records: { 'todos/own.md': 'own record', 'todos/other.md': 'private other record' }, map: {
    v: 1, root: { id: 'root', title: 'Project', children: [
      { id: 'A', title: 'Assigned', purpose: 'Assigned context', memories: [{ text: 'keep this behavior' }],
        todos: [{ id: 'own', title: 'Own task', sessions: ['executor'] }, { id: 'other', title: 'PRIVATE_OTHER', sessions: ['other'] }],
        children: [{ id: 'child', title: 'Child', owns: ['src/child.mjs'], children: [] }] },
      { id: 'B', title: 'PRIVATE_SIBLING', purpose: 'outside task', children: [] },
    ] }, flows: [{ from: 'A', to: 'B', label: 'PRIVATE_RELATION' }, { from: 'A', to: 'child', label: 'uses' }] } } };
  const task = { id: 'task', session: { id: 'executor', generation: 1 }, assignment: { mainVersion: 'approved', nodeIds: ['A'] } };
  return { snapshot, task };
}

test('task Map navigation is lightweight and only lists the approved assigned subtree', () => {
  const f = fixture(), before = JSON.stringify(f), result = cursorTaskMapRead(f.snapshot, f.task);
  assert.equal(result.version, 'current'); assert.equal(result.approvedMainVersion, 'approved');
  assert.deepEqual(result.nodes.map(n => n.nodeId), ['A']);
  assert.deepEqual(result.nodes[0].children, [{ nodeId: 'child', title: 'Child' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('keep this behavior'), false);
  assert.equal(JSON.stringify(f), before, 'Map reads do not change memory, task or approval');
});

test('task Map node bodies reuse Core Session filtering without leaking other tasks or relationships', () => {
  const f = fixture(), result = cursorTaskMapRead(f.snapshot, f.task, { nodeId: 'A', expectedVersion: 'current' });
  assert.equal(result.node.memories[0].text, 'keep this behavior');
  assert.deepEqual(result.node.todos.map(item => item.id), ['own']);
  assert.deepEqual(result.records, { 'todos/own.md': 'own record' });
  assert.deepEqual(result.related, [{ name: 'Child', label: 'uses' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(cursorTaskMapRead(f.snapshot, f.task, { nodeId: 'child' }).node.owns, ['src/child.mjs']);
});

test('task Map reads reject foreign nodes, identity substitution, missing scope and stale observed versions', () => {
  const f = fixture();
  for (const nodeId of ['B', 'root', 'unknown']) assert.throws(() => cursorTaskMapRead(f.snapshot, f.task, { nodeId }), { code: 'ROLE_FORBIDDEN' });
  for (const input of [null, [], { projectId: 'other' }, { session: 'other' }, { nodeId: '' }, { nodeId: 3 }])
    assert.throws(() => cursorTaskMapRead(f.snapshot, f.task, input), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => cursorTaskMapRead(f.snapshot, f.task, { expectedVersion: 'old' }), { code: 'CONFLICT' });
  assert.throws(() => cursorTaskMapRead(f.snapshot, { ...f.task, assignment: { nodeIds: [] } }), { code: 'ROLE_FORBIDDEN' });
});

test('current ACL revocation cannot be overridden by the task Map delegation', () => {
  const f = fixture(), node = f.snapshot.memory.map.root.children[0];
  node.children[0].access = [{ agentId: 'executor', allow: 'none' }];
  assert.deepEqual(cursorTaskMapRead(f.snapshot, f.task).nodes[0].children, []);
  assert.throws(() => cursorTaskMapRead(f.snapshot, f.task, { nodeId: 'child' }), { code: 'ROLE_FORBIDDEN' });
  node.access = [{ agentId: 'executor', allow: 'none' }];
  assert.throws(() => cursorTaskMapRead(f.snapshot, f.task), { code: 'ROLE_FORBIDDEN' });
});
