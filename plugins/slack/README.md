# Slack 插件

独立 Node 服务，通过 Socket Mode 连接 Jerry Family 的 Slack；只调用 Cloud 的本机插件网关。Cloud 不加载 Slack SDK，停止本服务不会停止 Coordinator。使用普通消息、Block Kit、Home 和文件 API，适用于免费工作区，不依赖 Lists 或付费 Assistant API。

## 安装

源码只从 `Michel-Johnson/Context-Guard-Cloud` 的已审核发布 SHA 部署，和 Cloud 共用同一 checkout；不能从 Skill 仓库或候选源码目录另起一份。要求 Node >= 22.19.0、npm >= 9.6.4。在插件目录执行 `npm ci --omit=dev --ignore-scripts`；依赖和 lockfile 与根包分开，下载地址固定为 npm 官方仓库。用 `app-manifest.json` 创建自建 Slack App，打开 Socket Mode，生成带 `connections:write` 的 App-level token，并将 App 安装到 Jerry Family。机器人只响应它能访问的频道，请把它邀请到使用的频道。

复制 `.env.example` 的字段到 **checkout 外**的私有 EnvironmentFile，文件权限设为 0600；配置 bot token、app token、独立插件网关 token、Cloud origin 和独立状态目录。不要把凭据填入仓库模板。先启用 Cloud 的可选 loopback 网关，再执行 `npm start`。

已有网关若显式配置 `actions` 白名单，绑定确认需要 `binding.review`，需求说明确认需要 `brief.review`。升级时逐项核对；不要因此扩大用户、项目范围或删除白名单。Socket 已连接不代表确认按钮可用，部署后须真实点击并回读保存结果。

仓库根目录的 `deploy/context-guard-slack.service` 是 system service，沿用 `context-guard` 账号：源码位于 `/opt/context-guard-cloud/repository/plugins/slack`，独立 Node 22 runtime 位于 `/opt/context-guard-slack/runtime/bin/node`；私有配置位于 `/etc/context-guard-slack.env`，状态位于 `/var/lib/context-guard-slack`，均在 checkout 外。先安装并验证该 Node runtime；模板不下载运行时。运行时路径不同可调整 unit，但 Cloud 与 Slack 必须保留一个明确源码根目录。两个服务独立启动与停止；业务状态和凭据独立备份，源码仅通过 Git/release SHA 回退，不复制源码备份。

从 Cloud 仓库根目录安装模板：

```bash
sudo install -o root -g root -m 0644 deploy/context-guard-slack.service /etc/systemd/system/context-guard-slack.service
sudo systemctl daemon-reload
sudo systemctl enable --now context-guard-slack.service
sudo systemctl show context-guard-slack.service -p WorkingDirectory -p ExecStart -p MainPID
```

## 使用

Map 总览新建项目后，Home 或原问题的搜索菜单会实时加载，不必手动加入开发列表。管理员只需首次关联 Map 与已核实的本人 Slack 账号；新增私有项目仅在本人私聊可选，不自动公开到频道。同名项目独立，改名保留对话，删除后的旧选项会被拒绝。当前频道可直接查询已开放项目，完整私有目录与自然切换仍限授权私聊。配置见[Slack 接入说明](../../references/design/design-slack-integration-v1.6.1.md)。

私聊中可以直接问“有哪些项目”或说“切换到某项目”，不用进入 Home。Coordinator 查询当前授权目录，只显示项目名称；同名时先澄清。插件成功保存后才确认切换，目标使用独立对话，原项目记录保留；在原线程继续回复也会进入目标项目。公共频道不开放此切换工具，也不因此新增权限。

可在频道输入 `/cg model`，或请 Coordinator 打开模型菜单；线程内使用原卡「打开我的模型菜单」按钮，不依赖线程不支持的 slash command。按钮以实际点击者只读获取当前目录，再经原生确认才保存选择，下一文字轮次生效；当前轮次、失败重试和图片路由不变。未知原选择须先由原操作恢复回执，不能另开选择覆盖。目录仅含已配置模型，不接受地址或凭据、不探测供应商；项目、频道、原卡与线程关联仍须校验。

