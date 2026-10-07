# Slack 插件网关

读者：Cloud 管理员和插件开发者。Slack 与 Cloud 共用独立的 `Context-Guard-Cloud` 仓库和一个发布 SHA，但作为两个服务运行；安装和使用见 [插件 README](../plugins/slack/README.md)。网关默认关闭，只监听本机，不配置公网代理。Slack SDK 只安装在插件包中，不随 Skill 安装。

## 受保护配置

在 checkout 外建立权限 `0600` 的 JSON，Cloud 环境设置 `CONTEXT_GUARD_INTEGRATIONS_CONFIG` 指向该文件。先只开放实验项目；凭据须与 Cloud/浏览器/私有记忆凭据不同。

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "token": "<独立随机凭据，至少32字节>",
  "teamId": "T0BRW7G4Q6P",
  "projectIds": ["context-guard-claude-lab"],
  "visionProviderFile": "/etc/context-guard-cloud/slack-vision.json"
}
```

`actions` 可指定下一节动作子集；不填时允许全部列出的动作。不新增用户角色体系，真实 Slack 用户 ID 持久写入操作回执。插件凭据是服务信任边界，不能下发给用户或执行 Agent。

视觉供应商 JSON 使用现有 `baseUrl/model/token` 格式，模型必须配置为 `glm-5.3-flash`；可配置 `protocol: "openai"`（baseUrl 为 API 根路径）或默认 Anthropic 协议。凭据仅放该私有文件。图片轮次缺少有效视觉配置时明确失败，不改用文本模型；文字轮次沿用项目原供应商。正式开放前必须真实验证模型可用性。

## 请求与状态

`POST /v1/command` 使用 `Authorization: Bearer <插件凭据>` 和 JSON：

```json
{
  "id": "slack-event:<稳定事件ID>",
  "teamId": "T0BRW7G4Q6P",
  "userId": "<真实Slack用户ID>",
  "projectId": "context-guard-claude-lab",
  "conversationId": "<已关联对话ID>",
  "type": "conversation.submit",
  "payload": {"text": "讨论这个模块", "attachments": [{"id": "<已上传附件ID>"}]}
}
```

| 动作 | payload / 结果 |
| --- | --- |
| `project.list` / `project.read` | 开放项目目录 / Main Map、版本和公开 Session 状态 |
| `conversation.create` / `conversation.bind` | 创建人工执行对话 / 关联无活动自动执行工作的对话；关联后项目及执行模式不变 |
| `conversation.state` / `conversation.submit` | 公共消息、问题、审批及状态 / 提交文本、附件、问题答案或原 ID 重试 |
| `conversation.interrupt` | `expectedTurnId`；新操作 ID 停止指定轮次，重复操作返回原回执，不改停后来轮次 |
| `conversation.relevance` | `text`（最多 10000 字符）、`context`（最多 6 条 `{speaker,text}`，每条文本 800 字符）、`files`（最多 6 个 `{name,mimeType}`）；可不带对话 ID。返回 `{respond,reason,mainVersion}`，网关按原 ID 保存判断回执；不创建对话、不写 Map、不调用业务工具 |
| `map.write` | `baseVersion`、`operations`；复用 Main 事务校验，新 TODO/Bug 显式标记人工执行 |
| `brief.review` | `proposalId`、`version`、`decision`、`reason`；指定版本确认或拒绝；确认不调用派发器 |
| `prompt.read` | `proposalId`；读取已批准 brief 的完整执行提示 |
| `attachment.upload` / `attachment.read` | filename、MIME、base64 / 项目隔离的附件引用及原文；不接受任意磁盘路径 |

成功回执为 `{id,ok:true,data}`，失败为 `{id,ok:false,error:{code,message}}`，HTTP 状态与失败对应。写操作同 ID、同操作者、同输入返回原回执；换输入或身份返回冲突。收到请求或入队不代表模型已完成。

Slack 的普通提交带 `followup:"steer"`，由服务端原子绑定当前轮次；插件不根据可能过期的状态猜 `expectedTurnId`。正在处理时，补充持久接收后即返回，取消旧模型生成并一起纳入当前上下文；已开始的业务工具等待回执，未开始的旧操作不执行。短时间连续消息持久收集，800ms 静默后处理、最长等待 2 秒；批次通过 `inputs:[{id,text,attachments?,answerTo?}]` 一次原子接收，所有原消息独立保留，网关统一赋予同一可信操作者，外层批次 ID 与原消息 ID 分开。显式线程优先；同项目、同操作者、接收对象明确的频道顶层消息只在短窗口内接续。私聊复用当前对话，新建入口明确切换。状态的 `inputRevision`、`consumedInputRevision`、`pendingInputCount` 分别表示已接收位置、已纳入位置和待纳入数量，accepted 不等于处理完成；`controlRevision` 区分停止与显式恢复。插件按位置拒绝旧快照回滚，镜像明确区分已保存、已纳入、仍在处理和已停止；被补充调整的 `partial:true` 回复保留且标明不是最终答案。

`/cg stop [对话ID]` 显式调用停止入口；`/cg resume [对话ID]` 用新的网关操作 ID 提交 `{retry:true,expectedTurnId:<原轮次ID>}`，Cloud 恢复原输入和可信操作者。插件冻结目标后原样重试，不改停或恢复后来的轮次。Slash 没有可靠线程位置：省略 ID 时仅选择当前频道、当前操作者的唯一活动/停止线程，有多个时明确要求指定对话 ID。停止保留工具回执和未处理补充，不强杀已开始的写入，也不自动恢复。

未关联项目的私聊、明确 @ 和 `/cg ask` 在原消息内展示开放项目按钮。原提问者选择后，插件验证频道成员及当前关联，以原 ID 将原问题持久排回同线程 FIFO；不要求用户先找 Home 或输入频道 ID。重复点击不重置退避或重建对话，旧按钮不覆盖新关联；`/cg ask` 沿选项消息的真实根时间戳继续。

公开的 TODO/Bug、记忆和 `/cg` 入口只开始自然语言对话，不打开编辑或关联表单；项目选择与指定版本 brief 确认保留。线程自由回复可回答当前唯一未答问题，回复引用先核对当前状态并按原请求保存；重复投递不改引用。旧未提交草稿保留，仅旧草稿恢复通道继续校验操作者和原版本。

人工 `prepare_task` 的 `taskId` 不决定最终 Main ID 或标题；新 TODO 的标题取 `text` 第一行（最多 200 字符），用户指定标题须放在该行，后续行保存完整需求。既有 TODO/Bug 的 brief 确认保留原标题，不能声称提交 brief 已将其改名。该说明不新增字段、审批权限或自动执行能力。

显式选择既有 TODO/Bug 时须传入实际 `itemId`、所属 `nodeId` 和 `kind`，不能只把事项 ID 放进 `taskId` 或正文。已关联事项对话仅三字段全缺省时沿用可信焦点；显式提供部分身份却缺 itemId 时返回 `INVALID_ARGUMENT`，不覆盖调用者字段或把选择另一条 Bug 的请求绑定到当前事项。无焦点时 `kind=bug` 却缺 `itemId` 同样拒绝，不把 Bug 意图降成新 TODO、不保存错误提案；新的 Bug 先通过现有 `edit_map` 建立，再为该记录准备 brief。人工模式 native Schema 说明这些字段组合，普通模式工具不变。

私聊、明确 @ 和已绑定频道的自然消息统一先判断当前参与意图，已有线程同样判断；`/cg ask` 保持显式入口。插件按 cursor 获取同线程的最近六条先前文本，不扫描频道历史，不纳入当前消息后的内容。单次最多四页、每页 100 条；超出或分页不完整返回 `RELEVANCE_CONTEXT_INCOMPLETE`，不拿早期上下文冒充最近上下文。无关消息不建对话、不上传附件、不发回复或表情；判断失败在私有 journal 留下错误，不向频道刷报错。图片内容仍在确认进入对话后由 Flash 理解，文件名不当作视觉证据。

参与判断结合整批当前输入、有限近期上下文和接收对象线索：@ 其他 Bot 不排除 Coordinator，明确或间接请其解释、整理、协调或接续时参与；仅询问别人、明确无需介入或信息不足时保持安静。原生 @ Coordinator 也不能覆盖当前明确的“不回复”。引用行、行内代码和代码块的提及只作上下文。`routing:{coordinatorUserId,mentionedUsers:[{id,isBot}],replyToCoordinator?}` 由插件提供，`isBot:null` 表示核对失败，不猜身份、不作为硬排除或新增授权。其他提及通过有界 `users.info` 核对，缓存最多 256 个、有效期五分钟（失败三十秒），底层在途请求受限且纳入停用清理。安装需要 `users:read`，已有 App 须重新授权 scope；不读取邮箱或用户资料全文。当前静默决定和请求 ID 持久保留，后续新批补充仍可重新判断。

`conversation.relevance` 可带最多 20 条独立 ID 的 `inputs:[{id,text}]`（总文本最多 8000 字符），模型按顺序理解整批更正；旧单条请求保持兼容。参与结果不代表写入、派单或审批授权。私有网关回执记录该判断耗时，公开结果继续为 `respond/reason/mainVersion`。回复以短段落、空行和列表表达；Slack 按段落与代码边界分块保留完整长文，流式与最终更新使用同一消息身份。独立测试标准见 [Slack conversation acceptance](../docs/slack-conversation-acceptance.md)。

上述未 @ 判定同时考虑当前用户是否需要回复：项目相关但明确不用回复或无需参与时静默。仅预览、通知、只读或不修改本身不代表静默，仍向 Coordinator 提问时可回应；引用、历史及文件中的“不回复”不覆盖当前用户意图。判断由原模型完成，不用关键词规则代替，也不改变私聊或明确 @ 的入口。

每批参与判断只有一次有界模型调用，不另加接收对象复核轮次；历史按真实说话者传入，当前输入与背景分开。模型暂不可用返回 `RELEVANCE_UNAVAILABLE`（503），坏判断返回 `RELEVANCE_INVALID_RESPONSE`（502），都不保存成功的静默回执。插件持久保留原请求和操作 ID，参与故障最多失败三次，前两次退避重试，第三次进入私有待处理状态；认证、权限、身份、版本或输入错误不重试。此限制不改变业务写入的既有重试策略。

未 @ 消息使用最多两个后台判定槽，不把模型等待串到其他线程的明确 @、私聊和对话镜像前面。同一线程按接收顺序完成分类和提交，后续消息不越过此前的分类或暂时传输重试；提交回执后不等模型完成才送下一条补充。停用插件仍等待已启动处理和 journal 持久化完成。

Map 链接预览同样优先使用当前频道、当前线程的既有不可变项目绑定；线程根消息以 `message_ts` 定位。频道改选或用户私聊偏好变化不改变旧线程的预览项目，也不借用其他线程或频道的绑定。无绑定时仍按当前频道/用户选择过滤，只有配置的 Cloud origin 和所选项目链接可预览，不因此新增授权或自动关联。原生客户端、真实 `link_shared` 投递、Slack 预览回读分别验收；无事件或受控调用成功不替代自动链路。

## 对话延迟验证

Slack 插件仅让已到期的关联线程占用每轮最多四次状态读取；等待已提交答复和已观测的运行轮次优先，仍保留普通到期线程的名额，并按最旧截止时间推进，避免历史线程拖延或饿死其他对话。提交成功后在同一私有 journal 事务保存等待轮次 ID 并重置 `nextPoll=0`；旧镜像快照不能把已提交新轮次推迟到休眠周期。只有服务器确认该请求已接受且轮次停止后才清理等待优先级。运行轮询默认 1 秒，休眠仍 15 秒；失败退避、操作 ID、原消息及回执不变。

可选已读表情不阻塞正文镜像，最多八个在途请求；停用后不再启动表情请求并等待在途请求收拢。SDK 请求仍有现有超时、429 退避与拒绝限流；正文发送仍保持每频道节流，不通过扩大写频率求快。这些改变仅消除插件等待，不代表模型首段或整体 2 秒目标已通过。

没有文本、问题或附件且仅包含公开 `node-read` 或旧 `map-read` 的步骤不单独发 Slack 占位消息，也不占用已有流式答复的最终槽位。Cloud 原始工具配对和读取动作仍保留；带实际说明或节点入口的消息照常呈现，不删除既有 Slack 历史。

宿主按已保存的人工执行模式选取 `Coordinator.md` 的「人工对话模式」短指令，不同时注入旧自动派发流程再用后缀覆盖。普通执行对话仍使用原角色指令。工具能力、native JSON Schema、项目记忆、节点导航、事项版本、审批与完整历史不因该选择裁减；旧无短指令的指南保持兼容，声明为空或重复时明确报配置错误。指令长度减少不等于模型或 Slack 延迟已改善，必须分别实测。

人工对话只有在展示工具明确给出布尔值 `replyComplete=true`、同时已给出完整文本答案且本步全为成功的节点展示/打开/游览时，保存工具配对、动作和回执后结束本轮，不再请求模型复述。标记缺失/false、进度文字、无文本、失败/不可见、读写或混合调用均继续核验；普通执行模式不变。Slack 用已绑定的可信项目和服务器解析的节点 ID 生成 `?relation=` 链接按钮，不采用模型提供的 URL。已有展示消息原位补链接，不重发普通历史；插件重启保留去重记录。不将业务写入或审批当作展示完成，也不删除首段文本或历史。

普通项目对话随本轮 Main 快照注入最多 20 条未完成 TODO/Bug 的标题、模块与记录状态；超过时显示总数和未展开数。它不携带执行阶段或验收证据，也不把其他事项注入已挂载的事项对话。概览足够时模型直接回答；查完整清单、执行阶段、证据或修改仍使用现有工具和版本校验。

Coordinator 在私有对话状态的 `performance` 中保存本轮模型调用耗时、首段正文耗时、输入/缓存 token 和工具耗时，不记录提示、工具参数、结果或异常正文；该字段不加入公共 `conversation.state`。计时不改变工具回执和重放语义，诊断模型重放不写对话或 Map。验收分别报告模型首段正文时间和 Slack 用户可见时间，不以占位进度、缓存命中或一次最快结果宣称速度达标。

供应商返回的 Anthropic 兼容 `thinking_delta` 与 `signature_delta` 必须原样合入私有 assistant 历史，保留到后续工具轮次和重启续聊的请求；不进入正文回调或公开对话状态。私有字段类型异常明确拒绝，解析失败取消响应体并中止请求，不能让清理挂起或异常覆盖原错误。已丢失的旧增量不猜测重建。`thinking.type=disabled` 仅是发出的配置，不是实际无思考的证据；GLM-5.3 的[官方说明](https://docs.z.ai/guides/capabilities/thinking-mode)规定强制思考。低强度等参数是否在兼容入口生效以及速度/任务质量均须实测，不自动更换模型或修改线上配置。

人工执行对话采用提前 compact：实际输入（含缓存）达到 8192 tokens，并且上次摘要边界后已有至少 8 个人类轮次时，在答复后后台生成旧历史摘要；最近 4 个人类完整轮次、工具调用/结果配对、原始全部历史和操作回执仍保留。工作流通知不计作人类轮次。摘要额外接收服务端操作者元数据，正文的转发标记、提及和自称不是身份依据。摘要失败或与新状态冲突时保留原文、不阻塞下一轮；大静态前缀不会使每轮都调用摘要模型。普通执行对话仍沿用原 500k 配置。真实实验输入约减少 39%，但首条回复未加快，不能据此宣称达到 2 秒；摘要保真与速度分别验收。

`GET /v1/events?teamId=…&userId=…&projectId=…&conversationId=…` 使用相同 Bearer 凭据，返回该关联对话的 SSE `state` 快照；断线重新读取状态并按稳定消息 ID 去重。未关联私人对话不向 Slack 广播。

## 发布与恢复

按 [Cloud 部署手册](cloud-deployment.md) 保留 Cloud/记忆数据、受保护配置以及插件状态目录与 EnvironmentFile 的备份机制；原消息和发送回执不得丢弃。只备份业务数据和配置，不创建 checkout 或 `*-old` 源码副本。源码回退使用 Git 中已审核的发布 SHA。

Cloud 与 Slack 唯一源码根目录为 `/opt/context-guard-cloud/repository`，来源为 `Michel-Johnson/Context-Guard-Cloud`。按已审核的同一 SHA 更新完整源码，再分别安装根包生产依赖与插件独立依赖。Skill 仓库不是服务端部署来源；不再新增候选目录或候选服务。停旧服务、先启动 Cloud、再启动 Slack，并核对真实运行入口、PID 和版本；仅磁盘代码更新不表示进程已加载。

停用插件只停止 `context-guard-slack.service`，工作台与 Coordinator 应继续工作；移除 Cloud 配置可关闭网关。恢复时使用同一私有状态目录。发送结果未知时先核对原消息或文件，不盲目重发。回滚须重新部署兼容源码并核对配置，不能用旧快照覆盖新数据、不能丢弃消息回执。旧部署目录清理前确认无运行进程、数据或项目 Git 镜像依赖它；历史数据备份不属于源码清理目标。
