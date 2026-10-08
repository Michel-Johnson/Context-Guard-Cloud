# Context Guard Cloud

操作资料：[部署手册](references/cloud-deployment.md)、[Slack 接入](scripts/shared/references/design/design-slack-integration-v1.1.0.md)、[附件设计](scripts/shared/references/design/design-cloud-attachments-v1.0.0.md)、[Coordinator 压缩](scripts/shared/references/design/design-coordinator-compaction-v1.0.0.md)。全部设计见 [设计目录](scripts/shared/references/design/README.md)。

本仓库提供 Context Guard 的 Cloud 工作台、Coordinator 和集成。客户端与 Skill 由 [Context-Guard-Skill](https://github.com/Michel-Johnson/Context-Guard-Skill) 维护。

Cloud 服务、独立 Slack 插件、公共运行时包和工作台 UI 包由本仓库维护。应用发布不改变业务项目仓库身份或记忆 Main 版本。

Slack 对话支持人工确认切换已配置的项目默认文字模型，以及仅对当前可信真人消息添加原生表情回应；表情不代替业务回执、风险说明或人工审批。

## 开发

使用 `npm ci` 安装，`npm start` 启动 Cloud。Slack 是独立服务，单独安装依赖。配置、凭据、地图、回执和附件放在源码检出目录之外，见 [部署手册](references/cloud-deployment.md)。

`npm test` 运行 Cloud 测试。跨客户端测试使用固定 Skill 开发依赖和仅供测试的包解析器，不将它们放入 Cloud 发布包。`scripts/shared` 和 `prototype` 是公共运行时与 UI 唯一可编辑的源码来源。

共享设计在 `scripts/shared/references/design/` 维护，随 core 包导出为安装目录的 `references/design/`；不在两个仓库复制第二份。Skill 自有 Session 同步设计由 Skill 仓库维护。

## 交付

修改经过 Review、CI 通过后由 PR 合并。Executor 完成模块验证后写编号 `CI_todo`；独立 Tester 验证准确源码修订后才交付。测试完成不等于人工验收。

将准确 Git 修订部署到唯一配置的检出目录，不创建源码备份目录或永久候选服务。保留运行数据和备份策略；回滚到已记录的源码修订或发布产物。
