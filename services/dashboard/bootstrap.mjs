import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const destination = fileURLToPath(new URL('../../temp/dashboard-shared/', import.meta.url));
const MAX_BYTES = 128 * 1024 * 1024;
const REPOSITORY = 'https://github.com/Michel-Johnson/Context-Guard-Skill';

export function validateSourceLock(lock) {
  if (lock?.schemaVersion !== 1 || lock.repository !== REPOSITORY
      || !/^[a-f0-9]{40}$/.test(lock.commit) || !/^[a-f0-9]{64}$/.test(lock.archiveSha256)
      || lock.modulePath !== 'packages/dashboard') throw new Error('Invalid fixed Dashboard source lock');
  const expected = `https://codeload.github.com/Michel-Johnson/Context-Guard-Skill/tar.gz/${lock.commit}`;
  if (lock.archiveUrl !== expected) throw new Error('Archive URL must be the exact HTTPS GitHub codeload commit URL');
  return lock;
}

function safePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)
      || name.split('/').some(x => x === '..' || x === '.') || /^[A-Za-z]:/.test(name)) {
    throw new Error('Unsafe archive path');
  }
  return name.replace(/\/$/, '');
}

function parsePax(data) {
  const fields = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid PAX header');
    const length = Number(data.subarray(offset, space).toString());
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length) throw new Error('Invalid PAX length');
    const record = data.subarray(space + 1, offset + length).toString('utf8');
    const equal = record.indexOf('=');
    if (equal <= 0 || !record.endsWith('\n')) throw new Error('Invalid PAX record');
    fields[record.slice(0, equal)] = record.slice(equal + 1, -1);
    offset += length;
  }
  // Only metadata and a validated long pathname are accepted; size/link overrides fail closed.
  if (Object.keys(fields).some(key => !['path', 'comment', 'mtime', 'atime', 'ctime', 'uid', 'gid'].includes(key))) throw new Error('Unsupported PAX override');
  if (fields.path) safePath(fields.path);
  return fields;
}

export function archiveFiles(archive, lock) {
  validateSourceLock(lock);
  if (archive.length > MAX_BYTES || createHash('sha256').update(archive).digest('hex') !== lock.archiveSha256) throw new Error('Dashboard archive SHA256 mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: MAX_BYTES });
  const prefix = `Context-Guard-Skill-${lock.commit}`;
  const files = [];
  const names = new Set();
  let pax = {}, ended = false;
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error('Truncated archive header');
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('Nonzero archive trailer');
      ended = true; break;
    }
    const field = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
    const octal = (start, size) => {
      const value = field(start, size).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('Invalid archive numeric field');
      return Number.parseInt(value, 8);
    };
    const checksum = octal(148, 8);
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error('Invalid archive checksum');
    const size = octal(124, 12), type = field(156, 1) || '0';
    const rawName = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    safePath(rawName);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error('Truncated archive body');
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset = next;
    if (type === 'g' || type === 'x') {
      const extra = parsePax(data);
      if (type === 'g' && extra.path) throw new Error('Global archive path override is forbidden');
      if (type === 'x') pax = extra;
      continue;
    }
    const name = safePath(pax.path || rawName); pax = {};
    if (!['0', '5'].includes(type) || field(157, 100)) throw new Error('Archive links and special files are forbidden');
    if (name !== prefix && !name.startsWith(prefix + '/')) throw new Error('Unexpected archive root');
    if (names.has(name)) throw new Error('Duplicate archive path');
    names.add(name);
    if (type === '5') { if (size) throw new Error('Archive directory has body'); continue; }
    const relative = name.slice(prefix.length + 1);
    if (relative.startsWith(lock.modulePath + '/')
        || /^skills\/(?:jiarui|dashboard-connect)\//.test(relative)
        || relative === 'skills/build-distribution.py') files.push({ path: relative, data });
  }
  if (!ended || !files.some(f => f.path === lock.modulePath + '/src/server.mjs')
      || !files.some(f => f.path === lock.modulePath + '/src/config.mjs')) throw new Error('Dashboard module missing or archive incomplete');
  return files;
}

export async function bootstrap({ lockFile = new URL('./source-lock.json', import.meta.url), source, target = destination, fetcher = globalThis.fetch } = {}) {
  const lock = validateSourceLock(JSON.parse(await readFile(lockFile, 'utf8')));
  let archive;
  if (source) {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Offline source must be a bounded regular archive file');
    archive = await readFile(source);
  } else {
    const response = await fetcher(lock.archiveUrl, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Dashboard archive download failed');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error('Dashboard archive too large');
      chunks.push(chunk);
    }
    archive = Buffer.concat(chunks);
  }
  const files = archiveFiles(archive, lock);
  target = resolve(target);
  await mkdir(dirname(target), { recursive: true });
  // Staging is created by us with no symlinks; no archive-provided permissions execute.
  const stage = await mkdtemp(join(dirname(target), '.dashboard-bootstrap-'));
  try {
    for (const file of files) {
      const output = join(stage, ...file.path.split('/'));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, file.data, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(stage, '.source-lock.json'), JSON.stringify(lock) + '\n');
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return target;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: node bootstrap.mjs [--source exact-archive.tar.gz]');
  console.log(await bootstrap({ source: args[1] }));
}
