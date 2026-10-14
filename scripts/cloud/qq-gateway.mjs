import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const account = value => typeof value === 'string' && /^[1-9]\d{4,15}$/.test(value);

export function validateQqConfig(input) {
  if (!keys(input, ['token', 'accountId', 'projectIds', 'defaultProjectId', 'friendChat']) ||
      (input.friendChat !== undefined && typeof input.friendChat !== 'boolean') ||
      typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 256 || !account(input.accountId) ||
      !Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) ||
      new Set(input.projectIds).size !== input.projectIds.length || !input.projectIds.includes(input.defaultProjectId)) {
    fail('INVALID_QQ_CONFIG', 'Configure an independent credential, QQ account and projects', 503);
  }
  return structuredClone(input);
}

// Only this authenticated adapter may assert a scene. Identity always comes
// from private configuration, never from message text or a supplied actor.
export function createQqGateway({ config, createConversation, submit, state, listProjects, friendConversation }) {
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
    if (route.startsWith('/api/integrations/qq/chat/')) {
      if (!verified.friendChat || !friendConversation) fail('FORBIDDEN', 'Friend chat is not enabled', 403);
      if (!keys(input, ['scene', 'id', 'text']) || !keys(input.scene, ['kind', 'peerId']) ||
          input.scene.kind !== 'private' || !account(input.scene.peerId) || input.scene.peerId === verified.accountId ||
          typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) fail('INVALID_ARGUMENT', 'Use a private friend scene without project access');
      if (!['/api/integrations/qq/chat/submit', '/api/integrations/qq/chat/state'].includes(route)) fail('NOT_FOUND', 'Unknown chat route', 404);
      if (route.endsWith('/submit') && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000)) fail('INVALID_ARGUMENT', 'Provide text up to 8000 characters');
      const peer = input.scene.peerId, id = `qq-chat-${digest(JSON.stringify([verified.accountId, peer, input.id]))}`;
      const service = await friendConversation(peer);
      if (route.endsWith('/submit')) {
        await service.submit({ id, text: input.text }, { source: 'human', actor: { kind: 'human', integration: 'qq', userId: peer,
          sessionId: `qq-friend:${verified.accountId}:${peer}`, channelId: `private:${peer}` } });
      }
      return requestReply(await service.state(), id);
    }
    const target = scope(input);
    if (route === '/api/integrations/qq/submit') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) fail('INVALID_ARGUMENT', 'Provide a nonempty message up to 8000 characters');
      await createConversation(target);
      await submit(target, input.text);
    } else if (route !== '/api/integrations/qq/state') fail('NOT_FOUND', 'Unknown QQ route', 404);
    return requestReply(await state(target), target.id);
  };
}

function requestReply(result, id) {
    const messages = result.messages || [], index = messages.findIndex(message => message.role === 'user' && message.requestId === id);
    const following = index < 0 ? [] : messages.slice(index + 1);
    const nextUser = following.findIndex(message => message.role === 'user');
    const replies = (nextUser < 0 ? following : following.slice(0, nextUser)).filter(message => message.role === 'assistant' && message.text && !message.partial)
      .map(({ id, text }) => ({ id, text }));
    return { accepted: result.acceptedRequestIds?.includes(id) || index >= 0,
      status: result.status, complete: index >= 0 && !result.activeTurnId && ['waiting-for-user', 'idle'].includes(result.status),
      replies, ...(result.error ? { error: { code: result.error.code } } : {}) };
}
