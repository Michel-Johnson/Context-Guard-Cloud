import { skillImport, skillFile } from './helpers/skill.mjs';
import '../.github/scripts/test-environment.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createWorkbenchPasswordHash, startCloudServer } from '../scripts/cloud/server.mjs';
import { completeSessionMemory, memoryPublicationStatus } from '../scripts/cloud/memory.mjs';
const { startServer } = await skillImport('scripts/workbench/server.mjs');
const { resolveProject } = await skillImport('scripts/workbench/project.mjs');
const { sessionMemoryDir } = await skillImport('scripts/workbench/memory.mjs');
import { atomicWrite, encode, pause } from '../scripts/shared/io.mjs';

const output = path.resolve(process.argv[2] || `output/playwright/browser-ci/session-sync-${Date.now()}-${randomUUID()}`);
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'context-guard-session-sync-browser-'));
const root = path.join(sandbox, 'project');
const ctx = path.join(root, '.codex/context');
const sessionId = 'browser-session-sync';
const memoryConfig = {
  dataDir: path.join(sandbox, 'memory'),
  adminToken: 'memory-admin',
  projects: { 'context-guard': { token: 'project-memory-token', root, ref: 'refs/heads/main' } },
};
const document = {
  v: 1, project: 'Context Guard', bootstrap: 'ready', flows: [],
  root: {
    id: 'T0', title: 'Session Map', purpose: '双向同步测试', kind: 'module', state: 'dirty', proposal: 'accepted',
    memories: [], ideas: [], todos: [{ id: 'TD1', title: '浏览器挂载任务', desc: '从 Cloud 触发本地 Codex', status: 'pending', sessions: [] }],
    bugs: [{ id: 'B1', title: '已修复的同步问题', status: 'fixed', sessions: [sessionId] }], dormant: [], files: [], owns: [], children: [],
  },
};
const headers = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
};
let cloud, local, browser, localPage, cloudPage, passed = false;

