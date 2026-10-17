import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDashboardServer, loadSharedDashboard } from '../server.mjs';

const options = process.env.DASHBOARD_TEST_SHARED_CHECKOUT ? { sharedCheckout: process.env.DASHBOARD_TEST_SHARED_CHECKOUT } : {};
const origin = 'https://dashboard-fixture.example';
async function fixture(t) {
  const shared = await loadSharedDashboard(options);
  const { Store } = await import(pathToFileURL(join(shared.moduleRoot, 'src/store.mjs')).href);
  const dir = await mkdtemp(join(tmpdir(), 'cloud-dashboard-'));
  const store = new Store(dir);
  let providerUser;
  const providerCalls = [];
  const instance = await createDashboardServer({
    dataDir: dir, webRoot: join(shared.moduleRoot, 'web'), ownerKey: 'fixture-owner-key',
    publicBaseUrl: origin, relay: null, feishuCli: '', jerryToolsEnabled: true,
    stalenessMs: { aging: 3600000, stale: 86400000 },
    feishuLogin: { appId: 'fixture-app', appSecret: 'synthetic-test-only', redirectUri: origin + '/auth/feishu/callback' },
  }, store, { ...options, workspaceServiceOptions: { fetch: async (url, request) => {
    providerCalls.push({ url, request });
    return Response.json(url.endsWith('/oauth/token') ? { access_token: 'synthetic-provider-token' }
      : { code: 0, data: { open_id: providerUser, tenant_key: 'fixture-tenant', name: providerUser } });
  } } });
  const childStores = [];
  t.after(async () => {
    instance.server.closeAllConnections();
    await new Promise(resolve => instance.server.close(resolve));
    for (const child of childStores) child.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...init });
  const json = async (path, init) => { const response = await request(path, init); return { status: response.status, data: await response.json() }; };
  const post = (path, body, headers = {}) => json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  async function start() {
    const response = await request('/auth/feishu/start');
    assert.equal(response.status, 302);
    return { state: new URL(response.headers.get('location')).searchParams.get('state'), cookie: response.headers.getSetCookie()[0].split(';')[0] };
  }
  async function login(name) {
    providerUser = name;
    const flow = await start();
    const response = await request('/auth/feishu/callback?code=fixture-code&state=' + flow.state + '&open_id=spoofed', { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 302);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('cgdash_session=')).split(';')[0];
    const session = (await json('/auth/session', { headers: { cookie } })).data;
    assert.equal(session.account.name, name, 'identity comes from provider user_info');
    const slug = session.ownWorkspace.slug;
    const headers = { cookie, origin, 'x-csrf-token': session.csrfToken };
    const space = instance.spaces.getBySlug(slug);
    const workspaceStore = new Store(space.config.dataDir); childStores.push(workspaceStore);
    workspaceStore.upsertProject({ id: 'shared-project', name: name + ' project' });
    workspaceStore.upsertTask({ id: 'shared-task', projectId: 'shared-project', taskKey: 'shared-task', title: name + ' task', status: 'done' });
    return { cookie, headers, slug, store: workspaceStore, space };
  }
  return { instance, store, request, json, post, login, start, providerCalls };
}

test('Feishu OAuth binds browser state, rejects replay, and uses server verified identity', async t => {
  const f = await fixture(t), flow = await f.start();
  for (const cookie of ['', flow.cookie.replace(/=.+$/, '=wrong-browser')]) {
    const response = await f.json('/auth/feishu/callback?code=fixture-code&state=' + flow.state, { headers: { cookie } });
    assert.equal(response.status, 400); assert.equal(response.data.error, 'OAUTH_STATE_INVALID');
  }
  assert.equal(f.providerCalls.length, 0);
  const user = await f.login('alice');
  assert.ok(user.slug.startsWith('u-'));
  const session = await f.json('/auth/session?workspace=' + user.slug, { headers: user.headers });
  assert.equal(session.data.canEdit, true);
  const cancel = await f.request('/auth/feishu/callback?error=access_denied&state=' + flow.state, { headers: { cookie: flow.cookie } });
  assert.equal(cancel.status, 400);
  const replay = await f.json('/auth/feishu/callback?code=fixture-code&state=' + flow.state, { headers: { cookie: flow.cookie } });
  assert.equal(replay.data.error, 'OAUTH_STATE_INVALID');
});

