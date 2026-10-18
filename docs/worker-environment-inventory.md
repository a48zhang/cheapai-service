# 线上 Worker 配置清单

本清单依据当前 Worker 配置与代码，供部署时核对运行时变量、Secrets、绑定和发布凭据。线上值和资源状态使用文末命令核对。

production 配置包含 5 个普通变量、启用 Resend 邮件所需的 2 个 Secret，以及 DB、CACHE、GATE、ASSETS 4 个绑定。切换到 Cloudflare 邮件时还需要 EMAIL 绑定。

## 1. 运行时 Variables / Secrets

| 名称 | 类别与配置位置 | 是否需要 | 用途 / 当前 Git 配置 |
| --- | --- | --- | --- |
| `ENVIRONMENT` | Worker 普通变量；`apps/worker/wrangler.jsonc` 的 `env.production.vars` | 必需 | 当前 `production`；决定生产可信 `www` 入口、本地 IP 行为和入口环境校验。 |
| `PUBLIC_BASE_URL` | 同上 | 生产必需 | 当前 `https://cheapai.dev`；可信控制台 HTTPS origin、写入来源验证与 CORS；生产允许 HTTPS、同端口的 `www` 对应入口，并按本次访问 origin 校验，不进行 host 跳转。格式是 HTTPS origin，可带单个尾斜杠，不含路径/用户名密码/query/hash。 |
| `EMAIL_VERIFICATION_READY` | 同上 | 要启用验证邮件必须为 `"true"`；未设相当于 false | **当前 Git 已设 `"true"`**。它表示服务端邮件能力就绪；与数据库中的业务开关 `emailVerificationEnabled` 不同。不能用其中一个替代另一个。 |
| `EMAIL_PROVIDER` | 同上 | 当前 Resend 方案需显式设置 | 当前 `resend`；允许 `resend` / `cloudflare`，省略默认 cloudflare。 |
| `EMAIL_FROM` | 同上 | readiness=true 时需要 | 当前 `noreply@mail.cheapai.dev`；需要匹配 Resend 已验证的发送域/身份。 |
| `RESEND_API_KEY` | **Worker 运行时 Secret**；目标 Worker → Settings → Variables and Secrets | 当前 readiness=true 且 provider=resend 时必需 | Resend 发邮件凭据；代码要求非空、无空白。通过 Worker Secret 配置。 |
| `EMAIL_HMAC_KEY` | **Worker 运行时 Secret**；同上 | readiness=true 时必需 | 邮箱验证码/验证凭证摘要；标准 canonical base64，解码 32–512 字节。Git 不保存 Secret 值。 |

依据：`apps/worker/env.ts`、`apps/worker/routes.ts`、`apps/worker/auth/email-provider.ts` 与 `apps/worker/wrangler.jsonc`。

现有邮件配置校验失败的具体影响：登录已有账户不依赖邮件 Secret；注册/发送验证码及相关 readiness 诊断需要解析邮件配置。`EMAIL_HMAC_KEY`、`EMAIL_FROM` 或 provider credential 不正确时，目前部分分支只产出泛化的 `Required server configuration is missing or invalid.`，可结合服务端配置检查定位缺失项。

## 2. 资源与服务配置

| 项目 | 必需性 | Git 中生产目标 / 用途 |
| --- | --- | --- |
| Cloudflare account | 必需 | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker name | 必需 | `sub2api-cloudflare-production`；入口 `apps/worker/index.ts` |
| `DB` / D1 | 必需 | 数据库 `sub2api-cloudflare-production`，ID `d85930ad-8e4f-41b7-9fb6-ddf97719e41d`。用户、会话、渠道、模型、聊天、账单等持久化；迁移目录 `migrations/`。配置里的 `remote:false` 控制本地开发资源模式，不表示部署后仍使用本地 D1。 |
| `CACHE` / KV | 必需 | ID `3da22af80f0946cdbb9cd85caee9810d`；路由/价格等缓存，不是事实数据库。 |
| `GATE` / Durable Object | 必需 | 当前 Worker 导出的 `Gate` 类；`v1` migration 的 `new_sqlite_classes: ["Gate"]`。认证/注册节流、并发租约/RPM。无需另配密钥或 `script_name`。 |
| `ASSETS` / Static Assets | Web 首页与控制台必需 | 从 `apps/web/dist` 上传；SPA fallback；生产 `run_worker_first:true` 确保逐请求 origin 选择和公共响应头。部署前需完成 Web build。 |
| `EMAIL` / send_email | 仅 provider=cloudflare 时需要 | 生产目前 `send_email: []`，Resend 通过 fetch 发邮件，**不要添加本地 `example.invalid` 邮件绑定**。切换提供方才需配置 Cloudflare 真实已验证发件/收件约束。 |
| Routes | 对正式域名必需 | `pre.cheapai.dev/*`、`cheapai.dev/*` 和 `www.cheapai.dev/*`，zone `cheapai.dev`；DNS/代理/TLS 线上状态另核。 |
| `workers_dev` / `preview_urls` | 当前策略 | 两者生产均为 true。 |
| Cron | 后台结算/清理必需 | `*/5 * * * *`（UTC 每 5 分钟），handler 做待结算重试、遗留请求处理、过期身份数据清理；直接依赖 DB。 |
| compatibility | 必需版本基线 | `compatibility_date: "2026-08-15"`；当前没有额外 compatibility_flags，没有配置 nodejs_compat。 |
| Observability | 当前已配置 | enabled=true，head_sampling_rate=1；logs enabled、invocation_logs、persist 均 true，logs sampling=1；`upload_source_maps:true`。不是额外 LOG_LEVEL 环境变量。 |

