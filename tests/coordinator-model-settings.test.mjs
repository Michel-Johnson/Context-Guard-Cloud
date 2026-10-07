import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorModelSettings } from '../scripts/cloud/coordinator-model-settings.mjs';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { startCloudServer } from '../scripts/cloud/server.mjs';

const answer = text => ({ content: [{ type: 'text', text }], stop: 'end_turn', usage: {} });
const factory = config => ({ model: config.model, next: async () => answer('synthetic') });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-model-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const providerFile = path.join(directory, 'glm-private.json'), ds = path.join(directory, 'ds-private.json');
  for (const [file, model] of [[providerFile, 'glm-5.3'], [ds, 'deepseek-flash']]) {
    await fs.writeFile(file, JSON.stringify({ model, token: 'synthetic-private-marker', baseUrl: 'https://provider.invalid', protocol: 'anthropic' }));
  }
  const config = { enabled: true, providerFile, modelProviders: {
    glm: { label: 'GLM 5.3', providerFile }, ds: { label: 'DeepSeek V4.1 Flash', providerFile: ds },
  }, defaultProviderId: 'glm', bindings: {} };
  const settings = await CoordinatorModelSettings.open({ directory, config, factory });
  return { directory, config, settings };
}

test('model catalog exposes only safe metadata and selection survives restart', async t => {
  const f = await fixture(t), initial = await f.settings.state();
  assert.deepEqual(initial.options, [{ id: 'glm', label: 'GLM 5.3', model: 'glm-5.3' }, { id: 'ds', label: 'DeepSeek V4.1 Flash', model: 'deepseek-flash' }]);
  assert.equal(initial.selectedId, 'glm');
  assert.ok(!JSON.stringify(initial).includes('private'));
  const input = { id: 'switch', providerId: 'ds', baseVersion: initial.version };
  const result = await f.settings.select(input);
  assert.equal(result.selectedId, 'ds');
  const restarted = await CoordinatorModelSettings.open({ ...f, factory });
  assert.deepEqual(await restarted.state(), result);
  assert.equal((await restarted.selection()).model.model, 'deepseek-flash');
  assert.deepEqual(await restarted.select({ baseVersion: input.baseVersion, providerId: input.providerId, id: input.id }), result, 'property order does not change operation identity');
  await assert.rejects(restarted.select({ ...input, providerId: 'glm' }), { code: 'ID_REUSED' });
  await assert.rejects(restarted.select({ ...input, id: 'stale' }), { code: 'VERSION_CONFLICT' });
});

