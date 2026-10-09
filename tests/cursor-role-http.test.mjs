import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { cursorTemplateWorktree } from '../scripts/cloud/cursor-role-factory.mjs';
import { CursorGitProof } from '../scripts/cloud/cursor-git-proof.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { INTEGRATION_COMMANDS } from '../scripts/cloud/integration-gateway.mjs';
import { SlackPlugin } from '../plugins/slack/src/plugin.mjs';
import { Store, threadKey } from '../plugins/slack/src/store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const templateId = '11111111-1111-4111-8111-111111111111';
const sourceSha = 'a'.repeat(40), taskId = 'http-task';
const handoffSha = 'b'.repeat(40);
const ciPolicy = { checks: [{ todoId: 'CI-1', testId: 'fixed-formal-test', argv: ['node', '--test', '--test-reporter=tap', 'tests/fixture.mjs'],
  name: 'Formal tests', appId: 15368, workflowPath: '.github/workflows/ci.yml', workflowBlobSha: 'd'.repeat(40), testStep: 'Run formal tests' }] };

// Real loopback HTTP, Coordinator tools, scheduler, ProtocolStore and MCP.
// Both vendor models are controlled dependencies: this is not native acceptance.
async function fixture(t, { enabled = true, mismatchedRepository = false, mixed = false, trustedCi = false, slack = false, cursorExecution = true, enableAction = true, holdModel = false, manualItem = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-role-http-'));
  let cloud;
  let releaseModel; const heldModel = new Promise(resolve => { releaseModel = resolve; });
  let enteredModel = false;
  t.after(async () => { releaseModel(); await cloud?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const apiKeyFile = path.join(directory, 'key'), cursorConfigFile = path.join(directory, 'cursor.json');
  const providerFile = path.join(directory, 'model.json');
  await fs.writeFile(apiKeyFile, 'synthetic-only', { mode: 0o600 });
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://model.invalid', model: 'synthetic', token: 'synthetic-only' }));
  await fs.writeFile(cursorConfigFile, JSON.stringify({ projects: { 'context-guard': {
    apiKeyFile, repositoryUrl: mismatchedRepository ? 'https://github.com/other/repo' : 'https://github.com/example/repo',
    startingRef: sourceSha, roles: { templateSessionId: templateId, ...(trustedCi ? { ciPolicy } : {}) },
  } } }), { mode: 0o600 });
  const config = { enabled, providerFile, bindings: { [templateId]: cursorTemplateWorktree(templateId) },
    sessionTemplates: [templateId], maxConcurrentTasks: 1 };
  if (mixed) { config.bindings['local-template'] = 'local-tree'; config.sessionTemplates.unshift('local-template'); }
  const memoryConfig = { dataDir: path.join(directory, 'memory'), adminToken: 'synthetic-admin', projects: {
    'context-guard': { root: directory, token: 'synthetic-memory', ref: 'refs/heads/main', coordinator: config },
  } };
  const memoryFile = path.join(memoryConfig.dataDir, digest('context-guard'), 'memory.json');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'main-1', memory: { records: {}, map: {
    v: 1, bootstrap: 'ready', root: { id: 'T0', title: 'Synthetic project', kind: 'module', state: 'dirty', owns: [], children: [],
      ...(manualItem ? { todos: [{ id: 'TD1', title: 'Synthetic manual item', status: 'pending' }] } : {}) },
  } } }, sessions: {}, receipts: {}, history: [], events: [], eventCursors: {}, closedSessions: {} }));
  const commands = [{ name: 'prepare_task', input: { taskId, text: 'Implement one isolated fixture', acceptance: 'Formal assertion passes', nodeIds: ['T0'], mainVersion: 'main-1' } }];
  const nativeCalls = [], gitCalls = [], runs = new Map(); let count = 0;
  const provider = {
    create: async input => { nativeCalls.push({ method: 'create', input }); const run = { id: 'native-' + ++count, agentId: input.agentId, status: 'FINISHED' };
      runs.set(input.agentId, run); return { agent: { id: input.agentId }, run }; },
    followUp: async (agentId, text, options) => { nativeCalls.push({ method: 'followUp', agentId, text, options });
      const run = { id: 'native-' + ++count, agentId, status: 'FINISHED' }; runs.set(agentId, run); return run; },
    getRun: async (agentId, runId) => { const run = runs.get(agentId); assert.equal(run.id, runId);
      return { ...run, git: { branches: [{ repoUrl: 'https://github.com/example/repo', branch: 'cursor/http-task' }] } }; },
    getAgent: async agentId => ({ id: agentId, latestRunId: runs.get(agentId)?.id }),
    readRunEvents: async (agentId, runId) => {
      // Only read this isolated server's one reserved Tester. The tool stream
      // is a controlled vendor boundary, not an actual Cursor execution.
      const testers = path.join(directory, 'cursor-roles', digest('context-guard'), 'testers');
      const files = await fs.readdir(testers); assert.equal(files.length, 1);
      const actor = JSON.parse(await fs.readFile(path.join(testers, files[0]), 'utf8'));
      assert.equal(actor.nativeAgentId, agentId); assert.equal(actor.invocations.at(-1).runId, runId);
      return { agentId, runId, complete: true, events: [...actor.commands.map((spec, index) => ({ event: 'tool_call', data: {
        callId: 'http-command-' + index, name: 'run_terminal_cmd', status: 'completed', args: { command: spec.command },
        result: { isBackground: false, success: { command: spec.command, stdout: 'CG_CURSOR_PROOF ' + JSON.stringify({
          format: 1, nonce: spec.nonce, sourceSha: handoffSha, argv: spec.argv,
          before: { sha: handoffSha, clean: true }, after: { sha: handoffSha, clean: true },
          exitCode: 0, signal: null, spawnError: null,
          stdout: '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', stderr: '',
        }) + '\n' } },
      } })), { event: 'result', data: { runId, status: 'FINISHED' } }] };
    },
  };
  const integrationConfig = slack ? { host: '127.0.0.1', port: 0, token: 'synthetic-slack-integration-credential', teamId: 'TTEST', projectIds: ['context-guard'],
    ...(enableAction ? { actions: [...INTEGRATION_COMMANDS] } : {}), ...(cursorExecution ? { cursorExecution: { 'context-guard': { templateSessionId: templateId, userIds: ['UTEST'] } } } : {}) } : undefined;
  cloud = await startCloudServer({ dataDir: directory, port: 0, publicOrigin: 'https://roles.example', browserToken: 'synthetic-human', memoryConfig, cursorConfigFile,
    ...(integrationConfig ? { integrationConfig } : {}),
    browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
    protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/repo' }] },
    cursorProviderFactory: () => provider,
    cursorGitProofFactory: config => new CursorGitProof({ ...config, fetch: async (url, options) => {
      assert.equal(options.method || 'GET', 'GET'); assert.equal(options.redirect, 'error');
      assert.ok(url.startsWith('https://api.github.com/repos/example/repo/'));
      gitCalls.push(url);
      const check = { id: 71, name: 'Formal tests', app: { id: 15368 }, head_sha: handoffSha, check_suite: { id: 81 }, status: 'completed', conclusion: 'success' };
      const run = { id: 91, check_suite_id: 81, head_sha: handoffSha, head_branch: 'cursor/http-task', event: 'push',
        path: '.github/workflows/ci.yml', run_attempt: 1, status: 'completed', conclusion: 'success',
        repository: { full_name: 'example/repo' }, head_repository: { full_name: 'example/repo' } };
      const job = { id: 101, name: check.name, run_id: run.id, head_sha: handoffSha, run_attempt: 1, status: 'completed', conclusion: 'success',
        check_run_url: 'https://api.github.com/repos/example/repo/check-runs/71', steps: [{ name: 'Run formal tests', status: 'completed', conclusion: 'success' }] };
      const value = url.includes('/check-runs?') ? { total_count: 1, check_runs: [check] }
        : url.includes('/actions/runs?') ? { total_count: 1, workflow_runs: [run] }
          : url.includes('/contents/') ? { type: 'file', path: run.path, sha: 'd'.repeat(40), size: 100 }
            : url.includes('/jobs?') ? { total_count: 1, jobs: [job] }
              : url.endsWith('/actions/runs/91') ? run
                : url.includes('/branches/') ? { name: 'cursor/http-task', commit: { sha: 'b'.repeat(40) } }
        : url.includes('/compare/') ? { base_commit: { sha: sourceSha }, merge_base_commit: { sha: sourceSha }, status: 'ahead', behind_by: 0,
          total_commits: 1, commits: [{ sha: 'b'.repeat(40) }], files: [{ filename: 'src/fixture.mjs' }] }
          : { sha: 'b'.repeat(40), parents: [{ sha: sourceSha }], files: [{ filename: 'src/fixture.mjs' }] };
      return new Response(JSON.stringify(value));
    } }),
    coordinatorModelFactory: () => ({ next: async () => { enteredModel = true; if (holdModel) await heldModel; const command = commands.shift(); return command
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'model-' + ++count, ...command }] }
      : { stop: 'end_turn', content: [{ type: 'text', text: 'Synthetic Coordinator response' }] }; } }),
  });
  const store = new ProtocolStore(path.join(directory, 'interface-v2', digest('123')));
  const human = { repositoryId: '123', deviceId: 'browser', agentId: 'human', role: 'human' };
  const endpoint = '/api/workbench/projects/context-guard/api/coordinator';
  let slackConversationId;
  const request = async (route, input, headers = { Authorization: 'Bearer synthetic-human' }) => {
    if (slackConversationId && route.startsWith(endpoint)) route += `${route.includes('?') ? '&' : '?'}conversation=${encodeURIComponent(slackConversationId)}`;
    const response = await fetch(cloud.url + route, { method: input ? 'POST' : 'GET', headers: { ...headers,
      ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, input) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = slackConversationId && route === endpoint
        ? await gateway('conversation.submit', input, { conversationId: slackConversationId, id: input.id }) : await request(route, input);
      // Inbox notifications may start a turn between observing waiting and
      // POST. BUSY is a definite non-acceptance; reuse this exact request ID.
      // Accepted/unknown results are never retried or replaced.
      if (route === endpoint && result.status === 409 && result.body.error?.code === 'COORDINATOR_BUSY') {
        assert.ok(Date.now() < deadline, 'Coordinator did not release its active turn');
        const state = await request(endpoint); assert.equal(state.status, 200);
        await new Promise(resolve => setTimeout(resolve, 20)); continue;
      }
      assert.equal(result.status, route === endpoint && !slackConversationId ? 202 : 200, JSON.stringify(result.body)); return slackConversationId && route === endpoint ? result.body.data : result.body;
    }
  };
  const poll = async predicate => {
    const deadline = Date.now() + 15000;
    for (;;) { const result = await request(endpoint); assert.equal(result.status, 200, JSON.stringify(result.body));
      if (await predicate(result.body)) return result.body;
      assert.ok(Date.now() < deadline, 'Coordinator state did not advance before its deadline');
      await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  const prepare = async () => {
    if (slack) {
      const created = await gateway('conversation.create'); assert.equal(created.status, 200);
      slackConversationId = created.body.data.conversationId;
      const enabled = await gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId: slackConversationId });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    }
    await post(endpoint, { id: 'requirement', text: 'Synthetic requirement' });
    const state = await poll(value => value.approvals?.some(item => item.projectTask) && value.status === 'waiting-for-user');
    return state.approvals.find(item => item.projectTask); };
  const approve = async proposal => {
    if (!slackConversationId) return post(endpoint + '/approval', { id: 'human-approve', proposalId: proposal.id, decision: 'approved', reason: 'Synthetic explicit human approval' });
    const result = await gateway('brief.review', { proposalId: proposal.id, version: proposal.brief.version, decision: 'approved', reason: 'Synthetic explicit human approval' }, { conversationId: slackConversationId, id: 'human-approve' });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data;
  };
  const mcpRoute = '/api/workbench/projects/context-guard/api/cursor-role-mcp';
  const mcp = async (authorization, method, params, extra = {}) => {
    // Model the backend of a TLS reverse proxy, retaining its public Host.
    // Node fetch rewrites Host, so use HTTP's explicit request headers here.
    return new Promise((resolve, reject) => {
      const req = http.request(cloud.url + mcpRoute, { method: 'POST', headers: { Authorization: authorization, Host: 'roles.example',
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { try { resolve({ status: response.statusCode, body: response.statusCode === 202 ? null : JSON.parse(Buffer.concat(chunks)) }); } catch (cause) { reject(cause); } });
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: 'rpc-' + ++count }), method, params }));
    });
  };
  const openMcp = async authorization => {
    const initialized = await mcp(authorization, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
    assert.equal((await mcp(authorization, 'notifications/initialized')).status, 202);
  };
  const call = async (authorization, name, args) => (await mcp(authorization, 'tools/call', { name, arguments: args })).body.result;
  const context = async authorization => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const result = await call(authorization, 'context_guard_context', {});
      if (!result.isError) { assert.ok(result.structuredContent); return result.structuredContent; }
      assert.equal(JSON.parse(result.content[0].text).error.code, 'ROLE_UNAVAILABLE');
      assert.ok(Date.now() < deadline, 'Confirmed native delegation was not activated');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const gateway = async (type, payload = {}, { conversationId, userId = 'UTEST', id = 'slack-' + type.replaceAll('.', '-') } = {}) => {
    const response = await fetch(cloud.integrationUrl + '/v1/command', { method: 'POST', headers: { Authorization: 'Bearer synthetic-slack-integration-credential', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, teamId: 'TTEST', userId, projectId: 'context-guard', ...(conversationId ? { conversationId } : {}), type, payload }) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, store, human, nativeCalls, gitCalls, commands, config, integrationConfig, gateway, endpoint, request, post, poll, prepare, approve, mcp, openMcp, call, context, memoryFile,
    releaseModel, modelEntered: () => enteredModel,
    url: cloud.url, integrationUrl: cloud.integrationUrl };
}

test('Slack Cursor opt-in preserves the original conversation and original human-approved task', async t => {
  const f = await fixture(t, { slack: true, mixed: true });
  const created = await f.gateway('conversation.create'); assert.equal(created.status, 200, JSON.stringify(created.body));
  const conversationId = created.body.data.conversationId;
  const before = await f.gateway('conversation.state', {}, { conversationId });
  assert.equal(before.body.data.executionMode, 'manual'); assert.equal(f.nativeCalls.length, 0);
  const enabled = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.data.conversationId, conversationId); assert.equal(enabled.body.data.executionMode, 'automatic');
  assert.equal(f.nativeCalls.length, 0, 'Enabling the host is not brief approval or a paid model request');
  const submitted = await f.gateway('conversation.submit', { text: 'Prepare a Cursor task in this same conversation' }, { conversationId });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  let state;
  const deadline = Date.now() + 5000;
  for (;;) {
    const response = await f.gateway('conversation.state', {}, { conversationId }); assert.equal(response.status, 200, JSON.stringify(response.body));
    state = response.body.data;
    if (state.status === 'waiting-for-user' && state.approvals.some(value => value.projectTask)) break;
    assert.ok(Date.now() < deadline, 'Original Slack conversation never received its brief'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  const proposal = state.approvals.find(value => value.projectTask);
  assert.equal(f.nativeCalls.length, 0); assert.equal((await f.store.projectTasks(f.human))[0].conversationId, conversationId);
  const wrong = await f.gateway('brief.review', { proposalId: proposal.id, version: 'stale', decision: 'approved' }, { conversationId, id: 'wrong-brief' });
  assert.equal(wrong.status, 409); assert.equal(f.nativeCalls.length, 0);
  const approved = await f.gateway('brief.review', { proposalId: proposal.id, version: proposal.brief.version, decision: 'approved', reason: 'Synthetic human confirmation' }, { conversationId });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await f.poll(() => f.nativeCalls.length === 1);
  const task = (await f.store.projectTasks(f.human))[0];
  assert.equal(task.conversationId, conversationId); assert.equal(task.templateSessionId, templateId);
  assert.equal(task.reviewIssuer.agentId, 'slack:TTEST:UTEST'); assert.equal(task.reviewIssuer.role, 'human');
  assert.equal(f.nativeCalls[0].input.mode, 'plan');
  const original = await f.gateway('conversation.state', {}, { conversationId });
  assert.equal(original.status, 200); assert.equal(original.body.data.projectTasks[0].taskId, taskId);
  assert.equal(original.body.data.approvals.find(value => value.id === proposal.id).pending, false);
});

test('Slack Cursor enable is closed by default and rejects other operators or repository mismatches', async t => {
  for (const options of [{ enableAction: false }, { cursorExecution: false }, { mismatchedRepository: true }, { userId: 'UOTHER' }]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, { slack: true, ...options }), created = await f.gateway('conversation.create');
    assert.equal(created.status, 200); const conversationId = created.body.data.conversationId;
    const result = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId, ...(options.userId ? { userId: options.userId } : {}) });
    assert.equal(result.status, 403, JSON.stringify(result.body)); assert.equal(result.body.error.code, 'FORBIDDEN');
    assert.equal((await f.gateway('conversation.state', {}, { conversationId })).body.data.executionMode, 'manual');
    assert.equal(f.nativeCalls.length, 0); assert.deepEqual(await f.store.projectTasks(f.human), []);
  });
});

