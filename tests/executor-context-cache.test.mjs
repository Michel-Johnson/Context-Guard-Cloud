import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as context from '../scripts/shared/context-tree.mjs';
import { readJSON } from '../scripts/shared/io.mjs';
import { selectImpact } from '../.github/scripts/ci-impact.mjs';
import { createMemoryHandler, readMemoryView } from '../scripts/cloud/memory.mjs';
import { createMemoryReadViews, memoryReadViews } from '../scripts/cloud/memory-read-view.mjs';
import { createContextGenerationCache, contextCacheIdentity } from '../scripts/cloud/context-generation-cache.mjs';
import { projectMemoryFile, filesystemProjectDirectory, migrateProjectMemoryToFilesystemV2, writeProjectMemory } from '../scripts/cloud/memory-filesystem.mjs';

test('cache module and suite are covered by existing impact rules; unrelated docs do not select runtime jobs', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../.github/ci-impact.json', import.meta.url), 'utf8'));
  const select = changedPaths => selectImpact({ config, eventName: 'pull_request', changedPaths });
  const module = select(['scripts/cloud/context-generation-cache.mjs']);
  assert.equal(module.full, false); assert.deepEqual(module.unmatchedPaths, []);
  assert.deepEqual(module.jobs, { test: true, 'minimum-runtime': true, slack: false, browser: true, package: true });
  assert.equal(select(['tests/executor-context-cache.test.mjs']).jobs.test, true);
  assert.ok(Object.values(select(['AGENTS.md']).jobs).every(value => value === false));
});

