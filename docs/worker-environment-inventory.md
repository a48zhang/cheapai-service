# 线上 Worker 配置清单

审计日期：2026-10-05（Asia/Shanghai）。只读检查仓库配置与实际代码消费点；未读取任何 Secret 值，未修改生产代码、Cloudflare 配置或远端数据。渠道密钥环移除已在当前工作树完成，尚未发布；下文按移除后的目标列清单；其余校验/加密只报告，不擅自调整。

## 结论

当前 production 配置需要 **5 个运行时普通变量、当前启用邮件所需的 2 个运行时 Secret，以及 DB/CACHE/GATE/ASSETS 4 个资源绑定**。Cloudflare 邮件 EMAIL 绑定仅在切换 cloudflare 邮件提供方时需要，当前 Resend 不需要。`CHANNEL_KEYRING_JSON` / `CHANNEL_ACTIVE_KEY_VERSION` 移除后不再需要，不应再为渠道创建配置主密钥。

这是仓库预期配置，不是线上已配置证明。远端实际变量、Secret 名称/有效性、数据库迁移水位、资源与域名关联、发送域验证状态、Builds 设置和已发布版本，均未在本次审计中回读。

## 1. 运行时 Variables / Secrets

| 名称 | 类别与配置位置 | 是否需要 | 用途 / 当前 Git 配置 |
| --- | --- | --- | --- |
| `ENVIRONMENT` | Worker 普通变量；`apps/worker/wrangler.jsonc` 的 `env.production.vars` | 必需 | 当前 `production`；决定生产 canonical redirect、本地 IP 行为和入口环境校验。 |
| `PUBLIC_BASE_URL` | 同上 | 生产必需 | 当前 `https://cheapai.dev`；可信控制台 HTTPS origin、写入来源验证、CORS、www 跳转。格式是 HTTPS origin，可带单个尾斜杠，不含路径/用户名密码/query/hash。 |
| `EMAIL_VERIFICATION_READY` | 同上 | 要启用验证邮件必须为 `"true"`；未设相当于 false | **当前 Git 已设 `"true"`**。它表示服务端邮件能力就绪；与数据库中的业务开关 `emailVerificationEnabled` 不同。不能用其中一个替代另一个。 |
| `EMAIL_PROVIDER` | 同上 | 当前 Resend 方案需显式设置 | 当前 `resend`；允许 `resend` / `cloudflare`，省略默认 cloudflare。 |
| `EMAIL_FROM` | 同上 | readiness=true 时需要 | 当前 `noreply@mail.cheapai.dev`；需要匹配 Resend 已验证的发送域/身份。 |
| `RESEND_API_KEY` | **Worker 运行时 Secret**；目标 Worker → Settings → Variables and Secrets | 当前 readiness=true 且 provider=resend 时必需 | Resend 发邮件凭据；代码要求非空、无空白。Git 不包含值；本审计未读取/验证线上值。不是 Cloudflare API Token。 |
| `EMAIL_HMAC_KEY` | **Worker 运行时 Secret**；同上 | readiness=true 时必需 | 邮箱验证码/验证凭证摘要；标准 canonical base64，解码 32–512 字节。此为现存独立邮件 HMAC，不是本次移除的渠道 AES 密钥环；是否保留由用户另行确认。Git 无值，本审计未读取/验证线上值。 |
| `CHANNEL_KEYRING_JSON` | 原 Worker Secret | **本次移除后不再需要** | 原渠道与 Desktop 返回式 API key 加密密钥环。不要再配置或生成替代主密钥；远端残留 Secret 不会因仅删除 Env 类型而自动删除。 |
| `CHANNEL_ACTIVE_KEY_VERSION` | 原 Worker Secret | **本次移除后不再需要** | 原当前加密版本，处理同上。 |

依据：`apps/worker/env.ts`；`apps/worker/routes.ts:55–93`；`apps/worker/auth/email-provider.ts:6–15`；`apps/worker/wrangler.jsonc:66–72`。

现有邮件配置校验失败的具体影响：登录已有账户不依赖邮件 Secret；注册/发送验证码及相关 readiness 诊断需要解析邮件配置。`EMAIL_HMAC_KEY`、`EMAIL_FROM` 或 provider credential 不正确时，目前部分分支只产出泛化的 `Required server configuration is missing or invalid.`，这仍是可读错误信息不足点，属于报告项。

