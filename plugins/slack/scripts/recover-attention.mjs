import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/store.mjs';
import { recoveryCandidate, operatorDirectory, recoverySourceHash } from '../src/recovery.mjs';

// The operator writes only a protected approval capsule, never the live Store.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) {
    if (!value.startsWith('--') || !all[index + 1]) throw new Error('Use explicit --name value arguments');
    pairs.push([value.slice(2), all[index + 1]]);
  }
  return pairs;
}, []));
const fields = ['mode', 'state-dir', 'operator-dir', 'inbox-id', 'operation-id', 'snapshot-hash', 'source-hash', 'pid', 'reason', 'team-id'];
try {
  if (Object.keys(args).some(key => !fields.includes(key)) || !['describe', 'preflight', 'apply'].includes(args.mode) ||
      !path.isAbsolute(args['state-dir'] || '') || !args['inbox-id'] || process.platform === 'win32' || process.getuid() !== 0) {
    throw Object.assign(new Error('Use the administrator CLI with an explicit original scope'), { code: 'INVALID_OPERATOR_REQUEST' });
  }
  const directory = path.resolve(args['state-dir']), stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || await fs.realpath(directory) !== directory) throw Object.assign(new Error('Unsafe state directory'), { code: 'UNSAFE_STATE_DIRECTORY' });
  const stateFile = path.join(directory, 'state.json'), stateStat = await fs.lstat(stateFile);
  if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.uid !== stat.uid || (stateStat.mode & 0o077)) throw Object.assign(new Error('Unsafe state file'), { code: 'UNSAFE_STATE_FILE' });
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const candidate = recoveryCandidate(state, args['inbox-id'], args['team-id'] || 'T0BRW7G4Q6P');
  const sourceHash = await recoverySourceHash(), pid = Number(await fs.readFile(path.join(directory, 'process.lock'), 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0 || state.operatorOwner?.pid !== pid || state.operatorOwner.sourceHash !== sourceHash) {
    throw Object.assign(new Error('The running operator owner does not match the reviewed source'), { code: 'STALE_OPERATOR_OWNER' });
  }
  process.kill(pid, 0);
  if (args.mode === 'describe') {
    console.log(JSON.stringify({ inboxId: args['inbox-id'], memberIds: candidate.descriptor.memberIds, snapshotHash: candidate.descriptor.snapshotHash,
      sourceHash, pid, original: candidate.original, format: candidate.scope.legacyFormat, audit: state.recoveries?.[args['operation-id']]?.status || null }));
  } else {
    if (args['snapshot-hash'] !== candidate.descriptor.snapshotHash || args['source-hash'] !== sourceHash || Number(args.pid) !== pid ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(args['operation-id'] || '') || !args.reason?.trim() || args.reason.length > 1000) {
      throw Object.assign(new Error('Explicit approved scope does not match current owner'), { code: 'STALE_OPERATOR_APPROVAL' });
    }
    const parent = await operatorDirectory(args['operator-dir'], stat.gid);
    const request = { v: 1, operationId: args['operation-id'], mode: args.mode, inboxId: args['inbox-id'], snapshotHash: args['snapshot-hash'],
      expectedPid: pid, expectedSourceHash: sourceHash, reason: args.reason };
    const filename = path.join(args['operator-dir'], digest(request.operationId) + '.json');
    try {
      const oldStat = await fs.lstat(filename), old = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (!oldStat.isFile() || oldStat.isSymbolicLink() || oldStat.uid !== 0 || oldStat.gid !== parent.gid || (oldStat.mode & 0o777) !== 0o640 ||
          digest({ ...old, mode: undefined, expectedPid: undefined }) !== digest({ ...request, mode: undefined, expectedPid: undefined })) {
        throw Object.assign(new Error('Control ID belongs to another approval'), { code: 'ID_REUSED' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (args.mode === 'apply' && state.recoveries?.[request.operationId]?.status !== 'preflighted' &&
        !['dispatching', 'unknown'].includes(state.recoveries?.[request.operationId]?.status)) throw Object.assign(new Error('Review preflight first'), { code: 'PRECHECK_REQUIRED' });
    const temporary = path.join(args['operator-dir'], `.request-${randomUUID()}`), handle = await fs.open(temporary, 'wx', 0o640);
    try { await handle.chown(0, parent.gid); await handle.chmod(0o640); await handle.writeFile(JSON.stringify(request)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
    const dir = await fs.open(args['operator-dir'], 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    console.log(JSON.stringify({ approved: true, operationId: request.operationId, mode: request.mode, snapshotHash: request.snapshotHash }));
  }
} catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'OPERATOR_RECOVERY_UNAVAILABLE' })); process.exitCode = 1; }
