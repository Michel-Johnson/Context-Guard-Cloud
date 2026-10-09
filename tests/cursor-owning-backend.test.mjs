import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { ProtocolStore } from '../scripts/shared/protocol-store.mjs';
import { canonical } from '../scripts/shared/protocol.mjs';
import { skillImport } from './helpers/skill.mjs';

const { startServer } = await skillImport('scripts/workbench/server.mjs');
const { resolveProject, saveMainBinding } = await skillImport('scripts/workbench/project.mjs');
const { recordHostAttestedSession } = await skillImport('scripts/workbench/access.mjs');
const { DeviceConnection } = await skillImport('scripts/workbench/protocol-device.mjs');
const digest = text => createHash('sha256').update(text).digest('hex');
const execute = promisify(execFile);

async function until(read, label) {
  const deadline = Date.now() + 15000;
  do { const result = await read(); if (result) return result; await delay(20); } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

// Real released Skill backend -> device pump -> owning Node IPC -> fixed
// device transport -> actual Cloud HTTP/auth/Core. Only GitHub identity and
// review preconditions are synthetic. No native provider or model is called:
// the positive case must stop at the existing native-isolation hard gate.
for (const scenario of ['authorized', 'revoked', 'rebound', 'missing-ack']) {
  test(`original owning backend CI preparation ${scenario} crosses actual device, IPC and Cloud boundaries`, async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cg-own-ci-')));
    const root = path.join(directory, 'repo'), testerRoot = path.join(directory, 'tester');
    await fs.mkdir(root);
    const git = async (...args) => (await execute('git', args, { cwd: root, windowsHide: true })).stdout.trim();
    await git('init', '-b', 'main');
    await fs.writeFile(path.join(root, '.gitignore'), '.codex/\n');
    await fs.writeFile(path.join(root, 'source.txt'), 'original source\n');
    await git('add', '.gitignore', 'source.txt');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'owning backend fixture');
    const planSourceSha = await git('rev-parse', 'HEAD');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'final handoff commit');
    const sourceSha = await git('rev-parse', 'HEAD');
    await git('worktree', 'add', '--detach', testerRoot, sourceSha);
    const project = await saveMainBinding(root, { mode: 'local', branch: 'main' });
    const testerProject = await resolveProject(testerRoot);
    const executorId = randomUUID(), testerId = randomUUID(), projectId = 'fixture', repositoryId = '123';
    await recordHostAttestedSession(root, executorId, { CURSOR_SESSION_ID: executorId });
    await recordHostAttestedSession(testerRoot, testerId, { CURSOR_SESSION_ID: testerId });
    const map = { v: 1, project: 'Fixture', bootstrap: 'ready', flows: [],
      root: { id: 'T0', title: 'Fixture', purpose: 'Synthetic test scope', kind: 'module', state: 'dirty', children: [] } };
    const memoryDir = path.join(directory, 'memory'), memoryFile = path.join(memoryDir, digest(projectId), 'memory.json');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, JSON.stringify({ revision: 1,
      main: { version: 'main-1', mainSha: sourceSha, memory: { map, records: {} } },
      sessions: Object.fromEntries([executorId, testerId].map(id => [id, {
        version: 'initial', baseMainVersion: 'main-1', memory: { map, records: {} } }])),
      receipts: {}, history: [], events: [], eventCursors: {} }));
    const dataDir = path.join(directory, 'cloud');
    const cloud = await startCloudServer({ dataDir, port: 0, browserToken: 'synthetic-browser',
      browserPasswordHash: await createWorkbenchPasswordHash('synthetic-password'),
      protocolConfig: { repositories: [{ slug: 'example/repo', repositoryId, projectId }] },
      memoryConfig: { dataDir: memoryDir, adminToken: 'synthetic-admin', projects: {
        [projectId]: { token: 'synthetic-memory', coordinator: { enabled: false, ciReceivers: {
          [testerId]: { executorSessionId: executorId, worktreeId: testerProject.worktreeId },
        } } },
      } },
    });
    let local, device, revoke;
    const observations = [], protocolTypes = [], proxyErrors = [];
    // Control only the external HTTP response/interleaving. Production client,
    // backend factory, authorization, IPC and device outbox are not replaced.
    const proxy = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks), scoped = req.headers['x-context-guard-ci-task'];
        if (req.url.startsWith('/api/v2/messages') && req.method === 'POST') protocolTypes.push(JSON.parse(body).type);
        if (scoped && ['revoked', 'rebound'].includes(scenario)) { await revoke(); revoke = async () => {}; }
        const headers = { ...req.headers }; delete headers.host; delete headers.connection;
        const response = await fetch(new URL(req.url, cloud.url), { method: req.method, headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'error' });
        const reply = Buffer.from(await response.arrayBuffer()), outgoing = Object.fromEntries(response.headers);
        if (scoped) {
          const message = JSON.parse(body);
          observations.push({ tuple: JSON.parse(Buffer.from(scoped, 'base64url')), ci: req.headers['x-context-guard-ci-session'],
            message, status: response.status, acknowledgement: response.headers.get('x-context-guard-ci-task-authorized') });
          if (scenario === 'missing-ack') delete outgoing['x-context-guard-ci-task-authorized'];
        }
        delete outgoing['transfer-encoding']; delete outgoing.connection;
        res.writeHead(response.status, outgoing); res.end(reply);
      } catch (error) { proxyErrors.push(error); res.writeHead(502); res.end(); }
    });
    t.after(async () => {
      await local?.close(); await device?.close();
      const stopped = new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      proxy.closeAllConnections?.(); await stopped; await cloud.close();
    }); // Preserve isolated failure evidence; never delete user directories.
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    await fs.mkdir(project.sharedDir, { recursive: true });
    device = new DeviceConnection({ directory: path.join(project.sharedDir, 'interface-v2'), origin, allowLoopback: true });
    await device.connect({ v: 2, id: 'connect', type: 'auth.open', payload: {
      repository: 'https://github.com/example/repo', password: 'synthetic-password', clientId: 'fixture-device' } });
    await fs.writeFile(path.join(project.sharedDir, 'memory-client.json'), JSON.stringify({ url: origin, projectId }));
    local = await startServer({ root, port: 0,
      repositoryLookup: async () => ({ repositoryId, slug: 'example/repo' }) });
    const call = async (route, body, credential = local.state.adminToken) => {
      const response = await fetch(new URL(route, local.state.url), { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const registered = await call('/api/session', { sessionId: executorId, worktreeRoot: root });
    const tester = await call('/api/session', { sessionId: testerId, worktreeRoot: testerRoot });
    assert.equal(registered.cloudBinding.status, 'ready'); assert.equal(tester.cloudBinding.status, 'ready');
    await call('/api/cursor-runtime', { action: 'configure', sessionId: testerId, config: {
      command: process.execPath, root: testerRoot, name: 'Synthetic independent Tester', role: 'ci',
      executorSessionId: executorId, ciCommands: ['node --test'] } });
    const store = new ProtocolStore(path.join(dataDir, 'interface-v2', digest(repositoryId)));
    const human = { repositoryId, deviceId: 'browser', agentId: 'human', role: 'human' };
    const binding = await store.registeredBinding(human, executorId), session = { id: executorId, generation: binding.generation };
    const executor = { repositoryId, deviceId: binding.deviceId, agentId: 'device-host', role: 'device' };
    const coordinator = { ...executor, deviceId: 'coordinator', agentId: 'synthetic-coordinator', role: 'coordinator',
      bindings: { [executorId]: binding.worktreeId } };
    let sequence = 0;
    const send = async (principal, type, payload, options) => (await store.handle(principal, {
      v: 2, id: 'setup-' + ++sequence, type, session, payload }, options)).data;
    const brief = await send(coordinator, 'brief.submit', { taskId: 'task', text: 'Verify original CI preparation' });
    await send(coordinator, 'review.request', { taskId: 'task', kind: 'brief', ref: brief.ref, version: brief.version });
    await send(human, 'review.result', { kind: 'brief', ref: brief.ref, version: brief.version,
      decision: 'approved', reason: 'Synthetic fixture precondition' });
    await send(coordinator, 'task.assign', { taskId: 'task', briefRef: brief.ref, briefVersion: brief.version,
      sessionId: executorId, nodeIds: ['T0'], mainVersion: 'main-1' }, { workflow: { verifyRouting: () => true } });
    const put = (ref, kind, content) => send(executor, 'object.put', { ref, kind, content, baseVersion: '' });
    const plan = await put('plan', 'plan', { paths: ['source.txt'], steps: ['Read exact commit'] });
    await send(executor, 'task.report', { taskId: 'task', stage: 'planReady', data: {
      planRef: plan.ref, planVersion: plan.version, sourceSha: planSourceSha } });
    await send(coordinator, 'review.request', { taskId: 'task', kind: 'plan', ref: plan.ref, version: plan.version,
      requirementsRef: brief.ref, requirementsVersion: brief.version, rulesVersion: 'synthetic-rules' });
    const approval = await send(coordinator, 'review.result', { kind: 'plan', ref: plan.ref, version: plan.version,
      decision: 'approved', reason: 'Synthetic fixture plan' });
    const todo = await put('todo', 'ciTodo', { items: [{ id: 'CI-1', title: 'Inspect original source' }] });
    const unit = await put('unit', 'evidence', { fixture: 'Synthetic unit precondition, not native proof' });
    await send(executor, 'task.report', { taskId: 'task', stage: 'handoff', data: {
      sourceSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref], experienceRefs: [] } });
    revoke = async () => {
      if (scenario === 'rebound') {
        const current = await store.registeredBinding(executor, testerId);
        await store.handle(executor, { v: 2, id: 'rebind-during-preparation', type: 'session.bind', payload: {
          sessionId: testerId, worktreeId: 'different-ci-worktree', agentId: testerId,
          expectedBindingVersion: current.version } }, { allowMigration: true, verifyBinding: () => true });
        return;
      }
      const task = await store.taskRecord(coordinator, session, 'task');
      await send(coordinator, 'task.control', { taskId: 'task', action: 'cancel', expectedVersion: task.version,
        data: { reason: 'Synthetic revocation during owning preparation' } });
    };
    const requested = await send(coordinator, 'ci.request', { taskId: 'task', sourceSha, ciTodoRef: todo.ref, unitTestRefs: [unit.ref] });
    assert.equal(requested.stage, 'testing');
    // Trigger the existing original device pump through its operator entry.
    const pulse = async () => {
      const prepared = await call('/api/device-heartbeat');
      const response = await fetch(new URL('/api/v2/heartbeat', origin), { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ credential: prepared.credential, message: prepared.message }]) });
      assert.equal(response.status, 200); const [reply] = await response.json(); assert.equal(reply.ok, true);
      await call('/api/device-heartbeat', reply);
    };
    await pulse();
    const deliveries = path.join(project.sharedDir, 'cursor-runtime', testerId, 'deliveries');
    const job = await until(async () => {
      const names = await fs.readdir(deliveries).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const jobs = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => JSON.parse(await fs.readFile(path.join(deliveries, name), 'utf8'))));
      return jobs.find(value => ['failed', 'finished', 'interrupted'].includes(value.state));
    }, `actual owning worker outcome (${scenario})`);
    assert.equal(job.state, 'failed');
    assert.equal(job.error, scenario === 'authorized' ? 'CI_NATIVE_ISOLATION_REQUIRED' : 'CI_CHANNEL_CLOSED');
    assert.ok(Number.isInteger(job.workerPid) && job.workerPid !== process.pid, 'actual separate owning Node worker');
    assert.equal(job.childPid, undefined, 'no unisolated Cursor CLI child may start');
    assert.equal(observations.length, 1, 'production preparation must use exactly one current Task-scoped read');
    const observed = observations[0];
    assert.equal(observed.ci, testerId);
    assert.deepEqual(observed.tuple, { taskId: 'task', planRef: plan.ref, planVersion: plan.version,
      planSourceSha, approvalReceiptId: approval.receiptId, sourceSha,
      ciTodoRef: todo.ref, ciTodoVersion: todo.version });
    assert.notEqual(observed.tuple.planSourceSha, observed.tuple.sourceSha, 'Plan baseline is not the final handoff commit');
    assert.equal(observed.message.type, 'object.read');
    assert.deepEqual(observed.message.payload, { ref: todo.ref, version: todo.version });
    assert.deepEqual(observed.message.session, session);
    const rejected = ['revoked', 'rebound'].includes(scenario);
    assert.equal(observed.status, rejected ? 403 : 200);
    assert.equal(observed.acknowledgement, rejected ? null : digest(canonical(observed.tuple)));
    const task = await store.taskRecord(coordinator, session, 'task');
    assert.equal(task.stage, scenario === 'revoked' ? 'cancelling' : 'testing');
    assert.equal(task.ci, undefined, 'preparation must not manufacture a CI result or task completion');
    await pulse();
    assert.equal(observations.length, 1, 'transport replay must not start a replacement worker or reauthorize a closed capability');
    assert.equal(protocolTypes.filter(type => ['object.put', 'ci.result'].includes(type)).length, 0,
      'preparation failure must not fall back to an ordinary unscoped CI write or publish a result');
    assert.deepEqual(proxyErrors, []);
    assert.equal(await fs.readFile(path.join(testerRoot, 'source.txt'), 'utf8'), 'original source\n');
    assert.equal(await git('status', '--porcelain'), '');
    const scopedState = await store.immutableState();
    assert.equal(Object.keys(scopedState.cursorCiTaskScopes || {}).length, 0, 'read-only authorization adds no write scope');
  });
}