test('parallel changes require versions and cannot overwrite one another', async t => {
  const { settings } = await fixture(t), initial = await settings.state();
  const results = await Promise.allSettled(['a', 'b'].map(id => settings.select({ id, providerId: 'ds', baseVersion: initial.version })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('model selection rejects arbitrary URLs, credentials, missing versions and unknown IDs', async t => {
  const { settings } = await fixture(t), initial = await settings.state();
  const valid = { id: 'safe', providerId: 'ds', baseVersion: initial.version };
  for (const input of [null, {}, { ...valid, token: 'not-accepted' }, { ...valid, providerFile: '/tmp/not-accepted' },
    { ...valid, baseUrl: 'https://arbitrary.invalid' }, { ...valid, providerId: 'other' }, { ...valid, baseVersion: '' }]) {
    await assert.rejects(settings.select(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(await settings.state(), initial);
});

test('private configuration errors are masked and removed selected models fail closed', async t => {
  const f = await fixture(t), initial = await f.settings.state();
  await f.settings.select({ id: 'select', providerId: 'ds', baseVersion: initial.version });
  const config = { ...f.config, modelProviders: { glm: f.config.modelProviders.glm } };
  const removed = await CoordinatorModelSettings.open({ directory: f.directory, config, factory });
  await assert.rejects(removed.state(), { code: 'MODEL_SETTINGS_UNAVAILABLE' });
  await fs.writeFile(f.config.providerFile, '{"token":"synthetic-private-marker" broken');
  await assert.rejects(CoordinatorModelSettings.open({ ...f, factory }), error => error.code === 'INVALID_COORDINATOR_CONFIG' && !error.message.includes('synthetic-private-marker'));
});

test('a running turn pins its provider while later turns use the selected model', { timeout: 10000 }, async t => {
  const f = await fixture(t), calls = [];
  let entered, release;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const glm = { model: 'glm-5.3', next: async () => { calls.push('glm'); entered(); await held; return answer('original'); } };
  const ds = { model: 'deepseek-flash', next: async () => { calls.push('ds'); return answer('new'); } };
  const models = new Map([['glm', glm], ['ds', ds]]);
  const service = new CoordinatorService({ directory: path.join(f.directory, 'chat'), system: 'test', tools: [], execute: async () => {},
    model: glm, textModels: models, selectTextModel: async () => { const { providerId } = await f.settings.selection(); return { providerId, model: models.get(providerId) }; } });
  t.after(() => service.close());
  await service.submit({ id: 'first', text: 'hello' }); await started;
  const current = await f.settings.state();
  await f.settings.select({ id: 'switch', providerId: 'ds', baseVersion: current.version });
  assert.equal((await service.state()).modelRoute.providerId, 'glm');
  release(); await service.close();
  await service.submit({ id: 'second', text: 'again' }); await service.close();
  assert.deepEqual(calls, ['glm', 'ds']);
  const persisted = JSON.parse(await fs.readFile(service.file, 'utf8'));
  assert.deepEqual(persisted.messages.filter(item => item.role === 'assistant').map(item => item.providerId), ['glm', 'ds']);
});

test('failed turns keep their original model across selection changes and restart', async t => {
  const f = await fixture(t); let attempts = 0, selected = 'glm';
  const glm = { model: 'glm-5.3', next: async () => { if (++attempts === 1) throw Object.assign(new Error('synthetic failure'), { code: 'MODEL_UNAVAILABLE' }); return answer('retried'); } };
  const ds = { model: 'deepseek-flash', next: async () => assert.fail('retry must use original model') };
  const models = new Map([['glm', glm], ['ds', ds]]);
  const options = { directory: path.join(f.directory, 'retry'), system: 'test', tools: [], execute: async () => {}, model: glm,
    textModels: models, selectTextModel: async () => ({ providerId: selected, model: models.get(selected) }), maxModelRetries: 0 };
  const input = { id: 'first', text: 'hello' };
  let service = new CoordinatorService(options);
  await service.submit(input); await service.close();
  assert.equal((await service.state()).status, 'error');
  selected = 'ds'; service = new CoordinatorService(options);
  await service.submit({ ...input, retry: true }); await service.close();
  assert.equal((await service.state()).status, 'waiting-for-user');
  assert.equal((await service.state()).modelRoute.providerId, 'glm');
  assert.equal(attempts, 2);
});

test('cross-provider history drops opaque thinking only in outgoing projection and preserves tool pairs', async t => {
  const f = await fixture(t), glm = factory({ model: 'glm-5.3' }), ds = factory({ model: 'deepseek-flash' });
  const service = new CoordinatorService({ directory: path.join(f.directory, 'history'), system: 'test', tools: [], execute: async () => {},
    model: glm, textModels: new Map([['glm', glm], ['ds', ds]]) });
  const blocks = [{ type: 'thinking', thinking: 'private', signature: 'provider-native' }, { type: 'redacted_thinking', data: 'opaque' },
    { type: 'tool_use', id: 'tool1', name: 'read_map', input: { nodeId: 'N1' } }];
  const messages = [{ role: 'assistant', providerId: 'glm', content: blocks },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'map' }] }];
  const outgoing = await service.materializeMessages({ messages, activeModelRoute: { kind: 'text', providerId: 'ds', model: ds.model } });
  assert.deepEqual(outgoing[0].content, [blocks[2]]); assert.deepEqual(outgoing[1].content, messages[1].content);
  assert.equal(messages[0].content.length, 3);
  const same = await service.materializeMessages({ messages, activeModelRoute: { kind: 'text', providerId: 'glm', model: glm.model } });
  assert.deepEqual(same[0].content, blocks);
  const legacy = await service.materializeMessages({ messages: [{ role: 'assistant', content: blocks }], activeModelRoute: { kind: 'text', providerId: 'ds', model: ds.model } });
  assert.deepEqual(legacy[0].content, [blocks[2]]);
  service.visionModel = factory({ model: 'glm-5.3-flash' });
  const vision = await service.materializeMessages({ messages: [{ role: 'assistant', modelName: 'deepseek-flash', content: blocks }], activeModelRoute: { kind: 'vision', model: 'glm-5.3-flash' } });
  assert.deepEqual(vision[0].content, [blocks[2]], 'text-provider thinking cannot leak into image-provider continuation');
});

test('model settings HTTP API requires workbench authority, rejects foreign origin and isolates projects', async t => {
  const f = await fixture(t), root = path.join(f.directory, 'checkout'); await fs.mkdir(root);
  await fs.mkdir(path.join(f.directory, 'server'));
  await fs.writeFile(path.join(f.directory, 'server', 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: 'lab', name: 'Lab' }, { id: 'other', name: 'Other' }] }));
  const server = await startCloudServer({ dataDir: path.join(f.directory, 'server'), port: 0, browserToken: 'synthetic-browser',
    publicOrigin: 'https://workbench.example', memoryConfig: { dataDir: path.join(f.directory, 'memory'), adminToken: 'synthetic-admin', projects: {
      lab: { root, token: 'synthetic-project', coordinator: f.config }, other: { root, token: 'other-project', coordinator: f.config },
    } }, protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'lab', slug: 'example/lab' },
      { repositoryId: '456', projectId: 'other', slug: 'example/other' }] }, coordinatorModelFactory: factory });
  t.after(() => server.close());
  const url = `${server.url}/api/workbench/projects/lab/api/coordinator/model`;
  for (const token of ['', 'synthetic-project']) {
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
  }
  const headers = { Authorization: 'Bearer synthetic-browser', 'Content-Type': 'application/json' };
  const response = await fetch(url, { headers }); assert.equal(response.status, 200, await response.clone().text());
  const initial = await response.json();
  assert.ok(!JSON.stringify(initial).includes('synthetic-private-marker')); assert.ok(!JSON.stringify(initial).includes(f.directory));
  const input = { id: 'http-switch', providerId: 'ds', baseVersion: initial.version };
  const denied = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: JSON.stringify(input) });
  assert.equal(denied.status, 403);
  const applied = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://workbench.example' }, body: JSON.stringify(input) });
  assert.equal(applied.status, 200, await applied.clone().text()); assert.equal((await applied.json()).selectedId, 'ds');
  const stale = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, id: 'stale-http' }) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT');
  const arbitrary = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, token: 'not-accepted' }) });
  assert.equal(arbitrary.status, 400);
  const other = await fetch(url.replace('/lab/', '/other/'), { headers }); assert.equal((await other.json()).selectedId, 'glm');
});
