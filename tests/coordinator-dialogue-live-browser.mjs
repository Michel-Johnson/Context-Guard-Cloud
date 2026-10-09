// 真实 Chromium → HTTP → 真实模型 → 工具 → 持久化。仅项目数据为隔离 fixture。
// 显式运行，凭据由本地配置提供；报告不保存凭据或模型私有推理。
import '../.github/scripts/test-environment.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { CoordinatorModel } from '../scripts/cloud/coordinator-model.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { readMemoryView } from '../scripts/cloud/memory.mjs';

assert.ok(process.env.CONTEXT_GUARD_COORDINATOR_PROVIDER_FILE, '须显式指定真实模型配置');
const providerFile = path.resolve(process.env.CONTEXT_GUARD_COORDINATOR_PROVIDER_FILE);
const provider = JSON.parse(await fs.readFile(providerFile, 'utf8'));
const output = path.resolve(process.argv[2] || `temp/dialogue-live-browser-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-dialogue-live-'));
const projectId = 'dialogue-acceptance';
const memories = ['项目规则：不得自动创建执行会话。', '登录规则：失败后保留已输入用户名。', '提示规则：提示用中文且不得泄露凭据。'];
const node = (id, title, purpose, children = [], memoryDocument = '') => ({ id, title, purpose, children, memoryDocument,
  kind: 'module', state: 'dirty', owns: [], memories: [], todos: [], bugs: [], ideas: [], dormant: [], files: [] });
const document = { v: 1, project: '对话验收', bootstrap: 'ready', flows: [], root: node('T0', '对话验收', '验证人类确认流程', [
  node('LOGIN', '登录', '用户认证', [node('ERROR', '错误提示', '登录失败时显示提示', [], memories[2])], memories[1]),
  node('PERMISSION', '权限控制', '校验访问权限', [], '权限规则：拒绝访问时不泄露资源详情。'),
], memories[0]) };
const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: randomUUID(), projects: { [projectId]: {
  root: directory, ref: 'refs/heads/main', token: randomUUID(), coordinator: { enabled: true, providerFile, bindings: {}, mapWrite: true },
} } };
const memoryFile = legacyProjectMemoryFile(memoryConfig.dataDir, projectId);
await fs.mkdir(path.dirname(memoryFile), { recursive: true });
await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'live-main', memory: { map: document, records: {} } },
  sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: projectId, name: '对话验收' }] }));
const calls = [], checks = [], pageErrors = [];
const options = { host: '127.0.0.1', port: 0, dataDir: directory, memoryConfig, privateAccess: true,
  browserToken: randomUUID(), browserPasswordHash: await createWorkbenchPasswordHash('isolated-dialogue-password'),
  protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/dialogue-acceptance' }] },
  coordinatorModelFactory: config => {
    const model = new CoordinatorModel(config);
    return { model: model.model, next: async input => {
      const start = Date.now(), rendered = JSON.stringify({ system: input.system, messages: input.messages });
      const bodyCounts = memories.map(body => rendered.split(body).length - 1);
      const backgroundCounts = memories.map(body => JSON.stringify(input.system).split(body).length - 1);
      console.log('真实模型开始调用');
      const result = await model.next(input);
      calls.push({ durationMs: Date.now() - start, bodyCounts, backgroundCounts, tools: result.content.filter(block => block.type === 'tool_use').map(block => block.name) });
      return result;
    } };
  } };
let service, browser, context, page, conversationId, passed = false;
const statePath = () => `/api/workbench/projects/${projectId}/api/coordinator?conversation=${encodeURIComponent(conversationId)}`;
const state = async () => (await context.request.get(service.url + statePath())).json();
const settle = async text => {
  const deadline = Date.now() + 150000;
  for (;;) {
    const s = await state();
    if ((!text || s.messages?.some(m => m.role === 'user' && m.text === text)) &&
        ['waiting-for-user', 'error', 'interrupted'].includes(s.status) && s.pendingInputCount === 0) {
      assert.equal(s.status, 'waiting-for-user', JSON.stringify(s.error || s.status));
      return s;
    }
    assert.ok(Date.now() < deadline, 'Coordinator 未在时限内完成本轮');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const record = name => { checks.push(name); console.log('真实 Map 流程通过：' + name); };
try {
  service = await startCloudServer(options);
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(service.url + `/login?next=${encodeURIComponent('/projects/' + projectId)}`);
  await page.getByLabel('密码').fill('isolated-dialogue-password'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
  await page.locator('#btn-coordinator').click();
  const panel = page.locator('#coordinator-panel');
  const confirm = async (label, endpoint) => {
    const committed = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(endpoint) && r.request().method() === 'POST');
    await panel.getByRole('button', { name: label, exact: true }).click();
    const response = await committed; assert.equal(response.status(), 200, await response.text());
    await settle();
  };
  const send = async text => {
    await panel.getByLabel('发送给 Coordinator').fill(text);
    const accepted = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/coordinator') && r.request().method() === 'POST');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    assert.equal((await accepted).status(), 202);
    return settle(text);
  };
  for (const kind of ['todo', 'bug']) {
    const created = page.waitForResponse(r => r.url().includes('/api/coordinator/conversations/new') && r.request().method() === 'POST');
    await panel.getByRole('button', { name: '新建 Coordinator Session', exact: true }).click();
    conversationId = (await (await created).json()).id;
    const initial = await readMemoryView(memoryConfig, projectId), firstCall = calls.length;
    await send(`这是一项${kind === 'todo' ? '待办：增加登录错误提示的回归测试' : 'Bug：登录失败时错误提示会泄露凭据'}。请先读取错误提示节点资料，再建议以错误提示为主节点，等我确认，不要创建事项。`);
    await panel.getByRole('button', { name: '确认绑定', exact: true }).waitFor();
    let s = await state(); assert.equal(s.focus.nodeId, null);
    const proposal = s.approvals.find(value => value.kind === 'binding-proposal' && value.pending);
    assert.equal(proposal.node.id, 'ERROR'); assert.equal(proposal.itemKind, kind);
    assert.match(proposal.pathText, /对话验收[\s\S]*登录[\s\S]*错误提示/);
    assert.ok(calls.slice(firstCall).some(call => call.tools.includes('read_map')), '真实模型须实际查询节点');
    assert.deepEqual(await readMemoryView(memoryConfig, projectId), initial, '建议不能改 Main');
    record(kind + '：查询资料并提出归属，不提前绑定');
    await confirm('确认绑定', '/binding-review');
    s = await state(); assert.equal(s.focus.nodeId, 'ERROR');
    const memoryCall = calls.length;
    await send('请根据项目、登录模块和错误提示节点的记忆，简短说明本次必须遵守的约束，先不要生成需求说明。');
    assert.ok(calls.slice(memoryCall).some(call => call.backgroundCounts.every(count => count === 1)), '祖先及当前正文在实际模型固定背景中各出现一次；原始读取回执仍保留');
    record(kind + '：确认后加载完整祖先正文并连续讨论');
    await send('请把这项需求改为归属权限控制。先提出改绑建议，等我确认。');
    s = await state(); assert.equal(s.focus.nodeId, 'ERROR', '建议改绑不能立即生效');
    await confirm('确认绑定', '/binding-review');
    assert.equal((await state()).focus.nodeId, 'PERMISSION');
    record(kind + '：改绑也经过人类确认');
    await send(`现在整理这项${kind === 'todo' ? '待办' : 'Bug'}，生成待我确认的需求说明。目标是权限校验拒绝访问时不泄露详情，验收条件为未授权请求只显示中文通用提示。不要自动执行。`);
    await panel.getByRole('button', { name: '确认需求', exact: true }).waitFor();
    s = await state(); const brief = s.approvals.find(value => value.manual && value.pending);
    assert.ok(brief); assert.deepEqual(brief.nodeIds, ['PERMISSION']); assert.equal(brief.kind, kind);
    assert.deepEqual(await readMemoryView(memoryConfig, projectId), initial, '形成说明不等于批准开发');
    await panel.screenshot({ path: path.join(output, kind + '-brief.png') });
    await confirm('确认需求', '/approval');
    const saved = await readMemoryView(memoryConfig, projectId), primary = saved.main.memory.map.root.children.find(n => n.id === 'PERMISSION');
    assert.equal(primary[kind + 's'].filter(item => item.id === brief.itemId).length, 1);
    assert.equal(Object.keys(saved.sessions).length, 0);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
    await page.locator('#btn-coordinator').click();
    const persisted = await state(); assert.equal(persisted.focus.nodeId, 'PERMISSION');
    assert.ok(persisted.approvals.some(value => value.id === brief.id && value.decision === 'approved'));
    record(kind + '：审批、保存回读和刷新恢复，不自动派发');
  }
  assert.deepEqual(pageErrors, []); passed = true;
} finally {
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed, model: provider.model, checks, calls, pageErrors,
    boundary: '真实浏览器和模型；隔离项目数据；不替代生产 Slack 或安装后验收' }, null, 2));
  await context?.close(); await browser?.close(); await service?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
