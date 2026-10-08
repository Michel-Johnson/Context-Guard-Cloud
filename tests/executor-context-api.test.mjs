import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { skillFile, skillImport } from './helpers/skill.mjs';
import { createMemoryHandler } from '../scripts/cloud/memory.mjs';
import { writeProjectMemory } from '../scripts/cloud/memory-filesystem.mjs';
import { memoryReadViews } from '../scripts/cloud/memory-read-view.mjs';
import { contextChanges, contextChangeLines } from '../scripts/shared/context-tree.mjs';

function state() {
  const node = (id, title) => ({ id, title, purpose: title, kind: 'work', children: [], memories: [], bugs: [], todos: [], ideas: [] });
  return { revision: 1, main: { version: 'v1', mainSha: 'a'.repeat(40), memory: { map: { v: 1, project: '隔离项目',
    root: { ...node('ROOT', '隔离项目'), kind: 'module', memoryDocument: '项目级规则', children: [node('A', '主页'), node('B', '鉴权'), node('C', '其他模块')] },
    flows: [{ from: 'A', to: 'B', label: '依赖鉴权' }] }, records: {} } }, sessions: {}, receipts: {}, history: [], events: [], eventCursors: {} };
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-context-api-'));
  let snapshot = state();
  const configuration = { dataDir, adminToken: 'synthetic-admin', projects: { project: { token: 'synthetic-project' } } };
  await writeProjectMemory(memoryReadViews, dataDir, 'project', snapshot);
  const handler = createMemoryHandler(configuration, { authorizeDevice: async ({ credential, sessionId }) => credential === 'synthetic-device' && sessionId === 'executor' ? { agentId: 'executor' } : false });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (query = '?session=executor', token = 'synthetic-device', method = 'GET') => {
    const response = await fetch(`${origin}/v1/projects/project/context${query}`, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  const update = async mutate => { mutate(snapshot); snapshot = { ...snapshot, revision: snapshot.revision + 1, main: { ...snapshot.main, version: `v${snapshot.revision + 1}` } }; await writeProjectMemory(memoryReadViews, dataDir, 'project', snapshot); };
  return { dataDir, origin, snapshot, configuration, requests, get, update };
}

test('真实 HTTP 开工索引不含节点正文；只读指定切片且固定版本', async t => {
  const { get, update } = await fixture(t);
  const index = await get();
  assert.equal(index.status, 200);
  assert.equal(index.body.tree.nodes.A.name, '主页');
  assert.equal(index.body.projectId, 'project');
  assert.doesNotMatch(JSON.stringify(index.body), /项目级规则|memoryDocument|records|sources/);
  const root = await get('?session=executor&node=ROOT&version=v1');
  assert.equal(root.body.content.node.memoryDocument, '项目级规则');
  assert.equal(root.body.content.node.children, undefined);
  await update(value => { value.main.memory.map.root.children[0].purpose = '主页新要求'; });
  const stale = await get('?session=executor&node=A&version=v1');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
});

test('真实 HTTP 拒绝无凭据、其他项目凭据、伪造 Session 和写请求', async t => {
  const { get, origin } = await fixture(t);
  assert.equal((await get('', '')).status, 400);
  assert.equal((await get('?session=executor', '')).status, 401);
  assert.equal((await get('?session=executor', 'other-project')).status, 401);
  assert.equal((await get('?session=other', 'synthetic-device')).status, 401);
  assert.equal((await get('?session=executor', 'synthetic-device', 'POST')).status, 405);
  const response = await fetch(`${origin}/v1/projects/other/context?session=executor`, { headers: { Authorization: 'Bearer synthetic-project' } });
  assert.equal(response.status, 401);
});

test('拒绝节点、Idea、其他 Session 事项与原始记录在索引和切片中均不可见', async t => {
  const { update, get } = await fixture(t);
  await update(value => {
    const a = value.main.memory.map.root.children[0];
    a.ideas = [{ id: 'I1', title: '隔离 Idea' }];
    a.bugs = [{ id: 'B1', title: '自己的 Bug', sessions: ['executor'] }, { id: 'B2', title: '其他人的 Bug', sessions: ['other'] }];
    value.main.memory.records = { 'bugs/B1.md': '自己的记录', 'bugs/B2.md': '私有其他记录' };
    value.main.memory.map.root.children[2].access = [{ agentId: 'executor', allow: 'none' }];
  });
  const index = await get(), slice = await get('?session=executor&node=A');
  assert.equal(index.body.tree.nodes.C, undefined);
  assert.deepEqual(slice.body.content.node.bugs.map(item => item.id), ['B1']);
  assert.deepEqual(slice.body.content.records, { 'bugs/B1.md': '自己的记录' });
  assert.doesNotMatch(JSON.stringify([index.body, slice.body]), /其他人的 Bug|隔离 Idea|私有其他记录/);
  assert.equal((await get('?session=executor&node=C')).status, 404);
});

test('真实 HTTP 两次读取能检查挂载与关联变化；无关正文不报，结构变化会报', async t => {
  const { get, update } = await fixture(t);
  const before = (await get()).body.tree;
  await update(value => {
    value.main.memory.map.root.children[1].purpose = '鉴权需求更新';
    value.main.memory.map.root.children[2].purpose = '无关正文更新';
  });
  const after = (await get()).body.tree;
  assert.deepEqual(contextChangeLines(contextChanges(before, after, { mounted: ['A'] })), ['鉴权 — 修改']);
  await update(value => { value.main.memory.map.root.children[2].title = '其他模块新名字'; });
  assert.ok(contextChangeLines(contextChanges(before, (await get()).body.tree, { mounted: ['A'] })).includes('其他模块新名字 — 改名'));
});

test('缓存不能吞掉节点权限撤销，已拒绝的节点不返回历史正文', async t => {
  const { get, update } = await fixture(t);
  assert.equal((await get('?session=executor&node=A')).status, 200);
  await get();
  await update(value => { value.main.memory.map.root.children[0].access = [{ agentId: 'executor', allow: 'none' }]; });
  assert.equal((await get()).body.tree.nodes.A, undefined);
  assert.equal((await get('?session=executor&node=A')).status, 404);
});

test('固定发布的 Skill CLI 与真实 Cloud 服务完成读取、缓存、检查与失效闭环', async t => {
  const { dataDir, origin, get, update, requests } = await fixture(t);
  const root = path.join(dataDir, 'synthetic-worktree');
  await fs.mkdir(root);
  const { resolveProject, sessionBinding, sessionBindingsPath } = await skillImport('scripts/workbench/project.mjs');
  const { memoryConfigPath, sessionMemoryDir } = await skillImport('scripts/workbench/memory.mjs');
  const { atomicWrite, encode } = await skillImport('scripts/shared/io.mjs');
  const project = await resolveProject(root);
  await atomicWrite(sessionBindingsPath(project), encode({ sessions: { executor: await sessionBinding(project, 'executor') } }));
  await atomicWrite(memoryConfigPath(project), encode({ url: origin, projectId: 'project', token: 'synthetic-project' }));
  const run = promisify(execFile);
  const cli = async args => JSON.parse((await run(process.execPath, [skillFile('bin/context-guard-skill.js'), ...args, '--root', root, '--session', 'executor'], { windowsHide: true, timeout: 20000 })).stdout);
  const navigation = await cli(['map', 'read', '--context']);
  assert.equal(navigation.source, 'cloud');
  assert.equal(navigation.global.node.memoryDocument, '项目级规则');
  await cli(['map', 'read', '--context', '--node', '主页', '--mount', '主页']);
  const count = requests.length;
  await cli(['map', 'read', '--context', '--node', '主页']);
  assert.equal(requests.length, count, '开发重复读取不访问 Cloud');
  await update(value => { value.main.memory.map.root.children[1].purpose = '鉴权条件改变'; });
  assert.deepEqual(await cli(['map', 'context-check']), ['鉴权 — 修改']);
  const diff = await cli(['map', 'read', '--context', '--node', '鉴权', '--diff']);
  assert.equal(diff.before, null, '未读过旧正文时不得编造差异');
  assert.equal(diff.after.node.purpose, '鉴权条件改变');
  assert.deepEqual(await cli(['map', 'context-check', '--accept-changes']), ['无变化']);
  await update(value => { value.main.memory.map.root.memoryDocument = '新的全局约束'; });
  await assert.rejects(cli(['map', 'context-check', '--require-clear']), error => error.code === 1 && JSON.parse(error.stdout).error.code === 'CONTEXT_CHANGED');
  assert.ok(requests.every(url => url.startsWith('/v1/projects/project/context?')));
  await assert.rejects(fs.access(path.join(sessionMemoryDir(project, 'executor'), 'map.json')), { code: 'ENOENT' });
  assert.equal((await get()).status, 200);
});
