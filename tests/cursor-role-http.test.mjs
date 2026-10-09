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
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const templateId = '11111111-1111-4111-8111-111111111111';
const sourceSha = 'a'.repeat(40), taskId = 'http-task';

// Real loopback HTTP, Coordinator tools, scheduler, ProtocolStore and MCP.
// Both vendor models are controlled dependencies: this is not native acceptance.
async function fixture(t, { enabled = true, mismatchedRepository = false, mixed = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-role-http-'));
  let cloud;
  t.after(async () => { await cloud?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const apiKeyFile = path.join(directory, 'key'), cursorConfigFile = path.join(directory, 'cursor.json');
  const providerFile = path.join(directory, 'model.json');
  await fs.writeFile(apiKeyFile, 'synthetic-only', { mode: 0o600 });
  await fs.writeFile(providerFile, JSON.stringify({ baseUrl: 'https://model.invalid', model: 'synthetic', token: 'synthetic-only' }));
  await fs.writeFile(cursorConfigFile, JSON.stringify({ projects: { 'context-guard': {
    apiKeyFile, repositoryUrl: mismatchedRepository ? 'https://github.com/other/repo' : 'https://github.com/example/repo',
    startingRef: sourceSha, roles: { templateSessionId: templateId },
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
    v: 1, bootstrap: 'ready', root: { id: 'T0', title: 'Synthetic project', kind: 'module', state: 'dirty', owns: [], children: [] },
  } } }, sessions: {}, receipts: {}, history: [], events: [], eventCursors: {}, closedSessions: {} }));
  const commands = [{ name: 'prepare_task', input: { taskId, text: 'Implement one isolated fixture', acceptance: 'Formal assertion passes', nodeIds: ['T0'], mainVersion: 'main-1' } }];
  const nativeCalls = [], runs = new Map(); let count = 0;
  const provider = {
    create: async input => { nativeCalls.push({ method: 'create', input }); const run = { id: 'native-' + ++count, agentId: input.agentId, status: 'FINISHED' };
      runs.set(input.agentId, run); return { agent: { id: input.agentId }, run }; },
    followUp: async (agentId, text, options) => { nativeCalls.push({ method: 'followUp', agentId, text, options });
      const run = { id: 'native-' + ++count, agentId, status: 'FINISHED' }; runs.set(agentId, run); return run; },
    getRun: async (agentId, runId) => { const run = runs.get(agentId); assert.equal(run.id, runId); return run; },
    getAgent: async agentId => ({ id: agentId, latestRunId: runs.get(agentId)?.id }),
  };
  cloud = await startCloudServer({ dataDir: directory, port: 0, publicOrigin: 'https://roles.example', browserToken: 'synthetic-human', memoryConfig, cursorConfigFile,
    browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
    protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'context-guard', slug: 'example/repo' }] },
    cursorProviderFactory: () => provider,
    coordinatorModelFactory: () => ({ next: async () => { const command = commands.shift(); return command
      ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'model-' + ++count, ...command }] }
      : { stop: 'end_turn', content: [{ type: 'text', text: 'Synthetic Coordinator response' }] }; } }),
  });
  const store = new ProtocolStore(path.join(directory, 'interface-v2', digest('123')));
  const human = { repositoryId: '123', deviceId: 'browser', agentId: 'human', role: 'human' };
  const endpoint = '/api/workbench/projects/context-guard/api/coordinator';
  const request = async (route, input, headers = { Authorization: 'Bearer synthetic-human' }) => {
    const response = await fetch(cloud.url + route, { method: input ? 'POST' : 'GET', headers: { ...headers,
      ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, input) => { const result = await request(route, input); assert.equal(result.status, route === endpoint ? 202 : 200, JSON.stringify(result.body)); return result.body; };
  const poll = async predicate => {
    const deadline = Date.now() + 15000;
    for (;;) { const result = await request(endpoint); assert.equal(result.status, 200, JSON.stringify(result.body));
      if (predicate(result.body)) return result.body;
      assert.ok(Date.now() < deadline, 'Coordinator state did not advance before its deadline');
      await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  const prepare = async () => { await post(endpoint, { id: 'requirement', text: 'Synthetic requirement' });
    const state = await poll(value => value.approvals?.some(item => item.projectTask) && value.status === 'waiting-for-user');
    return state.approvals.find(item => item.projectTask); };
  const approve = proposal => post(endpoint + '/approval', { id: 'human-approve', proposalId: proposal.id, decision: 'approved', reason: 'Synthetic explicit human approval' });
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
  return { directory, store, human, nativeCalls, commands, config, endpoint, request, post, poll, prepare, approve, mcp, openMcp, call, context, memoryFile,
    url: cloud.url };
}

test('Cloud Coordinator public approval and MCP drive reviewed execution and independent CI routing for a synthetic verified handoff', async t => {
  const f = await fixture(t), proposal = await f.prepare();
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
  // Routing fixture ONLY: seed a previously verified handoff through the real
  // reducer. This bypass is test-owned, not an exposed API or native proof.
  await f.store.handle({ repositoryId: '123', deviceId: 'cloud-cursor:context-guard', agentId: current.actor.id, role: 'executor' }, {
    v: 2, id: 'synthetic-verified-handoff', type: 'task.report', session: current.session,
    payload: { taskId, stage: 'handoff', data: { sourceSha: 'b'.repeat(40), ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } },
  });
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
  assert.equal((await f.store.taskRecord(f.human, context.session, taskId)).stage, 'testing', 'An independent FINISHED Run is not a CI verdict');
  const state = await f.store.transaction(value => value, { readOnly: true });
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
