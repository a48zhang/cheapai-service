# 本地开发与检查

更新：2026-10-03；本轮修改基于 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a`。命令从仓库根目录执行；Windows 中可把 `pnpm` 换为 `pnpm.cmd`。工具链安装与历史 Windows `Path` 问题见[工具链记录](toolchain.md)。

## 1. 固定版本，安装和检查

使用 `.node-version` 指定的 Node **24.19.0** 和根 `package.json` 指定的 pnpm **11.19.0**，不要复制他人机器上的 Node 绝对路径。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
pnpm run check
```

`pnpm-workspace.yaml` 的 engineStrict、依赖年龄与 allowBuilds 策略继续生效。安装失败先检查版本和 registry，不删除锁文件、不用 ignore-scripts 或全局放宽构建脚本策略来伪造通过。

| 命令 | 内容 | 边界 |
| --- | --- | --- |
| `pnpm run typecheck` | 三个 workspace 类型检查 | 不运行浏览器 |
| `pnpm run test` | Vitest 的 node 与 workers 两个项目 | 本地 D1/KV/DO 和模拟上游；不是真实云验收 |
| `pnpm run test:node` / `test:workers` | 单独项目定位问题 | 不能代替全量测试 |
| `pnpm run build` | 协议包、Vue 前端和 Worker dry-run bundle | 不发布到 Cloudflare |
| `pnpm run check` | typecheck → test → build，任一步失败停止 | 不包含 Playwright |
| `pnpm --filter @sub2api/web run test:e2e` | Playwright 浏览器测试 | 独立隔离环境，见下文 |

前端产物在 `apps/web/dist`，Worker dry-run 会读取它。优先使用根 `build` 保证顺序，不把 dist、.wrangler、test-results 提交到 Git。

## 2. 先区分三种启动方式

### A. 前端样式开发

```sh
pnpm run dev:web
```

这是 Vite 前端服务器。当前 `apps/web/vite.config.ts` 没有 `/api` 代理或开发 HTTPS 配置，API 客户端使用相对路径；因此只启动 Vite 不能得到可登录的完整应用。不要把“页面显示出来”当成鉴权和聊天已跑通。

### B. 完整本地 Worker

Worker 同源提供构建后的前端和 API。首次启动至少需要：前端构建、本地 D1 全部迁移、本地配置、管理员及与 PUBLIC_BASE_URL 一致的 HTTPS 地址。

1. 创建只用于本地的 `apps/worker/.dev.vars`。该路径受 `.gitignore` 保护；不要覆盖已有文件或复制生产 Secrets。最小身份配置为：

```dotenv
PUBLIC_BASE_URL=https://127.0.0.1:8787
EMAIL_VERIFICATION_READY=false
```