卡片只展示可读模型名称，默认与本轮路由确实相同时合并一行，不重复项目 slug、供应商 ID 或整份目录；不同路由分别显示，图片保留类型。未匹配目录的真实路由明确提示未匹配，不猜名称。历史回执不代表当前默认，用打开按钮读取新目录；未知旧作者不借线程创建者，连续输入错位时按服务端 assistant 身份与原请求关联绑定。真人明确说“切到 DeepSeek”等切换要求时可直接切换已配置模型，简短确认下一文字轮次生效，不强制点菜单；询问、引用与历史资料不表示切换授权。

Coordinator 可在已进入回复的轮次，用 👍、❤️、😄、👏、🎉、🙌、🤔、💪、👋、🙏 自然回应确认收到、感谢、鼓励或共鸣；可与文字同用，也可仅加原生表情，不强制每条或刷屏。必要解释、风险、失败和人工确认仍用文字，表情不是完成或通过回执。合并策略确认需要接话后，立即对原消息添加 👀，不等完整正文；静默消息不添加。表情目标仍须来自可信原 Inbox，不借用他人、频道、旧消息或合成 Slash。

表情意图与原目标调用前保存；重复、失回和重启只恢复同一表情，精确 `already_reacted` 可确认幂等效果。未知结果最多八次指数退避；明确永久拒绝及 SDK 两次 429 重试耗尽后保留失败，不外层重试 429 或刷频道。表情共用现有八个在途槽，不阻塞文字，饱和意图保留，停用收拢在途请求。源码测试不等于真实 Slack 上线验收。

- App Home：选择项目，查看 Map、TODO/Bug 与已有 Session 状态；点击事项、TODO/Bug 或记忆入口，直接开始 Coordinator 对话，不填节点 ID、标题或状态。
- 私聊：直接说需求；未关联时在原消息选择项目。顶层消息接续当前 Cloud 对话；“开始对话”明确新建，原生线程仍沿用其固定对话。
- 首次私聊或明确 `@Coordinator`：未关联时直接显示开放项目按钮，选择后继续原问题，无需先寻找 Home 或记住命令。频道选择会关联当前频道；只能由原提问者在原消息选择，旧选项不会覆盖后来的关联。没有开放项目时明确说明配置缺失。
- 频道：也可用 `/cg` 开始讨论，未关联时直接选择项目。未 @ 的消息先按项目概览及有限线程上下文判断，需要 Coordinator 参与才回复，闲聊或明确问别人时保持安静；已有线程也会判断。明确 `@Coordinator` 或 `/cg ask <问题>` 可直接开始线程。
- Coordinator 根据整批消息和近期上下文判断是否需要参与，无须每次 @；提及其他 Bot 也可同时呼叫它。仅问别人或明确无需回复时保持安静；引用和代码里的 @ 不算当前接收对象。身份检查需要 `users:read` scope，已有 App 升级后须重新授权，身份未知时仍按当前语义判断。
- 同一线程连续补充会先持久保存，再在安全点纳入当前轮次，不强制逐条回答。`/cg stop [对话ID]` 停止、`/cg resume [对话ID]` 显式恢复；省略 ID 只选择当前频道与操作者的唯一目标，存在多个时不猜。已经发生的操作和部分回复保留，停止不会自动重跑。
- Slack 线程首次建立后固定项目及 Cloud 对话，工作台可继续同一对话。公开入口不再要求手填已有 Cloud 对话 ID；升级前的关联草稿仍可按原校验提交，不改已有线程绑定。
- 快捷操作：全局或消息菜单进入 TODO/Bug 讨论，不直接写 Map。提问与修改意见直接在线程回复；brief 可明确确认或退回，确认后从卡片导出执行提示文件。
- 回复以纯文本呈现：去掉 Markdown 格式标记，保留正文、换行、代码和链接，不触发模型文本中的 Slack 提及。只改变 Slack 展示，不改 Cloud 历史或导出文件；默认简短回答，完整列表与风险说明按实际需要保留，不硬截断。卡片的通知与辅助阅读正文也保留段落，不把各区块挤在一起。
- 文本或截图附件：支持单份 UTF-8 文本（256 KiB）及 PNG/JPEG/WebP；每条消息最多六份附件，**图片合计上限 5 MiB**。完整消息在插件中先校验，再把附件存到受保护的 Cloud 附件存储，模型只接收授权引用。
- Map 链接：只预览配置中的 Cloud origin、当前关联项目；通知仅发到明确关联的线程。Slack 原始用户消息不会再反向复制回同一线程。

