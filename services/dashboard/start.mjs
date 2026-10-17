import { createDashboardServer, loadSharedDashboard } from './server.mjs';

// Only the executable reads environment variables. Library imports create no service.
const shared = await loadSharedDashboard();
const config = shared.loadConfig(process.env);
config.workspacesEnabled = process.env.DASHBOARD_WORKSPACES !== '0';
const instance = await createDashboardServer(config);
await new Promise((resolve, reject) => {
  instance.server.once('error', reject);
  instance.server.listen(config.port, config.host, resolve);
});
console.log(`Dashboard listening on port ${instance.server.address().port}`);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  instance.server.close(() => instance.store.close());
  instance.server.closeAllConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
