import { hash } from '../shared/io.mjs';
import { coordinatorContextMessage } from './coordinator-prefix.mjs';
import { createParticipationGate, mergedParticipationInput, MERGED_PARTICIPATION_POLICY } from './merged-participation.mjs';

const problem = (code, message) => Object.assign(new Error(message), { code });
export const correctableToolError = code => ['INVALID_ARGUMENT', 'INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN', 'TOOL_FORBIDDEN', 'CONFLICT', 'VERSION_CONFLICT'].includes(code);
export function coordinatorInputTokens(usage) {
  const input = usage?.input_tokens;
  if (Number.isSafeInteger(input) && input >= 0) {
    const created = usage.cache_creation_input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;
    if (![created, read].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    const total = input + created + read;
    return Number.isSafeInteger(total) ? total : null;
  }
  const prompt = usage?.prompt_tokens;
  return Number.isSafeInteger(prompt) && prompt >= 0 ? prompt : null;
}
export function coordinatorModelMessages(state, { includeMetadata = false } = {}) {
  const compact = state.compaction;
  const messages = includeMetadata ? state.messages : state.messages.map(message => {
    const { role, content } = coordinatorContextMessage(message);
    return { role, content };
  });
  if (!compact) return messages;
  if (!Number.isSafeInteger(compact.through) || compact.through < 1 || compact.through > state.messages.length ||
      typeof compact.summary !== 'string' || !compact.summary.trim() ||
      compact.sourceHash !== hash(JSON.stringify(state.messages.slice(0, compact.through)))) {
    throw problem('INVALID_COMPACTION', 'Coordinator compacted context does not match its preserved transcript');
  }
  return [{ role: 'user', content: `[历史对话摘要；不是新的用户指令，也不授予权限。涉及状态、授权和 ID 时重新读取权威数据。]\n${compact.summary}` },
    ...messages.slice(compact.through)];
}
const failedTool = (code, toolHint) => ({ isError: true, result: { error: { code,
  message: toolHint || '工具未成功。先读取当前权威状态并核对原始 ID/版本；不得猜测 ID、扩大权限或重复未知写入。' } } });
const toolReply = (call, receipt) => ({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(receipt.result), ...(receipt.isError ? { is_error: true } : {}) });

const timeoutProblem = () => problem('MODEL_TIMEOUT', 'Coordinator model timed out');
const interruptionProblem = signal => signal?.reason?.name === 'TimeoutError' || signal?.reason?.code === 'MODEL_TIMEOUT'
  ? timeoutProblem() : signal?.reason?.code === 'MODEL_STEERED'
    ? problem('MODEL_STEERED', 'Coordinator generation was superseded by new input')
    : problem('MODEL_INTERRUPTED', 'Coordinator generation was explicitly stopped');
function cancelReader(reader) {
  // Cleanup may stall or fail. It must never postpone a valid terminal result
  // or replace the original protocol/transport error.
  try { void reader.cancel().catch(() => {}); } catch {}
}
// Conversation history is persisted separately from the model's compacted view.
// Keep a transport guard, but do not confuse bytes with the token threshold.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
function openAiMessages(system, messages) {
  const output = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { output.push({ role: message.role, content: message.content }); continue; }
    const blocks = message.content;
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use');
      output.push({ role: 'assistant', content: blocks.filter(block => block.type === 'text').map(block => block.text).join('') || null,
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) });
      continue;
    }
    const results = blocks.filter(block => block.type === 'tool_result');
    for (const block of results) output.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
    const content = blocks.filter(block => ['text', 'image'].includes(block.type)).map(block => block.type === 'text' ? block :
      { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
    if (content.length) output.push({ role: 'user', content });
  }
  return output;
}
function openAiResult(value, model) {
  const choice = value.choices?.[0], message = choice?.message;
  if (!message || !['stop', 'tool_calls'].includes(choice.finish_reason) || value.model !== model) {
    throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned a different model or an incomplete turn');
  }
  const content = typeof message.content === 'string' && message.content ? [{ type: 'text', text: message.content }] : [];
  for (const call of message.tool_calls || []) {
    let input; try { input = JSON.parse(call.function?.arguments || ''); }
    catch { throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid tool input'); }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }
  return { model: value.model, content, usage: value.usage || {}, stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' };
}
async function readChunk(reader, deadlineAt, abort) {
  if (abort.signal.aborted) throw abort.signal.reason;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) { abort.abort(timeoutProblem()); throw timeoutProblem(); }
  let timer, cancel;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        cancel = () => { cancelReader(reader); reject(abort.signal.reason); };
        abort.signal.addEventListener('abort', cancel, { once: true });
      }),
      new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(timeoutProblem()); reject(timeoutProblem()); }, remaining); }),
    ]);
  } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); }
}

