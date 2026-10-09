import { fileURLToPath } from 'node:url';
import { run } from './client-protocol.mjs';
import diagnostics from './test-worker-diagnostics.cjs';

const files = diagnostics.discoverTestFiles();
if (!files.length) throw new Error('No Cloud tests discovered');
const args = ['--test', '--test-concurrency=2', ...files];
let env;
if (process.env.CONTEXT_GUARD_CI_TEST_DIAGNOSTICS === '1') {
  try {
    const config = diagnostics.prepareDiagnostics(process.cwd(), process.env.RUNNER_TEMP, files);
    env = { ...process.env, CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG: config };
    args.unshift('--require', fileURLToPath(new URL('./test-worker-diagnostics.cjs', import.meta.url)));
  } catch { console.error('[CI_TEST_DIAGNOSTICS_INCOMPLETE]'); }
}
await run(process.execPath, args, { env, inheritOutput: true, timeout: 15 * 60 * 1000 });