事项和记忆修改由 Coordinator 在同一对话处理，仍遵守 Main 版本校验和人工确认。不再从公开入口打开表单；升级前已打开的未提交草稿保留，旧草稿提交仍受原版本与操作者校验，不覆盖新版本。

## 可靠性与边界

普通消息采用合并策略：同一次 Coordinator 模型调用先决定是否接话，再直接回答或调用允许的工具。简单答复不另调用分类模型；工具需要的续轮照常保留。直接调用工具时，模型选择本轮 `reply_` 开头的工具明确声明接话；参数格式不变，宿主在完整响应校验后调用原业务工具。缺少声明、未知工具或静默时夹带正文、工具均拒绝执行。每个新批次重新判断，历史与引用不授予权限。

内部标识和工具别名不展示为用户正文。原生工具名、输入及回执在内部历史中保持原值；别名不能扩大工具、操作者或项目权限，也不代替人工审批。

每轮模型请求附带简短的服务器格式提醒，避免历史正文让模型省略接话标识；不修改原始输入或提交指纹。格式失败且没有未决工具、待处理补充或停止要求时，新消息可以继续同一对话，旧失败和回执仍保留。HTTP 409 的忙碌响应按原编号退避重试，不误判成永久失败；其他身份、权限和冲突错误仍须处理。

已配置接收范围内的人类新消息持久保存后，代码立即添加 👀，表示“已收到，正在判断”，不等合批、上下文或模型。模型决定不接话时替换为 🙈，不发正文、不执行业务工具；决定接话时替换为 💬，正常输出正文、交流表情并继续工具查询。状态不随多次模型调用重置，不额外拆出分类调用。处理失败明确提示，不用 🙈 假装静默。机器人、编辑和重复事件不作为新请求。

交流表情与固定状态分开：保留原十种，新增 🤝、🔥、🚀、💡、😂、😅、😎，可与短正文同时回复，也可用于无需解释的社交确认；问题、风险、失败和人工确认仍用文字。每条原消息最多两个交流表情，不凑数或刷屏；模型不能选择状态表情或其他消息目标。

状态先添加并确认新表情，再移除本机器人旧表情；交流表情保留。发送与移除意图均持久保存，失回、重启与限流按原目标恢复，反馈不阻塞正文。正常负载目标是持久接收后一秒内发起 👀 请求；实际显示与正文延迟分别验收，不以请求成功冒充已显示。原有原消息、身份、绑定和回执不删除，Map/fs-v2.1 不变。

有序原消息和有限接话参考冻结到 Inbox 后一并提交 Cloud；输入附件仍可经原有授权上传供判断。暂时失败沿原提交编号最多重试八次，永久权限失败直接保留 attention，不冒充静默。旧分类接口仅为兼容保留，普通消息不再调用。升级时先更新 Cloud，再更新插件。

升级前已保存分类结果的旧待处理消息，核对原项目、操作者和批次后按旧提交恢复，不增加新字段或更换编号；这避免已接受但确认丢失的请求被当成不同操作。所有新消息使用合并策略，不调用旧分类模型。

每个线程/私聊绑定首次接入（旧绑定升级也一次），只读取当前频道或原生线程在当前输入之前的最近最多 24 条、每条 1000 字符，最多四页；不读取整个工作区，排除账本可识别的其他项目及已记录原生消息。接话参考仍只取最近六条、每条 800 字符，复用同一次读取。历史只作为参考资料，不是当前需求、身份或授权，也不进入公开对话投影。成功快照先保存到原 Inbox，提交确认后才标记已接入；失回/重启复用原 ID 和快照，服务端 state/journal 同事务保证只注入一次。读取不完整保留失败，不向未决定接话的线程发错误；暂时失败复用既有有界重试，不冻结成永久快照。合成命令不读取历史。