## 3. 构建/发布配置：与运行时严格分开

main 包含非文档改动的推送由 GitHub Actions 执行正式迁移发布。原生 Preview 的资源覆盖已写入 `previews`；Cloudflare Workers Builds 独立执行生产或 Preview 构建，其路径过滤见[PR 预览](pr-previews.md#构建路径过滤)。`pnpm run build` 只构建与 dry-run；`pnpm run deploy` 明确选择 production 并执行正式发布，不能作为 PR Preview 命令。预发配置及后续状态见[预发说明](pr-previews.md)，正式发布见[部署步骤](deployment.md)。

| 名称 / 设置 | 所在位置 | 是否需要 / 作用 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 本地 CLI 执行环境或 CI secret / Builds 的部署认证 | 非交互 CLI/CI 访问 Cloudflare 时需要，或由 Cloudflare 托管 Builds 的部署授权提供。**不是 Worker 运行时 Secret，也不是 RESEND_API_KEY**；不要把它塞入业务 Worker vars。 |
| `CLOUDFLARE_ACCOUNT_ID` | CLI/CI 环境、GitHub Actions variable | 生产 account_id 已写在 wrangler，普通生产脚本不另外强制读取。需与目标 account 一致。 |
| `CLOUDFLARE_ENV` | CLI 进程环境 | 不必配置，production 脚本的显式 `--env production` 已固定目标。 |
| Node / pnpm | Builds 运行环境 | 根 package.json 声明 Node `24.19.0`、pnpm `11.19.0`；应使用 lockfile 安装。不是 Worker runtime 参数。 |
| `WRANGLER_SEND_METRICS` | CLI/CI 可选 | 常规检查 CI 设 false，控制 Wrangler 遥测，不影响业务日志。 |

**在 Builds 中填 EMAIL_HMAC_KEY/RESEND_API_KEY 不会自动变成 Worker env binding。** 应配置到指定 production Worker 的运行时 Variables and Secrets。反过来，运行时 Secret 不是给构建进程准备的部署凭据。

## 4. Web / Desktop 与 PR preview 区分

- Web 使用同源 `/api`、`/v1`，无生产 `VITE_API_BASE_URL` 必配项。`CHEAPAI_WEB_TLS_KEY_FILE`、`CHEAPAI_WEB_TLS_CERT_FILE`、`CHEAPAI_WEB_PORT`、`CHEAPAI_WORKER_PORT` 是本地开发 Vite/launcher 配置，不是线上 Worker 变量。
- Desktop runtime 可选 `SUB2API_DESKTOP_API_BASE_URL`（默认 `https://cheapai.dev`）、`SUB2API_DESKTOP_MODEL_BASE_URL`（默认 `https://cheapai.dev/v1`）、`SUB2API_DESKTOP_MODEL_API`（默认 `openai-completions`；也支持 openai-responses / anthropic-messages）。它们属于客户端进程配置，Worker 不消费它们；当前默认生产地址无需人工补 Worker env。
- Desktop 的 `SUB2API_DSH_*` 路径和 development-only key mode 属于本机侧，不是 Cloudflare runtime 配置。
- 原生 Preview 使用 `previews` 中指定的 D1/KV，并分配独立 Gate。GitHub PR 检查不执行部署；main 包含非文档改动的推送执行正式发布。

## 5. 环境变量之外的必要上线步骤

- D1 schema 要与发布代码匹配；`wrangler deploy` 不会自动执行 D1 SQL migrations。当前仓库包含 `0001` 至 `0030` 共 30 个迁移。`pnpm run deploy:ci` 会在发布前应用缺失迁移。
- 旧渠道密文在迁移中保留但不可在移除密钥环后自动解密，需要重新输入渠道上游 key；旧加密 Desktop 会话迁移要求重新登录。迁移前备份数据库，并安排渠道凭据重录与 Desktop 重新登录。
- 注册模式/邮箱验证业务开关在 D1 settings，渠道 key/地址/模型映射/价格与用户权限在 D1/管理界面，不是 Worker env。`RuntimeConfig` 中的 timeout/body/limit 默认值也不是任意同名环境变量读取器。
- Resend 的 `mail.cheapai.dev` 发送域验证、API key 授权及真实发送结果属外部服务状态；启用邮件前检查实际投递。
- `/healthz` 检查进程存活；D1、邮件和上游按[部署后检查](deployment.md#7-发布后验证和维护)分别验证。

## 6. 可执行的只读核对命令

在仓库根目录执行；需要现有 Cloudflare 登录/Token 权限。下列命令不读取 Secret 值，不发布、不 apply migrations：

```sh
pnpm --filter @sub2api/worker exec wrangler whoami
pnpm --filter @sub2api/worker exec wrangler secret list --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler deployments list --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler d1 info sub2api-cloudflare-production --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler d1 migrations list DB --remote --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler kv namespace list --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler d1 execute DB --remote --command 'SELECT 1 AS ok' --config wrangler.jsonc --env production
```

需要观察新增请求时可运行 `pnpm --filter @sub2api/worker exec wrangler tail --config wrangler.jsonc --env production --format json`；它只监听新日志，不会回查历史 request_id。历史 ID 在 Observability Logs 搜索。Secret 有效性需通过对应服务调用验证。

Dashboard 需逐项核对：Worker Settings → Variables and Secrets（普通值及 Secret 名称）、Bindings（资源 ID）、Triggers（routes/cron）、Builds（命令/根目录/部署授权）、Observability（日志/版本），以及 Resend 域验证。
