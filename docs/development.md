# 本地开发与统一检查命令（R01/R02）

核对日期：2026-09-07。本文是当前工程的本地命令入口。工程固定 Node.js **24.19.0**、pnpm **11.19.0**、Vitest **4.1.11**、Wrangler **4.129.0**；版本以 `.node-version`、根 `package.json`、锁文件和 `apps/worker/package.json` 为准。先阅读 [toolchain.md](toolchain.md) 处理 Windows `Path` 大小写、安装策略和证据目录。

当前代码仍有任务图中的未实现或未完成入口。下面的检查命令会真实返回失败并阻止交付；不要用 `--passWithNoTests`、跳过失败项目或把静态分析警告改写成通过。命令可执行不等于所有产品模块或真实云环境已验收，真实邮件、上游、部署、恢复和负载证据仍按各自任务后置。

## 固定工具链与安装

在全新 checkout 的工程根目录执行。Windows/Codex bundled Node 的路径是本机运行时路径；其他机器应按 `.node-version` 选择自己的 Node 24.19.0，不要复制该用户路径。以下只修改当前 PowerShell 进程：

```powershell
$toolchainOriginalPath = $env:Path
Remove-Item Env:PATH -ErrorAction SilentlyContinue
$env:Path = 'C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $toolchainOriginalPath
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location).Path '.wrangler/development.log'

node --version
pnpm.cmd --version
```

输出必须是 `v24.19.0` 和 `11.19.0`。在 POSIX 环境使用选定的 Node 24.19.0 与 pnpm 11.19.0 后，等价命令中的 `pnpm.cmd` 写作 `pnpm`。安装严格使用锁文件和官方 HTTPS registry：

```powershell
pnpm.cmd install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
```

`pnpm-workspace.yaml` 的 `engineStrict`、`verifyDepsBeforeRun` 和依赖策略会拒绝版本漂移或隐式安装。若安装失败，先修正 Node/pnpm 版本和 registry；不要删除锁文件，也不要把 `--ignore-scripts`、年龄检查覆盖或新的 `allowBuilds` 写进项目配置。

## 日常开发

根脚本按 workspace 运行，开发者不需要切换到子包目录：

```powershell
# 两个开发服务器按需分别运行
pnpm.cmd run dev:web
pnpm.cmd run dev:worker
```

Worker 本地开发需要明确的状态目录和本地 binding。要先应用迁移时，在另一个终端执行：

```powershell
$projectRoot = (Get-Location).Path
$workerWrangler = Join-Path $projectRoot 'apps/worker/node_modules/wrangler/bin/wrangler.js'
$workerConfig = Join-Path $projectRoot 'apps/worker/wrangler.jsonc'
$localState = Join-Path $projectRoot '.wrangler/development-state'
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path $projectRoot '.wrangler/development.log'

node $workerWrangler d1 migrations apply DB --config $workerConfig --local --persist-to $localState
node $workerWrangler d1 migrations list DB --config $workerConfig --local --persist-to $localState
node $workerWrangler dev --config $workerConfig --local --persist-to $localState --port 8787
```

`wrangler dev` 默认只连本地模拟 binding；不要为日常开发添加 `--remote`。本地服务可访问 `http://localhost:8787/healthz`，定时任务测试另需显式加入 `--test-scheduled`，参照 [deployment.md](deployment.md)。管理员初始化是交互操作，不属于 CI：

```powershell
node scripts/bootstrap-admin.ts --local --persist-to $localState
```

前端构建产物位于 `apps/web/dist`，Worker dry-run 会读取该目录；开发时优先使用根 `build`，不要把 `dist/` 或 `.wrangler/` 构建状态提交到 Git。

## 统一检查命令

根 `package.json` 提供下面的固定入口：

