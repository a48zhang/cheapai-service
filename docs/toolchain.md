# 工具链与依赖锁（F03）

本工程固定 Node.js **24.19.0**、pnpm **11.19.0**；版本分别见 `.node-version`、根 `package.json` 的 `packageManager` / `engines`。`pnpm-workspace.yaml` 启用 `engineStrict` 和 `verifyDepsBeforeRun: error`，运行脚本不会隐式安装依赖。

## 本机与跨机器启动

2026-09-05 验证环境为 Windows x64。本机原 PATH 中 Node 为 24.18.0，不能直接使用。Windows/Codex 当前子进程只提供大写 `PATH` 时，本机 pnpm 11 未能向命令环境加入项目 `.bin`；先保存原值、删除该环境变量，再以 `Path` 大小写重建并前置 bundled Node。以下在工程根目录执行，只修改当前 PowerShell 进程，不修改用户或系统 PATH：

```powershell
$toolchainOriginalPath = $env:PATH
Remove-Item Env:PATH
$env:Path = 'C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $toolchainOriginalPath
$env:WRANGLER_LOG_PATH = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path '../../work/f03-install/wrangler.log'))
node --version
pnpm.cmd --version
```

输出分别为 `v24.19.0`、`11.19.0`。本机绝对路径：

- Node：`C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- pnpm：`C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`

该 pnpm wrapper 自身绑定上述 bundled Node，但依赖脚本中的 `node` 仍需正确 PATH。`WRANGLER_LOG_PATH` 将日志重定向到可写工作区，避免默认全局日志目录的权限错误；退出该 PowerShell 进程后这些设置失效。其他机器应先读取 `.node-version`，用自己的版本管理器安装并选择该版本，再安装或启用 `packageManager` 指定的 pnpm 11.19.0；不要复制本机用户路径。安装前核对两个 `--version` 输出。

## 生成与冻结安装命令

在工程根目录执行，下面的 `../../work/f03-install` 位于本工作区，属于本地安装证据与缓存，不提交。命令级使用官方 HTTPS registry，避免继承本机腾讯 HTTP mirror；不修改用户或项目 registry 设置。

```powershell
pnpm.cmd install --lockfile-only --strict-peer-dependencies --registry=https://registry.npmjs.org --store-dir ../../work/f03-install/resolve-store --cache-dir ../../work/f03-install/resolve-cache --reporter append-only
pnpm.cmd install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org --store-dir ../../work/f03-install/final-store --cache-dir ../../work/f03-install/final-cache --reporter append-only
```

复核干净安装时使用新的、尚不存在的 store/cache 目录，并确保根目录及三个子包中没有此前生成的 `node_modules`；普通开发者可在全新 checkout 执行。不要删除源文件。最终安装前后对 `pnpm-lock.yaml`、四个 `package.json` 和 `pnpm-workspace.yaml` 计算 SHA-256，要求完全相同。

发布年龄仍为 1440 分钟。F01 作者在 workspace 内添加五个精确版本例外：`@cloudflare/workers-types@5.20260905.1`、`@playwright/test@1.63.0`、`hono@4.13.7`、`playwright-core@1.63.0`、`playwright@1.63.0`。其他依赖保持年龄检查。必需原生工具构建也仅允许 `esbuild@0.28.1`、`workerd@1.20260815.1`、`workerd@1.20260903.1`；未使用 `ignore-scripts` 或通配允许。

## 依赖图与 peer

锁格式为 9.0，覆盖根、`apps/web`、`apps/worker`、`packages/apicompat` 四个 importer。严格 peer 解析覆盖全部 204 个锁条目；Windows x64 安装的平台适用包数量与跨平台锁条目数量不同。

`@cloudflare/vitest-pool-workers@0.22.0` 的实际包清单和锁声明的三个 peer 均为 `^4.1.0`：`vitest`、`@vitest/runner`、`@vitest/snapshot`，根清单的 **4.1.11** 全部满足。不是沿用旧版 Vitest 3 的假设。

应用直接使用 Wrangler 4.129.0；测试 pool 自身依赖 Wrangler 4.124.0。因此锁中同时存在 Miniflare `5.20260903.0-alpha` / `5.20260815.0-alpha` 和 workerd `1.20260903.1` / `1.20260815.1`，不是手工去重遗漏。workspace 链接包括 worker → apicompat 和 worker 的开发依赖 → web。

```powershell
pnpm.cmd list --recursive --depth 0
pnpm.cmd list --recursive --depth Infinity --json
Get-FileHash pnpm-lock.yaml -Algorithm SHA256
```

## 验证记录与边界

初次继承本机 HTTP registry 的解析因网络 `EACCES` 停止；改用经工具许可的 npm HTTPS registry 后，严格 peer 锁解析成功。pnpm 曾自动添加 release-age 例外，F03 撤销自动修改，随后由 F01 作者显式维护原 workspace 文件。

一次中间安装使用了命令级年龄 0 覆盖，下载完成但因 `ERR_PNPM_IGNORED_BUILDS` 退出 1；它没有运行三个依赖的 postinstall，不能作为验收证据。pnpm 自动生成的 allowBuilds 占位配置也已撤销。

正式验证使用 F01 的精确例外与脚本许可、全新 `final-store` / `final-cache` 和四处空 `node_modules`，没有覆盖发布年龄。**冻结安装退出 0**，耗时 1 分 17.1 秒：204 个锁条目通过供应链策略检查，`resolved 120, reused 0, downloaded 119, added 120`。网络有一次 workerd tarball 重试，最终成功。esbuild 与两个版本 workerd 的 `postinstall: node install.js` 全部实际执行并显示 `Done`。

六文件 SHA-256 前后全部相同，锁 SHA-256 为 `810B8476E53C77F83501235B9979887AEBE97EFDD81651C1796A41B31D446E14`；最终 workspace SHA-256 为 `1C0ACAF402320D3FAB4E1A99E77CB447A9712E89EE697493B56F7BE5EA7E0AEA`。本地证据在工作区 `work/f03-install/`：`final-install.log`、`before-final.json`、`hash-checks.json`、`dependency-graph.json`。这些本地绝对路径证据不进入版本控制。

额外工具启动检查使用明确的项目路径：

```powershell
$env:WRANGLER_LOG_PATH = (Join-Path (Get-Location).Path '../../work/f03-install/wrangler.log')
& ./node_modules/.bin/vitest.CMD --version
& ./apps/web/node_modules/.bin/vite.CMD --version
& ./apps/worker/node_modules/.bin/wrangler.CMD --version
node node_modules/.pnpm/workerd@1.20260815.1/node_modules/workerd/bin/workerd --version
node node_modules/.pnpm/workerd@1.20260903.1/node_modules/workerd/bin/workerd --version
node node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild --version
```

分别输出 Vitest 4.1.11 / Vite 8.2.2（均 Node 24.19.0）、Wrangler 4.129.0、workerd 2026-08-15 / 2026-09-03、esbuild 0.28.1。

早期使用大写 `PATH` 的本机 `pnpm exec vitest` / `pnpm --filter @sub2api/web exec vite` 未找到本地命令，`pnpm --filter @sub2api/worker exec wrangler` 曾落到全局 4.98.0 并遇全局日志目录权限错误；这些失败尝试不计入工具版本证据。随后主代理使用上述当前进程 `Path` 大小写归一化步骤复核，探针显示 `localBinEntries` 已包含项目 `.bin`，以下命令分别正确输出本地 Vitest 4.1.11 和 Wrangler 4.129.0，确认该环境问题已解决；过程没有重新安装或修改系统 PATH。

```powershell
pnpm.cmd exec vitest --version
pnpm.cmd --filter @sub2api/worker exec wrangler --version
```

F03 只验证依赖安装及工具，不代表全工程测试、类型检查、构建已通过。F05 Worker 入口、F06 Wrangler/binding 配置、F07 Vitest 配置、F09 前端入口尚未具备；后续任务完成后才可运行对应集成验证。没有部署、模型请求或 Git 提交；也未安装 Playwright 浏览器，因此没有浏览器端到端测试证据。
