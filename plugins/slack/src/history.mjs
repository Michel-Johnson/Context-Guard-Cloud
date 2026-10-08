const timestamp = value => typeof value === 'string' && value.length <= 40 && /^\d+\.\d+$/.test(value);
const unavailable = transient => Object.assign(new Error('Slack history is unavailable within its bounded scope'), { code: 'HISTORY_UNAVAILABLE', ...(transient ? { historyTransient: true } : {}) });

// Reused by the six-item classifier and the first-binding reference snapshot.
// Both share one bounded native read, not independent pagination budgets.
export async function readSlackHistory(io, event, { limit = 24, width = 1000, accept = () => true } = {}) {
  if (!timestamp(event.ts) || !/^[CGD][A-Z0-9]{1,79}$/.test(event.channel || '') ||
      event.thread_ts !== undefined && !timestamp(event.thread_ts) || !Number.isInteger(limit) || limit < 1 || limit > 24 ||
      !Number.isInteger(width) || width < 1 || width > 1000) throw unavailable();
  const messages = new Map(), cursors = new Set(); let cursor;
  try {
    for (let page = 0; page < 4; page++) {
      const reply = await io.call(event.thread_ts ? 'conversations.replies' : 'conversations.history', {
        channel: event.channel, ...(event.thread_ts ? { ts: event.thread_ts } : {}), latest: event.ts, inclusive: false, limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!reply || !Array.isArray(reply.messages)) throw unavailable();
      for (const message of reply.messages) {
        if (message.channel && message.channel !== event.channel) throw unavailable();
        if (!timestamp(message.ts) || Number(message.ts) >= Number(event.ts) || typeof message.text !== 'string' || !message.text) continue;
        if (event.thread_ts && (Number(message.ts) < Number(event.thread_ts) || message.thread_ts && message.thread_ts !== event.thread_ts) ||
            !event.thread_ts && message.thread_ts && message.thread_ts !== message.ts) continue;
        if (!accept(message)) continue;
        const record = { ts: message.ts, speaker: String(message.user || message.bot_id || 'unknown').slice(0, 80), text: message.text.slice(0, width) };
        const previous = messages.get(message.ts);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw unavailable();
        messages.set(message.ts, record);
      }
      const recent = [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-limit);
      messages.clear(); for (const record of recent) messages.set(record.ts, record);
      const next = reply.response_metadata?.next_cursor;
      if (!reply.has_more && !next) return recent;
      if (typeof next !== 'string' || !next || cursors.has(next)) throw unavailable();
      cursors.add(next); cursor = next;
    }
  } catch (error) {
    if (error.code === 'HISTORY_UNAVAILABLE') throw error;
    throw unavailable(error instanceof TypeError || error.name === 'TimeoutError' ||
      ['slack_webapi_http_error', 'slack_webapi_rate_limited_error', 'slack_webapi_request_error'].includes(error.code));
  }
  throw unavailable();
}