只有登录/管理读取并不要求邮件就绪。配置真实或本地模拟上游渠道时，还需要 `CHANNEL_KEYRING_JSON` 与 `CHANNEL_ACTIVE_KEY_VERSION`：keyring 为版本名到 canonical base64 32 字节随机 AES key 的 JSON 对象，活动版本必须存在。它们是本地 Secret，应使用安全生成方式写入 `.dev.vars`，不要粘贴生产值或把占位字符串当作有效密钥。详细格式见[部署配置](deployment.md#4-环境值和-secrets)。

2. 使用同一个状态目录迁移、初始化并启动。以下参数取自仓库脚本和配置；不使用 `--remote`：

```sh
pnpm --filter @sub2api/web run build
node apps/worker/node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --config apps/worker/wrangler.jsonc --local --persist-to .wrangler/development-state
node apps/worker/node_modules/wrangler/bin/wrangler.js d1 migrations list DB --config apps/worker/wrangler.jsonc --local --persist-to .wrangler/development-state
node scripts/bootstrap-admin.ts --local --persist-to .wrangler/development-state
node apps/worker/node_modules/wrangler/bin/wrangler.js dev --config apps/worker/wrangler.jsonc --local --persist-to .wrangler/development-state --ip 127.0.0.1 --port 8787 --local-protocol https
```

初始化管理员要求交互终端，只创建第一个管理员。已有管理员时不要重复初始化；它不能用于重置密码。随后按[管理员指南](admin-guide.md)完成渠道、模型、分组授权和授额。

3. 使用与 `PUBLIC_BASE_URL` 完全一致的地址访问。浏览器必须信任开发 HTTPS 证书；若出现安全警告，先正确配置/信任本地开发证书，不要通过降低 Cookie/CSRF 安全要求来解决。`localhost` 和 `127.0.0.1` 是不同 origin，HTTP 与 HTTPS 也不同。

仓库配置的本地默认 vars 只有 `ENVIRONMENT=local`。直接执行 `pnpm run dev:worker` 不会自动补 PUBLIC_BASE_URL、迁移或业务数据；`/healthz` 只是存活探针，不检查数据库、邮件、渠道和余额。

本地 bindings 不会自动投递真实邮件。若需要完整邮件/模型模拟链路，使用下面的测试环境；不要为本地验证临时接入生产数据库、生产 Key 或公网测试控制接口。

### C. 隔离浏览器测试

```sh
# 首次在本机运行时准备 Playwright 浏览器
pnpm exec playwright install chromium
pnpm --filter @sub2api/web run test:e2e
```

`playwright.config.ts` 启动 `scripts/start-local-test-server.mjs`。它会重新构建前端，创建独立的 `.wrangler/e2e/run-*` 状态目录，应用全部迁移、创建测试管理员，并挂载 `tests/helpers/http-test-worker.ts`。上游和邮件是模拟的，不代表真实供应商可用。

默认地址为 `https://127.0.0.1:9789`；可用 `SUB2API_E2E_PORT` 选择本地端口。测试配置允许本地测试证书；这不是生产 TLS 配置。脚本生成的连接信息和测试控制 token 位于被 Git 忽略的目录，不能发布或分享。测试 Worker 含 `/__test__/*` 控制路由，不得作为生产入口部署。

2026-10-03 的浏览器尝试因 Chromium socket EPERM 启动失败，未完成本轮浏览器验收。需在允许本地进程/套接字的环境重新运行；不能将 Node 逻辑测试替代为浏览器通过。

Linux 缺浏览器系统依赖时按 Playwright 的实际报错准备环境；不要把浏览器未启动或被跳过记为测试通过。Windows 优先使用配置中探测到的 Edge，否则需要可用 Playwright 浏览器。浏览器报告写入 `test-results/browser-results.json`，失败 trace 保留在测试结果目录。

## 3. 定时维护和恢复检查

要在本地测试 Cron，在完整 Worker 启动命令上增加 `--test-scheduled`，然后用相同 HTTPS origin 访问 `/__scheduled`。它是开发功能，不是公开管理 API。不要混用不同本地状态目录。

本地恢复的只读验证示例：

```sh
node scripts/verify-restored-database.ts --local --database DB --config apps/worker/wrangler.jsonc --persist-to .wrangler/development-state --json
```

它执行 SELECT/PRAGMA 验证，不自动恢复、迁移或写入数据库。完整流程与真实恢复演练见[备份与恢复](backup-restore.md)。

## 4. CI 和验收记录

[Local checks](../.github/workflows/check.yml) 在 push、pull request、手动触发时冻结安装，然后分别执行 typecheck、Vitest 和 build。它没有 Playwright 步骤，也没有 Cloudflare 发布或真实模型/邮件调用。

`54d71d5` 的[检查结果](https://github.com/a48zhang/sub2api-cloudflare/actions/runs/36874254293)已通过上述三个检查；修改后的代码必须重新检查，不能沿用旧提交结果。本轮按模块完成后集中验证，开发任务不夹带测试；最终完整代码另行执行 V-INTEGRATION。局部回归结果与浏览器受阻状态见[执行计划](implementation-plan.md)。

失败记录至少包含提交、环境、版本、命令、退出码和脱敏摘要。保留通过/失败/未运行的区分；局部回归不能代表全量通过。涉及部署、迁移或 Secrets 时使用[部署流程](deployment.md)，不要在日常 check 中加入有远程写入副作用的命令。

## 常见本地启动问题

| 现象 | 先检查 |
| --- | --- |
| Vite 页面正常但 API 报错 | 当前 Vite 无 API proxy；使用完整 Worker 或专门配置开发集成 |
| 登录/注册写请求 403 | origin 与 PUBLIC_BASE_URL 是否精确一致、HTTPS/CSRF Cookie 是否有效 |
| 服务不可用但 healthz 正常 | PUBLIC_BASE_URL、本地迁移/绑定、所操作功能需要的 Secret |
| 初始化的账户无法找到 | bootstrap、migration、dev 是否用了相同 persist-to |
| 登录后暂无可用模型或余额不足 | 完成渠道/映射/组授权与授额；初始化只创建零余额管理员 |
| Worker 提示静态资源不存在 | 先构建 apps/web，检查 assets.directory |
| Windows 找不到项目内命令 | 确认使用固定版本及项目依赖，参阅工具链中的历史 Path 排查 |
