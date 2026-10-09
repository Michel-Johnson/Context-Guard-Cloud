import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import diagnostics from './test-worker-diagnostics.cjs';
import { run } from './client-protocol.mjs';

const preload = fileURLToPath(new URL('./test-worker-diagnostics.cjs', import.meta.url));
const sentinel = 'PRIVATE_SYNTHETIC_BODY_AND_CREDENTIAL_NOT_FOR_DIAGNOSTICS';

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-diagnostic-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runnerTemp = path.join(root, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(path.join(root, 'tests'));
  const file = 'tests/diagnostic-fixture.test.mjs';
  fs.writeFileSync(path.join(root, file), source);
  fs.writeFileSync(path.join(root, 'tests/test-manifest.json'), JSON.stringify({
    automaticNodeTests: { roots: ['tests'], excluded: [] },
  }));
  const config = diagnostics.prepareDiagnostics(root, runnerTemp, [file]);
  const env = { ...process.env, RUNNER_TEMP: runnerTemp,
    CONTEXT_GUARD_CI_TEST_DIAGNOSTICS: '1', CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG: config,
    PRIVATE_DIAGNOSTIC_TEST_SENTINEL: sentinel };
  delete env.NODE_TEST_CONTEXT;
  const directory = path.dirname(config);
  const args = ['--require', preload, '--test', '--test-concurrency=2', file];
  const rows = () => fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  return { root, runnerTemp, directory, env, args, rows, file };
}

function checkRows(rows, source) {
  const keys = new Set(['pid', 'source', 'event', 'time', 'elapsedMs', 'resources', 'code', 'reason']);
  for (const row of rows) {
    assert.ok(Object.keys(row).every(key => keys.has(key)));
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.ok(row.source === null || row.source === source);
    assert.ok(['start', 'snapshot', 'beforeExit', 'exit', 'incomplete'].includes(row.event));
    if (row.resources) assert.ok(Object.values(row.resources).every(count => Number.isInteger(count) && count > 0 && count <= 100000));
  }
}

test('CI diagnostics preserve discovery, minimum-runtime-only activation and original gates', () => {
  const manifest = JSON.parse(fs.readFileSync('tests/test-manifest.json', 'utf8'));
  const excluded = new Set(manifest.automaticNodeTests.excluded);
  const original = manifest.automaticNodeTests.roots.flatMap(directory => fs.readdirSync(directory)
    .filter(name => name.endsWith('.test.mjs')).map(name => `${directory}/${name}`))
    .filter(file => !excluded.has(file)).sort();
  assert.deepEqual(diagnostics.discoverTestFiles(), original);
  const runner = fs.readFileSync('.github/scripts/run-node-tests.mjs', 'utf8');
  assert.match(runner, /\['--test', '--test-concurrency=2', \.\.\.files\]/);
  assert.match(runner, /timeout: 15 \* 60 \* 1000/);
  assert.doesNotMatch(runner, /NODE_OPTIONS|allowFailure|test-name-pattern/);
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const minimum = workflow.split('  minimum-runtime:')[1].split('  slack:')[0];
  assert.equal(workflow.match(/CONTEXT_GUARD_CI_TEST_DIAGNOSTICS:/g)?.length, 1);
  assert.match(minimum, /CONTEXT_GUARD_CI_TEST_DIAGNOSTICS: '1'/);
  assert.match(minimum, /failure\(\) && !cancelled\(\)/);
  assert.match(minimum, /runner\.temp.*cloud-node18-diagnostics\/\*\.jsonl/);
  assert.match(minimum, /retention-days: 1/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /needs: \[security, test, minimum-runtime, slack, browser, package\]/);
  assert.doesNotMatch(workflow, /continue-on-error|pull_request_target/);
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
});

test('CI diagnostics disabled by default neither create output nor alter a child exit code', async t => {
  const f = fixture(t, "import test from 'node:test'; test('synthetic pass', () => {});\n");
  const env = { ...f.env, CONTEXT_GUARD_CI_TEST_DIAGNOSTICS: '0' };
  const result = await run(process.execPath, ['--require', preload, '-e', 'process.exitCode=7'],
    { cwd: f.root, env, allowFailure: true, timeout: 5000 });
  assert.equal(result.code, 7);
  assert.equal(result.stderr, '');
  assert.deepEqual(f.rows(), []);
});

test('CI diagnostics identify native Node workers and an unref observer does not delay normal exit', async t => {
  const f = fixture(t, "import test from 'node:test'; test('synthetic pass', () => {});\n");
  const result = await run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 5000 });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /CI_TEST_DIAGNOSTICS_INCOMPLETE/);
  const rows = f.rows();
  checkRows(rows, f.file);
  for (const source of [null, f.file]) {
    const own = rows.filter(row => row.source === source);
    assert.equal(own.filter(row => row.event === 'start').length, 1);
    assert.equal(own.filter(row => row.event === 'exit').length, 1);
    assert.equal(own.find(row => row.event === 'exit').code, 0);
    assert.ok(own.some(row => row.event === 'beforeExit'));
    assert.ok(own.every(row => row.elapsedMs < 5000));
  }
});