## 2. 资源与服务配置

| 项目 | 必需性 | Git 中生产目标 / 用途 |
| --- | --- | --- |
| Cloudflare account | 必需 | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker name | 必需 | `sub2api-cloudflare-production`；入口 `apps/worker/index.ts` |
| `DB` / D1 | 必需 | 数据库 `sub2api-cloudflare-production`，ID `d85930ad-8e4f-41b7-9fb6-ddf97719e41d`。用户、会话、渠道、模型、聊天、账单等持久化；迁移目录 `migrations/`。配置里的 `remote:false` 控制本地开发资源模式，不表示部署后仍使用本地 D1。 |
| `CACHE` / KV | 必需 | ID `3da22af80f0946cdbb9cd85caee9810d`；路由/价格等缓存，不是事实数据库。 |
| `GATE` / Durable Object | 必需 | 当前 Worker 导出的 `Gate` 类；`v1` migration 的 `new_sqlite_classes: ["Gate"]`。认证/注册节流、并发租约/RPM。无需另配密钥或 `script_name`。 |
| `ASSETS` / Static Assets | Web 首页与控制台必需 | 从 `apps/web/dist` 上传；SPA fallback；生产 `run_worker_first:true` 确保 www 跳转和公共响应头。部署前需完成 Web build。 |
| `EMAIL` / send_email | 仅 provider=cloudflare 时需要 | 生产目前 `send_email: []`，Resend 通过 fetch 发邮件，**不要添加本地 `example.invalid` 邮件绑定**。切换提供方才需配置 Cloudflare 真实已验证发件/收件约束。 |
| Routes | 对正式域名必需 | `cheapai.dev/*` 和 `www.cheapai.dev/*`，zone `cheapai.dev`；DNS/代理/TLS 线上状态另核。 |
| `workers_dev` / `preview_urls` | 当前策略 | 两者生产均 false；不使用 workers.dev 作为生产入口。 |
| Cron | 后台结算/清理必需 | `*/5 * * * *`（UTC 每 5 分钟），handler 做待结算重试、遗留请求处理、过期身份数据清理；直接依赖 DB。该配置不等于远端 trigger 已生效。 |
| compatibility | 必需版本基线 | `compatibility_date: "2026-08-15"`；当前没有额外 compatibility_flags，没有配置 nodejs_compat。 |
| Observability | 当前已配置 | enabled=true，head_sampling_rate=1；logs enabled、invocation_logs、persist 均 true，logs sampling=1；`upload_source_maps:true`。不是额外 LOG_LEVEL 环境变量。 |

未发现当前 Worker 需要 R2、Queues、service binding、独立 DATABASE_URL、JWT_SECRET、SESSION_SECRET、SMTP、Turnstile 或 Sentry 环境变量；不能把这些名称当成缺失配置。

## 3. 构建/发布配置：与运行时严格分开

Cloudflare Workers Builds 目标应为上述 production Worker，Root directory `/`，Build command `pnpm run build`，Deploy command `pnpm run deploy`。仓库脚本已经显式指定 `--config wrangler.jsonc --env production --strict`。继续使用裸 `npx wrangler deploy` 会选择顶层 local 配置，不能只依赖 CI 替换 Worker 名字。

