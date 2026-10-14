import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqGateway, validateQqConfig } from '../scripts/cloud/qq-gateway.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';
const config = { token: 'test-qq-independent-credential-0000000000', accountId: '123456789', projectIds: ['fixture'], defaultProjectId: 'fixture' };
const req = { method: 'POST', headers: { authorization: `Bearer ${config.token}` } };
const input = { id: 'message-1', text: 'hello', scene: { kind: 'private', peerId: '123456789' } };
function fixture() {
  const calls = [], receipts = new Map(); let messages = [];
  const gateway = createQqGateway({ config,
    createConversation: async target => calls.push(['create', target]),
    submit: async (target, text) => {
      const prior = receipts.get(target.id);
      if (prior && prior !== text) throw Object.assign(new Error('changed'), { code: 'ID_REUSED' });
      if (!prior) {
        receipts.set(target.id, text);
        messages.push({ role: 'user', requestId: target.id, text }, { role: 'assistant', id: 'answer', text: 'hello back' });
        calls.push(['submit', target]);
      }
    },
    state: async () => ({ status: 'waiting-for-user', acceptedRequestIds: [...receipts.keys()], messages }),
    listProjects: async () => [{ id: 'fixture', name: 'Fixture' }],
  });
  return { gateway, calls, setMessages: value => { messages = value; } };
}
test('QQ authenticates before identity assertions and rejects actor/project substitution', async () => {
  const { gateway, calls } = fixture();
  await assert.rejects(gateway({ ...req, headers: {} }, '/api/integrations/qq/submit', input), { code: 'UNAUTHORIZED' });
  await assert.rejects(gateway({ ...req, headers: { ...req.headers, origin: 'https://evil.example' } }, '/api/integrations/qq/submit', input), { code: 'FORBIDDEN' });
  await assert.rejects(gateway(req, '/api/integrations/qq/submit', { ...input, actor: { kind: 'human' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(gateway(req, '/api/integrations/qq/submit', { ...input, projectId: 'other' }), { code: 'FORBIDDEN' });
  assert.equal(calls.length, 0);
  assert.throws(() => validateQqConfig({ ...config, token: '' }), { code: 'INVALID_QQ_CONFIG' });
});
test('QQ retry uses identical identity, never creates a fake Slack or browser actor', async () => {
  const { gateway, calls } = fixture();
  const first = await gateway(req, '/api/integrations/qq/submit', input);
  const second = await gateway(req, '/api/integrations/qq/submit', input);
  assert.deepEqual(second, first);
  assert.equal(calls.filter(([name]) => name === 'submit').length, 1);
  assert.deepEqual(calls[0][1].actor, { kind: 'human', integration: 'qq', userId: config.accountId, sessionId: `qq:${config.accountId}`, channelId: 'private:123456789' });
  await assert.rejects(gateway(req, '/api/integrations/qq/submit', { ...input, text: 'changed' }), { code: 'ID_REUSED' });
  assert.equal(first.complete, true);
  assert.deepEqual(first.replies, [{ id: 'answer', text: 'hello back' }]);
});
test('QQ output is only this request, not previous, subsequent or partial replies', async () => {
  const { gateway, calls, setMessages } = fixture();
  await gateway(req, '/api/integrations/qq/submit', input);
  const id = calls[0][1].id;
  setMessages([{ role: 'assistant', id: 'older', text: 'old' }, { role: 'user', requestId: id },
    { role: 'assistant', id: 'partial', text: 'partial', partial: true }, { role: 'assistant', id: 'answer', text: 'right' },
    { role: 'user', requestId: 'other' }, { role: 'assistant', id: 'later', text: 'wrong' }]);
  assert.deepEqual((await gateway(req, '/api/integrations/qq/state', { ...input, text: undefined })).replies, [{ id: 'answer', text: 'right' }]);
  await gateway(req, '/api/integrations/qq/submit', { ...input, id: 'message-2', scene: { kind: 'private', peerId: '987654321' } });
  assert.notEqual(calls.at(-1)[1].conversationOperation, calls[0][1].conversationOperation);
});

test('QQ real Cloud HTTP delivers once across a Cloud restart with actual QQ identity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-qq-http-'));
  let cloud;
  t.after(async () => { await cloud?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const providerFile = path.join(directory, 'provider.json');
  await fs.writeFile(providerFile, JSON.stringify({ type: 'test' }));
  await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: 'fixture', name: 'Fixture' }] }));
  const memoryDir = path.join(directory, 'memory'), memoryFile = legacyProjectMemoryFile(memoryDir, 'fixture');
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, JSON.stringify({ revision: 1,
    main: { version: 'main-test', memory: { records: {}, map: { project: 'Fixture', root: { id: 'T0', title: 'Fixture', kind: 'module', children: [] } } } },
    sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  let modelCalls = 0; const modelRequests = [];
  const options = { dataDir: directory, host: '127.0.0.1', port: 0, privateAccess: true,
    adminToken: 'fixture-admin', browserToken: 'fixture-browser', qqConfig: { ...config, friendChat: true },
    protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'fixture', slug: 'example/fixture' }] },
    memoryConfig: { dataDir: memoryDir, adminToken: 'fixture-memory', projects: { fixture: { coordinator: { enabled: true, providerFile, bindings: {}, mapWrite: false } } } },
    coordinatorModelFactory: () => ({ next: async request => { modelCalls++; modelRequests.push(request); return { stop: 'end_turn', content: [{ type: 'text', text: 'QQ 已收到' }] }; } }),
  };
  cloud = await startCloudServer(options);
  const post = async (route, value = input, headers = req.headers) => {
    const result = await fetch(cloud.url + route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { status: result.status, data: await result.json() };
  };
  assert.equal((await post('/api/integrations/qq/submit', input, {})).status, 401);
  const submitted = await post('/api/integrations/qq/submit');
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await post('/api/integrations/qq/state', { id: input.id, scene: input.scene });
    if (result.data.complete) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.data.complete, true, JSON.stringify(result.data));
  assert.deepEqual(result.data.replies.map(item => item.text), ['QQ 已收到']);
  const conversations = JSON.parse(await fs.readFile(path.join(directory, 'coordinators/fixture/conversations.json'), 'utf8'));
  const chat = Object.values(conversations.chats)[0];
  assert.equal(chat.executionMode, 'manual');
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'coordinators/fixture/chats', chat.id, 'conversation.json'), 'utf8'));
  const actor = saved.messages.find(message => message.role === 'user').actor;
  assert.equal(actor.integration, 'qq'); assert.equal(actor.userId, config.accountId);
  await cloud.close(); cloud = await startCloudServer(options);
  assert.equal((await post('/api/integrations/qq/submit')).data.complete, true);
  assert.equal(modelCalls, 1);
  assert.equal((await post('/api/integrations/qq/submit', { ...input, text: 'changed' })).data.error.code, 'ID_REUSED');
  const friend = { id: 'friend-message', text: '你好', scene: { kind: 'private', peerId: '987654321' } };
  assert.equal((await post('/api/integrations/qq/chat/submit', { ...friend, projectId: 'fixture' })).status, 400);
  assert.equal((await post('/api/integrations/qq/chat/submit', { ...friend, actor: { userId: config.accountId } })).status, 400);
  assert.equal((await post('/api/integrations/qq/chat/submit', { ...friend, scene: input.scene })).status, 400);
  const friendSubmitted = await post('/api/integrations/qq/chat/submit', friend);
  assert.equal(friendSubmitted.status, 200, JSON.stringify(friendSubmitted.data));
  const friendState = async scene => post('/api/integrations/qq/chat/state', { id: friend.id, scene });
  for (let i = 0; i < 100; i++) {
    result = await friendState(friend.scene);
    if (result.data.complete) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.data.complete, true);
  assert.equal(modelCalls, 2);
  assert.deepEqual(modelRequests.at(-1).tools, []);
  assert.equal(JSON.stringify(modelRequests.at(-1)).includes('Fixture'), false);
  assert.equal(JSON.stringify(modelRequests.at(-1)).includes('read_project_map'), false);
  const otherScene = { kind: 'private', peerId: '987654322' };
  assert.equal((await friendState(otherScene)).data.accepted, false);
  const guestDirectory = path.join(directory, 'qq-chats');
  const guestFiles = await fs.readdir(guestDirectory);
  const transcripts = await Promise.all(guestFiles.map(name => fs.readFile(path.join(guestDirectory, name, 'conversation.json'), 'utf8').then(JSON.parse)));
  const guest = transcripts.find(value => value.messages.some(message => message.role === 'user'));
  assert.equal(guest.messages[0].actor.userId, friend.scene.peerId);
  assert.equal(guest.activeContext, null);
  await cloud.close(); cloud = await startCloudServer(options);
  assert.equal((await post('/api/integrations/qq/chat/submit', friend)).data.complete, true);
  assert.equal(modelCalls, 2);
});

test('QQ friend access is disabled by default and does not invoke a project service', async () => {
  const gateway = createQqGateway({ config, friendConversation: () => { throw Error('must not run'); } });
  await assert.rejects(gateway(req, '/api/integrations/qq/chat/submit', input), { code: 'FORBIDDEN' });
  assert.throws(() => validateQqConfig({ ...config, friendChat: 'true' }), { code: 'INVALID_QQ_CONFIG' });
});
