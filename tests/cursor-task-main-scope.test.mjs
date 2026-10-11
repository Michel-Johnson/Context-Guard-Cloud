import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../scripts/shared/protocol.mjs';
import { cursorTaskMainScopeUnchanged } from '../scripts/cloud/cursor-task-main-scope.mjs';

function fixture() {
  const map = { v: 1, project: 'fixture', bootstrap: 'ready', updated: 'old-date', flows: [],
    root: { id: 'R', title: 'Root', purpose: 'global constraint', todos: [], children: [
      { id: 'P', title: 'Parent', purpose: 'parent constraint', children: [
        { id: 'A', title: 'Assigned', purpose: 'task context', owns: ['src/a.mjs'], memories: [{ text: 'keep behavior' }], children: [] },
      ] },
      { id: 'B', title: 'Other', purpose: 'unrelated', children: [] },
      { id: 'C', title: 'Dependency', purpose: 'dependency contract', children: [] },
    ] } };
  const original = { version: 'original', memory: { map } };
  return { memory: { main: structuredClone(original), history: [{ scope: 'main', snapshot: structuredClone(original) }] },
    task: { session: { id: 'executor', generation: 1 }, assignment: { mainVersion: 'original', nodeIds: ['A'] } } };
}
const assigned = f => f.memory.main.memory.map.root.children[0].children[0];
const bump = f => { f.memory.main.version = 'new'; return f; };

test('same authoritative Main remains compatible without a history dependency', () => {
  const f = fixture(); f.memory.history = [];
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), true);
});

test('unrelated node and parent work-item updates do not revoke the unchanged original Task', () => {
  const f = bump(fixture()), beforeTask = canonical(f.task);
  f.memory.main.memory.map.root.children[1].purpose = 'other task change';
  f.memory.main.memory.map.root.todos.push({ id: 'unrelated', title: 'other task' });
  f.memory.main.memory.map.updated = 'new-date';
  f.memory.main.memory.map.root.children.push({ id: 'D', title: 'New unrelated node', children: [] });
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), true);
  assert.equal(canonical(f.task), beforeTask, 'approval and assigned version must not be rewritten');
});

test('assigned context, descendants and unknown fields remain protected', async t => {
  for (const [name, change] of [
    ['purpose', node => { node.purpose = 'changed requirement'; }],
    ['memory', node => { node.memories[0].text = 'changed constraint'; }],
    ['owns', node => { node.owns.push('src/b.mjs'); }],
    ['child', node => { node.children.push({ id: 'A-child', title: 'new implementation', children: [] }); }],
    ['access', node => { node.access = [{ agentId: 'executor', allow: 'none' }]; }],
    ['unknown', node => { node.customConstraint = 'new'; }],
  ]) await t.test(name, () => {
    const f = bump(fixture()); change(assigned(f));
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
});

test('ancestor constraints, task location and shared global context remain protected', async t => {
  for (const [name, change] of [
    ['root constraint', f => { f.memory.main.memory.map.root.purpose = 'new global constraint'; }],
    ['parent permission', f => { f.memory.main.memory.map.root.children[0].access = [{ agentId: 'executor', allow: 'none' }]; }],
    ['move', f => { f.memory.main.memory.map.root.children[1].children.push(f.memory.main.memory.map.root.children[0].children.pop()); }],
    ['delete', f => { f.memory.main.memory.map.root.children[0].children = []; }],
    ['global', f => { f.memory.main.memory.map.policy = { deployment: 'forbidden' }; }],
  ]) await t.test(name, () => {
    const f = bump(fixture()); change(f);
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
});

test('declared related-node context and relationships are protected while unrelated flows can change', async t => {
  await t.test('related contract', () => {
    const f = fixture(); f.memory.main.memory.map.flows = [{ id: 'ac', from: 'A', to: 'C', label: 'uses' }];
    f.memory.history[0].snapshot.memory.map.flows = structuredClone(f.memory.main.memory.map.flows);
    bump(f); f.memory.main.memory.map.root.children[2].purpose = 'changed dependency';
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
  await t.test('new related edge', () => {
    const f = bump(fixture()); f.memory.main.memory.map.flows.push({ id: 'ac', from: 'A', to: 'C', label: 'uses' });
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
  await t.test('unrelated edge', () => {
    const f = bump(fixture()); f.memory.main.memory.map.flows.push({ id: 'bc', from: 'B', to: 'C', label: 'uses' });
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), true);
  });
});

test('missing, wrong-scope or conflicting historical baselines fail closed', async t => {
  for (const [name, change] of [
    ['missing', f => { f.memory.history = []; }],
    ['Session is not Main', f => { f.memory.history[0].scope = 'session:other'; }],
    ['wrong version', f => { f.memory.history[0].snapshot.version = 'other-version'; }],
    ['conflicting history', f => { const entry = structuredClone(f.memory.history[0]); entry.snapshot.memory.map.root.purpose = 'forged'; f.memory.history.push(entry); }],
    ['conflicting non-Map history', f => { const entry = structuredClone(f.memory.history[0]); entry.snapshot.memory.records = { rule: 'different original' }; f.memory.history.push(entry); }],
  ]) await t.test(name, () => {
    const f = bump(fixture()); change(f);
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
});

test('invalid or ambiguous assigned scope cannot authorize work', async t => {
  for (const [name, change] of [
    ['empty scope', f => { f.task.assignment.nodeIds = []; }],
    ['unknown node', f => { f.task.assignment.nodeIds = ['missing']; }],
    ['duplicate ID', f => { f.memory.main.memory.map.root.children.push(structuredClone(assigned(f))); }],
    ['missing current version', f => { delete f.memory.main.version; }],
  ]) await t.test(name, () => {
    const f = bump(fixture()); change(f);
    assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
  });
});

test('scope validation is read-only and does not manufacture a new approval or baseline', () => {
  const f = bump(fixture()), before = canonical(f);
  cursorTaskMainScopeUnchanged(f.memory, f.task);
  assert.equal(canonical(f), before);
});

test('another Session work item under an assigned subtree is not the current Task context', () => {
  const f = fixture(); assigned(f).children.push({ id: 'A-child', title: 'Implementation', children: [] });
  f.memory.history[0].snapshot = structuredClone(f.memory.main); bump(f);
  assigned(f).children[0].todos = [{ id: 'other-task', title: 'unrelated work', sessions: ['other-executor'] }];
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), true);
  assigned(f).children[0].todos[0].sessions = ['executor'];
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
});

test('a named original source item stays protected even before child-Session assignment', () => {
  const f = fixture(), sourceItem = { kind: 'todo', nodeId: 'A', itemId: 'source-task' };
  assigned(f).todos = [{ id: sourceItem.itemId, title: 'approved original', sessions: ['template'] }];
  f.memory.history[0].snapshot = structuredClone(f.memory.main); bump(f);
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task, { sourceItem }), true);
  assigned(f).todos[0].title = 'new requirement';
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task, { sourceItem }), false);
});

test('other Main memory records are not assumed to be unrelated', () => {
  const f = bump(fixture()); f.memory.main.memory.records = { rule: 'changed referenced constraint' };
  assert.equal(cursorTaskMainScopeUnchanged(f.memory, f.task), false);
});
