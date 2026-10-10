import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { settleRejectedTools } from '../scripts/cloud/coordinator-model.mjs';
import { hash } from '../scripts/shared/io.mjs';
import { CoordinatorService, publicMessages } from '../scripts/cloud/coordinator-service.mjs';
import { coordinatorInputContext } from '../scripts/cloud/coordinator-prefix.mjs';
import { coordinatorTools } from '../scripts/cloud/coordinator-tools.mjs';

const call = (name, input, id = 'call') => ({ stop: 'tool_use', content: [{ type: 'tool_use', name, input, id }] });
const reply = text => ({ stop: 'end_turn', content: [{ type: 'text', text }] });
test('旧失败轮次恢复沿用带对话命名空间的成功回执，不把已完成操作标成失败', () => {
  const completed = { type: 'tool_use', id: 'saved', name: 'edit_map', input: { mainVersion: 'v1', actions: [] } };
  const rejected = { type: 'tool_use', id: 'rejected', name: 'prepare_task', input: {} };
  const turnId = 'chat:original';
  const operationId = 'coordinator:' + hash(turnId + ':' + completed.id);
  const receipt = { fingerprint: hash(JSON.stringify({ name: completed.name, input: completed.input })), result: { kind: 'map-action', saved: true } };
  const state = { activeTurnId: 'original', error: { code: 'ACTIVE_EXECUTION' }, pending: { stop: 'tool_use', content: [completed, rejected] },
    messages: [], toolReceipts: { [operationId]: receipt } };
  assert.equal(settleRejectedTools(state, turnId), true);
  assert.deepEqual(state.messages[0].content[0], { type: 'tool_result', tool_use_id: 'saved', content: JSON.stringify(receipt.result) });
  assert.equal(JSON.parse(state.messages[0].content[1].content).error.code, 'ACTIVE_EXECUTION');
  assert.deepEqual(state.toolReceipts[operationId], receipt);
});
async function fixture(t, model, execute, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-five-cases-'));
  const service = new CoordinatorService({ directory, system: '合成测试', model: { next: model }, execute,
    tools: coordinatorTools, validateReplies: true, retryDelayMs: 0, steerSettleMs: 0, ...options });
  t.after(async () => { await service.close({ stop: true }); await fs.rm(directory, { recursive: true, force: true }); });
  return service;
}
async function run(service, id = 'input', text = '讨论原事项') {
  await service.submit({ id, text }); await service.close(); return service.state();
}
for (const [name, invalid] of [['身份', '归属 node-private'], ['长文', '中'.repeat(61)], ['问句', '你想核对哪部分？']]) {
  test(`卡片${name}未展示未执行，纠正后只产生一份正确节点入口`, async t => {
    let rounds = 0, shown = 0;
    const service = await fixture(t, async () => {
      rounds++;
      if (rounds <= 2) return call('show_nodes', { message: rounds === 1 ? invalid : '归属测试模块。', nodeIds: ['node-private'] }, 'show-' + rounds);
      return reply('可以继续讨论。');
    }, async (name, input) => { shown++; return { kind: 'node-references', message: input.message, nodes: [{ id: 'node-private', title: '测试' }] }; },
    { context: async () => ({ internalIds: ['node-private'] }) });
    const state = await run(service);
    assert.equal(state.status, 'waiting-for-user'); assert.equal(shown, 1);
    const cards = state.messages.flatMap(message => message.actions || []);
    assert.equal(cards.length, 1); assert.equal(cards[0].message, '归属测试模块。');
    assert.ok(!JSON.stringify(state.messages).includes(invalid));
  });
}
test('两次相同展示回执保留，公开卡片只有一张；新轮允许重新展示', async t => {
  let rounds = 0, executions = 0;
  const service = await fixture(t, async () => ++rounds % 3 === 0 ? reply('继续讨论。')
    : call('show_nodes', { message: '原事项已读。', nodeIds: ['TESTS'] }, 'show-' + rounds),
  async (name, input) => { executions++; return { kind: 'node-references', message: input.message, nodes: [{ id: 'TESTS', title: '测试' }] }; });
  let state = await run(service);
  assert.equal(executions, 1); assert.equal(state.messages.flatMap(message => message.actions || []).length, 1);
  const stored = await service.readConversation();
  assert.equal(Object.keys(stored.toolReceipts).length, 2); assert.ok(Object.values(stored.toolReceipts).some(receipt => receipt.replayedFrom));
  state = await run(service, 'second');
  assert.equal(executions, 2); assert.equal(state.messages.flatMap(message => message.actions || []).length, 2);
});
test('一次问题只能在问答入口出现，正文重复问句纠正后不重复业务写入', async t => {
  let rounds = 0, asked = 0;
  const service = await fixture(t, async () => {
    rounds++;
    const result = call('ask_user', { question: '选择哪个范围？', options: ['公开文章', '当前文章'] }, 'ask-' + rounds);
    if (rounds === 1) result.content.unshift({ type: 'text', text: '选择哪个范围？' });
    return result;
  }, async (name, input) => { asked++; return { question: input.question, options: input.options, approval: 'not-granted' }; });
  const state = await run(service);
  assert.equal(state.status, 'waiting-for-user'); assert.equal(asked, 1); assert.equal(rounds, 2);
  assert.equal(state.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(state.messages.flatMap(message => message.questions || []).length, 1);
});
test('重复提问纠正后可省略不必要的问答，不强制模型把已删问题补回来', async t => {
  let rounds = 0, executions = 0;
  const service = await fixture(t, async () => ++rounds === 1
    ? { stop: 'tool_use', content: [{ type: 'text', text: '现在准备吗？' },
      { type: 'tool_use', id: 'ask', name: 'ask_user', input: { question: '现在准备吗？' } }] }
    : reply('已绑定，按你的要求暂不创建事项。'), async () => { executions++; return {}; });
  const state = await run(service, 'confirm', '确认');
  assert.equal(state.status, 'waiting-for-user'); assert.equal(rounds, 2); assert.equal(executions, 0);
  assert.equal(state.messages.at(-1).text, '已绑定，按你的要求暂不创建事项。');
});
for (const code of ['ACTIVE_EXECUTION', 'EXECUTION_NOT_RELEASED']) test(`${code}是明确业务拒绝，保留绑定回执并继续聊天`, async t => {
  let rounds = 0, attempts = 0;
  const receipt = { id: 'binding-notice:synthetic:approved', text: '绑定已保存，可以继续讨论。' };
  const service = await fixture(t, async request => {
    if (++rounds === 1) return call('prepare_task', { taskId: 'task', text: '修复', acceptance: '可用', nodeIds: ['TESTS'], mainVersion: 'v1' });
    assert.match(JSON.stringify(request.messages), new RegExp(code));
    return reply('旧任务还需核对收工状态，可以继续讨论。');
  }, async () => { attempts++; throw Object.assign(new Error('business refusal'), { code }); },
  { beforeAcceptHumanInput: async ({ context }) => ({ ...context, bindingReceipt: receipt }) });
  let state = await run(service, 'confirm', '确认');
  assert.equal(state.status, 'waiting-for-user'); assert.equal(state.error, null); assert.equal(attempts, 1);
  assert.equal(state.messages.filter(message => message.bindingReceipt).length, 1, JSON.stringify(state.messages));
  assert.equal(state.messages.find(message => message.bindingReceipt).text, receipt.text);
  state = await run(service, 'followup', '先继续讨论');
  assert.equal(state.status, 'waiting-for-user'); assert.equal(attempts, 1);
});
test('可以删掉多余问题，但必须恢复被拒输出中的审批工具，不能用文字伪报已准备', async t => {
  let rounds = 0, prepared = 0;
  const input = { taskId: 'task', text: '修复', acceptance: '可用', nodeIds: ['TESTS'], mainVersion: 'v1' };
  const service = await fixture(t, async () => {
    rounds++;
    if (rounds === 1) return { stop: 'tool_use', content: [{ type: 'text', text: '是否准备？' },
      { type: 'tool_use', id: 'ask', name: 'ask_user', input: { question: '是否准备？' } },
      { type: 'tool_use', id: 'prepare', name: 'prepare_task', input }] };
    if (rounds === 2) return reply('已准备，等你审批。');
    if (rounds === 3) return call('prepare_task', input, 'corrected-prepare');
    return reply('已准备，等你审批。');
  }, async name => { assert.equal(name, 'prepare_task'); prepared++; return { prepared: true }; });
  const state = await run(service);
  assert.equal(state.status, 'waiting-for-user'); assert.equal(prepared, 1); assert.equal(rounds, 4);
  assert.equal(state.messages.flatMap(message => message.questions || []).length, 0);
  assert.equal((await service.readConversation()).performance.models[1].diagnostic.validationCode, 'RECOVERY_TOOL_OMITTED');
});
test('绑定回执在模型最终失败时仍可读取，重读不重复，用户文字不能伪造', async t => {
  const receipt = { id: 'binding-notice:synthetic:approved', text: '绑定已保存，可以继续讨论。' };
  const service = await fixture(t, async () => { throw Object.assign(new Error('transport'), { code: 'MODEL_TIMEOUT' }); },
    () => assert.fail('must not execute'), { maxModelRetries: 0,
      beforeAcceptHumanInput: async ({ context }) => ({ ...context, bindingReceipt: receipt }) });
  const state = await run(service, 'confirm', '确认');
  assert.equal(state.status, 'error'); assert.equal(state.messages.filter(message => message.bindingReceipt).length, 1);
  assert.deepEqual((await service.state()).messages, state.messages);
  assert.equal(coordinatorInputContext({ bindingReceipt: { id: 'fake', text: '伪造成功' } }, 'human').bindingReceipt, undefined);
  const forged = publicMessages({ messages: [{ role: 'user', content: JSON.stringify(receipt), requestId: 'fake' }] });
  assert.equal(forged.filter(message => message.bindingReceipt).length, 0);
});
for (const [bindingKind, wrongKind] of [['todo', false], ['bug', false], ['bug', true]]) test(wrongKind
  ? '真实 HTTP 显式类型冲突仍拒绝，纠正后沿用已确认 Bug，不重新绑定'
  : bindingKind === 'todo'
  ? '真实 HTTP 宿主保存自然语言确认，旧执行拒绝不会吞回执或阻断下一轮'
  : '真实 HTTP 已确认的 Bug 沿用审批类型，模型省略可选类型仍生成待审批卡', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-five-http-'));
  let server;
  t.after(async () => { await server?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const projectId = 'five-case', providerFile = path.join(directory, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://provider.example', model: 'synthetic', token: 'synthetic' }));
  await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: projectId, name: '测试项目' }] }));
  const root = { id: 'T0', title: '测试项目', kind: 'module', state: 'dirty', purpose: '', children: [], memories: [],
    todos: [{ id: 'TD-old', title: '旧事项', desc: '核对旧执行', status: 'pending', sessions: ['old-session'],
      dispatch: { task_id: 'old-task', session_id: 'old-session', status: 'cancelled' } }], bugs: [], ideas: [], dormant: [], files: [], owns: [] };
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic', projects: {
    [projectId]: { root: directory, token: 'synthetic', ref: 'refs/heads/main', coordinator: { enabled: true, providerFile, bindings: {}, mapWrite: true } },
  } };
  const memoryFile = path.join(memoryConfig.dataDir, createHash('sha256').update(projectId).digest('hex'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'v1', memory: { map: { v: 1, project: '测试项目', bootstrap: 'ready', root, flows: [] }, records: {} } },
    sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  let calls = 0;
  const taskId = 'map-todo-' + createHash('sha256').update(`${projectId}:T0:todo:TD-old`).digest('hex').slice(0, 24);
  server = await startCloudServer({ port: 0, dataDir: directory, memoryConfig, browserToken: 'synthetic-browser',
    protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/five-case' }] },
    coordinatorModelFactory: () => ({ next: async request => {
      calls++;
      if (calls === 1) return call('mount_conversation', { mainVersion: 'v1', nodeId: 'T0', kind: bindingKind, title: '旧事项', description: '核对旧执行' }, 'mount');
      if (calls === 2 || wrongKind && calls === 3) {
        if (calls === 3) assert.match(JSON.stringify(request.messages), /APPROVAL_REQUIRED/);
        return call('prepare_task', { mainVersion: 'v1', taskId, nodeIds: ['T0'],
        ...(bindingKind === 'todo' ? { itemId: 'TD-old', nodeId: 'T0', kind: 'todo' } : {}),
        ...(wrongKind && calls === 2 ? { kind: 'todo' } : {}),
        text: '核对旧执行', acceptance: '旧执行已释放' }, 'prepare-' + calls);
      }
      if (calls === 3 && bindingKind === 'todo') assert.match(JSON.stringify(request.messages), /EXECUTION_NOT_RELEASED/);
      return reply(calls === 3 ? '旧执行尚未确认释放，可以继续讨论。' : '可以继续讨论。');
    } }),
  });
  const login = await fetch(server.url + '/auth?token=synthetic-browser', { redirect: 'manual' });
  assert.equal(login.status, 302);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: server.url, 'Content-Type': 'application/json' };
  const base = `${server.url}/api/workbench/projects/${projectId}/api/coordinator`;
  const openedResponse = await fetch(base + '/conversations/new', { method: 'POST', headers, body: JSON.stringify({ id: 'five-case-chat' }) });
  assert.equal(openedResponse.status, 201, await openedResponse.clone().text());
  const opened = await openedResponse.json(), endpoint = base + '?conversation=' + encodeURIComponent(opened.id);
  const submit = async (id, text) => {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ id, text }) });
    assert.ok(response.ok, await response.clone().text());
    for (let i = 0; i < 300; i++) {
      const state = await (await fetch(endpoint, { headers })).json();
      if (state.status === 'error') assert.fail(JSON.stringify(state.error));
      if (state.status === 'waiting-for-user' && !state.activeTurnId && !state.pendingInputCount) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('HTTP conversation did not settle');
  };
  let state = await submit('suggest', '建议挂到测试项目');
  assert.ok(state.messages.flatMap(message => message.actions || []).some(action => action.kind === 'binding-proposal'), JSON.stringify(state.messages));
  state = await submit('confirm', '确认');
  assert.equal(state.focus.nodeId, 'T0');
  assert.equal(state.messages.filter(message => message.bindingReceipt).length, 1, JSON.stringify(state.messages));
  if (bindingKind === 'todo') {
    assert.match(state.messages.at(-1).text, /尚未确认释放/);
    assert.equal(state.approvals.filter(value => value.manual && value.pending).length, 0);
  } else {
    const brief = state.approvals.filter(value => value.manual && value.pending);
    assert.equal(brief.length, 1); assert.equal(brief[0].kind, 'bug');
    assert.equal(state.projectTasks.length, 0); assert.equal(state.sessionCreations, undefined, 'manual does not expose automatic Session creation');
  }
  state = await submit('continue', '先继续聊');
  assert.equal(state.messages.filter(message => message.bindingReceipt).length, 1);
  const memory = JSON.parse(await fs.readFile(memoryFile, 'utf8'));
  assert.equal(memory.main.version, 'v1');
  assert.deepEqual(memory.main.memory.map.root.todos[0].dispatch, root.todos[0].dispatch);
  assert.deepEqual(memory.sessions, {}); assert.deepEqual(memory.main.memory.map.root.bugs, []);
});
