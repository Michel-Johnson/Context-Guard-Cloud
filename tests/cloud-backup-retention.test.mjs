import '../.github/scripts/test-environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listCloudBackups, pruneCloudBackups, verifyCloudBackup } from '../deploy/prune-cloud-backups.mjs';

const script = fileURLToPath(new URL('../deploy/prune-cloud-backups.mjs', import.meta.url));
const fixture = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-backup-retention-'));
  await fs.mkdir(path.join(root, 'context-guard-cloud'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const archiveName = number => `context-guard-cloud-pre-v${number}-20260924T00000${number}Z.tar`;
const nestedName = number => `pre-v${number}-20260924T00000${number}Z.tar.zst`;
const millisecondName = number => `pre-cloud-release-20261007T204829${String(number).padStart(3, '0')}Z.tar`;
const createCandidate = async (root, number, nested = false, name = nested ? nestedName(number) : archiveName(number)) => {
  const file = path.join(root, ...(nested ? ['context-guard-cloud', name] : [name]));
  await fs.writeFile(file, `backup ${number}`);
  const timestamp = new Date(Date.UTC(2026, 8, 23, 0, number));
  await fs.utimes(file, timestamp, timestamp);
  return file;
};

test('inventory accepts only legacy four-to-six or exact nine-digit timestamps and both archive formats', async t => {
  const root = await fixture(t), expected = [], ignored = [];
  let number = 0;
  for (const timestamp of ['2048', '20482', '204829', '204829844']) {
    for (const nested of [false, true]) for (const extension of ['.tar', '.tar.zst']) {
      const name = `${nested ? 'pre-cloud-release' : 'context-guard-cloud-pre-release'}-20261007T${timestamp}Z${extension}`;
      expected.push(await createCandidate(root, ++number, nested, name));
    }
  }
  for (const timestamp of ['204', '2048298', '20482984', '2048298440']) {
    ignored.push(await createCandidate(root, ++number, true, `pre-cloud-release-20261007T${timestamp}Z.tar`));
  }
  for (const extension of ['.tar.part', '.tar.zst.part']) ignored.push(await createCandidate(root, ++number, true,
    `pre-cloud-release-20261007T204829844Z${extension}`));
  const inventory = await listCloudBackups(root);
  assert.deepEqual(inventory.map(item => item.path).sort(), [...expected].sort());
  assert.ok(inventory.every(item => item.kind === 'file'));
  for (const file of ignored) assert.equal(await fs.readFile(file, 'utf8'), `backup ${expected.length + ignored.indexOf(file) + 1}`);
});

test('retention keeps five newest snapshots across both known directories and leaves other files untouched', async t => {
  const root = await fixture(t);
  const backups = [];
  for (let number = 1; number <= 7; number++) backups.push(await createCandidate(root, number, number % 2 === 0,
    number === 2 || number === 4 ? millisecondName(number) : number % 2 === 0 ? nestedName(number) : archiveName(number)));
  const unrelated = path.join(root, 'dpkg.status.0');
  const diagnostic = path.join(root, 'context-guard-cloud', 'memory-before-lab.json');
  const partial = path.join(root, 'context-guard-cloud', millisecondName(8) + '.part');
  await fs.writeFile(unrelated, 'unrelated');
  await fs.writeFile(diagnostic, 'diagnostic');
  await fs.writeFile(partial, 'still writing');
  const dryRun = await pruneCloudBackups({ root, now: Date.UTC(2026, 8, 24), minQuietMs: 0, verify: async () => {} });
  assert.equal(dryRun.status, 'dry-run');
  assert.equal(dryRun.stale.length, 2);
  assert.equal((await listCloudBackups(root)).length, 7, 'dry-run deletes nothing');
  const result = await pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0, verify: async () => {} });
  assert.deepEqual(result.removed, backups.slice(0, 2).reverse());
  assert.deepEqual((await listCloudBackups(root)).map(item => item.path), backups.slice(2).reverse());
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated');
  assert.equal(await fs.readFile(diagnostic, 'utf8'), 'diagnostic');
  assert.equal(await fs.readFile(partial, 'utf8'), 'still writing');
});

test('新完成的备份立即清理旧版；保留备份无效时不删除', async t => {
  const root = await fixture(t);
  const backups = [];
  for (let number = 1; number <= 6; number++) backups.push(await createCandidate(root, number));
  const fresh = new Date();
  await fs.utimes(backups[5], fresh, fresh);
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async item => { if (item.path === backups[5]) throw new Error('invalid archive'); } }), /invalid archive/);
  assert.equal((await listCloudBackups(root)).length, 6, 'validation fails before removing an old backup');
  const recent = await pruneCloudBackups({ root, apply: true, verify: async () => {} });
  assert.equal(recent.status, 'ok');
  assert.deepEqual(recent.removed, [backups[0]]);
  assert.equal((await listCloudBackups(root)).length, 5);
});

test('a changed backup invalidates the deletion plan', async t => {
  const root = await fixture(t);
  for (let number = 1; number <= 6; number++) await createCandidate(root, number);
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async item => { if (item.path.endsWith(archiveName(6))) await fs.writeFile(item.path, 'changed'); } }), /changed during verification/);
  assert.equal((await listCloudBackups(root)).length, 6);
});

test('new-format inventory changes and invalid retained archives preserve every snapshot', async t => {
  const root = await fixture(t), backups = [];
  for (let number = 1; number <= 6; number++) backups.push(await createCandidate(root, number, true, millisecondName(number)));
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async item => { if (item.path === backups[5]) throw new Error('invalid retained new-format archive'); } }), /invalid retained new-format archive/);
  assert.equal((await listCloudBackups(root)).length, 6);
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async item => { if (item.path === backups[5]) await createCandidate(root, 7, true, millisecondName(7)); } }), /inventory changed during verification/);
  assert.equal((await listCloudBackups(root)).length, 7);
  for (const [index, file] of backups.entries()) assert.equal(await fs.readFile(file, 'utf8'), `backup ${index + 1}`);
});

