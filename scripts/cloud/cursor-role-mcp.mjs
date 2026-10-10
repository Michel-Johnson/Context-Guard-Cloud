import { MAX_MESSAGE_BYTES, ProtocolError } from '../shared/protocol.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, code = -32602, status = 400) => { throw Object.assign(new Error(message), { rpcCode: code, status }); };
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const emptyParams = params => !params || record(params) && Object.keys(params).every(key => key === '_meta');
const idValid = id => typeof id === 'string' && id.length > 0 && id.length <= 128 || Number.isSafeInteger(id);
const string = (maxLength = 128) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const sourceSha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const refs = () => ({ type: 'array', items: string(), maxItems: 100 });
const errorCodes = new Set(['INVALID_ARGUMENT', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'ID_REUSED',
  'STALE_SESSION', 'TOO_LARGE', 'UNAVAILABLE', 'ROLE_FORBIDDEN', 'ROLE_UNAVAILABLE', 'ROLE_EXPIRED',
  'SOURCE_UNVERIFIED', 'CURSOR_ROLE_CONFLICT', 'ROLE_CALL_FAILED']);

// A discoverable projection of the shared wire contract, not its validator or
// authority. CursorRoleChannel still injects identity, validates with Core and
// checks the current role/task/Run inside the real ProtocolStore transaction.
function payloadSchemas(phase) {
  const report = (stage, data) => object({ taskId: { ...string(), description: 'Copy taskId from context_guard_context; do not create another task.' },
    stage: { const: stage }, data: object(data) });
  const check = object({ testId: string(), todoId: string(), status: { enum: ['passed', 'failed', 'incomplete'] },
    evidenceRef: string(), reproductionRef: string() }, ['testId', 'todoId', 'status', 'evidenceRef']);
  check.if = { properties: { status: { const: 'failed' } }, required: ['status'] };
  check.then = { required: ['reproductionRef'] };
  return {
    'object.read': object({ ref: string(), version: { ...string(4096), description: 'Read the exact immutable version returned by context or object.put.' } }),
    'object.put': object({ kind: { enum: phase === 'plan' ? ['plan'] : phase === 'ci' ? ['evidence'] : ['evidence', 'ciTodo', 'experience'] },
      ref: { ...string(), description: 'Append a nonempty suffix to the writePrefix returned by context_guard_context.' },
      baseVersion: { type: 'string', maxLength: 4096, description: 'Required: use the empty string "" for the first version, not null. For updates, use the last returned version; never guess it.' },
      content: { type: 'object', additionalProperties: true, description: phase === 'plan'
        ? 'Plan JSON object with steps, paths, validation and acceptance. Do not serialize it as a string. Writing this object does not report or approve the Plan.'
        : 'Evidence, CI TODO or experience JSON object; never serialize it as a string.' } }),
    ...(phase === 'ci' ? {
      'ci.result': object({ taskId: string(), sourceSha, verdict: { enum: ['passed', 'failed', 'incomplete'] },
        checks: { type: 'array', minItems: 1, maxItems: 100, items: check } }),
    } : {
      'task.report': { oneOf: phase === 'plan'
        ? [report('planReady', { planRef: string(), planVersion: { ...string(4096), description: 'Copy data.version from the successful Plan object.put response.' }, sourceSha })]
        : [report('progress', { seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, summary: string(2000) }),
          report('handoff', { sourceSha, ciTodoRef: string(), unitTestRefs: refs(), experienceRefs: refs() })] },
    }),
  };
}

function exchangeSchema(phase) {
  const payloads = payloadSchemas(phase);
  return { ...object({ id: { ...string(), description: 'Stable protocol message ID. Replay an uncertain request unchanged; a saved ID cannot be reused for another payload.' },
    type: { type: 'string', enum: Object.keys(payloads) }, payload: { type: 'object' } }),
  oneOf: Object.entries(payloads).map(([type, payload]) => ({ properties: { type: { const: type }, payload } })) };
}

