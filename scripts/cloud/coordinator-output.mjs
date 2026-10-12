import { COORDINATOR_NATIVE_OUTPUT, COORDINATOR_OUTPUT_CAPABILITIES, coordinatorRespondTool,
  COORDINATOR_NATIVE_OUTPUT_POLICY, COORDINATOR_NATIVE_OUTPUT_REMINDER, normalizeCoordinatorOutput, validateCoordinatorParameters, nativeOutputError } from '../shared/coordinator-output.mjs';
import { MERGED_PARTICIPATION_POLICY } from './merged-participation.mjs';
import { validateCoordinatorToolInput } from './coordinator-tools.mjs';
export { COORDINATOR_NATIVE_OUTPUT };

export function configuredOutputProtocol(config, conversationId) {
  if (config.outputProtocol === undefined && config.outputProtocolConversations === undefined) return null;
  outputProtocolRecord(config.outputProtocol);
  if (!Array.isArray(config.outputProtocolConversations) || config.outputProtocolConversations.length > 100 ||
    config.outputProtocolConversations.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    throw Object.assign(new Error('Experimental output requires an explicit bounded conversation allowlist'), { code: 'OUTPUT_PROTOCOL_UNSUPPORTED' });
  }
  return config.outputProtocolConversations.includes(conversationId) ? config.outputProtocol : null;
}

export function outputProtocolRecord(protocol) {
  if (protocol === null || protocol === undefined || protocol === 'legacy') return null;
  if (protocol !== COORDINATOR_NATIVE_OUTPUT) throw Object.assign(new Error('Unsupported Coordinator output protocol'), { code: 'OUTPUT_PROTOCOL_UNSUPPORTED' });
  return { protocol, capabilities: [...COORDINATOR_OUTPUT_CAPABILITIES] };
}
export function nativeOutputEnabled(record) {
  if (!record) return false; // Unfinished historical turns remain legacy.
  if (record.protocol !== COORDINATOR_NATIVE_OUTPUT || JSON.stringify(record.capabilities) !== JSON.stringify(COORDINATOR_OUTPUT_CAPABILITIES)) {
    throw Object.assign(new Error('Resume with the original supported output capabilities'), { code: 'OUTPUT_PROTOCOL_UNSUPPORTED' });
  }
  return true;
}
export function nativeOutputTools(tools, continuation) {
  return [...tools.map(tool => tool.name === 'react_to_user' ? { ...tool,
    description: tool.description.replace('先给接话标识，', '') } : tool), ...(continuation ? [] : [coordinatorRespondTool])];
}
export function nativeOutputMessages(messages) {
  const last = messages.findLastIndex(message => message.role === 'user');
  if (last < 0) return messages;
  return messages.map((message, index) => index !== last ? message : { ...message,
    content: typeof message.content === 'string' ? message.content + COORDINATOR_NATIVE_OUTPUT_REMINDER
      : [...message.content, { type: 'text', text: COORDINATOR_NATIVE_OUTPUT_REMINDER }] });
}
export function nativeOutputPolicy({ slack = false, continuation = false, repair = false } = {}) {
  // Reuse relevance semantics, not the retired marker syntax.
  const relevance = slack ? MERGED_PARTICIPATION_POLICY.split('\n需回应：')[0] : '';
  return relevance + (continuation ? '\n本轮已经接话。直接给普通正文或调用必要业务工具，不调用 respond，不写旧接话标记。'
    : COORDINATOR_NATIVE_OUTPUT_POLICY + (slack ? '' : '\nMap 的当前用户已发起对话，应回应其问题，不以静默代替回答。')) +
    (repair ? '\n上一份输出不合法，尚未执行其中工具。严格使用本轮原生工具及参数 schema；不退回旧标记或文本 JSON。' : '');
}
export function decodeNativeOutput(next, { tools, continuation = false, allowEmpty = false } = {}) {
  const output = normalizeCoordinatorOutput(next, { tools, continuation, allowEmpty });
  if (output.kind === 'business') {
    // Validate the whole batch before the first operation. The executor still
    // authorizes each real operation and owns semantic/version checks.
    for (const call of next.content.filter(block => block.type === 'tool_use')) {
      try {
        const tool = tools.find(tool => tool.name === call.name);
        validateCoordinatorParameters(call.input, tool.input_schema);
        validateCoordinatorToolInput(tool, call.input);
      }
      catch { throw nativeOutputError('OUTPUT_TOOL_ARGUMENT_INVALID'); }
    }
  }
  return output;
}
