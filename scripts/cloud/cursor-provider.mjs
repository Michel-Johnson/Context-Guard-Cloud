// Official Cursor Cloud Agents REST v1. Cursor owns the execution environment
// and agent loop; Context Guard owns authorization and the Session binding.
const fail = (code, message, uncertain = false) => { throw Object.assign(new Error(message), { code, ...(uncertain ? { deliveryUncertain: true } : {}) }); };
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) fail('INVALID_CURSOR_ID', 'Use the exact saved Cursor identifier');
  return encodeURIComponent(value);
};
const prompt = text => {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) fail('INVALID_PROMPT', 'Use a nonempty bounded prompt');
  return { text };
};
const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
export const cursorRunTerminal = run => terminal.has(run?.status);
export function validateCursorSource({ repositoryUrl, startingRef, model } = {}) {
  if (typeof repositoryUrl !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repositoryUrl) ||
      typeof startingRef !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(startingRef) ||
      model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) fail('INVALID_CURSOR_CREATE', 'Pin an approved repository and commit');
}

export class CursorCloudProvider {
  constructor({ apiKey, endpoint = 'https://api.cursor.com', allowLoopback = false, timeoutMs = 30000 } = {}) {
    const origin = new URL(endpoint);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        origin.origin !== 'https://api.cursor.com' && !(allowLoopback === true && origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) ||
        typeof apiKey !== 'string' || !apiKey || apiKey.length > 8192 || /[\r\n]/.test(apiKey) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) fail('INVALID_CURSOR_CONFIG', 'Use a private API key and the official Cursor origin');
    this.origin = origin.origin;
    this.authorization = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    this.timeoutMs = timeoutMs;
  }

  async request(route, { method = 'GET', body } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader;
    try {
      const response = await fetch(this.origin + route, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: this.authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 401 || response.status === 403 ? 'CURSOR_AUTH_REQUIRED'
          : response.status === 409 ? 'CURSOR_CONFLICT' : response.status === 429 ? 'CURSOR_RATE_LIMITED'
            : response.status === 404 ? 'CURSOR_NOT_FOUND' : response.status === 410 ? 'CURSOR_STREAM_EXPIRED' : 'CURSOR_HTTP_ERROR';
        fail(code, `Cursor API returned HTTP ${response.status}`, method !== 'GET' && response.status >= 500);
      }
      reader = response.body?.getReader();
      if (!reader) fail('CURSOR_PROTOCOL_ERROR', 'Cursor API returned an empty body', method !== 'GET');
      let bytes = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8 * 1024 * 1024) fail('CURSOR_OUTPUT_LIMIT', 'Cursor API response exceeds the limit', method !== 'GET');
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail('CURSOR_PROTOCOL_ERROR', 'Cursor API returned invalid JSON', method !== 'GET'); }
    } catch (cause) {
      if (typeof cause.code === 'string' && cause.code.startsWith('CURSOR_')) throw cause;
      fail(controller.signal.aborted ? 'CURSOR_TIMEOUT' : 'CURSOR_TRANSPORT_ERROR', 'Cursor API transport did not confirm the response', method !== 'GET');
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }

  verifyRun(run, agentId, runId) {
    if (!run || run.agentId !== agentId || runId && run.id !== runId || typeof run.status !== 'string' || run.result !== undefined && run.result !== null && typeof run.result !== 'string') fail('CURSOR_RUN_MISMATCH', 'Cursor returned another Agent or Run');
    id(run.id);
    return run; // Unknown future statuses stay raw; never treated as successful.
  }
  async checkConnection() {
    const result = await this.request('/v1/me');
    return { connected: true, identity: result }; // Do not log the private identity.
  }
  async create({ agentId, repositoryUrl, startingRef, text, name, model } = {}) {
    validateCursorSource({ repositoryUrl, startingRef, model });
    if (!/^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId || '') ||
        name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 100)) fail('INVALID_CURSOR_CREATE', 'Pin an approved repository, commit and client Agent ID');
    const result = await this.request('/v1/agents', { method: 'POST', body: {
      agentId, prompt: prompt(text), repos: [{ url: repositoryUrl, startingRef }], env: { type: 'cloud' },
      workOnCurrentBranch: false, autoCreatePR: false, mode: 'agent',
      ...(name ? { name } : {}), ...(model ? { model: { id: model } } : {}),
    } });
    if (result?.agent?.id !== agentId) fail('CURSOR_AGENT_MISMATCH', 'Cursor did not confirm the requested Agent', true);
    try { this.verifyRun(result.run, agentId); }
    catch { fail('CURSOR_RUN_MISMATCH', 'Cursor did not confirm the initial Run', true); }
    return result;
  }
  async followUp(agentId, text) {
    const result = await this.request(`/v1/agents/${id(agentId)}/runs`, { method: 'POST', body: { prompt: prompt(text) } });
    try { this.verifyRun(result.run, agentId); }
    catch { fail('CURSOR_RUN_MISMATCH', 'Cursor did not confirm the follow-up Run', true); }
    return result.run;
  }
  async getRun(agentId, runId) {
    return this.verifyRun(await this.request(`/v1/agents/${id(agentId)}/runs/${id(runId)}`), agentId, runId);
  }
  async getAgent(agentId) {
    const result = await this.request(`/v1/agents/${id(agentId)}`);
    if (result?.id !== agentId) fail('CURSOR_AGENT_MISMATCH', 'Cursor returned another Agent');
    return result;
  }
  cancel(agentId, runId) { return this.request(`/v1/agents/${id(agentId)}/runs/${id(runId)}/cancel`, { method: 'POST', body: {} }); }
}
