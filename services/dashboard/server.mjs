import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaceService } from './workspaces.mjs';
import { validateSourceLock } from './bootstrap.mjs';

const generatedRoot = fileURLToPath(new URL('../../temp/dashboard-shared/', import.meta.url));

// A separate checkout is an explicit test/development input, never inferred from HOME.
export async function loadSharedDashboard({ sharedCheckout } = {}) {
  let root;
  if (sharedCheckout) {
    root = resolve(sharedCheckout);
  } else {
    const lock = validateSourceLock(JSON.parse(await readFile(new URL('./source-lock.json', import.meta.url), 'utf8')));
    const receipt = JSON.parse(await readFile(resolve(generatedRoot, '.source-lock.json'), 'utf8'));
    if (JSON.stringify(receipt) !== JSON.stringify(lock)) throw new Error('Dashboard shared source receipt differs from source-lock.json; run bootstrap');
    root = generatedRoot;
  }
  const moduleRoot = resolve(root, 'packages/dashboard');
  const [server, config] = await Promise.all([
    import(pathToFileURL(resolve(moduleRoot, 'src/server.mjs')).href),
    import(pathToFileURL(resolve(moduleRoot, 'src/config.mjs')).href),
  ]);
  return { ...server, ...config, moduleRoot };
}

export async function createDashboardServer(config, store, options = {}) {
  const shared = await loadSharedDashboard(options);
  return shared.createDashboardServer({
    ...config,
    workspacesEnabled: config.workspacesEnabled ?? true,
    createWorkspaceService: options.workspaceServiceOptions
      ? workspaceConfig => createWorkspaceService(workspaceConfig, options.workspaceServiceOptions)
      : createWorkspaceService,
  }, store);
}
