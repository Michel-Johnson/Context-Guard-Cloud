import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CursorCloudProvider } from '../scripts/cloud/cursor-provider.mjs';

const agentId = 'bc-11111111-1111-4111-8111-111111111111', runId = 'run-1';
const frame = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
async function fixture(t, serve, timeoutMs = 1000) {
  const calls = [], server = http.createServer((req, res) => { calls.push({ url: req.url, method: req.method });
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('synthetic:').toString('base64'));
    serve(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, provider: new CursorCloudProvider({ apiKey: 'synthetic', endpoint: `http://127.0.0.1:${server.address().port}`, allowLoopback: true, timeoutMs }) };
}
test('Cursor native stream parses split UTF-8/CRLF/multiline frames and stops on done without waiting for EOF', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const body = Buffer.from(': comment\r\n\r\n' + frame('assistant', { text: '私有说明' }) +
      'event: tool_call\r\ndata: {"callId":"one",\r\ndata: "name":"run_terminal_cmd","status":"completed","args":{"command":"中文"}}\r\n\r\n' +
      frame('result', { runId, status: 'FINISHED' }) + frame('done', {}));
    let index = 0;
    const timer = setInterval(() => { if (index >= body.length) { clearInterval(timer); return; } res.write(body.subarray(index, ++index)); }, 1);
    res.on('close', () => clearInterval(timer));
  }, 2000);
  const observed = [];
  const result = await f.provider.readRunEvents(agentId, runId, { onEvent: event => observed.push(event.event) });
  assert.equal(result.complete, true); assert.equal(result.agentId, agentId); assert.equal(result.runId, runId);
  assert.deepEqual(observed, ['tool_call', 'result', 'done']);
  assert.equal(result.events[0].data.args.command, '中文');
  assert.equal(JSON.stringify(result).includes('私有说明'), false);
  assert.deepEqual(f.calls, [{ method: 'GET', url: `/v1/agents/${agentId}/runs/${runId}/stream` }]);
});
test('Cursor stream rejects truncated framing, malformed JSON and another Run without exposing output', async t => {
  for (const [name, body, code] of [
    ['EOF', frame('tool_call', { callId: 'one' }), 'CURSOR_STREAM_INCOMPLETE'],
    ['JSON', 'event: tool_call\ndata: private-not-json\n\n', 'CURSOR_PROTOCOL_ERROR'],
    ['scope', frame('status', { runId: 'other', status: 'RUNNING' }), 'CURSOR_RUN_MISMATCH'],
  ]) await t.test(name, async child => {
    const f = await fixture(child, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(body); });
    await assert.rejects(f.provider.readRunEvents(agentId, runId), cause => { assert.equal(cause.code, code); assert.doesNotMatch(cause.message, /private-not-json/); return true; });
    assert.equal(f.calls.length, 1);
  });
});
test('Cursor stream expiry/conflict remains a GET observation failure and never creates another Run', async t => {
  for (const [status, code] of [[410, 'CURSOR_STREAM_EXPIRED'], [409, 'CURSOR_CONFLICT'], [401, 'CURSOR_AUTH_REQUIRED'], [429, 'CURSOR_RATE_LIMITED']]) await t.test(String(status), async child => {
    const f = await fixture(child, (_req, res) => { res.writeHead(status); res.end('private-error'); });
    await assert.rejects(f.provider.readRunEvents(agentId, runId), { code });
    assert.equal(f.calls.every(call => call.method === 'GET'), true);
  });
});
test('Cursor stream enforces deadline and caller abort while a native stream remains open', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n'); }, 50);
  await assert.rejects(f.provider.readRunEvents(agentId, runId), { code: 'CURSOR_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.provider.readRunEvents(agentId, runId, { signal: controller.signal }), { code: 'CURSOR_TIMEOUT' });
  assert.equal(f.calls.length, 1);
});
test('Cursor stream rejects a non-stream content type and bounded oversized output', async t => {
  for (const [name, contentType, body, code] of [['type', 'application/json', '{}', 'CURSOR_PROTOCOL_ERROR'],
    ['limit', 'text/event-stream', 'x'.repeat(8 * 1024 * 1024 + 1), 'CURSOR_OUTPUT_LIMIT']]) await t.test(name, async child => {
    const f = await fixture(child, (_req, res) => { res.writeHead(200, { 'Content-Type': contentType }); res.end(body); }, 10000);
    await assert.rejects(f.provider.readRunEvents(agentId, runId), { code });
  });
});
