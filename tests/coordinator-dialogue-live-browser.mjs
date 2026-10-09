// 真实 Chromium → HTTP → 真实模型 → 工具 → 持久化。仅项目数据为隔离 fixture。
// 显式运行，凭据由本地配置提供；报告不保存凭据或模型私有推理。
import '../.github/scripts/test-environment.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { CoordinatorModel, coordinatorFailureDiagnostic } from '../scripts/cloud/coordinator-model.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { readMemoryView } from '../scripts/cloud/memory.mjs';

assert.ok(process.env.CONTEXT_GUARD_COORDINATOR_PROVIDER_FILE, '须显式指定真实模型配置');
const providerFile = path.resolve(process.env.CONTEXT_GUARD_COORDINATOR_PROVIDER_FILE);
const provider = JSON.parse(await fs.readFile(providerFile, 'utf8'));
const output = path.resolve(process.argv[2] || `temp/dialogue-live-browser-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const sourceFiles = [...new Set([...execFileSync('git', ['ls-files', 'scripts/cloud', 'plugins/slack/src', 'tests/coordinator-dialogue-live-browser.mjs'], { encoding: 'utf8' }).trim().split('\n'),
  'package.json', 'package-lock.json', 'scripts/shared/coordinator-reply.mjs', 'scripts/shared/coordinator-path.mjs',
  'prototype/coordinator-markdown.mjs', 'prototype/workbench-app.js', 'scripts/shared/package.json', 'prototype/package.json'])].sort();
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
  createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
const sourceBefore = await sourceHashes(), sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
const calls = [], checks = [], pageErrors = [], rounds = [];
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
      let result;
      try { result = await model.next(input); }
      catch (error) { calls.push({ durationMs: Date.now() - start, errorCode: error.code, diagnostic: coordinatorFailureDiagnostic(error) }); throw error; }
      calls.push({ durationMs: Date.now() - start, bodyCounts, backgroundCounts,
        text: result.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        tools: result.content.filter(block => block.type === 'tool_use').map(block => block.name) });
      return result;
    } };
  } };
let service, browser, context, page, conversationId, passed = false, activeRound = null, savedTodo;
const statePath = () => `/api/workbench/projects/${projectId}/api/coordinator?conversation=${encodeURIComponent(conversationId)}`;
const state = async () => (await context.request.get(service.url + statePath())).json();
const settle = async text => {
  const deadline = Date.now() + 150000;
  for (;;) {
    const s = await state();
    if (activeRound && activeRound.firstVisibleMs === null && (
      s.messages?.some(message => !activeRound.messageIds.has(message.id) && message.role === 'assistant' && message.text?.trim()) ||
      s.approvals?.some(proposal => proposal.pending && !activeRound.approvalIds.has(proposal.id)))) activeRound.firstVisibleMs = Date.now() - activeRound.started;
    if ((!text || s.messages?.some(m => m.role === 'user' && m.text === text)) &&
        ['waiting-for-user', 'error', 'interrupted'].includes(s.status) && s.pendingInputCount === 0) {
      await fs.writeFile(path.join(output, 'latest-state.json'), JSON.stringify(s, null, 2));
      if (activeRound) { rounds.push({ conversationId, input: activeRound.input, firstVisibleMs: activeRound.firstVisibleMs,
        durationMs: Date.now() - activeRound.started, status: s.status }); activeRound = null; }
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
  const beginRound = async input => {
    const current = await state(); activeRound = { input, started: Date.now(), firstVisibleMs: null,
      messageIds: new Set(current.messages.map(message => message.id)), approvalIds: new Set(current.approvals.map(proposal => proposal.id)) };
  };
  const confirm = async (label, endpoint) => {
    await beginRound('点击：' + label);
    const current = await state();
    const proposal = endpoint === '/binding-review' ? current.approvals.find(value => value.kind === 'binding-proposal' && value.pending) : null;
    if (endpoint === '/binding-review') assert.ok(proposal, '本轮必须有新的待确认绑定，不能点击旧卡片');
    const target = proposal ? panel.locator(`[data-binding-proposal="${proposal.id}"]`) : panel;
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname.endsWith(endpoint) && r.request().method() === 'POST'),
      target.getByRole('button', { name: label, exact: true }).click(),
    ]);
    assert.equal(response.status(), 200, await response.text());
    await settle();
  };
  const send = async text => {
    await beginRound(text);
    await panel.getByLabel('发送给 Coordinator').fill(text);
    const accepted = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/coordinator') && r.request().method() === 'POST');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    assert.equal((await accepted).status(), 202);
    return settle(text);
  };
  const choose = async label => {
    await beginRound('选项：' + label);
    const current = await state(), question = current.messages.flatMap(message => message.questions || []).find(value => !value.answer && !value.superseded);
    assert.ok(question?.options.includes(label));
    const target = panel.locator(`[data-question-id="${question.id}"]`);
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/coordinator') && r.request().method() === 'POST'),
      target.getByRole('button', { name: label, exact: true }).click(),
    ]);
    assert.equal(response.status(), 202); const settled = await settle();
    assert.equal(settled.messages.flatMap(message => message.questions || []).find(value => value.id === question.id).answer.text, label);
    return settled;
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
    assert.ok(typeof proposal.reason === 'string' && proposal.reason.trim(), '真实模型须说明推荐理由');
    assert.ok((await panel.textContent()).includes('理由：' + proposal.reason));
    await panel.screenshot({ path: path.join(output, kind + '-binding.png') });
    assert.ok(calls.slice(firstCall).some(call => call.tools?.includes('read_map')), '真实模型须实际查询节点');
    assert.deepEqual(await readMemoryView(memoryConfig, projectId), initial, '建议不能改 Main');
    record(kind + '：查询资料并提出归属，不提前绑定');
    if (kind === 'todo') await send('确认');
    else await confirm('确认绑定', '/binding-review');
    s = await state(); assert.equal(s.focus.nodeId, 'ERROR');
    const memoryCall = calls.length;
    await send('请根据项目、登录模块和错误提示节点的记忆，简短说明本次必须遵守的约束，先不要生成需求说明。');
    assert.ok(calls.slice(memoryCall).some(call => call.backgroundCounts?.every(count => count === 1)), '祖先及当前正文在实际模型固定背景中各出现一次；原始读取回执仍保留');
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
    if (kind === 'todo') savedTodo = primary.todos.find(item => item.id === brief.itemId);
    assert.equal(primary[kind + 's'].filter(item => item.id === brief.itemId).length, 1);
    assert.equal(Object.keys(saved.sessions).length, 0);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
    await page.locator('#btn-coordinator').click();
    const persisted = await state(); assert.equal(persisted.focus.nodeId, 'PERMISSION');
    assert.ok(persisted.approvals.some(value => value.id === brief.id && value.decision === 'approved'));
    await panel.getByRole('button', { name: '历史 Session', exact: true }).click();
    await panel.locator(`#coordinator-history button[data-conversation="${conversationId}"]`).click();
    await page.waitForFunction(id => document.querySelector('#coordinator-panel')?.dataset.conversation === id, conversationId);
    record(kind + '：审批、保存回读和刷新恢复，不自动派发');
    await send('刚才的需求现在是什么状态？只说结论，不列其他事项。');
    await send('请用一个选择题问我准备用Claude Code还是Cursor执行，提供这两个选项按钮，不再问其他问题。');
    await choose('Cursor');
    assert.equal(rounds.filter(round => round.conversationId === conversationId).length, 10);
    record(kind + '：十轮讨论与真实选项按钮闭环');
  }
  const created = page.waitForResponse(r => r.url().includes('/api/coordinator/conversations/new') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: '新建 Coordinator Session', exact: true }).click();
  conversationId = (await (await created).json()).id;
  await send('我们继续完善已有的登录错误提示回归测试待办。先读取现有事项，建议挂载权限控制这个主要节点，等我确认，暂不生成brief。');
  await confirm('确认绑定', '/binding-review');
  await send('旧待办的主要目标是什么？不要列编号或其他待办。');
  await send('保留原有目标，补充断网时不能显示内部错误。先不要保存。');
  await send('请只问我一个选择题：优先覆盖未授权还是断网场景？提供“未授权”和“断网”按钮。');
  await choose('断网');
  await send('现在复用这条旧待办整理brief，不新建事项：保持拒绝访问不泄露详情，补充断网时显示中文通用提示。验收先覆盖断网，等我批准，不要派发。');
  await confirm('确认需求', '/approval');
  const reused = (await readMemoryView(memoryConfig, projectId)).main.memory.map.root.children.find(node => node.id === 'PERMISSION').todos;
  assert.equal(reused.length, 1); assert.equal(reused[0].id, savedTodo.id, '复用旧事项不得另建待办');
  await send('这次是更新了旧待办还是新增了一条？只说结果。');
  await send('先停在这里，不自动发起执行，也不要再追问。');
  assert.equal(rounds.filter(round => round.conversationId === conversationId).length, 10);
  record('旧事项：先确认主节点，再复用brief，十轮无重复事项或自动派发');
  assert.equal(rounds.length, 30);
  assert.deepEqual(pageErrors, []); passed = true;
} finally {
  const sourceAfter = await sourceHashes(), sourceUnchanged = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
  passed = passed && sourceUnchanged;
  const finalState = service && conversationId ? await state() : null;
  if (!passed && page) await page.screenshot({ path: path.join(output, 'failure.png') });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed, model: provider.model, checks, calls, rounds, pageErrors,
    sourceRevision, sourceBefore, sourceAfter, sourceUnchanged,
    ...(passed ? {} : { finalState }),
    boundary: '真实浏览器和模型；隔离项目数据；不替代生产 Slack 或安装后验收' }, null, 2));
  await context?.close(); await browser?.close(); await service?.close();
  await fs.rm(directory, { recursive: true, force: true });
  assert.ok(sourceUnchanged, '真实验收期间源码不得变化');
}
