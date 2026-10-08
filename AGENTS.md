# Cloud 仓库开发说明

本仓库维护 Cloud、Coordinator、Slack、公共运行时和共享工作台 UI。Skill、本地运行时及客户端安装由独立的 [Skill 仓库](https://github.com/Michel-Johnson/Context-Guard-Skill) 维护；不要复制其源码到这里。

分支使用平台前缀，通过 PR 合并，不直接推送 main。保留安全和 Required 检查，运行数据与凭据不得进入 Git 或发布包。共享设计源码从 [设计目录](scripts/shared/references/design/README.md) 读取，设计文件按 `design-主题-vX.Y.Z.md` 命名；每个主题只留当前版，旧版查 Git。项目说明统一中文，代码、命令、协议标识和第三方法律原文不翻译。

Coordinator 对齐需求并审核 Executor 的 Plan；Executor 实现并完成模块测试，再写编号 CI_todo 供独立 Tester 验证。Tester 必须给出准确修订的证据，不能使用旧检出的结果。

生产冒烟不得变成未经批准的用户消息或破坏性数据修改。不创建源码备份副本；既有业务数据及其备份不是源码清理目标。
