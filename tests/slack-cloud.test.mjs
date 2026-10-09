import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { readMemoryView } from '../scripts/cloud/memory.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
import { hash, readJSON } from '../scripts/shared/io.mjs';
import { CoordinatorMapIntake } from '../scripts/cloud/coordinator-service.mjs';
import { coordinatorTools, selectCoordinatorTools } from '../scripts/cloud/coordinator-tools.mjs';
import { filterManualTools } from '../scripts/cloud/coordinator-manual.mjs';
import { coordinatorStep } from '../scripts/cloud/coordinator-model.mjs';
import { publicMessages, CoordinatorConversations } from '../scripts/cloud/coordinator-service.mjs';
import { createCoordinatorExecutor } from '../scripts/cloud/coordinator-tools.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { Store, threadKey } from '../plugins/slack/src/store.mjs';
import { Gateway } from '../plugins/slack/src/gateway.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';

// These exercise real Cloud and loopback HTTP with isolated persistence. Only
// the paid model provider is replaced; no Slack SDK/account/network is involved.
const projectId = 'context-guard', otherProjectId = 'fixture-other';
const teamId = 'TTESTWORKSPACE', userId = 'UTESTUSER';
const integrationCredential = 'fixture-independent-integration-credential';
const browserCredential = 'fixture-browser-credential';
const headers = { Authorization: `Bearer ${browserCredential}`, 'Content-Type': 'application/json' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN5kAAAAASUVORK5CYII=';

// Projection regression: real Coordinator execution/public messages and plugin,
// with in-memory provider/state and fake Slack IO; not a real Slack E2E case.
test('Native Coordinator read_map projection produces no empty Slack reply before the actual answer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-native-read-mirror-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).open(), key = threadKey(teamId, 'CTESTCHANNEL', '100.001');
  await store.bind(key, { channel: 'CTESTCHANNEL', threadTs: '100.001', projectId, conversationId: 'chat-native-read', userId,
    ownRequests: ['native-read-turn'] });
  const posts = [], raw = { status: 'running', activeTurnId: 'native-read-turn', activeInput: { id: 'native-read-turn' },
    messages: [{ role: 'user', requestId: 'native-read-turn', content: '只读分析这个模块' }], toolReceipts: {} };
  const execute = createCoordinatorExecutor({ readMap: async () => ({ version: 'main-native-read', node: { id: 'T0', title: 'Fixture' } }) });
  let modelStep = 0;
  const model = { next: async () => ++modelStep === 1
    ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'native-read-tool', name: 'read_map', input: { nodeId: 'T0' } }] }
    : { stop: 'end_turn', content: [{ type: 'text', text: '已读取真实模块信息，本轮只读。' }] } };
  const step = () => coordinatorStep({ turnId: 'native-read-turn', state: raw, model, system: 'native read projection test',
    tools: filterManualTools(coordinatorTools), execute, save: async () => {} });
  const plugin = new SlackPlugin({ store, teamId, cloudOrigin: 'https://map.example.com', botUserId: 'UBOTTEST',
    gateway: { command: async () => ({ status: raw.status, activeTurnId: raw.activeTurnId,
      messages: publicMessages(raw), approvals: [], acceptedRequestIds: ['native-read-turn'] }) },
    io: { post: async input => { posts.push(input); return '101.001'; }, update: async () => assert.fail('No retained stream in this case') },
    logger: { error(){}, warn(){} } });
  await step();
  const readMessage = publicMessages(raw).find(message => message.role === 'assistant');
  assert.equal(readMessage.actions[0].kind, 'node-read', 'Use the actual public projection, not a renamed fixture action');
  assert.equal(readMessage.text, '');
  assert.equal(Object.keys(raw.toolReceipts).length, 1);
  assert.equal(raw.messages.at(-1).content[0].type, 'tool_result');
  await plugin.mirror(key);
  assert.equal(posts.length, 0, 'The real native read projection must not create a blank Slack message');
  await step(); raw.activeTurnId = null;
  await plugin.mirror(key); await plugin.mirror(key);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /已读取真实模块信息/);
  assert.ok(raw.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')),
    'Cloud tool provenance remains complete');
});

