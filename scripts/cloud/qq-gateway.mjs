import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const account = value => typeof value === 'string' && /^[1-9]\d{4,15}$/.test(value);

export function validateQqConfig(input) {
  if (!keys(input, ['token', 'accountId', 'projectIds', 'defaultProjectId']) ||
      typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 256 || !account(input.accountId) ||
      !Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) ||
      new Set(input.projectIds).size !== input.projectIds.length || !input.projectIds.includes(input.defaultProjectId)) {
    fail('INVALID_QQ_CONFIG', 'Configure an independent credential, QQ account and projects', 503);
  }
  return structuredClone(input);
}

// Only this authenticated adapter may assert a scene. Identity always comes
// from private configuration, never from message text or a supplied actor.
export function createQqGateway({ config, createConversation, submit, state, listProjects }) {
  const verified = validateQqConfig(config);
  const authenticate = req => {
    if (req.headers.origin) fail('FORBIDDEN', 'QQ adapter is not a browser API', 403);
    const expected = Buffer.from(`Bearer ${verified.token}`), supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('UNAUTHORIZED', 'QQ adapter credential required', 401);
  };
  const scope = input => {
    if (!keys(input, ['projectId', 'scene', 'id', 'text']) || !keys(input.scene, ['kind', 'peerId']) ||
        !['private', 'group'].includes(input.scene.kind) || !account(input.scene.peerId) ||
        typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) fail('INVALID_ARGUMENT', 'Provide a valid scene and stable request ID');
    const projectId = input.projectId || verified.defaultProjectId;
    if (!verified.projectIds.includes(projectId)) fail('FORBIDDEN', 'Project is not connected to QQ', 403);
    const channelId = `${input.scene.kind}:${input.scene.peerId}`;
    const conversationOperation = `qq-${digest(JSON.stringify([verified.accountId, projectId, channelId]))}`;
    return { projectId, conversationOperation, id: `qq-${digest(JSON.stringify([verified.accountId, input.id]))}`,
      actor: { kind: 'human', integration: 'qq', userId: verified.accountId, sessionId: `qq:${verified.accountId}`, channelId } };
  };
  return async (req, route, input) => {
    authenticate(req);
    if (route === '/api/integrations/qq/projects') {
      if (req.method !== 'GET') fail('METHOD_NOT_ALLOWED', 'Use GET', 405);
      return { defaultProjectId: verified.defaultProjectId, projects: await listProjects(verified.projectIds) };
    }
    if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Use POST', 405);
    const target = scope(input);
    if (route === '/api/integrations/qq/submit') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) fail('INVALID_ARGUMENT', 'Provide a nonempty message up to 8000 characters');
      await createConversation(target);
      await submit(target, input.text);
    } else if (route !== '/api/integrations/qq/state') fail('NOT_FOUND', 'Unknown QQ route', 404);
    const result = await state(target);
    const messages = result.messages || [], index = messages.findIndex(message => message.role === 'user' && message.requestId === target.id);
    const following = index < 0 ? [] : messages.slice(index + 1);
    const nextUser = following.findIndex(message => message.role === 'user');
    const replies = (nextUser < 0 ? following : following.slice(0, nextUser)).filter(message => message.role === 'assistant' && message.text && !message.partial)
      .map(({ id, text }) => ({ id, text }));
    return { accepted: result.acceptedRequestIds?.includes(target.id) || index >= 0,
      status: result.status, complete: index >= 0 && !result.activeTurnId && ['waiting-for-user', 'idle'].includes(result.status),
      replies, ...(result.error ? { error: { code: result.error.code } } : {}) };
  };
}
