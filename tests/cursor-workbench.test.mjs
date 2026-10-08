import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startCloudServer, createWorkbenchPasswordHash } from '../scripts/cloud/server.mjs';
import { CursorCloudProvider } from '../scripts/cloud/cursor-provider.mjs';
import { skillImport } from './helpers/skill.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
const { DeviceConnection } = await skillImport('scripts/workbench/protocol-device.mjs');

test('Cloud workbench human API binds native creation, two-way output and follow-up to one project and Agent', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-cloud-http-'));
  const apiKeyFile = path.join(directory, 'private-key'), cursorConfigFile = path.join(directory, 'private-cursor.json');
  const config = { apiKeyFile, repositoryUrl: 'https://github.com/example/test-lab', startingRef: 'a'.repeat(40) };
  await fs.writeFile(apiKeyFile, 'synthetic-only', { mode: 0o600 });
  await fs.writeFile(cursorConfigFile, JSON.stringify({ projects: { 'context-guard': config, other: config } }), { mode: 0o600 });
  const nativeRequests = []; let agentId, run = 0;
  const native = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    nativeRequests.push({ route: req.url, method: req.method, input });
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('synthetic-only:').toString('base64'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST') {
      agentId ||= input.agentId; run++;
      const result = { id: 'run-' + run, agentId, status: 'RUNNING' };
      res.end(JSON.stringify(req.url === '/v1/agents' ? { agent: { id: agentId }, run: result } : { run: result }));
    } else res.end(JSON.stringify({ id: req.url.split('/').at(-1), agentId, status: 'FINISHED', result: run === 1 ? 'Synthetic task artifact: result.mjs' : 'Synthetic explanation of result.mjs' }));
  });
  await new Promise(resolve => native.listen(0, '127.0.0.1', resolve));
  const cloud = await startCloudServer({ dataDir: path.join(directory, 'data'), port: 0, adminToken: 'test-admin', browserToken: 'test-human', cursorConfigFile,
    cursorProviderFactory: ({ apiKey }) => new CursorCloudProvider({ apiKey, endpoint: `http://127.0.0.1:${native.address().port}`, allowLoopback: true }),
  });
  t.after(async () => { await cloud.close(); await new Promise(resolve => { native.close(resolve); native.closeAllConnections(); }); });
  const route = '/api/workbench/projects/context-guard/api/cursor-chat';
  const request = async (url = route, input, headers = { Cookie: 'cg_workbench=test-human' }) => {
    const response = await fetch(cloud.url + url, { method: input ? 'POST' : 'GET', headers: { ...headers, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(route, undefined, {})).status, 401);
  const input = { action: 'create', id: 'first', text: 'Tiny task' };
  assert.equal((await request(route, input, { Cookie: 'cg_workbench=test-human', Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal(nativeRequests.length, 0);
  assert.deepEqual((await request()).body, { sessions: [], canCreateCloud: true });
  assert.equal((await request(route, { ...input, repositoryUrl: 'https://github.com/foreign/repo' })).status, 400);
  assert.equal((await request(route, { ...input, action: 'force' })).status, 400);
  const created = await request(route, input); assert.equal(created.status, 202); assert.equal(created.body.state, 'received');
  const sessionId = created.body.sessionId;
  const untilDone = async () => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const view = await request(route + '?session=' + encodeURIComponent(sessionId));
      assert.equal(view.status, 200);
      if (!view.body.pending) return view.body;
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const first = await untilDone(); assert.equal(first.status, 'stopped'); assert.equal(first.messages[1].text, 'Synthetic task artifact: result.mjs');
  assert.equal((await request()).body.sessions[0].id, sessionId);
  assert.deepEqual(await request(route, input), created);
  assert.equal((await request(route, { ...input, text: 'Different task' })).body.error.code, 'ID_REUSED');
  const followUp = await request(route, { id: 'second', text: 'Explain the artifact', sessionId }); assert.equal(followUp.status, 202);
  const second = await untilDone(); assert.equal(second.nativeAgentId, first.nativeAgentId); assert.equal(second.messages.length, 4);
  assert.equal(second.messages[3].text, 'Synthetic explanation of result.mjs');
  const posts = nativeRequests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[1].route, '/v1/agents/' + first.nativeAgentId + '/runs');
  assert.equal(posts[0].input.repos[0].startingRef, config.startingRef); assert.equal(posts[0].input.autoCreatePR, false);
  assert.equal((await request('/api/projects', { id: 'other', name: 'Other project' }, { Authorization: 'Bearer test-admin' })).status, 201);
  assert.equal((await request('/api/workbench/projects/other/api/cursor-chat?session=' + encodeURIComponent(sessionId))).status, 404);
  assert.equal((await request(route + '?session=unbound-local')).status, 403);
});

test('Cloud paired Cursor human messages reach the owning device and return same-Session results', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-paired-http-'));
  const memoryDir = path.join(directory, 'memory'), memoryFile = legacyProjectMemoryFile(memoryDir, 'context-guard');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1, main: { version: 'main-fixture', memory: { map: {
    v: 1, project: 'Paired Cursor fixture', root: { id: 'R', title: 'Fixture', children: [] },
  }, records: {} } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  const cloud = await startCloudServer({ dataDir: path.join(directory, 'cloud'), port: 0,
    browserToken: 'test-human', browserPasswordHash: await createWorkbenchPasswordHash('test-pairing-only'),
    memoryConfig: { dataDir: memoryDir, adminToken: 'memory-admin', projects: { 'context-guard': { token: 'fixture-memory-token' } } },
    protocolConfig: { repositories: [{ slug: 'example/repo', repositoryId: '123', projectId: 'context-guard' }] },
  });
  const device = new DeviceConnection({ directory: path.join(directory, 'device'), origin: cloud.url, allowLoopback: true });
  t.after(async () => { await device.close(); await cloud.close(); }); // Retain synthetic local evidence.
  await device.connect({ v: 2, id: 'connect', type: 'auth.open', payload: { repository: 'https://github.com/example/repo', password: 'test-pairing-only', clientId: 'paired' } });
  const { session } = await device.send({ v: 2, id: 'bind', type: 'session.bind', payload: { sessionId: 'cursor-owned', worktreeId: 'fixture-worktree', agentId: 'native-cursor', expectedBindingVersion: '' } });
  await device.send({ v: 2, id: 'presence', type: 'sync.heartbeat', payload: { sessions: [{ ...session, ackedSeq: 0, name: 'Paired Cursor', platform: 'cursor', execution: { status: 'stopped', at: new Date().toISOString() } }] } });
  const route = '/api/workbench/projects/context-guard/api/cursor-chat';
  const human = async (suffix = '', input) => {
    const response = await fetch(cloud.url + route + suffix, { method: input ? 'POST' : 'GET', headers: { Cookie: 'cg_workbench=test-human', ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await human()).body, { sessions: [{ id: session.id, name: 'Paired Cursor', kind: 'local' }], canCreateCloud: false });
  const input = { id: 'first', sessionId: session.id, text: 'Synthetic local task' };
  const first = await human('', input); assert.equal(first.status, 202); assert.equal(first.body.state, 'queued');
  assert.deepEqual(await human('', input), first);
  const pending = await human('?session=' + session.id); assert.equal(pending.body.pending, true);
  const downlink = await device.send({ v: 2, id: 'read', type: 'sync.read', session, payload: { afterSeq: 0, limit: 10 } });
  assert.deepEqual(downlink.messages[0].message, { v: 2, id: input.id, type: 'native.prompt', session, payload: { text: input.text } });
  // The fixed legacy CLI handles pairing; the newly published core validates
  // native.result at the real HTTP boundary. No actual model is substituted as passed.
  const credential = JSON.parse(await fs.readFile(device.file, 'utf8')).credential;
  const result = { v: 2, id: 'result', type: 'native.result', session, payload: { requestId: input.id, status: 'finished', text: 'Synthetic receiver result', truncated: false } };
  const reply = await fetch(cloud.url + '/api/v2/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
  assert.equal(reply.status, 200); assert.equal((await reply.json()).data.recorded, true);
  const done = await human('?session=' + session.id); assert.equal(done.body.pending, false); assert.equal(done.body.status, 'stopped');
  assert.equal(done.body.messages[1].text, result.payload.text);
  assert.equal((await human('', { id: 'follow-up', sessionId: session.id, text: 'Explain the same task' })).status, 202);
  assert.equal((await human('?session=' + session.id)).body.messages.length, 3);
  assert.equal((await human('?session=unbound')).status, 403);
  assert.equal((await human('', { ...input, text: 'Changed intent' })).body.error.code, 'ID_REUSED');
});