每个 envelope 写入独立私有状态文件并 fsync 后才 ack；Socket 重投、BUSY 和重启沿用同一业务操作 ID。交互事件走快速处理通道，避免等待模型或附件下载导致 modal trigger 过期。线程、频道、用户选择、表单草稿、消息镜像和出站回执均保存在 `state.json`；同一目录只允许一个进程。

每个频道写消息/更新至少间隔一秒。429 遵守 Retry-After，单次最多重试两次；暂时失败退避，最多八次后进入 attention 状态。发送结果不明时通过自己机器人的 metadata 或导出文件的唯一文件名核对线程历史；无法确认则保留不确定状态，不盲目补发。Slack 删除/编辑事件、机器人消息、reaction 不作为需求或审批。

正在等待回复的已关联线程使用现有 `/v1/events` 订阅状态，最多四条连接；新状态唤醒原有镜像流程，不另建模型对话。订阅失效时保留状态轮询并退避重连，正常订阅也保留十五秒兜底检查；完成、失去绑定或停止插件时取消连接。缓存只在内存中，不增加磁盘对话副本。Coordinator 持久保存后立即唤醒同项目、同对话的网关订阅；网关读取单飞并合并在途通知，保留定时读取兜底。通知不等待插件网络，未订阅或停用不影响模型运行；外部 Main 变更等仍依赖兜底刷新，不能据此保证两秒响应。

执行提示导出使用与 SDK `filesUploadV2` 相同的三阶段官方 API，并独立保存 file ID 与进度。申请 URL、上传字节和完成共享的 429 均有界处理 Retry-After；已知拒绝与结果不明分别记录。完成共享的结果不明或进程中断后，只在原线程核对同一 file ID/唯一文件名，不再次分配或发布新文件。

停用时用 `sudo systemctl stop context-guard-slack.service`，只关闭 Socket 和插件进程；恢复时启动同一 unit 并保留私有状态目录。备份必须包含 `state.json`，不得用空目录替换已有回执。attention/unknown 条目需要在工作区按原线程、操作 ID 核对；核对前不删回执或重新发送同一需求。应用凭据与日志不参与 Map、Git 或 npm 分发，启动错误日志只输出错误代码，不输出响应正文。

启动或升级后，`systemctl active` 和 Cloud health 不能证明 Slack 已接通。发送验收问题前，在有权读取该 unit 日志的服务器账户下运行经过审核、root-owned 的 readiness 检查，不从服务可写目录直接以 root 执行：

```bash
sudo install -D -o root -g root -m 0755 plugins/slack/scripts/wait-ready.mjs /usr/local/libexec/context-guard-slack-wait-ready.mjs
sudo /opt/context-guard-slack/runtime/bin/node /usr/local/libexec/context-guard-slack-wait-ready.mjs --unit context-guard-slack.service
```

该只读检查有界等待本次 PID、当前 boot 及启动代次的 Socket 初始连接成功日志，读日志后复查同一启动代次；超时或无法核验返回失败，不输出日志正文，不启动第二个 Socket 客户端。它只证明本次初始连接曾成功，不证明之后的持续在线，仍须用真实 Slack 问答完成当前功能验收。停止旧候选服务并确认它不再使用 Socket、状态目录和旧源码后再清理；不把候选服务作为并行常驻部署。

Slack 免费版的历史保留与应用数量有限，长期项目记录在 Map 和 Cloud。此插件不启动 Executor、Tester、worktree 或自动派发；人工 brief 确认只写 Main 事项并生成粘贴提示。更多节点和超长内容可通过 Home 的完整 Map 链接查看。

## 旧参与失败的单次 operator 恢复

此入口只处理有完整原冻结请求的 `attention/RELEVANCE_UNAVAILABLE` 或 `RELEVANCE_INVALID_RESPONSE`，原 `attempts=3/relevanceAttempts=3` 保留。旧 Inbox、批次、错误与原操作 ID 不重新入队或清零；恢复审计单独保存在 `recoveries`。新请求继续原调度，已有待处理同线程输入优先于历史恢复。

