# Cloud 仓库开发说明

本仓库维护云端托管、账号与权限、多设备服务、云端模型服务、Slack 与部署。共享核心、Map、协议、UI、角色提示词和通用设计由 Skill 维护；本仓库固定版本使用，不编辑 scripts/shared/ 或 prototype/ 生成物。CLI、hooks、本地后端和客户端同步也在 Skill。

分支使用平台前缀，通过 PR 合并，不直接推送 main。保留安全和 Required 检查，运行数据与凭据不得进入 Git 或发布包。共享设计源码从 [设计目录](references/design/README.md) 读取，设计文件按 `design-主题-vX.Y.Z.md` 命名；每个主题只留当前版，旧版查 Git。项目说明统一中文，代码、命令、协议标识和第三方法律原文不翻译。

Coordinator 对齐需求并审核 Executor 的 Plan；Executor 实现并完成模块测试，再写编号 CI_todo 供独立 Tester 验证。Tester 必须给出准确修订的证据，不能使用旧检出的结果。

CI 与 Skill 遵守相同选择原则，具体路径影响和门禁见 [CI 策略](docs/ci.md)。新模块须登记影响规则及正反测试，未知范围保持全量；不得用影响选择绕过安全、Required 或准确 Main 发布检查。

生产冒烟不得变成未经批准的用户消息或破坏性数据修改。不创建源码备份副本；既有业务数据及其备份不是源码清理目标。
