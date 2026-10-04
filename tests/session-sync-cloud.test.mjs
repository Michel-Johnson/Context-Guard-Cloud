import { skillImport } from './helpers/skill.mjs';
import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMemoryServer } from '../scripts/cloud/memory.mjs';
import { atomicWrite, encode } from '../scripts/shared/io.mjs';
const { memoryConfigPath, memoryRequest, sessionMemoryDir } = await skillImport('scripts/workbench/memory.mjs');
const { resolveProject, sessionBinding, sessionBindingsPath } = await skillImport('scripts/workbench/project.mjs');
const { sessionSync } = await skillImport('scripts/workbench/sync.mjs');

const node = (id, title) => ({ id, title, kind: 'work', state: 'dirty', purpose: '', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children: [] });
const document = () => ({ v: 1, project: 'Sync Fixture', bootstrap: 'ready', flows: [], root: { ...node('T0', 'Sync Fixture'), kind: 'module', children: [node('N1', 'One'), node('N2', 'Two')] } });
async function fixture(t, git = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-guard-session-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (git) {
    for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture']]) {
      execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    }
  }
  const project = await resolveProject(root);
  return { root, project, retired: path.join(root, '.codex/context/private/cloud-sync') };
}
const write = (file, value) => atomicWrite(file, encode(value));

test('Session prepare/finish use current receipts, isolate Sessions and preserve conflicting drafts', async t => {
  const { root, project } = await fixture(t, true);
  const service = await startMemoryServer({ dataDir: path.join(root, 'cloud'), adminToken: 'admin', projects: { project: { token: 'token' } }, host: '127.0.0.1', port: 0 });
  t.after(() => service.close());
  await write(memoryConfigPath(project), { url: service.url, projectId: 'project', token: 'token' });
  await write(sessionBindingsPath(project), { sessions: { a: await sessionBinding(project, 'a'), b: await sessionBinding(project, 'b') } });
  for (const sessionId of ['a', 'b']) {
    await memoryRequest(project, 'sessions/' + sessionId, { operationId: 'seed-' + sessionId, baseVersion: null, baseMainVersion: null, sourceCommit: project.head, memory: { map: document(), records: {} } });
    assert.equal((await sessionSync(root, sessionId, 'prepare')).current, true);
  }
  const aFile = path.join(sessionMemoryDir(project, 'a'), 'map.json');
  const draft = JSON.parse(await fs.readFile(aFile)); draft.root.children[0].purpose = 'from A';
  await write(aFile, draft);
  const first = await sessionSync(root, 'a', 'finish');
  assert.equal(first.confirmed, true);
  assert.equal((await memoryRequest(project, 'sessions/a')).snapshot.memory.map.root.children[0].purpose, 'from A');
  assert.equal((await memoryRequest(project, 'sessions/b')).snapshot.memory.map.root.children[0].purpose, '');
  const retry = await sessionSync(root, 'a', 'finish');
  assert.equal(retry.sessionVersion, first.sessionVersion, 'an unchanged retry reuses the confirmed snapshot');
  const remote = (await memoryRequest(project, 'sessions/a')).snapshot;
  await memoryRequest(project, 'sessions/a/map', { operationId: 'remote-edit', baseVersion: remote.version, operations: [{ type: 'update', id: 'N1', fields: { purpose: 'remote' } }] });
  draft.root.children[0].purpose = 'unsent local'; await write(aFile, draft);
  await assert.rejects(sessionSync(root, 'a', 'checkpoint'), { code: 'MEMORY_CONFLICT' });
  assert.deepEqual(JSON.parse(await fs.readFile(aFile)), draft);
  await assert.rejects(sessionSync(root, 'not-bound', 'prepare'), { code: 'SESSION_BINDING_REQUIRED' });
});
