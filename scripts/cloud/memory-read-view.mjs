import fs from 'node:fs/promises';
import { atomicWrite, encode, readJSON } from '../shared/io.mjs';

// Never retain historical snapshots/receipts in the hot read cache. Disk remains
// authoritative; inode and nanosecond timestamps also detect external replaces.
const projectView = state => Object.fromEntries(
  ['revision', 'main', 'preferences', 'sessions', 'closedSessions', 'events', 'eventCursors']
    .filter(key => key in state).map(key => [key, state[key]]),
);
export function freezeContextValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeContextValue(item, seen);
  return Object.freeze(value);
}
async function fileInfo(file) {
  try {
    const info = await fs.stat(file, { bigint: true });
    return { stamp: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, bytes: Number(info.size) };
  } catch (error) { if (error.code === 'ENOENT') return { stamp: '', bytes: 0 }; throw error; }
}

export function createMemoryReadViews({ read = readJSON, write = atomicWrite, maxEntries = 32, maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Positive bounded read-view limits required');
  }
  const entries = new Map();
  let generation = 0;
  const stats = { fullClones: 0, mainSelections: 0, evictions: 0 };
  // Source bytes are a retention budget, not a measurement of JS heap. Pending
  // requests keep their own references even if the LRU evicts their entry.
  const bytes = () => [...entries.values()].reduce((total, entry) => total + (entry.bytes || 0), 0);
  const trim = () => {
    while (entries.size > maxEntries || bytes() > maxBytes) {
      entries.delete(entries.keys().next().value);
      stats.evictions++;
    }
  };
  const remember = (file, entry) => {
    entries.delete(file); entries.set(file, entry); trim();
  };
  async function entryFor(file, initial, retries = 0) {
    let entry = entries.get(file);
    if (!entry?.pending) {
      entry ||= {};
      const selected = entry;
      selected.pending = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await fileInfo(file);
          if (selected.stamp === before.stamp && selected.view) return selected.view;
          const state = await read(file, initial);
          if (before.stamp !== (await fileInfo(file)).stamp) continue;
          selected.stamp = before.stamp;
          selected.bytes = before.bytes;
          selected.view = projectView(state);
          selected.mainSelection = null;
          selected.generation = ++generation;
          return selected.view;
        }
        throw new Error('Memory changed while reading current state');
      })();
      remember(file, selected);
      selected.pending.finally(() => { selected.pending = null; trim(); }).catch(() => {});
    }
    const view = await entry.pending;
    if (entry.view !== view) {
      if (retries >= 3) throw new Error('Memory generation changed while selecting');
      return entryFor(file, initial, retries + 1);
    }
    return { entry, view, stamp: entry.stamp, generation: entry.generation };
  }
  return {
    async read(file, initial) {
      // Callers may assemble responses, but cannot mutate a cached generation.
      const { view } = await entryFor(file, initial);
      stats.fullClones++;
      return structuredClone(view);
    },
    async readMain(file, initial) {
      const { entry, view, stamp, generation } = await entryFor(file, initial);
      stats.mainSelections++;
      const select = () => Object.freeze({ revision: view.revision, main: freezeContextValue(view.main) });
      const state = entry.view === view && entry.generation === generation
        ? (entry.mainSelection ||= select()) : select();
      return { state, stamp, generation, isCurrent: async () => {
        const matches = () => entries.get(file) === entry && entry.stamp === stamp && entry.generation === generation;
        if (!matches()) return false;
        const current = await fileInfo(file);
        return matches() && current.stamp === stamp;
      } };
    },
    async write(file, state) {
      const entry = { generation: ++generation };
      entry.pending = (async () => {
        await write(file, encode(state));
        const current = await fileInfo(file);
        entry.stamp = current.stamp;
        entry.bytes = current.bytes;
        entry.view = structuredClone(projectView(state));
        stats.fullClones++;
        return entry.view;
      })();
      remember(file, entry);
      try { await entry.pending; }
      catch (error) { if (entries.get(file) === entry) entries.delete(file); throw error; }
      finally { entry.pending = null; trim(); }
    },
    stats: () => ({ ...stats, entries: entries.size, bytes: bytes(), maxEntries, maxBytes }),
  };
}

export const memoryReadViews = createMemoryReadViews();
