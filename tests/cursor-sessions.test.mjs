import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CursorCloudProvider } from '../scripts/cloud/cursor-provider.mjs';
import { CursorCloudSessions } from '../scripts/cloud/cursor-sessions.mjs';

const respond = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fixture(t, mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-cloud-sessions-'));
  const requests = [], runs = new Map(); let nativeAgentId;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ route: req.url, method: req.method, input });
    if (req.method === 'POST' && req.url === '/v1/agents') {
      nativeAgentId = input.agentId;
      const run = { id: 'run-initial', agentId: nativeAgentId, status: 'RUNNING' }; runs.set(run.id, run);
      if (mode === 'lost-create') return respond(res, { private: 'not exposed' }, 503);
      return respond(res, { agent: { id: nativeAgentId }, run });
    }
    if (req.method === 'POST') {
      if (mode === 'lost-follow-up') return respond(res, {}, 503);
      const run = { id: 'run-follow-up', agentId: nativeAgentId, status: 'RUNNING' }; runs.set(run.id, run);
      return respond(res, { run });
    }
    if (req.url === '/v1/agents/' + nativeAgentId) return respond(res, { id: nativeAgentId, latestRunId: 'run-initial' });
    const run = runs.get(req.url.split('/').at(-1));
    if (!run) return respond(res, {}, 404);
    return respond(res, { ...run, status: 'FINISHED', result: run.id === 'run-initial' ? 'Small task completed' : 'Explanation of the same task', git: { branches: [{ branch: 'cursor/test-result' }] } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new CursorCloudProvider({ apiKey: 'fixture-only', endpoint: `http://127.0.0.1:${server.address().port}`, allowLoopback: true });
  const options = { directory, provider, repositoryUrl: 'https://github.com/example/test-lab', startingRef: 'a'.repeat(40) };
  const service = new CursorCloudSessions(options);
  t.after(async () => { await service.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { service, requests, options };
}

test('Cursor Cloud ledger connects creation, native results and same-Agent follow-up with durable request IDs', async t => {
  const { service, requests, options } = await fixture(t);
  const first = await service.create({ id: 'task', text: 'Implement a tiny task' });
  const sessionId = first.sessionId.slice(6);
  await service.close();
  assert.equal(requests.length, 1); assert.equal(requests[0].input.repos[0].startingRef, options.startingRef);
  assert.equal(requests[0].input.workOnCurrentBranch, false);
  assert.equal((await service.list())[0].id, first.sessionId);
  await assert.rejects(service.followUp(sessionId, { id: 'too-early', text: 'New task' }), { code: 'RUNTIME_BUSY' });
  const done = await service.conversation(sessionId);
  assert.equal(done.status, 'stopped'); assert.equal(done.pending, false);
  assert.equal(done.messages[1].text, 'Small task completed');
  const duplicate = await new CursorCloudSessions(options).create({ id: 'task', text: 'Implement a tiny task' });
  assert.deepEqual(duplicate, first); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  await assert.rejects(service.create({ id: 'task', text: 'Different intent' }), { code: 'ID_REUSED' });
  await service.followUp(sessionId, { id: 'follow-up', text: 'Explain your change' }); await service.close();
  const view = await service.conversation(sessionId);
  assert.equal(view.nativeAgentId, done.nativeAgentId); assert.equal(view.messages.length, 4);
  assert.equal(view.messages[3].text, 'Explanation of the same task');
  assert.equal(requests.find(request => request.method === 'POST' && request.route !== '/v1/agents').route, '/v1/agents/' + done.nativeAgentId + '/runs');
  await service.followUp(sessionId, { id: 'follow-up', text: 'Explain your change' });
  assert.equal(requests.filter(request => request.method === 'POST').length, 2);
});

test('Cursor Cloud lost CREATE response is inspected through the saved Agent without another POST', async t => {
  const { service, requests, options } = await fixture(t, 'lost-create');
  const receipt = await service.create({ id: 'task', text: 'A small task' }); await service.close();
  const sessionId = receipt.sessionId.slice(6), restarted = new CursorCloudSessions(options);
  const view = await restarted.conversation(sessionId);
  assert.equal(view.status, 'stopped'); assert.equal(view.error, null, 'confirmed native result clears the stale transport error');
  assert.equal(view.messages[1].text, 'Small task completed');
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  assert.deepEqual(await restarted.create({ id: 'task', text: 'A small task' }), receipt);
});

test('Cursor Cloud uncertain follow-up is not repeated and invalid repository configuration creates no ledger', async t => {
  const { service, requests, options } = await fixture(t, 'lost-follow-up');
  assert.throws(() => new CursorCloudSessions({ ...options, startingRef: 'main' }), { code: 'INVALID_CURSOR_CREATE' });
  await assert.rejects(service.create({ id: '', text: 'Task' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await service.list(), []);
  const first = await service.create({ id: 'first', text: 'Task' }); await service.close();
  const sessionId = first.sessionId.slice(6); await service.conversation(sessionId);
  const input = { id: 'second', text: 'Follow up' };
  await service.followUp(sessionId, input); await service.close();
  const view = await service.conversation(sessionId);
  assert.equal(view.status, 'unknown'); assert.equal(view.pending, true); assert.equal(view.error, 'CURSOR_HTTP_ERROR');
  await new CursorCloudSessions(options).followUp(sessionId, input);
  await assert.rejects(service.followUp(sessionId, { id: 'third', text: 'Another follow-up' }), { code: 'RUNTIME_BUSY' });
  await assert.rejects(service.followUp(sessionId, { ...input, text: 'Changed' }), { code: 'ID_REUSED' });
  assert.equal(requests.filter(request => request.method === 'POST').length, 2);
});