async function readBoundedJson(response, deadlineAt, abort) {
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, deadlineAt, abort);
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { cancelReader(reader); throw problem('MODEL_RESPONSE_TOO_LARGE', 'Coordinator response exceeds 4 MiB'); }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid JSON'); }
}

function validatePrivateBlock(block) {
  if (block?.type === 'thinking' && ['thinking', 'signature'].some(field =>
    block[field] !== undefined && typeof block[field] !== 'string')) {
    throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid private stream data');
  }
}

async function readEventStream(response, onText, onToolStart, deadlineAt, abort) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', size = 0, model = '', stopReason = '', usage = {}, visibleText = '';
  const blocks = [], openBlocks = new Set();
  let started = false, terminal = false;
  const invalidStream = () => problem('MODEL_INVALID_RESPONSE', 'Coordinator returned an incomplete or invalid event stream');
  const checkActive = () => {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (Date.now() >= deadlineAt) { abort.abort(timeoutProblem()); throw abort.signal.reason; }
  };
  const event = async source => {
    checkActive();
    const data = source.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value; try { value = JSON.parse(data); } catch { throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid event data'); }
    if (value.type === 'error') throw problem('MODEL_UNAVAILABLE', 'Coordinator provider returned a stream error');
    if (value.type === 'message_start') {
      if (started) throw invalidStream();
      started = true; model = value.message?.model || ''; usage = value.message?.usage || {};
    }
    if (value.type === 'content_block_start') {
      if (!started || !Number.isSafeInteger(value.index) || value.index !== blocks.length) throw invalidStream();
      openBlocks.add(value.index);
      const block = value.content_block || {};
      validatePrivateBlock(block);
      blocks[value.index] = block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: block.input || {}, _json: '' }
        : block.type === 'text' ? { type: 'text', text: block.text || '' } : { ...block };
      if (block.type === 'tool_use') await onToolStart?.(block.name);
      if (block.type === 'text' && block.text) { visibleText += block.text; await onText?.(visibleText); }
    }
    if (value.type === 'content_block_delta') {
      if (!openBlocks.has(value.index)) throw invalidStream();
      const block = blocks[value.index], delta = value.delta || {};
      if (block?.type === 'text' && delta.type === 'text_delta') { block.text += delta.text || ''; visibleText += delta.text || ''; await onText?.(visibleText); }
      if (block?.type === 'tool_use' && delta.type === 'input_json_delta') block._json += delta.partial_json || '';
      // Thinking is private provider history, not visible streaming text. Keep
      // both opaque signature and exact content for subsequent native tool
      // rounds; dropping deltas silently corrupts the accepted assistant turn.
      if (['thinking_delta', 'signature_delta'].includes(delta.type)) {
        const field = delta.type === 'thinking_delta' ? 'thinking' : 'signature';
        if (block?.type !== 'thinking' || typeof delta[field] !== 'string' ||
            block[field] !== undefined && typeof block[field] !== 'string') {
          throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid private stream data');
        }
        block[field] = (block[field] || '') + delta[field];
      }
    }
    if (value.type === 'content_block_stop') {
      if (!openBlocks.has(value.index)) throw invalidStream();
      const block = blocks[value.index];
      if (block?.type === 'tool_use' && block._json) {
        try { block.input = JSON.parse(block._json); } catch { throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid tool input'); }
      }
      if (block) delete block._json;
      openBlocks.delete(value.index);
    }
    if (value.type === 'message_delta') {
      if (!started) throw invalidStream();
      stopReason = value.delta?.stop_reason || stopReason; usage = { ...usage, ...(value.usage || {}) };
    }
    if (value.type === 'message_stop') {
      if (!started || openBlocks.size || !['end_turn', 'tool_use'].includes(stopReason)) throw invalidStream();
      terminal = true;
    }
  };
  try {
    while (!terminal) {
      const { done, value } = await readChunk(reader, deadlineAt, abort);
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw problem('MODEL_RESPONSE_TOO_LARGE', 'Coordinator response exceeds 4 MiB');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while (!terminal && (boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, boundary), match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(boundary + match[0].length); await event(raw);
      }
    }
    if (!terminal) {
      buffer += decoder.decode(); if (buffer.trim()) await event(buffer);
    }
    if (!terminal) throw invalidStream();
    checkActive();
  } finally { cancelReader(reader); try { reader.releaseLock(); } catch {} }
  return { model, stop_reason: stopReason, content: blocks.filter(Boolean), usage };
}

