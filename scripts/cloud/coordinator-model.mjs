import { hash } from '../shared/io.mjs';
import { canonical } from '../shared/protocol.mjs';
import { coordinatorReplyIssue, coordinatorReplyProfile, replyRepairInstruction, coordinatorReplyParagraphLengths, COORDINATOR_REPLY_POLICY } from '../shared/coordinator-reply.mjs';
import { coordinatorContextMessage } from './coordinator-prefix.mjs';
import { canUseSlackProjectTool } from './coordinator-tools.mjs';
import { createParticipationGate, mergedParticipationInput, mergedParticipationMessages, mergedParticipationTools, businessToolName, MERGED_PARTICIPATION_POLICY } from './merged-participation.mjs';
import { nativeOutputEnabled, nativeOutputTools, nativeOutputMessages, nativeOutputPolicy, decodeNativeOutput } from './coordinator-output.mjs';

const problem = (code, message) => Object.assign(new Error(message), { code });
const diagnosticCodes = new Set(['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'MODEL_INVALID_RESPONSE', 'MODEL_INTERRUPTED', 'MODEL_STEERED', 'MODEL_RESPONSE_TOO_LARGE', 'CONTEXT_TOO_LARGE', 'UNKNOWN_MODEL_ERROR']);
const diagnosticPhases = new Set(['fetch', 'http', 'response-stream', 'response-json', 'response-validation']);
const terminationCodes = new Set(['STREAM_INVALID', 'MISSING_TERMINAL', 'OPEN_BLOCKS', 'STOP_REASON_INVALID', 'MODEL_MISMATCH', 'CONTENT_INVALID', 'TOOL_INVALID', 'STOP_TOOL_MISMATCH']);
const callbackBoundaries = new Set(['onText', 'onToolStart']);
const repairCodes = ['PARTICIPATION_HEADER_INVALID', 'PARTICIPATION_TOOL_UNDECLARED', 'PARTICIPATION_SILENT_CONFLICT', 'PARTICIPATION_REPLY_EMPTY',
  'REPLY_INTERNAL_ID', 'REPLY_PARAGRAPH_LONG', 'REPLY_TOO_MANY_PARAGRAPHS', 'MULTIPLE_QUESTIONS', 'REACTION_REQUIRES_TEXT', 'RECOVERY_TOOL_OMITTED',
  'OUTPUT_CONTENT_INVALID', 'OUTPUT_TOOL_INVALID', 'OUTPUT_RESPONSE_CONFLICT', 'OUTPUT_RESPONSE_INVALID', 'OUTPUT_TOOL_UNDECLARED', 'OUTPUT_RESPONSE_REQUIRED', 'OUTPUT_TOOL_ARGUMENT_INVALID'];
for (const code of repairCodes) terminationCodes.add(code);
export function coordinatorFailureDiagnostic(cause) {
  const diagnostic = safeModelDiagnostic(ownValue(cause, 'modelDiagnostic'));
  const termination = safeTermination(ownValue(cause, 'modelTermination'));
  return diagnostic || (termination.validationCode ? {
    code: diagnosticCodes.has(cause?.code) ? cause.code : 'UNKNOWN_MODEL_ERROR', phase: 'response-validation',
    ...termination,
  } : null);
}
export function recoverableModelFailure(cause) {
  if (['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'MODEL_HTTP_408', 'MODEL_HTTP_429', 'MODEL_HTTP_500', 'MODEL_HTTP_502', 'MODEL_HTTP_503', 'MODEL_HTTP_504'].includes(cause?.code)) return true;
  const code = coordinatorFailureDiagnostic(cause)?.validationCode;
  return cause?.code === 'MODEL_INVALID_RESPONSE' && [...repairCodes, 'STREAM_INVALID', 'MISSING_TERMINAL', 'OPEN_BLOCKS', 'CONTENT_INVALID', 'STOP_REASON_INVALID', 'TOOL_INVALID', 'STOP_TOOL_MISMATCH'].includes(code);
}
const invalidReply = (validationCode, text = '', repairTools = []) => Object.assign(problem('MODEL_INVALID_RESPONSE', '回复未通过展示校验，未执行工具'), {
  modelTermination: { validationCode }, retryableModelResponse: true, repairText: String(text).slice(0, 2000),
  repairTools,
});
const stopReasons = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'model_context_window_exceeded', 'stop', 'tool_calls', 'length', 'content_filter']);
const ownValue = (value, field) => value && Object.getOwnPropertyDescriptor(value, field)?.value;
function safeTermination(value) {
  try {
    const result = {}, code = ownValue(value, 'validationCode'), stop = ownValue(value, 'stopReason');
    if (terminationCodes.has(code)) result.validationCode = code;
    if (stopReasons.has(stop)) result.stopReason = stop;
    const origin = ownValue(value, 'failureOrigin'), boundary = ownValue(value, 'callbackBoundary');
    if (origin === 'callback' && callbackBoundaries.has(boundary)) {
      result.failureOrigin = origin; result.callbackBoundary = boundary;
    }
    const open = ownValue(value, 'openBlockCount'), terminal = ownValue(value, 'messageStopSeen');
    if (Number.isSafeInteger(open) && open >= 0) result.openBlockCount = open;
    if (typeof terminal === 'boolean') result.messageStopSeen = terminal;
    const usage = ownValue(value, 'usage'), tokens = {};
    for (const name of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'prompt_tokens', 'completion_tokens']) {
      const count = ownValue(usage, name);
      if (Number.isSafeInteger(count) && count >= 0) tokens[name] = count;
    }
    if (Object.keys(tokens).length) result.usage = tokens;
    return result;
  } catch { return {}; }
}
function safeModelDiagnostic(value) {
  try {
    const code = ownValue(value, 'code'), phase = ownValue(value, 'phase'), durationMs = ownValue(value, 'durationMs');
    if (!diagnosticPhases.has(phase)) return null;
    return { code: diagnosticCodes.has(code) || typeof code === 'string' && /^MODEL_HTTP_[45]\d\d$/.test(code) ? code : 'UNKNOWN_MODEL_ERROR', phase,
      ...(Number.isSafeInteger(durationMs) && durationMs >= 0 ? { durationMs } : {}),
      ...safeTermination(ownValue(value, 'termination')) };
  } catch { return null; }
}
export const correctableToolError = code => ['INVALID_ARGUMENT', 'INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN', 'TOOL_FORBIDDEN', 'APPROVAL_REQUIRED', 'CONFLICT', 'VERSION_CONFLICT'].includes(code);
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
    catch { throw Object.assign(problem('MODEL_INVALID_RESPONSE', 'Coordinator returned invalid tool input'), { modelTermination: { validationCode: 'TOOL_INVALID' } }); }
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
  let started = false, terminal = false, messageStopSeen = false, validationCode = 'STREAM_INVALID';
  let callbackBoundary = null;
  const notify = async (boundary, callback, value) => {
    try { await callback?.(value); }
    catch (error) { callbackBoundary = boundary; throw error; }
  };
  const invalidStream = (code = 'STREAM_INVALID') => {
    validationCode = code;
    return problem('MODEL_INVALID_RESPONSE', 'Coordinator returned an incomplete or invalid event stream');
  };
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
      if (block.type === 'tool_use') await notify('onToolStart', onToolStart, block.name);
      if (block.type === 'text' && block.text) { visibleText += block.text; await notify('onText', onText, visibleText); }
    }
    if (value.type === 'content_block_delta') {
      if (!openBlocks.has(value.index)) throw invalidStream();
      const block = blocks[value.index], delta = value.delta || {};
      if (block?.type === 'text' && delta.type === 'text_delta') { block.text += delta.text || ''; visibleText += delta.text || ''; await notify('onText', onText, visibleText); }
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
        try { block.input = JSON.parse(block._json); } catch { throw invalidStream('TOOL_INVALID'); }
      }
      if (block) delete block._json;
      openBlocks.delete(value.index);
    }
    if (value.type === 'message_delta') {
      if (!started) throw invalidStream();
      stopReason = value.delta?.stop_reason || stopReason; usage = { ...usage, ...(value.usage || {}) };
    }
    if (value.type === 'message_stop') {
      messageStopSeen = true;
      if (!started) throw invalidStream();
      if (openBlocks.size) throw invalidStream('OPEN_BLOCKS');
      if (!['end_turn', 'tool_use'].includes(stopReason)) throw invalidStream('STOP_REASON_INVALID');
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
    if (!terminal) throw invalidStream('MISSING_TERMINAL');
    checkActive();
  } catch (error) {
    // Never retain raw events, blocks, thoughts or arbitrary usage properties.
    const callbackTermination = callbackBoundary ? safeTermination(ownValue(error, 'modelTermination')) : {};
    try { Object.defineProperty(error, 'modelTermination', { value: safeTermination({
      ...(callbackBoundary ? { ...callbackTermination, failureOrigin: 'callback', callbackBoundary }
        : ownValue(error, 'code') === 'MODEL_INVALID_RESPONSE' ? { validationCode } : {}), stopReason,
      openBlockCount: openBlocks.size, messageStopSeen, usage }), configurable: true }); } catch {}
    throw error;
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
    let phase = 'fetch', termination = null;
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
      termination = { stopReason: result.stop_reason, usage: result.usage };
      if (result.model !== this.model || !Array.isArray(result.content) || !['end_turn', 'tool_use'].includes(result.stop_reason)) {
        termination.validationCode = result.model !== this.model ? 'MODEL_MISMATCH' : !Array.isArray(result.content) ? 'CONTENT_INVALID' : 'STOP_REASON_INVALID';
        throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned a different model or an incomplete turn');
      }
      for (const block of result.content) validatePrivateBlock(block);
      const calls = result.content.filter(block => block.type === 'tool_use');
      if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input))) {
        termination.validationCode = 'TOOL_INVALID';
        throw problem('MODEL_INVALID_RESPONSE', 'Coordinator returned malformed tool calls');
      }
      if ((result.stop_reason === 'tool_use') !== Boolean(calls.length)) {
        termination.validationCode = 'STOP_TOOL_MISMATCH';
        throw problem('MODEL_INVALID_RESPONSE', 'Coordinator stop reason does not match its tool calls');
      }
      return { content: result.content, stop: result.stop_reason, usage: result.usage || {}, model: result.model, requestId: response.headers.get('request-id') || '' };
    } catch (error) {
      const wasAborted = abort.signal.aborted;
      abort.abort();
      const failure = wasAborted ? interruptionProblem(abort.signal) : String(error.code || '').startsWith('MODEL_') || error.code === 'CONTEXT_TOO_LARGE'
        ? error : problem('MODEL_UNAVAILABLE', 'Coordinator model connection failed; no automatic retry was made');
      // Private metadata only: provider exception text and arbitrary codes are
      // never diagnostic data. Preserve the original outcome if metadata fails.
      try {
        const code = diagnosticCodes.has(failure.code) || /^MODEL_HTTP_[45]\d\d$/.test(failure.code || '') ? failure.code : 'UNKNOWN_MODEL_ERROR';
        const elapsed = Date.now() - (deadlineAt - this.timeoutMs);
        Object.defineProperty(failure, 'modelDiagnostic', { value: { code, phase,
          termination: safeTermination(ownValue(error, 'modelTermination') || termination),
          ...(Number.isSafeInteger(elapsed) && elapsed >= 0 ? { durationMs: elapsed } : {}) }, configurable: true });
      } catch {}
      throw failure;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
}