function wireErrorField(cause, type, phase) {
  // Only Core's known validation labels are exposed. Never forward arbitrary
  // provider messages, object values, private paths or unknown caller fields.
  if (!(cause instanceof ProtocolError) || cause.code !== 'INVALID_ARGUMENT') return;
  const fields = new Map(['id', 'type', 'payload'].map(field => ['Invalid message.' + field, field]));
  const payload = payloadSchemas(phase)[type];
  if (!payload) return fields.get(cause.message);
  fields.set('Invalid payload', 'payload'); fields.set('Invalid payload fields', 'payload');
  for (const field of Object.keys(payload.properties || {})) fields.set('Invalid payload.' + field, 'payload.' + field);
  for (const branch of payload.oneOf || []) {
    for (const field of Object.keys(branch.properties)) fields.set('Invalid payload.' + field, 'payload.' + field);
    for (const field of Object.keys(branch.properties.data.properties)) fields.set('Invalid payload.' + field, 'payload.data.' + field);
  }
  if (type === 'ci.result') {
    for (const field of Object.keys(payload.properties.checks.items.properties)) fields.set('Invalid payload.' + field, 'payload.checks[].' + field);
    fields.set('Invalid failed check reproduction', 'payload.checks[].reproductionRef');
  }
  return fields.get(cause.message);
}

function toolError(cause, type, phase) {
  // Provider/internal error codes are data too; truncation is not redaction.
  const code = errorCodes.has(cause.code) ? cause.code : 'ROLE_CALL_FAILED';
  const field = wireErrorField(cause, type, phase);
  return { error: { code, ...(field ? { field, message: field === 'payload.baseVersion'
    ? 'payload.baseVersion must be a string: use "" for the first write, or the exact previous version for an update. See tools/list; keep the original task.'
    : `Invalid ${field}; follow the phase-specific payload schema in tools/list. Keep the original task; do not substitute an approval or vendor-only Plan.` }
    : { message: 'Role operation denied or unavailable; keep the original task and request ID' }) } };
}

