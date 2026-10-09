# Cloud 专有设计

Cloud 是 Skill 的可选云端扩展。核心、UI、角色提示词和通用协议由 [Skill](https://github.com/Michel-Johnson/Context-Guard-Skill/tree/main/references/design) 维护，通过固定发布包使用；本目录不复制它们。

| 主题 | 本仓库设计 |
| --- | --- |
| Slack | [项目查询与切换、模型选择与表情回应](design-slack-integration-v1.3.0.md) |
| 云端附件 | [附件设计](design-cloud-attachments-v1.0.0.md) |
| 云端对话压缩 | [压缩设计](design-coordinator-compaction-v1.0.0.md) |
| 云端模型缓存前缀 | [稳定前缀与逐轮状态](design-coordinator-cache-prefix-v1.0.0.md) |

完整源码归属见 [两仓库边界](https://github.com/Michel-Johnson/Context-Guard-Skill/blob/main/references/design/design-repository-v1.0.0.md)。设计存在不代表已实现或部署，迁移不改变权限、数据格式和暂缓范围。