// Empty completion belongs to the current accepted participation batch and
// native reaction pairs, never to a historical intent or a model-supplied flag.
function reactionOnlyContinuation(state, turnId, input) {
  const anchor = state.messages.lastIndexOf(input);
  const start = state.messages.findLastIndex(message => message.role === 'user' && message.requestId);
  const inputs = input?.serverContext?.participation?.inputs;
  const active = state.activeInput, actorHash = hash(JSON.stringify(active.actor));
  const users = state.messages.slice(anchor, start + 1), pairs = state.messages.slice(start + 1);
  if (anchor < 0 || start < anchor || !Array.isArray(inputs) || !inputs.length || users.length !== inputs.length ||
      users.some((message, index) => message.role !== 'user' || message.requestId !== inputs[index].id ||
        !state.activeRequestIds?.includes(message.requestId) || message.source !== 'slack' || !message.actor ||
        hash(JSON.stringify(message.actor)) !== actorHash) || !pairs.length || pairs.length % 2) return false;
  for (let index = 0; index < pairs.length; index += 2) {
    const assistant = pairs[index], results = pairs[index + 1];
    if (assistant.role !== 'assistant' || assistant.superseded || assistant.requestId !== active.id ||
        assistant.source !== 'slack' || !assistant.actor || hash(JSON.stringify(assistant.actor)) !== actorHash ||
        !Array.isArray(assistant.content) || assistant.content.some(block => block.type === 'text' && block.text?.trim()) ||
        results.role !== 'user' || results.requestId || !Array.isArray(results.content)) return false;
    const calls = assistant.content.filter(block => block.type === 'tool_use');
    if (!calls.length || calls.length !== results.content.length || new Set(calls.map(call => call.id)).size !== calls.length) return false;
    for (let offset = 0; offset < calls.length; offset++) {
      const call = calls[offset], reply = results.content[offset];
      const operationId = `coordinator:${hash(`${turnId}:${call.id}`)}`, receipt = state.toolReceipts[operationId];
      if (businessToolName(call.name) !== 'react_to_user' || !receipt || receipt.isError ||
          receipt.fingerprint !== hash(JSON.stringify({ name: call.name, input: call.input })) ||
          receipt.result?.kind !== 'slack-reaction' || receipt.result.status !== 'intent' ||
          receipt.result.actionId !== operationId || receipt.result.emoji !== call.input?.emoji ||
          receipt.result.requestId !== active.id || !receipt.result.actor || hash(JSON.stringify(receipt.result.actor)) !== actorHash ||
          reply.type !== 'tool_result' || reply.tool_use_id !== call.id || reply.is_error ||
          reply.content !== JSON.stringify(receipt.result)) return false;
    }
  }
  return true;
}

