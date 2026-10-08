import '../.github/scripts/test-environment.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createWorkbenchPasswordHash, startCloudServer } from '../scripts/cloud/server.mjs';
import { completeSessionMemory, readMemoryView } from '../scripts/cloud/memory.mjs';
import { legacyProjectMemoryFile } from '../scripts/cloud/memory-filesystem.mjs';

const execFileAsync = promisify(execFile);
const git = async (root, ...args) => (await execFileAsync('git', args, { cwd: root, windowsHide: true })).stdout.trim();
const controlsOnly = process.argv.includes('--controls-only');
const output = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) || `output/playwright/browser-ci/cloud-${Date.now()}-${randomUUID()}`);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-guard-cloud-browser-'));
const repository = path.join(dataDir, 'repository');
const memoryConfig = {
  dataDir: path.join(dataDir, 'memory'),
  adminToken: 'memory-admin',
  projects: { 'context-guard': { token: 'project-memory-token', root: repository, ref: 'refs/heads/main' } },
};
const mainMap = {
  v: 1,
  project: 'Context Guard',
  bootstrap: 'ready',
  flows: [],
  root: { id: 'T0', title: 'Main map', purpose: 'published baseline', kind: 'module', state: 'dirty', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children: [
    { id: 'N1', title: 'Tour one', purpose: 'first tour node', kind: 'module', state: 'dirty', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children: [] },
    { id: 'N2', title: 'Tour two', purpose: 'second tour node', kind: 'module', state: 'dirty', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children: [] },
  ] },
};
// A valid legacy item may have no files field. Merely rendering it must not
// normalize that field into a Main write (B142).
mainMap.root.children[0].bugs=[{id:'B-readonly',title:'Readonly manual bug',status:'open',executionMode:'manual',sessions:[]}];
mainMap.root.memories = [{ id: 'M-old-root', text: 'Legacy project evidence <script>window.__legacyExecuted=true</script>', state: 'success',
  files: [{ path: 'docs/legacy-proof.md' }], proposalEvidence: { reason: 'Historical rationale', basis: 'code', files: ['module.mjs'] } }];
mainMap.root.children[0].memories = [{ id: 'M-old-node', text: 'Legacy node history', state: 'dirty', custom: { retained: true } }];
mainMap.root.children.push(...Array.from({ length: 16 }, (_, index) => ({ id: `tray-cancelled-${index}`, title: `Cancelled fixture ${index}`,
  kind: 'work', proposal: 'cancelled', state: 'dirty', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children: [] })));
const sessionMap = structuredClone(mainMap);
sessionMap.root.title = 'Session map';
sessionMap.root.purpose = 'private working state';

let service;
let browser;
let context;
let page;
let attachmentPage;
let passed = false;
let failAttachmentShare = true;
let attachmentUploads = 0;
const checks = [];
const record = name => { checks.push(name); console.log(`Cloud browser check passed: ${name}`); };
const synchronized = () => page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
const syncVersion = () => page.locator('#cg-sync-version').getAttribute('data-version');
const synchronizedAfter = version => page.waitForFunction(previous => {
  const panel = document.querySelector('#cg-sync');
  const current = document.querySelector('#cg-sync-version')?.dataset.version;
  return panel?.dataset.status === 'synced' && current && current !== previous;
}, version);
const headers = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
};
// Ordinary screenshot pages use local fallback fonts. Page routing disables
// HTTP cache: call after cache acceptance and never on the held-font test page.
const useScreenshotFallbackFonts = screenshotPage => screenshotPage.route(
  /^https:\/\/(?:fonts\.googleapis\.com\/css2(?:\?|$)|fonts\.gstatic\.com\/)/,
  route=>route.abort(),
);

