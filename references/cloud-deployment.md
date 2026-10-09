# Cloud 部署手册

Cloud 只能从 [Context-Guard-Cloud](https://github.com/Michel-Johnson/Context-Guard-Cloud) 部署。Skill 和本地后端由 Context-Guard-Skill 独立发布，不得用 Skill 检出目录运行 Cloud，也不保留并行候选源码目录。Cloud 与 Slack 使用同一份已审核的 Cloud 源码修订，但分为两个服务，依赖和状态各自独立。

私有记忆的数据权威与发布规则见 [服务器记忆](../scripts/shared/references/design/design-memory-server-v1.0.1.md)。仅安装 Cloud 不会迁移 Session 数据或改变项目身份。

## 1. 安装布局

模板使用 Linux systemd 系统服务，以 `context-guard` 账户运行；安装单元前先创建该专用账户。Cloud 要求 Node.js >= 18；Slack 使用独立的 Node.js >= 22.19.0 和 npm >= 9.6.4。

| 用途 | 路径 |
| --- | --- |
| 唯一 Cloud 源码检出 | `/opt/context-guard-cloud/repository` |
| Cloud 受保护环境配置 | `/etc/context-guard-cloud/cloud.env` |
| 可选的既有站点覆盖配置 | `/etc/context-guard-cloud/public.env` |
| 私有记忆配置 | `/etc/context-guard-cloud/memory.json` |
| Cloud 业务数据 | `/var/lib/context-guard-cloud` |
| 新安装的私有记忆数据 | `/var/lib/context-guard-cloud/memory` |
| 业务项目 Git 镜像 | `/var/lib/context-guard-projects/<project>` |
| Slack 源码 | `/opt/context-guard-cloud/repository/plugins/slack` |
| Slack 受保护环境配置 / 状态 | `/etc/context-guard-slack.env` / `/var/lib/context-guard-slack` |
| Slack Node 运行时 | `/opt/context-guard-slack/runtime/bin/node` |

这些是安装默认值，不是数据迁移命令。已有主机保留已核验的数据与配置路径，必要时调整单元的 `ReadWritePaths`；不要为了匹配模板而移动或替换数据。

新安装时，管理员先安装 Git、Node、npm、curl 并创建服务账户，再创建唯一的源码检出目录：

```bash
sudo git clone https://github.com/Michel-Johnson/Context-Guard-Cloud.git /opt/context-guard-cloud/repository
cd /opt/context-guard-cloud/repository
sudo npm ci --omit=dev --ignore-scripts
sudo npm run build:runtime
```

启动服务前选定已审核的发布提交。服务账户需要读取源码和受保护 JSON 文件，但不需要写源码；运行状态和凭据必须放在检出目录之外。

## 2. 受保护配置与项目镜像

启动系统服务前，创建可写的业务项目镜像根目录：

```bash
sudo install -d -o context-guard -g context-guard -m 0750 /var/lib/context-guard-projects
```

服务可以在此目录执行 Git 拉取和已明确启用的项目文件操作；Cloud 自身源码保持只读。既有镜像若位于其他位置，迁移前必须在经过审核的 `ReadWritePaths` 覆盖配置中列出其精确目录。绝不授予 `/opt` 或 `/` 的写权限。

创建 `/etc/context-guard-cloud/cloud.env`，权限为 `0600`，所有者为 root。systemd 会先读取 EnvironmentFile，再切换为服务账户：

```dotenv
CONTEXT_GUARD_CLOUD_TOKEN=<independent-admin-token>
CONTEXT_GUARD_CLOUD_WORKBENCH_TOKEN=<independent-browser-token>
CONTEXT_GUARD_CLOUD_PASSWORD_HASH=<scrypt-password-hash>
CONTEXT_GUARD_CLOUD_ORIGIN=https://map.example.com
CONTEXT_GUARD_MEMORY_CONFIG=/etc/context-guard-cloud/memory.json
```

真实凭据不得进入 Git、命令参数、Map 或复制出的日志。用密码管理器生成相互独立的 Token；通过私有标准输入生成加盐密码哈希，避免密码进入 shell 历史：

```bash
node --input-type=module -e '
  import { createWorkbenchPasswordHash } from "./scripts/cloud/server.mjs";
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  process.stdout.write(await createWorkbenchPasswordHash(password.replace(/\r?\n$/, "")) + "\n");
'
```

Cloud 保存哈希，不保存密码。人登录后使用已有的 HttpOnly/SameSite 浏览器 Cookie；执行客户端通常使用浏览器批准的设备授权，不复制项目 Token 或密码。

创建权限为 `0600`、服务账户可读的受保护记忆 JSON，例如归 `context-guard` 所有。路径必须为绝对路径：

```json
{
  "dataDir": "/var/lib/context-guard-cloud/memory",
  "adminToken": "<server-only-memory-admin-token>",
  "projects": {
    "my-project": {
      "token": "<project-memory-token>",
      "root": "/var/lib/context-guard-projects/my-project",
      "ref": "refs/remotes/origin/main",
      "repository": "owner/my-project"
    }
  }
}
```

每个 `root` 都是该业务项目独立维护的 Git 检出或镜像。除非 Cloud 本身就是业务项目，否则不要指向 Cloud 应用仓库。在部署或维护步骤中拉取其权威 Main；服务按该引用核验源码提交，不能用 Cloud 发布 SHA 替代项目 Main SHA。

模板使用 `ProtectSystem=strict`。省略记忆项目的 `remote` 字段，避免运行中的服务向只读源码或镜像执行拉取。不得为了绕过发布失败而授予源码写权限。

Slack 的可选回环网关与独立凭据配置见 [Slack 接入设计](design/design-slack-integration-v1.3.0.md)。Slack SDK 依赖留在插件包，Cloud 不加载它们。

### Coordinator 模型选择

工作台的“模型配置”按钮为当前项目选择服务器已配置的文本供应商。保留 `coordinator.providerFile`，供旧的进行中轮次及其重试使用。显式增加私有供应商目录，例如：

```json
{
  "modelProviders": {
    "glm-5.3": { "label": "GLM 5.3", "providerFile": "/etc/context-guard-cloud/glm-coordinator.json" },
    "deepseek-flash": { "label": "DeepSeek V4.1 Flash", "providerFile": "/etc/context-guard-cloud/deepseek-flash-coordinator.json" }
  },
  "defaultProviderId": "deepseek-flash"
}
```

各供应商文件权限为 `0600`，由服务账户读取，不进入 Git。DeepSeek V4.1 Flash 使用 `model: "deepseek-flash"`、`protocol: "anthropic"`、`baseUrl: "https://api.deepseek.com/anthropic"` 和私有 `token`。开放选项前，用真实凭据验证流式输出和工具接续；不要把凭据填进浏览器字段或 URL。

`GET/POST /api/workbench/projects/<project>/api/coordinator/model` 要求工作台权限。POST 只接受 `{id, providerId, baseVersion}`，在项目的 Coordinator 数据目录保存带版本、幂等的选择；浏览器只接收 ID、标签、模型名称和设置版本。变更仅作用于后续文本轮次（包括 Slack），不影响进行中的轮次或重试，图片路由不变。保留原供应商直到其未完成轮次全部处理完毕；移除已选供应商时明确拒绝，而不是静默替换。

## 3. 启动与连接

Cloud 模板监听 `127.0.0.1:8788`，启用私有模式和安全 Cookie。在反向代理终止 TLS，不得把后端端口公开。已有容器代理若要求特定私有网桥地址，保留已审核的主机覆盖配置和防火墙边界；迁移时不要盲目改为回环地址或 `0.0.0.0`。配置准确的外部 HTTPS 来源。

```bash
sudo install -o root -g root -m 0644 deploy/context-guard-cloud.service /etc/systemd/system/context-guard-cloud.service
sudo systemctl daemon-reload
sudo systemctl enable --now context-guard-cloud.service
curl --fail http://127.0.0.1:8788/api/health
sudo systemctl show context-guard-cloud.service -p WorkingDirectory -p ExecStart -p MainPID -p ExecMainStartTimestamp
```

本地健康探测使用实际的私有监听地址。除了健康状态，还要核对运行入口和源码修订；仅进程存活或磁盘 SHA 正确，不能证明已加载最新代码。检查私有诊断时，不复制凭据、提示词或完整 journal。

管理员在现有项目目录与记忆配置中登记业务项目。拆仓库时保留已有 ID，不因 Cloud 源码仓库改变而新建项目。管理员和项目 API 凭据放在 Authorization 请求头，不放在查询参数。

工作副本使用已安装的 Skill：

```bash
context-guard workbench connect --root <project> --url https://map.example.com --session <actual-session-id> --wait
context-guard workbench --root <project> --session <actual-session-id>
context-guard sync status --root <project> --session <actual-session-id>
```

人批准返回的浏览器 URL / 验证码，后端保存设备凭据；新 Session 复用项目连接。旧 Map-only 传输已删除。存在待处理旧数据时的 `UPGRADE_REQUIRED` 是需要协调的阻塞，不授权清空队列或覆盖 Main。

按 Slack [README](../plugins/slack/README.md) 安装，随后核验初始 Socket 就绪状态，并完成一次真实、已授权的 Slack 交互。Cloud 健康不代表 Slack 已就绪。

## 4. 升级、淘汰旧源码与回滚

1. 记录当前 Cloud / Slack 源码 SHA 及数据、配置路径。按既有策略备份业务数据和受保护配置，包含私有记忆、附件、Slack 状态与回执，不备份或复制源码检出。停服务前核对必需的备份来源和实际目标文件系统可用容量；缺少可选 drop-in 不等于缺少必需来源。按数据表观大小加上归档开销、依赖和并发占用的明确余量预算，不假定压缩能挽救空间不足。容量不足时，不改变正在运行的版本。
2. 拉取 Cloud 仓库，选定已批准的准确发布提交。先停 Slack，再停 Cloud；安装根包生产依赖，执行 `npm run build:runtime` 生成已锁定的核心与 UI，再安装插件独立依赖，随后先启动 Cloud，再启动 Slack。
3. 核对入口、进程代次和源码 SHA，验证鉴权读取、编辑、重载、Session 历史保留、重连和 Slack 就绪。编辑必须在已批准的测试项目进行，不任意修改生产 Map。
4. 将客户端更新到兼容的 Skill 版本，核验安装入口、本地 / Cloud 同步及待处理数据保留。
5. 只有确认没有进程、服务或业务项目 Git 镜像引用，且独有提交已保存到 Git、运行数据已移出后，才淘汰旧单元、覆盖配置和源码目录。保留单一固定源码入口，不创建 `*-old` 源码副本。

源码目录存在未提交修改时，不得部署；不要执行 `reset --hard`、覆盖修改或把候选目录变成第二个永久源码入口。通过 Git 历史或已批准的发布产物，在原入口重新部署兼容旧版，并保留当前业务数据和回执。若版本需要不兼容数据迁移，先取得明确的迁移与恢复方案，源码回滚不得静默恢复陈旧数据。

分别记录停服务、改源码和安装依赖。若备份在源码或依赖变更前失败，只需重启已停服务，核验旧 Cloud 版本和初始 Slack Socket 就绪；不要为未改变的版本执行 Git/npm 回滚，不覆盖受保护配置，也不凭进程活跃宣称恢复。

## 5. 业务数据备份保留

保留既有数据与凭据备份机制。新快照排除源码、`node_modules`、候选检出和运行时二进制，只记录对应发布 SHA 等少量元数据。不要把旧混合归档当作源码清理目标；它们可能是业务数据的唯一副本。

`deploy/prune-cloud-backups.mjs` 从 `/var/backups/context-guard-cloud-pre-*.tar[.zst]` 或 `/var/backups/context-guard-cloud/pre-*` 保留最新五份完整快照。默认 dry-run，验证保留快照，拒绝变化的清单和符号链接；最近备份有变动时等待十分钟。脚本不创建备份，既有备份生产流程仍应保存数据与受保护配置。

识别原始 `.tar` 和 `.tar.zst` 最终归档。时间戳名称支持既有四至六位时间，以及生产器的精确九位 `HHMMSSmmm` 时间。`.part` 仍不参与保留清理，也不自动删除。若主机已有 `--apply` 定时器，更新发现规则前先检查新增识别的清单、保留 / 过期列表及保留快照完整性。安装新脚本前取得扩大的删除范围授权；获准删除特定 `.part` 不代表获准清理完整快照。

安装经过审核的保留脚本和单元，所有者必须为 root；不要以 root 执行服务账户可写的检出脚本：

```bash
sudo install -D -o root -g root -m 0755 deploy/prune-cloud-backups.mjs /usr/local/libexec/context-guard-cloud-prune.mjs
sudo install -D -o root -g root -m 0644 deploy/context-guard-cloud-backup-retention.service /etc/systemd/system/context-guard-cloud-backup-retention.service
sudo install -D -o root -g root -m 0644 deploy/context-guard-cloud-backup-retention.timer /etc/systemd/system/context-guard-cloud-backup-retention.timer
sudo systemctl daemon-reload
sudo node /usr/local/libexec/context-guard-cloud-prune.mjs
sudo systemctl enable --now context-guard-cloud-backup-retention.timer
```

以 `0600` 权限写入 `.part` 数据归档，核验完整内容后原子改名为可识别的最终名称。保留机制的完整性检查不替代“是否包含所有必需数据与配置”的检查；现有数据、配置目录和归档仍按备份保留策略管理，不属于源码清理。

迁移主机时先停写，复制完整业务数据、状态目录和受保护配置。从 Git 部署相同的已批准 Cloud 版本，核验历史与就绪状态，再通过 `workbench connect` 重连客户端。绝不能只凭最新 Map 重建同步状态。

共享源码来自 Skill 发布包：源码 SHA、core/UI 版本和锁文件完整性摘要必须随 Cloud 修订一起记录。运行数据不参与构建；回退须恢复对应修订的依赖与生成物，不复用新版本目录。

## 6. 新版 Map（Beta）

UI 1.3.2 在“设置 → 实验功能”提供新版 Map（Beta）开关，默认关闭。仅主动开启的浏览器使用新版架构图和展示翻译；关闭恢复稳定工作台，正在编辑或未提交输入时拒绝切换。偏好只存当前浏览器，不更改项目数据、角色或权限，也不因旧 `mapView` URL 自动启用。

英语展示翻译复用该项目当前选择的 Coordinator 文本模型，要求已有真人登录、同源及对应 Session 读取权限。接口只接收有界文本批次，翻译缓存按项目、视图及模型设置版本隔离；不调用工具、不写 Map、不加入 Coordinator 聊天记录，失败保留原文并提供重试。供应商凭据仍由服务器私有配置维护。

本次不改变 fs-v2.1 或共享 Map 结构。稳定版恢复优先关闭 Beta；源码回滚仍沿第 4 节，在唯一入口恢复旧修订及其固定依赖，保留业务数据与受保护配置。
