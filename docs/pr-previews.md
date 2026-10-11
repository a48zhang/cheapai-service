# Pull request 预发

`.github/workflows/preview.yml` 在同仓库 PR 的 opened、synchronize、reopened 事件部署分支 head（包括 draft），closed 时停用它的公开 URL。Fork 和 Dependabot PR 不获得部署凭据；不使用 `pull_request_target`。部署脚本从事件对应的 PR base SHA 检出，应用源码和迁移仍来自 PR head，旧分支中的部署脚本不会覆盖共享环境策略。原有 `Local checks` 独立执行完整类型检查、测试和构建，preview 成功不能替代这些检查。

## 连接已有预发环境

PR CI 不创建共享 D1、KV 或 Durable Object namespace，也不部署或更新共享 Gate Worker。固定共享预发为 `cheapai-preview`，配置保存在 [`apps/worker/wrangler.preview.jsonc`](../apps/worker/wrangler.preview.jsonc)。在仓库 Settings → Secrets and variables → Actions 配置：

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | 目标账户的 Workers Scripts: Edit、D1: Edit、Workers KV Storage: Read 权限；不需要 DNS、Routes 或 Email Routing 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | 已有预发所在的账户 ID |

共享预发 Worker 必须具备以下现存绑定：

- `ENVIRONMENT`：普通变量，值为 `staging`。
- `DB`：已存在的预发 D1。
- `CACHE`：已存在的预发 KV。
- `GATE`：已存在的 `Gate` Durable Object namespace，可以属于共享预发 Worker 自身，也可以通过 `script_name` 指向已有 Gate host。

CI 固定按名称查找 `cheapai-preview`，不需要预发选择变量，也没有覆盖入口。读取该 Worker 的绑定，核实 D1、KV 和 Gate namespace 的实际存在及一致性，拒绝生产环境标记及与 `sub2api-cloudflare-production` 相同的存储绑定。目标 Worker 或资源缺失、读取失败时直接失败，提供配置提示，不回退到生产，也不尝试新建。

2026-10-11 已清理两套历史预发及其 PR Worker，并单独建立一套固定共享预发：

| 资源 | 名称 / ID |
| --- | --- |
| Worker / Gate host | `cheapai-preview` |
| 共享入口 | <https://cheapai-preview.alphazhang689.workers.dev> |
| D1 | `cheapai-preview` / `f9719b76-adb4-4ebe-be98-6e784e2440a1` |
| KV | `cheapai-preview-cache` / `2e433b90bb3a4bc4a1b890852384bc80` |
| Gate namespace | 由共享 Worker 的 `v1` SQLite DO migration 建立，PR 通过 `script_name: cheapai-preview` 复用 |

共享 Worker 同时提供前端、API 和 Gate，开启 Cloudflare 原生日志；邮件及 cron 关闭。数据库只初始化仓库迁移和默认配置，不复制生产账号、渠道、余额或 Secrets。初始化管理员后才能登录；真实模型测试需要配置预发专用渠道和余额。

Token 在 GitHub 安全输入框填写，不提交 Git 或粘贴日志。只有可信的同仓库分支可以使用部署凭据；从 base 读取脚本是为了统一部署策略，并不使未经审核的 PR 应用代码变得可信。

更新共享环境时显式使用固定预发配置，以下命令只迁移和部署已有资源，不创建 D1 或 KV：

```sh
pnpm --filter @cheapai/web run build
pnpm --filter @sub2api/worker exec wrangler deploy --config wrangler.preview.jsonc --dry-run --strict
pnpm --filter @sub2api/worker exec wrangler d1 migrations apply DB --remote --config wrangler.preview.jsonc
pnpm --filter @sub2api/worker exec wrangler deploy --config wrangler.preview.jsonc --strict
```

这些命令需要预发维护 Token（Workers Scripts: Edit、D1: Edit、Workers KV Storage: Read），并保留原有 Gate migration tag。不要使用根目录的 `pnpm deploy`，它选择生产环境。

## 一套共享预发，多个分支入口

每个 PR 的代码和 URL 独立：Worker 名称为 `sub2api-<仓库名 SHA256 前10位>-pr-<PR号>`。只有这个分支 Worker 和静态资源由 PR CI 发布；所有 PR 绑定 `cheapai-preview` 的同一套 D1、KV 和 Gate。共享资源不按仓库名推导，因此仓库改名不会创建第二套底层环境。

数据、用户、余额、缓存、限流和渠道冷却都共享。PR 代码的数据库迁移仍应用到共享 D1，因此会影响其他预发；PR 部署不会更新共享 Gate 代码。需要更改 Gate 的类实现或 namespace 时，先单独更新共享环境，并维持各分支的接口兼容。

流程：构建前端 → 只读校验已有预发绑定 → Wrangler strict dry-run → 应用已有预发 D1 的迁移 → 发布本 PR Worker 和静态资源 → 检查 `/healthz` 与首页 HTML。Actions Summary 显示分支 URL、确切 head SHA、共享 Worker、数据库及 Gate host。邮件和 cron 在 PR 环境关闭；烟测只覆盖 HTML 和存活，不覆盖真实邮件、模型、登录及账单链路。

所有预发部署共用一个 concurrency group，不中断正在执行的迁移。GitHub 同组只保留一个待执行任务，多 PR 连续推送时，被替换的 pending run 可重跑。部署前检查当前 PR 状态和 head，过期任务跳过。CI 不清库、不回滚数据、不备份、不复制生产数据。生成配置保存在已忽略的 `.wrangler/pr-preview-<PR号>.json`。

## 首次登录与真实模型测试

本地使用同一账户的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量，脚本同样按名称查找 `cheapai-preview`；如未设置 `GITHUB_REPOSITORY`，默认仓库为 `a48zhang/cheapai-service`。示例 PR 号须替换为实际 PR：

```sh
PR_NUMBER=1 node scripts/pr-preview.mjs --config-only
node scripts/bootstrap-admin.ts --remote --preview 1
```

`--config-only` 只读取已有预发并生成本地配置，不要求该 PR 已部署，也不创建远程资源。管理员脚本再次校验当前共享环境与生成配置一致，然后交互询问管理员邮箱和隐藏密码。只需初始化一次，所有 PR 共用这个账号；脚本不重置现有管理员，初始余额为 0。管理员登录后按[管理员指南](admin-guide.md)配置预发专用渠道、模型映射、分组、授权和余额，再验证聊天及网关。

## 关闭、重试与清理

PR 关闭后只停用该分支 Worker 的 workers.dev 和 version preview URL；不会删除分支 Worker，也不会改变共享 D1、KV 或 Gate。即使共享环境尚未配置或已退役，关闭操作也能独立执行。

关闭操作失败时重跑该 closed-event run。GitHub 对有合并冲突的 `pull_request` 可能不触发运行，此时可手工关闭该 PR Worker 的 workers.dev。部署失败后修正已有环境或配置再重跑，不会分配新的共享资源；若部署成功但烟测失败，Actions 保持失败并提供 URL 供排查。

官方参考：[跨 Worker 共享 Durable Objects](https://developers.cloudflare.com/durable-objects/reference/environments/)、[Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[GitHub pull_request 事件与 fork 限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)。
