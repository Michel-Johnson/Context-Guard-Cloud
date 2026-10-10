# CI 策略

Cloud 与 Skill 使用相同原则，各自维护符合源码依赖的路径规则；不依赖另一仓库的本地检出目录。规则在 `.github/ci-impact.json`，选择器在 `.github/scripts/ci-impact.mjs`，工作流在 `.github/workflows/ci.yml`。

## 何时运行

- PR：比较 base 与 head 的 merge-base 差异，合并所有命中规则；重命名同时考虑旧、新路径，删除也参与分析。
- Main、标签与未知事件：完整运行。安全检查和影响分析不参与跳过。
- 未知路径、空差异、无法取得 merge-base：回退完整运行。配置损坏或选择器校验失败直接阻断，不能产生部分成功计划。
- CI 自身、根/Slack 包及锁文件、测试清单、本文策略变更：完整运行。不能用发版改版本号绕过依赖检查。

| PR 变更 | 选择的功能检查 |
| --- | --- |
| 仓库内部文档、CI_todo | 无；仍执行安全、影响分析、Required |
| README、发布资料及法律声明 | 包检查 |
| Slack 源码、运行脚本或应用清单 | Cloud 集成测试、最低运行时、Slack、包检查 |
| 仅 Slack 测试 | Slack |
| Cloud 源码 | Cloud 测试、最低运行时、浏览器、包检查；与 Slack 交互的源码另含 Slack |
| 固定共享运行时构建 | 全部功能检查 |
| Cloud 单元测试 / 浏览器 runner | 对应 Cloud 测试 / 浏览器检查 |
| 共享测试 helper | Cloud 测试、最低运行时、浏览器 |
| 部署代码 | Cloud 测试、包检查 |

选择计划写入 Job Summary 和 `cloud-ci-impact-plan` artifact。新增模块必须同时登记规则及正反回归；未登记前保持全量回退。真实供应商/真人 Slack 验收不混入普通 CI。

## Required 与交付

Required 必须确认安全、影响分析成功，全部预期任务存在，计划字段为明确布尔值：被选任务只能是 success，未选任务只能是 skipped。失败、取消、缺失或异常跳过均阻断；完整计划不允许关闭任何任务。

保留现有 Node 18/22、浏览器、安全、包内容与生产依赖安装检查。影响分析只选择 Job，不删测试、不缩短超时、不允许跳过失败项；同一 Job 仍执行原完整套件。Main 全量结果仍是准确发布修订的门禁，PR 结果不代替它。

Coordinator 审核需求和方案；Executor 开发并集中做模块自检，写编号 CI_todo；Tester 独立验证准确修订。GitHub 自动检查不代替 Tester 的判断。本地不重复已通过项目、不每次修改都跑全量。
