import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSourceLock, archiveFiles, bootstrap } from '../bootstrap.mjs';

const commit = 'a'.repeat(40), prefix = 'Context-Guard-Skill-' + commit;
function archive(extra = []) {
  const records = [
    { name: prefix + '/packages/dashboard/src/server.mjs', body: 'export const server = true;' },
    { name: prefix + '/packages/dashboard/src/config.mjs', body: 'export const config = true;' },
    ...extra,
  ];
  const parts = [];
  for (const { name, body = '', type = '0', link = '' } of records) {
    const header = Buffer.alloc(512), data = Buffer.from(body);
    header.write(name); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157); header.write('ustar\0', 257);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function lockFor(buffer) {
  return { schemaVersion: 1, repository: 'https://github.com/Michel-Johnson/Context-Guard-Skill', commit,
    archiveUrl: 'https://codeload.github.com/Michel-Johnson/Context-Guard-Skill/tar.gz/' + commit,
    archiveSha256: createHash('sha256').update(buffer).digest('hex'), modulePath: 'packages/dashboard' };
}

test('fixed source rejects branches, malformed hashes, redirects and arbitrary source URLs', () => {
  const good = lockFor(archive());
  for (const patch of [{ commit: 'main' }, { commit: 'a'.repeat(39) }, { archiveSha256: 'pending' },
    { modulePath: '../dashboard' }, { archiveUrl: good.archiveUrl.replace('https:', 'http:') },
    { archiveUrl: good.archiveUrl.replace('codeload.github.com', 'codeload.github.com.evil.example') },
    { archiveUrl: good.archiveUrl + '?latest=1' }, { repository: 'https://github.com/other/repository' }]) {
    assert.throws(() => validateSourceLock({ ...good, ...patch }));
  }
  assert.throws(() => archiveFiles(archive(), { ...good, archiveSha256: '0'.repeat(64) }), /SHA256/);
});

test('archive rejects traversal, absolute paths, symlinks, hardlinks, special files and duplicates', () => {
  for (const entry of [
    { name: prefix + '/packages/dashboard/../../escape' }, { name: '/absolute/file' },
    { name: prefix + '/packages/dashboard/evil', type: '2', link: '/outside' },
    { name: prefix + '/packages/dashboard/evil', type: '1', link: 'src/server.mjs' },
    { name: prefix + '/packages/dashboard/evil', type: '6' },
    { name: prefix + '/packages/dashboard/src/server.mjs' },
    { name: prefix + '/packages/dashboard/..\\escape' },
  ]) { const buffer = archive([entry]); assert.throws(() => archiveFiles(buffer, lockFor(buffer))); }
});

test('offline archive is hash checked, generates only the module, and download forbids redirects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const buffer = archive([
    { name: prefix + '/unrelated-secret.txt', body: 'fixture ignored' },
    { name: prefix + '/skills/build-distribution.py', body: '# fixture builder' },
    { name: prefix + '/skills/jiarui/version.json', body: '{"version":"1.0.0"}' },
    { name: prefix + '/skills/dashboard-connect/version.json', body: '{"version":"1.0.0"}' },
    { name: prefix + '/skills/unrelated/SKILL.md', body: 'fixture ignored' },
  ]);
  const lock = lockFor(buffer), lockFile = join(dir, 'lock.json'), source = join(dir, 'source.tar.gz'), target = join(dir, 'generated');
  await writeFile(lockFile, JSON.stringify(lock)); await writeFile(source, buffer);
  assert.equal(await bootstrap({ lockFile, source, target }), target);
  assert.equal(await readFile(join(target, 'packages/dashboard/src/server.mjs'), 'utf8'), 'export const server = true;');
  await assert.rejects(readFile(join(target, 'unrelated-secret.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(target, 'skills/unrelated/SKILL.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(target, 'skills/build-distribution.py'), 'utf8'), '# fixture builder');
  assert.equal(await readFile(join(target, 'skills/jiarui/version.json'), 'utf8'), '{"version":"1.0.0"}');
  assert.deepEqual(JSON.parse(await readFile(join(target, '.source-lock.json'), 'utf8')), lock);
  const linked = join(dir, 'linked.tar.gz'); await symlink(source, linked);
  await assert.rejects(bootstrap({ lockFile, source: linked, target }), /regular archive/);
  await bootstrap({ lockFile, target, fetcher: async (url, options) => {
    assert.equal(url, lock.archiveUrl); assert.equal(options.redirect, 'error');
    return new Response(buffer);
  } });
  await writeFile(source, Buffer.from('tampered'));
  await assert.rejects(bootstrap({ lockFile, source, target }), /SHA256/);
  assert.equal(await readFile(join(target, 'packages/dashboard/src/server.mjs'), 'utf8'), 'export const server = true;');
});