try {
  await fs.mkdir(ctx, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'sync@example.test'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Sync Test'], { cwd: root, windowsHide: true });
  await fs.writeFile(path.join(root, 'README.md'), '# sync fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: root, windowsHide: true });
  const fixtureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', fixtureSha], { cwd: root, windowsHide: true });
  execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: root, windowsHide: true });
  await fs.writeFile(path.join(ctx, 'map.json'), encode(document));
  await fs.writeFile(path.join(ctx, 'sessions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event: 'session-start', platform: 'codex', session_id: sessionId, thread_name: 'browser-sync' })}\n`);

  cloud = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(sandbox, 'cloud'), adminToken: 'cloud-admin', browserToken: 'cloud-admin',
    browserPasswordHash: await createWorkbenchPasswordHash('test-only'), memoryConfig,
    protocolConfig: { repositories: [{ slug: 'example/repo', repositoryId: '123', projectId: 'context-guard' }] } });
  const project = await resolveProject(root);
  await atomicWrite(path.join(project.sharedDir, 'memory-client.json'), encode({ url: cloud.url, projectId: 'context-guard', token: 'project-memory-token' }));
  // The baseline publisher is a real registered Session, not an unbound ID.
  // Keep the current-generation workflow gate enabled during fixture setup.
  const baselineLogin = await fetch(`${cloud.url}/api/v2/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, id: 'baseline-device-login', type: 'auth.open',
      payload: { repository: 'https://github.com/example/repo', clientId: 'baseline-device', password: 'test-only' } }),
  });
  assert.equal(baselineLogin.status, 200);
  const baselineCredential = baselineLogin.headers.get('x-context-guard-credential');
  assert.ok(baselineCredential);
  await request(`${cloud.url}/api/v2/messages`, { method: 'POST', headers: headers(baselineCredential),
    body: JSON.stringify({ v: 2, id: 'baseline-bind', type: 'session.bind',
      payload: { sessionId: 'browser-baseline', worktreeId: 'baseline-tree', agentId: 'baseline-agent', expectedBindingVersion: '' } }),
  });
  const baseline = await request(`${cloud.url}/v1/projects/context-guard/sessions/browser-baseline`, {
    method: 'POST', headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-sync-baseline', baseVersion: null, baseMainVersion: null, sourceCommit: fixtureSha, memory: { map: document, records: {} } }),
  });
  await completeSessionMemory(memoryConfig, 'context-guard', { operationId: 'review-sync-baseline', sessionId: 'browser-baseline', generation: 1, sessionVersion: baseline.snapshot.version, sourceCommit: fixtureSha }, { kind: 'human' });
  const published = await request(`${cloud.url}/v1/projects/context-guard/publish`, {
    method: 'POST', headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-sync-main', baseVersion: null, sessionId: 'browser-baseline', sessionVersion: baseline.snapshot.version, expectedMainSha: fixtureSha }),
  });
  // Keep this fixture on genuine unmerged work; neither completion nor Git
  // merge is implied by exercising live synchronization.
  execFileSync('git', ['switch', '-c', 'fixture-session'], { cwd: root, stdio: 'ignore', windowsHide: true });
  await fs.writeFile(path.join(root, 'README.md'), '# unmerged sync fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'unmerged Session fixture'], { cwd: root, stdio: 'ignore', windowsHide: true });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  assert.notEqual(sourceCommit, fixtureSha);
  await request(`${cloud.url}/v1/projects/context-guard/sessions/${sessionId}`, {
    method: 'POST', headers: headers('project-memory-token'),
    body: JSON.stringify({ operationId: 'browser-sync-seed', baseVersion: null, baseMainVersion: published.snapshot.version, sourceCommit, memory: { map: document, records: {} } }),
  });
  const publication = await memoryPublicationStatus(memoryConfig, 'context-guard', sessionId);
  assert.equal(publication.status, 'waiting');
  assert.equal(publication.mainSha, fixtureSha);
  assert.equal(publication.sourceCommit, sourceCommit);

  const delivered = [];
  local = await startServer({ root, port: 0, messageQueue: async input => delivered.push(input), repositoryLookup: async () => ({ repositoryId: '123', slug: 'example/repo' }) });
  await request(new URL('/api/v2/messages', local.state.url), {
    method: 'POST', headers: headers(local.humanToken),
    body: JSON.stringify({ v: 2, id: 'browser-device-login', type: 'auth.open', payload: { repository: 'auto', clientId: 'local-backend', password: 'test-only' } }),
  });
  const registration = await request(new URL('/api/session', local.state.url), {
    method: 'POST', headers: headers(local.state.adminToken),
    body: JSON.stringify({ sessionId, worktreeRoot: root }),
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // This suite verifies synchronization, not third-party font availability.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  localPage = await context.newPage(); cloudPage = await context.newPage();
  for (const page of [localPage, cloudPage]) page.setDefaultTimeout(12000);
  await localPage.goto(`${local.state.url}?session=${sessionId}`);
  await localPage.waitForFunction(id => document.querySelector('#cg-sync-session')?.value === id, sessionId);
  const syncedAppearance = await localPage.waitForFunction(() => {
    const indicator = document.querySelector('#cloud-sync-status.synced');
    if (!indicator) return false;
    // Read class and visibility in the same browser task: the next heartbeat
    // may legitimately show its syncing spinner between two protocol calls.
    return { display: getComputedStyle(indicator).display, rectangles: indicator.getClientRects().length };
  });
  assert.deepEqual(await syncedAppearance.jsonValue(), { display: 'none', rectangles: 0 },
    'synced Cloud status does not render a checkmark button');
  await cloudPage.goto(`${cloud.url}/auth?token=cloud-admin&next=${encodeURIComponent('/projects/context-guard')}`);
  await cloudPage.waitForFunction(() => document.querySelector('#cg-sync')?.dataset.status === 'synced');
  await cloudPage.locator('.node[data-id="T0"]').click();
  assert.equal(await cloudPage.locator('button[data-todo-assign="TD1"]').count(), 0, 'legacy TODO Session assignment control is removed');
  assert.equal(await cloudPage.locator('button[data-bug-assign="B1"]').count(), 0, 'legacy Bug Session assignment control is removed');
  await cloudPage.locator('#session-chip').click();
  await cloudPage.locator(`#session-menu [data-session="${sessionId}"]`).click();
  await cloudPage.waitForFunction(id => new URL(location.href).searchParams.get('session') === id, sessionId);
  await localPage.locator('.node[data-id="T0"]').click();
  await localPage.locator('#detail [data-ed="title"]').fill('本地写入 Cloud');
  await localPage.evaluate(() => {
    window.__cloudSyncCycle = { started: false, done: false };
    const indicator = document.querySelector('#cloud-sync-status');
    const observer = new MutationObserver(() => {
      if (!indicator.classList.contains('synced')) window.__cloudSyncCycle.started = true;
      if (window.__cloudSyncCycle.started && indicator.classList.contains('synced')) {
        window.__cloudSyncCycle.done = true;
        observer.disconnect();
      }
    });
    observer.observe(indicator, { attributes: true, attributeFilter: ['class'] });
  });
  await localPage.locator('#detail [data-ed="title"]').blur();
  await localPage.waitForFunction(() => window.__cloudSyncCycle?.done, undefined, { timeout: 25000 });
  await cloudPage.waitForFunction(() => document.querySelector('.node[data-id="T0"]')?.textContent?.includes('本地写入 Cloud'), undefined, { timeout: 25000 });

  const cloudPurpose = 'Cloud 编辑后本地实时可见';
  assert.equal(new URL(cloudPage.url()).searchParams.get('session'), sessionId, 'Cloud edit stays in the selected Session');
  await cloudPage.locator('.node[data-id="T0"]').click();
  assert.equal((await cloudPage.locator('#detail [data-ed="purpose"]').textContent()).trim(), '双向同步测试');
  await cloudPage.locator('#detail [data-ed="purpose"]').fill(cloudPurpose);
  await cloudPage.locator('#detail [data-ed="purpose"]').blur();
  // Prove live Cloud-to-local delivery before either page is refreshed.
  await localPage.waitForFunction(value => document.querySelector('#detail [data-ed="purpose"]')?.textContent?.trim() === value, cloudPurpose, { timeout: 25000 });
  await localPage.waitForSelector('#cloud-sync-status.synced', { state: 'attached' });
  const liveDisk = JSON.parse(await fs.readFile(path.join(sessionMemoryDir(project, sessionId), 'map.json'), 'utf8'));
  assert.equal(liveDisk.root.title, '本地写入 Cloud');
  assert.equal(liveDisk.root.purpose, cloudPurpose, 'Cloud edit is committed to the local Session file before refresh');

  await Promise.all([localPage.reload(), cloudPage.reload()]);
  await localPage.waitForFunction(id => document.querySelector('#cg-sync-session')?.value === id, sessionId);
  for (const page of [localPage, cloudPage]) {
    assert.match(await page.locator('.node[data-id="T0"]').textContent(), /本地写入 Cloud/);
    await page.locator('.node[data-id="T0"]').click();
    assert.equal((await page.locator('#detail [data-ed="purpose"]').textContent()).trim(), cloudPurpose);
  }
  const disk = JSON.parse(await fs.readFile(path.join(sessionMemoryDir(project, sessionId), 'map.json'), 'utf8'));
  assert.equal(disk.root.title, '本地写入 Cloud');
  assert.equal(disk.root.purpose, cloudPurpose);
  const cloudSession = await request(`${cloud.url}/v1/projects/context-guard/sessions/${sessionId}`, { headers: headers('project-memory-token') });
  assert.equal(cloudSession.snapshot.memory.map.root.title, '本地写入 Cloud');
  assert.equal(cloudSession.snapshot.memory.map.root.purpose, cloudPurpose);
  const main = await request(`${cloud.url}/v1/projects/context-guard/main`, { headers: headers('project-memory-token') });
  assert.equal(main.snapshot.version, published.snapshot.version, 'Session edits must not publish a new Main version');
  assert.deepEqual(main.snapshot.memory.map, published.snapshot.memory.map, 'bidirectional Session edits leave Main unchanged');
  const finalPublication = await memoryPublicationStatus(memoryConfig, 'context-guard', sessionId);
  assert.equal(finalPublication.status, 'waiting', 'the unmerged Session remains open after bidirectional edits');
  assert.equal(finalPublication.mainSha, fixtureSha);
  assert.equal(finalPublication.sourceCommit, sourceCommit);
  for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) {
    assert.equal(execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), fixtureSha);
  }
  const changes = await request(`${cloud.url}/v1/projects/context-guard/sessions/${sessionId}/changes?after=0`, { headers: headers('project-memory-token') });
  assert.ok(changes.events.length >= 3);
  for (const event of changes.events) assert.equal(event.at, new Date(event.at).toISOString());

  await fs.mkdir(output, { recursive: true });
  await localPage.screenshot({ path: path.join(output, 'local.png'), fullPage: true });
  await cloudPage.screenshot({ path: path.join(output, 'cloud.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'result.json'), encode({ passed: true, checks: ['no-manual-session-assignment-control', 'local-to-cloud', 'cloud-to-local', 'local-disk-persistence', 'refresh-persistence', 'main-isolation', 'server-timestamps'] }));
  passed = true;
} finally {
  if (!passed) {
    await fs.mkdir(output, { recursive: true }).catch(() => {});
    for (const [name, page] of [['local', localPage], ['cloud', cloudPage]]) {
      const diagnosis = await page?.evaluate(() => ({
        path: location.pathname + location.search,
        selectedSession: document.querySelector('#cg-sync-session')?.value,
        sessions: [...(document.querySelector('#cg-sync-session')?.options || [])].map(option => ({ id: option.value, disabled: option.disabled })),
        syncStatus: document.querySelector('#cg-sync')?.dataset.status,
        syncMessage: document.querySelector('#cg-sync-status')?.textContent,
        cloudStatus: document.querySelector('#cloud-sync-status')?.className,
        cloudMessage: document.querySelector('#cloud-sync-status')?.title,
      })).catch(() => null);
      if (diagnosis) await fs.writeFile(path.join(output, `${name}-diagnosis.json`), encode(diagnosis)).catch(() => {});
    }
    await localPage?.screenshot({ path: path.join(output, 'local-failure.png'), fullPage: true }).catch(() => {});
    await cloudPage?.screenshot({ path: path.join(output, 'cloud-failure.png'), fullPage: true }).catch(() => {});
  }
  await browser?.close().catch(() => {});
  await local?.close().catch(() => {});
  await cloud?.close().catch(() => {});
  // Windows can briefly retain directory handles after browser/server shutdown.
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`Session sync browser artifacts: ${output}`);