// A human can correct a definitively rejected call. Successful preceding tools
// retain their receipts; unexecuted following tools are not silently invoked.
export function settleRejectedTools(state) {
  if (state.error?.code === 'STEP_LIMIT' && !state.pending) return true;
  if (!correctableToolError(state.error?.code) || state.pending?.stop !== 'tool_use') return false;
  let first = true;
  const responses = state.pending.content.filter(block => block.type === 'tool_use').map(call => {
    const id = `coordinator:${hash(`${state.activeTurnId}:${call.id}`)}`;
    const fingerprint = hash(JSON.stringify({ name: call.name, input: call.input }));
    let receipt = state.toolReceipts[id];
    if (receipt && receipt.fingerprint !== fingerprint) throw problem('TOOL_ID_REUSED', 'Tool receipt differs');
    if (!receipt) {
      receipt = state.toolReceipts[id] = { fingerprint, ...failedTool(first ? state.error.code : 'NOT_EXECUTED') };
      first = false;
    }
    return toolReply(call, receipt);
  });
  state.messages.push({ role: 'user', content: responses }); state.pending = null;
  return true;
}

// Provider transport only. Project authorization and workflow decisions belong
// to the server's existing protocol, never to model-supplied role fields.
export class CoordinatorModel {
  #token;
  constructor({ baseUrl, model, token, timeoutMs = 90000, maxTokens = 1024, thinking = null, supportsImages = false, protocol = 'anthropic', fetch: fetchImpl = fetch }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw problem('INVALID_PROVIDER', 'Coordinator requires a configured HTTPS provider');
    if (!model || !token) throw problem('INVALID_PROVIDER', 'Coordinator model and credential are required');
    if (!['anthropic', 'openai'].includes(protocol)) throw problem('INVALID_PROVIDER', 'Unknown Coordinator provider protocol');
    if (thinking !== null && (!thinking || !['enabled', 'disabled'].includes(thinking.type) || Object.keys(thinking).some(key => key !== 'type'))) {
      throw problem('INVALID_PROVIDER', 'Coordinator thinking mode must be enabled or disabled');
    }
    const providerRoot = url.href.replace(/\/$/, '');
    this.endpoint = new URL(protocol === 'openai' ? `${providerRoot}/chat/completions` : `${providerRoot}/v1/messages`);
    this.model = model; this.#token = token; this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens; this.thinking = thinking ? { type: thinking.type } : null; this.fetch = fetchImpl;
    this.supportsImages = supportsImages; this.protocol = protocol;
  }