test('Slack Cursor grant replay, state and events revalidate the current operator configuration', async t => {
  const f = await fixture(t, { slack: true }), created = await f.gateway('conversation.create');
  const conversationId = created.body.data.conversationId, options = { conversationId, id: 'stable-enable' };
  const enabled = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, options); assert.equal(enabled.status, 200);
  assert.deepEqual((await f.gateway('conversation.cursor', { expectedMode: 'manual' }, options)).body, enabled.body);
  const bound = await f.gateway('conversation.bind', { conversationId }, { id: 'bind-enabled' });
  assert.equal(bound.status, 200); assert.equal(bound.body.data.executionMode, 'automatic', 'Binding cannot silently remove Cursor authority');
  f.integrationConfig.cursorExecution['context-guard'].userIds = ['UOTHER'];
  assert.equal((await f.gateway('conversation.cursor', { expectedMode: 'manual' }, options)).status, 403, 'A cached enable receipt cannot survive revocation');
  assert.equal((await f.gateway('conversation.state', {}, { conversationId })).status, 403);
  assert.equal((await f.gateway('conversation.submit', { text: 'Do not run' }, { conversationId })).status, 403);
  const events = await fetch(f.integrationUrl + '/v1/events?' + new URLSearchParams({ teamId: 'TTEST', userId: 'UTEST', projectId: 'context-guard', conversationId }),
    { headers: { Authorization: 'Bearer synthetic-slack-integration-credential' } });
  assert.equal(events.status, 403); await events.body.cancel();
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.modelEntered(), false);
});

