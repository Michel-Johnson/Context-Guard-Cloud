import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// 只在生产依赖安装后的隔离子进程运行，不继承真实 Cloud 配置。
for (const name of Object.keys(process.env)) if (name.startsWith('CONTEXT_GUARD_')) delete process.env[name];
const root = path.resolve(process.argv[2] || '.');
await assert.rejects(fs.access(path.join(root, 'node_modules/@michelj/context-guard/package.json')), { code: 'ENOENT' }, '生产 Cloud 不安装完整 Skill 客户端');
await fs.mkdir(path.join(root, 'temp'), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, 'temp/production-smoke-'));
let running;
try {
  const { startCloudServer } = await import(pathToFileURL(path.join(root, 'scripts/cloud/server.mjs')));
  const token = randomUUID();
  running = await startCloudServer({ host: '127.0.0.1', port: 0, dataDir: directory,
    adminToken: randomUUID(), browserToken: token, privateAccess: true, secureCookies: false });
  const get = (route, headers = {}) => fetch(new URL(route, running.url), { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await get('/api/projects')).status, 401);
  const cookie = { Cookie: `cg_workbench=${token}` };
  const page = await get('/', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]*\/prototype\/(?:workbench-(?:app|data)\.js|workbench\.css))"/g)].map(match => match[1]);
  assert.equal(new Set(assets).size, 3, '页面引用完整的固定 UI 资源');
  for (const route of assets) {
    const response = await get(route, cookie);
    assert.equal(response.status, 200);
    const file = new URL(route, running.url).pathname.split('/prototype/')[1];
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(path.join(root, 'prototype', file)));
  }
  const state = await get('/api/workbench/overview/api/state', cookie);
  assert.equal(state.status, 200);
  const snapshot = await state.json();
  assert.ok(snapshot.doc?.root && snapshot.version, '生产依赖支持实际版本化工作台读取');
  console.log('Cloud 生产依赖冒烟通过：无完整客户端、启动、UI 资源字节、版本化地图与未授权拒绝。');
} finally {
  if (running) await running.close();
  await fs.rm(directory, { recursive: true, force: true });
}
