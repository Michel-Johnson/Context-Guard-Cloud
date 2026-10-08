const timestamp = value => typeof value === 'string' && value.length <= 40 && /^\d+\.\d+$/.test(value);
const fail = () => { throw Object.assign(new Error('Invalid bounded Slack history snapshot'), { code: 'INVALID_ARGUMENT', status: 400 }); };

// Only the verified integration batch supplies these records. Speakers remain
// reference data, never actor metadata or additional native conversation turns.
export function validateSlackHistory(history, { projectId } = {}) {
  if (history === undefined) return undefined;
  if (!Array.isArray(history) || history.length > 24) fail();
  const seen = new Set(); let scopeKey, previous = -1, characters = 0;
  return history.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['ts', 'speaker', 'text', 'scope'].includes(key)) ||
        !timestamp(item.ts) || typeof item.speaker !== 'string' || !item.speaker || item.speaker.length > 80 ||
        typeof item.text !== 'string' || !item.text || item.text.length > 1000) fail();
    const scope = item.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['channel', 'threadTs', 'beforeTs', 'projectId'].includes(key)) ||
        !/^[CGD][A-Z0-9]{1,79}$/.test(scope.channel || '') || !timestamp(scope.beforeTs) ||
        scope.threadTs !== null && !timestamp(scope.threadTs) ||
        typeof scope.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope.projectId) || projectId !== undefined && scope.projectId !== projectId ||
        Number(item.ts) >= Number(scope.beforeTs) || scope.threadTs && Number(item.ts) < Number(scope.threadTs)) fail();
    const frozenScope = { channel: scope.channel, threadTs: scope.threadTs, beforeTs: scope.beforeTs, projectId: scope.projectId };
    const key = JSON.stringify(frozenScope);
    if (scopeKey !== undefined && scopeKey !== key || seen.has(item.ts) || Number(item.ts) < previous) fail();
    scopeKey = key; seen.add(item.ts); previous = Number(item.ts); characters += item.text.length;
    if (characters > 24000) fail();
    return { ts: item.ts, speaker: item.speaker, text: item.text, scope: frozenScope };
  });
}