const SESSION = 'executor';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function state(bodyChars = 100) {
  const node = (id, title) => ({ id, title, kind: 'work', purpose: title, children: [], memories: [], bugs: [], todos: [], ideas: [], memoryDocument: '合成正文'.repeat(Math.ceil(bodyChars / 4)).slice(0, bodyChars) });
  const a = node('A', '相同名字'), b = node('B', '相同名字'), c = node('C', '关联模块');
  a.bugs = [{ id: 'B1', title: '自己的 Bug', sessions: [SESSION, 'other'] }, { id: 'B2', title: '其他事项', sessions: ['other'] }];
  a.todos = [{ id: 'T1', title: '自己的 Todo', target_session: SESSION, also: ['C'] }];
  a.ideas = [{ id: 'I1', title: '禁止 Idea' }];
  b.access = [{ agentId: 'agent-b', allow: 'none' }];
  c.access = [{ agentId: SESSION, allow: 'read' }];
  const root = { ...node('ROOT', '项目'), kind: 'module', children: [a, b, c], flows: [{ from: 'ROOT', to: 'B', label: '根关联' }] };
  return { revision: 1, main: { version: 'v1', mainSha: 'a'.repeat(40), memory: { map: { v: 1, project: '合成项目', root,
    flows: [{ from: 'A', to: 'B', label: '调用' }], unassigned_bugs: [{ id: 'B3', title: '不应暴露' }] },
    records: { 'bugs/B1.md': '完整 Bug 正文', 'fixes/B1.md': '完整修复正文', 'bugs/B2.md': '他人正文', 'todos/T1.md': '完整 Todo 正文', 'FIND.md': '旧索引' } } },
    sessions: { executor: { version: 's1', memory: { map: { root: node('SESSION', '独立 Session') }, records: {} } } },
    events: [{ payload: '独立事件' }], eventCursors: {}, history: [], receipts: {}, closedSessions: {}, preferences: null };
}
const scoped = (value, agentId = SESSION, grants) => context.contextDocument(value.main, { sessionId: SESSION, agentId, ...(grants ? { grants } : {}) });
const prepared = value => {
  const snapshot = scoped(value);
  return { snapshot, lookup: typeof context.prepareContextLookup === 'function' ? context.prepareContextLookup(snapshot) : null };
};
const navigation = record => context.publicContextTree(context.buildContextTree(record.snapshot));
const input = (build, extra = {}) => ({ key: 'key', scopeKey: 'scope', sourceStamp: 'g1', isCurrent: async () => true, build, ...extra });
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, { maxBytes, cache, v2 = false } = {}) {
  const dataDir = await directory(t);
  let value = state();
  const configuration = { dataDir, adminToken: 'synthetic-admin', projects: { project: { token: 'synthetic-project' } } };
  await writeProjectMemory(memoryReadViews, dataDir, 'project', value);
  if (v2) await migrateProjectMemoryToFilesystemV2(dataDir, 'project');
  const auth = { allowed: true, agentId: SESSION, permissionIdentity: 'permission-a', calls: 0, unknown: false };
  const contextCache = cache || createContextGenerationCache(maxBytes ? { maxBytes } : {});
  const handler = createMemoryHandler(configuration, { contextCache, authorizeDevice: async ({ credential, projectId, sessionId }) => {
    auth.calls++;
    return auth.allowed && credential === 'synthetic-device' && projectId === 'project' && sessionId === SESSION
      ? auth.unknown ? {} : { agentId: auth.agentId, permissionIdentity: auth.permissionIdentity, grants: auth.grants } : false;
  } });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  server.requestTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const get = async (params = {}, token = 'synthetic-device', method = 'GET') => {
    const query = new URLSearchParams({ session: SESSION, ...params });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/projects/project/context?${query}`, {
      method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const update = async mutate => { value = structuredClone(value); mutate(value); value.revision++; await writeProjectMemory(memoryReadViews, dataDir, 'project', value); };
  return { dataDir, configuration, auth, contextCache, handler, get, update, value: () => value };
}

test('cache smoke 01: full shared response shape retains records, flows and also without Ideas or other Session items', async t => {
  const f = await fixture(t);
  const expected = scoped(f.value());
  for (const id of ['ROOT', 'A', 'B', 'C']) {
    const got = await f.get({ node: id });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.content, context.contextSlice(expected, id));
  }
  const a = (await f.get({ node: 'A' })).body.content;
  assert.deepEqual(a.records, { 'bugs/B1.md': '完整 Bug 正文', 'fixes/B1.md': '完整修复正文', 'todos/T1.md': '完整 Todo 正文' });
  assert.doesNotMatch(JSON.stringify(a), /他人正文|其他事项|禁止 Idea/);
  assert.equal(a.node.children, undefined);
});

test('cache smoke 02: all nodes and navigation match shared filtering for two raw agent identities in one Session', async t => {
  const f = await fixture(t);
  for (const actor of [SESSION, 'agent-b']) {
    f.auth.agentId = actor;
    const expected = scoped(f.value(), actor);
    assert.deepEqual((await f.get()).body.tree, context.publicContextTree(context.buildContextTree(expected)));
    for (const id of ['ROOT', 'A', 'B', 'C']) {
      const got = await f.get({ node: id });
      if (actor === 'agent-b' && id === 'B') assert.equal(got.status, 404);
      else assert.deepEqual(got.body.content, context.contextSlice(expected, id));
    }
  }
  assert.equal(f.contextCache.stats().preparedEntries, 2);
  assert.equal(f.auth.calls, 10);
});

test('cache smoke 03: caller mutation is isolated; Main frozen; hot HTTP performs zero full-view clones', async t => {
  const f = await fixture(t, { v2: true });
  await f.get();
  const before = memoryReadViews.stats().fullClones;
  const received = await f.get({ node: 'A' });
  received.body.content.node.title = 'CALLER';
  received.body.content.records['bugs/B1.md'] = 'CALLER';
  assert.equal((await f.get({ node: 'A' })).body.content.node.title, '相同名字');
  assert.equal(memoryReadViews.stats().fullClones, before);
  const clone = await readMemoryView(f.configuration, 'project');
  clone.main.memory.map.root.title = 'CALLER'; clone.sessions.executor.version = 'CALLER'; clone.events.push({});
  const reread = await readMemoryView(f.configuration, 'project');
  assert.equal(reread.main.memory.map.root.title, '项目'); assert.equal(reread.sessions.executor.version, 's1'); assert.equal(reread.events.length, 1);
  const selection = await memoryReadViews.readMain(projectMemoryFile(f.dataDir, 'project'), {});
  assert.equal(selection.state.sessions, undefined); assert.equal(selection.state.events, undefined);
  assert.ok(Object.isFrozen(selection.state.main.memory.map.root));
  assert.throws(() => { selection.state.main.memory.map.root.title = 'MUTATE'; });
});

test('cache smoke 04: every request reauthorizes and cache never hides revoke, version conflict or reauthorization', async t => {
  const f = await fixture(t); await f.get({ node: 'A' });
  f.auth.allowed = false; assert.equal((await f.get({ node: 'A' })).status, 401);
  f.auth.allowed = true;
  await f.update(value => { value.main.version = 'v2'; value.main.memory.map.root.children[0].access = [{ agentId: SESSION, allow: 'none' }]; });
  assert.equal((await f.get({ node: 'ROOT', version: 'v1' })).status, 409);
  assert.equal((await f.get({ node: 'A' })).status, 404);
  f.auth.agentId = 'agent-b'; f.auth.permissionIdentity = 'permission-b';
  assert.equal((await f.get({ node: 'A' })).status, 200);
  assert.equal((await f.get({ session: 'other' })).status, 401);
  assert.equal((await f.get({}, 'synthetic-device', 'POST')).status, 405);
  assert.equal(f.auth.calls, 6);
});

test('cache smoke 05: unknown identity rebuilds on every node/navigation request', async t => {
  const f = await fixture(t); f.auth.unknown = true;
  for (let i = 0; i < 2; i++) { assert.equal((await f.get({ node: 'A' })).status, 200); assert.equal((await f.get()).status, 200); }
  const stats = f.contextCache.stats();
  assert.equal(stats.builds, 4); assert.equal(stats.unknownIdentity, 4); assert.equal(stats.entries, 0);
});

test('cache smoke 06: malformed, control, oversized or credential-containing identities are not retained', async t => {
  const f = await fixture(t);
  for (const identity of [{ unknown: true }, '', 'x'.repeat(300), 'bad\u0000identity', 'prefix-synthetic-device-suffix']) {
    f.auth.permissionIdentity = identity;
    assert.equal((await f.get({ node: 'A' })).status, 200); assert.equal((await f.get({ node: 'A' })).status, 200);
  }
  assert.equal(f.contextCache.stats().unknownIdentity, 10); assert.equal(f.contextCache.stats().entries, 0);
  const base = { projectId: 'project', sessionId: SESSION, agentId: SESSION, binding: { agentId: SESSION }, credential: 'synthetic-device' };
  assert.notEqual(contextCacheIdentity(base).scopeKey, contextCacheIdentity({ ...base, binding: { agentId: SESSION, permissionIdentity: 'main-acl' } }).scopeKey);
  assert.notEqual(contextCacheIdentity(base).scopeKey, contextCacheIdentity({ ...base, admin: true }).scopeKey);
});

test('cache smoke 07: root denial and unavailable precede stale-version 409; authentication still comes first', async t => {
  const f = await fixture(t); await f.get();
  await f.update(value => { value.main.version = 'v2'; value.main.memory.map.root.access = [{ agentId: SESSION, allow: 'none' }]; });
  assert.equal((await f.get({ node: 'ROOT', version: 'v1' })).status, 403);
  f.auth.allowed = false; assert.equal((await f.get({ version: 'v1' })).status, 401); f.auth.allowed = true;
  await f.update(value => { value.main = null; });
  assert.equal((await f.get({ version: 'v1' })).status, 503);
});

test('cache smoke 08: external same-version ACL replace invalidates context; projection repair retains every Session', async t => {
  const f = await fixture(t, { v2: true }); await f.get();
  const file = projectMemoryFile(f.dataDir, 'project'), replacement = structuredClone(f.value());
  replacement.revision++; replacement.main.memory.map.root.children[0].access = [{ agentId: SESSION, allow: 'none' }];
  const temp = file + '.synthetic-replace'; await fs.writeFile(temp, JSON.stringify(replacement)); await fs.rename(temp, file);
  assert.equal((await f.get({ node: 'A' })).status, 404);
  const root = filesystemProjectDirectory(f.dataDir, 'project');
  await fs.rm(path.join(root, 'content'), { recursive: true, force: true });
  assert.equal((await f.get({ node: 'ROOT' })).status, 200);
  const metadata = await readJSON(path.join(root, 'content', 'storage.json'));
  assert.equal(metadata.revision, replacement.revision); assert.equal(metadata.sessions.executor.version, 's1');
  assert.ok((await fs.readFile(path.join(root, 'content', 'sessions', metadata.sessions.executor.directory, 'memory.md'), 'utf8')).length > 0);
});

test('cache smoke 09: failed atomic replacement cannot fake a new read generation', async t => {
  const f = await fixture(t); await f.get();
  const file = projectMemoryFile(f.dataDir, 'project'), before = await fs.readFile(file);
  const bad = structuredClone(f.value()); bad.main.version = 'not-committed';
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === file) throw Object.assign(new Error('synthetic replacement failure'), { code: 'EIO' }); return rename(from, to); };
  try { await assert.rejects(writeProjectMemory(memoryReadViews, f.dataDir, 'project', bad), /synthetic replacement failure/); }
  finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await f.get({ node: 'ROOT' })).body.version, 'v1');
});

test('cache smoke 10: corrupt cold read never returns a cached successful body', async t => {
  const f = await fixture(t); await f.get({ node: 'ROOT' });
  const file = projectMemoryFile(f.dataDir, 'project'), saved = await fs.readFile(file);
  await fs.writeFile(file, '{invalid');
  assert.equal((await f.get({ node: 'ROOT' })).status, 500);
  await fs.writeFile(file, saved);
  assert.equal((await f.get({ node: 'ROOT' })).status, 200);
});

test('cache smoke 11: concurrent cold reads singleflight both admission and navigation', async t => {
  const f = await fixture(t);
  const got = await Promise.all(Array.from({ length: 20 }, () => f.get()));
  assert.ok(got.every(value => value.status === 200)); assert.ok(got.every(value => JSON.stringify(value.body) === JSON.stringify(got[0].body)));
  assert.equal(f.contextCache.stats().builds, 1); assert.equal(f.contextCache.stats().navigationBuilds, 1); assert.equal(f.auth.calls, 20);
  const file = projectMemoryFile(f.dataDir, 'project'); let reads = 0;
  const views = createMemoryReadViews({ read: async (...args) => { reads++; return readJSON(...args); } });
  const selected = await Promise.all(Array.from({ length: 20 }, () => views.readMain(file, {})));
  assert.equal(reads, 1); assert.ok(selected.every(item => Object.isFrozen(item.state.main)));
});

test('cache smoke 12: fixed core optional prepared capability and original two-argument slicing are equivalent; binding.grants adds no semantics', async t => {
  const f = await fixture(t); f.auth.grants = ['ROOT'];
  assert.equal((await f.get({ node: 'A' })).status, 200);
  for (const grants of [undefined, ['ROOT', 'A', 'C']]) {
    const snapshot = scoped(f.value(), SESSION, grants);
    const lookup = typeof context.prepareContextLookup === 'function' ? context.prepareContextLookup(snapshot) : null;
    for (const id of grants || ['ROOT', 'A', 'B', 'C']) assert.deepEqual(context.contextSlice(snapshot, id, lookup), context.contextSlice(snapshot, id));
  }
});

test('cache smoke 13: late admission and late navigation cannot pollute the new generation', async () => {
  const cache = createContextGenerationCache(); let current = 'old'; const gate = deferred();
  const old = cache.get(input(async () => { await gate.promise; return prepared(state()); }, { key: 'old', sourceStamp: 'old', isCurrent: async () => current === 'old' }));
  await new Promise(resolve => setImmediate(resolve)); current = 'new';
  const nextState = state(); nextState.main.version = 'v2';
  const next = await cache.get(input(() => prepared(nextState), { key: 'new', sourceStamp: 'new' }));
  gate.resolve(); await old;
  assert.equal((await cache.get(input(() => { throw new Error('new cache poisoned'); }, { key: 'new', sourceStamp: 'new' }))).snapshot.version, 'v2');
  assert.equal(cache.stats().entries, 1); assert.ok(cache.stats().staleBuilds > 0);
  cache.clear(); current = 'old';
  const oldRecord = await cache.get(input(() => prepared(state()), { key: 'old', sourceStamp: 'old', isCurrent: async () => current === 'old' }));
  const navGate = deferred();
  const oldNav = cache.navigation(oldRecord, async () => { await navGate.promise; return navigation(oldRecord); });
  current = 'new'; const fresh = await cache.get(input(() => prepared(nextState), { key: 'new', sourceStamp: 'new' }));
  await cache.navigation(fresh, () => navigation(fresh)); navGate.resolve(); assert.equal((await oldNav).version, 'v1');
  assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().navigationEntries, 1);
});

test('cache smoke 14: entry and logical-byte budgets independently bound retained contexts and raw views', async t => {
  const cache = createContextGenerationCache({ maxEntries: 1, maxBytes: 100000 });
  for (let i = 0; i < 4; i++) await cache.get(input(() => prepared(state()), { key: 'key' + i, scopeKey: 'scope' + i }));
  assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().evictions, 3);
  assert.ok(cache.stats().peakBytes <= 100000); assert.equal(cache.stats().peakEntries, 1);
  const tiny = createContextGenerationCache({ maxBytes: 1 }); await tiny.get(input(() => prepared(state()))); assert.equal(tiny.stats().entries, 0);
  const root = await directory(t), file = path.join(root, 'state.json'); await fs.writeFile(file, JSON.stringify(state()));
  const views = createMemoryReadViews({ maxBytes: 1 }); assert.equal((await views.readMain(file, {})).state.main.version, 'v1'); assert.equal(views.stats().entries, 0);
  assert.equal((await views.read(file, {})).main.version, 'v1'); assert.equal(views.stats().bytes, 0);
});

test('cache smoke 15: selector recycle and pending read/write preserve source identity without stale slot updates', async t => {
  const root = await directory(t), file = path.join(root, 'state.json'), other = path.join(root, 'other.json');
  await fs.writeFile(file, JSON.stringify(state())); await fs.copyFile(file, other);
  const views = createMemoryReadViews({ maxEntries: 1 }); const first = await views.readMain(file, {}); await views.readMain(other, {});
  assert.equal(await first.isCurrent(), false);
  const renewed = await views.readMain(file, {}); assert.equal(first.stamp, renewed.stamp); assert.notEqual(first.generation, renewed.generation);
  const begin = deferred(), release = deferred(); let initial = true;
  const racing = createMemoryReadViews({ read: async (...args) => { if (initial) { initial = false; begin.resolve(); await release.promise; } return readJSON(...args); } });
  const pending = racing.readMain(file, {}); await begin.promise;
  const next = state(); next.main.version = 'v2'; await racing.write(file, next); release.resolve();
  const old = await pending; assert.equal(await old.isCurrent(), false);
  const latest = await racing.readMain(file, {}); assert.equal(latest.state.main.version, 'v2'); assert.equal(await latest.isCurrent(), true);
});

test('cache smoke 16: HTTP build paused across write cannot overwrite the latest cached version', async t => {
  const cache = createContextGenerationCache(), begin = deferred(), release = deferred(); let pause = true;
  const injected = { ...cache, get: args => cache.get({ ...args, build: async () => { if (pause) { begin.resolve(); await release.promise; } return args.build(); } }) };
  const f = await fixture(t, { cache: injected }); const earlier = f.get({ node: 'ROOT' }); await begin.promise;
  await f.update(value => { value.main.version = 'v2'; value.main.memory.map.root.memoryDocument = 'NEW'; }); pause = false;
  assert.equal((await f.get({ node: 'ROOT' })).body.version, 'v2'); release.resolve(); assert.equal((await earlier).body.version, 'v1');
  assert.equal((await f.get({ node: 'ROOT' })).body.content.node.memoryDocument, 'NEW'); assert.equal(cache.stats().entries, 1);
});

test('cache smoke 17: oversize same-generation marker retains no body/lookup, avoids repeated sizing and readmits a smaller generation', async () => {
  const cache = createContextGenerationCache({ maxBytes: 10000 }); const large = state(10000); let current = 'g1';
  const get = (value, stamp) => cache.get(input(() => prepared(value), { key: stamp, sourceStamp: stamp, isCurrent: async () => current === stamp }));
  const first = await get(large, 'g1'); assert.equal(first.admission, 'oversized');
  for (let i = 0; i < 5; i++) { const marker = await get(large, 'g1'); assert.equal(marker.snapshot, null); assert.equal(marker.lookup, null); }
  assert.equal(cache.stats().builds, 1); assert.equal(cache.stats().oversizedHits, 5); assert.equal(cache.stats().markers, 1);
  current = 'g2'; assert.equal((await get(state(), 'g2')).admission, 'prepared'); assert.equal(cache.stats().markers, 0);
});

test('cache smoke 18: marker eviction, small navigation admission and oversize navigation share the same budgets', async () => {
  const cache = createContextGenerationCache({ maxEntries: 1, maxBytes: 10000 });
  for (let i = 0; i < 4; i++) await cache.get(input(() => prepared(state(10000)), { key: 'key' + i, scopeKey: 'scope' + i }));
  assert.equal(cache.stats().markers, 1); assert.equal(cache.stats().evictions, 3);
  const marker = await cache.get(input(() => { throw new Error('marker rebuilt'); }, { key: 'key3', scopeKey: 'scope3' }));
  const expected = context.publicContextTree(context.buildContextTree(scoped(state(10000))));
  assert.deepEqual(await cache.navigation(marker, () => expected), expected); assert.equal(cache.stats().navigationEntries, 1);
  const tiny = createContextGenerationCache({ maxBytes: 1000 }); const rejected = await tiny.get(input(() => prepared(state(10000))));
  assert.deepEqual(await tiny.navigation(rejected, () => expected), expected); assert.equal(tiny.stats().markers, 1); assert.equal(tiny.stats().navigationEntries, 0);
  assert.ok(tiny.stats().peakBytes <= 1000);
});

test('cache smoke 19: late oversized marker/navigation and close cannot replace the current small admission', async () => {
  const cache = createContextGenerationCache({ maxBytes: 10000 }), gate = deferred(); let current = 'old';
  const old = cache.get(input(async () => { await gate.promise; return prepared(state(10000)); }, { key: 'old', sourceStamp: 'old', isCurrent: async () => current === 'old' }));
  await new Promise(resolve => setImmediate(resolve)); current = 'new';
  await cache.get(input(() => prepared(state()), { key: 'new', sourceStamp: 'new' })); gate.resolve(); await old;
  assert.equal(cache.stats().markers, 0); assert.equal(cache.stats().preparedEntries, 1);
  cache.clear(); const record = await cache.get(input(() => prepared(state(10000)))); const navGate = deferred();
  const nav = cache.navigation(record, async () => { await navGate.promise; return navigation(record); }); cache.clear(); navGate.resolve(); await nav;
  assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().bytes, 0);
});

test('cache smoke 20: HTTP oversize node fallback preserves full body, cached navigation survives revoke/reauth and smaller generation admits', async t => {
  const f = await fixture(t, { maxBytes: 10000 }); await f.update(value => { value.main = state(10000).main; });
  const expected = context.contextSlice(scoped(f.value()), 'A');
  for (let i = 0; i < 3; i++) assert.deepEqual((await f.get({ node: 'A' })).body.content, expected);
  await f.get(); await f.get(); assert.equal(f.contextCache.stats().builds, 1); assert.equal(f.contextCache.stats().navigationBuilds, 1);
  assert.equal(f.contextCache.stats().preparedEntries, 0); assert.equal(f.contextCache.stats().markers, 1);
  f.auth.allowed = false; assert.equal((await f.get({ node: 'A' })).status, 401); f.auth.allowed = true;
  assert.deepEqual((await f.get({ node: 'A' })).body.content, expected);
  await f.update(value => { value.main = state().main; value.main.version = 'small'; });
  assert.equal((await f.get({ node: 'A' })).body.version, 'small'); assert.equal(f.contextCache.stats().preparedEntries, 1);
});

test('cache smoke 21: cache-only failures fall back; business admission/navigation failures propagate and clear pending for retry', async () => {
  const cache = createContextGenerationCache();
  await assert.rejects(cache.get(input(() => { throw new Error('business build'); })), /business build/);
  assert.equal(cache.stats().entries, 0);
  const expected = prepared(state());
  const failedSizing = await cache.get(input(() => ({ snapshot: expected.snapshot, lookup: { get size() { throw new Error('cache-only sizing'); } } })));
  assert.equal(failedSizing.snapshot.version, 'v1'); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().cacheFailures, 1);
  const failedFreshness = await cache.get(input(() => expected, { isCurrent: async () => { throw new Error('cache-only stat'); } }));
  assert.equal(failedFreshness.snapshot.version, 'v1'); assert.equal(cache.stats().entries, 0);
  const record = await cache.get(input(() => expected));
  await assert.rejects(cache.navigation(record, () => { throw new Error('business navigation'); }), /business navigation/);
  assert.deepEqual(await cache.navigation(record, () => navigation(record)), navigation(record));
  cache.clear(); const retry = await cache.get(input(() => expected));
  const before = JSON.stringify; JSON.stringify = value => { if (value?.nodes) throw new Error('cache-only navigation sizing'); return before(value); };
  try { assert.deepEqual(await cache.navigation(retry, () => navigation(retry)), navigation(retry)); }
  finally { JSON.stringify = before; }
  assert.equal(cache.stats().entries, 0); assert.ok(cache.stats().cacheFailures >= 3);
});

test('cache smoke 22: clear fences requests paused before slot insertion without deleting a newer admission', async () => {
  const cache = createContextGenerationCache(), entered = deferred(), release = deferred();
  const old = cache.get(input(() => prepared(state()), { isCurrent: async () => {
    entered.resolve(); await release.promise; return true;
  } }));
  await entered.promise; cache.clear();
  const latest = state(); latest.main.version = 'after-clear';
  const fresh = await cache.get(input(() => prepared(latest)));
  release.resolve(); const previous = await old;
  assert.equal(previous.snapshot.version, 'v1');
  assert.equal(cache.stats().entries, 1);
  assert.strictEqual(await cache.get(input(() => { throw new Error('must retain fresh admission'); })), fresh);
  assert.equal(fresh.snapshot.version, 'after-clear');
  cache.clear(); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().bytes, 0);
});

test('cache smoke 23: clear during final admission freshness cannot remove or overwrite the new slot', async () => {
  const cache = createContextGenerationCache(), entered = deferred(), release = deferred(); let calls = 0;
  const old = cache.get(input(() => prepared(state()), { isCurrent: async () => {
    if (++calls === 2) { entered.resolve(); await release.promise; }
    return true;
  } }));
  await entered.promise; cache.clear();
  const latest = state(); latest.main.version = 'after-final-check';
  const fresh = await cache.get(input(() => prepared(latest)));
  const bytes = cache.stats().bytes;
  release.resolve(); assert.equal((await old).snapshot.version, 'v1');
  assert.strictEqual(await cache.get(input(() => { throw new Error('new slot was lost'); })), fresh);
  assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().bytes, bytes);
});

test('cache smoke 24: clear during navigation freshness cannot erase a newer context', async () => {
  const cache = createContextGenerationCache(), entered = deferred(), release = deferred(); let calls = 0;
  const record = await cache.get(input(() => prepared(state()), { isCurrent: async () => {
    if (++calls === 3) { entered.resolve(); await release.promise; }
    return true;
  } }));
  const oldNavigation = cache.navigation(record, () => navigation(record));
  await entered.promise; cache.clear();
  const latest = state(); latest.main.version = 'after-navigation-check';
  const fresh = await cache.get(input(() => prepared(latest)));
  release.resolve(); assert.equal((await oldNavigation).version, 'v1');
  assert.strictEqual(await cache.get(input(() => { throw new Error('new context was erased'); })), fresh);
  assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().navigationEntries, 0);
  assert.equal((await cache.navigation(fresh, () => navigation(fresh))).version, 'after-navigation-check');
});