| 名称 / 设置 | 所在位置 | 是否需要 / 作用 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 本地 CLI 执行环境或 CI secret / Builds 的部署认证 | 非交互 CLI/CI 访问 Cloudflare 时需要，或由 Cloudflare 托管 Builds 的部署授权提供。**不是 Worker 运行时 Secret，也不是 RESEND_API_KEY**；不要把它塞入业务 Worker vars。 |
| `CLOUDFLARE_ACCOUNT_ID` | CLI/CI 环境、GitHub Actions variable | 生产 account_id 已写在 wrangler，普通生产脚本不另外强制读取；PR preview 脚本显式必需。需与目标 account 一致。 |
| `CLOUDFLARE_ENV` | CLI 进程环境 | 不必配置，production 脚本的显式 `--env production` 已固定目标；仅设它而保留旧错误命令不是建议部署方式。 |
| Node / pnpm | Builds 运行环境 | 根 package.json 声明 Node `24.19.0`、pnpm `11.19.0`；应使用 lockfile 安装。不是 Worker runtime 参数。 |
| `WRANGLER_SEND_METRICS` | CLI/CI 可选 | 预览 workflow 设 false，控制 Wrangler 遥测，不影响业务日志。 |
| `GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`PR_NUMBER`、`PR_HEAD_SHA`、`PR_EVENT_ACTION` | 仅 GitHub PR preview workflow | 自动提供或按事件注入；生产运行时不需要。 |

**在 Builds 中填 EMAIL_HMAC_KEY/RESEND_API_KEY 不会自动变成 Worker env binding。** 应配置到指定 production Worker 的运行时 Variables and Secrets。反过来，运行时 Secret 不是给构建进程准备的部署凭据。

## 4. Web / Desktop 与 PR preview 区分

- Web 使用同源 `/api`、`/v1`，无生产 `VITE_API_BASE_URL` 必配项。`CHEAPAI_WEB_TLS_KEY_FILE`、`CHEAPAI_WEB_TLS_CERT_FILE`、`CHEAPAI_WEB_PORT`、`CHEAPAI_WORKER_PORT` 是本地开发 Vite/launcher 配置，不是线上 Worker 变量。
- Desktop runtime 可选 `SUB2API_DESKTOP_API_BASE_URL`（默认 `https://cheapai.dev`）、`SUB2API_DESKTOP_MODEL_BASE_URL`（默认 `https://cheapai.dev/v1`）、`SUB2API_DESKTOP_MODEL_API`（默认 `openai-completions`；也支持 openai-responses / anthropic-messages）。它们属于客户端进程配置，Worker 不消费它们；当前默认生产地址无需人工补 Worker env。
- Desktop 的 `SUB2API_DSH_*` 路径和 development-only key mode 属于本机侧，不是 Cloudflare runtime 配置。
- PR preview 脚本生成独立 Worker 配置，ENVIRONMENT=staging，PUBLIC_BASE_URL=对应 workers.dev，EMAIL_VERIFICATION_READY=false，send_email=[]，cron=[]。多个 PR 共用专用 preview D1/KV/Gate host，与 production 资源不同；配置文件不包含固定 named staging 环境。不要把生产 Secret 复制进 preview 来“补齐”列表。

## 5. 环境变量之外的必要上线步骤

- D1 schema 要与发布代码匹配；`wrangler deploy` 不会自动执行 D1 SQL migrations。审计时仓库现有 `0001`–`0026`，其中 `0025_channel_plaintext_keys.sql` / `0026_desktop_plaintext_keys.sql` 是此次去加密新增的迁移；远端水位未知，最终以合并后的迁移清单为准。
- 旧渠道密文在迁移中保留但不可在移除密钥环后自动解密，需要重新输入渠道上游 key；旧加密 Desktop 会话迁移要求重新登录。具体迁移行为应由实施变更的负责人复核，不能把这当成 Secret 缺失继续添加密钥。
- 注册模式/邮箱验证业务开关在 D1 settings，渠道 key/地址/模型映射/价格与用户权限在 D1/管理界面，不是 Worker env。`RuntimeConfig` 中的 timeout/body/limit 默认值也不是任意同名环境变量读取器。
- Resend 的 `mail.cheapai.dev` 发送域验证、API key 授权及真实发送结果属外部服务状态；Git 中 readiness=true 不证明已通过。
- `/healthz` 明确只做 liveness，不查询 D1/邮件/上游，200 不证明集成正常。

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

需要观察新增请求时可运行 `pnpm --filter @sub2api/worker exec wrangler tail --config wrangler.jsonc --env production --format json`；它只监听新日志，不会回查历史 request_id。历史 ID 在 Observability Logs 搜索。上述只读命令的通过也不证明 Secret 值正确；此报告没有执行它们或声称线上已验证。

Dashboard 需逐项核对：Worker Settings → Variables and Secrets（普通值及 Secret 名称）、Bindings（资源 ID）、Triggers（routes/cron）、Builds（命令/根目录/部署授权）、Observability（日志/版本），以及 Resend 域验证。这里只核对配置与名字，不要求用户贴 Secret。

## 7. 文档同步

审计发现部署和管理员指南仍将生产邮件 readiness 写为 false，文档迁移数量也落后。主任务已按当前 Git 配置同步为 readiness=true、26 份迁移。这只是仓库说明修正，不证明线上配置或迁移已生效。