test('Slack Cursor controls reuse the original thread, exact brief approval and result cards through real HTTP', async t => {
  const f = await fixture(t, { slack: true }), created = await f.gateway('conversation.create');
  const conversationId = created.body.data.conversationId, store = await new Store(path.join(f.directory, 'slack-plugin')).open();
  const key = threadKey('TTEST', 'CTEST', '1.0'), posts = [];
  await store.bind(key, { projectId: 'context-guard', conversationId, channel: 'CTEST', threadTs: '1.0', userId: 'UTEST', ownRequests: [] });
  const plugin = new SlackPlugin({ store, teamId: 'TTEST', cloudOrigin: 'https://roles.example', botUserId: 'UBOT',
    gateway: { command: async (type, input) => {
      const response = await f.gateway(type, input.payload, { conversationId: input.conversationId, userId: input.userId, id: input.id });
      assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
    } }, io: { post: async input => { posts.push(input); return String(posts.length + 10); }, update: async (channel, ts, text, blocks) => { posts.push({ channel, ts, text, blocks, update: true }); } },
    logger: { warn(){}, error(){} } });
  t.after(() => plugin.stop());
  await plugin.mirror(key);
  const enable = posts.flatMap(item => item.blocks || []).flatMap(block => block.elements || []).find(value => value.action_id === 'enable_cursor');
  assert.ok(enable); assert.match(enable.text.text, /当前对话/); assert.equal(f.nativeCalls.length, 0);
  await plugin.process('cursor-button', { type: 'interactive', body: { user: { id: 'UTEST' }, actions: [{ action_id: 'enable_cursor', value: enable.value }] } });
  assert.equal(store.data.threads[key].conversationId, conversationId); assert.equal(f.nativeCalls.length, 0);
  const submitted = await f.gateway('conversation.submit', { text: 'Prepare the original task' }, { conversationId }); assert.equal(submitted.status, 200);
  const deadline = Date.now() + 5000; let state;
  for (;;) {
    state = (await f.gateway('conversation.state', {}, { conversationId })).body.data;
    if (state.status === 'waiting-for-user' && !state.activeTurnId && state.approvals.some(item => item.projectTask)) break;
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
  }
  await plugin.mirror(key);
  const approve = posts.flatMap(item => item.blocks || []).flatMap(block => block.elements || []).find(value => value.action_id === 'approve_brief');
  assert.ok(approve); assert.equal(approve.text.text, '确认并交给 Cursor');
  assert.equal(JSON.parse(approve.value).version, state.approvals.find(item => item.projectTask).brief.version);
  await plugin.process('approve-original-brief', { type: 'interactive', body: { user: { id: 'UTEST' }, actions: [{ action_id: 'approve_brief', value: approve.value }] } });
  await f.poll(() => f.nativeCalls.length === 1); await plugin.mirror(key);
  assert.ok(posts.some(item => item.text?.includes('已进入 Cursor 执行队列')));
  assert.equal(posts.some(item => JSON.stringify(item.blocks || []).includes('export_prompt')), false);
  assert.equal(posts.filter(item => !item.update).every(item => item.channel === 'CTEST' && item.threadTs === '1.0'), true);
  assert.equal(store.data.threads[key].conversationId, conversationId);
});

