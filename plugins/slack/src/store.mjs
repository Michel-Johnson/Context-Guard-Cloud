import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { activeMentions } from './mentions.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const threadKey = (team, channel, ts) => `${team}:${channel}:${ts}`;
export function routedThreadKey(state, team, event) {
  let key = threadKey(team, event.channel, event.thread_ts || event.ts);
  const visited = new Set();
  for (;;) {
    if (visited.has(key)) throw Object.assign(new Error('项目切换路径出现循环'), { code: 'CONFLICT' });
    visited.add(key);
    const route = state.projectRoutes?.[digest([key, event.user])];
    if (!route || Number(event.ts) <= Number(route.afterTs)) return key;
    const target = state.threads[key = route.targetKey];
    if (!target || target.channel !== event.channel || target.userId !== event.user ||
        !event.channel?.startsWith('D') && target.threadTs !== (event.thread_ts || event.ts)) {
      throw Object.assign(new Error('项目切换记录与当前用户或线程不一致'), { code: 'CONFLICT' });
    }
  }
}
const empty = () => ({ version: 1, inbox: {}, threads: {}, channels: {}, preferences: {}, drafts: {}, outgoing: {} });
const durableThread = ({ nextPoll, nextItemPoll, ...thread }) => thread;

// A single process owns this file. Every acknowledgement follows a file fsync
// and atomic rename; Unix also flushes the directory before acknowledging.
export class Store {
  constructor(directory, { onCommit = null } = {}) {
    if (onCommit !== null && typeof onCommit !== 'function') throw new TypeError('Commit observer must be a function');
    this.directory = directory; this.file = path.join(directory, 'state.json'); this.tail = Promise.resolve(); this.onCommit = onCommit;
  }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = empty(); }
    if (this.data.version !== 1) throw new Error('Unsupported Slack state version');
    return this;
  }
  async update(operation) {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.data), result = await operation(next);
      // A replay may inspect an existing durable receipt without changing it.
      if (!isDeepStrictEqual(this.data, next)) await this.#publish(next, 'global');
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  updateThread(key, operation) {
    return this.#updateRecord('threads', key, operation, durableThread);
  }
  updateFeedback(id, operation) {
    return this.#updateRecord('feedback', id, operation);
  }
  updateReaction(id, operation) {
    return this.#updateRecord('reactionOutbox', id, operation);
  }
  async #updateRecord(collection, key, operation, durable = null) {
    const run = this.tail.then(async () => {
      const previous = this.data[collection]?.[key];
      if (!previous) return;
      const record = structuredClone(previous), result = await operation(record, this.data);
      if (isDeepStrictEqual(previous, record)) return result;
      const next = { ...this.data, [collection]: { ...this.data[collection], [key]: record } };
      // Poll deadlines alone are volatile; restart can only advance a read.
      // Every identity, status, input, mirror or receipt change remains durable.
      if (durable && isDeepStrictEqual(durable(previous), durable(record))) this.data = next;
      else await this.#publish(next, collection);
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async #publish(next, kind) {
    const started = performance.now(), payload = JSON.stringify(next);
    const temporary = path.join(this.directory, `.state-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, this.file);
    // Windows does not support directory fsync. File fsync remains mandatory.
    if (process.platform !== 'win32') {
      const directory = await fs.open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    this.data = next;
    // 诊断只包含固定更新类型、字节数和耗时；失败不能改变耐久回执。
    if (this.onCommit) try {
      void Promise.resolve(this.onCommit(Object.freeze({ kind, bytes: Buffer.byteLength(payload), elapsedMs: Math.round(performance.now() - started) }))).catch(() => {});
    } catch { /* An observer is not part of the commit or acknowledgement. */ }
  }
  async receive(id, envelope, { collectMs = 800, maxCollectMs = 2000, feedback = null } = {}) {
    return this.update(state => {
      if (state.inbox[id]) return false;
      state.inbox[id] = { envelope, status: 'pending', attempts: 0, at: Date.now(), next: 0 };
      if (feedback) {
        // 接收原消息与其反馈意图共用同一 fsync/原子替换，不留下崩溃窗口。
        (state.feedback ||= {})[id] = { ...feedback, desired: 'received', revision: 0, inputRevision: -1, controlRevision: -1,
          receivedAt: state.inbox[id].at, savedAt: Date.now(), applied: {}, receipts: [], pending: null };
      }
      const event = envelope.type === 'events_api' && envelope.body?.event;
      if (event && ['message', 'app_mention'].includes(event.type) && !event.bot_id && !event.bot_profile && !event.hidden && (!event.subtype || event.subtype === 'file_share')) {
        const now = Date.now(), direct = event.channel_type === 'im' || event.channel?.startsWith('D');
        const projectId = direct ? state.preferences[event.user] : state.threads[routedThreadKey(state, envelope.body.team_id, event)]?.projectId || state.channels[event.channel];
        // Freeze the project and receiver set into the collection lane. Different
        // people and receiver sets never borrow each other's authorization.
        const contextLane = digest([envelope.body.team_id, event.channel, event.user, projectId || null, event.thread_ts || null]);
        const mentions = direct ? [] : activeMentions(event.text).sort();
        let lane = digest([contextLane, mentions]);
        state.messageBatches ||= {}; state.topConversations ||= {};
        if (!mentions.length && !direct) {
          const candidates = Object.values(state.messageBatches).filter(item => item.contextLane === contextLane && item.deadline > now);
          const lanes = [...new Set(candidates.map(item => item.lane))];
          if (lanes.length === 1) lane = lanes[0];
        }
        let batch = Object.values(state.messageBatches).find(item => item.lane === lane && !item.frozen && item.deadline > now && item.ids.length < 20 &&
          item.ids.reduce((size, inputId) => size + String(state.inbox[inputId].envelope.body.event.text || '').length + 2, String(event.text || '').length) <= 8000 &&
          item.ids.reduce((count, inputId) => count + (state.inbox[inputId].envelope.body.event.files || []).length, (event.files || []).length) <= 6 &&
          new Set([...activeMentions(event.text), ...item.ids.flatMap(inputId => activeMentions(state.inbox[inputId].envelope.body.event.text))]).size <= 8);
        if (!batch) {
          const recent = !direct && !event.thread_ts && state.topConversations[lane];
          const rootTs = event.thread_ts || (recent?.until > now ? recent.rootTs : event.ts);
          const deadline = recent?.until > now ? recent.until : now + maxCollectMs;
          batch = state.messageBatches[id] = { lane, contextLane, rootTs, projectId: projectId || null, ids: [], firstAt: now, deadline, readyAt: Math.min(deadline, now + collectMs) };
          if (!direct && !event.thread_ts) state.topConversations[lane] = { rootTs, until: deadline };
        }
        batch.ids.push(id); batch.readyAt = Math.min(batch.deadline, now + collectMs);
        state.inbox[id].batchId = batch.ids[0];
      }
      return true;
    });
  }
  async bind(key, binding) {
    return this.update(state => {
      const prior = state.threads[key];
      if (prior && (prior.projectId !== binding.projectId || prior.conversationId !== binding.conversationId)) throw new Error('Thread binding is immutable');
      state.threads[key] = prior || { ...binding, mirrored: {}, cursor: null, at: Date.now() };
      return state.threads[key];
    });
  }
}