test('anonymous reads remain available; same IDs and owner mutations stay workspace scoped with CSRF', async t => {
  const f = await fixture(t), alice = await f.login('alice'), bravo = await f.login('bravo');
  for (const user of [alice, bravo]) {
    assert.equal((await f.request('/' + user.slug + '/')).status, 200);
    const snapshot = await f.json('/' + user.slug + '/api/snapshot');
    assert.equal(snapshot.status, 200); assert.equal(snapshot.data.projects.length, 1);
    assert.equal(snapshot.data.projects[0].tasks[0].title, user === alice ? 'alice task' : 'bravo task');
  }
  const malformed = await f.json('/' + alice.slug + '/api/snapshot', { headers: { cookie: 'dashboardToken=%E0%A4%A; cgdash_session=%E0%A4%A' } });
  assert.equal(malformed.status, 200, 'malformed untrusted cookies remain anonymous');
  assert.equal((await f.json('/auth/session', { headers: { cookie: 'cgdash_session=%E0%A4%A' } })).data.authenticated, false);
  assert.equal((await f.request('/api/health')).status, 200, 'malformed credentials do not terminate the service');
  const edit = { page: 'task/shared-task', expectedVersion: 1, action: 'update', data: { title: 'Alice edited' }, operationId: 'fixture-owner-edit' };
  const path = '/' + alice.slug + '/api/jerry/v1/edit';
  for (const headers of [{}, { cookie: alice.cookie }, { ...alice.headers, origin: 'https://cross-origin.example' }, { ...alice.headers, 'x-csrf-token': 'wrong' }, bravo.headers]) {
    assert.equal((await f.post(path, edit, headers)).status, 403);
  }
  assert.equal((await f.post(path, edit, alice.headers)).status, 200);
  assert.equal(alice.store.getTask('shared-task').title, 'Alice edited');
  assert.equal(bravo.store.getTask('shared-task').title, 'bravo task');
  assert.equal((await f.post('/auth/logout', {}, { cookie: alice.cookie })).status, 403);
  assert.equal((await f.post('/auth/logout', {}, alice.headers)).status, 200);
  assert.equal((await f.json('/auth/session', { headers: alice.headers })).data.authenticated, false);
});

test('report-only PAT cannot edit Jerry, cross workspaces, or read recipient inbox; revocation works', async t => {
  const f = await fixture(t), alice = await f.login('alice'), bravo = await f.login('bravo');
  assert.equal((await f.post('/auth/tokens', { name: 'fixture-token' }, { cookie: alice.cookie })).status, 403);
  const token = await f.post('/auth/tokens', { name: 'fixture-token' }, alice.headers);
  assert.equal(token.status, 201); assert.deepEqual(token.data.scopes, ['dashboard:report']);
  const bearer = { authorization: 'Bearer ' + token.data.token, 'x-dashboard-skill-version': '1.0.0' };
  const report = { project: 'ingested', projectName: 'Fixture ingest', taskKey: 'session-fixture-report', title: 'Fixture report', status: 'in_progress', sourceObservedAt: new Date().toISOString(), expectedVersion: 0, opId: 'fixture-report-01' };
  const path = '/' + alice.slug + '/api/dashboard/v1/report';
  const ingested = await f.post(path, report, bearer);
  assert.equal(ingested.status, 200, JSON.stringify(ingested.data));
  for (const slug of [bravo.slug, 'jerry']) assert.equal((await f.post('/' + slug + '/api/dashboard/v1/report', report, bearer)).status, 403);
  assert.equal((await f.post('/' + alice.slug + '/api/jerry/v1/edit', { page: 'task/shared-task', expectedVersion: 1, action: 'update', data: { title: 'Forbidden PAT edit' }, operationId: 'fixture-pat-edit' }, bearer)).status, 403);
  assert.equal((await f.json('/' + alice.slug + '/api/inbox/messages', { headers: bearer })).status, 403);
  assert.equal(alice.store.getTask('shared-task').title, 'alice task');
  assert.equal(bravo.store.getProject('ingested'), null); assert.equal(f.store.getProject('ingested'), null);
  assert.equal((await f.json('/auth/tokens/' + token.data.id, { method: 'DELETE', headers: alice.headers })).status, 200);
  assert.equal((await f.post(path, { ...report, opId: 'fixture-revoked' }, bearer)).status, 403);
});
