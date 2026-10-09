// 渠道专用契约；不依赖 Cloud 工具目录或共享角色生成物。
export const slackReactionEmojis = Object.freeze(['thumbsup', 'heart', 'smile', 'clap', 'tada', 'raised_hands',
  'thinking_face', 'muscle', 'wave', 'pray', 'handshake', 'fire', 'rocket', 'bulb', 'joy', 'sweat_smile', 'sunglasses']);
export const slackStatusEmojis = Object.freeze({ received: 'eyes', silent: 'see_no_evil', reply: 'speech_balloon', completed: 'white_check_mark', failed: 'warning', stopped: 'stop_sign' });
export const SLACK_INTERACTION_POLICY = '\n[Slack 交流方式]\n默认用简短文字回应，包括问候、确认收到和继续接话；不要只回表情，不每轮追加表情。只有用户明确要表情或确有必要表达认可、感谢时，才用 react_to_user，通常一个即可。问题、解释、风险、失败和人工确认必须保留有用文字。用户明确只要原生表情且无需正文时可只用交流表情，不能输出占位正文。接收、处理中和回复完成的状态表情由代码负责，不重复调用，也不把对勾当作任务完成或人类批准。每条原消息仍至多两个交流表情，不凑数、不刷屏、不抢别人话题、不自行执行新任务。工具查询可正常续轮，不额外拆出分类调用，不为补表情重新生成已完成正文。';
