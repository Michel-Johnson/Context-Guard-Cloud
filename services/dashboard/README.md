# Dashboard Cloud 服务

账号、飞书 OAuth 与空间隔离由本服务维护。共享 HTTP、SQLite Store、Web 与 CLI 从 Skill 仓库的 `packages/dashboard` 固定修订加载；Cloud 不跟踪其源码副本。本服务需要 Node >=22.5，CI 使用 Node 24；仓库根服务仍支持 Node 18，原 `npm start` 不变。

## 固定源码准备

`source-lock.json` 必须记录 Skill 的完整 40 位 commit、对应 codeload HTTPS URL、归档 SHA256 和 `packages/dashboard` 路径；占位或动态分支会直接失败。维护者先审核准确提交并独立核对归档 SHA256，再更新锁文件。

```sh
npm run bootstrap --prefix services/dashboard
```

脚本仅下载锁定 GitHub 归档，禁止重定向，验证 SHA256 后提取共享模块及同修订的 `skills/jiarui`、`skills/dashboard-connect`、首次分发构建器至忽略的 `temp/dashboard-shared/`。解包会拒绝路径穿越、链接、设备和重复路径。离线可传入同一份已锁定归档，仍执行完全相同的哈希与结构验证：

```sh
npm run bootstrap --prefix services/dashboard -- --source /absolute/path/exact-archive.tar.gz
```

归档必须来自 `source-lock.json` 的同一 codeload 地址；重新生成的 `git archive` 若字节不同，不能替代它。升级时重新执行 bootstrap，启动会核对生成目录的锁定回执。

## 启动与测试

通过环境变量提供 `DASHBOARD_OWNER_KEY`、`DASHBOARD_DATA_DIR`、`DASHBOARD_PUBLIC_BASE_URL`，按需设置 `DASHBOARD_HOST`、`DASHBOARD_PORT` 和 `DASHBOARD_FEISHU_LOGIN_FILE`。飞书文件为私有 JSON，包含 `appId`、`appSecret`、`redirectUri`；回调须为公开 origin 下的 `/auth/feishu/callback`。启动入口显式读取当前进程环境，不搜索本机个人配置。

bootstrap 后，用 Python 3 从同一锁定归档源码生成本地首次分发基线。公开地址必须显式传入，`web/skills` 必须是全新空目录；构建器拒绝覆盖既有 release/catalog，也不会上传或发布。升级代码不等于正式 Skill 版本发布，已有同版本分发包不能被重构生成物替换。

```sh
npm run build:skills --prefix services/dashboard -- --base-url "$DASHBOARD_PUBLIC_BASE_URL"
npm start --prefix services/dashboard
npm run test:dashboard
```

Cloud 默认启用工作空间，显式 `DASHBOARD_WORKSPACES=0` 可关闭。集成测试只使用临时目录、合成账号和本地 HTTP；飞书响应由测试替身提供，不调用真实 OAuth 或模型。开发时可显式指定独立 Skill 检出目录进行共享源码联调，只有测试入口读取该变量：

```sh
DASHBOARD_TEST_SHARED_CHECKOUT=/absolute/path/skill-checkout npm run test:dashboard
```

此联调方式不证明锁定归档可获取；正式 CI 必须先执行受控 bootstrap，再在无此变量的环境运行测试。代码检查和测试不执行部署。