test('CI diagnostic artifacts omit raw failures, environment values and absolute paths', async t => {
  const f = fixture(t, `import test from 'node:test'; test('synthetic failure', () => { throw new Error('${sentinel}'); });\n`);
  const result = await run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 5000, allowFailure: true });
  assert.equal(result.code, 1);
  const rows = f.rows();
  checkRows(rows, f.file);
  const artifact = JSON.stringify(rows);
  for (const forbidden of [sentinel, f.root, f.runnerTemp, 'stack', 'stdout', 'stderr', 'PRIVATE_DIAGNOSTIC_TEST_SENTINEL']) {
    assert.equal(artifact.includes(forbidden), false);
  }
  assert.equal(rows.find(row => row.source === f.file && row.event === 'exit').code, 1);
  assert.deepEqual({ ...diagnostics.resourceCounts(['Timeout', 'Timeout', sentinel, { secret: sentinel }]) }, { Timeout: 2, Other: 2 });
});

test('CI diagnostics reject an unapproved source and malformed configuration without changing test success', async t => {
  const f = fixture(t, "import test from 'node:test'; test('synthetic pass', () => {});\n");
  assert.throws(() => diagnostics.prepareDiagnostics(f.root, f.runnerTemp, ['../secret.test.mjs']));
  fs.writeFileSync(path.join(f.root, 'unapproved.mjs'), 'process.exitCode=3;\n');
  // Direct non-test helpers are not registered as approved test workers.
  const direct = await run(process.execPath, ['--require', preload, 'unapproved.mjs'],
    { cwd: f.root, env: f.env, allowFailure: true, timeout: 5000 });
  assert.equal(direct.code, 3);
  assert.deepEqual(f.rows(), []);
  const config = JSON.parse(fs.readFileSync(f.env.CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG, 'utf8'));
  config.files = ['tests/not-in-manifest.test.mjs'];
  fs.writeFileSync(f.env.CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG, JSON.stringify(config));
  const malformed = await run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 5000 });
  assert.equal(malformed.code, 0);
  assert.match(malformed.stdout + malformed.stderr, /CI_TEST_DIAGNOSTICS_INCOMPLETE/);
  assert.deepEqual(f.rows(), []);
  assert.doesNotMatch(malformed.stdout + malformed.stderr, /Invalid diagnostic|config\.json/);
});

test('CI diagnostic files and their aggregate have fixed quotas and report truncated evidence', async t => {
  // Drive the same closed metadata writer, never the native test lifecycle.
  const f = fixture(t, `import test from 'node:test'; import { createRequire } from 'node:module';
    const diagnostics = createRequire(import.meta.url)(${JSON.stringify(preload)});
    test('synthetic quota', () => {
      const unaccepted = { get body() { throw new Error('${sentinel}'); } };
      for(let i=0;i<1000;i++) diagnostics.recordDiagnosticSnapshot(unaccepted);
    });\n`);
  const result = await run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 5000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout + result.stderr, /CI_TEST_DIAGNOSTICS_INCOMPLETE/);
  const rows = f.rows();
  checkRows(rows, f.file);
  assert.equal(JSON.stringify(rows).includes(sentinel), false);
  assert.ok(rows.some(row => row.event === 'incomplete' && row.reason === 'size-limit'));
  const sizes = fs.readdirSync(f.directory).filter(name => name.endsWith('.jsonl'))
    .map(name => fs.statSync(path.join(f.directory, name)).size);
  assert.ok(sizes.every(size => size <= 64 * 1024));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 2 * 1024 * 1024);
});

test('CI diagnostic output failure is explicitly incomplete and never replaces the test result', async t => {
  const f = fixture(t, "import test from 'node:test'; test('synthetic pass', () => {});\n");
  fs.mkdirSync(path.join(f.directory, 'runner.jsonl'));
  const result = await run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 5000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout + result.stderr, /CI_TEST_DIAGNOSTICS_INCOMPLETE/);
  assert.doesNotMatch(result.stdout + result.stderr, /EISDIR|runner\.jsonl|stack/);
  const worker = JSON.parse(fs.readFileSync(path.join(f.directory, 'worker-0.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(worker.event, 'exit');
  assert.equal(worker.code, 0);
});

test('CI diagnostics expose the still-running native worker without closing its resources', { timeout: 40000 }, async t => {
  const f = fixture(t, "import test from 'node:test'; test('synthetic retained timer', () => { setInterval(() => {},1000); });\n");
  await assert.rejects(run(process.execPath, f.args, { cwd: f.root, env: f.env, timeout: 32000 }), /Process timed out after 32000 ms/);
  // Only the synthetic process tree owned by run() is stopped at its original test boundary.
  const rows = f.rows();
  checkRows(rows, f.file);
  const worker = rows.filter(row => row.source === f.file);
  assert.ok(worker.some(row => row.event === 'start'));
  assert.ok(worker.some(row => row.event === 'snapshot' && row.resources.Timeout >= 1 && row.elapsedMs >= 29000));
  assert.equal(worker.some(row => row.event === 'exit'), false);
});
