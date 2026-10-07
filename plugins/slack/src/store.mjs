import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activeMentions } from './mentions.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const threadKey = (team, channel, ts) => `${team}:${channel}:${ts}`;
const empty = () => ({ version: 1, inbox: {}, threads: {}, channels: {}, preferences: {}, drafts: {}, outgoing: {} });

// A single process owns this file. Every acknowledgement follows a file fsync
// and atomic rename; Unix also flushes the directory before acknowledging.
export class Store {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); this.tail = Promise.resolve(); }
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
      const temporary = path.join(this.directory, `.state-${randomUUID()}`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      // Windows does not support directory fsync. File fsync remains mandatory.
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.data = next;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async receive(id, envelope, { collectMs = 800, maxCollectMs = 2000 } = {}) {
    return this.update(state => {
      if (state.inbox[id]) return false;
      state.inbox[id] = { envelope, status: 'pending', attempts: 0, at: Date.now(), next: 0 };
      const event = envelope.type === 'events_api' && envelope.body?.event;
      if (event && ['message', 'app_mention'].includes(event.type) && !event.bot_id && !event.bot_profile && !event.hidden && (!event.subtype || event.subtype === 'file_share')) {
        const now = Date.now(), direct = event.channel_type === 'im' || event.channel?.startsWith('D');
        const projectId = direct ? state.preferences[event.user] : state.threads[threadKey(envelope.body.team_id, event.channel, event.thread_ts || event.ts)]?.projectId || state.channels[event.channel];
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