  prepareRequest({ system, messages, tools = [], maxTokens = this.maxTokens }) {
    for (const message of messages) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type !== 'image') continue;
      if (!this.supportsImages) throw problem('MODEL_IMAGE_UNSUPPORTED', 'This Coordinator provider is not configured for image input');
      if (block.source?.type !== 'base64' || !['image/png', 'image/jpeg', 'image/webp'].includes(block.source.media_type) ||
          typeof block.source.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.source.data)) {
        throw problem('INVALID_IMAGE', 'Coordinator image input is invalid');
      }
    }
    const body = JSON.stringify(this.protocol === 'openai' ? {
      model: this.model, max_tokens: maxTokens, messages: openAiMessages(system, messages), stream: false,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}),
    } : { model: this.model, max_tokens: maxTokens, system, messages: messages.map(({ role, content }) => ({ role, content })),
      stream: true, ...(this.thinking ? { thinking: this.thinking } : {}), ...(tools.length ? { tools } : {}) });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw problem('CONTEXT_TOO_LARGE', 'Coordinator request exceeds the transport safety limit');
    return body;
  }

  async next({ system, messages, tools = [], maxTokens = this.maxTokens, onText = null, onToolStart = null, signal = null }) {
    const body = this.prepareRequest({ system, messages, tools, maxTokens });
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const deadlineAt = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => abort.abort(timeoutProblem()), this.timeoutMs);
    let phase = 'fetch';
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body,
      });
      if (!response.ok) {
        phase = 'http';
        cancelReader(response.body);
        // Provider error bodies may echo credentials or private prompt data.
        throw problem(`MODEL_HTTP_${response.status}`, `Coordinator provider returned HTTP ${response.status}`);
      }
      phase = this.protocol !== 'openai' && (response.headers.get('content-type') || '').includes('text/event-stream') ? 'response-stream' : 'response-json';
      const result = this.protocol === 'openai' ? openAiResult(await readBoundedJson(response, deadlineAt, abort), this.model)
        : (response.headers.get('content-type') || '').includes('text/event-stream')
          ? await readEventStream(response, onText, onToolStart, deadlineAt, abort) : await readBoundedJson(response, deadlineAt, abort);
      if (this.protocol === 'openai') {
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text) await onText?.(text);
        for (const call of result.content.filter(block => block.type === 'tool_use')) await onToolStart?.(call.name);
      }
      phase = 'response-validation';
      if (result.model !== this.model || !Array.isArray(result.content) || !['end_turn', 'tool_use'].includes(result.stop_reason)) {
        throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned a different model or an incomplete turn');
      }
      for (const block of result.content) validatePrivateBlock(block);
      const calls = result.content.filter(block => block.type === 'tool_use');
      if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input))) {
        throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned malformed tool calls');
      }
      if ((result.stop_reason === 'tool_use') !== Boolean(calls.length)) throw problem('MODEL_INVALID_RESPONSE', 'Coordinator stop reason does not match its tool calls');
      return { content: result.content, stop: result.stop_reason, usage: result.usage || {}, model: result.model, requestId: response.headers.get('request-id') || '' };
    } catch (error) {
      const wasAborted = abort.signal.aborted;
      abort.abort();
      const failure = wasAborted ? interruptionProblem(abort.signal) : String(error.code || '').startsWith('MODEL_') || error.code === 'CONTEXT_TOO_LARGE'
        ? error : problem('MODEL_UNAVAILABLE', 'Coordinator model connection failed; no automatic retry was made');
      // Private metadata only: provider exception text and arbitrary codes are
      // never diagnostic data. Preserve the original outcome if metadata fails.
      try {
        const safeCodes = ['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'MODEL_INVALID_RESPONSE', 'MODEL_INTERRUPTED', 'MODEL_STEERED', 'MODEL_RESPONSE_TOO_LARGE', 'CONTEXT_TOO_LARGE'];
        const code = safeCodes.includes(failure.code) || /^MODEL_HTTP_[45]\d\d$/.test(failure.code || '') ? failure.code : 'UNKNOWN_MODEL_ERROR';
        const elapsed = Date.now() - (deadlineAt - this.timeoutMs);
        Object.defineProperty(failure, 'modelDiagnostic', { value: { code, phase,
          ...(Number.isSafeInteger(elapsed) && elapsed >= 0 ? { durationMs: elapsed } : {}) }, configurable: true });
      } catch {}
      throw failure;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
}

// Persist every assistant response and tool receipt through the caller. Stable
// operation IDs let protocol-backed tools replay a lost response idempotently.
export async function coordinatorStep({ turnId, state, model, system, promptVersion = hash(system), tools, save, execute, materializeMessages = null, onText = null, onToolStart = null, completePresentations = false, checkpoint = null, signal = null }) {
  if (state.promptVersion && state.promptVersion !== promptVersion) throw problem('PROMPT_CHANGED', 'Resume with the same Coordinator prompt version');
  state.promptVersion = promptVersion;
  state.messages ||= []; state.toolReceipts ||= {};
  // Source belongs to the accepted server input, never to message text or model
  // tool parameters. Other clients already have their own model settings UI.
  const sourceTools = tools.filter(tool => tool.name !== 'show_model_menu' || state.activeInput?.source === 'slack');
  const slackActor = state.activeInput?.actor;
  const trustedSlackInput = state.activeInput?.source === 'slack' && !!state.activeInput.id && slackActor?.kind === 'human' &&
    slackActor.integration === 'slack' && /^[UW][A-Z0-9]{1,31}$/.test(slackActor.userId || '') &&
    /^[TE][A-Z0-9]{1,31}$/.test(slackActor.teamId || '') && slackActor.sessionId === `slack:${slackActor.teamId}:${slackActor.userId}`;
  const projectTools = ['list_projects', 'switch_project'];
  const executableTools = sourceTools.filter(tool => (!['react_to_user', 'select_text_model', ...projectTools].includes(tool.name) || trustedSlackInput) &&
    (!projectTools.includes(tool.name) || /^D[A-Z0-9]{1,31}$/.test(slackActor?.channelId || '')));
  const modelTools = tools.filter(tool => !projectTools.includes(tool.name) || executableTools.includes(tool));
  // Private operator diagnostics only; public timing and transcript contracts
  // stay unchanged. No prompts, arguments, results or provider IDs are copied.
  if (state.activeTurnId && state.performance?.turnId !== state.activeTurnId) state.performance = {
    turnId: state.activeTurnId, models: [], tools: [],
  };
  if (!state.pending) {
    const messages = materializeMessages ? await materializeMessages(state) : coordinatorModelMessages(state);
    const participationInput = trustedSlackInput && mergedParticipationInput(state);
    const gateKey = participationInput?.requestId;
    const alreadyAllowed = gateKey && state.slackParticipation?.requestId === gateKey && state.slackParticipation.decision === 'reply';
    const needsGate = gateKey && !alreadyAllowed;
    const generationSystem = needsGate ? system + MERGED_PARTICIPATION_POLICY : alreadyAllowed
      ? system + '\n本轮已确认需要接话，直接继续正文和允许的工具，不再输出内部接话标识。' : system;
    const systemHash = hash(generationSystem), toolsHash = hash(JSON.stringify(modelTools));
    const measurement = state.performance && { startedAt: new Date().toISOString(), firstTextMs: null,
      prefix: { systemHash, toolsHash, envelopeHash: hash(JSON.stringify([systemHash, toolsHash])),
        historyHash: hash(JSON.stringify(messages)), messageCount: messages.length,
        ...(state.activeContext?.format === 2 ? { staticVersion: state.activeContext.staticVersion } : {}) } };
    const started = Date.now();
    const gate = needsGate || alreadyAllowed ? createParticipationGate(async text => {
      if (text && measurement && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
      await onText?.(text);
    }, { continuation: !!alreadyAllowed }) : null;
    let next;
    try {
      if (signal?.aborted) throw interruptionProblem(signal);
      next = await model.next({ system: generationSystem, messages, tools: modelTools, signal, onText: measurement ? async text => {
        if (signal?.aborted) return;
        if (!gate && text && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
        if (gate) await gate.consume(text); else await onText?.(text);
      } : gate ? text => gate.consume(text) : onText, onToolStart: async name => {
        gate?.toolStart(); await onToolStart?.(name);
      } });
      if (signal?.aborted) {
        // An adapter may finish despite cancellation. Preserve only visible text;
        // incomplete thinking signatures and tool blocks are never replayed.
        const cause = interruptionProblem(signal);
        cause.partialText = next.content?.filter(block => block.type === 'text').map(block => block.text).join('') || '';
        throw cause;
      }
      if (gate) {
        next = await gate.finish(next);
        state.slackParticipation = { requestId: gateKey, decision: gate.decision };
      }
      if (measurement) Object.assign(measurement, { durationMs: Date.now() - started,
        stop: next.stop, inputTokens: coordinatorInputTokens(next.usage),
        cacheReadTokens: Number.isSafeInteger(next.usage?.cache_read_input_tokens) && next.usage.cache_read_input_tokens >= 0 ? next.usage.cache_read_input_tokens
          : Number.isSafeInteger(next.usage?.prompt_tokens_details?.cached_tokens) && next.usage.prompt_tokens_details.cached_tokens >= 0
            ? next.usage.prompt_tokens_details.cached_tokens : null });
    } catch (cause) {
      if (gate && cause.partialText !== undefined) cause.partialText = gate.visible;
      if (measurement) Object.assign(measurement, { durationMs: Date.now() - started, errorCode: cause.code || 'MODEL_UNAVAILABLE' });
      throw cause;
    } finally {
      if (measurement) state.performance.models = [...state.performance.models, measurement].slice(-60);
    }
    if (next.content.some(block => ['image', 'image_url'].includes(block.type))) {
      throw problem('MODEL_INVALID_RESPONSE', 'Coordinator responses cannot persist raw image payloads');
    }
    const inputTokens = coordinatorInputTokens(next.usage);
    if (inputTokens !== null) state.lastInputTokens = inputTokens;
    if (next.content.some(block => block.type === 'tool_use' && block.name === 'ask_user')) await onToolStart?.('ask_user');
    if (gate?.decision === 'silent') {
      const changed = checkpoint ? await checkpoint() : { steered: false, interrupted: false };
      state.pending = null;
      state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' : 'waiting-for-user';
      await save(state); return state;
    }
    const metadata = state.activeInput || {};
    state.messages.push({ role: 'assistant', content: next.content,
      ...(state.activeModelRoute?.providerId ? { providerId: state.activeModelRoute.providerId } : {}),
      ...(state.activeModelRoute?.model ? { modelName: next.model || state.activeModelRoute.model } : {}),
      ...(metadata.id ? { requestId: metadata.id, id: `message-${hash(`${metadata.id}:assistant:${state.messages.length}`)}` } : {}),
      ...(metadata.source ? { source: metadata.source } : {}), ...(metadata.actor ? { actor: metadata.actor } : {}) });
    state.pending = next;
    await save(state);
  }
  const next = state.pending;
  let changed = checkpoint ? await checkpoint() : { steered: false, interrupted: false };
  if (changed.steered || changed.interrupted) state.messages.at(-1).superseded = true;
  if (next.stop === 'end_turn') {
    state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' : 'waiting-for-user'; state.pending = null;
    await save(state);
    return state;
  }
  const responses = []; let failed = false, transferred = false;
  const visible = [];
  for (const call of next.content.filter(block => block.type === 'tool_use')) {
    changed = checkpoint ? await checkpoint() : changed;
    const operationId = `coordinator:${hash(`${turnId}:${call.id}`)}`;
    const fingerprint = hash(JSON.stringify({ name: call.name, input: call.input }));
    let receipt = state.toolReceipts[operationId];
    if (receipt && receipt.fingerprint !== fingerprint) throw problem('TOOL_ID_REUSED', 'Coordinator reused a tool identifier with different input');
    if (!receipt) {
      if (changed.steered || changed.interrupted) receipt = { fingerprint, ...failedTool(changed.interrupted ? 'TURN_INTERRUPTED' : 'INPUT_SUPERSEDED') };
      else if (failed || transferred) receipt = { fingerprint, ...failedTool('NOT_EXECUTED') };
      else if (!executableTools.some(tool => tool.name === call.name)) receipt = { fingerprint,
        ...failedTool('TOOL_FORBIDDEN', '工具名未注册；只能使用本轮提供的工具，不得猜测接口。') };
      else {
        const started = Date.now();
        let errorCode = null;
        try {
          // Model settings use the integration's identifier alphabet, while
          // the original native tool receipt keeps its unchanged identity.
          const result = await execute(call.name, call.input, { operationId: call.name === 'select_text_model' ? `model-${hash(operationId)}` : operationId,
            ...(['select_text_model', ...projectTools].includes(call.name) && trustedSlackInput ? { source: 'slack', actor: slackActor,
              ...(projectTools.includes(call.name) ? { requestId: state.activeInput.id } : {}) } : {}) });
          receipt = { fingerprint, result: call.name === 'react_to_user' && trustedSlackInput && result?.kind === 'slack-reaction'
            ? { ...result, requestId: state.activeInput.id, actor: slackActor } : result };
        }
        catch (error) {
          errorCode = error.code || 'TOOL_FAILED';
          if (!correctableToolError(error.code)) throw error;
          receipt = { fingerprint, ...failedTool(error.code, error.toolHint) };
        } finally {
          if (state.performance) state.performance.tools = [...state.performance.tools,
            { name: call.name, durationMs: Date.now() - started, ...(errorCode ? { errorCode } : {}) }].slice(-120);
        }
      }
      state.toolReceipts[operationId] = receipt;
      await save(state);
    }
    if (receipt.isError) failed = true;
    if (!receipt.isError && receipt.result?.kind === 'map-read' && receipt.result.node?.id) visible.push({
      kind: 'node-read', actionId: receipt.result.actionId, node: { id: receipt.result.node.id, title: receipt.result.node.title || '' },
    });
    else if (!receipt.isError && call.name === 'react_to_user' && trustedSlackInput && receipt.result?.kind === 'slack-reaction') visible.push(receipt.result);
    else if (!receipt.isError && ['node-references', 'node-navigation', 'node-tour', 'conversation-mounted', 'map-action', 'model-selection', 'project-switch'].includes(receipt.result?.kind)) visible.push(receipt.result);
    if (!receipt.isError && ['conversation-mounted', 'project-switch'].includes(receipt.result?.kind)) transferred = true;
    responses.push(toolReply(call, receipt));
  }
  if (visible.length) state.messages.at(-1).actions = visible;
  state.messages.push({ role: 'user', content: responses });
  state.pending = null;
  // Successful UI-only actions do not supply new business facts to explain.
  // The model must explicitly mark the accompanying answer complete. Nonempty
  // progress text alone cannot terminate pending reading/checking. Preserve the
  // native tool pair and receipts even when no further model round is needed.
  const presentationOnly = completePresentations && !failed && responses.length > 0 && visible.length === responses.length &&
    next.content.some(block => block.type === 'text' && block.text?.trim()) &&
    next.content.filter(block => block.type === 'tool_use').every(call =>
      ['show_nodes', 'open_node', 'tour_nodes'].includes(call.name) && call.input?.replyComplete === true);
  // A reaction intent does not complete the requested textual answer. Let the
  // model consume its receipt and end the turn normally, with or without text.
  changed = checkpoint ? await checkpoint() : changed;
  if (changed.steered || changed.interrupted) {
    const response = state.messages.at(-2);
    if (response?.role === 'assistant') response.superseded = true;
  }
  state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' :
    transferred || !failed && (presentationOnly || next.content.some(block => block.type === 'tool_use' &&
      (block.name === 'ask_user' || block.name === 'show_model_menu' && block.input?.display !== false))) ? 'waiting-for-user' : 'running';
  await save(state);
  return state;
}
