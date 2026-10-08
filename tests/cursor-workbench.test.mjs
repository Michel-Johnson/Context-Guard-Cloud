import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { CursorCloudProvider } from '../scripts/cloud/cursor-provider.mjs';

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