const tools = phase => [
  { name: 'context_guard_context', description: 'Read the fixed task identity, phase, source revision and immutable object references. Use writePrefix for own objects.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'context_guard_exchange', description: 'Exchange a stable-ID message with the original Coordinator task. The credential fixes identity and permissions; approval is never an agent operation.',
    inputSchema: exchangeSchema(phase), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
];

async function readInput(req) {
  const chunks = []; let bytes = 0;
  await new Promise((resolve, reject) => {
    const finish = cause => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
      if (cause) { req.resume(); reject(cause); } else resolve();
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) finish(Object.assign(new Error('MCP message exceeds the limit'), { rpcCode: -32600, status: 413 }));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const error = () => finish(Object.assign(new Error('MCP request transport failed'), { rpcCode: -32600, status: 400 }));
    const aborted = () => finish(Object.assign(new Error('MCP request was interrupted'), { rpcCode: -32600, status: 400 }));
    const timer = setTimeout(() => finish(Object.assign(new Error('MCP request timed out'), { rpcCode: -32600, status: 408 })), 10000);
    timer.unref();
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { invalid('Invalid JSON', -32700); }
}

// Narrow Streamable HTTP subset, no SSE or server-to-client requests. Credentials
// are pre-delegated through Cursor's inline MCP headers, not OAuth discovery.
// This handler cannot issue capabilities or operate the provider/admin APIs.
export function createCursorRoleMcpHandler({ channel, projectId, endpoint, allowLoopback = false }) {
  const url = new URL(endpoint);
  if (!channel || !projectId || url.username || url.password || url.search || url.hash || url.protocol !== 'https:' &&
      !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Use the configured HTTPS role MCP endpoint');
  return async (req, res) => {
    let input;
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      const incoming = new URL(req.url, url.origin);
      if (incoming.origin !== url.origin || incoming.pathname !== url.pathname || incoming.search || incoming.hash || req.headers.host !== url.host) invalid('Use the exact role MCP endpoint', -32600, 403);
      // Native provider only; no browser authority, CORS or trusted Host fallback.
      if (req.headers.origin || req.headers.cookie) invalid('MCP is not a browser endpoint', -32600, 403);
      const authorization = req.headers.authorization || '';
      if (!/^Bearer cgc_[A-Za-z0-9_-]{43}$/.test(authorization)) invalid('Scoped role authorization required', -32600, 401);
      const token = authorization.slice(7), headerVersion = req.headers['mcp-protocol-version'];
      if (headerVersion && !versions.has(headerVersion)) invalid('Unsupported MCP protocol version');
      if (req.method !== 'POST') {
        await channel.withLease(token, lease => {
          if (lease.scope.projectId !== projectId) invalid('Delegation belongs to another project', -32600, 403);
        }, { active: false });
        return send(405, { error: { code: 'METHOD_NOT_ALLOWED' } }, { Allow: 'POST' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) invalid('Expected application/json', -32600, 415);
      const accept = String(req.headers.accept || '').split(',').map(value => value.trim().split(';')[0]);
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) invalid('Accept JSON and event streams', -32600, 406);
      // Authenticate before reading a potentially large request. Dormant CREATE
      // leases permit discovery but never access to private business context.
      await channel.withLease(token, lease => {
        if (lease.scope.projectId !== projectId) invalid('Delegation belongs to another project', -32600, 403);
      }, { active: false });
      input = await readInput(req);
      if (!record(input) || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || input.method.length > 128 ||
          Object.keys(input).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
          input.id !== undefined && !idValid(input.id)) invalid('Expected one JSON-RPC request or notification', -32600);
      if (input.method === 'initialize') {
        const p = input.params;
        if (input.id === undefined || !record(p) || typeof p.protocolVersion !== 'string' || p.protocolVersion.length > 40 ||
            !record(p.capabilities) || !record(p.clientInfo) || typeof p.clientInfo.name !== 'string' || typeof p.clientInfo.version !== 'string') invalid('Expected MCP initialization');
        const state = await channel.mcpSession(token, { projectId, action: 'initialize', protocolVersion: p.protocolVersion });
        return send(200, { jsonrpc: '2.0', id: input.id, result: { protocolVersion: state.protocolVersion,
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'context-guard-cursor-role', version: '0.1.0' } } });
      }
      if (input.method === 'notifications/initialized') {
        if (input.id !== undefined || !emptyParams(input.params)) invalid('Expected initialized notification');
        await channel.mcpSession(token, { projectId, action: 'initialized', protocolVersion: headerVersion });
        return send(202);
      }
      const state = await channel.mcpSession(token, { projectId, action: 'check', protocolVersion: headerVersion });
      if (input.id === undefined) {
        if (input.method !== 'notifications/cancelled' || !record(input.params) || !idValid(input.params.requestId)) invalid('Unsupported notification', -32600);
        return send(202); // Never cancel a committed protocol write on disconnect.
      }
      if (input.method === 'ping') {
        if (!emptyParams(input.params)) invalid('Expected empty ping parameters');
        return send(200, { jsonrpc: '2.0', id: input.id, result: {} });
      }
      if (input.method === 'tools/list') {
        if (!emptyParams(input.params)) invalid('This fixed tool list has no pagination');
        return send(200, { jsonrpc: '2.0', id: input.id, result: { tools: tools(state.phase) } });
      }
      if (input.method !== 'tools/call') invalid('Method not found', -32601, 200);
      const p = input.params;
      if (!record(p) || Object.keys(p).some(key => !['name', 'arguments', '_meta'].includes(key)) ||
          !tools(state.phase).some(tool => tool.name === p.name) || !record(p.arguments)) invalid('Unknown tool or invalid arguments');
      if (p.name === 'context_guard_context' && Object.keys(p.arguments).length) invalid('Context has no caller-selected identity');
      let result;
      try {
        if (p.name === 'context_guard_context') {
          result = await channel.context(token);
        } else result = await channel.exchange(token, p.arguments);
      } catch (cause) {
        const error = toolError(cause, p.name === 'context_guard_exchange' ? p.arguments.type : undefined, state.phase);
        return send(200, { jsonrpc: '2.0', id: input.id, result: { isError: true, content: [{ type: 'text',
          text: JSON.stringify(error) }], structuredContent: error } });
      }
      return send(200, { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
    } catch (cause) {
      const status = cause.code === 'ROLE_EXPIRED' ? 401 : cause.status || 500;
      return send(status, { jsonrpc: '2.0', id: idValid(input?.id) ? input.id : null, error: {
        code: cause.rpcCode || -32000, message: cause.rpcCode ? cause.message : 'Cursor role authorization is unavailable',
      } }, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
    }
  };
}