async function fixture(t, { enabled = true, visionProvider, nodeIds, childNodes = [], prepareInput, initialMap, mapProjects, bindingNodeId = 'T0', modelSelection = false, projectSelection = false, integrationActions } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-guard-slack-cloud-'));
  let cloud;
  const held = new Set(), plugins = new Set();
  const releaseHeld = () => { for (const release of held) release(); held.clear(); };
  t.after(async () => {
    releaseHeld();
    // 先收拢插件的后台反应/原子写入，再停 Cloud，最后删除夹具目录。
    for (const plugin of plugins) await plugin.stop();
    await cloud?.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  const providerFile = path.join(directory, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ model: 'fixture-model', token: 'synthetic', baseUrl: 'https://fixture.invalid' }));
  const visionProviderFile = path.join(directory, 'vision-provider.json');
  if (visionProvider) await fs.writeFile(visionProviderFile, JSON.stringify({ token: 'synthetic', baseUrl: 'https://fixture.invalid', ...visionProvider }));
  const projects = Object.fromEntries([projectId, otherProjectId].map(id => [id, { root: directory, ref: 'refs/heads/main',
    coordinator: { enabled: true, providerFile, bindings: {}, mapWrite: true, ...(nodeIds ? { nodeIds } : {}),
      ...(modelSelection ? { modelProviders: { original: { label: '原模型', providerFile }, target: { label: '目标模型', providerFile } }, defaultProviderId: 'original' } : {}) } }]));
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'fixture-memory-credential', projects };
  await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2, projects: [projectId, otherProjectId].map(id => ({ id, name: id, description: 'Isolated synthetic project' })) }));
  for (const id of Object.keys(projects)) {
    const file = legacyProjectMemoryFile(memoryConfig.dataDir, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ revision: 1, main: { version: 'main-initial', memory: { records: {}, map: initialMap || {
      project: 'Fixture', root: { id: 'T0', title: 'Fixture', kind: 'module', state: 'dirty', owns: ['src/'], memoryDocument: 'Current project facts', children: childNodes,
        todos: [{ id: 'TD-old', title: 'Existing original TODO', status: 'pending', createdAt: 'original-todo' }],
        bugs: [{ id: 'B1', title: 'Existing original Bug', status: 'open', createdAt: 'original-bug', attempts: [{ status: 'Confirmed', cause: 'Token expired' }] }] },
    } } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  }
  const modelCalls = [], failedTurns = new Set();
  const options = { dataDir: directory, host: '127.0.0.1', port: 0, adminToken: 'fixture-server-admin', browserToken: browserCredential, privateAccess: true,
    memoryConfig, protocolConfig: { repositories: [{ repositoryId: '123', projectId, slug: 'example/fixture' },
      { repositoryId: '124', projectId: otherProjectId, slug: 'example/other' }] },
    ...(enabled ? { integrationConfig: { host: '127.0.0.1', port: 0, token: integrationCredential, teamId, projectIds: [projectId, otherProjectId],
      ...(mapProjects ? { mapProjects: { coordinatorProjectId: projectId, userIds: [userId] } } : {}),
      ...(visionProvider ? { visionProviderFile } : {}), ...(integrationActions ? { actions: integrationActions } : {}) } } : {}),
    coordinatorModelFactory: () => { const next = async request => {
      modelCalls.push({ system: request.system, messages: request.messages, tools: request.tools, maxTokens: request.maxTokens });
      if (request.tools.length === 0 && request.maxTokens === 256) {
        // Identify the bounded no-tools contract, not a particular PE prefix.
        const input = JSON.parse(request.messages.at(-1).content);
        assert.equal(typeof input.message.text, 'string');
        if (input.message.text === 'relevance-tool') return { stop: 'tool_use', content: [{ type: 'tool_use', name: 'edit_map', id: 'forbidden-relevance-tool', input: {} }] };
        const addressed = input.message.text === '登录刷新 Bug，请分析。' || projectSelection;
        return { stop: 'end_turn', content: [{ type: 'text', text: input.message.text === 'invalid-relevance'
          ? 'not a decision' : JSON.stringify({ target: addressed ? 'coordinator' : 'none', intent: addressed ? 'reply' : 'notice', reason: 'Controlled decision' }) }] };
      }
      const message = request.messages.at(-1), text = typeof message?.content === 'string'
        // 替身按原始人类输入路由；保留 modelCalls 中完整服务器格式提醒供断言。
        ? message.content.split('[以下为原始输入]\n').at(-1).split('\n\n[服务器本轮输出格式；')[0] : '';
      if (projectSelection && ['列出项目', '切换到另一个项目'].includes(text)) return { stop: 'tool_use', content: [
        { type: 'tool_use', id: 'live-projects', name: 'list_projects', input: {} }] };
      if (projectSelection && Array.isArray(message?.content)) {
        const block = message.content.find(block => block.type === 'tool_result');
        if (block) {
          const result = JSON.parse(block.content);
          if (result.projects) assert.equal(result.total, result.projects.length, '目录工具提供权威总数，不从展示行估算');
          if (result.projects && request.messages.some(m => typeof m.content === 'string' && m.content.includes('切换到另一个项目'))) {
            return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'switch-project', name: 'switch_project', input: {
              projectId: result.projects.find(project => project.id !== result.currentProjectId).id } }] };
          }
          return { stop: 'end_turn', content: [{ type: 'text', text: result.projects ? result.projects.map(p => p.name).join('、') : '项目工具已拒绝，未切换。' }] };
        }
      }
      if (mapProjects && text === '准备测试任务') {
        const response = await fetch(cloud.url + '/api/workbench/overview/api/state', { headers });
        const version = (await response.json()).version;
        return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'map-project-brief', name: 'prepare_task', input: {
          taskId: 'fixture-manual', text: '验证新增项目的任务', acceptance: '保留原始 Map 分支', nodeIds: ['N-new'], nodeId: 'N-new', mainVersion: version,
        } }] };
      }
      if (modelSelection && text === '切换到目标模型') {
        const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST',
          headers: { Authorization: `Bearer ${integrationCredential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'read-model-catalog', teamId, userId, projectId, type: 'models.state', payload: {} }) });
        const catalog = (await response.json()).data;
        return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'real-select', name: 'select_text_model', input: { providerId: 'target', baseVersion: catalog.version } }] };
      }
      if (modelSelection && Array.isArray(message?.content)) {
        const receipt = message.content.find(block => block.type === 'tool_result');
        if (receipt) {
          const result = JSON.parse(receipt.content);
          return { stop: 'end_turn', content: [{ type: 'text', text: result.kind === 'model-selected' ? `已切换到${result.label}，下一轮生效。` : '该项目不允许切换模型。' }] };
        }
      }
      if (text === 'show-node-complete') return { stop: 'tool_use', content: [
        { type: 'text', text: 'This is the complete read-only answer.' },
        { type: 'tool_use', id: 'tool-show-complete', name: 'show_nodes', input: { message: 'Project entry', nodeIds: ['T0'], replyComplete: true } },
      ] };
      if (text === 'list-scoped-tasks') return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'list-scoped', name: 'list_tasks', input: {} }] };
      if (message?.role === 'user' && text === 'failure-then-browser-retry' && !failedTurns.has(text)) {
        failedTurns.add(text); throw Object.assign(new Error('Controlled provider failure'), { code: 'FIXTURE_PROVIDER_FAILURE' });
      }
      if (message?.role === 'user' && text === 'hold-busy-turn') await new Promise(resolve => held.add(resolve));
      if (message?.role === 'user' && ['mount-bug', 'mount-todo'].includes(text)) {
        const version = mapProjects ? (await (await fetch(cloud.url + '/api/workbench/overview/api/state', { headers })).json()).version :
          (await readMemoryView(memoryConfig, projectId)).main.version;
        return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'tool-mount-bug', name: 'mount_conversation', input: {
          mainVersion: version, nodeId: bindingNodeId, kind: text === 'mount-bug' ? 'bug' : 'todo', title: 'Mounted refresh failure', description: 'Expired tokens produce a reproducible renewal failure',
        } }] };
      }
      if (message?.role === 'user' && text === 'prepare-explicit-routing' && prepareInput) {
        const version = (await readMemoryView(memoryConfig, projectId)).main.version;
        return { stop:'tool_use',content:[{type:'tool_use',id:'tool-explicit-routing',name:'prepare_task',input:{
          text:'Fix existing B1 only',acceptance:'Keep the requested item identity',nodeIds:['T0'],mainVersion:version,...prepareInput,
        }}] };
      }
      if (message?.role === 'user' && /^prepare-(new|new-bug|bug|stale)$/.test(text)) {
        const version = (await readMemoryView(memoryConfig, projectId)).main.version;
        return { stop: 'tool_use', content: [{ type: 'tool_use', id: `tool-${text}`, name: 'prepare_task', input: {
          taskId: text === 'prepare-bug' ? 'B1' : 'new-item', text: text === 'prepare-bug' ? 'Fix token refresh' : 'Add token refresh guidance',
          acceptance: 'Verified expired token handling', nodeIds: ['T0'], mainVersion: version,
          ...(text === 'prepare-bug' ? { nodeId: 'T0', kind: 'bug', itemId: 'B1' } : {}),
          ...(text === 'prepare-new-bug' ? { kind: 'bug' } : {}),
        } }] };
      }
      return { stop: 'end_turn', content: [{ type: 'text', text: text.startsWith('[服务器工作流事件') ? '确认结果已收到。' : `Fixture response${text ? ': ' + text : ''}` }] };
    }; return { model: 'fixture-model', next: async request => {
      const result = await next(request);
      // Controlled provider follows the new first-round wire protocol. Business
      // tool assertions below still use the real Cloud executor and HTTP route.
      return request.system.includes('[Slack 合并接话协议]') ? { ...result,
        content: [{ type: 'text', text: '[CG_REPLY]\n' }, ...result.content] } : result;
    } }; },
  };
  // Default-off is evaluated without an ambient user's integration configuration.
  const previousIntegrationConfig = process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG;
  delete process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG;
  try { cloud = await startCloudServer(options); }
  finally { if (previousIntegrationConfig === undefined) delete process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG; else process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG = previousIntegrationConfig; }
  const gateway = async (type, payload = {}, { id = `request-${hash(JSON.stringify([type, payload])).slice(0, 32)}`, conversationId,
    project = projectId, user = userId, credential = integrationCredential } = {}) => {
    const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type, teamId, userId: user, projectId: project, ...(conversationId ? { conversationId } : {}), payload }) });
    return { status: response.status, body: await response.json() };
  };
  const browser = async (conversationId, { suffix = '', body, authorization = browserCredential, project = projectId, human = false } = {}) => {
    let response;
    try {
      response = await fetch(`${cloud.url}/api/workbench/projects/${project}/api/coordinator${suffix}?conversation=${encodeURIComponent(conversationId || 'main')}`, {
        method: body ? 'POST' : 'GET', headers: { ...headers, Authorization: `Bearer ${authorization}`,
          ...(human ? { Cookie: `cg_workbench=${encodeURIComponent(authorization)}`, Origin: cloud.url } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      // Diagnose the actual OS-assigned loopback port without logging credentials
      // or changing fetch restrictions, allocated ports or the assertion path.
      error.fixturePort = Number(new URL(cloud.url).port);
      throw error;
    }
    return { status: response.status, body: await response.json() };
  };
  const wait = async (conversationId, predicate, label = 'Coordinator final state') => {
    const deadline = Date.now() + 4000; let last;
    while (Date.now() < deadline) {
      last = await browser(conversationId);
      assert.equal(last.status, 200, JSON.stringify(last.body));
      if (predicate(last.body)) return last.body;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail(`${label} timed out: ${JSON.stringify(last?.body)}`);
  };
  return { directory, memoryConfig, options, modelCalls, gateway, browser, wait, get cloud() { return cloud; },
    ownPlugin(plugin) { plugins.add(plugin); },
    main: () => readMemoryView(memoryConfig, projectId),
    async restart() { releaseHeld(); await cloud.close(); cloud = await startCloudServer(options); },
    async newConversation(id) {
      const result = await gateway('conversation.create', { operationId: id }, { id });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data.conversationId;
    } };
}

test('Cloud integration listener is disabled by default and plugin credentials cannot impersonate browser access', async t => {
  const disabled = await fixture(t, { enabled: false });
  assert.equal(disabled.cloud.integrationUrl, null);
  assert.equal((await disabled.browser('main')).status, 200);
  const enabled = await fixture(t);
  assert.equal((await enabled.gateway('project.list', {}, { credential: browserCredential })).status, 401);
  assert.equal((await enabled.browser('main', { authorization: integrationCredential })).status, 401);
  const projects = await enabled.gateway('project.list');
  assert.equal(projects.status, 200); assert.deepEqual(projects.body.data.projects.map(item => item.id).sort(), [projectId, otherProjectId].sort());
});

test('真实 Cloud 项目工具沿原目录授权交接，对话和 Main 隔离，非私聊不能获得目录', async t => {
  const f = await fixture(t, { projectSelection: true });
  const conversationId = await f.newConversation('project-tools-chat');
  const before = await f.main();
  const submitted = await f.gateway('conversation.submit', { text: '列出项目', slackChannelId: 'DTESTDM' }, { id: 'list-projects-turn', conversationId });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const listed = await f.wait(conversationId, s => s.status === 'waiting-for-user' && !s.activeTurnId);
  assert.match(listed.messages.at(-1).text, /context-guard.*fixture-other/);
  assert.equal(listed.messages.find(m => m.role === 'user').actor.channelId, 'DTESTDM');
  await f.gateway('conversation.submit', { text: '切换到另一个项目', slackChannelId: 'DTESTDM' }, { id: 'switch-project-turn', conversationId });
  const switched = await f.wait(conversationId, s => !s.activeTurnId && s.messages.some(m => m.actions?.some(a => a.kind === 'project-switch')));
  const action = switched.messages.flatMap(m => m.actions || []).find(a => a.kind === 'project-switch');
  assert.equal(action.status, 'pending'); assert.equal(action.sourceProjectId, projectId); assert.equal(action.sourceConversationId, conversationId);
  assert.equal(action.projectId, otherProjectId); assert.equal(action.actor.userId, userId); assert.equal(action.actor.channelId, 'DTESTDM');
  const target = await f.gateway('conversation.state', {}, { project: otherProjectId, conversationId: action.conversationId });
  assert.equal(target.status, 200); assert.equal(target.body.data.executionMode, 'manual'); assert.deepEqual(target.body.data.messages, []);
  assert.deepEqual(await f.main(), before);
  await f.restart();
  const saved = await f.gateway('conversation.state', {}, { conversationId });
  assert.equal(saved.body.data.messages.flatMap(m => m.actions || []).find(a => a.kind === 'project-switch').conversationId, action.conversationId);
  const channelConversation = await f.newConversation('channel-project-tools');
  await f.gateway('conversation.submit', { text: '列出项目', slackChannelId: 'CTESTCHANNEL' }, { id: 'channel-list-turn', conversationId: channelConversation });
  const denied = await f.wait(channelConversation, s => s.status === 'waiting-for-user' && !s.activeTurnId);
  assert.match(denied.messages.at(-1).text, /已拒绝/);
  const last = f.modelCalls.filter(c => c.maxTokens !== 256).at(-1);
  assert.equal(last.tools.some(t => ['list_projects', 'switch_project'].includes(t.name)), false);
  const invalid = await f.gateway('conversation.submit', { text: '列出项目', slackChannelId: 'bad-channel' }, { id: 'invalid-channel-turn', conversationId });
  assert.equal(invalid.status, 400);
});

test('隔离端到端：Slack 自然切换经真实 HTTP 和原生工具交接，后续原线程回复只读新项目上下文', async t => {
  const f = await fixture(t, { projectSelection: true }), dm = 'DTESTDM', posts = [], calls = [];
  const oldFile = legacyProjectMemoryFile(f.memoryConfig.dataDir, projectId), newFile = legacyProjectMemoryFile(f.memoryConfig.dataDir, otherProjectId);
  const oldMemory = await readJSON(oldFile), newMemory = await readJSON(newFile);
  oldMemory.main.memory.map.root.memoryDocument = 'OLD_ONLY_蓝色纸船';
  newMemory.main.memory.map.root.memoryDocument = 'NEW_ONLY_博客项目';
  await fs.writeFile(oldFile, JSON.stringify(oldMemory)); await fs.writeFile(newFile, JSON.stringify(newMemory));
  const store = await new Store(path.join(f.directory, 'switch-slack')).open();
  await store.update(s => { s.preferences[userId] = projectId; });
  const gateway = new Gateway({ url: f.cloud.integrationUrl, token: integrationCredential, teamId });
  const original = gateway.command.bind(gateway); gateway.command = async (type, args) => { calls.push({ type, ...args }); return original(type, args); };
  const plugin = new SlackPlugin({ store, gateway, teamId, cloudOrigin: f.cloud.url, botUserId: 'UBOTTEST', collectMs: 0, maxCollectMs: 0,
    logger: { warn(){}, error(){} }, io: {
      post: async input => { posts.push(input); return `${1000 + posts.length}.001`; }, update: async (...args) => { posts.push({ update: args }); },
      call: async (method, input) => method === 'conversations.info' ? { channel: { id: dm, user: userId } } :
        method === 'users.info' ? { user: { id: input.user, is_bot: false } } : { messages: [] },
    } });
  f.ownPlugin(plugin); plugin.stopped = false;
  const send = async (ts, text, thread_ts) => plugin.receive({ type: 'events_api', body: { team_id: teamId, event: {
    type: 'message', user: userId, channel: dm, channel_type: 'im', ts, text, ...(thread_ts ? { thread_ts } : {}) } }, ack: async () => {} });
  await send('100.001', '切换到另一个项目');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && store.data.preferences[userId] !== otherProjectId) { await plugin.tick(); await new Promise(r => setTimeout(r, 10)); }
  assert.equal(store.data.preferences[userId], otherProjectId, JSON.stringify(store.data.projectSwitches));
  const sourceKey = threadKey(teamId, dm, '100.001'), record = Object.values(store.data.projectSwitches)[0];
  assert.equal(store.data.threads[sourceKey].projectId, projectId); assert.equal(record.status, 'applied');
  const next = store.data.threads[record.targetKey];
  const target = await original('conversation.state', { id: 'before-target-reply', userId, projectId: next.projectId, conversationId: next.conversationId });
  assert.deepEqual(target.messages, []);
  await send('2000.001', '只读介绍当前项目', '100.001');
  const nextDeadline = Date.now() + 6000;
  while (Date.now() < nextDeadline && !posts.some(p => p.text?.includes('Fixture response'))) { await plugin.tick(); await new Promise(r => setTimeout(r, 10)); }
  assert.ok(posts.some(p => p.text?.includes('Fixture response')));
  const lastCall = f.modelCalls.filter(c => c.maxTokens !== 256).at(-1);
  assert.match(lastCall.system, /NEW_ONLY_博客项目/); assert.doesNotMatch(JSON.stringify(lastCall), /OLD_ONLY_蓝色纸船|切换到另一个项目/);
  const submit = calls.filter(c => c.type === 'conversation.submit').at(-1);
  assert.equal(submit.projectId, otherProjectId); assert.equal(submit.conversationId, next.conversationId); assert.equal(submit.payload.history, undefined);
  assert.equal((await readJSON(oldFile)).main.memory.map.root.memoryDocument, oldMemory.main.memory.map.root.memoryDocument);
});

test('Map 新建项目自动可选：沿原分支对话和写入，改名、同名、删除及重启保持身份与隔离', async t => {
  const f = await fixture(t, { mapProjects: true, bindingNodeId: 'N-new' });
  const overview = async () => {
    const response = await fetch(f.cloud.url + '/api/workbench/overview/api/state', { headers });
    assert.equal(response.status, 200); return response.json();
  };
  const edit = async (operationId, operations) => {
    const response = await fetch(f.cloud.url + '/api/workbench/overview/api/commit', { method: 'POST', headers,
      body: JSON.stringify({ operationId, baseVersion: (await overview()).version, operations }) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const list = async () => (await f.gateway('project.list')).body.data.projects;
  await edit('new-projects', [
    { type: 'create', parentId: 'T0', node: { id: 'N-new', title: '博客', purpose: '新建博客项目', memoryDocument: '仅属于博客的资料' } },
    { type: 'create', parentId: 'T0', node: { id: 'N-other', title: '博客', purpose: '另一份同名项目', memoryDocument: '不可串入的其他资料' } },
  ]);
  const projects = (await list()).filter(project => project.name === '博客');
  assert.equal(projects.length, 2); assert.notEqual(projects[0].id, projects[1].id);
  assert.equal(projects[0].private, true);
  const selected = projects.find(project => project.mapNodeId === 'N-new');
  const read = await f.gateway('project.read', {}, { project: selected.id });
  assert.equal(read.status, 200); assert.equal(read.body.data.map.root.id, 'N-new');
  assert.doesNotMatch(JSON.stringify(read.body.data), /不可串入|N-other/);
  assert.deepEqual(read.body.data.sessions, []);
  const denied = await f.gateway('project.read', {}, { project: selected.id, user: 'UOTHER' });
  assert.equal(denied.status, 403);
  assert.deepEqual((await f.gateway('project.list', {}, { user: 'UOTHER' })).body.data.projects.map(project => project.id), [projectId, otherProjectId]);
  const created = await f.gateway('conversation.create', {}, { id: 'new-map-chat', project: selected.id });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const conversationId = created.body.data.conversationId;
  const submit = await f.gateway('conversation.submit', { text: '介绍这个项目，不修改' }, { id: 'map-chat-turn', project: selected.id, conversationId });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const wait = async predicate => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const state = await f.gateway('conversation.state', {}, { project: selected.id, conversationId });
      assert.equal(state.status, 200, JSON.stringify(state.body));
      if (predicate(state.body.data)) return state.body.data;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('Map 项目对话未完成');
  };
  const state = await wait(state => state.status === 'waiting-for-user');
  assert.equal(state.executionMode, 'manual'); assert.deepEqual(state.projectTasks, []);
  assert.ok(state.messages.some(message => message.role === 'assistant' && message.text.includes('Fixture response')));
  const call = f.modelCalls.find(call => call.tools.length > 0 && call.messages.some(message => String(message.content).includes('介绍这个项目')));
  assert.ok(call); assert.doesNotMatch(JSON.stringify(call), /不可串入的其他资料/);
  assert.equal(call.tools.some(tool => tool.name === 'dispatch_task' || tool.name === 'write_file'), false);
  const before = await overview();
  const invalid = await f.gateway('map.write', { baseVersion: before.version, operations: [{ type: 'update', id: 'N-other', fields: { memoryDocument: '越界修改' } }] },
    { id: 'cross-project', project: selected.id });
  assert.equal(invalid.status, 404); assert.equal((await overview()).version, before.version);
  const write = await f.gateway('map.write', { baseVersion: before.version, operations: [{ type: 'update', id: 'N-new', fields: { memoryDocument: '更新后的博客资料' } }] },
    { id: 'scoped-map-write', project: selected.id });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  const afterWrite = await overview();
  assert.equal(afterWrite.doc.root.children.find(node => node.id === 'N-new').memoryDocument, '更新后的博客资料');
  assert.equal(afterWrite.doc.root.children.find(node => node.id === 'N-other').memoryDocument, '不可串入的其他资料');
  assert.equal((await f.gateway('project.read', {}, { project: selected.id })).body.data.version, afterWrite.version);
  assert.equal((await f.gateway('map.write', { baseVersion: before.version, operations: [{ type: 'update', id: 'N-new', fields: { purpose: '过期修改' } }] },
    { id: 'stale-map-write', project: selected.id })).status, 409);
  await edit('rename-project', [{ type: 'update', id: 'N-new', fields: { title: '新的博客名称' } }]);
  assert.equal((await list()).find(project => project.id === selected.id).name, '新的博客名称');
  await f.restart();
  assert.equal((await f.gateway('conversation.state', {}, { project: selected.id, conversationId })).status, 200);
  await confirmBinding(f, conversationId, 'todo', { project: selected.id });
  const reply = await f.gateway('conversation.submit', { text: '准备测试任务' }, { id: 'map-brief-turn', project: selected.id, conversationId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const prepared = await wait(state => state.approvals?.some(proposal => proposal.manual && !proposal.review));
  const approval = prepared.approvals.find(proposal => proposal.manual && !proposal.review);
  const confirmed = await f.gateway('brief.review', { proposalId: approval.id, version: approval.version, decision: 'approved', reason: '隔离测试确认' },
    { id: 'map-brief-confirm', project: selected.id, conversationId });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const prompt = await f.gateway('prompt.read', { proposalId: approval.id }, { project: selected.id, conversationId });
  assert.equal(prompt.status, 200);
  assert.match(prompt.body.data.text, /不代表已经关联代码仓库或执行 Session/);
  assert.doesNotMatch(prompt.body.data.text, /通过 Context Guard 的按版本单文件读取入口使用/);
  assert.ok((await overview()).doc.root.children.find(node => node.id === 'N-new').todos.some(item => item.title === '验证新增项目的任务'));
  const registry = JSON.parse(await fs.readFile(path.join(f.directory, 'projects.json'), 'utf8'));
  assert.equal(registry.projects.length, 2, '不生成第二份项目或 Map');
  assert.deepEqual((await f.gateway('project.read', {}, { project: selected.id })).body.data.sessions, []);
  await edit('delete-project', [{ type: 'delete', id: 'N-new' }]);
  assert.equal((await list()).some(project => project.id === selected.id), false);
  assert.equal((await f.gateway('conversation.state', {}, { project: selected.id, conversationId })).status, 404);
  assert.equal((await f.gateway('conversation.create', {}, { id: 'new-map-chat', project: selected.id })).status, 404,
    '即使原操作有成功回执，删除后也不再返回私有结果');
  assert.ok((await list()).some(project => project.id === projects.find(project => project.mapNodeId === 'N-other').id));
});

test('隔离跨组件：网页新建项目→原 Slack 问题实时选项→同线程 Coordinator 回复', async t => {
  const f = await fixture(t, { mapProjects: true }), messages = [];
  const store = await new Store(path.join(f.directory, 'slack-state')).open();
  const plugin = new SlackPlugin({ store, teamId, cloudOrigin: 'https://map.example.com', botUserId: 'UBOTTEST',
    gateway: new Gateway({ url: f.cloud.integrationUrl, token: integrationCredential, teamId }),
    io: { post: async input => { messages.push(input); return `${100 + messages.length}.001`; }, update: async (...input) => messages.push({ update: input }),
      call: async method => method === 'conversations.info' ? { channel: { user: userId } } :
        ['conversations.history', 'conversations.replies'].includes(method) ? { messages: [] } : {}, }, logger: { error(){}, warn(){} } });
  f.ownPlugin(plugin);
  const event = { type: 'message', user: userId, channel: 'DPRIVATE', channel_type: 'im', ts: '100.000', text: '登录刷新 Bug，请分析。' };
  await plugin.chooseProject('original-question', event);
  const original = store.data.inbox['original-question'];
  const stateResponse = await fetch(f.cloud.url + '/api/workbench/overview/api/state', { headers }), state = await stateResponse.json();
  const added = await fetch(f.cloud.url + '/api/workbench/overview/api/commit', { method: 'POST', headers,
    body: JSON.stringify({ operationId: 'browser-new-project', baseVersion: state.version,
      operations: [{ type: 'create', parentId: 'T0', node: { id: 'N-after-question', title: '新项目', purpose: '登录刷新讨论' } }] }) });
  assert.equal(added.status, 200); await added.body.cancel();
  const body = { type: 'block_suggestion', user: { id: userId }, channel: { id: event.channel }, message: { ts: original.projectPromptTs },
    block_id: 'projects:original-question', action_id: 'connect_project_menu', value: '新项目' };
  const options = await plugin.suggestProjects(body, 'fresh-options');
  assert.equal(options.length, 1); assert.equal(options[0].text.text, '新项目');
  assert.equal(original.projectPromptProjects.includes(options[0].value), false, '项目在原问题之后才创建');
  await plugin.process('select-new-project', { type: 'interactive', body: { ...body, type: 'block_actions',
    actions: [{ action_id: 'connect_project_menu', block_id: body.block_id, selected_option: options[0] }] } });
  await plugin.runEntry('original-question', store.data.inbox['original-question']);
  assert.equal(store.data.inbox['original-question'].status, 'done');
  const [key, binding] = Object.entries(store.data.threads)[0];
  assert.equal(binding.threadTs, event.ts); assert.equal(binding.projectId, options[0].value); assert.equal(binding.mapNodeId, 'N-after-question');
  const deadline = Date.now() + 4000; let final;
  while (Date.now() < deadline) {
    const result = await f.gateway('conversation.state', {}, { project: binding.projectId, conversationId: binding.conversationId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.body.data.status === 'waiting-for-user') { final = result.body.data; break; }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(final); await plugin.mirror(key); await plugin.mirror(key);
  const replies = messages.filter(message => message.text?.startsWith('Coordinator：'));
  assert.equal(replies.length, 1); assert.equal(replies[0].channel, event.channel); assert.equal(replies[0].threadTs, event.ts);
  assert.match(replies[0].text, /Fixture response/);
  assert.equal(final.messages.filter(message => message.role === 'user' && message.text === event.text).length, 1);
  assert.equal(Object.keys(store.data.threads).length, 1);
});

test('Slack native selector uses the real server model action grant without a menu or route change mid-turn', async t => {
  for (const allowed of [true, false]) {
    const f = await fixture(t, { modelSelection: true, ...(allowed ? {} : { integrationActions: ['conversation.create', 'conversation.submit', 'conversation.state', 'models.state'] }) });
    const chat = await f.newConversation(`native-select-chat-${allowed}`);
    const response = await f.gateway('conversation.submit', { text: '切换到目标模型' }, { id: `native-select-turn-${allowed}`, conversationId: chat });
    assert.equal(response.status, 200);
    const completed = await f.wait(chat, state => state.status === 'waiting-for-user' && !state.activeTurnId);
    const settings = await f.gateway('models.state');
    assert.equal(settings.body.data.selectedId, allowed ? 'target' : 'original');
    assert.equal(completed.modelRoute.providerId, 'original');
    assert.equal(completed.messages.flatMap(message => message.actions || []).length, 0);
    assert.match(completed.messages.at(-1).text, allowed ? /已切换到目标模型/ : /不允许切换/);
    await f.gateway('conversation.submit', { text: '下一轮' }, { id: `after-switch-${allowed}`, conversationId: chat });
    const next = await f.wait(chat, state => state.status === 'waiting-for-user' && !state.activeTurnId && state.acceptedRequestIds.includes(`after-switch-${allowed}`));
    assert.equal(next.modelRoute.providerId, allowed ? 'target' : 'original');
    await f.cloud.close();
  }
});

test('list_tasks uses the same exact node scope as reads, not inherited access to children', async t => {
  const f = await fixture(t, { nodeIds: ['T0'], childNodes: [{ id: 'N-private', title: 'Unassigned child', children: [],
    todos: [{ id: 'TD-private', title: 'Unassigned child TODO', status: 'pending' }],
    bugs: [{ id: 'B-private', title: 'Unassigned child Bug', status: 'open' }] }] });
  const conversation = await f.newConversation('scope-list-chat');
  assert.equal((await f.gateway('conversation.submit', { text: 'list-scoped-tasks' }, { id: 'scope-list-turn', conversationId: conversation })).status, 200);
  await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const reply = f.modelCalls.at(-1).messages.at(-1).content.find(block => block.type === 'tool_result');
  const result = JSON.parse(reply.content);
  assert.ok(JSON.stringify(result).includes('Existing original TODO'));
  assert.ok(JSON.stringify(result).includes('Existing original Bug'));
  assert.doesNotMatch(JSON.stringify(result), /TD-private|B-private|Unassigned child/);
});

test('relevance endpoint reads current Main but never creates conversations, work items or execution state', async t => {
  const f = await fixture(t), before = await f.main();
  const originalFiles = await fs.readdir(path.join(f.directory, 'coordinators'), { recursive: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error; return [];
  });
  const conversationFiles = files => files.filter(file => /(?:conversations|conversation|state\.json|chat-)/.test(file)).sort();
  const result = await f.gateway('conversation.relevance', { text: '登录刷新 Bug，请分析。' }, { id: 'relevance-related' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { respond: true, reason: 'Controlled decision', mainVersion: before.main.version });
  const request = f.modelCalls.at(-1);
  assert.deepEqual(request.tools, []); assert.equal(request.maxTokens, 256);
  assert.equal(JSON.parse(request.messages[0].content).overview.memory, 'Current project facts');
  assert.deepEqual(await f.main(), before);
  assert.deepEqual(conversationFiles(await fs.readdir(path.join(f.directory, 'coordinators'), { recursive: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error; return [];
  })), conversationFiles(originalFiles));
  const calls = f.modelCalls.length;
  await f.restart();
  assert.deepEqual((await f.gateway('conversation.relevance', { text: '登录刷新 Bug，请分析。' }, { id: 'relevance-related' })).body.data, result.body.data);
  assert.equal(f.modelCalls.length, calls);
  assert.equal((await f.gateway('conversation.relevance', { text: 'changed text' }, { id: 'relevance-related' })).status, 409);
});

test('unrelated and invalid relevance decisions cannot become submitted turns', async t => {
  const f = await fixture(t), before = await f.main();
  const unrelated = await f.gateway('conversation.relevance', { text: '<@UOTHER> 中午吃什么？' }, { id: 'relevance-unrelated' });
  assert.equal(unrelated.status, 200); assert.equal(unrelated.body.data.respond, false);
  const invalid = await f.gateway('conversation.relevance', { text: 'invalid-relevance' }, { id: 'relevance-malformed' });
  assert.equal(invalid.status, 502); assert.equal(invalid.body.error.code, 'RELEVANCE_INVALID_RESPONSE');
  const forbiddenTool = await f.gateway('conversation.relevance', { text: 'relevance-tool' }, { id: 'relevance-tool' });
  assert.equal(forbiddenTool.status, 502); assert.equal(forbiddenTool.body.error.code, 'RELEVANCE_INVALID_RESPONSE');
  assert.equal(invalid.body.data, undefined); assert.deepEqual(await f.main(), before);
});

test('Cloud connects the real integration failure logger using only fixed private diagnostic fields', async t => {
  const f = await fixture(t), logs = [], warn = console.warn;
  console.warn = (...args) => logs.push(args);
  try {
    const failed = await f.gateway('conversation.relevance', { text: 'invalid-relevance' }, { id: 'private-original-request' });
    assert.equal(failed.status, 502); assert.deepEqual(Object.keys(failed.body.error).sort(), ['code', 'message']);
    const entry = logs.find(log => log[0] === 'Context Guard integration failure')?.[1];
    assert.ok(entry, 'Exercise startCloudServer logger wiring, not a standalone supplied logger');
    assert.equal(entry.code, 'RELEVANCE_INVALID_RESPONSE'); assert.equal(entry.phase, 'decision-parse'); assert.equal(entry.causeCode, 'MODEL_INVALID_RESPONSE');
    assert.match(entry.idHash, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0);
    assert.deepEqual(Object.keys(entry).sort(), ['causeCode', 'code', 'durationMs', 'idHash', 'phase']);
    assert.doesNotMatch(JSON.stringify(entry), /private-original-request|invalid-relevance|provider|token|model|project|prompt/);
  } finally { console.warn = warn; }
});

test('relevance input, workspace, project and conversation boundaries are checked before the model', async t => {
  const f = await fixture(t), calls = f.modelCalls.length;
  for (const payload of [{ text: '' }, { text: 'x', tool: 'map.write' }, { text: 'x', context: [{ speaker: userId, text: 'x'.repeat(801) }] },
    { text: 'x', files: [{ name: 'x', mimeType: 'image/png', path: '/private' }] }, { text: 'x'.repeat(10001) }]) {
    assert.equal((await f.gateway('conversation.relevance', payload)).status, 400);
  }
  assert.equal((await f.gateway('conversation.relevance', { text: 'x' }, { project: 'unavailable-project' })).status, 403);
  assert.equal((await f.gateway('conversation.relevance', { text: 'x' }, { user: 'fake-device' })).status, 403);
  assert.equal((await f.gateway('conversation.relevance', { text: 'x' }, { credential: browserCredential })).status, 401);
  assert.equal((await f.gateway('conversation.relevance', { text: 'x' }, { conversationId: 'legacy' })).status, 403);
  assert.equal(f.modelCalls.length, calls);
});

test('An atomic Slack input batch retains each original identity and rejects forged or mixed retry data', async t => {
  const f = await fixture(t), conversation = await f.newConversation('batch-chat'), before = await f.main();
  const inputs = [{ id: 'batch-original-1', text: '整理登录问题。' },
    { id: 'batch-original-2', text: '补充：只列验收标准。' }];
  const sent = await f.gateway('conversation.submit', { inputs, followup: 'steer' }, { id: 'batch-envelope', conversationId: conversation });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const state = await f.wait(conversation, value => !value.activeTurnId && value.status === 'waiting-for-user');
  const messages = state.messages.filter(message => message.role === 'user');
  assert.deepEqual(messages.map(message => message.requestId), inputs.map(input => input.id));
  assert.deepEqual(messages.map(message => message.text), inputs.map(input => input.text));
  assert.ok(messages.every(message => message.actor.userId === userId && message.actor.teamId === teamId && message.source === 'slack'));
  const calls = f.modelCalls.length;
  assert.deepEqual((await f.gateway('conversation.submit', { inputs, followup: 'steer' }, { id: 'batch-envelope', conversationId: conversation })).body, sent.body);
  assert.equal(f.modelCalls.length, calls);
  assert.equal((await f.gateway('conversation.submit', { inputs: [{ ...inputs[0], actor: { userId: 'UOTHER' } }] }, { id: 'batch-forged', conversationId: conversation })).status, 400);
  assert.equal((await f.gateway('conversation.submit', { inputs, text: 'replacement' }, { id: 'batch-mixed', conversationId: conversation })).status, 400);
  assert.equal((await f.browser(conversation, { body: { id: 'batch-browser', inputs } })).status, 400);
  const single = await f.gateway('conversation.submit', { inputs: [{ id: 'single-original', text: '再确认一下验收范围。' }], followup: 'steer' },
    { id: 'single-envelope', conversationId: conversation });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  const completed = await f.wait(conversation, value => !value.activeTurnId && value.acceptedRequestIds.includes('single-original'));
  assert.equal(completed.messages.filter(message => message.requestId === 'single-original' && message.role === 'user').length, 1);
  assert.equal(completed.acceptedRequestIds.includes('single-envelope'), false, 'Plugin must track original acceptance IDs, not the transport envelope');
  assert.deepEqual(await f.main(), before);
});

test('Slack vision configuration cannot silently select a different model', async t => {
  const invalid = await fixture(t, { visionProvider: { model: 'wrong-image-model' } });
  const rejected = await invalid.gateway('conversation.create', { operationId: 'create-wrong-model' }, { id: 'create-wrong-model' });
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error.code, 'INVALID_VISION_PROVIDER');
  assert.equal(invalid.modelCalls.length, 0);
  const valid = await fixture(t, { visionProvider: { model: 'glm-5.3-flash' } });
  const id = await valid.newConversation('create-fixed-vision');
  assert.equal((await valid.browser(id)).body.executionMode, 'manual');
});

test('Slack-created and browser-bound conversations retain manual mode and shared history across restart', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-shared');
  assert.equal((await f.browser(conversation)).body.executionMode, 'manual');
  assert.equal((await f.browser(conversation)).body.compaction.thresholdTokens, 8192, 'Manual chat uses the early compact profile');
  assert.equal((await f.browser('main')).body.compaction.thresholdTokens, 500000, 'Normal execution profile remains unchanged');
  const created = await f.browser('main', { suffix: '/conversations/new', body: { id: 'browser-original-chat' } });
  assert.equal(created.status, 201); const boundId = created.body.id;
  const bind = await f.gateway('conversation.bind', { conversationId: boundId }, { id: 'bind-original-chat' });
  assert.equal(bind.status, 200, JSON.stringify(bind.body));
  const submit = await f.gateway('conversation.submit', { text: 'Slack first message' }, { id: 'slack-first', conversationId: conversation });
  assert.equal(submit.status, 200, JSON.stringify(submit.body)); assert.equal(submit.body.data.accepted, true);
  const state = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const slackMessage = state.messages.find(message => message.requestId === 'slack-first' && message.role === 'user');
  assert.equal(slackMessage.text, 'Slack first message'); assert.equal(slackMessage.source, 'slack');
  assert.equal(slackMessage.actor.userId, userId); assert.equal(slackMessage.actor.teamId, teamId); assert.ok(slackMessage.id);
  assert.equal((await f.browser(conversation, { body: { id: 'browser-second', text: 'Browser continues the same thread' } })).status, 202);
  await f.wait(conversation, value => value.status === 'waiting-for-user' && value.acceptedRequestIds.includes('browser-second'));
  const pluginView = await f.gateway('conversation.state', {}, { conversationId: conversation });
  assert.ok(pluginView.body.data.messages.some(message => message.requestId === 'browser-second' && message.text === 'Browser continues the same thread'));
  await f.restart();
  assert.equal((await f.browser(boundId)).body.executionMode, 'manual');
  const after = (await f.browser(conversation)).body;
  assert.equal(after.executionMode, 'manual'); assert.equal(after.messages.filter(message => message.role === 'user').length, 2);
  assert.ok(after.messages.some(message => message.id === slackMessage.id));
  const repeated = await f.newConversation('create-shared'); assert.equal(repeated, conversation);
  assert.ok(f.modelCalls.length >= 2, 'Requests actually exercised the controlled model provider');
});

test('Public manual conversation uses lean role and unchanged native schemas without weakening normal execution', async t => {
  const f = await fixture(t), conversation = await f.newConversation('role-manual');
  assert.equal((await f.gateway('conversation.submit', { text: 'role-first' }, { id: 'role-first', conversationId: conversation })).status, 200);
  await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const manualCall = f.modelCalls.at(-1);
  assert.match(manualCall.system, /不创建、派发或恢复执行 Session/);
  assert.doesNotMatch(manualCall.system, /系统为新任务创建独立执行 Session|自动发起中断恢复/);
  assert.match(manualCall.system, /Current project facts/);
  assert.match(manualCall.system, /本轮答复发往 Slack/);
  const nonDMTools = coordinatorTools.filter(tool => !['list_projects', 'switch_project'].includes(tool.name));
  assert.deepEqual(manualCall.tools, selectCoordinatorTools(filterManualTools(nonDMTools), { fileWrite: false }),
    'Retain enabled manual native definitions, not a text-only substitute');
  for (const name of ['show_model_menu', 'react_to_user']) assert.ok(manualCall.tools.some(tool => tool.name === name),
    `Verified Slack human inputs retain the Slack-only tool ${name}`);
  const callsBefore = f.modelCalls.length;
  assert.equal((await f.gateway('conversation.submit', { text: 'show-node-complete' }, { id: 'role-show', conversationId: conversation })).status, 200);
  const shown = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId && value.acceptedRequestIds.includes('role-show'));
  assert.equal(f.modelCalls.length, callsBefore + 1, 'Successful presentation of an existing answer needs no second model round');
  const replies = shown.messages.filter(m => m.role === 'assistant' && m.requestId === 'role-show');
  assert.equal(replies.length, 1); assert.equal(replies[0].text, 'This is the complete read-only answer.');
  assert.equal(replies[0].actions[0].kind, 'node-references');
  assert.equal((await f.browser('main', { body: { id: 'role-automatic', text: 'role-automatic' } })).status, 202);
  await f.wait('main', value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const automaticCall = f.modelCalls.at(-1);
  assert.match(automaticCall.system, /系统为新任务创建独立执行 Session/);
  assert.doesNotMatch(automaticCall.system, /以下仅用于宿主已声明的人工执行对话/);
  assert.match(automaticCall.messages.at(-1).content, /输出来源：human/);
  assert.deepEqual(automaticCall.tools, selectCoordinatorTools(nonDMTools, { fileWrite: false }));
  for (const name of ['show_model_menu', 'react_to_user']) assert.equal(automaticCall.tools.some(tool => tool.name === name), true,
    `Stable catalog retains ${name}; source authorization is checked at execution`);
  await f.restart();
  assert.equal((await f.gateway('conversation.submit', { text: 'role-after-restart' }, { id: 'role-after-restart', conversationId: conversation })).status, 200);
  await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  assert.doesNotMatch(f.modelCalls.at(-1).system, /系统为新任务创建独立执行 Session/);
  assert.deepEqual(f.modelCalls.at(-1).tools, manualCall.tools);
});

test('Browser retries of a failed Slack turn retain verified Slack actor/source and reject caller-forged identity', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-retry');
  const payload = { text: 'failure-then-browser-retry' };
  assert.equal((await f.gateway('conversation.submit', payload, { id: 'failed-slack-turn', conversationId: conversation })).status, 200);
  const failed = await f.wait(conversation, value => value.status === 'error');
  assert.equal(failed.error.code, 'FIXTURE_PROVIDER_FAILURE'); assert.equal(failed.retryInput.source, 'slack');
  assert.equal((await f.browser(conversation, { body: { id: 'failed-slack-turn', ...payload, retry: true, source: 'workflow' } })).status, 400);
  const retry = await f.browser(conversation, { body: { id: 'failed-slack-turn', ...payload, retry: true } });
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  const done = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const users = done.messages.filter(message => message.role === 'user' && message.requestId === 'failed-slack-turn');
  assert.equal(users.length, 1); assert.equal(users[0].source, 'slack'); assert.equal(users[0].actor.userId, userId);
});

async function confirmBinding(f, conversation, kind = 'todo', { project = projectId } = {}) {
  const request = 'bind-' + conversation + '-' + kind;
  assert.equal((await f.gateway('conversation.submit', { text: 'mount-' + kind }, { id: request, project, conversationId: conversation })).status, 200);
  const deadline = Date.now() + 4000; let pending;
  while (Date.now() < deadline) {
    const state = (await f.gateway('conversation.state', {}, { id: 'poll-' + request + '-' + Date.now(), project, conversationId: conversation })).body.data;
    if (state.status === 'waiting-for-user' && !state.activeTurnId && state.approvals.some(item => item.kind === 'binding-proposal' && item.pending)) { pending = state; break; }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(pending, '真实 HTTP 必须返回待确认绑定，不能直接写焦点');
  const proposal = pending.approvals.find(item => item.kind === 'binding-proposal' && item.pending);
  const result = await f.gateway('binding.review', { proposalId: proposal.id, version: proposal.version, decision: 'approved' }, {
    id: 'confirm-' + request, project, conversationId: conversation });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const finalDeadline = Date.now() + 4000;
  while (Date.now() < finalDeadline) {
    const state = (await f.gateway('conversation.state', {}, { id: 'settle-' + request + '-' + Date.now(), project, conversationId: conversation })).body.data;
    if (state.status === 'waiting-for-user' && !state.activeTurnId) return state;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('确认通知未收口');
}
async function prepared(f, conversation, name, id) {
  if (['prepare-new', 'prepare-stale', 'prepare-new-bug', 'prepare-bug'].includes(name)) {
    const kind = ['prepare-new-bug', 'prepare-bug'].includes(name) ? 'bug' : 'todo', state = (await f.browser(conversation)).body;
    if (state.focus?.kind !== kind || !state.approvals.some(item => item.kind === 'binding-proposal' && item.decision === 'approved' && item.itemKind === kind)) {
      await confirmBinding(f, conversation, kind);
    }
  }
  const result = await f.gateway('conversation.submit', { text: name }, { id, conversationId: conversation });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const state = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId &&
    value.approvals.some(proposal => proposal.manual && proposal.pending));
  return state.approvals.find(proposal => proposal.manual && proposal.pending);
}
async function assertNoDispatch(f, existingBindings = {}) {
  const state = await f.main(); assert.deepEqual(Object.keys(state.sessions), []);
  for (const repositoryId of ['123', '124']) {
    const state = await readJSON(path.join(f.directory, 'interface-v2', hash(repositoryId), 'protocol-v2.json'), {});
    assert.equal(Object.keys(state.sessionCreations || {}).length, 0);
    assert.equal(Object.keys(state.projectTasks || {}).length, 0);
    assert.equal(Object.keys(state.tasks || {}).length, 0);
    assert.deepEqual(state.bindings || {}, existingBindings[repositoryId] || {}, 'Existing bindings stay exact; mounting cannot create or modify a Session');
  }
}

test('绑定确认通知不是新的需求指令，模型不能据此自行生成待审批 brief', async t => {
  const f = await fixture(t);
  f.options.coordinatorModelFactory = () => ({ next: async request => {
    const content = request.messages.at(-1)?.content;
    if (typeof content === 'string' && content.includes('mount-todo')) return { stop: 'tool_use', content: [{ type: 'tool_use',
      id: 'propose-focus', name: 'mount_conversation', input: { mainVersion: 'main-initial', nodeId: 'T0', kind: 'todo', title: '需求讨论', description: '先确认归属' } }] };
    if (typeof content === 'string' && content.includes('human.binding-review')) return { stop: 'tool_use', content: [{ type: 'tool_use',
      id: 'unsolicited-brief', name: 'prepare_task', input: { taskId: 'notification-brief', text: '未经用户要求整理需求', acceptance: '不得创建', nodeIds: ['T0'], mainVersion: 'main-initial' } }] };
    return { stop: 'end_turn', content: [{ type: 'text', text: '归属已确认，等待继续讨论。' }] };
  } });
  await f.restart(); const conversation = await f.newConversation('notification-is-not-brief-request');
  const before = await f.main(); await confirmBinding(f, conversation);
  const state = (await f.browser(conversation)).body;
  assert.equal(state.focus.nodeId, 'T0'); assert.equal(state.approvals.some(p => p.manual), false);
  const registry = new CoordinatorConversations(path.join(f.directory, 'coordinators', projectId));
  const native = await readJSON(registry.conversationFile(conversation));
  assert.ok(Object.values(native.toolReceipts).some(receipt => receipt.isError && receipt.result.error.code === 'APPROVAL_REQUIRED'));
  assert.deepEqual(await f.main(), before);
});

test('真实 HTTP 拒绝未经确认创建节点、未绑定或跨主节点 brief，并拒绝改绑后的旧审批', async t => {
  const f = await fixture(t, { childNodes: [{ id: 'OTHER', title: '另一模块', kind: 'module', children: [], todos: [], bugs: [] }] });
  f.options.coordinatorModelFactory = () => ({ next: async request => {
    const last = request.messages.at(-1)?.content;
    const text = typeof last === 'string' ? last.split('[以下为原始输入]\n').at(-1) : '';
    const version = (await f.main()).main.version;
    const call = (name, input) => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'native-' + text, name, input }] });
    if (text === '未经确认新建') return call('edit_map', { mainVersion: version, actions: [{ op: 'create', parentId: 'T0', title: '不能偷偷创建' }] });
    if (text.startsWith('整理')) return call('prepare_task', { taskId: 'new-request', text: '新需求说明', acceptance: '保持确认的主节点',
      nodeIds: text === '整理其他' ? ['OTHER'] : text === '整理多个' ? ['T0', 'OTHER'] : ['T0'], mainVersion: version });
    if (['mount-todo', '改绑其他'].includes(text)) return call('mount_conversation', { mainVersion: version,
      nodeId: text === '改绑其他' ? 'OTHER' : 'T0', kind: 'todo', title: '需求讨论', description: '人工确认归属' });
    return { stop: 'end_turn', content: [{ type: 'text', text: '继续讨论，以真实回执为准。' }] };
  } });
  await f.restart(); const conversation = await f.newConversation('routing-guards');
  const send = async (id, text) => {
    const result = await f.gateway('conversation.submit', { text }, { id, conversationId: conversation });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return f.wait(conversation, state => state.status === 'waiting-for-user' && !state.activeTurnId);
  };
  const before = await f.main();
  await send('blocked-node', '未经确认新建'); await send('unbound-brief', '整理需求');
  assert.deepEqual(await f.main(), before);
  const registry = new CoordinatorConversations(path.join(f.directory, 'coordinators', projectId));
  const errors = async () => Object.values((await readJSON(registry.conversationFile(conversation))).toolReceipts).filter(receipt => receipt.isError).map(receipt => receipt.result.error.code);
  assert.deepEqual(await errors(), ['APPROVAL_REQUIRED', 'APPROVAL_REQUIRED']);
  await confirmBinding(f, conversation, 'todo');
  await send('wrong-primary', '整理其他'); await send('multiple-primary', '整理多个');
  assert.equal((await f.browser(conversation)).body.approvals.some(proposal => proposal.manual), false);
  assert.equal((await errors()).length, 4); assert.deepEqual(await f.main(), before);
  const prepared = await send('valid-brief', '整理需求');
  const brief = prepared.approvals.find(proposal => proposal.manual && proposal.pending); assert.ok(brief);
  const changed = await send('change-primary', '改绑其他');
  const proposal = changed.approvals.find(proposal => proposal.kind === 'binding-proposal' && proposal.pending);
  assert.equal((await f.gateway('binding.review', { proposalId: proposal.id, version: proposal.version, decision: 'approved' }, {
    id: 'human-rebind', conversationId: conversation })).status, 200);
  const stale = await f.gateway('brief.review', { proposalId: brief.id, version: brief.version, decision: 'approved' }, {
    id: 'stale-brief-review', conversationId: conversation });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(await f.main(), before); await assertNoDispatch(f);
});

test('Slack brief approval and browser approval use shared Main CAS, receipts and manual work-item identities', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-approval');
  const proposal = await prepared(f, conversation, 'prepare-new', 'prepare-new-message');
  assert.equal((await f.main()).main.memory.map.root.todos.length, 1, 'Proposal preparation cannot create a Main TODO');
  const review = { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: 'Exact brief accepted' };
  const approved = await f.gateway('brief.review', review, { id: 'slack-approval', conversationId: conversation });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.match(approved.body.data.prompt, /执行需求/);
  assert.match(approved.body.data.prompt, /Current project facts/, 'Root Map memory uses the root-level fs-v2.1 memory.md path');
  const todo = (await f.main()).main.memory.map.root.todos.find(item => item.id === proposal.itemId);
  assert.equal(todo.executionMode, 'manual'); assert.equal(todo.status, 'pending'); assert.equal(todo.approvedBrief.actor.userId, userId);
  await assertNoDispatch(f);
  const revision = (await f.main()).revision;
  assert.deepEqual((await f.gateway('brief.review', review, { id: 'slack-approval', conversationId: conversation })).body, approved.body);
  assert.equal((await f.main()).revision, revision);
  await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const browserView = (await f.browser(conversation)).body;
  assert.equal(browserView.approvals.find(item => item.id === proposal.id).pending, false);
  const exported = await f.gateway('prompt.read', { proposalId: proposal.id }, { conversationId: conversation });
  assert.equal(exported.body.data.text, approved.body.data.prompt);
  const bugProposal = await prepared(f, conversation, 'prepare-bug', 'prepare-bug-message');
  const browserApproved = await f.browser(conversation, { suffix: '/approval', body: { id: 'browser-approval', proposalId: bugProposal.id,
    version: bugProposal.version, decision: 'approved', reason: 'Original Bug accepted from workbench' } });
  assert.equal(browserApproved.status, 200, JSON.stringify(browserApproved.body));
  const bug = (await f.main()).main.memory.map.root.bugs[0];
  assert.equal(bug.id, 'B1'); assert.equal(bug.createdAt, 'original-bug'); assert.equal(bug.attempts[0].cause, 'Token expired');
  assert.equal(bug.executionMode, 'manual'); assert.equal(bug.status, 'open');
  assert.equal(bug.approvedBrief.actor.sessionId, 'browser-human'); await assertNoDispatch(f);
  const afterBrowser = (await f.main()).revision;
  assert.equal((await f.browser(conversation, { suffix: '/approval', body: { id: 'browser-approval', proposalId: bugProposal.id,
    version: bugProposal.version, decision: 'approved', reason: 'Original Bug accepted from workbench' } })).status, 200);
  assert.equal((await f.main()).revision, afterBrowser);
  assert.ok(f.modelCalls.filter(call => call.tools?.length).every(call => !call.tools.some(tool => ['dispatch_task', 'request_ci', 'complete_task'].includes(tool.name))),
    'Manual conversation model calls cannot receive automatic Agent tools');
});

test('Stale brief confirmation fails without Main or Agent mutations after a concurrent map update', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-stale');
  const proposal = await prepared(f, conversation, 'prepare-stale', 'prepare-stale-message');
  const before = await f.main();
  assert.equal((await f.gateway('map.write', { baseVersion: before.main.version,
    operations: [{ type: 'update', id: 'T0', fields: { memoryDocument: 'Concurrent verified update' } }] }, { id: 'concurrent-map' })).status, 200);
  const changed = await f.main();
  const rejected = await f.gateway('brief.review', { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: 'Stale confirmation' },
    { id: 'stale-approval', conversationId: conversation });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'VERSION_CONFLICT');
  const after = await f.main(); assert.equal(after.revision, changed.revision); assert.deepEqual(after.main.memory.map, changed.main.memory.map);
  await assertNoDispatch(f);
});

for (const scenario of [
  { name:'explicit Bug intent in a TODO-focused conversation', mount:'mount-todo', input:{taskId:'B1',kind:'bug'} },
  { name:'explicit Bug intent in another Bug-focused conversation', mount:'mount-bug', input:{taskId:'B1',kind:'bug'} },
  { name:'explicit other node in a Bug-focused conversation', mount:'mount-bug', input:{taskId:'B1',nodeId:'OTHER'} },
  { name:'explicit TODO intent in a Bug-focused conversation', mount:'mount-bug', input:{taskId:'new-todo',kind:'todo'} },
]) test(`Manual focus cannot replace ${scenario.name} when item identity is incomplete`, async t => {
  const f = await fixture(t,{prepareInput:scenario.input}),conversation=await f.newConversation('partial-identity');
  assert.equal((await f.gateway('conversation.submit',{text:scenario.mount},{id:'mount-focus',conversationId:conversation})).status,200);
  const mounted=await f.wait(conversation,value=>value.status==='waiting-for-user'&&!value.activeTurnId&&value.acceptedRequestIds.includes('mount-focus'));
  assert.equal(mounted.conversations.find(item=>item.id===conversation).itemId, undefined,
    'Mounting focuses a node without creating a Main work item');
  // Existing item conversations still need the routing protection after the
  // mount-only flow stopped creating items. Seed a persisted legacy focus.
  const registry=new CoordinatorConversations(path.join(f.directory,'coordinators',projectId));
  await registry.setFocus(conversation, { nodeId:'T0', kind:scenario.mount==='mount-bug'?'bug':'todo',
    itemId:scenario.mount==='mount-bug'?'B1':'TD-old' });
  await f.restart();
  const before=await f.main();
  assert.equal((await f.gateway('conversation.submit',{text:'prepare-explicit-routing'},{id:'partial-prepare',conversationId:conversation})).status,200);
  const settled=await f.wait(conversation,value=>value.status==='waiting-for-user'&&!value.activeTurnId&&value.acceptedRequestIds.includes('partial-prepare'));
  assert.equal(settled.approvals.filter(x=>x.manual).length,0,'No brief may silently adopt the focus instead of the explicit routing');
  const raw=await readJSON(registry.conversationFile(conversation));
  const reply=raw.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_result'&&b.tool_use_id==='tool-explicit-routing');
  assert.equal(reply?.is_error,true);
  assert.equal(JSON.parse(reply.content).error.code,'INVALID_ARGUMENT');
  assert.deepEqual(await f.main(),before,'A failed proposal must not mutate any Main item');
  await assertNoDispatch(f);
});

for (const scope of ['automatic-chat', 'main', 'legacy', 'session']) test(`Automatic mount retains ${scope} node memory across restart without Main or dispatch writes`, async t => {
  const f = await fixture(t, { childNodes: [{ id: 'N1', title: 'Login', kind: 'module', state: 'dirty', owns: [],
    memoryDocument: 'MOUNT-FOCUS-UNIQUE-MEMORY', children: [] }] });
  f.options.coordinatorModelFactory = () => ({ next: async request => {
    f.modelCalls.push(request);
    if (typeof request.messages.at(-1)?.content === 'string' && request.messages.at(-1).content.endsWith('[以下为原始输入]\nmount-focus-node')) return { stop: 'tool_use', content: [{ type: 'tool_use',
      id: 'mount-focus-tool', name: 'mount_conversation', input: {
        mainVersion: 'main-initial', nodeId: 'N1', kind: 'todo', title: 'Review login', description: 'Keep this discussion focused',
      } }] };
    return { stop: 'end_turn', content: [{ type: 'text', text: 'done' }] };
  } });
  let id = scope;
  if (scope === 'session') {
    const store = new ProtocolStore(path.join(f.directory, 'interface-v2', hash('123')));
    await store.handle({ repositoryId: '123', deviceId: 'fixture-device', agentId: 'fixture-executor' }, {
      v: 2, id: 'register-focus-session', type: 'session.bind', payload: { sessionId: 'focus-session', worktreeId: 'fixture-worktree',
        agentId: 'fixture-executor', expectedBindingVersion: '' },
    }, { verifyBinding: () => true });
    id = 'session:focus-session';
  }
  await f.restart();
  if (scope === 'automatic-chat') {
    const chat = await f.browser('main', { suffix: '/conversations/new', body: { id: 'automatic-focus-chat' } });
    assert.equal(chat.status, 201, JSON.stringify(chat.body)); id = chat.body.id;
  }
  const before = await f.main();
  const bindingsBefore = {};
  if (scope === 'session') bindingsBefore['123'] = (await readJSON(path.join(f.directory, 'interface-v2', hash('123'), 'protocol-v2.json'), {})).bindings;
  const mounted = await f.browser(id, { human: true, body: { id: 'mount-focus', text: 'mount-focus-node' } });
  assert.equal(mounted.status, 202, JSON.stringify(mounted.body));
  let final = await f.wait(id, state => state.status === 'waiting-for-user' && !state.activeTurnId);
  const action = final.messages.flatMap(message => message.actions || []).find(value => value.kind === 'binding-proposal');
  assert.equal(action?.node.id, 'N1');
  assert.equal(final.conversations.find(value => value.id === id).nodeId, undefined);
  const reviewed = await f.browser(id, { human: true, suffix: '/binding-review', body: {
    id: 'confirm-focus', proposalId: action.id, version: action.version, decision: 'approved' } });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  final = await f.wait(id, state => state.status === 'waiting-for-user' && !state.activeTurnId);
  assert.equal(final.conversations.find(value => value.id === id).nodeId, 'N1');
  assert.deepEqual(await f.main(), before, 'Mounting cannot change the Main memory, version or Session store');
  await assertNoDispatch(f, bindingsBefore);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const state = await f.browser(id); assert.equal(state.status, 200);
    assert.equal(state.body.conversations.find(value => value.id === id).nodeId, 'N1');
    assert.equal((await f.browser(id, { body: { id: `focused-followup-${restart}`, text: 'followup' } })).status, 202);
    await f.wait(id, value => value.status === 'waiting-for-user' && !value.activeTurnId);
    assert.ok(f.modelCalls.at(-1).system.includes('MOUNT-FOCUS-UNIQUE-MEMORY'), '后续轮次从固定上下文复用已确认节点正文');
    assert.equal(JSON.stringify(f.modelCalls.at(-1)).split('MOUNT-FOCUS-UNIQUE-MEMORY').length - 1, 1);
  }
});

test('Automatic mount rejects an out-of-scope node without saving focus or changing Main', async t => {
  const f = await fixture(t, { nodeIds: ['N1'], childNodes: [{ id: 'N1', title: 'Allowed', kind: 'module', state: 'dirty', owns: [], children: [] }] });
  const chat = await f.browser('main', { suffix: '/conversations/new', body: { id: 'restricted-auto-chat' } });
  assert.equal(chat.status, 201); const id = chat.body.id, before = await f.main();
  assert.equal((await f.browser(id, { body: { id: 'restricted-mount', text: 'mount-bug' } })).status, 202);
  const final = await f.wait(id, state => ['waiting-for-user', 'error'].includes(state.status) && state.messages.length > 1);
  assert.equal(final.conversations.find(value => value.id === id).nodeId, undefined);
  assert.deepEqual(await f.main(), before); await assertNoDispatch(f);
});

test('Manual 新 Bug 先确认主节点，再审批 brief；不写 TODO 或创建执行 Session', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-mounted-bug');
  const before = await f.main();
  const mounted = await f.gateway('conversation.submit', { text: 'mount-bug' }, { id: 'mount-bug-message', conversationId: conversation });
  assert.equal(mounted.status, 200, JSON.stringify(mounted.body));
  const settled = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  assert.equal(settled.conversationId, conversation); assert.equal(settled.executionMode, 'manual');
  const main = await f.main();
  assert.equal(main.revision, before.revision);
  assert.equal(main.main.memory.map.root.bugs.length, 1);
  assert.equal(main.main.memory.map.root.bugs[0].id, 'B1');
  assert.equal(main.main.memory.map.root.todos.length, 1);
  assert.equal(settled.focus.nodeId, null, '建议阶段未绑定');
  const natural = await f.gateway('conversation.submit', { text: '同意绑定' }, { id: 'confirm-bug-natural', conversationId: conversation });
  assert.equal(natural.status, 200, JSON.stringify(natural.body));
  const confirmed = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId && value.focus.nodeId === 'T0');
  const focus = confirmed.conversations.find(item => item.id === conversation);
  assert.equal(focus.nodeId, 'T0'); assert.equal(focus.kind, 'bug'); assert.equal(focus.itemId, undefined);
  await assertNoDispatch(f);
  await f.restart();
  const restored = (await f.browser(conversation)).body.conversations.find(item => item.id === conversation);
  assert.equal(restored.itemId, undefined); assert.equal(restored.kind, 'bug'); assert.equal(restored.nodeId, 'T0'); assert.equal(restored.executionMode, 'manual');
  const proposal = await prepared(f, conversation, 'prepare-new-bug', 'prepare-mounted-bug-message');
  assert.equal(proposal.kind, 'bug'); assert.equal(proposal.nodeId, 'T0'); assert.notEqual(proposal.itemId, 'B1');
  const approved = await f.gateway('brief.review', { proposalId: proposal.id, version: proposal.version,
    decision: 'approved', reason: 'Approve the brief after mount' }, { id: 'approve-mounted-bug', conversationId: conversation });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.itemId, proposal.itemId); assert.equal(approved.body.data.kind, 'bug');
  const after = (await f.main()).main.memory.map.root;
  assert.equal(after.bugs.length, 2); assert.equal(after.bugs[0].id, 'B1'); assert.equal(after.bugs[0].createdAt, 'original-bug');
  assert.equal(after.todos.length, 1);
  assert.equal(after.bugs.find(item => item.id === proposal.itemId).executionMode, 'manual');
  await assertNoDispatch(f);
});

test('Brief confirmation while Coordinator is busy survives restart and notifies exactly once with a persisted acknowledgement', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-busy-review');
  const proposal = await prepared(f, conversation, 'prepare-new', 'prepare-busy-review');
  const started = await f.gateway('conversation.submit', { text: 'hold-busy-turn' }, { id: 'held-turn', conversationId: conversation });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await f.wait(conversation, value => value.activeTurnId === 'held-turn' && value.status === 'running');
  const approved = await f.gateway('brief.review', { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: 'Approve while another turn is in progress' },
    { id: 'approve-while-busy', conversationId: conversation });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.data.notification.pending, true);
  const reviewFile = path.join(f.directory, 'manual-briefs', projectId, 'manual-briefs.json');
  assert.equal((await readJSON(reviewFile)).proposals[proposal.id].review.notified, undefined, 'Pending notification must remain recoverable');
  assert.ok((await f.main()).main.memory.map.root.todos.find(item => item.id === proposal.itemId), 'Approval commits Main even when Coordinator is busy');
  await f.restart();
  const notified = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId &&
    value.approvals.find(item => item.id === proposal.id)?.review?.notified === true);
  const receiptMessages = notified.messages.filter(message => message.role === 'user' && message.source === 'workflow' && message.text.includes(proposal.id));
  assert.equal(receiptMessages.length, 1); assert.ok(receiptMessages[0].requestId.startsWith('manual-review-'));
  assert.equal((await readJSON(reviewFile)).proposals[proposal.id].review.notified, true);
  const revision = (await f.main()).revision;
  await f.restart();
  const after = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId);
  const replayMessages = after.messages.filter(message => message.role === 'user' && message.source === 'workflow' && message.text.includes(proposal.id));
  assert.equal(replayMessages.length, 1); assert.equal(replayMessages[0].requestId, receiptMessages[0].requestId);
  assert.equal((await f.main()).revision, revision); await assertNoDispatch(f);
});

test('Long exported execution prompt does not exceed workflow input limits or leak into every approval snapshot', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-long-prompt');
  const initial = await f.main(), sentinel = 'LONG-MEMORY-CONTENT-FOR-EXPORT';
  const memoryDocument = `${sentinel}\n${'Precise module knowledge. '.repeat(420)}`;
  assert.ok(memoryDocument.length > 8000 && memoryDocument.length < 12000);
  const changed = await f.gateway('map.write', { baseVersion: initial.main.version,
    operations: [{ type: 'update', id: 'T0', fields: { purpose: memoryDocument } }] }, { id: 'write-long-node-context' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const proposal = await prepared(f, conversation, 'prepare-new', 'prepare-long-prompt');
  const approved = await f.gateway('brief.review', { proposalId: proposal.id, version: proposal.version, decision: 'approved', reason: 'Approve the exact long-context task' },
    { id: 'approve-long-prompt', conversationId: conversation });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.ok(approved.body.data.prompt.length > 8000);
  assert.match(approved.body.data.prompt, new RegExp(sentinel)); assert.equal(approved.body.data.notification.pending, false);
  const state = await f.wait(conversation, value => value.status === 'waiting-for-user' && !value.activeTurnId &&
    value.approvals.find(item => item.id === proposal.id)?.review?.notified === true);
  const approval = state.approvals.find(item => item.id === proposal.id);
  assert.equal(approval.review.result.prompt, undefined);
  assert.ok(approval.pathText.length < 500, '主节点描述摘要不能复制长正文');
  const workflow = state.messages.filter(message => message.role === 'user' && message.source === 'workflow' && message.text.includes(proposal.id));
  assert.equal(workflow.length, 1); assert.ok(workflow[0].text.length < 8000); assert.doesNotMatch(workflow[0].text, new RegExp(sentinel));
  const exported = await f.gateway('prompt.read', { proposalId: proposal.id }, { conversationId: conversation });
  assert.equal(exported.status, 200); assert.equal(exported.body.data.text, approved.body.data.prompt); await assertNoDispatch(f);
});

test('Slack map array writes require explicit manual mode for new items, preserve old items and replay idempotently', async t => {
  const f = await fixture(t), before = await f.main(), old = before.main.memory.map.root.todos[0];
  const missingMode = await f.gateway('map.write', { baseVersion: before.main.version,
    operations: [{ type: 'update', id: 'T0', fields: { todos: [old, { id: 'TD-missing-mode', title: 'Missing manual marker', status: 'pending' }] } }] }, { id: 'missing-mode-map-write' });
  assert.equal(missingMode.status, 400, JSON.stringify(missingMode.body)); assert.equal(missingMode.body.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual((await f.main()).main.memory.map, before.main.memory.map); assert.equal((await f.main()).revision, before.revision);
  const payload = { baseVersion: before.main.version,
    operations: [{ type: 'update', id: 'T0', fields: { todos: [old, { id: 'TD-new-slack', title: 'New Slack requirement', status: 'pending', executionMode: 'manual' }] } }] };
  const result = await f.gateway('map.write', payload, { id: 'array-map-write' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const after = await f.main(), todos = after.main.memory.map.root.todos;
  assert.deepEqual(todos.find(item => item.id === old.id), old, 'Sending a whole editor array cannot take over unrelated preexisting items');
  assert.equal(todos.find(item => item.id === 'TD-new-slack').executionMode, 'manual');
  assert.deepEqual((await f.gateway('map.write', payload, { id: 'array-map-write' })).body, result.body);
  assert.equal((await f.main()).revision, after.revision); assert.equal((await f.main()).main.memory.map.root.todos.length, 2);
  assert.equal((await f.gateway('map.write', { baseVersion: before.main.version,
    operations: [{ type: 'update', id: 'T0', fields: { todos: [] } }] }, { id: 'stale-array-map-write' })).body.error.code, 'VERSION_CONFLICT');
});

test('Slack validates direct Bug operations and retains manual markers before committing Main', async t => {
  const f = await fixture(t), before = await f.main();
  const bug = { id: 'B99999', title: 'Slack Bug', status: 'open' };
  const invalid = [
    { type: 'attach-bug', id: 'T0', bug },
    { type: 'attach-bug', id: 'T0', bug: { ...bug, executionMode: 'automatic' } },
    { type: 'attach-bug', bug },
    { type: 'recover-bug', id: 'T0', bug },
    { type: 'document', fields: { unassigned_bugs: [bug] } },
    { type: 'create', parentId: 'T0', node: { id: 'N1', title: 'New node', kind: 'module', state: 'dirty', owns: [], bugs: [bug] } },
  ];
  for (const [index, operation] of invalid.entries()) {
    const result = await f.gateway('map.write', { baseVersion: before.main.version, operations: [operation] }, { id: `invalid-direct-bug-${index}` });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(await f.main(), before, 'Rejected operations must not change Main, receipts or events');
  }
  const manualBug = { ...bug, executionMode: 'manual' };
  const payload = { baseVersion: before.main.version, operations: [{ type: 'attach-bug', id: 'T0', bug: manualBug }] };
  const attached = await f.gateway('map.write', payload, { id: 'manual-direct-bug' });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const after = await f.main();
  assert.deepEqual(after.main.memory.map.root.bugs.find(item => item.id === bug.id), manualBug);
  assert.deepEqual((await f.gateway('map.write', payload, { id: 'manual-direct-bug' })).body, attached.body);
  assert.deepEqual(await f.main(), after);
  const intake = new CoordinatorMapIntake({ directory: path.join(f.directory, 'manual-bug-intake'), read: f.main,
    service: { submit: async () => assert.fail('Slack work must not enter automatic intake') } });
  assert.equal(intake.items(after.main.memory.map.root).some(entry => entry.item.id === bug.id), false);
  for (const executionMode of [undefined, 'automatic']) {
    const bugs = after.main.memory.map.root.bugs.map(item => item.id === bug.id ? { ...item, executionMode } : item);
    const result = await f.gateway('map.write', { baseVersion: after.main.version,
      operations: [{ type: 'update', id: 'T0', fields: { bugs } }] }, { id: `strip-marker-${executionMode || 'missing'}` });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(await f.main(), after);
  }
  const recovery = await f.gateway('map.write', { baseVersion: after.main.version,
    operations: [{ type: 'recover-bug', id: 'T0', bug: manualBug }] }, { id: 'manual-recovery-still-forbidden' });
  assert.equal(recovery.status, 403);
  assert.equal(recovery.body.error.code, 'FORBIDDEN_RECOVERY');
});

test('A legacy unassigned Bug cannot bypass the marker check on a node without a Bug array', async t => {
  const bug = { id: 'B7777', title: 'Existing unassigned Bug', status: 'open' };
  const f = await fixture(t, { initialMap: { project: 'Fixture', root: {
    id: 'T0', title: 'Legacy node', kind: 'module', state: 'dirty', owns: [], children: [],
  }, unassigned_bugs: [bug] } });
  const before = await f.main();
  const rejected = await f.gateway('map.write', { baseVersion: before.main.version,
    operations: [{ type: 'attach-bug', id: 'T0', bug }] }, { id: 'shadow-unassigned-bug' });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.deepEqual(await f.main(), before);
  const unchanged = await f.gateway('map.write', { baseVersion: before.main.version,
    operations: [{ type: 'attach-bug', bug }] }, { id: 'unchanged-unassigned-bug' });
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  assert.deepEqual((await f.main()).main.memory.map.unassigned_bugs, [bug]);
});

test('Coordinator attachments are shared with authenticated browser and isolated by project without Quark', async t => {
  const f = await fixture(t), uploaded = await f.gateway('attachment.upload', { filename: 'screenshot.png', mimeType: 'image/png', base64: png }, { id: 'upload-screenshot' });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); const attachment = uploaded.body.data;
  assert.equal(attachment.hash, hash(Buffer.from(png, 'base64'))); assert.equal(attachment.base64, undefined);
  const pathFor = id => `${f.cloud.url}/api/workbench/projects/${id}/api/coordinator/attachments/${attachment.id}`;
  const unauthorized = await fetch(pathFor(projectId)); assert.equal(unauthorized.status, 401);
  const response = await fetch(pathFor(projectId), { headers });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
  const wrongProject = await fetch(pathFor(otherProjectId), { headers }); assert.equal(wrongProject.status, 404);
  assert.equal((await f.gateway('attachment.read', { id: attachment.id }, { project: otherProjectId })).status, 404);
  assert.equal((await f.gateway('attachment.read', { id: attachment.id })).body.data.base64, png);
});

test('Closing Cloud closes integration subscriptions and listener with no surviving HTTP endpoint', async t => {
  const f = await fixture(t), conversation = await f.newConversation('create-close');
  const listener = f.cloud.integrationUrl;
  const query = new URLSearchParams({ teamId, userId, projectId, conversationId: conversation });
  const events = await fetch(`${listener}/v1/events?${query}`, { headers: { Authorization: `Bearer ${integrationCredential}` } });
  assert.equal(events.status, 200); const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  await f.cloud.close();
  assert.equal((await reader.read()).done, true);
  await assert.rejects(fetch(listener + '/v1/command'), /fetch failed/);
});