// Persist every assistant response and tool receipt through the caller. Stable
// operation IDs let protocol-backed tools replay a lost response idempotently.
function currentProjectReadInput(state) {
  const ids = new Set(state.activeRequestIds || [state.activeInput?.id]);
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.role === 'user' && ids.has(message.requestId)) return {
      id: message.requestId, source: message.source, actor: message.actor,
    };
  }
  return state.activeInput;
}

export async function coordinatorStep({ turnId, state, model, system, promptVersion = hash(system), tools, save, execute, materializeMessages = null, onText = null, onToolStart = null, onModelAccepted = null, completePresentations = false, validateReplies = false, checkpoint = null, signal = null }) {
  if (state.promptVersion && state.promptVersion !== promptVersion) throw problem('PROMPT_CHANGED', 'Resume with the same Coordinator prompt version');
  state.promptVersion = promptVersion;
  state.messages ||= []; state.toolReceipts ||= {};
  const nativeOutput = nativeOutputEnabled(state.activeOutputProtocol);
  const outputKey = `${state.activeTurnId || turnId}:${state.consumedInputRevision || 0}`;
  // Source belongs to the accepted server input, never to message text or model
  // tool parameters. Other clients already have their own model settings UI.
  const sourceTools = tools.filter(tool => tool.name !== 'show_model_menu' || state.activeInput?.source === 'slack');
  const slackActor = state.activeInput?.actor;
  const trustedSlackInput = state.activeInput?.source === 'slack' && !!state.activeInput.id && slackActor?.kind === 'human' &&
    slackActor.integration === 'slack' && /^[UW][A-Z0-9]{1,31}$/.test(slackActor.userId || '') &&
    /^[TE][A-Z0-9]{1,31}$/.test(slackActor.teamId || '') && slackActor.sessionId === `slack:${slackActor.teamId}:${slackActor.userId}`;
  const readProjectTools = ['list_projects', 'read_project_map'], projectTools = [...readProjectTools, 'switch_project'];
  // 补充已消费后，读取不能借用轮次最初发送者的更大权限。
  const projectReadInput = currentProjectReadInput(state);
  const executableTools = sourceTools.filter(tool => readProjectTools.includes(tool.name)
    ? !!projectReadInput?.id && canUseSlackProjectTool(tool.name, projectReadInput)
    : (!['react_to_user', 'select_text_model', 'switch_project'].includes(tool.name) || trustedSlackInput) &&
      (tool.name !== 'switch_project' || canUseSlackProjectTool(tool.name, state.activeInput)));
  const availableModelTools = tools.filter(tool => !projectTools.includes(tool.name) || executableTools.includes(tool));
  // Private operator diagnostics only; public timing and transcript contracts
  // stay unchanged. No prompts, arguments, results or provider IDs are copied.
  if (state.activeTurnId && state.performance?.turnId !== state.activeTurnId) state.performance = {
    turnId: state.activeTurnId, models: [], tools: [],
  };
  if (!state.pending) {
    const messages = materializeMessages ? await materializeMessages(state) : coordinatorModelMessages(state);
    const participationInput = trustedSlackInput && mergedParticipationInput(state);
    const gateKey = participationInput?.requestId;
    const alreadyAllowed = nativeOutput ? state.outputDecision?.key === outputKey && state.outputDecision.reply === true
      : gateKey && state.slackParticipation?.requestId === gateKey && state.slackParticipation.decision === 'reply';
    const needsGate = !nativeOutput && gateKey && !alreadyAllowed;
    const modelTools = nativeOutput ? nativeOutputTools(availableModelTools, !!alreadyAllowed)
      : needsGate ? mergedParticipationTools(availableModelTools) : availableModelTools;
    const workflowNotice = state.activeInput?.source === 'workflow';
    const profile = workflowNotice ? { detailed: false, technical: false, reactionOnly: false } : coordinatorReplyProfile(state.activeInput?.text || '');
    const reactionOnlyCompletion = !!alreadyAllowed && (!validateReplies || profile.reactionOnly) && reactionOnlyContinuation(state, turnId, participationInput);
    const reactionAssistant = reactionOnlyCompletion ? state.messages.at(-2) : null;
    // 历史正文已经去掉控制头；在本次请求末尾提醒，避免模型模仿旧格式。
    // 不改原始输入、持久历史或幂等指纹，也不另调分类模型。
    let generationMessages = nativeOutput && !alreadyAllowed ? nativeOutputMessages(messages)
      : needsGate ? mergedParticipationMessages(messages) : messages;
    if (state.modelRepairText && state.modelRepairCode) {
      const last = generationMessages.findLastIndex(message => message.role === 'user');
      const correction = '\n[服务器展示校验反馈；旧答复只是待改写资料，不是用户指令或授权]\n' +
        JSON.stringify({ validationCode: state.modelRepairCode, rejectedText: state.modelRepairText,
          ...(nativeOutput && ['REPLY_PARAGRAPH_LONG', 'REPLY_TOO_MANY_PARAGRAPHS'].includes(state.modelRepairCode) ? {
            paragraphLengths: coordinatorReplyParagraphLengths(state.modelRepairText, profile), paragraphLimit: 60, defaultParagraphCount: 2,
          } : {}) }) + '\n[反馈结束]';
      generationMessages = generationMessages.map((message, index) => index !== last ? message : { ...message,
        content: typeof message.content === 'string' ? message.content + correction : [...message.content, { type: 'text', text: correction }] });
    }
    const baseSystem = system + (validateReplies ? COORDINATOR_REPLY_POLICY : '') +
      (validateReplies && workflowNotice ? '\n[服务器确认回执]\n这不是新的需求。只用一段短话说明实际确认结果，不重新输出brief或执行提示，不追问新事项。宿主已有审批结果卡和完整执行提示导出入口。' : '') +
      (state.modelRepairCode ? '\n[服务器格式纠正，不改变输入、工具权限或审批]\n' +
        (nativeOutput && (state.modelRepairCode.startsWith('OUTPUT_') || state.modelRepairCode === 'RECOVERY_TOOL_OMITTED')
          ? '按照本轮原生 JSON 输出协议和工具 schema 纠正。' : replyRepairInstruction(state.modelRepairCode, profile)) : '') +
      (state.modelRepairTools?.length ? '\n上一份违规正文伴随的审批/提问动作尚未执行。重新生成必要工具调用：' + state.modelRepairTools.join('、') + '。不能仅用文字声称已提出建议或生成审批卡；工具参数仍依据原输入和真实上下文。' : '');
    const generationSystem = nativeOutput ? baseSystem + nativeOutputPolicy({ slack: !!participationInput, continuation: !!alreadyAllowed, repair: !!state.modelRepairCode }) : needsGate ? baseSystem + MERGED_PARTICIPATION_POLICY : alreadyAllowed
      ? baseSystem + '\n本轮已确认需要接话，直接继续正文和允许的工具，不再输出内部接话标识。' : baseSystem;
    const systemHash = hash(generationSystem), toolsHash = hash(JSON.stringify(modelTools));
    const measurement = state.performance && { startedAt: new Date().toISOString(), firstTextMs: null,
      prefix: { systemHash, toolsHash, envelopeHash: hash(JSON.stringify([systemHash, toolsHash, ...(nativeOutput ? [state.activeOutputProtocol] : [])])),
        ...(nativeOutput ? { outputProtocol: state.activeOutputProtocol.protocol } : {}),
        historyHash: hash(JSON.stringify(generationMessages)), messageCount: generationMessages.length,
        ...(state.activeContext?.format === 2 ? { staticVersion: state.activeContext.staticVersion } : {}) } };
    const started = Date.now();
    const gate = !nativeOutput && (needsGate || alreadyAllowed) ? createParticipationGate(async text => {
      // 同一增量含控制头与正文时，也先持久发布决定，再发布正文。
      await publishDecision();
      if (!validateReplies) {
        if (text && measurement && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
        await onText?.(text);
      }
    }, { continuation: !!alreadyAllowed, reactionOnlyCompletion,
      replyToolNames: needsGate ? modelTools.map(tool => tool.name) : [] }) : null;
    const publishDecision = async () => {
      if (gate?.decision && (state.slackParticipation?.requestId !== gateKey || state.slackParticipation.decision !== gate.decision)) {
        state.slackParticipation = { requestId: gateKey, decision: gate.decision };
        await save(state);
      }
    };
    let next;
    try {
      if (signal?.aborted) throw interruptionProblem(signal);
      next = await model.next({ system: generationSystem, messages: generationMessages, tools: modelTools, signal, onText: measurement ? async text => {
        if (signal?.aborted) return;
        if (!nativeOutput && !gate && !validateReplies && text && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
        if (gate) { await gate.consume(text); await publishDecision(); } else if (!nativeOutput && !validateReplies) await onText?.(text);
      } : gate ? async text => { await gate.consume(text); await publishDecision(); } : nativeOutput ? async () => {} : onText, onToolStart: async name => {
        gate?.toolStart();
        if (gate && gate.decision !== 'reply') return;
        await publishDecision(); await onToolStart?.(name);
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
      if (nativeOutput) next = { ...next, nativeOutput: decodeNativeOutput(next, {
        tools: executableTools, continuation: !!alreadyAllowed, allowEmpty: reactionOnlyCompletion,
      }) };
      if (validateReplies) {
        const calls = next.content.filter(block => block.type === 'tool_use');
        const repairTools = [...new Set(calls.map(call => businessToolName(call.name)).filter(name => ['mount_conversation', 'prepare_task', 'ask_user'].includes(name)))];
        const questions = calls.filter(call => businessToolName(call.name) === 'ask_user');
        if (questions.length > 1) throw invalidReply('MULTIPLE_QUESTIONS', '', repairTools);
        const internalIds = new Set(state.activeContext?.internalIds || []);
        for (const receipt of Object.values(state.toolReceipts)) {
          const visit = value => {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
              if (/^(?:id|nodeId|itemId|taskId|sessionId|version|mainVersion)$/u.test(key) && typeof child === 'string' &&
                  !(key === 'id' && [value.title, value.name, value.label].includes(child) && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(child))) internalIds.add(child);
              else if (child && typeof child === 'object') visit(child);
            }
          };
          visit(receipt.result);
        }
        const options = { ...profile, internalIds: [...internalIds] };
        const text = next.nativeOutput?.text ?? next.content.filter(block => block.type === 'text').map(block => block.text).join('');
        const displayed = [text, ...questions.flatMap(call => [call.input?.question || '',
          ...(Array.isArray(call.input?.options) ? call.input.options : [])]),
          ...calls.filter(call => businessToolName(call.name) === 'mount_conversation').flatMap(call => [call.input?.title || '', call.input?.description || ''])];
        const rejected = displayed.map((value, index) => ({ value, issue: coordinatorReplyIssue(value,
          index === 0 ? options : { ...options, technical: false, detailed: false }) })).find(item => item.issue);
        if (rejected) throw invalidReply(rejected.issue, rejected.value, repairTools.length ? repairTools : state.modelRepairTools);
        if (state.modelRepairTools?.some(name => !calls.some(call => businessToolName(call.name) === name))) {
          throw invalidReply('RECOVERY_TOOL_OMITTED', text, state.modelRepairTools);
        }
        if (!profile.reactionOnly && calls.length && calls.every(call => businessToolName(call.name) === 'react_to_user' && call.input?.replyComplete === true) && !text.trim()) {
          throw invalidReply('REACTION_REQUIRES_TEXT');
        }
        if (text) {
          if (measurement && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
          await onText?.(text);
        }
      }
      if (nativeOutput) {
        state.outputDecision = { key: outputKey, reply: next.nativeOutput.reply };
        if (gateKey) state.slackParticipation = { requestId: gateKey, decision: next.nativeOutput.reply ? 'reply' : 'silent' };
        if (!validateReplies && next.nativeOutput.text) {
          if (measurement && measurement.firstTextMs === null) measurement.firstTextMs = Date.now() - started;
          await onText?.(next.nativeOutput.text);
        }
      }
      if (measurement) Object.assign(measurement, { durationMs: Date.now() - started,
        stop: next.stop, inputTokens: coordinatorInputTokens(next.usage),
        cacheReadTokens: Number.isSafeInteger(next.usage?.cache_read_input_tokens) && next.usage.cache_read_input_tokens >= 0 ? next.usage.cache_read_input_tokens
          : Number.isSafeInteger(next.usage?.prompt_tokens_details?.cached_tokens) && next.usage.prompt_tokens_details.cached_tokens >= 0
            ? next.usage.prompt_tokens_details.cached_tokens : null });
    } catch (cause) {
      if (cause.partialText !== undefined) cause.partialText = nativeOutput || validateReplies ? '' : gate ? gate.visible : cause.partialText;
      if (measurement) Object.assign(measurement, { durationMs: Date.now() - started, errorCode: cause.code || 'MODEL_UNAVAILABLE' });
      if (measurement) {
        // Only the closed diagnostic projection enters private performance.
        try { const diagnostic = coordinatorFailureDiagnostic(cause);
          if (diagnostic) measurement.diagnostic = diagnostic; } catch {}
      }
      throw cause;
    } finally {
      if (measurement) state.performance.models = [...state.performance.models, measurement].slice(-60);
    }
    if (next.content.some(block => ['image', 'image_url'].includes(block.type))) {
      throw problem('MODEL_INVALID_RESPONSE', 'Coordinator responses cannot persist raw image payloads');
    }
    const inputTokens = coordinatorInputTokens(next.usage);
    if (inputTokens !== null) state.lastInputTokens = inputTokens;
    if (next.content.some(block => block.type === 'tool_use' &&
      (gate?.decision === 'reply' ? businessToolName(block.name) : block.name) === 'ask_user')) await onToolStart?.('ask_user');
    if (gate?.decision === 'silent') {
      const changed = checkpoint ? await checkpoint() : { steered: false, interrupted: false };
      state.pending = null;
      state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' : 'waiting-for-user';
      onModelAccepted?.(state);
      await save(state); return state;
    }
    if (reactionOnlyCompletion && next.stop === 'end_turn' && next.content.length === 0) {
      // Preserve the native pair without adding an empty assistant to future
      // provider requests. Nonempty private blocks keep their original history.
      const changed = checkpoint ? await checkpoint() : { steered: false, interrupted: false };
      if ((changed.steered || changed.interrupted) && state.messages.includes(reactionAssistant)) reactionAssistant.superseded = true;
      state.pending = null;
      state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' : 'waiting-for-user';
      await save(state); return state;
    }
    const metadata = state.activeInput || {};
    state.messages.push({ role: 'assistant', content: next.content,
      ...(next.nativeOutput ? { output: { protocol: state.activeOutputProtocol.protocol, ...next.nativeOutput } } : {}),
      ...(state.activeModelRoute?.providerId ? { providerId: state.activeModelRoute.providerId } : {}),
      ...(state.activeModelRoute?.model ? { modelName: next.model || state.activeModelRoute.model } : {}),
      ...(metadata.id ? { requestId: metadata.id, id: `message-${hash(`${metadata.id}:assistant:${state.messages.length}`)}` } : {}),
      ...(metadata.source ? { source: metadata.source } : {}), ...(metadata.actor ? { actor: metadata.actor } : {}) });
    state.pending = next;
    // The private acceptance marker shares the complete native response save,
    // never a streaming/tool-start save or a later business tool checkpoint.
    onModelAccepted?.(state);
    await save(state);
  }
  const next = state.pending, toolAssistant = state.messages.at(-1);
  const mergedReplyAllowed = trustedSlackInput && state.slackParticipation?.decision === 'reply' &&
    (state.activeRequestIds || [state.activeInput.id]).includes(state.slackParticipation.requestId);
  const toolName = call => !nativeOutput && mergedReplyAllowed ? businessToolName(call.name) : call.name;
  let changed = checkpoint ? await checkpoint() : { steered: false, interrupted: false };
  if ((changed.steered || changed.interrupted) && toolAssistant?.role === 'assistant' && state.messages.includes(toolAssistant)) toolAssistant.superseded = true;
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
    const name = toolName(call);
    let receipt = state.toolReceipts[operationId];
    if (receipt && receipt.fingerprint !== fingerprint) throw problem('TOOL_ID_REUSED', 'Coordinator reused a tool identifier with different input');
    // 回复纠正可能让模型换一个原生调用ID。只在本轮自动恢复时复用相同
    // 写入的已知成功回执，读取仍取当前状态；不重放未知或失败写入。
    if (!receipt && (state.modelRetries || 0) > 0 && !['list_projects', 'list_tasks', 'list_sessions', 'list_conversations',
      'read_map', 'read_reference', 'read_task', 'read_object', 'show_model_menu'].includes(name)) {
      const businessFingerprint = hash(canonical({ name, input: call.input }));
      const completed = Object.entries(state.toolReceipts).find(([, item]) => item.turnId === turnId && item.inputRevision === state.consumedInputRevision && !item.isError &&
        item.businessFingerprint === businessFingerprint);
      if (completed) {
        receipt = { ...completed[1], fingerprint, replayedFrom: completed[0] };
        state.toolReceipts[operationId] = receipt; await save(state);
      }
    }
    if (!receipt) {
      if (changed.steered || changed.interrupted) receipt = { fingerprint, ...failedTool(changed.interrupted ? 'TURN_INTERRUPTED' : 'INPUT_SUPERSEDED') };
      else if (failed || transferred) receipt = { fingerprint, ...failedTool('NOT_EXECUTED') };
      else if (nativeOutput && next.nativeOutput?.kind === 'response' && name === 'respond') receipt = {
        fingerprint, result: { kind: 'coordinator-response', reply: next.nativeOutput.reply },
      };
      else if (!executableTools.some(tool => tool.name === name)) receipt = { fingerprint,
        ...failedTool('TOOL_FORBIDDEN', '工具名未注册；只能使用本轮提供的工具，不得猜测接口。') };
      else if (name === 'react_to_user' && Object.values(state.toolReceipts).filter(item => !item.isError &&
        item.result?.kind === 'slack-reaction' && item.result.requestId === state.activeInput.id).length >= 2) {
        receipt = { fingerprint, ...failedTool('INVALID_ARGUMENT', '本条消息已使用两个交流表情，请继续必要正文，不再添加表情。') };
      }
      else {
        const started = Date.now();
        let errorCode = null;
        try {
          // Model settings use the integration's identifier alphabet, while
          // the original native tool receipt keeps its unchanged identity.
          const result = await execute(name, call.input, { operationId: name === 'select_text_model' ? `model-${hash(operationId)}` : operationId,
            ...(name === 'mount_conversation' ? { source: state.activeInput?.source || 'human',
              ...(state.activeInput?.actor ? { actor: state.activeInput.actor } : {}) } : {}),
            ...(readProjectTools.includes(name) ? { source: projectReadInput.source, actor: projectReadInput.actor, requestId: projectReadInput.id }
              : ['select_text_model', 'switch_project'].includes(name) && trustedSlackInput ? { source: 'slack', actor: slackActor,
                ...(name === 'switch_project' ? { requestId: state.activeInput.id } : {}) } : {}) });
          receipt = { fingerprint, result: name === 'react_to_user' && trustedSlackInput && result?.kind === 'slack-reaction'
            ? { ...result, requestId: state.activeInput.id, actor: slackActor } : result };
        }
        catch (error) {
          errorCode = error.code || 'TOOL_FAILED';
          if (!correctableToolError(error.code)) throw error;
          receipt = { fingerprint, ...failedTool(error.code, error.toolHint) };
        } finally {
          if (state.performance) state.performance.tools = [...state.performance.tools,
            { name, durationMs: Date.now() - started, ...(errorCode ? { errorCode } : {}) }].slice(-120);
        }
      }
      receipt.turnId = turnId;
      receipt.inputRevision = state.consumedInputRevision;
      receipt.businessFingerprint = hash(canonical({ name, input: call.input }));
      state.toolReceipts[operationId] = receipt;
      await save(state);
    }
    if (receipt.isError) failed = true;
    if (!receipt.isError && receipt.result?.kind === 'map-read' && receipt.result.node?.id) visible.push({
      kind: 'node-read', actionId: receipt.result.actionId, node: { id: receipt.result.node.id, title: receipt.result.node.title || '' },
    });
    else if (!receipt.isError && name === 'react_to_user' && trustedSlackInput && receipt.result?.kind === 'slack-reaction') visible.push(receipt.result);
    else if (!receipt.isError && ['node-references', 'node-navigation', 'node-tour', 'binding-proposal', 'conversation-mounted', 'map-action', 'model-selection', 'project-switch'].includes(receipt.result?.kind)) visible.push(receipt.result);
    if (!receipt.isError && ['conversation-mounted', 'project-switch'].includes(receipt.result?.kind)) transferred = true;
    responses.push(toolReply(call, receipt));
  }
  if (visible.length) state.messages.at(-1).actions = visible;
  state.messages.push({ role: 'user', content: responses });
  state.pending = null;
  // 人工 brief 已有完整审批卡；成功回执后等待确认，不再让模型复述正文。
  // 只收敛单个 manual prepare_task，自动模式、失败或混合工具仍正常继续。
  const manualBriefReady = validateReplies && !failed && responses.length === 1 &&
    next.content.filter(block => block.type === 'tool_use').length === 1 &&
    next.content.some(block => block.type === 'tool_use' && toolName(block) === 'prepare_task') &&
    (() => { try { const result = JSON.parse(responses[0].content);
      return result.manual === true && result.pending === true && result.requiresHumanApproval === true;
    } catch { return false; } })();
  // Successful UI-only actions do not supply new business facts to explain.
  // The model must explicitly mark the accompanying answer complete. Nonempty
  // progress text alone cannot terminate pending reading/checking. Preserve the
  // native tool pair and receipts even when no further model round is needed.
  const presentationOnly = completePresentations && !failed && responses.length > 0 && visible.length === responses.length &&
    next.content.some(block => block.type === 'text' && block.text?.trim()) &&
    next.content.filter(block => block.type === 'tool_use').every(call =>
      ['show_nodes', 'open_node', 'tour_nodes'].includes(toolName(call)) && call.input?.replyComplete === true);
  // 纯社交回应必须由模型明确标记，无正文、无本轮业务工具且所有意图回执成功。
  // 默认表情意图仍不能结束应有的文字答复；平台送达继续由私有队列核验。
  const reactionOnly = trustedSlackInput && (!validateReplies || coordinatorReplyProfile(state.activeInput?.text || '').reactionOnly) && !failed && responses.length > 0 && visible.length === responses.length &&
    !next.content.some(block => block.type === 'text' && block.text?.trim()) &&
    next.content.filter(block => block.type === 'tool_use').every(call => toolName(call) === 'react_to_user' && call.input?.replyComplete === true) &&
    !state.messages.some(message => message.role === 'assistant' && message.requestId === state.activeInput.id &&
      message.content?.some(block => block.type === 'tool_use' && toolName(block) !== 'react_to_user' || block.type === 'text' && block.text?.trim()));
  changed = checkpoint ? await checkpoint() : changed;
  if (changed.steered || changed.interrupted) {
    if (toolAssistant?.role === 'assistant' && state.messages.includes(toolAssistant)) toolAssistant.superseded = true;
  }
  state.status = changed.interrupted ? 'interrupted' : changed.steered ? 'running' :
    transferred || !failed && (nativeOutput && next.nativeOutput?.kind === 'response' || manualBriefReady || presentationOnly || reactionOnly || next.content.some(block => block.type === 'tool_use' &&
      (toolName(block) === 'ask_user' || toolName(block) === 'mount_conversation' || toolName(block) === 'show_model_menu' && block.input?.display !== false))) ? 'waiting-for-user' : 'running';
  await save(state);
  return state;
}