// Real browser -> authenticated HTTP -> Coordinator -> durable state. Only the
// paid model provider and one deliberately lost HTTP request are controlled.
async function coordinatorControlAcceptance() {
  const directory = path.join(dataDir, 'control-acceptance'), providerFile = path.join(directory, 'provider.json');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(providerFile, JSON.stringify({ model: 'fixture-model', token: 'synthetic', baseUrl: 'https://fixture.invalid' }));
  await fs.writeFile(path.join(directory, 'projects.json'), JSON.stringify({ v: 2, projects: [{ id: 'control-fixture', name: 'Control fixture' }] }));
  const memory = { dataDir: path.join(directory, 'memory'), adminToken: 'fixture-memory-admin', projects: {
    'control-fixture': { root: directory, ref: 'refs/heads/main', token: 'fixture-project',
      coordinator: { enabled: true, providerFile, bindings: {}, mapWrite: true } },
  } };
  const file = legacyProjectMemoryFile(memory.dataDir, 'control-fixture');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ revision: 1, main: { version: 'control-main', memory: { records: {}, map: {
    project: 'Control fixture', bootstrap: 'ready', root: { id: 'T0', title: 'Controls', kind: 'module', state: 'dirty', owns: [], children: [
      { id: 'N1', title: 'Login', kind: 'module', state: 'dirty', owns: [], memoryDocument: 'BROWSER-DURABLE-FOCUS-MEMORY', children: [] },
    ] },
  } } }, sessions: {}, closedSessions: {}, receipts: {}, history: [], events: [], eventCursors: {} }));
  const held = new Set(), errors = [], modelInputs = []; let heldGenerations = 0, cloud, fixtureContext, fixturePage;
  try {
    cloud = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir: directory, memoryConfig: memory,
      browserToken: 'fixture-browser', browserPasswordHash: await createWorkbenchPasswordHash('control-password'), privateAccess: true,
      protocolConfig: { repositories: [{ repositoryId: '123', projectId: 'control-fixture', slug: 'example/control-fixture' }] },
      coordinatorModelFactory: () => ({ model: 'fixture-model', next: async input => {
        modelInputs.push(input); const text = input.messages.at(-1)?.content;
        if ((text === '开始停止测试' || text === '第一行补充\n第二行补充') && heldGenerations < 2) {
          heldGenerations++; await input.onText('已经输出的完整段落。\n\n正在生成的尾段');
          return new Promise((resolve, reject) => {
            const release = () => { held.delete(release); resolve({ stop: 'end_turn', content: [{ type: 'text', text: 'completed' }] }); };
            held.add(release);
            input.signal.addEventListener('abort', () => { held.delete(release); reject(input.signal.reason); }, { once: true });
          });
        }
        if (text === '记住登录节点') return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'browser-mount', name: 'mount_conversation',
          input: { nodeId: 'N1', kind: 'todo', title: 'Login discussion', description: 'Keep login focus', mainVersion: 'control-main' } }] };
        return { stop: 'end_turn', content: [{ type: 'text', text: '已继续当前讨论。' }] };
      } }) });
    fixtureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    fixturePage = await fixtureContext.newPage(); fixturePage.on('pageerror', error => errors.push(error.message));
    await fixturePage.goto(cloud.url + '/login?next=%2Fprojects%2Fcontrol-fixture');
    await fixturePage.getByLabel('密码').fill('control-password');
    await fixturePage.getByRole('button', { name: '登录', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
    await fixturePage.locator('#btn-coordinator').click();
    const panel = fixturePage.locator('#coordinator-panel'), input = panel.getByLabel('发送给 Coordinator');
    const before = await readMemoryView(memory, 'control-fixture');
    await input.fill('开始停止测试'); await panel.getByRole('button', { name: '发送', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value === '');
    await panel.getByRole('button', { name: '停止当前回复', exact: true }).waitFor();
    await panel.getByText('已经输出的完整段落。', { exact: true }).waitFor();
    await fixturePage.waitForFunction(() => {
      const send = document.querySelector('.coordinator-send.is-working-ready');
      return send && getComputedStyle(send.querySelector('canvas')).opacity === '1';
    });
    await panel.screenshot({ path: path.join(output, 'coordinator-click-stop-desktop.png') });
    await fixturePage.setViewportSize({ width: 390, height: 844 });
    await input.fill('第一行补充\n第二行补充');
    assert.equal(await panel.getByRole('button', { name: '发送', exact: true }).isEnabled(), true, 'A typed supplement still has a send action during generation');
    await fixturePage.waitForFunction(() => {
      const send = document.querySelector('.coordinator-send');
      return send && getComputedStyle(send.querySelector('svg')).opacity === '1' &&
        getComputedStyle(send.querySelector('canvas')).opacity === '0';
    });
    const alignment = await panel.locator('.coordinator-send').evaluate(send => {
      const box = send.getBoundingClientRect(), shell = send.parentElement.getBoundingClientRect(), arrow = send.querySelector('svg').getBoundingClientRect();
      return { bottom: shell.bottom - box.bottom, right: shell.right - box.right,
        center: [Math.abs((arrow.left + arrow.right - box.left - box.right) / 2), Math.abs((arrow.top + arrow.bottom - box.top - box.bottom) / 2)] };
    });
    assert.ok(Math.abs(alignment.bottom - 8) <= .25 && Math.abs(alignment.right - 8) <= .25, JSON.stringify(alignment));
    assert.ok(alignment.center.every(value => value <= .25), 'Mobile multi-line arrow is centered in a single grid cell');
    await panel.locator('.coordinator-input-shell').screenshot({ path: path.join(output, 'coordinator-arrow-multiline-mobile.png') });
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value === '');
    const generationDeadline = Date.now() + 5000;
    for (;;) {
      const state = await (await fixtureContext.request.get(cloud.url + '/api/workbench/projects/control-fixture/api/coordinator?conversation=main')).json();
      if (heldGenerations === 2 && state.status === 'running' && state.pendingInputCount === 0 && state.streamingText === '已经输出的完整段落。\n\n正在生成的尾段' &&
          state.messages.some(message => message.role === 'user' && message.text === '第一行补充\n第二行补充')) break;
      assert.ok(Date.now() < generationDeadline, 'The durable supplement must be consumed by the replacement generation');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(heldGenerations, 2, 'The supplement cancels and replaces the active generation before the stop test');
    assert.deepEqual(modelInputs[1].messages.filter(message => message.role === 'user').map(message => message.content), ['开始停止测试', '第一行补充\n第二行补充']);
    assert.ok(!JSON.stringify(modelInputs[1].messages).includes('已经输出的完整段落'), 'A superseded fragment is display history, not a complete model message');
    await input.fill('');
    await fixturePage.waitForFunction(() => {
      const send = document.querySelector('.coordinator-send.is-working-ready');
      return send && getComputedStyle(send.querySelector('canvas')).opacity === '1';
    });
    await panel.screenshot({ path: path.join(output, 'coordinator-click-stop-mobile.png') });
    const interruptRequests = [];
    await fixturePage.route(/\/api\/coordinator\/interrupt(?:\?|$)/, async route => {
      interruptRequests.push(route.request().postDataJSON());
      if (interruptRequests.length === 1) return route.abort(); // Not committed: retry must keep the original request ID.
      await route.continue();
    });
    await panel.getByRole('button', { name: '停止当前回复', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('停止结果尚未确认'));
    await panel.locator(':scope > [role=status]').evaluate(status => {
      status.__stopWarningWrites = 0;
      status.__stopWarningObserver = new MutationObserver(() => status.__stopWarningWrites++);
      status.__stopWarningObserver.observe(status, { childList: true });
    });
    await fixturePage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/coordinator') && response.request().method() === 'GET');
    await fixturePage.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.__stopWarningWrites > 0);
    assert.match(await panel.locator(':scope > [role=status]').textContent(), /停止结果尚未确认/,
      'A rendered Coordinator heartbeat must preserve uncertain stop outcome ahead of queued-input status');
    await panel.locator(':scope > [role=status]').evaluate(status => status.__stopWarningObserver.disconnect());
    await panel.getByRole('button', { name: '停止当前回复', exact: true }).click();
    await panel.getByText('本轮已停止，已有操作和部分回复已保留；点击重试可继续', { exact: true }).waitFor();
    assert.equal(interruptRequests.length, 2); assert.deepEqual(interruptRequests[0], interruptRequests[1]);
    const stateUrl = cloud.url + '/api/workbench/projects/control-fixture/api/coordinator?conversation=main';
    let state = await (await fixtureContext.request.get(stateUrl)).json();
    assert.equal(state.status, 'interrupted'); assert.equal(state.activeTurnId, interruptRequests[0].expectedTurnId);
    assert.equal(state.partialText, '已经输出的完整段落。\n\n正在生成的尾段');
    const partialIds = state.messages.filter(message => message.partial).map(message => message.id);
    assert.equal(partialIds.length, 2); assert.equal(new Set(partialIds).size, 2, 'Each canceled generation has exactly one distinct retained output');
    assert.equal(await panel.getByText(/部分回复（未完成）/).count(), 2, 'Superseded and explicitly stopped attempts both retain their visible fragments');
    assert.match(await panel.locator('.coordinator-messages').textContent(), /已经输出的完整段落/);
    await fixturePage.reload(); await fixturePage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
    await fixturePage.locator('#btn-coordinator').click();
    await panel.getByText(/部分回复（未完成）/).first().waitFor();
    assert.equal(await panel.getByText(/部分回复（未完成）/).count(), 2, 'Both retained attempts survive reload');
    assert.match(await panel.locator('.coordinator-messages').textContent(), /正在生成的尾段/);
    await panel.getByRole('button', { name: '重试原请求', exact: true }).click();
    await panel.getByText('已继续当前讨论。', { exact: true }).waitFor();
    await panel.getByText(/部分回复（未完成）/).first().waitFor();
    assert.equal(await panel.getByText('已经输出的完整段落。', { exact: true }).count(), 2,
      'Retry preserves one marked output per canceled generation, rather than hiding or duplicating it');
    state = await (await fixtureContext.request.get(stateUrl)).json();
    assert.deepEqual(state.messages.filter(message => message.partial).map(message => message.id), partialIds, 'Retry preserves the exact original output identities and ordering');
    await fixturePage.waitForFunction(() => document.querySelector('.coordinator-send')?.getAttribute('aria-label') === '发送');
    await input.fill('记住登录节点'); await panel.getByRole('button', { name: '发送', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('#coordinator-panel [data-conversation="main"]')?.textContent.includes('Login discussion'));
    state = await (await fixtureContext.request.get(stateUrl)).json();
    assert.equal(state.conversations.find(value => value.id === 'main').nodeId, 'N1');
    assert.deepEqual(await readMemoryView(memory, 'control-fixture'), before, 'Clicking stop and mounting focus never change Main or create an execution Session');
    await fixturePage.reload(); await fixturePage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
    await fixturePage.locator('#btn-coordinator').click();
    await input.fill('继续讨论'); await panel.getByRole('button', { name: '发送', exact: true }).click();
    await fixturePage.waitForFunction(() => document.querySelector('.coordinator-send')?.getAttribute('aria-label') === '发送');
    await panel.getByText(/部分回复（未完成）/).first().waitFor();
    assert.equal(await panel.getByText('已经输出的完整段落。', { exact: true }).count(), 2);
    state = await (await fixtureContext.request.get(stateUrl)).json();
    assert.deepEqual(state.messages.filter(message => message.partial).map(message => message.id), partialIds, 'New turns and another reload retain each original fragment exactly once');
    await panel.screenshot({ path: path.join(output, 'coordinator-partial-after-resume-new-turn-reload.png') });
    assert.ok(modelInputs.at(-1).system.includes('BROWSER-DURABLE-FOCUS-MEMORY'));
    assert.ok(!JSON.stringify(modelInputs.at(-1).messages).includes('已经输出的完整段落'), 'Aborted display history never enters later native model requests');
    assert.deepEqual(errors, []);
    record('CONTROL-01 real ink-click stop uses an idempotent original-turn request and preserves text across reload/resume');
    record('CONTROL-02 mobile multi-line send stays aligned; existing one-second ink and typed supplements remain');
    record('FOCUS-01 real Main mounting survives reload and supplies the saved node memory without Main/Session writes');
  } catch (error) {
    await fixturePage?.screenshot({ path: path.join(output, 'failure-coordinator-controls.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const release of held) release();
    await fixtureContext?.close(); await cloud?.close();
  }
}

try {
  if (!controlsOnly) {
  assert.deepEqual(await fs.readFile('prototype/vendor/marked.mjs'), await fs.readFile('node_modules/marked/lib/marked.esm.js'), 'vendor lexer must match the locked dependency');
  assert.deepEqual(await fs.readFile('licenses/Marked-MIT.txt'), await fs.readFile('node_modules/marked/LICENSE.md'), 'ship the upstream license unchanged');
  const markdownDependency=JSON.parse(await fs.readFile('package-lock.json','utf8')).packages['node_modules/marked'];
  assert.equal(markdownDependency.resolved, `https://registry.npmjs.org/marked/-/marked-${markdownDependency.version}.tgz`, 'CI must not depend on a developer-only package mirror');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Cloud Browser Test');
  await git(repository, 'config', 'user.email', 'cloud-browser@example.invalid');
  await fs.writeFile(path.join(repository, 'version.txt'), 'base\n');
  await git(repository, 'add', 'version.txt');
  await git(repository, 'commit', '-m', 'base');
  const baseSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', '-c', 'feature');
  await fs.writeFile(path.join(repository, 'version.txt'), 'feature\n');
  await git(repository, 'commit', '-am', 'feature');
  const featureSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', 'main');
  service = await startCloudServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    adminToken: 'cloud-admin',
    browserToken: 'browser-token',
    browserPasswordHash: await createWorkbenchPasswordHash('browser-password'),
    privateAccess: true,
    memoryConfig,
    attachmentProvider: {
      upload: async file => { attachmentUploads++; assert.ok((await fs.stat(file)).size > 9 * 1024 * 1024); return 'browser-fixture-file'; },
      share: async () => {
        if (failAttachmentShare) { failAttachmentShare = false; throw new Error('Synthetic share failure'); }
        return { url: 'https://pan.quark.cn/s/browserfixture', passcode: 'Ab12' };
      },
    },
  });
  const baselineSession = await request(`${service.url}/v1/projects/context-guard/sessions/baseline-session`, {
    method: 'POST',
    headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-baseline-session', baseVersion: null, baseMainVersion: null, sourceCommit: baseSha, memory: { map: mainMap, records: {} } }),
  });
  assert.equal(baselineSession.response.status, 200, JSON.stringify(baselineSession.body));
  await completeSessionMemory(memoryConfig, 'context-guard', { operationId: 'review-browser-baseline', sessionId: 'baseline-session', generation: 1, sessionVersion: baselineSession.body.snapshot.version, sourceCommit: baseSha }, { kind: 'human' });
  const baselinePublication = await request(`${service.url}/v1/projects/context-guard/publish`, {
    method: 'POST',
    headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-baseline-publish', baseVersion: null, sessionId: 'baseline-session', sessionVersion: baselineSession.body.snapshot.version, expectedMainSha: baseSha }),
  });
  assert.equal(baselinePublication.response.status, 200, JSON.stringify(baselinePublication.body));
  const seededMain = await request(`${service.url}/api/projects/context-guard/snapshot`, {
    method: 'POST',
    headers: headers('cloud-admin'),
    body: JSON.stringify({ baseVersion: null, operationId: 'browser-main-seed', document: mainMap }),
  });
  assert.equal(seededMain.response.status, 200, JSON.stringify(seededMain.body));
  const seededSession = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, {
    method: 'POST',
    headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-session-seed', baseVersion: null, baseMainVersion: baselinePublication.body.snapshot.version, sourceCommit: featureSha, memory: { map: sessionMap, records: { 'sessions.jsonl': JSON.stringify({ session_id: 'session-one', thread_name: '修复同步连接', platform: 'codex', event: 'session-start', at: '2026-09-06T00:00:00Z' }) } } }),
  });
  assert.equal(seededSession.response.status, 200, JSON.stringify(seededSession.body));

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  assert.equal((await fetch(`${service.url}/prototype/working-blot-atlas.png`)).status,401,'Ready ink atlas stays behind Cloud workbench authentication');
  // Cloud publication and cross-view reconciliation run on a 30-second cycle.
  // Keep assertions strict while allowing one complete authoritative refresh.
  page.setDefaultTimeout(35000);
  await page.goto(`${service.url}/projects/context-guard`);
  assert.equal(new URL(page.url()).pathname, '/login');
  await page.locator('input[name="password"]').fill('browser-password');
  await Promise.all([
    page.waitForURL(/\/projects\/context-guard$/),
    page.locator('button[type="submit"]').click(),
  ]);
  record('Unauthenticated users get a visible password login');
  const authCookie = (await page.context().cookies()).find(cookie => cookie.name === 'cg_workbench');
  assert.ok(authCookie?.httpOnly);
  assert.ok(authCookie?.expires > Date.now() / 1000 + 29 * 24 * 60 * 60);
  await synchronized(); // The first authenticated page must finish loading before testing a warm reload.
  await page.reload();
  assert.equal(new URL(page.url()).pathname, '/projects/context-guard');
  const warmedAssets = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => new URL(entry.name).pathname.startsWith('/assets/'))
    .map(entry => ({ path: new URL(entry.name).pathname, transferSize: entry.transferSize })));
  assert.ok(warmedAssets.some(entry => entry.path.endsWith('/workbench-app.js')), 'browser loads the versioned entry script');
  assert.ok(warmedAssets.some(entry => entry.path.endsWith('/workbench.css')), 'browser loads the versioned stylesheet');
  assert.ok(warmedAssets.filter(entry => /\/(?:workbench-app\.js|workbench\.css)$/.test(entry.path))
    .every(entry => entry.transferSize === 0), 'repeat visit uses the private browser cache for critical assets');
  const reopened = await page.context().newPage();
  await reopened.goto(`${service.url}/projects/context-guard`);
  assert.equal(new URL(reopened.url()).pathname, '/projects/context-guard');
  await reopened.close();
  record('Persistent cookie keeps login across refresh and a reopened page');
  await useScreenshotFallbackFonts(page);
  await synchronized();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Main map/);
  // A failed authoritative read must not load an unrelated static/local Map.
  const startupPage = await context.newPage();
  let fallbackReads = 0;
  await startupPage.route('**/.codex/context/map.json', route => { fallbackReads++; return route.fulfill({ json: sessionMap }); });
  await startupPage.route('**/api/state*', route => route.fulfill({ contentType: 'application/json', body: '{' }));
  let releaseFonts;
  const fontsHeld = new Promise(resolve => { releaseFonts = resolve; });
  await startupPage.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async route => { await fontsHeld; await route.abort(); });
  await startupPage.goto(`${service.url}/projects/context-guard`);
  await startupPage.locator('#cg-sync[data-status="error"]').waitFor({ state: 'attached' });
  assert.equal(fallbackReads, 0);
  assert.equal(await startupPage.getByText('Session map', { exact: true }).count(), 0);
  await startupPage.unroute('**/api/state*');
  await startupPage.locator('#btn-settings').click();
  await startupPage.locator('#cg-sync > summary').click();
  await startupPage.locator('#cg-sync-retry').click();
  await startupPage.locator('#cg-sync[data-status="synced"]').waitFor({ state: 'attached' });
  assert.match(await startupPage.locator('.node[data-id="T0"]').textContent(), /Main map/);
  releaseFonts();
  await startupPage.close();
  record('Failed startup preserves project authority; retry works while external fonts stall');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('rel-mode')), false);
  assert.equal(await page.locator('#btn-rel').getAttribute('aria-pressed'), 'false');
  await page.locator('#session-chip').click();
  assert.equal(await page.locator('#session-menu .session-option-name').filter({ hasText: '当前会话' }).count(), 0, 'Cloud overview/project pages have no actual current Session');
  assert.equal(await page.locator('#session-menu [data-session="session-one"]').count(), 0, 'idle historical Sessions stay out of the main working list');
  assert.doesNotMatch(await page.locator('#session-menu').textContent(), /session-one/);
  assert.doesNotMatch((await page.locator('#cg-sync-session option').allTextContents()).join(' '), /session-one/);
  await page.locator('#session-chip').click();
  record('Main is the default view');

  const tray = page.locator('#tray'), trayTrigger = page.locator('#btn-tray');
  const trayBaseline = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  let trayCommits = 0;
  const countTrayCommit = request => { if (request.method() === 'POST' && request.url().includes('/api/commit')) trayCommits++; };
  page.on('request', countTrayCommit);
  const openTray = async () => { await page.locator('#btn-settings').click(); await trayTrigger.click(); await tray.locator('#tray-close').waitFor(); };
  const closedTray = async () => {
    assert.equal(await tray.isVisible(), false);
    assert.equal(await trayTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trayTrigger.evaluate(button => button.classList.contains('on')), false);
  };
  await openTray();
  assert.equal(await trayTrigger.getAttribute('aria-controls'), 'tray');
  assert.equal(await trayTrigger.getAttribute('aria-expanded'), 'true');
  await tray.locator('[data-delete="tray-cancelled-0"]').click();
  await tray.locator('[data-delete-no]').click();
  assert.equal(await tray.isVisible(), true, 'internal confirmation controls do not dismiss the tray');
  await tray.locator('#tray-close').click();
  await closedTray();
  assert.equal(await page.locator('#btn-settings').evaluate(button => button === document.activeElement), true);
  await openTray();
  await tray.locator('#tray-list').evaluate(list => {
    const editor = document.createElement('input'); editor.id = 'tray-editor-fixture'; editor.value = '未保存草稿'; list.append(editor); editor.focus();
  });
  await page.keyboard.press('Escape');
  assert.equal(await tray.isVisible(), true, 'Escape in an editor belongs to the editor, not the tray');
  assert.equal(await tray.locator('#tray-editor-fixture').inputValue(), '未保存草稿');
  await tray.locator('#tray-close').focus();
  await page.keyboard.press('Escape');
  await closedTray();
  await openTray();
  await page.locator('#session-chip').click();
  await closedTray();
  await page.locator('#session-chip').click();
  await openTray();
  await page.locator('#viewport').click({ position: { x: 15, y: 300 } });
  await closedTray();
  await page.setViewportSize({ width: 390, height: 844 });
  await openTray();
  await tray.locator('#tray-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  const trayPhone = await tray.locator('#tray-close').evaluate(button => {
    const rect = button.getBoundingClientRect(), list = document.querySelector('#tray-list');
    return { visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
      hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
      listScrolled: list.scrollTop > 0, trayScrolled: document.querySelector('#tray').scrollTop };
  });
  assert.equal(trayPhone.visible && trayPhone.hit && trayPhone.listScrolled, true);
  assert.equal(trayPhone.trayScrolled, 0, 'only the list scrolls, never the close header');
  await page.screenshot({ path: path.join(output, 'cancelled-tray-phone.png'), fullPage: true });
  await tray.locator('#tray-close').click();
  await closedTray();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trayAfter = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  assert.equal(trayCommits, 0);
  assert.equal(trayAfter.body.snapshot.version, trayBaseline.body.snapshot.version);
  assert.deepEqual(trayAfter.body.snapshot.memory.map, trayBaseline.body.snapshot.memory.map);
  page.off('request', countTrayCommit);
  record('UI-TRAY-CLOSE-01: cancelled tray closes by button, Escape and outside clicks without Map writes; phone header stays reachable');

  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-show-other-sessions]').click();
  const otherSession = page.locator('#session-menu [data-session="session-one"]');
  assert.match(await otherSession.textContent(), /修复同步连接/);
  assert.equal(await otherSession.isDisabled(), false);
  await otherSession.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('session') === 'session-one'
    && document.querySelector('.node[data-id="T0"]')?.textContent?.includes('Session map'));
  await synchronized();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Session map/);
  assert.equal(new URL(page.url()).searchParams.get('session'), 'session-one');
  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-session="__all__"]').click();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('session')
    && document.querySelector('.node[data-id="T0"]')?.textContent?.includes('Main map'));
  await synchronized();
  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-show-other-sessions]').click();
  assert.equal(await page.locator('#session-menu [data-session="session-one"]').count(), 0);
  await page.locator('#session-chip').click();
  record('Opt-in other Session list opens the real map and returns to the working-only Main list');

  const unavailableSession = 'registered-without-snapshot';
  const otherAccessRoute = '**/api/access?*';
  await page.route(otherAccessRoute, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.push({ id: unavailableSession, name: '尚未同步的会话', platform: 'claude', status: 'offline', bindingState: 'bound' });
    body.sessions.push({ id: 'other-stale', name: '绑定失效会话', status: 'offline', bindingState: 'stale' });
    body.sessions.push({ id: 'other-closed', name: '已关闭会话', status: 'closed', bindingState: 'closed' });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await synchronized();
  const beforeMissingVersion = await syncVersion(), beforeMissingUrl = page.url();
  let missingSwitchCommits = 0;
  const countMissingCommits = request => { if (request.method() === 'POST' && request.url().includes('/api/commit')) missingSwitchCommits++; };
  page.on('request', countMissingCommits);
  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-show-other-sessions]').click();
  assert.equal(await page.locator('#session-menu [data-session="other-stale"]').isDisabled(), true);
  assert.equal(await page.locator('#session-menu [data-session="other-closed"]').count(), 0);
  await page.locator(`#session-menu [data-session="${unavailableSession}"]`).click();
  await page.locator('#btn-settings').click();
  if (await page.locator('#cg-sync').getAttribute('open') === null) await page.locator('#cg-sync > summary').click();
  await page.locator('#cg-sync-status').filter({ hasText: '地图尚未同步' }).waitFor();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Main map/);
  assert.equal(await syncVersion(), beforeMissingVersion);
  assert.equal(page.url(), beforeMissingUrl);
  assert.equal(await page.locator('#cg-sync-session').inputValue(), '__all__');
  assert.equal(await page.locator('#cg-sync-initialize').isVisible(), false);
  assert.equal(missingSwitchCommits, 0);
  page.off('request', countMissingCommits);
  await page.unroute(otherAccessRoute);
  await page.reload();
  await synchronized();
  record('A bound Session without a snapshot preserves Main and does not initialize or commit a replacement');

  const pendingPage = await context.newPage();
  const lateSessionId = `late-session-${process.pid}-${Date.now()}`;
  await pendingPage.goto(`${service.url}/projects/context-guard?session=${lateSessionId}`);
  await pendingPage.waitForFunction(id => document.querySelector('#cg-sync-session')?.value === id, lateSessionId);
  assert.equal(new URL(pendingPage.url()).searchParams.get('session'), lateSessionId);
  assert.match(await pendingPage.locator('#cg-sync-status').textContent(), /正在同步到 Cloud/);
  assert.equal(await pendingPage.locator('#cloud-sync-status').getAttribute('aria-label'), '云端同步中');
  assert.equal(await pendingPage.locator(`#cg-sync-session option[value="${lateSessionId}"]`).count(), 1);
  assert.equal(await pendingPage.locator('#cg-sync-session option[value="session-one"]').count(), 0, 'a deep link does not expose other idle Sessions');
  assert.equal(await pendingPage.locator('#cg-sync-session option[value="__all__"]').count(), 1, 'Cloud deep links retain the Main entry');
  await pendingPage.locator('#session-chip').click();
  assert.equal(await pendingPage.locator('#session-menu [data-session="session-one"]').count(), 0);
  assert.equal(await pendingPage.locator('#session-menu [data-session="__all__"]').count(), 1);
  await pendingPage.locator('#session-chip').click();
  const lateMap = structuredClone(sessionMap);
  lateMap.root.title = 'Late Session map';
  const lateSession = await request(`${service.url}/v1/projects/context-guard/sessions/${lateSessionId}`, {
    method: 'POST',
    headers: headers('project-memory-token'),
    body: JSON.stringify({
      operationId: 'browser-late-session',
      baseVersion: null,
      baseMainVersion: baselinePublication.body.snapshot.version,
      sourceCommit: featureSha,
      memory: { map: lateMap, records: {} },
      client: { sessionId: lateSessionId, hookEvent: 'SessionStart', eventId: 'hook-late-session', occurredAt: new Date().toISOString(), cursor: 0 },
    }),
  });
  assert.equal(lateSession.response.status, 200, JSON.stringify(lateSession.body));
  await pendingPage.waitForFunction(id => document.querySelector('#cg-sync-session')?.value === id && document.querySelector('#cg-sync')?.dataset.status === 'synced', lateSessionId);
  await pendingPage.waitForFunction(() => document.querySelector('.node[data-id="T0"]')?.textContent?.includes('Late Session map'));
  assert.match(await pendingPage.locator('.node[data-id="T0"]').textContent(), /Late Session map/);
  assert.equal(lateSession.body.snapshot.lastSync.sessionId, lateSessionId);
  assert.equal(lateSession.body.snapshot.lastSync.hookEvent, 'SessionStart');
  assert.equal(lateSession.body.snapshot.updatedAt, new Date(lateSession.body.snapshot.updatedAt).toISOString());
  await pendingPage.close();
  record('A pending Session deep link stays selected and opens automatically after Hook-style Cloud registration');

  await page.locator('.cloud-overview-link').click();
  await page.waitForURL(`${service.url}/`);
  assert.match(await page.locator('.node[data-id="P_context-guard"]').textContent(), /Context Guard/);
  await page.locator('.node[data-id="P_context-guard"]').click();
  await page.waitForURL(`${service.url}/projects/context-guard`);
  await synchronized();
  record('Project page has a stable route back to the overview');

  const mobileLayoutPage=await context.newPage();
  await useScreenshotFallbackFonts(mobileLayoutPage);
  const layoutBefore=await request(`${service.url}/v1/projects/context-guard/main`,{headers:headers('project-memory-token')});
  const toolbarFits=async()=>{
    const geometry=await mobileLayoutPage.evaluate(()=>{
      const row=document.querySelector('.top-tools'),chip=document.querySelector('#session-chip'),label=document.querySelector('#session-name');
      const style=getComputedStyle(row),r=row.getBoundingClientRect(),c=chip.getBoundingClientRect(),l=label.getBoundingClientRect();
      return {contentHeight:row.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),chipHeight:chip.offsetHeight,
        contained:c.top>=r.top-.5&&c.bottom<=r.bottom+.5,labelContained:l.top>=c.top-.5&&l.bottom<=c.bottom+.5,
        centered:Math.abs((l.top+l.bottom-c.top-c.bottom)/2)<1};
    });
    assert.ok(geometry.contentHeight>=geometry.chipHeight-.5&&geometry.contained&&geometry.labelContained&&geometry.centered,
      `toolbar must contain the Session control and centered label: ${JSON.stringify(geometry)}`);
  };
  for(const width of [320,390,718]){
    await mobileLayoutPage.setViewportSize({width,height:900});
    await mobileLayoutPage.goto(`${service.url}/?phone=1`);
    await mobileLayoutPage.waitForFunction(()=>document.querySelector('#cg-sync')?.dataset.status==='synced');
    await mobileLayoutPage.locator('.node[data-id="T0"]').click();
    assert.equal(await mobileLayoutPage.locator('#detail [data-fold="files"]').count(),0,'overview with no attachments must not render an empty separator section');
    assert.equal(await mobileLayoutPage.locator('#detail [data-fold="memory-doc"]').count(),1,'memory document remains accessible');
    await toolbarFits();
    await mobileLayoutPage.screenshot({path:path.join(output,`mobile-toolbar-${width}.png`),fullPage:true});
  }
  await mobileLayoutPage.evaluate(()=>{document.documentElement.dir='rtl';});
  await toolbarFits();
  await mobileLayoutPage.evaluate(()=>{document.documentElement.dir='ltr';document.body.style.zoom='2';});
  await toolbarFits();
  await mobileLayoutPage.setViewportSize({width:1440,height:1000});
  await mobileLayoutPage.goto(service.url);
  await mobileLayoutPage.waitForFunction(()=>document.querySelector('#cg-sync')?.dataset.status==='synced');
  await toolbarFits();
  const overview=await request(`${service.url}/api/workbench/overview/api/state`,{headers:headers('browser-token')});
  const stagedAttachment=await request(`${service.url}/api/workbench/overview/api/commit`,{method:'POST',headers:headers('browser-token'),
    body:JSON.stringify({baseVersion:overview.body.version,operationId:'layout-existing-attachment',operations:[{type:'update',id:'T0',fields:{files:[{path:'docs/synthetic-existing.txt'}]}}]})});
  assert.equal(stagedAttachment.response.status,200);
  await mobileLayoutPage.reload();
  await mobileLayoutPage.waitForFunction(()=>document.querySelector('#cg-sync')?.dataset.status==='synced');
  await mobileLayoutPage.locator('.node[data-id="T0"]').click();
  assert.equal(await mobileLayoutPage.locator('#detail [data-fold="files"]').count(),1,'existing file references survive when upload is disabled');
  assert.equal(await mobileLayoutPage.locator('#detail [data-act="ask-file"]').count(),0);
  assert.match(await mobileLayoutPage.locator('#detail [data-fold="files"]').textContent(),/synthetic-existing/);
  const withFiles=await request(`${service.url}/api/workbench/overview/api/state`,{headers:headers('browser-token')});
  assert.equal((await request(`${service.url}/api/workbench/overview/api/commit`,{method:'POST',headers:headers('browser-token'),
    body:JSON.stringify({baseVersion:withFiles.body.version,operationId:'layout-remove-fixture-reference',operations:[{type:'update',id:'T0',fields:{files:overview.body.doc.root.files||[]}}]})})).response.status,200);
  await mobileLayoutPage.close();
  const layoutAfter=await request(`${service.url}/v1/projects/context-guard/main`,{headers:headers('project-memory-token')});
  assert.equal(layoutAfter.body.snapshot.version,layoutBefore.body.snapshot.version);
  assert.deepEqual(layoutAfter.body.snapshot.memory.map,layoutBefore.body.snapshot.memory.map);
  record('UI-MOBILE-LAYOUT-01: phone toolbar fits, empty attachment separators disappear and existing attachments/Memory/Main stay intact');

  const readonlyBefore=await request(`${service.url}/v1/projects/context-guard/main`,{headers:headers('project-memory-token')});
  assert.equal(readonlyBefore.body.snapshot.version,baselinePublication.body.snapshot.version,'Initial loading has not written a normalized Main');
  const readonlyCommits=[];
  const observeReadonlyCommit=req=>{if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/api/commit'))readonlyCommits.push(req.url());};
  page.on('request',observeReadonlyCommit);
  await page.locator('.node[data-id="N1"]').click();
  await page.locator('#detail').getByText('Readonly manual bug',{exact:true}).waitFor({state:'visible'});
  await synchronized();
  // Complete a real presence checkpoint and task-status refresh after render,
  // not a fixed sleep that could finish before autosave gets a chance to run.
  await page.evaluate(async()=>{await workbenchSync.presence('readonly-inspection');await workbenchSync.refreshTaskStatuses();});
  await synchronized();
  const readonlyAfter=await request(`${service.url}/v1/projects/context-guard/main`,{headers:headers('project-memory-token')});
  assert.deepEqual(readonlyAfter.body.snapshot,readonlyBefore.body.snapshot,'Read-only inspection preserves Main version and every field');
  assert.deepEqual(readonlyCommits,[],'Inspection and status refresh never submit a map commit');
  page.off('request',observeReadonlyCommit);
  record('Read-only manual Bug inspection keeps absent files and all Main fields unchanged');

  const relationPage = await context.newPage();
  await relationPage.goto(`${service.url}/projects/context-guard?relation=T0#cloud-relation-contract`);
  await relationPage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced' && document.body.classList.contains('rel-mode'));
  assert.equal(await relationPage.locator('#btn-rel').getAttribute('aria-pressed'), 'true');
  await relationPage.goto(`${service.url}/projects/context-guard?session=session-one#cloud-relation-contract`);
  await relationPage.waitForFunction(() => document.querySelector('#cg-sync-session')?.value === 'session-one' && !document.body.classList.contains('rel-mode'));
  const switchedRelationUrl = new URL(relationPage.url());
  assert.equal(switchedRelationUrl.searchParams.get('session'), 'session-one');
  assert.equal(switchedRelationUrl.searchParams.has('relation'), false);
  assert.equal(switchedRelationUrl.hash, '#cloud-relation-contract');
  await relationPage.reload();
  await relationPage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced' && document.querySelector('#cg-sync-session')?.value === 'session-one');
  assert.equal(await relationPage.locator('body').evaluate(el => el.classList.contains('rel-mode')), false);
  await relationPage.close();
  record('Relation mode requires an explicit action or deep link and resets on Session switch');

  await page.goto(`${service.url}/projects/context-guard?session=session-one`);
  await page.waitForFunction(() => document.querySelector('#cg-sync-session')?.value === 'session-one');
  await synchronized();
  assert.equal(new URL(page.url()).searchParams.get('session'), 'session-one');
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Session map/);
  record('Session selector changes the Map scope');

  // Only the first three commit responses are replaced. Recovery then reaches
  // the real Cloud transaction and is verified against persisted Session data.
  await page.locator('.node[data-id="N1"]').click();
  const busyRoute = /\/api\/workbench\/projects\/context-guard\/api\/commit/;
  const busyBodies = [];
  let releaseBusy = false;
  await page.route(busyRoute, async route => {
    busyBodies.push(route.request().postData());
    if (!releaseBusy) return route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'STATE_BUSY', message: 'Shared state is busy; preserve lock and retry' } }) });
    await route.continue();
  });
  await page.locator('#detail [data-ed="title"]').fill('Busy recovery node');
  await page.locator('#detail [data-ed="title"]').blur();
  await page.locator('#cg-sync[data-status="busy"]').waitFor({ state: 'attached' });
  assert.equal(busyBodies.length, 3);
  const busyPayload = JSON.parse(busyBodies[0]);
  assert.ok(busyPayload.operationId);
  assert.ok(busyBodies.every(body => body === busyBodies[0]), 'Initial retries keep the exact operation');
  const busyBefore = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(busyBefore.body.snapshot.memory.map.root.children[0].title, 'Tour one', 'Busy responses did not write a replacement');
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem(workbenchSync.captureKey))?.pendingRequest?.operationId), 'Recovery draft is persisted before waiting');
  releaseBusy = true;
  await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced', null, { timeout: 45000 });
  assert.equal(busyBodies.length, 4);
  assert.equal(busyBodies[3], busyBodies[0], 'Heartbeat replays the original commit rather than issuing a new one');
  const busyAfter = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(busyAfter.body.snapshot.memory.map.root.children[0].title, 'Busy recovery node');
  assert.equal(busyAfter.body.snapshot.version, await syncVersion());
  assert.equal(await page.evaluate(() => localStorage.getItem(workbenchSync.captureKey)), null, 'Acknowledged draft is cleared');
  await page.unroute(busyRoute);
  // Restore this isolated fixture so later scenarios retain their original inputs.
  const restoreBusyVersion = await syncVersion();
  await page.locator('#detail [data-ed="title"]').fill('Tour one');
  await page.locator('#detail [data-ed="title"]').blur();
  await synchronizedAfter(restoreBusyVersion);
  assert.equal((await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') })).body.snapshot.version,
    baselinePublication.body.snapshot.version, 'Recovery never changes Main');
  record('Busy commit preserves the exact draft and recovers through the real Cloud transaction without approval replay');

  await page.locator('#nav-crumbs a[data-id="T0"]').click();
  await page.locator('.node[data-id="T0"]').click();
  const title = page.locator('#detail [data-ed="title"]');
  const beforeEditVersion = await syncVersion();
  await title.fill('Session map edited in browser');
  await page.waitForFunction(() => ['draft', 'saving', 'persisted'].includes(document.querySelector('#cg-sync')?.dataset.status));
  await title.blur();
  await synchronizedAfter(beforeEditVersion);
  const savedSession = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(savedSession.body.snapshot.version, await syncVersion());
  assert.equal(savedSession.body.snapshot.memory.map.root.title, 'Session map edited in browser');
  assert.equal(savedSession.body.snapshot.updatedAt, new Date(savedSession.body.snapshot.updatedAt).toISOString());
  const unchangedMain = await request(`${service.url}/api/projects/context-guard/map`, { headers: headers('cloud-admin') });
  assert.equal(unchangedMain.body.document.root.title, 'Main map');
  record('Session edit is durably stored without changing Main');

  await page.reload();
  await synchronized();
  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-session="session-one"]').click();
  await page.waitForFunction(() => document.querySelector('#cg-sync-session')?.value === 'session-one');
  await synchronized();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Session map edited in browser/);
  record('Browser refresh restores the persisted Session edit');

  const conflictBase = await syncVersion();
  let interceptedResolve, releaseResolve;
  const intercepted = new Promise(resolve => { interceptedResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const commitRoute = /\/api\/workbench\/projects\/context-guard\/api\/commit/;
  await page.route(commitRoute, async route => {
    interceptedResolve();
    await release;
    await route.continue();
  });
  await page.locator('.node[data-id="T0"]').click();
  const conflictingTitle = page.locator('#detail [data-ed="title"]');
  await conflictingTitle.fill('Unsaved browser conflict draft');
  await intercepted;
  const remote = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Asession-one`, {
    method: 'POST',
    headers: headers('browser-token'),
    body: JSON.stringify({ baseVersion: conflictBase, operationId: 'browser-conflict-winner', operations: [{ type: 'update', id: 'T0', fields: { purpose: 'concurrent server edit' } }] }),
  });
  assert.equal(remote.response.status, 200, JSON.stringify(remote.body));
  releaseResolve();
  await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'conflict');
  const recoveryDraft = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('cg-sync-draft:'))
    .map(([, value]) => JSON.parse(value))
    .find(value => value?.doc?.root?.title === 'Unsaved browser conflict draft'));
  assert.ok(recoveryDraft, 'the losing browser edit must remain in a recovery draft');
  const conflictWinner = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(conflictWinner.body.snapshot.memory.map.root.title, 'Session map edited in browser');
  assert.equal(conflictWinner.body.snapshot.memory.map.root.purpose, 'concurrent server edit');
  await page.unroute(commitRoute);
  record('Concurrent edit shows conflict and preserves the losing browser draft');

  await page.reload();
  await synchronized();
  const reconciled = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(reconciled.body.snapshot.memory.map.root.title, 'Unsaved browser conflict draft');
  assert.equal(reconciled.body.snapshot.memory.map.root.purpose, 'concurrent server edit');
  assert.equal(await page.evaluate(() => localStorage.getItem('cg-sync-draft:cloud:context-guard:session:session-one')), null);
  record('Refresh safely merges disjoint browser draft and Cloud changes');

  const overlapBase = await syncVersion();
  let overlapInterceptedResolve, overlapReleaseResolve;
  const overlapIntercepted = new Promise(resolve => { overlapInterceptedResolve = resolve; });
  const overlapRelease = new Promise(resolve => { overlapReleaseResolve = resolve; });
  await page.route(commitRoute, async route => {
    overlapInterceptedResolve();
    await overlapRelease;
    await route.continue();
  });
  await page.locator('.node[data-id="T0"]').click();
  await page.locator('#detail [data-ed="title"]').fill('Overlapping local title');
  await overlapIntercepted;
  const overlapWinner = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Asession-one`, {
    method: 'POST', headers: headers('browser-token'),
    body: JSON.stringify({ baseVersion: overlapBase, operationId: 'browser-overlap-winner', operations: [{ type: 'update', id: 'T0', fields: { title: 'Overlapping remote title' } }] }),
  });
  assert.equal(overlapWinner.response.status, 200, JSON.stringify(overlapWinner.body));
  overlapReleaseResolve();
  await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'conflict');
  await page.unroute(commitRoute);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'conflict');
  assert.equal((await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') })).body.snapshot.memory.map.root.title, 'Overlapping remote title');
  assert.match(await page.evaluate(() => localStorage.getItem('cg-sync-draft:cloud:context-guard:session:session-one')), /Overlapping local title/);
  record('Overlapping browser draft remains preserved without overwriting Cloud');

  await page.evaluate(() => localStorage.removeItem('cg-sync-draft:cloud:context-guard:session:session-one'));
  await page.reload();
  await synchronized();
  const restoreTitleBase = await syncVersion();
  const restoredTitle = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Asession-one`, {
    method: 'POST', headers: headers('browser-token'),
    body: JSON.stringify({ baseVersion: restoreTitleBase, operationId: 'browser-overlap-fixture-restore', operations: [{ type: 'update', id: 'T0', fields: { title: 'Session map edited in browser' } }] }),
  });
  assert.equal(restoredTitle.response.status, 200, JSON.stringify(restoredTitle.body));
  await synchronizedAfter(restoreTitleBase);
  await page.evaluate(() => {
    const key = 'cg-sync-draft:cloud:context-guard:session:session-one';
    localStorage.setItem(key, JSON.stringify({ baseVersion: 'stale-browser-version', baseTree: structuredClone(workbenchSync.baseTree),
      doc: { ...workbenchSync.doc, root: structuredClone(workbenchSync.baseTree) } }));
  });
  await page.reload();
  await synchronized();
  assert.equal(await page.evaluate(() => localStorage.getItem('cg-sync-draft:cloud:context-guard:session:session-one')), null);
  record('Stale browser cache with no unsaved changes is cleared on open');

  const replayBase = await syncVersion();
  const replayBaseTree = await page.evaluate(() => structuredClone(workbenchSync.baseTree));
  const replayRequest = { baseVersion: replayBase, operationId: 'browser-lost-ack-replay',
    operations: [{ type: 'update', id: 'N1', fields: { purpose: 'saved despite lost acknowledgement' } }] };
  const replayFirst = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Asession-one`, {
    method: 'POST', headers: headers('browser-token'), body: JSON.stringify(replayRequest),
  });
  assert.equal(replayFirst.response.status, 200, JSON.stringify(replayFirst.body));
  const replayFirstVersion = (await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') })).body.snapshot.version;
  const replaySecond = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Asession-one`, {
    method: 'POST', headers: headers('browser-token'),
    body: JSON.stringify({ baseVersion: replayFirstVersion, operationId: 'browser-lost-ack-followup',
      operations: [{ type: 'update', id: 'N2', fields: { purpose: 'separate later Cloud update' } }] }),
  });
  assert.equal(replaySecond.response.status, 200, JSON.stringify(replaySecond.body));
  const replayDraftRoot = structuredClone(replayBaseTree);
  replayDraftRoot.children[0].purpose = 'saved despite lost acknowledgement';
  await page.evaluate(({ baseVersion, baseTree, root, pendingRequest }) => {
    localStorage.setItem('cg-sync-draft:cloud:context-guard:session:session-one', JSON.stringify({ baseVersion, baseTree, doc: { root }, pendingRequest }));
  }, { baseVersion: replayBase, baseTree: replayBaseTree, root: replayDraftRoot, pendingRequest: replayRequest });
  await page.reload();
  await synchronized();
  const replayed = await request(`${service.url}/v1/projects/context-guard/sessions/session-one`, { headers: headers('project-memory-token') });
  assert.equal(replayed.body.snapshot.memory.map.root.children[0].purpose, 'saved despite lost acknowledgement');
  assert.equal(replayed.body.snapshot.memory.map.root.children[1].purpose, 'separate later Cloud update');
  assert.equal(await page.evaluate(() => localStorage.getItem('cg-sync-draft:cloud:context-guard:session:session-one')), null);
  record('Lost acknowledgement replays its original request before clearing stale browser cache');

  await page.locator('#session-chip').click();
  await page.locator('#session-menu [data-session="session-one"]').click();
  await page.waitForFunction(() => document.querySelector('#cg-sync-session')?.value === 'session-one');
  await synchronized();
  await page.locator('#btn-settings').click();
  await page.locator('#cg-sync > summary').click();
  page.once('dialog', dialog => dialog.accept());
  const reviewedSession = page.waitForResponse(response => response.url().includes('/api/session-completion'));
  await page.locator('#cg-session-complete').click();
  assert.equal((await reviewedSession).status(), 200, 'human completes the exact reviewed map before source merge');
  await git(repository, 'merge', '--ff-only', 'feature');
  await page.reload();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('session'), undefined, { timeout: 35000 });
  await synchronized();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Session map edited in browser/);
  assert.doesNotMatch(await page.content(), /memory-admin|cloud-admin|project-memory-token/);
  await page.reload();
  await synchronized();
  assert.match(await page.locator('.node[data-id="T0"]').textContent(), /Session map edited in browser/);
  assert.equal(new URL(page.url()).searchParams.has('session'), false);
  assert.equal(await page.locator('#btn-publish-main').count(), 0, 'Main publication has no browser control');
  await page.locator('#session-chip').click();
  assert.equal(await page.locator('#session-menu [data-session="session-one"]').count(), 0, 'a published Session leaves the active selector');
  assert.equal(await page.locator('#cg-sync-session option[value="session-one"]').count(), 0);
  await page.locator('#session-chip').click();
  record('Verified publication updates durable Main without exposing an admin token');

  assert.equal(await page.locator('#coordinator-panel').count(), 0, 'ordinary projects do not gain a Coordinator');
  assert.equal(await page.locator('#btn-coordinator').isVisible(), false, 'ordinary projects do not expose the Coordinator launcher');
  await page.addInitScript(() => {
    let config;
    Object.defineProperty(window, '__CG_SERVER', {
      configurable: true,
      get: () => config,
      set: value => { config = value; config.interfaceCapabilities.coordinator = true; },
    });
  });
  await page.route(/\/bootstrap(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.interfaceCapabilities = { ...body.interfaceCapabilities, coordinator: true };
    await route.fulfill({ response, json: body });
  });
  const submissions = [];
  let releaseDelayedSubmission;
  let releaseCardSubmission;
  let releaseLongSubmission;
  const oneShotLongText='完整长段落。'.repeat(240);
  const coordinatorReads = [];
  let modelSettings={version:'a'.repeat(64),selectedId:'glm',options:[{id:'glm',label:'GLM 5.3',model:'glm-5.3'},{id:'ds',label:'DeepSeek V4.1 Flash',model:'deepseek-flash'}]};
  const modelSelections=[];
  const modelReceipts=new Map();let modelFailure=null,modelWrites=0;
  await page.route(/\/api\/coordinator\/model(?:\?|$)/,async route=>{
    if(route.request().method()==='POST'){
      const input=route.request().postDataJSON();modelSelections.push(input);
      assert.deepEqual(Object.keys(input).sort(),['baseVersion','id','providerId']);
      if(modelReceipts.has(input.id)){
        assert.deepEqual(input,modelReceipts.get(input.id).input,'unknown-outcome retries preserve the exact operation');
        await route.fulfill({json:modelReceipts.get(input.id).value});return;
      }
      assert.equal(input.baseVersion,modelSettings.version);
      if(modelFailure==='conflict'){
        modelFailure=null;modelSettings={...modelSettings,version:'f'.repeat(64)};
        await route.fulfill({status:409,json:{error:{code:'VERSION_CONFLICT',message:'model settings changed'}}});return;
      }
      modelWrites++;modelSettings={...modelSettings,selectedId:input.providerId,version:String(modelWrites).padStart(64,'0')};
      modelReceipts.set(input.id,{input,value:modelSettings});
      if(modelFailure==='unknown'){modelFailure=null;await route.abort('failed');return;}
    }
    await route.fulfill({json:modelSettings});
  });
  let coordinatorReadFailure = false;
  let coordinatorReadOffline = false;
  const markdownImageRequests = [];
  const workingBlotRequests = [];
  page.on('request', request=>{
    if(request.url()==='https://example.invalid/private.png')markdownImageRequests.push(request.url());
    if(request.url().includes('/working-blot-atlas.png'))workingBlotRequests.push(request.url());
  });
  const staleAtlasRoute=/\/assets\/[a-f0-9]{16}\/prototype\/working-blot-atlas\.png$/;
  await page.route(staleAtlasRoute,route=>route.fulfill({status:404,body:'old asset version'}));
  let runningPreview = false;
  let coordinatorState = { status: 'waiting-for-user', simulated: true, messages: [{ role: 'assistant', text: '<img src=x onerror=alert(1)>', tools: [] }],
    sessionTemplates: [{ id: 'developer-template', name: 'Claude Developer' }], sessionCreations: [],
    conversations: [{id:'main',scope:'main',title:'Main 对话'},{id:'session:history-one',scope:'session',title:'历史开发 Session'}],
    approvals: [{ id: 'proposal-1', pending: true, brief: { ref: 'brief-1', version: 'v1' }, text: '模拟需求确认', acceptance: '明确验收标准', sessionId: 'assigned-session', nodeIds: ['T0'], mainVersion: 'main-v1' }] };
  coordinatorState.messages.push(
    { role: 'user', text: '[实验：模拟人工输入]\n请审核这个计划', tools: [] },
    { role: 'assistant', text: '## 审核结果\n\n1. **范围一致**，执行 `npm ci`。\n   - 保留目录边界\n\n> 先审核，再开发。\n\n```js\nconst value = "<script>";\n```\n\n| 阶段 | 状态 |\n| --- | --- |\n| Plan | 通过 |\n\n[规范](https://example.invalid/spec) [不安全链接](javascript:alert(1))\n\n![不加载远程图片](https://example.invalid/private.png)', tools: [] },
    { role: 'user', text: '[服务器工作流事件，不是新的用户授权]\n{"type":"review.result","privateEventMarker":"diagnostic-only"}', tools: [] },
    { role: 'assistant', text: '', tools: [{ name: 'read_task' }, { name: 'read_reference' }] },
    { role: 'assistant', text: '请说明预期行为，并提供 `复现步骤`。', tools: [{ name: 'ask_user' }] },
  );
  coordinatorState.approvals.push(...['frontend', 'build'].map(id => ({ id, kind: 'mount-proposal', pending: true,
    mainVersion: 'main-v1', title: id, purpose: '隔离实验节点', owns: [id + '/'] })));
  const mountReviews = [];
  await page.route(/\/api\/coordinator\/mount-review(?:\?|$)/, async route => {
    mountReviews.push(route.request().postDataJSON());
    if (mountReviews.length === 1) return route.abort();
    for (const approval of coordinatorState.approvals) if (approval.kind === 'mount-proposal') approval.pending = false;
    return route.fulfill({ json: { committed: { version: 'main-v2', nodeIds: ['frontend', 'build'] } } });
  });
  const approvals = [];
  await page.route(/\/api\/coordinator\/approval(?:\?|$)/, async route => {
    approvals.push(route.request().postDataJSON());
    if (approvals.length === 1) return route.abort();
    coordinatorState.approvals[0].pending = false;
    return route.fulfill({ json: { receiptId: 'human-receipt' } });
  });
  const conversationCreationRequests = [];
  await page.route(/\/api\/coordinator\/conversations\/new(?:\?|$)/, async route => {
    const request = route.request().postDataJSON();conversationCreationRequests.push(request);
    if(conversationCreationRequests.length===1)return route.abort();
    coordinatorState.conversations.push({id:'chat-created',scope:'chat',title:'Coordinator Session 1'});
    return route.fulfill({ status: 201, json: { id: 'chat-created' } });
  });
  await page.route(/\/api\/coordinator(?:\?|$)/, async route => {
    if (route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      if(submissions.at(-1).text==='明确拒绝后恢复草稿')return route.fulfill({status:409,json:{error:{code:'COORDINATOR_BUSY',message:'Previous turn is running'}}});
      if (submissions.at(-1).text === 'Ready 一次性回复') {
        coordinatorState = { ...coordinatorState, status: 'waiting-for-user', streamingText: '', error: null,
          messages: [...coordinatorState.messages,{role:'user',text:'Ready 一次性回复'},{role:'assistant',text:'完整段落一次返回。\n\n第二段保持稳定。'}] };
        return route.fulfill({ json: { accepted: true, id: submissions.at(-1).id }, status: 202 });
      }
      if (submissions.at(-1).text === '一次性长回复测试') {
        await new Promise(resolve => { releaseLongSubmission = resolve; });
        coordinatorState = { ...coordinatorState, status: 'waiting-for-user', streamingText: '', error: null,
          messages: [...coordinatorState.messages,{role:'user',text:'一次性长回复测试'},{role:'assistant',text:oneShotLongText}] };
        return route.fulfill({ json: { accepted: true, id: submissions.at(-1).id }, status: 202 });
      }
      if (submissions.at(-1).text === '立即显示测试') {
        await new Promise(resolve => { releaseDelayedSubmission = resolve; });
        coordinatorState = { ...coordinatorState, status: 'waiting-for-user', error: null, retryInput: null, canCorrect: false,
          messages: [...coordinatorState.messages, { role: 'user', text: '立即显示测试', tools: [] }] };
        return route.fulfill({ json: { accepted: true, id: submissions.at(-1).id }, status: 202 });
      }
      if (submissions.at(-1).answerTo === 'ordering-question') {
        const answer = submissions.at(-1);
        coordinatorState.messages.at(-1).questions[0].answer = { text: answer.text, requestId: answer.id };
        coordinatorState.messages.push({ role: 'user', text: answer.text, answerTo: answer.answerTo, requestId: answer.id },
          { role: 'assistant', text: '后续回复应排在回答之后。' });
        return route.fulfill({ json: { accepted: true, id: answer.id }, status: 202 });
      }
      if (submissions.at(-1).text === '已持久化但响应丢失') {
        coordinatorState = { ...coordinatorState, status: 'waiting-for-user', error: null, retryInput: null, canCorrect: false,
          acceptedRequestIds: [submissions.at(-1).id] };
        return route.abort(); // The server accepted the turn, but the acknowledgement was lost.
      }
      if (submissions.at(-1).text === '短暂断线后成功') {
        const attempt=submissions.filter(item=>item.text==='短暂断线后成功');
        if(attempt.length===1)return route.abort(); // No server receipt exists yet.
        const request=submissions.at(-1);
        coordinatorState={...coordinatorState,status:'waiting-for-user',error:null,retryInput:null,canCorrect:false,
          acceptedRequestIds:[request.id],messages:[...coordinatorState.messages,
            {role:'user',text:request.text,requestId:request.id},{role:'assistant',text:'已收到原请求。'}]};
        return route.fulfill({json:{accepted:true,id:request.id},status:202});
      }
      if (submissions.length === 1 && submissions.at(-1).answerTo === 'choice') {
        await new Promise(resolve=>{releaseCardSubmission=resolve;});
        coordinatorState.status='running';
        return route.abort(); // A separate running turn must not be retried automatically.
      }
      if (submissions.length === 1) return route.abort(); // Delivery is uncertain: preserve the ID.
      if (submissions.at(-1).text === '更正审批 ID，先核对当前 Plan') {
        coordinatorState = { ...coordinatorState, status: 'waiting-for-user', error: null, retryInput: null, canCorrect: false };
        return route.fulfill({ json: { accepted: true, id: submissions.at(-1).id }, status: 202 });
      }
      coordinatorState = { ...coordinatorState, status: 'error', error: { code: 'MODEL_TIMEOUT' }, retryInput: submissions[0] };
      return route.fulfill({ json: { accepted: true, id: submissions.at(-1).id }, status: 202 });
    }
    const readConversation=new URL(route.request().url()).searchParams.get('conversation');coordinatorReads.push(readConversation);
    if(coordinatorReadOffline||coordinatorReadFailure){coordinatorReadFailure=false;return route.abort();}
    const responseState=readConversation==='chat-created'?{...coordinatorState,messages:[],approvals:[],acceptances:[],status:'idle'}:runningPreview?{...coordinatorState,status:'running',streamingText:'第一段回复。\n\n第二段回复。\n\n第三段回复。\n\n'}:coordinatorState;
    await route.fulfill({ json: responseState });
  });
  await page.reload(); await synchronized();
  const coordinator = page.locator('#coordinator-panel');
  await page.locator('#btn-coordinator').waitFor({ state: 'visible' });
  const detailTitleBeforeCoordinator = (await page.locator('#detail h2').first().textContent()).trim();
  assert.equal(await page.locator('#btn-coordinator').isVisible(), true, 'Coordinator entry lives in the top bar');
  assert.equal(await page.locator('#btn-coordinator').evaluate(el => el.closest('header.top') !== null), true);
  assert.equal(await page.locator('#cloud-sync-status').isVisible(), false, 'synced state does not render a checkmark button');
  await page.locator('#btn-coordinator').click();
  assert.equal(await page.locator('#btn-coordinator').getAttribute('aria-expanded'), 'true');
  assert.equal(await coordinator.locator(':scope > [role=status]').evaluate(el=>el.nextElementSibling?.className),'coordinator-compose','submission failures remain visible beside the composer after the chat scrolls');
  assert.equal(await coordinator.evaluate(el => el.parentElement?.id), 'detail', 'Coordinator reuses the existing inspector');
  assert.equal(await coordinator.evaluate(el => getComputedStyle(el).position), 'static', 'Coordinator is not a floating overlay');
  assert.equal(await page.locator('#detail').evaluate(el => el.classList.contains('coordinator-open')), true);
  await page.waitForFunction(() => document.querySelector('#coordinator-panel')?.dataset.conversation === 'main');
  const createSessionAction=coordinator.getByRole('button',{name:'新建 Coordinator Session',exact:true});
  assert.equal(await createSessionAction.textContent(),'＋','new Session uses a symbol-only control');
  assert.equal(await createSessionAction.evaluate(el=>el.parentElement?.classList.contains('coordinator-toolbar')),true,'new Session lives in the Coordinator toolbar');
  const historyAction=coordinator.getByRole('button',{name:'历史 Session',exact:true});
  assert.equal(await historyAction.textContent(),'◷','history uses a symbol-only control');
  assert.equal(await historyAction.evaluate(el=>el.parentElement?.classList.contains('coordinator-toolbar')),true,'history lives in the Coordinator toolbar');
  assert.equal(await coordinator.locator('.coordinator-toolbar button[aria-label="重试原请求"]').count(),0);
  assert.equal(await coordinator.locator('.coordinator-toolbar button[aria-label="停止当前回复"]').count(),0);
  assert.equal(await coordinator.locator('.coordinator-stop,button[aria-label="停止当前轮次"]').count(),0,'the removed Stop control is not restored');
  const modelAction=coordinator.getByRole('button',{name:'模型配置',exact:true});
  await modelAction.click();
  const modelMenu=coordinator.getByRole('menu',{name:'模型选择',exact:true});
  const glmChoice=modelMenu.getByRole('menuitemradio',{name:'GLM 5.3',exact:true}),dsChoice=modelMenu.getByRole('menuitemradio',{name:'DeepSeek V4.1 Flash',exact:true});
  await glmChoice.waitFor();
  assert.equal(await glmChoice.getAttribute('aria-checked'),'true');
  assert.equal(await page.locator('.coordinator-model-dialog').count(),0,'model selection has no modal or backdrop');
  assert.equal(await modelMenu.locator('input,select,form').count(),0,'direct choices need no configuration form');
  assert.ok((await modelMenu.boundingBox()).y>=(await modelAction.boundingBox()).y+(await modelAction.boundingBox()).height,'menu opens immediately below the model button');
  await dsChoice.click();await modelMenu.waitFor({state:'hidden'});
  assert.equal(modelSelections.length,1);
  await modelAction.click();
  await page.waitForFunction(()=>document.querySelector('[role=menuitemradio][aria-checked=true]')?.textContent.includes('DeepSeek'));
  await page.screenshot({path:path.join(output,'coordinator-model-menu-desktop.png')});
  await dsChoice.click();await modelMenu.waitFor({state:'hidden'});
  assert.equal(modelSelections.length,1,'clicking the selected model is a no-op');
  await modelAction.click();await dsChoice.waitFor();await modelAction.press('Escape');await modelMenu.waitFor({state:'hidden'});
  assert.equal(await modelAction.evaluate(el=>el===document.activeElement),true,'Escape restores the toggle focus');
  await modelAction.click();await dsChoice.waitFor();await coordinator.locator('textarea').click();await modelMenu.waitFor({state:'hidden'});
  assert.equal(await coordinator.locator('textarea').evaluate(el=>el===document.activeElement),true,'outside dismissal does not block the composer');
  await modelAction.press('ArrowDown');await glmChoice.waitFor();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitemradio');
  await glmChoice.press('End');assert.equal(await dsChoice.evaluate(el=>el===document.activeElement),true);
  await dsChoice.press('Escape');
  modelFailure='unknown';await modelAction.click();await glmChoice.waitFor();await glmChoice.click();
  await modelMenu.getByText('结果尚未确认，请再次点选同一模型。',{exact:true}).waitFor();
  assert.equal(await dsChoice.isDisabled(),true,'unresolved writes cannot be replaced with a different operation');
  const uncertainRequest=modelSelections.at(-1),writesBeforeRetry=modelWrites;
  await glmChoice.click();await modelMenu.waitFor({state:'hidden'});
  assert.deepEqual(modelSelections.at(-1),uncertainRequest);assert.equal(modelWrites,writesBeforeRetry,'receipt replay does not repeat the write');
  modelFailure='conflict';await modelAction.click();await dsChoice.waitFor();await dsChoice.click();
  await modelMenu.getByText('配置已更新，请重新点选。',{exact:true}).waitFor();
  const conflictRequest=modelSelections.at(-1);
  await dsChoice.click();await modelMenu.waitFor({state:'hidden'});
  assert.notEqual(modelSelections.at(-1).id,conflictRequest.id);assert.equal(modelSelections.at(-1).baseVersion,'f'.repeat(64));
  await modelAction.click();await dsChoice.waitFor();
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    await page.waitForFunction(()=>document.documentElement.classList.contains('cg-phone'));
    await page.waitForFunction(()=>{const menu=document.querySelector('#coordinator-model-menu');return menu&&!menu.hidden&&!menu.querySelector('[role=status]').textContent&&menu.querySelectorAll('button:not(:disabled)').length===2;});
    const modelBounds=await modelMenu.boundingBox(),toggleBounds=await modelAction.boundingBox();
    assert.ok(modelBounds.x>=0&&modelBounds.x+modelBounds.width<=width&&modelBounds.y>=toggleBounds.y+toggleBounds.height&&modelBounds.y+modelBounds.height<=844,`model menu fits below the toggle on the ${width}px phone`);
    for(const choice of [glmChoice,dsChoice]){
      const target=await choice.boundingBox();
      assert.ok(target.height>=44&&target.x>=modelBounds.x&&target.x+target.width<=modelBounds.x+modelBounds.width&&target.y>=modelBounds.y&&target.y+target.height<=modelBounds.y+modelBounds.height,`model choice has a reachable 44px target on the ${width}px phone`);
      assert.equal(await choice.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'menu choices are not obscured by the transcript');
    }
    await page.screenshot({path:path.join(output,`coordinator-model-menu-mobile-${width}.png`)});
    await dsChoice.click();await modelMenu.waitFor({state:'hidden'});await modelAction.click();await dsChoice.waitFor();
  }
  await page.setViewportSize({width:1280,height:900});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('cg-phone'));
  await modelAction.press('Escape');
  record('model dropdown direct selection, current no-op, keyboard/outside dismissal, unknown receipt replay, stale-version recovery and 320/390px phone placement (synthetic API)');
  const toolbarAppearance=await coordinator.locator('.coordinator-toolbar').evaluate(toolbar=>{
    const action=toolbar.querySelector('.coordinator-toolbar-action'),style=getComputedStyle(action),toolbarStyle=getComputedStyle(toolbar);
    return{width:style.width,height:style.height,fontSize:style.fontSize,borderWidth:style.borderTopWidth,borderRadius:style.borderRadius,background:style.backgroundColor,color:style.color,boxShadow:style.boxShadow,gap:toolbarStyle.gap};
  });
  assert.deepEqual(toolbarAppearance,{width:'28px',height:'28px',fontSize:'16px',borderWidth:'1px',borderRadius:'8px',background:'rgba(0, 0, 0, 0)',color:'rgb(116, 108, 96)',boxShadow:'none',gap:'8px 12px'},'Coordinator icon actions use the compact neutral button system');
  // UI-COORDINATOR-MOBILE-02: current Main's three controls and recovery keep
  // geometry are checked with synthetic state, never a user's conversation.
  const coordinatorGeometry=async(width,label)=>{
    await page.setViewportSize({width,height:width<820?844:1000});
    await page.waitForFunction(phone=>document.documentElement.classList.contains('cg-phone')===phone,width<820);
    const geometry=await coordinator.evaluate(panel=>{
      const rect=el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const toolbar=panel.querySelector('.coordinator-toolbar'),buttons=[...toolbar.querySelectorAll('button')];
      const input=panel.querySelector('.coordinator-input-shell textarea'),send=panel.querySelector('.coordinator-send');
      const recovery=panel.querySelector('.coordinator-recovery');
      const visible=buttons.filter(el=>!el.hidden&&el.getClientRects().length).map(el=>{const range=document.createRange();range.selectNodeContents(el);return{...rect(el),text:rect(range),action:el.classList.contains('coordinator-toolbar-action')};});
      return{phone:document.documentElement.classList.contains('cg-phone'),toolbar:rect(toolbar),visible,
        recovery:{...rect(recovery),hidden:recovery.hidden,display:getComputedStyle(recovery).display,afterMessages:recovery.previousElementSibling?.classList.contains('coordinator-messages')},
        panel:rect(panel),messages:rect(panel.querySelector('.coordinator-messages')),
        input:rect(input),shell:rect(send.parentElement),send:rect(send),arrow:rect(send.querySelector('svg')),
        padding:parseFloat(getComputedStyle(input).paddingInlineEnd),bottom:send.computedStyleMap().get('bottom').toString(),top:send.computedStyleMap().get('top').toString()};
    });
    const details=`${label} ${width}: ${JSON.stringify(geometry)}`;
    assert.equal(geometry.visible.filter(el=>el.action).length,3,'toolbar contains history, model and new Session only');
    assert.equal(geometry.recovery.afterMessages,true,'recovery stays after messages, outside the toolbar');
    if(geometry.recovery.hidden)assert.ok(geometry.recovery.display==='none'&&geometry.recovery.width===0&&geometry.recovery.height===0,`hidden recovery takes no layout space: ${details}`);
    else{
      assert.ok(geometry.recovery.top>=geometry.messages.bottom-.5&&geometry.recovery.bottom<=geometry.input.top+.5&&geometry.recovery.left>=geometry.panel.left-.5&&geometry.recovery.right<=geometry.panel.right+.5,`recovery remains separate from transcript and composer: ${details}`);
      if(geometry.phone)assert.ok(geometry.recovery.width>=44&&geometry.recovery.height>=44,`phone recovery has a real 44px target: ${details}`);
    }
    assert.ok(geometry.visible.every(el=>el.left>=geometry.toolbar.left-.5&&el.right<=geometry.toolbar.right+.5&&el.top>=geometry.toolbar.top-.5&&el.bottom<=geometry.toolbar.bottom+.5&&el.text.left>=el.left-.5&&el.text.right<=el.right+.5&&el.text.top>=el.top-.5&&el.text.bottom<=el.bottom+.5),`toolbar text and controls remain contained: ${details}`);
    for(let i=0;i<geometry.visible.length;i++)for(const other of geometry.visible.slice(i+1)){
      const el=geometry.visible[i];assert.ok(el.right<=other.left+.5||other.right<=el.left+.5||el.bottom<=other.top+.5||other.bottom<=el.top+.5,`toolbar targets do not overlap: ${details}`);
    }
    if(geometry.phone){
      assert.ok(geometry.visible.every(el=>el.width>=44&&el.height>=44),`phone targets use actual 44px dimensions: ${details}`);
      assert.ok(geometry.visible.filter(el=>el.action).every(el=>el.top>=geometry.visible[0].bottom),`phone actions follow the heading row: ${details}`);
      assert.deepEqual([geometry.send.width,geometry.send.height],[44,44]);
    }
    assert.equal(geometry.top,'auto','send has only one vertical positioning constraint');
    assert.equal(geometry.bottom,'8px');
    assert.ok(Math.abs(geometry.shell.bottom-geometry.send.bottom-8)<=.5,`single/multiline send stays bottom anchored: ${details}`);
    assert.ok(Math.abs((geometry.send.top+geometry.send.bottom-geometry.arrow.top-geometry.arrow.bottom)/2)<=.25&&
      Math.abs((geometry.send.left+geometry.send.right-geometry.arrow.left-geometry.arrow.right)/2)<=.25,`send arrow stays centered in its control: ${details}`);
    assert.ok(geometry.send.left>=geometry.input.right-geometry.padding+4&&geometry.send.right<=geometry.input.right&&geometry.send.top>=geometry.input.top&&geometry.send.bottom<=geometry.input.bottom,`send remains inside reserved composer space: ${details}`);
  };
  await coordinator.getByLabel('发送给 Coordinator').fill('Main 草稿');await historyAction.click();
  await coordinator.getByRole('button',{name:'历史开发 Session',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel')?.dataset.conversation==='session:history-one');
  assert.ok(coordinatorReads.includes('session:history-one'),'history opens the selected Session conversation');
  await coordinator.getByLabel('发送给 Coordinator').fill('历史草稿');await historyAction.click();
  await coordinator.getByRole('button',{name:'当前 · Main 对话',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel')?.dataset.conversation==='main');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'Main 草稿','switching history preserves each conversation draft');
  await coordinator.getByLabel('发送给 Coordinator').fill('');
  coordinatorReadFailure=true;
  await page.locator('#btn-coordinator').click();await page.locator('#btn-coordinator').click();
  const readRetry=coordinator.getByRole('button',{name:'重试读取',exact:true});
  await readRetry.waitFor();
  assert.equal(await readRetry.textContent(),'重新读取','read recovery is a contextual text action');
  assert.equal(await readRetry.evaluate(el=>el.parentElement?.id==='coordinator-panel'),true,'recovery stays outside the toolbar');
  await readRetry.click();
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel > [role=status]')?.textContent==='');
  const coordinatorLayout = await coordinator.evaluate(el => {
    const drawer = el.parentElement.getBoundingClientRect();
    const form = el.querySelector('form.coordinator-compose').getBoundingClientRect();
    const input = el.querySelector('.coordinator-input-shell textarea');
    const typing = el.querySelector('.coordinator-typing');
    const send = el.querySelector('.coordinator-input-shell > button');
    const blot = send.querySelector('.coordinator-working-blot');
    const arrow = send.querySelector('svg');
    const inputRect = input.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const arrowRect = arrow.getBoundingClientRect();
    const blotRect = blot.getBoundingClientRect();
    const centerDelta = rect => [Math.abs((rect.left + rect.right - sendRect.left - sendRect.right) / 2),
      Math.abs((rect.top + rect.bottom - sendRect.top - sendRect.bottom) / 2)];
    return { drawerBottom: drawer.bottom, panelBottom: el.getBoundingClientRect().bottom, formBottom: form.bottom,
      inputHeight: inputRect.height, sendPosition: getComputedStyle(send).position,
      sendWidth:sendRect.width,sendHeight:sendRect.height,sendRadius:getComputedStyle(send).borderRadius,
      sendCenterDelta: Math.abs((sendRect.top + sendRect.bottom - inputRect.top - inputRect.bottom) / 2),
      arrowCenterDelta:centerDelta(arrowRect),blotCenterDelta:centerDelta(blotRect),
      sendDisabled:send.disabled,
      workingLabelVisuallyHidden:getComputedStyle(typing).clipPath==='inset(50%)',
      workingLabel:typing.getAttribute('aria-label'),blotWidth:parseFloat(getComputedStyle(blot).width),
      sendTransition:getComputedStyle(send).transitionDuration,
      arrowTransition:getComputedStyle(arrow).transitionDuration,
      blotTransition:getComputedStyle(blot).transitionDuration,
      blotClipPath:getComputedStyle(blot).clipPath,
      blotParent:blot.parentElement===send,
      blotPixels:[blot?.width,blot?.height],typingDots:typing.querySelectorAll('i').length };
  });
  assert.ok(coordinatorLayout.panelBottom <= coordinatorLayout.drawerBottom + 1, 'chat stays inside the inspector height');
  assert.ok(coordinatorLayout.formBottom <= coordinatorLayout.drawerBottom + 1, 'chat composer remains visible inside the inspector');
  assert.ok(coordinatorLayout.inputHeight <= 58, `composer starts compact instead of filling the inspector: ${JSON.stringify(coordinatorLayout)}`);
  assert.equal(coordinatorLayout.sendPosition, 'absolute', 'send button sits inside the composer like ChatGPT');
  assert.deepEqual([coordinatorLayout.sendWidth,coordinatorLayout.sendHeight,coordinatorLayout.sendRadius],[32,32,'50%'],'send uses a compact circular control');
  assert.ok(coordinatorLayout.sendCenterDelta <= 0.5, `send arrow stays vertically centered in the composer: ${JSON.stringify(coordinatorLayout)}`);
  assert.ok(coordinatorLayout.arrowCenterDelta.every(delta=>delta<=0.25),`desktop send arrow is centered in its circle: ${JSON.stringify(coordinatorLayout)}`);
  assert.ok(coordinatorLayout.blotCenterDelta.every(delta=>delta<=0.25),`desktop working ink shares the arrow center: ${JSON.stringify(coordinatorLayout)}`);
  assert.ok(coordinatorLayout.sendTransition.startsWith('1s, 1s'),`button background and icon color hand off over one second: ${JSON.stringify(coordinatorLayout)}`);
  assert.equal(coordinatorLayout.arrowTransition,'1s','the arrow fades over one second without shrinking');
  assert.equal(coordinatorLayout.blotTransition,'1s, 1s','Ready ink opacity and center reveal share the one-second handoff');
  assert.match(coordinatorLayout.blotClipPath,/circle\(0% at 50% 50%\)/,'the hidden ink starts at the arrow center');
  await coordinator.locator('.coordinator-input-shell').screenshot({path:path.join(output,'coordinator-send-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  const mobileArrowCenterDelta=await coordinator.locator('.coordinator-send').evaluate(send=>{
    const button=send.getBoundingClientRect(),arrow=send.querySelector('svg').getBoundingClientRect();
    return [Math.abs((arrow.left+arrow.right-button.left-button.right)/2),Math.abs((arrow.top+arrow.bottom-button.top-button.bottom)/2)];
  });
  assert.ok(mobileArrowCenterDelta.every(delta=>delta<=0.25),`mobile send arrow is centered in its circle: ${mobileArrowCenterDelta}`);
  await coordinator.locator('.coordinator-input-shell').screenshot({path:path.join(output,'coordinator-send-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(coordinatorLayout.sendDisabled,true,'empty composer keeps the send arrow disabled');
  await coordinator.getByLabel('发送给 Coordinator').fill('可以发送');
  assert.equal(await coordinator.getByRole('button',{name:'发送',exact:true}).isEnabled(),true,'typing enables the send arrow immediately');
  await coordinator.getByLabel('发送给 Coordinator').fill('');
  assert.equal(coordinatorLayout.workingLabel,'正在处理','Ready working mark retains an accessible status');
  assert.equal(coordinatorLayout.workingLabelVisuallyHidden,true,'the auxiliary Working status does not replace the selected message shimmer');
  assert.equal(coordinatorLayout.blotParent,true,'Ready ink mark lives in the composer send control');
  assert.deepEqual([coordinatorLayout.blotWidth,coordinatorLayout.blotPixels],[36,[160,160]],'Ready ink atlas renders in a 36px canvas');
  assert.equal(coordinatorLayout.typingDots,0,'the old dots are removed');
  for(const width of [320,390,1440]){
    await coordinatorGeometry(width,'idle empty');
    assert.equal(await coordinator.locator('.coordinator-recovery').evaluate(el=>el.hidden),true,'idle recovery is not shown');
    assert.equal(await coordinator.locator('.coordinator-send').isEnabled(),false);
    await coordinator.getByLabel('发送给 Coordinator').fill('Synthetic first line\nSynthetic second line\nSynthetic third line');
    await coordinatorGeometry(width,'idle multiline');
    assert.equal(await coordinator.locator('.coordinator-send').isEnabled(),true);
    await coordinator.getByLabel('发送给 Coordinator').fill('');
  }
  coordinatorState={...coordinatorState,status:'running'};
  await page.locator('#btn-coordinator').click();await page.locator('#btn-coordinator').click();
  await coordinator.locator('.coordinator-send.is-working').waitFor();
  for(const width of [320,390,1440])await coordinatorGeometry(width,'running');
  assert.equal(await coordinator.locator('.coordinator-send').isEnabled(),false,'empty running composer retains its disabled send state');
  coordinatorReadOffline=true;
  await page.locator('#btn-coordinator').click();await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button',{name:'重试读取',exact:true}).waitFor();
  for(const width of [320,390,1440])await coordinatorGeometry(width,'running read failure, three toolbar controls plus contextual recovery');
  await page.setViewportSize({width:390,height:844});
  await coordinator.locator('.coordinator-toolbar').screenshot({path:path.join(output,'coordinator-mobile-toolbar.png')});
  coordinatorReadOffline=false;
  coordinatorState={...coordinatorState,status:'waiting-for-user'};
  assert.equal(await coordinator.getByRole('button',{name:'重试读取',exact:true}).isEnabled(),true);
  await coordinator.getByRole('button',{name:'重试读取',exact:true}).click();
  await coordinator.locator('.coordinator-recovery').waitFor({state:'hidden'});
  await coordinatorGeometry(390,'recovered, empty');
  await coordinator.getByLabel('发送给 Coordinator').fill('Synthetic line one\nSynthetic line two\nSynthetic line three');
  await coordinatorGeometry(390,'recovered multiline');
  await coordinator.locator('.coordinator-input-shell').screenshot({path:path.join(output,'coordinator-mobile-multiline.png')});
  await coordinator.getByLabel('发送给 Coordinator').fill('');
  await page.setViewportSize({width:1440,height:1000});
  record('UI-COORDINATOR-MOBILE-02: current model/three controls, contextual recovery and 44px single/multiline composer geometry');
  const historicalMessage=coordinator.locator('.coordinator-message.assistant').first();
  await historicalMessage.evaluate(node=>{node.dataset.historyProbe='kept';});
  runningPreview=true;
  await page.locator('#btn-coordinator').click();
  await page.locator('#btn-coordinator').click();
  await coordinator.locator('.coordinator-streaming').waitFor({state:'attached'});
  assert.equal(await coordinator.locator('.coordinator-streaming').count(), 1, 'streaming response keeps a live visual state');
  assert.equal(await coordinator.locator('.coordinator-streaming-text').count(), 1, 'streaming response uses a buffered text surface');
  await coordinator.locator('.coordinator-rise').first().waitFor();
  assert.equal(await coordinator.locator('.coordinator-typing.is-visible').count(), 1, 'working state remains while the response is still streaming');
  assert.equal(await coordinator.locator('.coordinator-word-reveal').count(),0,'response chunks appear without per-word opacity animation');
  await coordinator.locator('.coordinator-streaming').evaluate(node => { node.dataset.motionProbe = 'stable'; });
  await coordinator.locator('.coordinator-rise').first().waitFor();
  const firstRise=coordinator.locator('.coordinator-rise').first();
  await firstRise.evaluate(node=>{node.dataset.stableBlock='kept';});
  await coordinator.locator('.coordinator-messages').evaluate(node=>{
    node.__removedCommittedRows=0;
    node.__rowObserver=new MutationObserver(records=>{
      for(const record of records)for(const removed of record.removedNodes){
        if(removed.classList?.contains('coordinator-message')&&!removed.classList.contains('coordinator-streaming'))node.__removedCommittedRows++;
      }
    });
    node.__rowObserver.observe(node,{childList:true});
  });
  assert.equal(await firstRise.textContent(),'第一段回复。','Ready-style reveal waits for a complete paragraph');
  assert.equal(await firstRise.locator('.coordinator-rise-body').evaluate(node=>getComputedStyle(node).transitionDuration),'1.05s, 1.05s','new block uses Ready rise timing');
  const readsBeforeReconcile=coordinatorReads.length;
  coordinatorState.nodeReferences=[{id:'T0',title:'定位节点'}];
  for(let attempt=0;coordinatorReads.length===readsBeforeReconcile&&attempt<30;attempt++)await page.waitForTimeout(20);
  assert.ok(coordinatorReads.length>readsBeforeReconcile,'streaming state was refreshed after metadata changed');
  assert.equal(await firstRise.getAttribute('data-stable-block'),'kept','metadata refresh preserves already revealed blocks');
  assert.equal(await historicalMessage.getAttribute('data-history-probe'),'kept','metadata refresh does not rebuild committed transcript rows');
  const readsBeforeTool=coordinatorReads.length;
  coordinatorState.messages.push({role:'assistant',text:'',tools:[{name:'read_map'}]});
  for(let attempt=0;coordinatorReads.length===readsBeforeTool&&attempt<30;attempt++)await page.waitForTimeout(20);
  assert.ok(coordinatorReads.length>readsBeforeTool,'tool progress was polled');
  assert.equal(await historicalMessage.getAttribute('data-history-probe'),'kept','tool progress does not rebuild prior messages');
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>{
    node.__rowObserver.disconnect();return node.__removedCommittedRows;
  }),0,'polling and tool progress never detach committed message rows');
  await page.waitForFunction(()=>document.querySelectorAll('.coordinator-streaming-text .coordinator-rise').length===3);
  assert.equal(await coordinator.locator('.coordinator-streaming-text').textContent(), '第一段回复。第二段回复。第三段回复。', 'streaming response reveals whole paragraphs without dropping content');
  assert.equal(await firstRise.getAttribute('data-stable-block'),'kept','earlier blocks stay mounted while later blocks enter');
  assert.equal(await coordinator.locator('.coordinator-streaming .coordinator-markdown').evaluate(node => getComputedStyle(node, '::after').content), 'none', 'streaming response has no blinking caret');
  assert.equal(await coordinator.locator('.coordinator-streaming').getAttribute('data-motion-probe'), 'stable', 'streaming updates preserve the message node instead of replaying the whole transcript');
  const segmentBoundaries=await page.evaluate(async()=>{
    const {nextRevealSegmentEnd}=await import('/prototype/coordinator-markdown.mjs');
    return {
      paragraph:nextRevealSegmentEnd('第一段。\n\n第二段未完',0,false),
      openFence:nextRevealSegmentEnd('```js\nconst value = 1;',0,false),
      closedFence:nextRevealSegmentEnd('```js\nconst value = 1;\n```\n后续',0,false),
      brokenFence:nextRevealSegmentEnd('```js\nconst value = 1;',0,true),
      final:nextRevealSegmentEnd('没有空行的一整段回复。',0,true),
    };
  });
  assert.deepEqual(segmentBoundaries,{paragraph:'第一段。\n\n'.length,openFence:0,closedFence:'```js\nconst value = 1;\n```\n'.length,brokenFence:'```js\nconst value = 1;'.length,final:'没有空行的一整段回复。'.length},'reveal boundaries preserve Markdown blocks and drain the final paragraph');
  const readableItems=await page.evaluate(async()=>{
    const {conversationFragments,markdownFragment}=await import('/prototype/coordinator-markdown.mjs');
    const text='- Bug B399679682924：静态服务路径越界（工程）\n- **TD-438cae5ce21911a**: 边界回归测试（测试）\n- B505917140400 | 空值搜索崩溃\n\n```text\n- Bug B399679682924: 精确诊断编号\n```\n\n- `B399679682924`: 用户要求的编号\n- [诊断链接](/tasks/TD-438cae5ce21911a)\n- TD-example: 非内部编号\n- 部署到 8.218.56.89:8000';
    const messages=[{role:'assistant',text},{role:'user',text}];
    const container=document.createElement('div');container.append(conversationFragments(messages,document).body);
    const stream=document.createElement('div');stream.append(markdownFragment(text,document,{readableWorkItems:true}));
    const result={assistant:[...container.querySelectorAll('.assistant li')].map(x=>x.textContent),
      user:[...container.querySelectorAll('.user li')].map(x=>x.textContent),
      code:container.querySelector('.assistant pre code').textContent,
      link:new URL(container.querySelector('.assistant a').href).pathname,
      stream:[...stream.querySelectorAll('li')].map(x=>x.textContent),unchanged:messages[0].text===text};
    container.replaceChildren(container.querySelector('.assistant ul'));
    container.dataset.testid='readable-work-items-preview';
    container.style.cssText='position:fixed;inset:24px auto auto 24px;width:420px;padding:24px;background:#fffdf7;color:#333;z-index:100000;font:18px/1.8 sans-serif';
    document.body.append(container);
    return result;
  });
  assert.deepEqual(readableItems.assistant.slice(0,3),['静态服务路径越界（工程）','边界回归测试（测试）','空值搜索崩溃']);
  const partialNotice = await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div');
    host.append(conversationFragments([{ role: 'assistant', text: 'Interrupted text', partial: true }], document).body);
    return host.textContent;
  });
  assert.match(partialNotice, /部分回复（未完成）/);
  assert.equal(readableItems.user[0],'Bug B399679682924：静态服务路径越界（工程）','user-authored text remains verbatim');
  assert.equal(readableItems.code,'- Bug B399679682924: 精确诊断编号');
  assert.ok(readableItems.assistant.includes('B399679682924: 用户要求的编号'),'explicit code IDs remain available for diagnostics');
  assert.ok(readableItems.assistant.includes('TD-example: 非内部编号'));
  assert.ok(readableItems.assistant.includes('部署到 8.218.56.89:8000'));
  assert.equal(readableItems.link,'/tasks/TD-438cae5ce21911a');
  assert.deepEqual(readableItems.stream,readableItems.assistant,'streaming and committed lists use the same presentation');
  assert.equal(readableItems.unchanged,true,'readable presentation never rewrites durable conversation data');
  await page.getByTestId('readable-work-items-preview').screenshot({path:path.join(output,'coordinator-readable-work-items.png')});
  await page.getByTestId('readable-work-items-preview').evaluate(node=>node.remove());
  record('Coordinator work-item lists show names without exposing internal IDs; user text, code and links stay exact');
  runningPreview=false;coordinatorState.status='waiting-for-user';
  await page.locator('#btn-coordinator').click();
  await page.locator('#btn-coordinator').click();
  await page.waitForFunction(() => !document.querySelector('.coordinator-typing.is-visible'));
  const oneShotText='第一段最终回复。\n第二段最终回复。\n第三段最终回复。';
  coordinatorState={...coordinatorState,status:'waiting-for-user',streamingText:'',messages:[...coordinatorState.messages,{role:'assistant',text:oneShotText,tools:[]}]};
  await page.locator('#btn-coordinator').click();
  await page.locator('#btn-coordinator').click();
  const oneShotMessage=coordinator.locator('.coordinator-message.assistant').filter({hasText:'第一段最终回复。'}).last();
  await oneShotMessage.waitFor();
  assert.equal(await coordinator.locator('.coordinator-final-reveal,.coordinator-reveal-original').count(),0,'one-shot replies render only their final Markdown DOM');
  assert.ok(await oneShotMessage.locator('p').count()>=1,'one-shot replies use final Markdown structure immediately');
  const stableFinalLayout=await oneShotMessage.evaluate(node=>({text:node.textContent,html:node.innerHTML,height:node.getBoundingClientRect().height}));
  await page.waitForTimeout(300);
  assert.deepEqual(await oneShotMessage.evaluate(node=>({text:node.textContent,html:node.innerHTML,height:node.getBoundingClientRect().height})),stableFinalLayout,'one-shot reply layout stays unchanged after first paint');
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>getComputedStyle(node).paddingBottom),'36px','latest message keeps space above the composer');
  record('Coordinator composer is compact and reply state uses a continuous indicator');
  await coordinator.getByText('<img src=x onerror=alert(1)>', { exact: false }).waitFor();
  assert.ok(coordinatorReads.includes('main'), 'Main opens a fresh scoped conversation instead of legacy history');
  assert.equal(await coordinator.locator('img,script,iframe').count(), 0, 'Markdown cannot inject HTML or fetch remote images');
  assert.equal(await coordinator.locator('.coordinator-markdown strong').textContent(), '范围一致');
  assert.equal(await coordinator.locator('.coordinator-markdown ol > li > ul > li').textContent(), '保留目录边界');
  assert.equal(await coordinator.locator('.coordinator-markdown pre code').textContent(), 'const value = "<script>";');
  assert.equal(await coordinator.locator('.coordinator-markdown table tbody tr').count(), 1);
  assert.equal(await coordinator.getByRole('link', { name: '规范', exact: true }).getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await coordinator.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(markdownImageRequests.length, 0, 'rendering must not disclose viewing activity through remote images');
  const attachmentMarkup = await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div');
    host.append(conversationFragments([{ role: 'user', attachments: [
      { id: 'safe', filename: '<script>截图</script>.png', mimeType: 'image/png' },
      { id: 'external', filename: '外链', mimeType: 'image/png' },
      { id: 'text', filename: '需求.md', mimeType: 'text/markdown' },
    ] }], document, { attachmentUrl: item => item.id === 'external' ? 'https://example.invalid/private.png'
      : '/api/workbench/projects/fixture/api/coordinator/attachments/' + item.id }).body);
    return { rows: host.querySelectorAll('article').length, images: [...host.querySelectorAll('img')].map(image => image.getAttribute('src')),
      links: [...host.querySelectorAll('a')].map(link => ({ text: link.textContent, rel: link.rel })), scripts: host.querySelectorAll('script').length };
  });
  assert.equal(attachmentMarkup.rows, 1, 'attachment-only messages remain visible');
  assert.deepEqual(attachmentMarkup.images, ['/api/workbench/projects/fixture/api/coordinator/attachments/safe']);
  assert.deepEqual(attachmentMarkup.links.map(link => link.text), ['<script>截图</script>.png', '需求.md']);
  assert.ok(attachmentMarkup.links.every(link => link.rel === 'noopener noreferrer')); assert.equal(attachmentMarkup.scripts, 0);
  const inlineCodeLayout=await page.evaluate(async()=>{
    const {markdownFragment}=await import('/prototype/coordinator-markdown.mjs');
    const host=document.createElement('div');
    host.append(markdownFragment('服务器相关最合适的是工程节点。理由：它 owns `.github/workflows/`、`scripts/`、`package.json` 与 `_config.yml`，80 端口部署成果也归档在这里。'));
    return {paragraphs:host.querySelectorAll('p').length,codes:[...host.querySelectorAll('code')].map(node=>node.textContent),text:host.textContent};
  });
  assert.deepEqual(inlineCodeLayout.codes,['.github/workflows/','scripts/','package.json','_config.yml'],'long prose preserves every inline code span');
  assert.equal(inlineCodeLayout.paragraphs,1,'inline Markdown keeps the model-authored paragraph boundary');
  assert.doesNotMatch(inlineCodeLayout.text,/`/,'rendered Coordinator text never exposes code delimiters');
  assert.equal(await coordinator.locator('.coordinator-message.user').textContent(), '请审核这个计划');
  assert.equal(await coordinator.locator('.coordinator-speaker').count(), 0);
  assert.equal(await coordinator.getByRole('status').count(), 0, 'normal status is not displayed');
  assert.equal(await coordinator.locator('form.coordinator-compose').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
  assert.equal(await coordinator.locator('.coordinator-debug').count(), 0);
  assert.equal(await coordinator.getByText('请说明预期行为，并提供', { exact: false }).isVisible(), true, 'questions stay visible while tool diagnostics are collapsed');
  assert.equal(await coordinator.locator('.coordinator-messages').innerText().then(text=>text.includes('diagnostic-only')), false);
  assert.equal(await coordinator.getByText(/运行记录/).count(), 0);
  record('coordinator-safe-markdown-chat-without-diagnostics-controls');
  await page.locator('#btn-coordinator').click();
  assert.equal(await page.locator('#btn-coordinator').getAttribute('aria-expanded'), 'false');
  assert.equal(await coordinator.evaluate(el => el.parentElement === document.body), true, 'closed chat leaves the inspector available for node details');
  assert.equal((await page.locator('#detail h2').first().textContent()).trim(), detailTitleBeforeCoordinator);
  await page.locator('#btn-coordinator').click();
  await page.waitForFunction(() => document.querySelector('#coordinator-panel')?.dataset.conversation === 'main');
  await coordinator.getByLabel('发送给 Coordinator').fill('切回详情仍保留的草稿');
  await page.locator('.node[data-id="T0"]').click();
  assert.equal(await coordinator.getAttribute('open'), null, 'selecting a map node returns to its details');
  await page.locator('#btn-coordinator').click();
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(), '切回详情仍保留的草稿');
  await coordinator.getByLabel('发送给 Coordinator').fill('');
  await page.locator('#workbench-tools > summary').click();
  await page.locator('#btn-bugs').click();
  assert.equal(await coordinator.getAttribute('open'), null, 'work lists and Coordinator do not compete for the right panel');
  assert.equal(await page.locator('#btn-coordinator').getAttribute('aria-expanded'), 'false');
  await page.locator('#workbench-tools > summary').click();
  await page.locator('#btn-bugs').click();
  await page.locator('#btn-coordinator').click();
  record('Coordinator shares the node inspector and restores its previous detail view');
  await createSessionAction.click();
  await coordinator.getByText(/新建 Coordinator Session 尚未确认/).waitFor();
  await createSessionAction.click();
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel')?.dataset.conversation==='chat-created');
  assert.equal(conversationCreationRequests.length,2);
  assert.equal(conversationCreationRequests[0].id,conversationCreationRequests[1].id,'uncertain creation retries preserve the operation ID');
  assert.equal(await coordinator.locator('.coordinator-session-create').count(),0,'Coordinator Session creation never opens an execution environment form');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'');
  assert.equal(await coordinator.locator('.coordinator-messages').textContent(),'');
  record('Coordinator creates a durable blank chat Session without creating an execution Session');
  const navigationVersion = await syncVersion();
  await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div'); host.id = 'node-link-test';
    host.append(conversationFragments([{ role: 'assistant', text: '推荐：**前端交互**；未知节点；重名；`前端交互`；[前端交互](https://example.invalid)' }], document, {
      nodes: [{ id: 'target', title: '前端交互（frontend/）' }, { id: 'a', title: '重名' }, { id: 'b', title: '重名' }],
      onNode: id => { host.dataset.selected = id; },
    }).body);
    document.body.append(host);
  });
  assert.equal(await page.locator('#node-link-test button').count(), 0, 'plain response text never becomes Map buttons');
  assert.match(await page.locator('#node-link-test').textContent(), /前端交互/, 'node names remain readable text');
  await page.locator('#node-link-test').evaluate(node => node.remove());
  await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div'); host.id = 'legacy-question-test';
    host.append(conversationFragments([{ role: 'assistant', text: '等待你确认的三个澄清问题如下：\n\n1. TD3：空搜索结果的提示文案与行为，建议挂「前端交互」。\n\n2. B41：搜索框清空后的结果恢复行为，建议挂「前端交互」。\n\n3. TD4：测试实验的目标、完成条件与挂载节点。' }], document, {
      nodes: [{ id: 'frontend', title: '前端交互（frontend/）' }], canAnswer: true, onAnswer: () => {}, onNode: () => {},
    }).body);
    document.body.append(host);
  });
  assert.equal(await page.locator('#legacy-question-test .coordinator-legacy-question').count(), 3, 'legacy numbered confirmation questions become inline cards');
  assert.equal(await page.locator('#legacy-question-test textarea').count(), 3, 'each legacy question has an inline answer field');
  assert.equal(await page.locator('#legacy-question-test button.coordinator-node-link').count(), 0, 'legacy question text does not create implicit node buttons');
  await page.locator('#legacy-question-test').evaluate(node => node.remove());
  await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div'); host.id = 'structured-node-test';
    host.append(conversationFragments([{ role: 'assistant', text: '建议放在这里。', actions: [
      { kind: 'node-references', message: '候选节点', nodes: [{ id: 'reader', title: '阅读' }, { id: 'admin', title: '管理' }, { id: 'content', title: '内容' }, { id: 'test', title: '工程' }] },
      { kind: 'node-navigation', actionId: 'direct-open', node: { id: 'admin', title: '管理' } },
      { kind: 'node-tour', actionId: 'direct-tour', nodes: [{ id: 'reader', title: '阅读' }, { id: 'admin', title: '管理' }] },
      { kind: 'node-read', actionId: 'direct-read', node: { id: 'reader', title: '阅读' } },
      { kind: 'conversation-mounted', conversationId: 'item-next', node: { id: 'reader', title: '阅读' } },
    ] }, { role: 'assistant', text: '选择节点', questions: [{ id: 'node-choice', text: '挂到哪里？', nodes: [{ id: 'reader', title: '阅读' }] }] }], document, {
      canAnswer: true, onNode: id => { host.dataset.selected = id; }, onConversation: id => { host.dataset.conversation = id; }, onAnswer: () => {},
    }).body);
    document.body.append(host);
  });
  assert.equal(await page.locator('#structured-node-test .coordinator-actions').first().locator('button.coordinator-node-link').count(), 3, 'even historical structured actions render at most three node buttons');
  assert.equal(await page.locator('#structured-node-test button.coordinator-node-link').count(), 5);
  await page.locator('#structured-node-test .coordinator-actions button.coordinator-node-link').first().evaluate(button => button.click());
  assert.equal(await page.locator('#structured-node-test').getAttribute('data-selected'), 'reader');
  await page.locator('#structured-node-test').getByRole('button', { name: '继续这个事项' }).evaluate(button => button.click());
  assert.equal(await page.locator('#structured-node-test').getAttribute('data-conversation'), 'item-next');
  await page.locator('#structured-node-test').evaluate(node => node.remove());
  await page.evaluate(async () => {
    const { conversationFragments } = await import('/prototype/coordinator-markdown.mjs');
    const host = document.createElement('div'); host.id = 'question-keyboard-test';
    host.append(conversationFragments([{ role: 'assistant', text: '补充细节', questions: [{ id: 'keyboard-question', text: '请补充细节' }] }], document, {
      canAnswer: true, onAnswer: (_question, answer) => { host.dataset.answer = answer; },
    }).body);
    document.body.append(host);
  });
  const keyboardAnswer = page.locator('#question-keyboard-test textarea');
  await keyboardAnswer.fill('第一行'); await keyboardAnswer.press('Shift+Enter'); await keyboardAnswer.type('第二行');
  assert.equal(await keyboardAnswer.inputValue(), '第一行\n第二行', 'Shift+Enter keeps a newline in an inline answer');
  await keyboardAnswer.press('Enter');
  assert.equal(await page.locator('#question-keyboard-test').getAttribute('data-answer'), '第一行\n第二行', 'Enter sends an inline answer');
  assert.equal(await page.locator('#question-keyboard-test .coordinator-answer-compose > button').textContent(), '发送');
  await page.locator('#question-keyboard-test').evaluate(node => node.remove());
  coordinatorState.nodeReferences = [{ id: 'T0', title: '定位节点' }];
  coordinatorState.messages.push({ role: 'assistant', text: '推荐挂载节点。', actions: [{ kind: 'node-references', message: '推荐', nodes: [{ id: 'T0', title: '定位节点' }] }] });
  await page.reload(); await synchronized();
  await page.locator('#btn-coordinator').click();
  await coordinator.locator('textarea').fill('跳转时保留草稿');
  await coordinator.getByRole('button', { name: '定位节点', exact: true }).click();
  assert.equal(await coordinator.getAttribute('open'), '', 'node navigation keeps the conversation open');
  assert.equal(await coordinator.locator('textarea').inputValue(), '跳转时保留草稿');
  await coordinator.locator('textarea').fill('');
  assert.equal(await page.locator('.node.selected[data-id="T0"]').count(), 1);
  assert.equal(await syncVersion(), navigationVersion, 'navigation does not mutate Main');
  assert.equal(approvals.length + mountReviews.length + submissions.length, 0, 'navigation never approves or dispatches');
  record('coordinator-node-navigation-without-approval');
  const directActionId='coordinator:direct-open-T0';
  coordinatorState.messages.push({role:'assistant',text:'已打开定位节点。',actions:[{kind:'node-navigation',actionId:directActionId,node:{id:'T0',title:'定位节点'}}]});
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await page.waitForFunction(id=>sessionStorage.getItem('cg-coordinator-navigation:'+id)==='1',directActionId);
  assert.equal(await page.locator('.node.selected[data-id="T0"]').count(),1,'direct navigation action opens the Map node without another click');
  const directMessage=coordinator.locator('.coordinator-message.assistant').filter({hasText:'已打开定位节点。'}).last();
  assert.equal(await directMessage.getByRole('button',{name:'定位节点',exact:true}).count(),0,'direct navigation action does not render a second-step node button');
  const tourActionId='coordinator:tour-N1-N2';
  await page.evaluate(()=>localStorage.setItem('cg-workbench-beta-map-motion','1'));
  await page.addInitScript(()=>{window.__coordinatorTourTransitions=[];addEventListener('cg:map-transition-end',event=>window.__coordinatorTourTransitions.push(event.detail.viewRootId));});
  coordinatorState.messages.push({role:'assistant',text:'已展示 Map 游览。',actions:[{kind:'node-tour',actionId:tourActionId,nodes:[{id:'N1',title:'Tour one'},{id:'N2',title:'Tour two'}]}]});
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await page.waitForFunction(id=>sessionStorage.getItem('cg-coordinator-navigation:'+id)==='1',tourActionId);
  await page.waitForFunction(()=>document.querySelector('#nav-crumbs')?.textContent?.includes('Tour two'));
  assert.deepEqual(await page.evaluate(()=>window.__coordinatorTourTransitions),['N1','N2'],'Map tour waits for each animation to finish before starting the next');
  assert.equal(await coordinator.locator('.coordinator-message.assistant').filter({hasText:'已展示 Map 游览。'}).last().locator('button').count(),0,'Map tour renders no manual node controls');
  const readActionId='coordinator:read-T0';
  coordinatorState.messages.push({role:'assistant',text:'读取完成。',actions:[{kind:'node-read',actionId:readActionId,node:{id:'T0',title:'定位节点'}}]});
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await page.waitForFunction(id=>sessionStorage.getItem('cg-coordinator-navigation:'+id)==='1',readActionId);
  assert.equal(await page.locator('.node.selected[data-id="T0"]').count(),1,'read_map action visibly focuses the node');
  assert.equal(await coordinator.locator('.coordinator-message.assistant').filter({hasText:'读取完成。'}).last().locator('button').count(),0,'read_map focus needs no manual node button');
  coordinatorState.messages.push({role:'user',text:'查看组合动效'});
  coordinatorState.status='running';coordinatorState.streamingText='';
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await historicalMessage.evaluate(node=>{node.dataset.historyProbe='kept-after-reload';});
  await coordinator.locator('.coordinator-send.is-working canvas').waitFor({state:'visible'});
  await coordinator.locator('.coordinator-planning').waitFor({state:'visible'});
  assert.equal(await coordinator.locator('.coordinator-message.user').last().evaluate(node=>node.nextElementSibling?.className),'coordinator-planning','M03 shimmer sits directly below the newest user message');
  assert.equal(await coordinator.locator('.coordinator-planning').textContent(),'Planning next moves','M03 keeps the selected wording');
  assert.equal(await coordinator.locator('.coordinator-typing-phase').evaluate(node=>getComputedStyle(node).animationName),'coordinator-text-shimmer','M03 shimmer animates during planning');
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('.coordinator-send.is-working canvas');
    if(!canvas)return false;
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let index=3;index<pixels.length;index+=4)if(pixels[index]>0)return true;
    return false;
  });
  await page.waitForFunction(()=>{
    const send=document.querySelector('.coordinator-send.is-working-ready');
    const canvas=send?.querySelector('.coordinator-working-blot');
    return canvas&&getComputedStyle(canvas).opacity==='1'&&getComputedStyle(send.querySelector('svg')).opacity==='0';
  });
  assert.ok(workingBlotRequests.length,'Ready atlas is fetched through the authenticated Cloud asset route');
  assert.ok(workingBlotRequests.some(url=>url.endsWith('/prototype/working-blot-atlas.png')&&!url.includes('/assets/')),
    'a stale versioned atlas recovers through the authenticated current asset');
  await coordinator.screenshot({path:path.join(output,'coordinator-ready-working.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await coordinator.locator('.coordinator-message.user').last().evaluate(node=>node.nextElementSibling?.className),'coordinator-planning','mobile M03 shimmer stays below the user message');
  assert.equal(await coordinator.locator('.coordinator-send.is-working canvas').isVisible(),true,'mobile M04 ink stays inside the send control');
  await coordinator.screenshot({path:path.join(output,'coordinator-ready-working-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  const blotCanvas=coordinator.locator('.coordinator-send.is-working canvas');
  assert.equal(await blotCanvas.evaluate(canvas=>getComputedStyle(canvas).filter),'none','Ready ink colors are not flattened by a fixed CSS tint');
  assert.match(await blotCanvas.evaluate(canvas=>getComputedStyle(canvas).transitionDuration),/1s/,'the one-second arrow-to-ink transition remains');
  const inkColor=await blotCanvas.evaluate(canvas=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>32)return [...pixels.slice(index,index+3)];
    return null;
  });
  assert.ok(inkColor,'Ready ink has visible color pixels');
  const inkFrame=await blotCanvas.evaluate(canvas=>canvas.toDataURL());
  await page.waitForTimeout(150);
  assert.notEqual(await blotCanvas.evaluate(canvas=>canvas.toDataURL()),inkFrame,'working mark advances through Ready ink frames');
  assert.notDeepEqual(await blotCanvas.evaluate(canvas=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>32)return [...pixels.slice(index,index+3)];
    return null;
  }),inkColor,'Ready ink hue changes while working');
  coordinatorState.status='waiting-for-user';
  await page.waitForFunction(()=>!document.querySelector('.coordinator-send.is-working'));
  await page.waitForTimeout(1050);
  await page.emulateMedia({reducedMotion:'reduce'});
  coordinatorState.status='running';
  await coordinator.locator('.coordinator-send.is-working canvas').waitFor({state:'visible'});
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('.coordinator-send.is-working canvas');
    if(!canvas)return false;
    const pixels=canvas.getContext('2d').getImageData(0,0,160,160).data;
    for(let index=3;index<pixels.length;index+=4)if(pixels[index]>0)return true;
    return false;
  });
  const stillFrame=await blotCanvas.evaluate(canvas=>canvas.toDataURL());
  await page.waitForTimeout(150);
  assert.equal(await blotCanvas.evaluate(canvas=>canvas.toDataURL()),stillFrame,'reduced motion freezes the Ready mark');
  assert.equal(await coordinator.locator('.coordinator-typing-phase').evaluate(node=>getComputedStyle(node).animationName),'none','reduced motion makes the message shimmer static');
  assert.equal(await blotCanvas.evaluate(node=>getComputedStyle(node).transitionDuration),'0s','reduced motion removes the one-second ink transition');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const planningPlacement=await blotCanvas.evaluate(node=>({
    parent:node.parentElement?.className,
    insideComposer:!!node.closest('.coordinator-compose'),
    messageInk:!!document.querySelector('.coordinator-messages .coordinator-working-blot'),
  }));
  assert.match(planningPlacement.parent,/coordinator-send/,'working state replaces the send arrow');
  assert.equal(planningPlacement.insideComposer,true,'Ready ink stays in the composer');
  assert.equal(planningPlacement.messageInk,false,'the message timeline contains no working ink');
  coordinatorState.streamingText='正在形成可见答案';
  await coordinator.locator('.coordinator-streaming').waitFor({state:'attached'});
  assert.equal(await coordinator.locator('.coordinator-typing').textContent(),'Working · 正在生成回复','screen-reader activity updates without a visible toolbar label');
  assert.equal(await coordinator.getByText('正在形成可见答案',{exact:true}).count(),0,'an unfinished paragraph stays buffered');
  assert.equal(await coordinator.locator('.coordinator-planning').count(),1,'M03 remains while the first paragraph is buffered');
  assert.equal(await coordinator.locator('.coordinator-send.is-working').count(),1,'M04 ink continues while the reply is buffered');
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';
  coordinatorState.messages.push({role:'assistant',text:'最终答案'});
  await coordinator.locator('.coordinator-message.assistant').filter({hasText:'最终答案'}).last().waitFor();
  assert.equal(await coordinator.getByText('正在形成可见答案',{exact:true}).count(),0,'stream preview is replaced by the durable final message');
  const transitionText='流式转最终只保留一份';
  coordinatorState.status='running';coordinatorState.streamingText=transitionText;
  coordinatorState.messages.push({role:'user',text:'检查重复过渡'},{role:'assistant',text:transitionText});
  await coordinator.locator('.coordinator-message.assistant').filter({hasText:transitionText}).waitFor();
  assert.equal(await coordinator.locator('.coordinator-message.assistant').filter({hasText:transitionText}).count(),1,'a committed final response suppresses the identical streaming preview');
  assert.equal(await coordinator.locator('.coordinator-streaming').count(),0,'the committed response is never rendered as a second streaming row');
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';
  const seamlessText='先检查页面层级与段落间距。\n\n1. 检查对齐与留白。\n2. 检查窄屏换行。';
  coordinatorState.messages.push({role:'user',text:'检查流式完成态'});
  coordinatorState.status='running';coordinatorState.streamingText=seamlessText.slice(0,-10);
  await coordinator.locator('.coordinator-streaming').waitFor();
  await coordinator.locator('.coordinator-streaming .coordinator-streaming-text .coordinator-rise').first().waitFor();
  await coordinator.locator('.coordinator-streaming').evaluate(node=>{
    node.dataset.finalizationProbe='kept';
    node.querySelector('.coordinator-streaming-text > :first-child').__coordinatorBlockProbe='kept';
  });
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=0;});
  coordinatorState.streamingText=seamlessText;
  await coordinator.locator('.coordinator-streaming .coordinator-streaming-text .coordinator-rise').first().waitFor();
  assert.equal(await coordinator.locator('.coordinator-streaming .coordinator-streaming-text ol li:last-child').count(),0,'incomplete list stays buffered until its closing boundary');
  assert.equal(await coordinator.locator('.coordinator-streaming .coordinator-streaming-text > :first-child').evaluate(node=>node.__coordinatorBlockProbe),'kept','stream updates patch stable Markdown blocks instead of replacing them');
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>node.scrollTop),0,'stream updates do not steal scroll position while the user reads older messages');
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';coordinatorState.messages.push({role:'assistant',text:seamlessText});
  const seamlessFinal=coordinator.locator('.coordinator-message.assistant').filter({hasText:'先检查页面层级与段落间距。'}).last();
  await page.waitForFunction(()=>!document.querySelector('.coordinator-streaming'));
  assert.equal(await seamlessFinal.getAttribute('data-finalization-probe'),'kept','stream completion keeps the existing assistant message node');
  assert.equal(await seamlessFinal.locator('.coordinator-streaming-text > :first-child').evaluate(node=>node.__coordinatorBlockProbe),'kept','stream completion keeps the existing Markdown block without rebuilding it');
  assert.equal(await seamlessFinal.locator('ol li').last().textContent(),'检查窄屏换行。','the final buffered list appears after completion');
  assert.equal(await historicalMessage.getAttribute('data-history-probe'),'kept-after-reload','finalization preserves older transcript rows');
  record('coordinator-streaming-text-is-visible-before-final-message');
  const intermediateText='已经展示的第一步。\n\n';
  const nextStepText='接着展示的第二步。\n\n';
  coordinatorState.messages.push({role:'user',text:'检查多轮模型调用'});
  coordinatorState.status='running';coordinatorState.streamingText=intermediateText;
  await coordinator.locator('.coordinator-streaming .coordinator-rise').last().waitFor();
  coordinatorState.messages.push({role:'assistant',text:intermediateText,tools:[{name:'read_map'}]});
  coordinatorState.streamingText='';
  await page.waitForFunction(()=>!document.querySelector('.coordinator-streaming'));
  const intermediateRow=coordinator.locator('.coordinator-message.assistant').filter({hasText:'已经展示的第一步。'}).last();
  await intermediateRow.evaluate(node=>{node.dataset.multistepProbe='kept';});
  await coordinator.locator('.coordinator-planning').waitFor({state:'visible'});
  assert.equal(await intermediateRow.evaluate(node=>node.nextElementSibling?.className),'coordinator-planning',
    'the planning animation moves below retained assistant text between model calls');
  const beforeMultistepScreenshot=await coordinator.locator('.coordinator-messages').evaluate(node=>{
    const previous=node.scrollTop;node.scrollTop=node.scrollHeight;return previous;
  });
  await coordinator.screenshot({path:path.join(output,'coordinator-multistep-planning.png')});
  await coordinator.locator('.coordinator-messages').evaluate((node,previous)=>{node.scrollTop=previous;},beforeMultistepScreenshot);
  coordinatorState.streamingText=nextStepText;
  await coordinator.locator('.coordinator-streaming .coordinator-rise').last().waitFor();
  assert.equal(await intermediateRow.getAttribute('data-multistep-probe'),'kept','new model output does not remove the previous assistant row');
  assert.equal(await coordinator.locator('.coordinator-message.assistant').filter({hasText:'已经展示的第一步。'}).count(),1,
    'the first model call remains visible while the second call streams');
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';
  coordinatorState.messages.push({role:'assistant',text:nextStepText,tools:[]});
  await page.waitForFunction(()=>!document.querySelector('.coordinator-streaming'));
  assert.equal(await intermediateRow.getAttribute('data-multistep-probe'),'kept','completion retains the earlier assistant DOM row');
  assert.equal(await coordinator.locator('.coordinator-message.assistant').filter({hasText:'接着展示的第二步。'}).count(),1,
    'the final model call appears once after the earlier text');
  record('Coordinator retains intermediate text and places planning below it across model calls');
  const rapidRevealText=Array.from({length:8},(_,index)=>`第 ${index+1} 段已经完整。`).join('\n\n');
  coordinatorState.messages.push({role:'user',text:'检查已完成文本的显示速度'});
  coordinatorState.status='running';coordinatorState.streamingText='第 1 段已经完整。\n\n';
  await coordinator.locator('.coordinator-streaming .coordinator-rise').last().waitFor();
  assert.equal(await coordinator.locator('.coordinator-send.is-working').count(),1,'working mark stays visible while a streamed block is being revealed');
  const revealStarted=Date.now();
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';
  coordinatorState.messages.push({role:'assistant',text:rapidRevealText});
  await page.waitForFunction(()=>[...document.querySelectorAll('#coordinator-panel .coordinator-messages > .coordinator-message.assistant')].at(-1)?.textContent?.includes('第 8 段已经完整。'),null,{timeout:1800});
  assert.ok(Date.now()-revealStarted<1800,'completed text drains promptly instead of waiting 1.1 seconds per block');
  await page.waitForFunction(()=>!document.querySelector('.coordinator-send.is-working'));
  assert.equal(await coordinator.locator('.coordinator-messages > .coordinator-message.assistant').last().getByText('第 8 段已经完整。',{exact:true}).count(),1,'rapid drain renders the final block only once');
  const structuredQuestionText='当前有四个未完成事项。\n\n想先处理哪一项？';
  coordinatorState.status='running';coordinatorState.activity='preparing-question';coordinatorState.streamingText=structuredQuestionText;
  await coordinator.locator('.coordinator-streaming').waitFor();
  await page.waitForFunction(()=>document.querySelector('.coordinator-streaming .coordinator-streaming-text')?.textContent==='当前有四个未完成事项。');
  assert.equal(await coordinator.locator('.coordinator-typing').textContent(),'Working · 正在整理选项','question-stage activity remains accessible');
  assert.equal(await coordinator.locator('.coordinator-planning').count(),0,'M03 exits when visible reply text arrives');
  assert.equal(await coordinator.locator('.coordinator-send.is-working').count(),1,'M04 continues after M03 exits');
  assert.equal(await coordinator.locator('.coordinator-send.is-working-ready svg').count(),2,'arrow and network-independent ink remain mounted during the working transition');
  await coordinator.locator('.coordinator-streaming').evaluate(node=>{
    node.dataset.questionTransitionProbe='kept';
    node.querySelector('.coordinator-streaming-text > :first-child').__questionLeadProbe='kept';
  });
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=0;});
  coordinatorState.streamingText='';coordinatorState.activity=null;coordinatorState.status='waiting-for-user';
  coordinatorState.messages.push({role:'assistant',text:structuredQuestionText,questions:[{id:'next-task',text:'想先处理哪一项？',options:['部署博客','处理 Bug']}]});
  await coordinator.getByRole('button',{name:'部署博客',exact:true}).waitFor();
  const structuredQuestion=coordinator.locator('.coordinator-message.assistant').filter({hasText:'当前有四个未完成事项。'}).last();
  assert.equal(await structuredQuestion.getAttribute('data-question-transition-probe'),'kept','structured questions keep the streaming assistant message node');
  assert.equal(await structuredQuestion.locator('.coordinator-streaming-text > :first-child').evaluate(node=>node.__questionLeadProbe),'kept','structured questions keep the already visible lead text node');
  assert.equal(await structuredQuestion.getByText('当前有四个未完成事项。',{exact:true}).count(),1,'structured questions retain the non-duplicate lead text');
  assert.equal(await structuredQuestion.getByText('想先处理哪一项？',{exact:true}).count(),1,'the question prompt appears once instead of duplicating the streamed suffix');
  await page.waitForFunction(()=>document.querySelector('.coordinator-typing')?.getAttribute('aria-hidden')==='true');
  assert.equal(await coordinator.locator('.coordinator-typing.is-visible').count(),0,'committed card clears the transient working status');
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>node.scrollTop),0,'appending a question card does not jump the conversation to the card');
  assert.equal(await historicalMessage.getAttribute('data-history-probe'),'kept-after-reload','question-card insertion does not remount older messages');
  coordinatorState.messages.pop();
  coordinatorState.messages.push({role:'assistant',text:'要上传什么？',questionOnly:true,questions:[{id:'choice',text:'要上传什么？',options:['网站构建产物','其他文件']}]});
  await coordinator.getByRole('button',{name:'网站构建产物',exact:true}).waitFor();
  assert.equal(await coordinator.locator('.coordinator-input-shell > button').textContent(),'','the main send control uses an icon instead of a text label');
  assert.equal(await coordinator.getByRole('button',{name:'发送',exact:true}).getAttribute('title'),'发送','the icon-only send control keeps an accessible label');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'','question answers work while the main composer is empty');
  await coordinator.getByLabel('回答：要上传什么？').fill('保留我的补充');
  await coordinator.getByRole('button',{name:'网站构建产物',exact:true}).click();
  assert.equal(submissions.length,0,'the first option click only selects it');
  assert.equal(await coordinator.getByRole('button',{name:'网站构建产物',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await coordinator.getByRole('button',{name:'提交回答',exact:true}).count(),0,'questions have no separate submit-answer button');
  const readsBeforeCardAnswer=coordinatorReads.length;
  await coordinator.getByRole('button',{name:'网站构建产物',exact:true}).click();
  await coordinator.locator('.coordinator-planning').waitFor({state:'visible'});
  assert.equal(await coordinator.locator('.coordinator-message.user').last().evaluate(node=>node.nextElementSibling?.className),'coordinator-planning','card-answer shimmer sits below the new user message');
  assert.equal(await coordinator.locator('.coordinator-typing').getAttribute('aria-hidden'),'false','card answers start the same working state as free-form messages');
  assert.equal(await coordinator.locator('.coordinator-planning').textContent(),'Planning next moves','card answers show M03 beneath the sent reply');
  assert.equal(await coordinator.locator('.coordinator-typing-phase').evaluate(el=>getComputedStyle(el).animationName),'coordinator-text-shimmer','M03 shimmer runs for card answers');
  await page.waitForFunction(()=>{
    const send=document.querySelector('.coordinator-send.is-working-ready');
    const canvas=send?.querySelector('canvas');
    if(!canvas)return false;
    if(Number(getComputedStyle(canvas).opacity)<.95||Number(getComputedStyle(send.querySelector('svg')).opacity)>.05)return false;
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let index=3;index<pixels.length;index+=4)if(pixels[index]>0)return true;
    return false;
  });
  await coordinator.screenshot({path:path.join(output,'coordinator-card-answer-motion.png')});
  await page.waitForTimeout(3300);
  assert.ok(coordinatorReads.length>readsBeforeCardAnswer,'stale coordinator state is read while card submission remains in flight');
  assert.equal(await coordinator.locator('.coordinator-typing').getAttribute('aria-hidden'),'false','stale polling does not hide card-answer working state');
  assert.equal(await coordinator.locator('.coordinator-planning').count(),1,'stale polling does not remove card-answer shimmer');
  assert.equal(await coordinator.locator('.coordinator-send.is-working-ready').count(),1,'stale polling does not reset card-answer ink');
  releaseCardSubmission();
  await coordinator.getByRole('button',{name:'重试原请求',exact:true}).waitFor();
  assert.equal(await coordinator.getByRole('button',{name:'重试原请求',exact:true}).textContent(),'重试','failure recovery remains explicit');
  assert.equal(await coordinator.getByRole('button',{name:'重试原请求',exact:true}).evaluate(el=>el.parentElement===document.querySelector('#coordinator-panel')),true,'retry remains outside the toolbar');
  assert.equal(submissions.length,1);
  assert.equal(submissions[0].text,'网站构建产物\n\n保留我的补充');
  assert.equal(submissions[0].answerTo,'choice');
  assert.equal(await coordinator.getByLabel('回答：要上传什么？').inputValue(),'保留我的补充');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'');
  assert.equal(await coordinator.getByRole('button',{name:'网站构建产物',exact:true}).isEnabled(),false);
  assert.equal(approvals.length+mountReviews.length,0,'choice answers are never approvals');
  coordinatorState.status='running';coordinatorState.activeTurnId=submissions[0].id;
  coordinatorState.messages.at(-1).questions[0].answer={text:submissions[0].text,requestId:submissions[0].id};
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await coordinator.locator('.coordinator-question-status').waitFor({state:'visible'});
  assert.match(await coordinator.locator('.coordinator-answer').textContent(),/网站构建产物[\s\S]*保留我的补充/);
  assert.equal(await coordinator.locator('.coordinator-send.is-working').count(),1,'answer status stays with the question while the agent remains working');
  coordinatorState.status='waiting-for-user';coordinatorState.activeTurnId=null;
  await coordinator.locator('.coordinator-question-status').waitFor({state:'hidden'});
  coordinatorState.status='running';
  await coordinator.locator('.coordinator-send.is-working').waitFor();
  coordinatorState.status='waiting-for-user';
  await page.waitForFunction(()=>!document.querySelector('.coordinator-send.is-working'));
  // Reload clears the deliberately uncertain local request; this mock has not persisted it.
  submissions.length=0;coordinatorState.messages.pop();
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  coordinatorState.messages.push({role:'assistant',text:'请先回答顺序问题。',questions:[{id:'ordering-question',text:'具体是什么问题？'}]});
  await coordinator.getByLabel('回答：具体是什么问题？').fill('这条回答必须位于后续回复之前');
  await coordinator.getByRole('button',{name:'发送“具体是什么问题？”'}).click();
  await coordinator.getByText('后续回复应排在回答之后。',{exact:true}).waitFor();
  assert.equal(await coordinator.locator('.coordinator-message.assistant').last().locator('.coordinator-rise.is-entering').count(),1,'a direct reply after a card answer uses the same text reveal');
  const orderedRows=await coordinator.locator('.coordinator-messages > .coordinator-message').allTextContents();
  const answerIndex=orderedRows.findIndex(text=>text.trim()==='这条回答必须位于后续回复之前');
  const replyIndex=orderedRows.findIndex(text=>text.includes('后续回复应排在回答之后。'));
  assert.ok(answerIndex>=0&&answerIndex<replyIndex,'a persisted answer replaces its optimistic row in chronological order');
  assert.equal(await coordinator.locator('.coordinator-optimistic').count(),0,'the acknowledged answer does not linger at the bottom');
  coordinatorState.messages.splice(-3);
  submissions.length=0;
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=0;});
  await coordinator.screenshot({ path: path.join(output, 'coordinator-chat.png') });
  await coordinator.getByRole('button', { name: '确认这些节点', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('节点审核尚未成功'));
  await coordinator.getByRole('button', { name: '确认这些节点', exact: true }).click();
  await coordinator.getByRole('button', { name: '确认这些节点', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(mountReviews[0].proposalIds, ['frontend', 'build']);
  assert.deepEqual(mountReviews[1], mountReviews[0], 'the batch retry preserves its original request');
  assert.equal(submissions.length, 0, 'node confirmation uses the script endpoint, not a model request');
  coordinatorState.approvals.push({ id: 'reader', kind: 'mount-proposal', pending: true,
    mainVersion: 'main-v2', title: 'reader', purpose: '读者体验', owns: ['reader/'] });
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button', { name: '拒绝这些节点', exact: true }).click();
  await coordinator.getByRole('button', { name: '拒绝这些节点', exact: true }).waitFor({ state: 'detached' });
  assert.equal(mountReviews[2].decision, 'rejected');
  assert.equal(mountReviews[2].reason, '拒绝所示节点，请重新提案');
  await coordinator.getByRole('button', { name: '确认需求', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('确认尚未成功'));
  await coordinator.getByRole('button', { name: '确认需求', exact: true }).click();
  await coordinator.getByRole('button', { name: '确认需求', exact: true }).waitFor({ state: 'detached' });
  assert.equal(approvals[0].id, approvals[1].id);
  assert.equal(submissions.length, 0, 'human confirmation is a script request, not a model prompt');
  await coordinator.getByLabel('发送给 Coordinator').fill('模拟需求');
  await coordinator.getByLabel('发送给 Coordinator').press('Shift+Enter');
  await coordinator.getByLabel('发送给 Coordinator').type('补充一行');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'模拟需求\n补充一行');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('MODEL_TIMEOUT'));
  assert.equal(submissions[0].id, submissions[1].id, 'a healthy read retries an unaccepted transport failure with the exact request ID');
  assert.equal(submissions.length,2,'automatic recovery sends only one safe transport retry');
  await coordinator.screenshot({path:path.join(output,'coordinator-submit-error-near-composer.png')});
  await page.reload(); await synchronized();
  await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button', { name: '重试原请求' }).waitFor();
  await coordinator.locator('textarea').fill('未提交的纠正意见');
  await coordinator.getByRole('button', { name: '重试原请求' }).click();
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('MODEL_TIMEOUT'));
  assert.equal(submissions[2].id, submissions[0].id);
  assert.equal(submissions[2].retry, true, 'provider retry survives reload and remains explicit');
  assert.equal(await coordinator.locator('textarea').inputValue(), '未提交的纠正意见', 'retrying another request must not erase an unsent draft');
  assert.equal(await coordinator.getByRole('button', { name: '发送', exact: true }).isEnabled(), false, 'unknown transport failure still preserves the original intent');
  coordinatorState = { ...coordinatorState, canCorrect: true, error: { code: 'NOT_FOUND' } };
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('可补充纠正意见'));
  await coordinator.locator('textarea').fill('更正审批 ID，先核对当前 Plan');
  await coordinator.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent === '' && document.querySelector('#coordinator-panel .coordinator-send')?.disabled && !document.querySelector('.coordinator-send.is-working') && document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value === '');
  assert.notEqual(submissions.at(-1).id, submissions[0].id);
  assert.equal(submissions.at(-1).retry, undefined, 'human correction is a new message, not an unsafe replay');
  record('Coordinator feature gate, safe Markdown rendering and durable explicit retries');

  const beforeLostReply = submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('已持久化但响应丢失');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(() => {
    const panel = document.querySelector('#coordinator-panel');
    const retry = panel.querySelector('button[aria-label="重试原请求"]');
    return panel.querySelector(':scope > [role=status]').textContent === '' && retry.hidden &&
      !panel.querySelector('.coordinator-send.is-working') &&
      panel.querySelector('.coordinator-send')?.disabled && panel.querySelector('textarea[aria-label="发送给 Coordinator"]').value === '';
  });
  assert.equal(submissions.length, beforeLostReply + 1, 'durable receipt reconciliation never submits a second model turn');
  record('Coordinator reconciles a lost HTTP acknowledgement without manual retry or duplicate submission');

  const beforeOfflineRecovery=submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('短暂断线后成功');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await coordinator.getByText('已收到原请求。',{exact:true}).waitFor();
  assert.equal(submissions.length,beforeOfflineRecovery+2,'a request absent from the server is automatically recovered once');
  assert.equal(submissions.at(-1).id,submissions.at(-2).id,'transport recovery reuses the same durable request identity');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'','acknowledged recovery clears the preserved draft');
  assert.equal(await coordinator.locator('.coordinator-optimistic').count(),0,'the recovered request replaces its optimistic bubble');
  record('Coordinator retries an unaccepted request after reconnecting and clears the duplicate draft');

  await coordinator.getByLabel('发送给 Coordinator').fill('立即显示测试');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await coordinator.locator('.coordinator-message.coordinator-optimistic').filter({ hasText: '立即显示测试' }).waitFor({ state: 'visible' });
  await coordinator.locator('.coordinator-planning').waitFor({state:'visible'});
  await coordinator.locator('.coordinator-send.is-working canvas').waitFor({state:'visible'});
  assert.equal(typeof releaseDelayedSubmission, 'function', 'the delayed request is still waiting for the server receipt');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'','sending clears the composer before the server acknowledgement');
  assert.equal(await coordinator.locator('.coordinator-message.coordinator-optimistic').filter({ hasText: '立即显示测试' }).textContent(), '立即显示测试', 'the sent message appears before the network response');
  const sentTurnPlacement=await coordinator.locator('.coordinator-message.coordinator-optimistic').filter({hasText:'立即显示测试'}).evaluate(node=>{
    const pane=node.closest('.coordinator-messages'),box=node.getBoundingClientRect(),view=pane.getBoundingClientRect();
    return {bottomRatio:(box.bottom-view.top)/view.height,tailHeight:pane.querySelector('.coordinator-messages-tail').getBoundingClientRect().height,
      inkInComposer:!!document.querySelector('.coordinator-send.is-working .coordinator-working-blot')};
  });
  assert.ok(sentTurnPlacement.bottomRatio>.38&&sentTurnPlacement.bottomRatio<.7,`Ready-style send pins the new turn near the middle: ${JSON.stringify(sentTurnPlacement)}`);
  assert.ok(sentTurnPlacement.tailHeight>0,'the message list reserves scroll room below the new turn');
  assert.equal(sentTurnPlacement.inkInComposer,true,'M04 ink appears in the composer while M03 shimmers under the new message');
  await coordinator.getByLabel('发送给 Coordinator').fill('立即显示测试');
  releaseDelayedSubmission();
  await page.waitForFunction(() => !document.querySelector('.coordinator-message.coordinator-optimistic'));
  assert.equal(await coordinator.locator('.coordinator-message.user').filter({ hasText: '立即显示测试' }).count(), 1, 'server confirmation reconciles the optimistic message without duplication');
  const confirmedTurnRatio=await coordinator.locator('.coordinator-message.user').filter({hasText:'立即显示测试'}).evaluate(node=>{
    const pane=node.closest('.coordinator-messages'),box=node.getBoundingClientRect(),view=pane.getBoundingClientRect();
    return (box.bottom-view.top)/view.height;
  });
  assert.ok(confirmedTurnRatio>.38&&confirmedTurnRatio<.7,`server confirmation keeps the pinned turn stable: ${confirmedTurnRatio}`);
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'立即显示测试','a late acknowledgement preserves even an identical newly typed draft');
  await coordinator.getByLabel('发送给 Coordinator').fill('');
  const longReplyBlocks=Array.from({length:16},(_,index)=>`回复第 ${index+1} 段：这里是已经完成的一段内容。`);
  const longReply=longReplyBlocks.join('\n\n')+'\n\n';
  coordinatorState.status='running';
  coordinatorState.streamingText=longReplyBlocks[0]+'\n\n';
  await coordinator.locator('.coordinator-streaming .coordinator-rise').first().waitFor();
  const firstReplyTurnRatio=await coordinator.locator('.coordinator-message.user').filter({hasText:'立即显示测试'}).evaluate(node=>{
    const pane=node.closest('.coordinator-messages'),box=node.getBoundingClientRect(),view=pane.getBoundingClientRect();
    return (box.bottom-view.top)/view.height;
  });
  assert.ok(Math.abs(firstReplyTurnRatio-confirmedTurnRatio)<.08,
    `the first reply block does not snap the sent turn away: ${firstReplyTurnRatio}`);
  coordinatorState.streamingText=longReply;
  await page.waitForFunction(()=>document.querySelectorAll('.coordinator-streaming .coordinator-rise').length>=16);
  const streamedTail=await coordinator.locator('.coordinator-streaming .coordinator-rise').last().evaluate(node=>{
    const pane=node.closest('.coordinator-messages');
    return {bottom:node.getBoundingClientRect().bottom,viewportBottom:pane.getBoundingClientRect().bottom};
  });
  assert.ok(streamedTail.bottom<=streamedTail.viewportBottom-16,
    `long replies remain visible as they grow rather than leaving the viewport in the middle: ${JSON.stringify(streamedTail)}`);
  const tallBlock='很长的单段回复。'.repeat(190);
  const beforeTallScroll=await coordinator.locator('.coordinator-messages').evaluate(node=>node.scrollTop);
  coordinatorState.streamingText=longReply+tallBlock+'\n\n';
  await page.waitForFunction(()=>document.querySelectorAll('.coordinator-streaming .coordinator-rise').length>=17);
  const tallPlacement=await coordinator.locator('.coordinator-streaming .coordinator-rise').last().evaluate(node=>{
    const pane=node.closest('.coordinator-messages'),box=node.getBoundingClientRect(),view=pane.getBoundingClientRect();
    return {top:box.top,bottom:box.bottom,viewportBottom:view.bottom,scrollTop:pane.scrollTop};
  });
  assert.ok(tallPlacement.top<tallPlacement.viewportBottom-64&&tallPlacement.bottom>tallPlacement.viewportBottom,
    `a tall paragraph shows its beginning without jumping to its middle: ${JSON.stringify(tallPlacement)}`);
  assert.ok(tallPlacement.scrollTop-beforeTallScroll<220,'one oversized paragraph does not cause a large scroll jump');
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=0;});
  coordinatorState.streamingText=longReply+tallBlock+'\n\n用户上滚后追加的新段落。\n\n';
  await page.waitForFunction(()=>document.querySelectorAll('.coordinator-streaming .coordinator-rise').length>=18);
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>node.scrollTop),0,
    'reading older messages cancels automatic reply following');
  coordinatorState.streamingText='';coordinatorState.status='waiting-for-user';
  coordinatorState.messages.push({role:'assistant',text:longReply+tallBlock+'\n\n用户上滚后追加的新段落。\n\n'});
  await page.waitForFunction(()=>!document.querySelector('.coordinator-streaming'));
  record('Coordinator reply follows visible text without snapping or stealing manual scroll');
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=0;});
  await page.waitForFunction(()=>document.querySelector('.coordinator-messages').scrollTop===0);
  await page.waitForTimeout(50);
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  assert.equal(await coordinator.locator('.coordinator-messages').evaluate(node=>node.scrollTop),0,'manual scroll releases the turn pin instead of pulling old messages back to center');
  record('Coordinator sends with immediate optimistic message feedback');

  await coordinator.getByLabel('发送给 Coordinator').fill('Ready 一次性回复');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  const oneShotLive=coordinator.locator('.coordinator-message.assistant').filter({hasText:'完整段落一次返回。'}).last();
  await oneShotLive.waitFor();
  assert.equal(await oneShotLive.locator('.coordinator-rise.is-entering').count(),1,'a live one-shot response uses one Ready-style entering group');
  assert.equal(await oneShotLive.locator('.coordinator-rise-body p').count(),2,'the one-shot group keeps its final Markdown layout');
  await coordinator.getByLabel('发送给 Coordinator').fill('一次性长回复测试');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await coordinator.locator('.coordinator-message.coordinator-optimistic').filter({hasText:'一次性长回复测试'}).waitFor();
  await coordinator.locator('.coordinator-messages').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  assert.equal(typeof releaseLongSubmission,'function');
  releaseLongSubmission();
  const oneShotLong=coordinator.locator('.coordinator-message.assistant').filter({hasText:oneShotLongText.slice(0,60)}).last();
  await oneShotLong.waitFor();
  const oneShotLongPlacement=await oneShotLong.evaluate(node=>{
    const pane=node.closest('.coordinator-messages'),row=node.getBoundingClientRect(),view=pane.getBoundingClientRect();
    return {top:row.top,bottom:row.bottom,viewportBottom:view.bottom};
  });
  assert.ok(oneShotLongPlacement.top<oneShotLongPlacement.viewportBottom-64&&oneShotLongPlacement.bottom>oneShotLongPlacement.viewportBottom,
    `a one-shot long reply reveals its beginning rather than snapping to its middle: ${JSON.stringify(oneShotLongPlacement)}`);

  const failedAtlasRoute=/\/working-blot-atlas\.png$/;
  const failAtlas=route=>route.fulfill({status:404,body:'unavailable atlas'});
  await page.route(failedAtlasRoute,failAtlas);
  coordinatorState.status='running';coordinatorState.streamingText='';
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();
  await coordinator.locator('.coordinator-send.is-working-fallback').waitFor();
  await page.waitForFunction(()=>{
    const send=document.querySelector('.coordinator-send');
    return getComputedStyle(send.querySelector('.coordinator-ink-fallback')).opacity==='1'&&getComputedStyle(send.querySelector('svg')).opacity==='0';
  });
  assert.equal(await coordinator.locator('.coordinator-ink-fallback').evaluate(node=>getComputedStyle(node).animationPlayState),'running',
    'network-independent ink keeps the hue effect when atlas loading fails');
  await coordinator.locator('.coordinator-input-shell').screenshot({path:path.join(output,'coordinator-offline-ink.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await coordinator.locator('.coordinator-ink-fallback').evaluate(node=>getComputedStyle(node).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  coordinatorState.status='waiting-for-user';
  await page.waitForFunction(()=>!document.querySelector('.coordinator-send.is-working'));
  await page.waitForTimeout(1050);
  await page.unroute(failedAtlasRoute,failAtlas);
  coordinatorState.status='running';
  await coordinator.locator('.coordinator-send.is-working-ready').waitFor();
  coordinatorState.status='waiting-for-user';
  await page.waitForFunction(()=>!document.querySelector('.coordinator-send.is-working'));
  record('Coordinator ink survives stale and unavailable assets, then recovers the original animation');
  await coordinator.getByLabel('发送给 Coordinator').fill('明确拒绝后恢复草稿');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('COORDINATOR_BUSY'));
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'明确拒绝后恢复草稿','a definitive rejection restores the unsent original input');
  await page.reload();await synchronized();await page.locator('#btn-coordinator').click();

  const itemConversations=[];
  await page.route(/\/api\/coordinator\/conversations(?:\?|$)/,async route=>{
    const item=route.request().postDataJSON(), id=item.kind+'-'+item.itemId;
    itemConversations.push({...item,id});
    coordinatorState.conversations=[{id:'legacy',title:'历史总对话'},...itemConversations.map(item=>({...item,title:item.itemId}))];
    return route.fulfill({json:{id}});
  });

  for (const kind of ['todo', 'bug']) {
    await page.locator('#btn-coordinator').click();
    await page.locator(`[data-act="add-${kind}"]`).click();
    const previous = await syncVersion();
    const editor = kind === 'todo' ? page.locator('#detail [data-ed="todo-text"]').last() : page.locator('#detail [data-ed="bug-title"]').last();
    await editor.fill(`Discuss new ${kind} before dispatch`);
    await editor.press('Tab');
    await synchronizedAfter(previous);
    assert.equal(await coordinator.getAttribute('open'), '', 'creating work opens the conversation immediately');
    const saved = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
    const item = saved.body.snapshot.memory.map.root[kind === 'todo' ? 'todos' : 'bugs'].find(item => item.title === `Discuss new ${kind} before dispatch`);
    assert.ok(item, 'the requirement must be persisted in Main');
    assert.equal(item.dispatch, undefined, 'creating a requirement must not dispatch work or approve a brief');
    assert.deepEqual(item.sessions, []);
    await page.waitForFunction(id=>document.querySelector('#coordinator-panel')?.dataset.conversation===id,kind+'-'+item.id);
  }
  assert.notEqual(itemConversations[0].id,itemConversations[1].id);
  await page.locator('#btn-coordinator').click();
  assert.equal(await page.locator('#detail .todo-list li').count()>0,true);
  assert.equal(await page.locator('#detail .bug-list li').count()>0,true);
  assert.equal(await page.locator('#detail [data-task-review], #detail .task-review-actions').count(),0,
    'work item details no longer expose the redundant approve/reject shortcut buttons');
  await page.locator('#btn-coordinator').click();
  const openItem=async item=>{
    if(await coordinator.getAttribute('open')!==null) await page.locator('#btn-coordinator').click();
    await page.locator(`[data-coordinator-item="${item.itemId}"][data-coordinator-kind="${item.kind}"]`).click();
    await page.waitForFunction(id=>document.querySelector('#coordinator-panel')?.dataset.conversation===id,item.id);
  };
  await coordinator.locator('textarea').fill('Bug 独立草稿');
  await openItem(itemConversations[0]);
  assert.equal(await coordinator.locator('textarea').inputValue(),'');
  await coordinator.locator('textarea').fill('TODO 独立草稿');
  await page.waitForTimeout(100);
  await openItem(itemConversations[1]);
  assert.equal(await coordinator.locator('textarea').inputValue(),'Bug 独立草稿');
  record('Coordinator intake saves TODO and Bug without selecting or dispatching a Session');

  assert.equal(await coordinator.getByRole('button',{name:'新建 Coordinator Session',exact:true}).count(),1);
  assert.equal(await coordinator.getByLabel('Coordinator 事项对话').count(),0);
  assert.equal(await coordinator.getByText(/运行记录/).count(),0);
  record('Coordinator hides removed controls while per-item conversation entry remains usable');

  const acceptanceRequests = [];
  let rejectStaleReview=false,loseReviewResponse=false;
  await page.route(/\/api\/coordinator\/acceptance(?:\?|$)/, async route => {
    acceptanceRequests.push(route.request().postDataJSON());
    if(rejectStaleReview){rejectStaleReview=false;return route.fulfill({status:409,json:{error:{code:'CONFLICT',message:'验收版本已变化'}}});}
    coordinatorState = { ...coordinatorState, acceptances: [],
      ...(Array.isArray(coordinatorState.reviewCandidates) ? { reviewCandidates: [] } : {}) };
    if(loseReviewResponse){loseReviewResponse=false;return route.abort();}
    await route.fulfill({ json: { accepted: true } });
  });
  const acceptanceFixture={
    taskId: 'task-review-ui', sessionId: 'session-one', sourceSha: 'sha-review-ui',
    brief: { text: '这是一个超过六十个字符的验收说明，用于确认任务信息会自动按句子分段并以 Markdown 结构显示。' },
    result: { verdict: 'passed' }, ci: { ref: 'ci-review-ui', version: 'ci-version-review-ui' },
  };
  coordinatorState = { ...coordinatorState, status:'waiting-for-user', error:null, retryInput:null, canCorrect:false, acceptances: [acceptanceFixture] };
  await page.reload(); await synchronized(); await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button',{name:'验收不通过',exact:true}).waitFor();
  assert.equal(await coordinator.locator(':scope > [role=status]').isVisible(),false,'an acceptance card does not add a persistent review instruction');
  const submissionsBeforeReview=submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过');
  assert.equal(await coordinator.locator('.coordinator-send').isEnabled(),true,'an explicit review command can be sent while awaiting human acceptance');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  assert.match(await coordinator.locator(':scope > [role=status]').textContent(),/请写明原因/);
  assert.equal(acceptanceRequests.length,0,'rejection without a reason is not submitted');
  assert.equal(submissions.length,submissionsBeforeReview,'review directives do not become model requests');
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：'+'需核对'.repeat(668));
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  assert.match(await coordinator.locator(':scope > [role=status]').textContent(),/不能超过 2000 字/);
  assert.equal(acceptanceRequests.length,0,'oversized human review reasons are rejected before a POST');
  coordinatorState.acceptances=[acceptanceFixture,{...acceptanceFixture,taskId:'another-task',ci:{ref:'another-ci',version:'another-version'}}];
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：页面无法访问');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('多项待验收'));
  assert.equal(acceptanceRequests.length,0,'ambiguous reviews fail closed without guessing the task');
  coordinatorState.acceptances=[acceptanceFixture];
  await coordinator.getByLabel('发送给 Coordinator').fill('这项验收不通过，原因是页面无法访问');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value==='');
  assert.equal(acceptanceRequests.length,1);
  assert.equal(acceptanceRequests[0].decision,'rejected');
  assert.equal(acceptanceRequests[0].reason,'页面无法访问');
  assert.equal(acceptanceRequests[0].taskId,acceptanceFixture.taskId);
  assert.equal(acceptanceRequests[0].version,acceptanceFixture.ci.version);
  assert.equal(submissions.length,submissionsBeforeReview,'delegated review uses the authenticated human review route, not a model tool');
  coordinatorState.acceptances=[acceptanceFixture];
  await coordinator.getByLabel('发送给 Coordinator').fill('验收通过');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value==='');
  assert.equal(acceptanceRequests.length,2);
  assert.equal(acceptanceRequests[1].decision,'approved');
  assert.equal(acceptanceRequests[1].reason,'验收通过');
  assert.equal(submissions.length,submissionsBeforeReview);
  coordinatorState.acceptances=[acceptanceFixture];
  rejectStaleReview=true;
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：版本冲突');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('验收未提交'));
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'验收不通过：版本冲突','stale review preserves the explicit human decision');
  assert.equal(acceptanceRequests.length,3);
  loseReviewResponse=true;
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：连接中断');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('验收结果尚未确认'));
  assert.equal(acceptanceRequests.length,4,'an unknown review outcome is sent only once');
  assert.equal(await coordinator.getByLabel('发送给 Coordinator').inputValue(),'验收不通过：连接中断');
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：再次尝试');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  assert.match(await coordinator.locator(':scope > [role=status]').textContent(),/不会再次提交/);
  assert.equal(acceptanceRequests.length,4,'a repeated command after an unknown outcome cannot mint another review ID');
  record('Coordinator chat delegates only explicit human acceptance decisions to the existing review endpoint');
  coordinatorState.acceptances=[acceptanceFixture];
  await page.reload(); await synchronized(); await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button', { name: '验收不通过', exact: true }).click();
  const reviewForm = coordinator.locator('.coordinator-review-inline');
  await reviewForm.waitFor();
  await reviewForm.locator('textarea').fill('需要补充部署路径和回滚验证。');
  await reviewForm.getByRole('button', { name: '提交反馈', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.coordinator-review-inline'));
  assert.equal(acceptanceRequests.length, 5);
  assert.equal(acceptanceRequests[4].decision, 'rejected');
  assert.equal(acceptanceRequests[4].reason, '需要补充部署路径和回滚验证。');
  record('Coordinator acceptance rejection opens an inline feedback form');
  const submissionsBeforeQuestion=submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('为什么验收不通过还要我点？');
  const questionPost=page.waitForResponse(response=>response.url().includes('/api/coordinator?')&&response.request().method()==='POST');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await questionPost;
  assert.equal(acceptanceRequests.length,5,'a question mentioning acceptance never signs a review');
  assert.equal(submissions.length,submissionsBeforeQuestion+1,'ordinary chat still reaches the Coordinator model');

  coordinatorState = { ...coordinatorState, status:'waiting-for-user', error:null, retryInput:null, canCorrect:false,
    acceptances: [], reviewCandidates: [acceptanceFixture] };
  await page.reload(); await synchronized(); await page.locator('#btn-coordinator').click();
  await coordinator.getByRole('button', { name: '历史 Session' }).click();
  const mainRead=page.waitForResponse(response=>response.request().method()==='GET'&&
    new URL(response.url()).pathname.endsWith('/api/coordinator')&&new URL(response.url()).searchParams.get('conversation')==='main');
  await coordinator.locator('.coordinator-history-list button').first().click();
  await mainRead;
  await page.waitForFunction(() => document.querySelector('#coordinator-panel')?.dataset.conversation==='main');
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent==='');
  assert.equal(await coordinator.locator(':scope > [role=status]').isVisible(),false,'Main does not show a persistent acceptance instruction');
  assert.equal(await coordinator.getByRole('button', { name: '验收不通过', exact: true }).count(),0,
    'Main does not need the owner conversation acceptance card');
  const modelRequestsBeforeMainReview=submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('无法打开，验收不通过');
  await page.waitForFunction(() => !document.querySelector('#coordinator-panel .coordinator-send')?.disabled);
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="发送给 Coordinator"]')?.value==='');
  assert.equal(acceptanceRequests.length,6,'Main sends the unique cross-conversation human review');
  assert.equal(acceptanceRequests[5].taskId,acceptanceFixture.taskId);
  assert.equal(acceptanceRequests[5].reason,'无法打开');
  assert.equal(submissions.length,modelRequestsBeforeMainReview,'Main review bypasses the model');
  coordinatorState.reviewCandidates=[acceptanceFixture,{...acceptanceFixture,taskId:'another-task'}];
  await coordinator.getByLabel('发送给 Coordinator').fill('验收不通过：还有问题');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await page.waitForFunction(() => document.querySelector('#coordinator-panel > [role=status]')?.textContent.includes('多项待验收'));
  assert.equal(acceptanceRequests.length,6,'Main never guesses among multiple pending reviews');
  coordinatorState.reviewCandidates=[acceptanceFixture];
  const modelRequestsBeforeExample=submissions.length;
  await coordinator.getByLabel('发送给 Coordinator').fill('这是个例子，验收不通过');
  const examplePost=page.waitForResponse(response=>response.url().includes('/api/coordinator?')&&response.request().method()==='POST');
  await coordinator.getByLabel('发送给 Coordinator').press('Enter');
  await examplePost;
  assert.equal(acceptanceRequests.length,6,'an example is not a human rejection decision');
  assert.equal(submissions.length,modelRequestsBeforeExample+1,'an example remains ordinary chat');
  record('Coordinator Main chat routes only a unique explicit human acceptance decision without a card');

  const attachmentMap = structuredClone(sessionMap);
  attachmentMap.root.memories = [{ text: 'Attachment fixture', state: 'dirty', files: [] }];
  const currentMain = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  const attachmentSeed = await request(`${service.url}/v1/projects/context-guard/sessions/attachment-session`, {
    method: 'POST', headers: headers('project-memory-token'), body: JSON.stringify({ operationId: 'attachment-browser-seed',
      baseVersion: null, baseMainVersion: currentMain.body.snapshot.version, sourceCommit: featureSha, memory: { map: attachmentMap, records: {} } }),
  });
  assert.equal(attachmentSeed.response.status, 200, JSON.stringify(attachmentSeed.body));
  attachmentPage = await context.newPage();
  await useScreenshotFallbackFonts(attachmentPage);
  await attachmentPage.goto(service.url);
  await attachmentPage.waitForFunction(() => window.__CG_SERVER?.root === 'cloud:overview'
    && document.querySelector('.node[data-id="T0"]')?.textContent?.includes('项目地图'));
  assert.equal(await attachmentPage.locator('[data-act="ask-file"]').count(), 0, 'overview must not offer an unusable upload action');
  await attachmentPage.goto(`${service.url}/projects/context-guard?session=attachment-session`);
  await attachmentPage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced'
    && document.querySelector('.node[data-id="T0"]')?.textContent?.includes('Session map'));
  await attachmentPage.locator('.node[data-id="T0"]').click();
  const attachmentButton = attachmentPage.getByRole('button', { name: '附件 ＋', exact: true });
  await attachmentButton.waitFor();
  assert.equal(await attachmentPage.locator('#detail [data-fold="files"]').count(),1,'upload-enabled empty attachment entry is retained');
  const emptyChooser = attachmentPage.waitForEvent('filechooser');
  await attachmentButton.click();
  await (await emptyChooser).setFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
  await attachmentPage.getByRole('status').filter({ hasText: '附件不能为空' }).waitFor();
  await attachmentPage.locator('[data-fold="files"]').getByRole('button', { name: '取消', exact: true }).click();
  const chooser = attachmentPage.waitForEvent('filechooser');
  await attachmentButton.click();
  await (await chooser).setFiles({
    name: 'browser-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.4\nSynthetic browser fixture\n'), Buffer.alloc(9 * 1024 * 1024, 32), Buffer.from('\n%%EOF')]),
  });
  const retry = attachmentPage.locator('[data-quark-retry]');
  await retry.waitFor();
  await attachmentPage.setViewportSize({ width: 390, height: 844 });
  const retryStyle = await (await attachmentPage.waitForFunction(() => {
    const button = document.querySelector('[data-quark-retry]');
    if (!button?.isConnected) return false;
    const wrap = getComputedStyle(button).whiteSpace;
    return wrap ? { wrap, width: button.getBoundingClientRect().width } : false;
  })).jsonValue();
  assert.equal(retryStyle.wrap, 'nowrap');
  assert.ok(retryStyle.width >= 52);
  await attachmentPage.screenshot({ path: path.join(output, 'quark-retry-mobile.png'), fullPage: true });
  await retry.click();
  const quarkLink = attachmentPage.getByRole('link', { name: 'browser-fixture.pdf', exact: true });
  await quarkLink.waitFor();
  assert.equal(await quarkLink.getAttribute('href'), 'https://pan.quark.cn/s/browserfixture');
  assert.equal(attachmentUploads, 1, 'GUI retry must reuse the uploaded remote file');
  assert.match(await attachmentPage.locator('.file-chip').first().textContent(), /Ab12/);
  assert.equal(await attachmentPage.getByRole('button', { name: '附件 1 ＋', exact: true }).count(), 1);
  await attachmentPage.reload();
  await attachmentPage.locator('.node[data-id="T0"]').click();
  await quarkLink.waitFor();
  await attachmentPage.setViewportSize({ width: 1280, height: 900 });
  await attachmentPage.screenshot({ path: path.join(output, 'quark-desktop.png'), fullPage: true });
  await attachmentPage.setViewportSize({ width: 390, height: 844 });
  await attachmentPage.screenshot({ path: path.join(output, 'quark-mobile.png'), fullPage: true });
  const phoneSplit = attachmentPage.locator('#drawer-split');
  assert.equal(await attachmentPage.locator('html').evaluate(el => el.classList.contains('cg-phone')), true);
  await attachmentPage.locator('#workbench-tools > summary').click();
  const phoneToolsMenu = await attachmentPage.locator('.workbench-tools-menu').evaluate(menu => {
    const rect = menu.getBoundingClientRect();
    const point = { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + Math.min(rect.height / 2, 20) };
    return { open: menu.closest('details')?.open, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      hit: menu.contains(document.elementFromPoint(point.x, point.y)), viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.ok(phoneToolsMenu.open && phoneToolsMenu.hit && phoneToolsMenu.rect.left >= 0
    && phoneToolsMenu.rect.right <= phoneToolsMenu.viewport.width
    && phoneToolsMenu.rect.bottom <= phoneToolsMenu.viewport.height,
  `phone workbench tools menu must actually be visible: ${JSON.stringify(phoneToolsMenu)}`);
  for (const selector of ['#dir-toggle', '#btn-rel', '#btn-auth', '#btn-bugs', '#btn-todos']) {
    assert.equal(await attachmentPage.locator(selector).evaluate(control => {
      const rect = control.getBoundingClientRect();
      return control.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), true, `${selector} must be reachable in the phone tools menu`);
  }
  await attachmentPage.locator('#workbench-tools > summary').click();
  record('Phone workbench tools menu opens visibly inside the viewport');
  await phoneSplit.focus();
  for (let i = 0; i < 24; i++) await phoneSplit.press('Shift+ArrowUp');
  const expandedPhoneDrawer = await attachmentPage.evaluate(() => ({
    chromeBottom: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-top')),
    drawerTop: document.querySelector('.drawer').getBoundingClientRect().top,
    viewportHeight: document.querySelector('#viewport').getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(expandedPhoneDrawer.drawerTop - expandedPhoneDrawer.chromeBottom) <= 2, `phone inspector can reach the top bar: ${JSON.stringify(expandedPhoneDrawer)}`);
  assert.ok(expandedPhoneDrawer.viewportHeight <= 2, 'phone inspector need not leave the map visible');
  await attachmentPage.screenshot({ path: path.join(output, 'phone-inspector-expanded.png'), fullPage: true });
  await phoneSplit.dblclick();
  assert.ok(await attachmentPage.locator('#viewport').evaluate(el => el.getBoundingClientRect().height) > 100, 'double-click restores the map area');
  record('Phone inspector can expand over the map and restore its default split');
  await attachmentPage.close();
  record('Visible Cloud attachment picker uploads a PDF, persists a protected Quark link and survives refresh');

  await page.goto(`${service.url}/projects/context-guard`);
  await synchronized();
  await page.locator('.node[data-id="T0"]').click();
  const memoryPanel = page.locator('#detail [data-fold="memory-doc"]');
  assert.equal(await page.locator('#detail [data-fold="mem"], #detail [data-fold="inherited"], #detail [data-act="add-mem"], #detail [data-ed="mem"], #detail [data-ed="inh"]').count(), 0);
  const historyPanel = page.locator('#detail [data-fold="legacy-memory-preview"]');
  assert.equal(await historyPanel.getAttribute('open'), null, 'legacy cards stay outside the normal memory view');
  const previewVersion = await syncVersion();
  await historyPanel.locator('summary').click();
  assert.match(await historyPanel.textContent(), /proposalEvidence/);
  assert.match(await historyPanel.textContent(), /docs\/legacy-proof\.md/);
  assert.equal(await historyPanel.locator('[contenteditable],textarea,input,button,[data-drop-files]').count(), 0);
  assert.equal(await page.evaluate(() => window.__legacyExecuted), undefined, 'legacy text is not executable HTML');
  assert.equal(await syncVersion(), previewVersion, 'opening history is not a Map write');
  if (await memoryPanel.getAttribute('open') === null) await memoryPanel.locator('summary').click();
  const projectMemory = '# Main map · 项目记忆\n\n## 目标\n\n记住项目边界。';
  let memoryVersion = await syncVersion();
  await page.locator('#detail [data-memory-document]').fill(projectMemory);
  await page.locator('#detail [data-act="save-memory-document"]').click();
  await synchronizedAfter(memoryVersion);
  await page.locator('.node[data-id="N1"]').click();
  if (await memoryPanel.getAttribute('open') === null) await memoryPanel.locator('summary').click();
  const nodeMemory = '# Tour one · 节点记忆\n\n## 能力\n\n保留节点职责。';
  memoryVersion = await syncVersion();
  await page.locator('#detail [data-memory-document]').fill(nodeMemory);
  await page.locator('#detail [data-act="save-memory-document"]').click();
  await synchronizedAfter(memoryVersion);
  const savedMemory = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  assert.equal(savedMemory.response.status, 200);
  assert.equal(savedMemory.body.snapshot.memory.map.root.memoryDocument, projectMemory);
  assert.equal(savedMemory.body.snapshot.memory.map.root.children[0].memoryDocument, nodeMemory);
  assert.deepEqual(savedMemory.body.snapshot.memory.map.root.memories, mainMap.root.memories, 'saving a document preserves legacy project evidence');
  assert.deepEqual(savedMemory.body.snapshot.memory.map.root.children[0].memories, mainMap.root.children[0].memories, 'saving a document preserves legacy node metadata');
  assert.match(await historyPanel.textContent(), /Legacy node history/);
  assert.match(await historyPanel.textContent(), /Historical rationale/, 'ancestor evidence is available only through read-only history');
  await page.reload();
  await synchronized();
  await page.locator('.node[data-id="T0"]').click();
  if (await memoryPanel.getAttribute('open') === null) await memoryPanel.locator('summary').click();
  assert.equal(await page.locator('#detail [data-memory-document]').inputValue(), projectMemory);
  record('Human edits project and node memory documents through the versioned Main workbench');

  const partialPresentation = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(name => new URL(name).pathname.endsWith('/coordinator-markdown.mjs'));
    const { conversationFragments } = await import(url);
    const container = document.createElement('div');
    container.append(conversationFragments([{ role: 'assistant', text: 'Stopped partial <script>unsafe</script>', partial: true }]).body);
    return { text: container.textContent, scripts: container.querySelectorAll('script').length };
  });
  assert.match(partialPresentation.text, /部分回复（未完成）/);
  assert.equal(partialPresentation.scripts, 0);
  record('Stopped or superseded Coordinator output is visibly marked partial, not a final answer');

  assert.equal(await page.locator('#cg-session-complete').getAttribute('hidden'), '', 'Main does not offer Session completion');
  await git(repository, 'switch', '-c', 'completion-feature');
  await fs.writeFile(path.join(repository, 'completion.txt'), 'unmerged completion UI fixture');
  await git(repository, 'add', 'completion.txt');
  await git(repository, 'commit', '-m', 'completion feature');
  const completionSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', 'main');
  const completionMain = await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  const completionSeed = await request(`${service.url}/v1/projects/context-guard/sessions/completion-ui`, {
    method: 'POST', headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'completion-ui-seed', baseVersion: null,
      baseMainVersion: completionMain.body.snapshot.version, sourceCommit: completionSha, memory: { map: sessionMap, records: {} } }),
  });
  assert.equal(completionSeed.response.status, 200);
  await page.goto(`${service.url}/projects/context-guard?session=completion-ui`);
  await synchronized();
  assert.equal(await page.locator('#cg-session-complete').getAttribute('hidden'), null);
  await page.locator('.node[data-id="T0"]').click();
  const beforeCompletionEdit = await syncVersion();
  let releaseCompletionEdit, startedCompletionEdit;
  const completionEditGate = new Promise(resolve => { releaseCompletionEdit = resolve; });
  const completionEditStarted = new Promise(resolve => { startedCompletionEdit = resolve; });
  const completionEditRoute = `${service.url}/api/workbench/projects/context-guard/api/commit*`;
  const holdCompletionEdit = async route => {
    const response = await route.fetch();
    startedCompletionEdit();
    await completionEditGate;
    await route.fulfill({ response });
  };
  await page.route(completionEditRoute, holdCompletionEdit);
  await page.locator('#detail [data-ed="title"]').fill('Reviewed completion UI');
  let dialogs = 0;
  const acceptCompletion = async dialog => { dialogs++; await dialog.accept(); };
  page.on('dialog', acceptCompletion);
  await page.locator('#btn-settings').click();
  await page.locator('#cg-sync > summary').click();
  await completionEditStarted;
  await page.locator('#cg-session-complete').click();
  await page.waitForFunction(() => document.querySelector('#cg-session-complete')?.disabled === false);
  assert.equal(dialogs, 0, 'unsynchronized edits cannot be attested');
  releaseCompletionEdit();
  await synchronizedAfter(beforeCompletionEdit);
  await page.unroute(completionEditRoute, holdCompletionEdit);
  const completionRoute = `${service.url}/api/workbench/projects/context-guard/api/session-completion*`;
  let racedCompletionVersion;
  const completionRequests = [];
  const trackCompletion = request => {
    if (request.method() === 'POST' && request.url().includes('/api/session-completion')) completionRequests.push(request.postDataJSON());
  };
  page.on('request', trackCompletion);
  await page.route(completionRoute, async route => {
    const body = route.request().postDataJSON();
    const changed = await request(`${service.url}/api/workbench/projects/context-guard/api/commit?view=session%3Acompletion-ui`, {
      method: 'POST', headers: headers('browser-token'), body: JSON.stringify({ operationId: 'completion-ui-race',
        baseVersion: body.sessionVersion, operations: [{ type: 'update', id: 'T0', fields: { purpose: 'Changed after review' } }] }),
    });
    assert.equal(changed.response.status, 200);
    racedCompletionVersion = changed.body.version;
    assert.ok(racedCompletionVersion && racedCompletionVersion !== body.sessionVersion);
    await route.continue();
  });
  const staleCompletion = page.waitForResponse(response => response.url().includes('/api/session-completion'));
  await page.locator('#cg-session-complete').click();
  assert.equal((await staleCompletion).status(), 409, 'stale reviewed version is rejected');
  await page.unroute(completionRoute);
  let completionState = await request(`${service.url}/v1/projects/context-guard/sessions/completion-ui`, { headers: headers('project-memory-token') });
  assert.equal(completionState.body.snapshot.completion, undefined);
  assert.equal((await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') })).body.snapshot.version,
    completionMain.body.snapshot.version, 'stale completion does not publish into Main');
  // Receiving the 409 is earlier than the click handler's finally and the SSE
  // refresh. A previously synced indicator alone cannot attest the new version.
  await page.waitForFunction(version => document.querySelector('#cg-sync')?.dataset.status === 'synced'
    && document.querySelector('#cg-sync-version')?.dataset.version === version
    && document.querySelector('#cg-session-complete')?.disabled === false, racedCompletionVersion);
  const acceptedCompletion = page.waitForResponse(response => response.url().includes('/api/session-completion'));
  await page.locator('#cg-session-complete').click();
  assert.equal((await acceptedCompletion).status(), 200);
  completionState = await request(`${service.url}/v1/projects/context-guard/sessions/completion-ui`, { headers: headers('project-memory-token') });
  assert.equal(completionState.body.snapshot.completion.sessionVersion, completionState.body.snapshot.version);
  assert.equal(completionState.body.snapshot.completion.generation, 1);
  assert.equal(completionState.body.snapshot.completion.sourceCommit, completionSha);
  assert.equal(completionState.body.snapshot.completion.actor.kind, 'human');
  await fs.writeFile(path.join(output, 'completion-requests.json'), `${JSON.stringify(completionRequests, null, 2)}\n`);
  assert.equal(completionRequests.length, 2, `each reviewed click submits once: ${JSON.stringify(completionRequests)}`);
  assert.notEqual(completionRequests[0].operationId, completionRequests[1].operationId);
  assert.equal(completionRequests[1].sessionVersion, racedCompletionVersion);
  assert.equal((await request(`${service.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') })).body.snapshot.version,
    completionMain.body.snapshot.version, 'reviewed but unmerged work remains a Session');
  page.off('dialog', acceptCompletion);
  page.off('request', trackCompletion);
  record('Session completion requires synchronized human review and exact current version; stale review preserves Main');

  await page.screenshot({ path: path.join(output, 'cloud-session-edit.png'), fullPage: true });
  }
  await fs.mkdir(output, { recursive: true });
  browser ||= await chromium.launch({ headless: true });
  await coordinatorControlAcceptance();
  await fs.writeFile(path.join(output, 'result.json'), `${JSON.stringify({ passed: true, scope: controlsOnly ? 'coordinator-controls-and-focus' : 'all', checks }, null, 2)}\n`);
  passed = true;
} finally {
  if (attachmentPage && !attachmentPage.isClosed() && !passed) {
    await attachmentPage.screenshot({ path: path.join(output, 'failure-attachment.png'), fullPage: true }).catch(() => {});
    const diagnosis = await attachmentPage.evaluate(() => ({
      url: location.pathname + location.search,
      syncStatus: document.querySelector('#cg-sync')?.dataset.status,
      detailHeading: document.querySelector('#detail h2')?.textContent,
      fileNames: [...document.querySelectorAll('.file-name')].map(node => node.textContent),
      fileStatuses: [...document.querySelectorAll('.file-status')].map(node => node.textContent),
      retryButtons: [...document.querySelectorAll('[data-quark-retry]')].map(node => ({ disabled: node.disabled, visible: !!node.getClientRects().length })),
      coordinatorVisible: !!document.querySelector('#coordinator-panel')?.getClientRects().length,
    })).catch(() => null);
    if (diagnosis) {
      const snapshot = await request(`${service.url}/api/workbench/projects/context-guard/api/state?view=session%3Aattachment-session`,
        { headers: headers('browser-token') }).catch(() => null);
      const jobs = [];
      for (const name of await fs.readdir(path.join(dataDir, 'attachments')).catch(() => [])) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const job = JSON.parse(await fs.readFile(path.join(dataDir, 'attachments', name), 'utf8'));
        jobs.push({ id: job.id, status: job.status, uncertain: job.uncertain, lastFailure: job.lastFailure });
      }
      await fs.writeFile(path.join(output, 'failure.txt'), JSON.stringify({ ui: diagnosis, jobs,
        persisted: snapshot ? { httpStatus: snapshot.response.status, version: snapshot.body.version,
          files: snapshot.body.doc?.root?.files } : null }, null, 2));
    }
  }
  if (page && !passed) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await browser?.close().catch(() => {});
  await service?.close().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(`Cloud browser artifacts: ${output}`);
