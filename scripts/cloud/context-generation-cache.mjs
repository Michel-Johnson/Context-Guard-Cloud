import { freezeContextValue } from './memory-read-view.mjs';

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

// Cache identity is authorization metadata, never a bearer credential. Unknown
// bindings still use the original shared filtering/slicing path on every read.
export function contextCacheIdentity({ projectId, sessionId, agentId, binding, admin, legacy, credential }) {
  const safe = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value) && (!credential || !value.includes(credential));
  const permission = binding?.permissionIdentity;
  const knownIdentity = safe(projectId, 200) && safe(sessionId, 200) && safe(agentId, 200) && (admin || legacy || safe(binding?.agentId, 200)
    && (permission === undefined || safe(permission, 256)));
  const scopeKey = knownIdentity ? JSON.stringify([projectId, sessionId, agentId,
    admin ? 'admin' : legacy ? 'project' : 'device', permission === undefined ? ['main-acl'] : ['explicit', permission]]) : null;
  return { knownIdentity: !!knownIdentity, scopeKey };
}

export function createContextGenerationCache({ maxEntries = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Positive bounded context cache limits required');
  }
  const entries = new Map();
  let bytes = 0, epoch = 0;
  const stats = { hits: 0, misses: 0, builds: 0, navigationBuilds: 0, singleflight: 0,
    evictions: 0, invalidations: 0, oversized: 0, oversizedHits: 0, navigationOversized: 0,
    unknownIdentity: 0, staleBuilds: 0, cacheFailures: 0, peakBytes: 0, peakEntries: 0 };
  const remove = (key, reason) => {
    const slot = entries.get(key);
    if (!slot) return;
    entries.delete(key); bytes -= slot.bytes;
    if (reason) stats[reason]++;
  };
  const observe = () => {
    stats.peakBytes = Math.max(stats.peakBytes, bytes);
    stats.peakEntries = Math.max(stats.peakEntries, entries.size);
  };
  const evictFor = (extra, own) => {
    while (entries.size > maxEntries || bytes + extra > maxBytes) {
      const key = [...entries.keys()].find(key => key !== own);
      if (key === undefined) break;
      remove(key, 'evictions');
    }
  };
  const currentSlot = async slot => entries.get(slot.key) === slot && slot.epoch === epoch
    && await slot.isCurrent() && entries.get(slot.key) === slot && slot.epoch === epoch;
  const store = (slot, record, logicalBytes) => {
    if (logicalBytes > maxBytes || entries.get(slot.key) !== slot) return false;
    const delta = logicalBytes - slot.bytes;
    evictFor(Math.max(0, delta), slot.key);
    if (bytes + delta > maxBytes) return false;
    bytes += delta; slot.bytes = logicalBytes; slot.record = record;
    record.wasCached = true; observe(); return true;
  };
  const marker = () => ({ admission: 'oversized', snapshot: null, lookup: null,
    navigation: null, navigationPending: null, marker: null, wasCached: false });
  const buildRecord = async build => {
    stats.builds++;
    // Business/read failures propagate. Only cache bookkeeping failures may
    // fall back to this request's already-authorized, freshly built snapshot.
    const prepared = await build();
    return { admission: 'prepared', snapshot: prepared.snapshot, lookup: prepared.lookup || null,
      navigation: null, navigationPending: null, marker: null, wasCached: false };
  };
  return {
    async get({ key, scopeKey, sourceStamp, knownIdentity = true, isCurrent, build }) {
      if (!knownIdentity) { stats.unknownIdentity++; return buildRecord(build); }
      const requestEpoch = epoch;
      let slot = entries.get(key);
      if (slot) {
        stats.hits++;
        if (slot.record?.admission === 'oversized') stats.oversizedHits++;
        if (slot.pending) stats.singleflight++;
        entries.delete(key); entries.set(key, slot);
        return slot.pending || slot.record;
      }
      // An old in-flight selector must not evict a newer generation's slot.
      try { if (!await isCurrent()) { stats.staleBuilds++; return buildRecord(build); } }
      catch { stats.cacheFailures++; return buildRecord(build); }
      // A request that started before clear may finish, but must not repopulate the cache.
      if (requestEpoch !== epoch) { stats.staleBuilds++; return buildRecord(build); }
      for (const [prior, value] of entries) {
        if (value.scopeKey === scopeKey && value.sourceStamp !== sourceStamp) remove(prior, 'invalidations');
      }
      // Another cold caller may have inserted the same slot during the check.
      slot = entries.get(key);
      if (slot) { stats.singleflight++; return slot.pending || slot.record; }
      stats.misses++;
      slot = { key, scopeKey, sourceStamp, epoch: requestEpoch, bytes: 0, isCurrent, record: null, pending: null };
      entries.set(key, slot); evictFor(0, key); observe();
      slot.pending = (async () => {
        const record = await buildRecord(build);
        try {
          if (!await currentSlot(slot)) {
            stats.staleBuilds++; if (entries.get(key) === slot) remove(key); return record;
          }
          // Logical retention = UTF-8 JSON + optional lookup allowance + slot
          // metadata. This is not JS heap/RSS, nor an in-flight allocation cap.
          slot.markerBytes = jsonBytes([key, scopeKey, sourceStamp]) + 128;
          const logicalBytes = jsonBytes(record.snapshot) + (record.lookup?.size || 0) * 128 + slot.markerBytes;
          freezeContextValue(record.snapshot);
          if (logicalBytes > maxBytes) {
            stats.oversized++;
            const rejected = marker();
            if (store(slot, rejected, slot.markerBytes)) record.marker = rejected;
            else remove(key);
            record.admission = 'oversized';
          } else if (!store(slot, record, logicalBytes)) remove(key);
        } catch { stats.cacheFailures++; if (entries.get(key) === slot) remove(key); }
        return record;
      })();
      try { return await slot.pending; }
      catch (error) { if (entries.get(key) === slot) remove(key); throw error; }
      finally { slot.pending = null; }
    },
    async navigation(record, build) {
      const target = record.marker || record;
      if (target.navigation) return target.navigation;
      if (target.navigationPending) { stats.singleflight++; return target.navigationPending; }
      target.navigationPending = (async () => {
        stats.navigationBuilds++;
        const navigation = await build();
        const match = [...entries].find(([, slot]) => slot.record === target);
        if (!match) { if (target.wasCached) stats.staleBuilds++; return navigation; }
        const [key, slot] = match;
        try {
          if (!await currentSlot(slot)) {
            stats.staleBuilds++; if (entries.get(key) === slot) remove(key); return navigation;
          }
          const extra = jsonBytes(navigation);
          freezeContextValue(navigation);
          if (slot.bytes + extra <= maxBytes) {
            if (store(slot, target, slot.bytes + extra)) target.navigation = navigation;
          } else {
            stats.navigationOversized++;
            if (target.admission === 'prepared') {
              const rejected = marker();
              if (store(slot, rejected, slot.markerBytes)) {
                record.marker = rejected;
                if (slot.markerBytes + extra <= maxBytes && store(slot, rejected, slot.markerBytes + extra)) rejected.navigation = navigation;
              } else remove(key);
            }
            // An oversized navigation does not erase a useful small marker.
          }
        } catch { stats.cacheFailures++; if (entries.get(key) === slot) remove(key); }
        return navigation;
      })();
      try { return await target.navigationPending; }
      finally { target.navigationPending = null; }
    },
    clear() { epoch++; entries.clear(); bytes = 0; },
    stats: () => ({ ...stats, entries: entries.size, bytes, maxEntries, maxBytes,
      markers: [...entries.values()].filter(slot => slot.record?.admission === 'oversized').length,
      preparedEntries: [...entries.values()].filter(slot => slot.record?.admission === 'prepared').length,
      navigationEntries: [...entries.values()].filter(slot => !!slot.record?.navigation).length }),
  };
}
