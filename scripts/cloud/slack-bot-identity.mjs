// Bot讨论权限独立于真人审批；真实身份只由已鉴权的Slack网关提供。
export const BOT_DISCUSSION_TOOLS = Object.freeze(['read_map', 'read_reference', 'get_execution_capabilities']);
const user = value => /^[UW][A-Z0-9]{1,31}$/.test(value || '');
const bot = value => /^B[A-Z0-9]{1,31}$/.test(value || '');
export function validateDiscussionBots(value = []) {
  if (!Array.isArray(value) || value.length > 20 || new Set(value.map(x => x?.userId)).size !== value.length ||
      value.some(x => !x || Object.keys(x).some(k => !['userId', 'botId', 'projectIds', 'channelIds'].includes(k)) ||
        !user(x.userId) || !bot(x.botId) || !Array.isArray(x.projectIds) || !x.projectIds.length || x.projectIds.length > 100 ||
        x.projectIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) ||
        !Array.isArray(x.channelIds) || !x.channelIds.length || x.channelIds.length > 20 ||
        x.channelIds.some(id => !/^[CG][A-Z0-9]{1,31}$/.test(id)))) {
    throw Object.assign(new Error('Bot讨论需明确平台身份、项目及频道范围'), { code: 'INVALID_INTEGRATION_CONFIG', status: 400 });
  }
  return value;
}
export const isVerifiedSlackBot = actor => actor?.kind === 'bot' && actor.integration === 'slack' &&
  /^[TE][A-Z0-9]{1,31}$/.test(actor.teamId || '') && user(actor.userId) && bot(actor.botId) &&
  /^[CG][A-Z0-9]{1,31}$/.test(actor.channelId || '') && actor.sessionId === `slack-bot:${actor.teamId}:${actor.userId}`;
export const discussionTools = (tools, actor) => actor?.kind === 'bot'
  ? tools.filter(tool => BOT_DISCUSSION_TOOLS.includes(tool.name)) : tools;
export const isSlackBotMessage = event => ['message', 'app_mention'].includes(event?.type) && !event.hidden &&
  /^B[A-Z0-9]{1,31}$/.test(event.bot_id || event.bot_profile?.id || '') &&
  (!event.subtype || ['bot_message', 'file_share'].includes(event.subtype));