test('Slack Cursor mode change rejects a live original model turn and preserves its receipt', async t => {
  const f = await fixture(t, { slack: true, holdModel: true }), created = await f.gateway('conversation.create');
  const conversationId = created.body.data.conversationId;
  assert.equal((await f.gateway('conversation.submit', { text: 'Original pending input' }, { conversationId })).status, 200);
  const deadline = Date.now() + 3000;
  while (!f.modelEntered()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  const enabled = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId });
  assert.equal(enabled.status, 409); assert.equal(enabled.body.error.code, 'COORDINATOR_BUSY');
  const state = (await f.gateway('conversation.state', {}, { conversationId })).body.data;
  assert.equal(state.executionMode, 'manual'); assert.equal(state.status, 'running');
  assert.ok(state.messages.some(value => value.role === 'user' && value.text.includes('Original pending input')));
  assert.equal(f.nativeCalls.length, 0); f.releaseModel();
});

test('Slack Cursor mode change rejects an old registry read arriving after cache retirement', async t => {
  const f = await fixture(t, { slack: true }), created = await f.gateway('conversation.create');
  assert.equal(created.status, 200); const conversationId = created.body.data.conversationId;
  const registryFile = path.join(f.directory, 'coordinators', 'context-guard', 'conversations.json');
  const originalRead = fs.readFile;
  let captured = false, releaseRead;
  const heldRead = new Promise(resolve => { releaseRead = resolve; });
  // Hold only this test's first real registry snapshot, after the file has
  // been read. The original HTTP request now carries the old manual revision.
  fs.readFile = async function(file, ...args) {
    const value = await originalRead.call(this, file, ...args);
    if (file === registryFile && !captured) { captured = true; await heldRead; }
    return value;
  };
  t.after(() => { releaseRead(); fs.readFile = originalRead; });
  const late = f.request(f.endpoint + '?conversation=' + encodeURIComponent(conversationId));
  try {
    const deadline = Date.now() + 3000;
    while (!captured) { assert.ok(Date.now() < deadline, 'The original registry read was not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const enabled = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  } finally { releaseRead(); }
  const stale = await late;
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'COORDINATOR_BUSY');
  fs.readFile = originalRead;
  const state = await f.gateway('conversation.state', {}, { conversationId });
  assert.equal(state.status, 200); assert.equal(state.body.data.executionMode, 'automatic');
  assert.equal((await f.gateway('conversation.submit', { text: 'Use the current Cursor host' }, { conversationId })).status, 200);
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = await f.gateway('conversation.state', {}, { conversationId }); assert.equal(current.status, 200);
    if (current.body.data.status === 'waiting-for-user' && current.body.data.approvals.some(item => item.projectTask)) break;
    assert.notEqual(current.body.data.status, 'error', JSON.stringify(current.body.data.error));
    assert.ok(Date.now() < deadline, 'A stale initializer poisoned the current service'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.nativeCalls.length, 0, 'Changing hosts never approves the new brief');
});

test('Slack Cursor pending manual approval cannot become execution authority after enabling', async t => {
  const f = await fixture(t, { slack: true, manualItem: true });
  // Manual preparation requires a real existing item or an independently
  // confirmed node binding. Seed it before starting Cloud, not by a partial
  // write racing its background reader; keep the original business gate.
  Object.assign(f.commands[0].input, { itemId: 'TD1', nodeId: 'T0', kind: 'todo' });
  const created = await f.gateway('conversation.create');
  assert.equal(created.status, 200); const conversationId = created.body.data.conversationId;
  assert.equal((await f.gateway('conversation.submit', { text: 'Prepare the original manual brief' }, { conversationId })).status, 200);
  const deadline = Date.now() + 5000; let proposal;
  for (;;) {
    const response = await f.gateway('conversation.state', {}, { conversationId }); assert.equal(response.status, 200);
    proposal = response.body.data.approvals.find(item => item.manual && item.pending);
    if (proposal && response.body.data.status === 'waiting-for-user' && !response.body.data.activeTurnId) break;
    assert.ok(Date.now() < deadline, 'The original manual brief was not prepared'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  const enabled = await f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId });
  assert.equal(enabled.status, 409); assert.equal(enabled.body.error.code, 'CONFLICT');
  const state = await f.gateway('conversation.state', {}, { conversationId }); assert.equal(state.status, 200);
  assert.equal(state.body.data.executionMode, 'manual');
  assert.equal(state.body.data.approvals.find(item => item.id === proposal.id).pending, true);
  assert.equal(f.nativeCalls.length, 0); assert.deepEqual(await f.store.projectTasks(f.human), []);
});

test('Slack Cursor concurrent enable operations preserve one grant and the original conversation', async t => {
  const f = await fixture(t, { slack: true }), created = await f.gateway('conversation.create');
  assert.equal(created.status, 200); const conversationId = created.body.data.conversationId;
  const results = await Promise.all(['enable-first', 'enable-second'].map(id => f.gateway('conversation.cursor', { expectedMode: 'manual' }, { conversationId, id })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200);
  assert.equal(winner.body.data.conversationId, conversationId);
  const state = await f.gateway('conversation.state', {}, { conversationId }); assert.equal(state.status, 200);
  assert.equal(state.body.data.executionMode, 'automatic'); assert.equal(f.nativeCalls.length, 0);
  const registry = JSON.parse(await fs.readFile(path.join(f.directory, 'coordinators', 'context-guard', 'conversations.json'), 'utf8'));
  assert.equal(Object.keys(registry.chats).length, 1);
  assert.ok(['enable-first', 'enable-second'].includes(registry.chats[conversationId].cursorExecution.operationId));
});

for (const slack of [false, true]) test(slack ? 'Slack Cursor original task reaches independent CI without a second conversation' : 'Public Coordinator approval, handoff and independent MCP CI reach the original task with controlled native and Git providers', async t => {
  const f = await fixture(t, { trustedCi: true, slack }), proposal = await f.prepare();
  assert.equal(f.nativeCalls.length, 0, 'A prepared requirement never calls Cursor');
  await f.approve(proposal);
  await f.poll(state => state.projectTasks?.some(task => task.stage === 'dispatched') && f.nativeCalls.length === 1);
  const initial = f.nativeCalls[0].input;
  assert.equal(initial.mode, 'plan'); assert.equal(initial.startingRef, sourceSha);
  assert.equal(initial.mcpServers.length, 1); assert.match(initial.mcpServers[0].url, /\/api\/cursor-role-mcp$/);
  const authorization = initial.mcpServers[0].headers.Authorization;
  await f.openMcp(authorization);
  const context = await f.context(authorization);
  assert.equal(context.taskId, taskId); assert.equal(context.stage, 'assigned'); assert.notEqual(context.session.id, templateId);
  const exchange = async (id, type, payload) => f.call(authorization, 'context_guard_exchange', { id, type, payload });
  const object = await exchange('plan-object', 'object.put', { kind: 'plan', ref: context.writePrefix + 'plan', baseVersion: '',
    content: { steps: ['Implement fixture', 'Run formal test'], paths: ['src/fixture.mjs'] } });
  assert.equal(object.isError, undefined); const plan = object.structuredContent.data;
  const ready = await exchange('plan-ready', 'task.report', { taskId, stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha } });
  assert.equal(ready.isError, undefined);
  assert.equal((await f.store.taskRecord(f.human, context.session, taskId)).stage, 'plan-ready');
  const forged = await exchange('self-approve', 'review.result', { kind: 'plan', ref: plan.ref, version: plan.version, decision: 'approved', reason: 'forged' });
  assert.equal(forged.isError, true); assert.equal(f.nativeCalls.length, 1);
  await f.poll(state => state.status === 'waiting-for-user');
  f.commands.push({ name: 'review_plan', input: { executionSessionId: context.session.id, taskId, planRef: plan.ref, planVersion: plan.version,
    decision: 'approved', reason: 'Synthetic Coordinator reviewed the exact Plan' } });
  await f.post(f.endpoint, { id: 'review-next', text: 'Continue the original task review' });
  await f.poll(() => f.nativeCalls.length === 2);
  assert.equal(f.nativeCalls[1].method, 'followUp'); assert.equal(f.nativeCalls[1].agentId, initial.agentId);
  assert.equal(f.nativeCalls[1].options.mode, 'agent');
  const nextAuthorization = f.nativeCalls[1].options.mcpServers[0].headers.Authorization;
  assert.equal(nextAuthorization === authorization, false);
  assert.notEqual((await f.mcp(authorization, 'tools/list')).status, 200, 'The old Plan capability is revoked');
  await f.openMcp(nextAuthorization);
  const current = await f.context(nextAuthorization);
  assert.deepEqual(current.session, context.session); assert.equal(current.stage, 'executing'); assert.deepEqual(current.plan, { ref: plan.ref, version: plan.version });
  const unverified = await f.call(nextAuthorization, 'context_guard_exchange', { id: 'unverified-handoff', type: 'task.report',
    payload: { taskId, stage: 'handoff', data: { sourceSha: 'b'.repeat(40), ciTodoRef: current.writePrefix + 'todo', unitTestRefs: [], experienceRefs: [] } } });
  assert.equal(unverified.isError, true);
  assert.equal(JSON.parse(unverified.content[0].text).error.code, 'SOURCE_UNVERIFIED');
  assert.equal((await f.store.taskRecord(f.human, context.session, taskId)).stage, 'executing', 'FINISHED is not a verified handoff or task completion');
  const put = async (id, kind, content) => {
    const reply = await f.call(nextAuthorization, 'context_guard_exchange', { id, type: 'object.put', payload: {
      kind, ref: current.writePrefix + id, baseVersion: '', content,
    } });
    assert.equal(reply.isError, undefined); return reply.structuredContent.data;
  };
  const todo = await put('todo', 'ciTodo', { items: [{ id: 'CI-1', title: 'Independent formal check' }] });
  const unit = await put('unit', 'evidence', { synthetic: true });
  const proposed = await f.call(nextAuthorization, 'context_guard_exchange', {
    id: 'original-http-handoff', type: 'task.report', payload: { taskId, stage: 'handoff',
      data: { sourceSha: 'b'.repeat(40), ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } },
  });
  assert.equal(proposed.isError, undefined); assert.equal(proposed.structuredContent.data.state, 'proof-pending');
  await f.poll(async () => (await f.store.taskRecord(f.human, current.session, taskId)).stage === 'awaiting-ci');
  assert.equal(f.gitCalls.length, 4); assert.equal(f.nativeCalls.length, 2);
  await f.poll(state => state.status === 'waiting-for-user');
  f.commands.push({ name: 'request_ci', input: { executionSessionId: current.session.id, taskId } });
  await f.post(f.endpoint, { id: 'ci-next', text: 'Continue the independent CI routing fixture' });
  await f.poll(() => f.nativeCalls.length === 3);
  const independent = f.nativeCalls[2].input;
  assert.equal(f.nativeCalls[2].method, 'create'); assert.notEqual(independent.agentId, initial.agentId);
  assert.equal(independent.mode, 'agent'); assert.equal(independent.startingRef, 'b'.repeat(40));
  const ciAuthorization = independent.mcpServers[0].headers.Authorization;
  await f.openMcp(ciAuthorization);
  const ciContext = await f.context(ciAuthorization);
  assert.equal(ciContext.phase, 'ci'); assert.equal(ciContext.stage, 'testing'); assert.deepEqual(ciContext.session, current.session);
  assert.notEqual(ciContext.actor.id, current.actor.id); assert.equal(ciContext.sourceSha, 'b'.repeat(40));
  assert.deepEqual(ciContext.testPolicy.checks.map(({ todoId, testId, argv, machineStatus }) => ({ todoId, testId, argv, machineStatus })),
    [{ todoId: 'CI-1', testId: 'fixed-formal-test', argv: ciPolicy.checks[0].argv, machineStatus: 'passed' }]);
  assert.match(ciContext.testPolicy.checks[0].command, /CG_CURSOR_PROOF/);
  assert.equal((await f.store.taskRecord(f.human, context.session, taskId)).stage, 'testing', 'An independent FINISHED Run is not a CI verdict');
  const ciEvidence = await f.call(ciAuthorization, 'context_guard_exchange', { id: 'ci-owned-evidence', type: 'object.put', payload: {
    kind: 'evidence', ref: ciContext.writePrefix + 'evidence', baseVersion: '', content: { sourceSha: handoffSha, synthetic: true },
  } });
  assert.equal(ciEvidence.isError, undefined);
  const ciResult = await f.call(ciAuthorization, 'context_guard_exchange', { id: 'original-http-ci', type: 'ci.result', payload: {
    taskId, sourceSha: handoffSha, verdict: 'passed', checks: [{ todoId: 'CI-1', testId: 'fixed-formal-test', status: 'passed', evidenceRef: ciEvidence.structuredContent.data.ref }],
  } });
  assert.equal(ciResult.isError, undefined); assert.equal(ciResult.structuredContent.data.state, 'proof-pending');
  await f.poll(async () => (await f.store.taskRecord(f.human, current.session, taskId)).stage === 'awaiting-merge');
  const completedCi = await f.store.taskRecord(f.human, current.session, taskId);
  assert.equal(completedCi.ci.verdict, 'passed'); assert.equal(completedCi.acceptanceReview, undefined);
  assert.equal(f.nativeCalls.length, 3, 'Verification does not start a replacement model');
  assert.equal(f.gitCalls.filter(url => url.includes('/check-runs?')).length, 2, 'Exact-source workflow facts are read before and after the independent Run');
  const state = await f.store.transaction(value => value, { readOnly: true });
  assert.equal(Object.values(state.cursorRoleCiResults).length, 1);
  assert.equal(Object.values(state.queues).flatMap(queue => queue.items).filter(item => item.message.type === 'ci.result').length, 1);
  assert.equal(Object.values(state.bindings).every(binding => binding.deviceId === 'cloud-cursor:context-guard'), true);
  assert.equal((await f.store.projectTasks(f.human))[0].reviewIssuer.role, 'human');
  const legacy = await f.request('/api/workbench/projects/context-guard/api/cursor-chat');
  assert.equal(legacy.body.sessions.length, 0, 'Role execution never creates a standalone Cursor chat');
});

test('Hosted MCP cannot initialize a template through browser, unknown credential or disabled Coordinator requests', async t => {
  const f = await fixture(t, { enabled: false });
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { Cookie: 'cg_workbench=synthetic-human' }, {}]) {
    const reply = await f.mcp('Bearer cgc_' + 'x'.repeat(43), 'initialize', {}, headers);
    assert.notEqual(reply.status, 200);
  }
  assert.equal(await f.store.registeredBinding(f.human, templateId), null);
  assert.equal(f.nativeCalls.length, 0);
});

