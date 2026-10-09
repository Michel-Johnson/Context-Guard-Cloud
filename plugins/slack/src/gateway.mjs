export class GatewayError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
export class Gateway {
  constructor({ url, token, teamId, fetchImpl = fetch, streamIdleMs = 25000 }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)) throw new Error('Plugin gateway must be loopback HTTP');
    this.url = parsed.origin; this.token = token; this.teamId = teamId; this.fetch = fetchImpl;
    if (!Number.isSafeInteger(streamIdleMs) || streamIdleMs <= 0) throw new Error('Event idle timeout must be a positive integer');
    this.streamIdleMs = streamIdleMs;
  }
  async command(type, { id, userId, projectId, conversationId, payload = {}, timeoutMs = 20000 }) {
    if (!id || !userId) throw new Error('Stable operation ID and real Slack user are required');
    const response = await this.fetch(`${this.url}/v1/command`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, teamId: this.teamId, userId, ...(projectId ? { projectId } : {}), ...(conversationId ? { conversationId } : {}), type, payload }) });
    let body;
    try { body = await response.json(); }
    catch { throw new GatewayError('GATEWAY_BAD_RESPONSE', 'Gateway returned invalid JSON', response.status); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
      throw new GatewayError('GATEWAY_BAD_RESPONSE', 'Gateway returned an invalid response envelope', response.status);
    }
    if (!response.ok || !body.ok) throw new GatewayError(body.error?.code || 'GATEWAY_ERROR', body.error?.message || 'Gateway unavailable', response.status);
    return body.data;
  }
  async *events({ userId, projectId, conversationId, signal }) {
    if (!userId || !projectId || !conversationId) throw new Error('A scoped linked conversation is required');
    const controller = new AbortController();
    const interrupted = () => controller.signal.reason || new DOMException('Event subscription interrupted', 'AbortError');
    const checkActive = () => { if (controller.signal.aborted) throw interrupted(); };
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer, reader;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new GatewayError('GATEWAY_STREAM_IDLE', 'Event subscription stopped receiving data')), this.streamIdleMs);
      timer.unref?.();
    };
    refresh();
    try {
      checkActive();
      const query = new URLSearchParams({ teamId: this.teamId, userId, projectId, conversationId });
      const response = await this.fetch(`${this.url}/v1/events?${query}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal,
      });
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!response.ok || mediaType !== 'text/event-stream' || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new GatewayError('GATEWAY_STREAM', 'Event subscription is unavailable', response.status);
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const limit = 8 * 1024 * 1024;
      let buffer = '';
      const read = async () => {
        checkActive();
        let abort;
        try {
          return await Promise.race([reader.read(), new Promise((_, reject) => {
            abort = () => reject(interrupted());
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          })]);
        } finally { controller.signal.removeEventListener('abort', abort); }
      };
      while (true) {
        const { value, done } = await read();
        if (done) break;
        refresh();
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          checkActive();
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame) > limit) throw new GatewayError('GATEWAY_EVENT_TOO_LARGE', 'Event frame exceeds the size limit');
          const lines = frame.split(/\r?\n/);
          if (lines.find(line => line.startsWith('event:'))?.slice(6).trim() !== 'state') continue;
          let message;
          try { message = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')); }
          catch { throw new GatewayError('GATEWAY_EVENT_INVALID', 'Event frame is invalid'); }
          if (message?.type !== 'state' || !message.data || typeof message.data !== 'object' || Array.isArray(message.data) || message.data.conversationId !== conversationId) {
            throw new GatewayError('GATEWAY_EVENT_INVALID', 'Event does not belong to the linked conversation');
          }
          yield message.data;
        }
        if (Buffer.byteLength(buffer) > limit) throw new GatewayError('GATEWAY_EVENT_TOO_LARGE', 'Event frame exceeds the size limit');
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new GatewayError('GATEWAY_EVENT_INVALID', 'Event stream ended with an incomplete frame');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // 已中断的 fetch 在部分 Node 版本仍可能卡住读取或取消；清理不能拖住插件停机。
      try { void reader?.cancel().catch(() => {}); } catch {}
      reader?.releaseLock();
    }
  }
}
