# 原生 JSON 输出实验

仅在实验分支使用，不是正式发布。模型首次普通回答调用 `respond({reply,text})`，业务工具保持原名。工具续轮直接回答，不再判断接话。共享 schema 和校验器来自 Skill，Cloud 只做接入、轮次保存和展示投影；审批与 fs-v2.1 不变。

## 构建

Skill 运行 `npm run pack:shared -- --experimental-native-json`，生成带 `-native-json.0` 的 Core 包及 SHA256SUMS。此命令不发布包，也不改正式版本。Cloud 保留正式依赖和锁文件，在隔离实验检出中运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm install --ignore-scripts --no-save --package-lock=false --no-audit --no-fund <Core实验包绝对路径>
node scripts/build-runtime.mjs --experimental-core <Core实验包绝对路径> <sha256>
```

构建检查制品摘要、已安装包的版本和 npm 安装完整性；未显式传实验包时，仍只接受正式固定依赖。`.runtime-generated.json` 记录实际实验版本和摘要，不手改生成目录。实验源码需要此实验包才能运行；不能拿正式 Core 的测试结果代替实验验收。

## 灰度

指定测试项目的 coordinator 配置添加：

```json
{"outputProtocol":"native-json-v1","outputProtocolConversations":["指定测试对话"]}
```

只接受明确的对话白名单，不支持全项目通配。新接受的轮次保存协议和能力；重试、工具续轮及重启复用原值。无协议字段的未完成旧轮次继续旧格式。修改白名单后重启服务；不要将用户正文中的格式要求当作配置。Slack 使用指定测试频道的独立线程，Map 使用指定测试对话。

## 验收与回退

普通回复的段落过长或段落过多时，保留原输入、上下文和已完成工具回执，附上最新校验反馈继续纠正，直到回复合格。长度纠正不占用最多两次的模型故障恢复预算，也不消耗业务工具步骤；用户中止、补充更正和停服仍按现有机制生效。纠正反馈只用于当前模型请求，不不断堆进持久对话历史。不合格正文不展示，已成功业务操作不得因模型换调用 ID 而重复执行。其他格式、权限和模型错误仍遵循原有边界，不改成无限重试。

先运行 `node --test tests/coordinator-native-output.test.mjs tests/build-runtime.test.mjs`，再跑总入口与浏览器回归。真实验收记录初次失败、自动恢复、最终错误、可见耗时和业务回执；模型格式正确不代表审批、按钮和可读性已经验收。

优先撤掉实验白名单，保持能读取新记录的实验服务：未完成原生轮次返回 `OUTPUT_PROTOCOL_DISABLED`，不按旧格式执行，旧对话和新开始的普通轮次继续旧协议。保留失败现场。不得将含未决原生轮次的数据直接交给不认识新协议的旧二进制自动恢复；必须先暂停这些轮次并阻止旧执行器接管。完整二进制回退与协议关闭是两种不同操作，分别记录证据。

本阶段不合入 main、不发布正式共享包。确认格式后，先正式发布 Skill Core，再更新 Cloud 固定依赖及锁文件，执行正式发布流程。