test('A hosted repository mismatch fails public approval scheduling without creating a Session or native Agent', async t => {
  const f = await fixture(t, { mismatchedRepository: true }), proposal = await f.prepare();
  await f.approve(proposal);
  const tasks = await f.store.projectTasks(f.human);
  assert.equal(tasks[0].review.decision, 'approved');
  assert.equal(tasks[0].sessionId, undefined);
  assert.equal(await f.store.registeredBinding(f.human, templateId), null);
  assert.equal(f.nativeCalls.length, 0);
});

test('Broken hosted configuration cannot block local Claude Session creation, assignment or Coordinator Plan review', async t => {
  const f = await fixture(t, { mixed: true, mismatchedRepository: true });
  const login = await fetch(f.url + '/api/v2/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    v: 2, id: 'login-local', type: 'auth.open', payload: { repository: 'https://github.com/example/repo', clientId: 'device', password: 'synthetic-password' },
  }) });
  assert.equal(login.status, 200);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.headers.get('x-context-guard-credential') };
  const send = async (id, type, payload, session) => {
    const reply = await f.request('/api/v2/messages', { v: 2, id, type, payload, ...(session ? { session } : {}) }, headers);
    assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body.data;
  };
  await send('bind-local', 'session.bind', { sessionId: 'local-template', worktreeId: 'local-tree', agentId: 'local-template', expectedBindingVersion: '' });
  await send('heartbeat-local', 'sync.heartbeat', { sessions: [{ id: 'local-template', generation: 1, ackedSeq: 0, execution: { status: 'stopped', at: new Date().toISOString() } }] });
  const proposal = await f.prepare(); await f.approve(proposal);
  const pending = await f.poll(state => state.sessionCreations?.some(item => item.state === 'pending'));
  const creation = pending.sessionCreations[0]; assert.equal(creation.templateSessionId, 'local-template');
  const registered = await send('bind-local-child', 'session.bind', { sessionId: creation.sessionId, worktreeId: 'local-child-tree', agentId: creation.sessionId, expectedBindingVersion: '' });
  await f.poll(state => state.projectTasks?.some(task => task.stage === 'dispatched'));
  const plan = await send('local-plan-object', 'object.put', { ref: 'local-plan', kind: 'plan', baseVersion: '', content: { steps: ['Synthetic local implementation'] } }, registered.session);
  await send('local-plan-ready', 'task.report', { taskId, stage: 'planReady', data: { planRef: plan.ref, planVersion: plan.version, sourceSha } }, registered.session);
  await f.poll(state => state.status === 'waiting-for-user');
  f.commands.push({ name: 'review_plan', input: { executionSessionId: creation.sessionId, taskId, planRef: plan.ref, planVersion: plan.version,
    decision: 'approved', reason: 'Synthetic local Plan review' } });
  await f.post(f.endpoint, { id: 'local-review', text: 'Review the original local task' });
  await f.poll(asyncState => asyncState.status === 'waiting-for-user');
  assert.equal((await f.store.taskRecord(f.human, registered.session, taskId)).stage, 'executing');
  assert.equal(await f.store.registeredBinding(f.human, templateId), null);
  assert.equal(f.nativeCalls.length, 0);
});