test('备份子目录是符号链接时拒绝清理，不访问外部备份', async t => {
  const root = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-backup-protected-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rmdir(path.join(root, 'context-guard-cloud'));
  for (let number = 1; number <= 6; number++) await createCandidate(outside, number, false, millisecondName(number));
  await fs.symlink(outside, path.join(root, 'context-guard-cloud'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pruneCloudBackups({ root, apply: true, verify: async () => {} }), /real directory/);
  assert.equal((await fs.readdir(outside)).length, 6);
});

test('完成归档的目录变化立即触发清理；定时器只作保底', async () => {
  const unit = await fs.readFile(new URL('../deploy/context-guard-cloud-backup-retention.path', import.meta.url), 'utf8');
  assert.match(unit, /^PathChanged=\/var\/backups$/m);
  assert.match(unit, /^PathChanged=\/var\/backups\/context-guard-cloud$/m);
  assert.match(unit, /^Unit=context-guard-cloud-backup-retention.service$/m);
  assert.doesNotMatch(unit, /OnCalendar|OnActiveSec/);
  const scriptSource = await fs.readFile(script, 'utf8');
  assert.doesNotMatch(scriptSource, /quietMs|minQuietMs|deferred-recent-backup/);
  const guide = await fs.readFile(new URL('../references/cloud-deployment.md', import.meta.url), 'utf8');
  assert.match(guide, /enable --now context-guard-cloud-backup-retention.path/);
  assert.match(guide, /systemctl start context-guard-cloud-backup-retention.service/);
});

test('new-format symbolic entries are refused before validation or deletion', async t => {
  const root = await fixture(t);
  for (let number = 1; number <= 6; number++) await createCandidate(root, number, true, millisecondName(number));
  const target = path.join(root, 'protected-payload'), link = path.join(root, 'context-guard-cloud', millisecondName(7));
  await fs.mkdir(target); await fs.writeFile(path.join(target, 'record.txt'), 'retained payload');
  // Junctions are symbolic entries on Windows without requiring privileged
  // file-symlink creation; both platforms exercise lstat's symbolic guard.
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  let verified = false;
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async () => { verified = true; } }), /Unexpected backup entry type/);
  assert.equal(verified, false);
  assert.equal(await fs.readFile(path.join(target, 'record.txt'), 'utf8'), 'retained payload');
  assert.equal((await fs.readdir(path.join(root, 'context-guard-cloud'))).length, 7);
});

test('a backup-shaped entry with an unexpected type blocks pruning', async t => {
  const root = await fixture(t);
  for (let number = 1; number <= 6; number++) await createCandidate(root, number);
  await fs.mkdir(path.join(root, archiveName(7)));
  await assert.rejects(pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0,
    verify: async () => {} }), /Unexpected backup entry type/);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tar')).length, 7);
});

test('legacy snapshot directories require data and config and can be pruned precisely', async t => {
  const root = await fixture(t);
  const legacy = path.join(root, 'context-guard-cloud', 'pre-v1-20260924');
  await fs.mkdir(path.join(legacy, 'data'), { recursive: true });
  await assert.rejects(verifyCloudBackup({ path: legacy, kind: 'directory' }), /ENOENT|Incomplete backup directory/);
  await fs.mkdir(path.join(legacy, 'config'));
  await verifyCloudBackup({ path: legacy, kind: 'directory' });
  const timestamp = new Date(Date.UTC(2026, 8, 23));
  await fs.utimes(legacy, timestamp, timestamp);
  for (let number = 2; number <= 6; number++) await createCandidate(root, number);
  const result = await pruneCloudBackups({ root, apply: true, now: Date.UTC(2026, 8, 24), minQuietMs: 0, verify: async () => {} });
  assert.deepEqual(result.removed, [legacy]);
  await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
});

test('CLI validates complete tar archives before applying retention', async t => {
  const root = await fixture(t);
  const payload = path.join(root, 'payload.txt');
  const valid = path.join(root, 'valid.tar');
  await fs.writeFile(payload, 'recoverable backup fixture');
  const tar = spawnSync('tar', ['-cf', valid, '-C', root, 'payload.txt'], { windowsHide: true });
  assert.equal(tar.status, 0, 'tar is a documented Cloud prerequisite');
  for (let number = 1; number <= 6; number++) {
    const target = number % 2 === 0 ? path.join(root, 'context-guard-cloud', millisecondName(number)) : path.join(root, archiveName(number));
    await fs.copyFile(valid, target);
    const timestamp = new Date(Date.UTC(2026, 8, 23, 0, number));
    await fs.utimes(target, timestamp, timestamp);
  }
  const dryRun = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).status, 'dry-run');
  assert.deepEqual(JSON.parse(dryRun.stdout).removed, []);
  assert.equal((await listCloudBackups(root)).length, 6);
  const run = spawnSync(process.execPath, [script, '--root', root, '--apply'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).removed.length, 1);
  assert.equal((await listCloudBackups(root)).length, 5);
  const corrupted = await createCandidate(root, 7, true, millisecondName(7));
  await fs.writeFile(corrupted, 'corrupt tar');
  const timestamp = new Date(Date.UTC(2026, 8, 23, 0, 7));
  await fs.utimes(corrupted, timestamp, timestamp);
  const refused = spawnSync(process.execPath, [script, '--root', root, '--apply'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Backup verification failed/);
  assert.equal((await listCloudBackups(root)).length, 6);
});
