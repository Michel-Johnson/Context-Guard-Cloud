'use strict';

const fs = require('node:fs');
const path = require('node:path');

const directoryName = 'cloud-node18-diagnostics';
const totalBytes = 2 * 1024 * 1024;
const fileBytes = 64 * 1024;
const reserveBytes = 512;
const resourceKinds = new Set(['FSReqCallback', 'FSReqPromise', 'FSEventWrap', 'PipeWrap',
  'TCPServerWrap', 'TCPSocketWrap', 'TLSWrap', 'TTYWrap', 'Timeout', 'Immediate',
  'UDPWrap', 'ProcessWrap', 'SignalWrap', 'StatWatcher', 'MessagePort', 'SocketAddress']);

function discoverTestFiles(root = process.cwd()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/test-manifest.json'), 'utf8'));
  const excluded = new Set(manifest.automaticNodeTests.excluded);
  return manifest.automaticNodeTests.roots.flatMap(directory => fs.readdirSync(path.join(root, directory))
    .filter(name => name.endsWith('.test.mjs')).map(name => `${directory}/${name}`))
    .filter(file => !excluded.has(file)).sort();
}

function validFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 500 &&
    new Set(files).size === files.length && files.every(file => typeof file === 'string' &&
      /^(?:\.github\/scripts|tests)\/[A-Za-z0-9_-]+\.test\.mjs$/.test(file));
}

function prepareDiagnostics(root, runnerTemp, files) {
  root = fs.realpathSync(root);
  runnerTemp = fs.realpathSync(runnerTemp);
  if (!validFiles(files) || JSON.stringify(files) !== JSON.stringify(discoverTestFiles(root))) {
    throw new Error('Invalid diagnostic test mapping');
  }
  const directory = path.join(runnerTemp, directoryName);
  fs.mkdirSync(directory, { mode: 0o700 });
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ root, files,
    bytesPerFile: Math.min(fileBytes, Math.floor(totalBytes / (files.length + 1))) }), { flag: 'wx', mode: 0o600 });
  return configPath;
}

function readConfiguration(env) {
  const runnerTemp = fs.realpathSync(env.RUNNER_TEMP);
  const expectedDirectory = path.join(runnerTemp, directoryName);
  const configPath = path.join(expectedDirectory, 'config.json');
  if (env.CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG !== configPath ||
      fs.realpathSync(expectedDirectory) !== expectedDirectory || fs.realpathSync(configPath) !== configPath ||
      fs.statSync(configPath).size > 128 * 1024) throw new Error('Invalid diagnostic configuration');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.root !== fs.realpathSync(process.cwd()) || !validFiles(config.files) ||
      JSON.stringify(config.files) !== JSON.stringify(discoverTestFiles(config.root)) ||
      config.bytesPerFile !== Math.min(fileBytes, Math.floor(totalBytes / (config.files.length + 1)))) {
    throw new Error('Invalid diagnostic mapping');
  }
  return { ...config, directory: expectedDirectory };
}

function resourceCounts(resources) {
  const counts = Object.create(null);
  for (const kind of resources) {
    const name = resourceKinds.has(kind) ? kind : 'Other';
    counts[name] = Math.min(100000, (counts[name] || 0) + 1);
  }
  return counts;
}

// The writer generates closed metadata itself; callers cannot supply records,
// source paths, resources, error objects, environment values or message bodies.
function createDiagnosticWriter(config, source, filename, incomplete, stopObserver) {
  const fd = fs.openSync(path.join(config.directory, filename), 'wx', 0o600);
  const started = process.hrtime.bigint();
  const getResources = process.getActiveResourcesInfo.bind(process);
  let bytes = 0, stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    stopObserver();
    try { fs.closeSync(fd); } catch { incomplete(); }
  }
  function record(event, code) {
    if (stopped || !['start', 'snapshot', 'beforeExit', 'exit'].includes(event)) return;
    try {
      const row = { pid: process.pid, source, event, time: new Date().toISOString(),
        elapsedMs: Number((process.hrtime.bigint() - started) / 1000000n),
        resources: resourceCounts(getResources()) };
      if (event === 'exit') row.code = Number.isInteger(code) ? code : null;
      let line = `${JSON.stringify(row)}\n`;
      if (bytes + Buffer.byteLength(line) > config.bytesPerFile - reserveBytes) {
        line = `${JSON.stringify({ pid: process.pid, source, event: 'incomplete', reason: 'size-limit' })}\n`;
        incomplete();
        if (fs.writeSync(fd, line) !== Buffer.byteLength(line)) incomplete();
        stop();
        return;
      }
      if (fs.writeSync(fd, line) !== Buffer.byteLength(line)) { incomplete(); stop(); return; }
      bytes += Buffer.byteLength(line);
    } catch { incomplete(); stop(); }
  }
  return { record, stop, get stopped() { return stopped; } };
}

let recordActiveSnapshot = () => {};
// This CI-only entry exercises the same writer without emitting native lifecycle
// events. It deliberately accepts no data, path, event or error parameters.
function recordDiagnosticSnapshot() { recordActiveSnapshot(); }

function enableDiagnostics(env = process.env) {
  if (env.CONTEXT_GUARD_CI_TEST_DIAGNOSTICS !== '1' || !env.CONTEXT_GUARD_TEST_DIAGNOSTICS_CONFIG) return;
  let incompleteReported = false;
  const incomplete = () => {
    if (!incompleteReported) process.stderr.write('[CI_TEST_DIAGNOSTICS_INCOMPLETE]\n');
    incompleteReported = true;
  };
  try {
    const config = readConfiguration(env);
    let source = null, filename;
    const registration = path.join(config.directory, 'runner.json');
    if (!env.NODE_TEST_CONTEXT && process.execArgv.includes('--test')) {
      fs.writeFileSync(registration, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      filename = 'runner.jsonl';
    } else if (env.NODE_TEST_CONTEXT === 'child-v8' && process.argv[1]) {
      if (fs.realpathSync(registration) !== registration || fs.statSync(registration).size > 64) throw new Error('Invalid diagnostic runner');
      const runner = JSON.parse(fs.readFileSync(registration, 'utf8'));
      if (!Number.isSafeInteger(runner.pid) || runner.pid !== process.ppid) return;
      const resolved = path.resolve(process.argv[1]);
      source = path.relative(config.root, resolved).split(path.sep).join('/');
      const index = config.files.indexOf(source);
      if (index < 0 || fs.realpathSync(resolved) !== resolved) return;
      filename = `worker-${index}.jsonl`;
    } else return;

    // One exclusive file per approved worker bounds the entire artifact to 2 MiB.
    // These are diagnostic-only descriptors; no business handles are inspected or closed.
    let timer;
    const writer = createDiagnosticWriter(config, source, filename, incomplete, () => clearInterval(timer));
    writer.record('start');
    if (writer.stopped) return;
    recordActiveSnapshot = () => writer.record('snapshot');
    timer = setInterval(recordDiagnosticSnapshot, 30000);
    timer.unref();
    process.on('beforeExit', () => writer.record('beforeExit'));
    process.once('exit', code => { writer.record('exit', code); writer.stop(); });
  } catch { incomplete(); }
}

module.exports = { discoverTestFiles, prepareDiagnostics, resourceCounts, enableDiagnostics, recordDiagnosticSnapshot };
enableDiagnostics();
