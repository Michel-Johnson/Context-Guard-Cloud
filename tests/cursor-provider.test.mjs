import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CursorCloudProvider, cursorRunTerminal } from '../scripts/cloud/cursor-provider.mjs';

const agentId = 'bc-11111111-1111-4111-8111-111111111111', runId = 'run-first';
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return new CursorCloudProvider({ apiKey: 'fixture-only', endpoint: `http://127.0.0.1:${server.address().port}`, allowLoopback: true, timeoutMs: 1000 });
}
const respond = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

test('Cursor REST creation pins a commit and follow-up uses the same Agent without pushing main', async t => {
  const requests = [];
  const provider = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, body });
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('fixture-only:').toString('base64'));
    if (req.url === '/v1/agents') respond(res, { agent: { id: agentId }, run: { id: runId, agentId, status: 'CREATING' } });
    else if (req.method === 'POST') respond(res, { run: { id: 'run-second', agentId, status: 'RUNNING' } });
    else respond(res, { id: 'run-second', agentId, status: 'FINISHED', result: 'actual fixture result', git: { branches: [{ repoUrl: 'github.com/example/lab', branch: 'cursor/result' }] } });
  });
  const created = await provider.create({ agentId, repositoryUrl: 'https://github.com/example/lab', startingRef: 'a'.repeat(40), text: 'Implement a tiny change' });
  assert.equal(created.run.id, runId);
  assert.equal(requests[0].body.workOnCurrentBranch, false); assert.equal(requests[0].body.autoCreatePR, false);
  assert.deepEqual(requests[0].body.repos, [{ url: 'https://github.com/example/lab', startingRef: 'a'.repeat(40) }]);
  const followUp = await provider.followUp(agentId, 'Explain the change');
  assert.equal(requests[1].url, `/v1/agents/${agentId}/runs`); assert.equal(followUp.id, 'run-second');
  const finished = await provider.getRun(agentId, followUp.id);
  assert.equal(finished.result, 'actual fixture result'); assert.equal(cursorRunTerminal(finished), true);
  assert.equal(cursorRunTerminal({ status: 'UNKNOWN_NEW_STATUS' }), false);
});

test('Cursor REST rejects an unpinned repository, unsafe endpoint and mismatched Run', async t => {
  assert.throws(() => new CursorCloudProvider({ apiKey: 'fixture', endpoint: 'https://untrusted.example' }), { code: 'INVALID_CURSOR_CONFIG' });
  const provider = await fixture(t, (_req, res) => respond(res, { id: runId, agentId: 'another-agent', status: 'FINISHED' }));
  await assert.rejects(provider.create({ agentId, repositoryUrl: 'https://github.com/example/lab', startingRef: 'main', text: 'change' }), { code: 'INVALID_CURSOR_CREATE' });
  await assert.rejects(provider.getRun(agentId, runId), { code: 'CURSOR_RUN_MISMATCH' });
  await assert.rejects(provider.getRun('../different', runId), { code: 'INVALID_CURSOR_ID' });
});

test('Cursor REST preserves conflicts and unknown acceptance without retrying writes or leaking errors', async t => {
  let calls = 0;
  const provider = await fixture(t, (_req, res) => { calls++; respond(res, { secret: 'private-provider-diagnostic' }, calls === 1 ? 409 : 503); });
  await assert.rejects(provider.followUp(agentId, 'first'), cause => cause.code === 'CURSOR_CONFLICT' && !cause.deliveryUncertain && !cause.message.includes('private'));
  await assert.rejects(provider.followUp(agentId, 'second'), cause => cause.code === 'CURSOR_HTTP_ERROR' && cause.deliveryUncertain === true);
  assert.equal(calls, 2, 'one POST each; no blind retry');
});

test('Cursor REST marks malformed successful writes as uncertain', async t => {
  const provider = await fixture(t, (_req, res) => { res.writeHead(200); res.end('not json'); });
  await assert.rejects(provider.followUp(agentId, 'first'), cause => cause.code === 'CURSOR_PROTOCOL_ERROR' && cause.deliveryUncertain === true);
});
