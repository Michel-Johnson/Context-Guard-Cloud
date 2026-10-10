// 渠道专用契约；不依赖 Cloud 工具目录或共享角色生成物。
export const slackReactionEmojis = Object.freeze(['thumbsup', 'heart', 'smile', 'clap', 'tada', 'raised_hands',
  'thinking_face', 'muscle', 'wave', 'pray', 'handshake', 'fire', 'rocket', 'bulb', 'joy', 'sweat_smile', 'sunglasses']);
export const slackStatusEmojis = Object.freeze({ received: 'eyes', silent: 'see_no_evil', reply: 'speech_balloon', completed: 'white_check_mark', failed: 'warning', stopped: 'stop_sign' });
export const SLACK_INTERACTION_POLICY = '\n[Slack 交流方式]\n代码已负责原消息的接收、接话与回复完成状态表情，不要重复调用状态表情；对勾不代表任务完成或人类批准。普通交流优先给有用的短文字，用户明确要求原生交流表情时才使用react_to_user。表情可以与简短正文同轮出现，正文也可适度使用 emoji；问题、解释、风险、失败和必要确认必须保留有用文字，不能只用表情。只有用户明确要求只用表情时才省略文字，这属于接话，不是静默。每条原消息至多两个交流表情，不为凑数或提高频率而调用。交流热情不改变当前受众和接话判断，不抢别人话题、不自行执行新任务。工具查询和后续回答可正常多次调用模型，不额外拆出分类调用，不为补一个表情单独重写已完成正文。';