默认关闭。部署审核后，管理员可配置 `CONTEXT_GUARD_SLACK_OPERATOR_DIR`，指向现有 root-owned、服务组只读的 Unix 目录（目录 `0750`、capsule `0640`，父目录均管理员所有且不可被服务写入）。Cloud 的显式 `actions` 还必须包含 `recovery.preflight`；默认 actions 不自动授予这一能力。本实现不创建目录、修改生产权限、新增后台服务或安装配置。

管理员在已审核的源码入口执行 `plugins/slack/scripts/recover-attention.mjs`，先用 `--mode describe --state-dir <原状态目录> --inbox-id <原ID>` 取得有限元数据，再以明确的 `--operation-id`、`--snapshot-hash`、`--source-hash`、`--pid`、`--reason` 和 `--operator-dir` 分别提交 `preflight`、审核结果后提交 `apply`。所有参数都使用 `--name value`。CLI 只读原状态并原子写入受保护授权 capsule；运行中唯一 Slack 进程消费 capsule，串行持久审计，不允许 CLI 编辑 `state.json`。

首版仅支持已核历史 writer 的完整新建对话格式：原 `relevanceRequest` 真正没有 own-key `conversationId`，原 actor/project/有序 inputs/text/context/routing/files 全匹配，且没有附件、后来改绑或待回答问题。缺字段、`conversationId:null`、未知历史格式或已绑定其他对话均拒绝，不补造 provenance。这个本地事实不是无业务效果的充分证明：Cloud 必须在原 create、batch-submit、各 submit 的回执锁及实际对话接受锁下核对原回执、输入/journal、工具与控制状态。预检之后最终接受前再次复核；任何在途、已接受或未知效果都拒绝，不能用新 ID 规避。

通过预检后沿当前单调用 merged 接话路径处理原消息，不复活旧 classifier。初始处理只有一次模型机会；在调用前持久标记尝试，完整原生响应和接话验证通过后，接受标记与原 assistant 同一次保存，之后正常工具轮次及原回执恢复不受限制。结果不明时禁止自动再发初始模型请求；普通新请求原有重试预算不变。新增人类输入或停止仍优先，不改变工具权限和审批。

同一恢复 ID 重复 apply 不新增代次。失 ACK 只允许每个 owner 一次精确已保存运输重放；重启后须以当前 PID 重新确认同一授权 capsule，不能重建原请求或改项目/正文/预算。若崩溃发生在保存运输前，审计保持 unknown，不能自动猜发。首次失败码单独保留，不被轮询覆盖。

`preflighted` 只是无效果预检；`accepted` 只是原输入已耐久接受，不是任务完成或 Slack 送达。只有原批次完整 reply/silent 终态及原线程正式镜像/表情出站回执才标记恢复 `completed`；失败、停止和被新输入替代分别记录，原 attention 始终保留。真实旧 C4 是否满足预检必须现场核验，此实现和替身测试均不代表它已经恢复。

## 验证

执行 `npm test`：覆盖持久 ack、重投、私聊/频道独立线程、原任务 ID、CAS 冲突、人工 brief、附件、消息镜像、流式转最终回复、限流、未知发送核对和订阅生命周期。SSE 协议使用隔离 loopback HTTP，生命周期使用真实私有 journal 与受控 gateway/Slack 传输；不是已安装工作区或真实模型的验收。

相关性判断的决定和原请求在私有 journal 中保存；重启和重投沿用原 ID、原输入，不因线程后来编辑而重新指向其他项目。失败不当作相关，也不向未 @ 的频道刷报错。回归覆盖这一可靠性边界，语义准确率仍需真实模型和 Slack 验收。

真实验收需完成 App 安装、token 配置、Cloud 网关部署，并在 Slack 中检查 Home、两端线程接续、事项/brief/提示、图片轮次和服务重启。保持本服务停用时，工作台正常运行也需实测。

官方资料：[Socket Mode](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)、[消息 metadata](https://docs.slack.dev/reference/methods/chat.postMessage/)、[文件上传](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/)。