| 命令 | 作用 | 是否访问远程资源 |
| --- | --- | --- |
| `pnpm.cmd run typecheck` | 三个 workspace 的严格 TypeScript/Vue 类型检查 | 否 |
| `pnpm.cmd run test` | `vitest run`，运行 `node` 与 `workers` 两个项目 | 否；Workers 测试禁用外网 |
| `pnpm.cmd run test:node` | 只运行纯 Node 项目 | 否 |
| `pnpm.cmd run test:workers` | 只运行本地 D1/KV/DO Workers 项目 | 否；使用本地 bindings |
| `pnpm.cmd run build` | 递归构建协议包、前端和 Worker dry-run bundle | 否；Worker 使用 `--dry-run` |
| `pnpm.cmd run check` | 依次执行 typecheck、全量测试和 build | 否 |

开发提交前的最小检查：

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test
pnpm.cmd run build
```

或使用同一组检查的串行入口：

```powershell
pnpm.cmd run check
```

`check` 使用 `&&`，任一步骤退出非零都会停止。`test` 保留 `vitest run` 的显式行为：没有匹配测试、测试失败或 Workers 项目失败都必须使命令失败。`test:node`/`test:workers` 用于定位故障，不是跳过另一个项目后宣布全量通过的替代品。

构建脚本只生成检查结果和本地 bundle：`packages/apicompat` 执行 TypeScript build，`apps/web` 执行 `vue-tsc` 与 Vite build，`apps/worker` 执行 `wrangler deploy --dry-run --outdir dist`。真正的 `wrangler deploy`、远程 D1 migration、Secret 文件和域名只允许在 [deployment.md](deployment.md) 的受控发布流程中执行。

## 本地恢复核对

恢复 SQL、隔离数据库和密钥版本标签的边界见 [backup-restore.md](backup-restore.md)。只读检查可在本地迁移库上运行：

```powershell
node scripts/verify-restored-database.ts --local `
  --database DB `
  --config apps/worker/wrangler.jsonc `
  --persist-to .wrangler/r05-restore-verify `
  --json
```

脚本固定使用 `wrangler d1 execute` 的 SELECT/PRAGMA 查询，不会 restore、export、migrate 或写入 D1。远程恢复副本必须额外使用 `--remote --isolated`，且脚本会拒绝 production-like 目标；R06/R07 的真实云端恢复和 key 解密不在本地命令中。

## CI 边界

[`.github/workflows/check.yml`](../.github/workflows/check.yml) 是本地检查工作流：checkout、设置 Node 24.19.0、设置 pnpm 11.19.0、冻结安装，然后分别运行 typecheck、test 和 build。它不配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、生产 Secret、远程 binding、`wrangler deploy` 或真实上游请求；GitHub Actions 因此不会改变 Cloudflare 状态。

工作流触发于 push、pull request 和手动运行，只有 `contents: read` 权限；同一 ref 的旧检查在新提交到达时取消。它使用 GitHub Actions 的 pnpm 缓存，但缓存命中不能绕过 `--frozen-lockfile`。检查步骤保持分开，便于定位失败，并且任一步非零都会阻止该工作流通过。

工作流使用 pnpm lockfile cache 和 `--frozen-lockfile`。依赖 postinstall 仍由锁定的 `allowBuilds` 规则控制，CI 不通过命令行覆盖策略。Cloudflare 的外部 CI 认证需要 API token 与 account ID，并应放在 CI Secret 中；本地检查工作流不需要这些权限。参阅 [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) 与 [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)。

## 失败处理与证据

命令失败时保留失败的命令、Node/pnpm/Wrangler 版本、提交标识和不含凭据的摘要。修复后重新运行受影响的检查；源码、迁移、锁文件或配置发生变化时，不复用旧测试/构建证据。Workers 测试可能打印入口静态导出分析警告；要同时记录实际测试退出码和独立构建结果，不能单凭“测试进程启动”记为通过。

本地日志和构建状态使用 `.wrangler/`、`dist/`、`coverage/`、`test-results/` 等 `.gitignore` 路径。发布证据可放在工作区的 `work/`，但不要把导出的 D1、Secret 文件、Authorization、密码、上游 Key 或完整请求/响应正文复制进仓库或 CI 日志。

本文件只定义可重复的本地命令和 CI 门禁。任务图中尚未完成的业务入口、协议方向、真实上游、邮件、远程 D1/DO、浏览器和负载验收仍需各自证据，不能因为这些命令可执行而标记一期产品完成。
