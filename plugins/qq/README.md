# QQ 入口

NapCat 登录普通 QQ 账号，独立 NoneBot2 服务通过 OneBot v11 反向 WebSocket 收消息，经认证 HTTP 调用现有 Cloud Coordinator。不是 Insight 问答服务，也不复制一套模型或 Map 后端。

首期只处理账号本人私聊发出的 `/co 问题`；普通聊天、好友/群员消息及机器人自己的回复均不触发。回复统一发送给登录账号本人，不向原好友或群公开项目内容。实际 QQ 客户端能否呈现给自己的消息须真实验收；不能以 SDK 模拟结果宣称可用。

## 配置

Cloud 通过 `CONTEXT_GUARD_QQ_CONFIG` 指向私有 JSON：

```json
{"token":"独立随机凭据，至少32字符","accountId":"你的QQ号","projectIds":["已注册项目"],"defaultProjectId":"已注册项目"}
```

适配服务通过 `CONTEXT_GUARD_QQ_ADAPTER_CONFIG` 指向另一个私有 JSON：

```json
{"accountId":"你的QQ号","backendToken":"上面Cloud的独立凭据","onebotToken":"另一份独立随机凭据","cloudOrigin":"https://你的Cloud域名","defaultProjectId":"已注册项目","acceptSince":1}
```

凭据、QQ登录数据和 SQLite 放仓库之外；不要把私有文件提交 Git。NapCat WebUI 和适配服务仅映射回环端口，反向连接配置 `/onebot/v11/ws`、相同 `onebotToken`、`reportSelfMessage:true`。禁用其他不需要的 OneBot 连接。不自动接受好友/群邀请、不抓取历史聊天。

`acceptSince` 用首次启用时的当前 Unix 秒数，重启沿用原值，不自动处理接入前的旧命令。Cloud 地址须 HTTPS；只有真正回环地址可使用明文 HTTP，URL 不得包含凭据或查询参数。

本机安装使用独立虚拟环境：`pip install -r plugins/qq/requirements.txt`，在该目录运行 `python app.py`。容器构建：`docker build -t context-guard-qq-adapter plugins/qq`；持久挂载 `/state`，只读挂载私有配置，设配置路径。QQ登录需要本人扫码。

## 可靠性与接口

- POST `/api/integrations/qq/submit`：`{id,text,scene:{kind,peerId},projectId?}`。重复发送保留原编号和正文。
- POST `/api/integrations/qq/state`：同范围、不含正文，查询原请求是否接受以及该轮回复。
- GET `/api/integrations/qq/projects`：已连接的项目名称；不接受模型自称操作者。
- 同场景串行，跨场景最多4并发；请求和分段回复在 SQLite 保存，进程/网络恢复后继续查询原请求，不重新创建模型任务。
- 模型长输出分段完整发送，不因长度拒绝、不截断正文。每段加 `Coordinator：`，避免自身消息回环。
- QQ发送回执丢失、进程在发送时崩溃：保留“发送结果未知”，不自动重发造成重复。当前需要人工核对；不伪称恰好一次投递或完整故障恢复。
- 仅文字与固定默认项目；群、图片、附件、自动执行授权和会话内项目切换不在首期实现范围。
- 候选每批32个场景，长期停滞场景的更大规模公平调度尚未验收；不承诺任意数量场景互不影响。

集中模块自检：`python -m unittest discover -s plugins/qq/tests` 与 `node --test tests/qq-gateway.test.mjs`。它们不替代真实账号的收发和重连验收。
