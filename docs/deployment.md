# 部署步骤

更新：2026-10-03；配置基线为 main `fd6ce3d37de87239a7474a04ab85b83c96f7df11`，本次清理移除共享 staging 的可执行入口。共享 staging 已于 2026-10-03 完成永久退役，相关 Worker、D1、KV 和 Gate DO 已删除并回读确认；这次文档更新不是删除或发布成功证明。历史资源与证据见[退役记录](staging-resources.md)。

先读[管理员配置顺序](admin-guide.md)。正式入口为 https://cheapai.dev，www 入口由 Worker 重定向至 canonical origin。分支验证使用[每个 PR 独立的预发](pr-previews.md)；不要重建旧共享 staging，也不要以历史验证结果代替本次验收。

## 发布前准备

从仓库根目录执行 `pnpm run production:check`（Windows 可用 `pnpm.cmd`）。它先构建前端，再对 **production** 执行 `deploy --dry-run --strict`，输出到忽略提交的 `.wrangler/build-production`；不会上传、应用远程迁移、配置 Secrets 或发布。此检查只验证打包和配置，不证明线上功能可用。

### Cloudflare Workers Builds 设置

2026-10-05 修正：Worker 的 `build` 和 `deploy` 脚本均显式指定配置文件及 `--env production`，本地 `dev` 显式指定顶层环境和 `--local`。顶层配置仍是本地占位资源，不作为生产默认值。

在 `sub2api-cloudflare-production` 的 Settings → Builds 中使用以下设置：

| 设置 | 值 |
| --- | --- |
| Root directory | 仓库根目录 `/` |
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy` |

这些 Dashboard 设置不由 Git 中的 package scripts 自动覆盖。必须将已有的裸命令 `npx wrangler deploy` 替换为上表命令，再重试发布。若保留 Wrangler 直接调用，等价命令为 `pnpm --filter @sub2api/worker exec wrangler deploy --config wrangler.jsonc --env production --strict`。`deploy` 使用构建步骤生成的前端产物，不重复构建。

CI 自动将 Worker 名称替换为 production 名称，不会同时切换 D1、KV、邮件或 vars。构建及发布日志中应确认 `ENVIRONMENT` 为 `production`、DB 为 `sub2api-cloudflare-production`、CACHE 为 `3da22af80f0946cdbb9cd85caee9810d`，且没有 local 邮件占位绑定。不能只依据 Worker 名称判断选中了生产环境。

本地验证：在故意设置 `CLOUDFLARE_ENV=local` 时，`pnpm run build` 和 `pnpm run deploy --dry-run --outdir /tmp/cheapai-production-deploy` 均成功，解析为上述生产绑定。未实际发布，也未修改 Dashboard 配置。Wrangler 仍提示生产未继承顶层 `send_email`；这是 production 使用 Resend、明确设置 `send_email: []` 的现有配置，不应补入本地邮件绑定。

发布者必须核对目标账户及现有资源，不能重复创建或替换：

| production 项目 | 配置值 |
| --- | --- |
| Cloudflare account | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker | `sub2api-cloudflare-production` |
| D1 / `DB` | `sub2api-cloudflare-production` / `d85930ad-8e4f-41b7-9fb6-ddf97719e41d` |
| KV / `CACHE` | `3da22af80f0946cdbb9cd85caee9810d` |
| 公网 origin | `https://cheapai.dev` |
| routes | `cheapai.dev/*`、`www.cheapai.dev/*` |

以下为只读核对，不读取 Secret 值：

```sh
pnpm --filter @sub2api/worker exec wrangler whoami
pnpm --filter @sub2api/worker exec wrangler d1 info sub2api-cloudflare-production --env production
pnpm --filter @sub2api/worker exec wrangler kv namespace list --env production
pnpm --filter @sub2api/worker exec wrangler d1 migrations list DB --env production --remote
pnpm --filter @sub2api/worker exec wrangler secret list --env production
pnpm --filter @sub2api/worker exec wrangler deployments list --env production
```

发布前确认账户权限、备份、23 份迁移水位、渠道 keyring 保留版本与活动版本；只检查 Secret 名称不等于验证值。生产和 PR 均默认关闭邮件，启用前必须验证发件身份、投递与获批收件人，不能只改 readiness。真实上游调用、负载及恢复验证另行限定目标、权限和预算。

先完成类型、测试、构建和 PR 验证，再核对生产目标、备份、迁移与发布授权；部署后核对真实域名和功能。PR 默认没有邮件或 cron，不能用其 smoke test 代替这些能力的验收。需要完整隔离验证环境时另行明确配置并授权，不能复用已删除的共享资源。本文后续命令是操作手册，不代表已执行。

## 1. 发布单元和配置基线

发布单元是同一个 Worker 的 HTTP 入口、`Gate` DO、`scheduled` handler 和 React 静态资源。当前配置在 [wrangler.jsonc](../apps/worker/wrangler.jsonc)，入口在 [index.ts](../apps/worker/index.ts)，binding 类型在 [env.ts](../apps/worker/env.ts)。

| 项目 | 当前值 / 发布要求 |
| --- | --- |
| Node / pnpm / Wrangler | 24.19.0 / 11.19.0 / 4.129.0；遵守锁文件，不临时升级 |
| compatibility_date | `2026-08-15`；不要用 `--latest` 随发布漂移 |
| 前端 | `apps/web/dist`；相对 Worker 配置为 `../web/dist`，必须先构建 |
| 静态路由 | `ASSETS`；production 的 `run_worker_first: true` 确保 www 重定向先于静态资源；本地/PR 的 API 和 health 路径先运行 Worker，未知 API 不能落成 SPA HTML |
| D1 / KV | 每环境独立 `DB` / `CACHE`；配置中的零前缀 ID 均是占位符 |
| DO | `GATE` → `Gate`，`migrations` 的 `v1` 使用 `new_sqlite_classes: ["Gate"]` |
| 邮件 | `EMAIL` / `send_email`；所有 `.invalid` 发件人和收件人都是占位符 |
| 定时任务 | 顶层本地配置和 production 显式配置每五分钟一次；PR previews 无 cron |
| 公网入口 | local/production 为 `workers_dev: false`；production 使用 cheapai.dev 路由，PR 使用独立 workers.dev。version preview URLs 关闭；每次发布仍要核对域名与访问结果 |

`remote: false` 描述本地开发 binding 行为，不会让发布后的 Worker 使用本地数据库。远程 D1 操作仍必须明确 `--remote --env ...`。这与已安装 Wrangler schema 及[开发 binding 模式](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)一致。

## 2. 工具和本地发布检查

以下 PowerShell 命令都从工程根目录执行。先按 [toolchain.md](toolchain.md) 选择固定 Node，并处理本机 pnpm 的 `Path` 大小写问题；不要依赖全局 Wrangler。

```powershell
node --version
pnpm.cmd --version
$deploymentRoot = (Get-Location).Path
$deploymentWrangler = Join-Path $deploymentRoot 'apps/worker/node_modules/wrangler/bin/wrangler.js'
$deploymentConfig = Join-Path $deploymentRoot 'apps/worker/wrangler.jsonc'
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path $deploymentRoot '.wrangler/release.log'
node $deploymentWrangler --version

pnpm.cmd install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
pnpm.cmd run typecheck
pnpm.cmd exec vitest run --project node
pnpm.cmd exec vitest run --project workers
pnpm.cmd --filter @cheapai/web run build
node $deploymentWrangler deploy --config $deploymentConfig --env production --dry-run --outdir .wrangler/build-production
```

每一步失败都停止发布。保存提交标识、锁文件 SHA-256、命令退出码、测试结果、迁移清单和 dry-run 摘要；不要保存包含密码/Key 的终端转录。若测试池输出入口静态分析警告，记录警告及实际执行结果，不能把“启动测试命令”当成通过。dry-run 不验证远程权限、邮件投递、真实供应商或网络策略。

本地 D1 与 Cron 可使用同一个明确的状态目录：

```powershell
$deploymentLocalState = Join-Path $deploymentRoot '.wrangler/state-r04'
node $deploymentWrangler d1 migrations apply DB --config $deploymentConfig --local --persist-to $deploymentLocalState
node $deploymentWrangler d1 migrations list DB --config $deploymentConfig --local --persist-to $deploymentLocalState
node scripts/bootstrap-admin.ts --local --persist-to $deploymentLocalState
node $deploymentWrangler dev --config $deploymentConfig --local --persist-to $deploymentLocalState --test-scheduled --port 8787
```

最后一条保持本地服务运行，在另一个终端访问 `http://localhost:8787/__scheduled` 触发本地维护。该入口仅是 `--test-scheduled` 开发功能，不能添加为公网管理接口。上述 HTTP 地址用于本地维护测试；浏览器登录测试另需与 `PUBLIC_BASE_URL` 一致的可信 HTTPS 本地入口，以保留 Secure Cookie 约束。

## 3. 环境选择

production 已有独立资源和域名，bindings/vars 明确位于 `env.production`；不要重新创建数据库或复用旧资源。新 PR 的资源由[预发工作流](pr-previews.md)生成，每个 PR 独立 Worker、D1、KV 和 Gate DO。PR 配置使用 `--config .wrangler/pr-preview-<PR号>.json`，不使用已移除的命名 staging 环境。

生产 `send_email: []`、`EMAIL_VERIFICATION_READY: "false"`；只有验证真实发件身份和投递后才启用验证邮件。不要为消除 Wrangler 的 binding 继承提示添加虚假发件身份。

## 4. 环境值和 Secrets

[routes.ts](../apps/worker/routes.ts) 与 [channel-keyring.ts](../apps/worker/channel-keyring.ts) 按请求解析配置，缺少必需值时失败关闭；不存在从客户端 Host/Origin 推断信任域名的回退。

| 名称 | 类型与要求 |
| --- | --- |
| `ENVIRONMENT` | 环境 `vars`：生产为 production，独立 PR 为 staging（安全模式名，不表示旧共享资源） |
| `PUBLIC_BASE_URL` | 环境 `vars`，实际控制台的 canonical HTTPS origin，可有一个尾斜杠；无账号密码、路径、query、fragment |
| `EMAIL_VERIFICATION_READY` | `vars`，初始设 `"false"`；真实发件身份/投递能力验证后才设 `"true"` |
| `EMAIL_FROM` | `vars`，与已验证发件身份一致的地址 |
| `EMAIL_PROVIDER` | `vars`，`cloudflare`（未设置时默认）或 `resend`；Resend 不需要 `EMAIL` binding |
| `RESEND_API_KEY` | 仅 Resend 使用的 Worker Secret；由用户在安全配置界面输入 Sending access key，不放进 `vars` 或前端 |
| `EMAIL_HMAC_KEY` | Secret，标准 canonical base64，解码 32–512 个随机字节；不与渠道 AES 密钥共用 |
| `CHANNEL_KEYRING_JSON` | Secret，JSON 对象；键为保留版本名，值为标准 canonical base64 的 **32 字节** AES-256 key（44 字符、尾部 `=`） |
| `CHANNEL_ACTIVE_KEY_VERSION` | Secret，当前写入版本名，必须存在于 keyring 中 |

渠道版本名为 1–64 字符，首字符字母/数字，其余可用字母、数字、`.`、`_`、`-`；keyring 最多 16 项、JSON UTF-8 最多 8192 字节。不得提供示例全零密钥作为生产配置，也不要把 keyring 放入 `vars`。

Secrets 由受控密钥工具生成并放入仓库外的临时部署文件或密钥管理系统；本文不要求输出其值。使用 JSON secrets 文件时，`CHANNEL_KEYRING_JSON` 本身是一个 JSON **字符串**，不是外层嵌套对象。文件应包含本环境的完整保留版本集合和活动版本，并单独保存可恢复的受控副本。

首次发布使用已安装 CLI 支持的 `deploy --secrets-file` 将代码和 Secrets 一并提交。不要假定不存在的 Worker 可以预先 `secret put`。普通 `secret put` 会建立并立即部署新版本；需要只准备版本时另评估 `versions secret put`，不能把前者当成无发布副作用的配置写入。[官方 Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)

### Resend 验证码邮件

生产配置已准备 `EMAIL_PROVIDER: "resend"`、`EMAIL_FROM: "noreply@mail.cheapai.dev"`，`EMAIL_VERIFICATION_READY` 仍为 `"false"`，`send_email` 保持空数组。此变更不部署、不发送邮件、不添加数据库迁移，也不实现密码找回。

1. 在 Resend 完成 `mail.cheapai.dev` 的发信域名验证；发件地址必须属于已验证域名。沿用可用于该域名的 Sending access key，无需为了接入再创建 key。不要将 key 粘贴到聊天、仓库、日志或 CheapAI 管理界面。
2. 用户自行打开 Cloudflare Dashboard → Workers & Pages → `sub2api-cloudflare-production` → Settings → Variables and Secrets → Add，选择 **Secret**，名称填 **`RESEND_API_KEY`**，值由用户私下输入。`EMAIL_HMAC_KEY` 是原有验证码 HMAC Secret，需另行安全配置（canonical base64，解码 32–512 字节），不能复用 Resend key；已有值不需要读取或复制。Dashboard 保存部署和 CLI `secret put` 可能发布版本，应在获准的发布窗口操作；本次只准备代码和参数名。[Cloudflare Secret 配置](https://developers.cloudflare.com/workers/configuration/secrets/)
3. 本 PR 合并并获准部署后，先完成隔离环境投递验收，再在正式环境将 `EMAIL_VERIFICATION_READY` 设为 `"true"`。将该非敏感开关同步至 `env.production.vars`，避免下一次 Wrangler 发布恢复为 false；当前 PR 故意不打开它。`PUBLIC_BASE_URL` 沿用 `https://cheapai.dev`。不要将生产 Secrets 注入 PR 预览。
4. CheapAI 现有管理后台继续控制 `registrationMode`（closed/open/invite）和 `emailVerificationEnabled`。要求邮箱验证时，只有 provider、from、HMAC 和 readiness 完整才允许依赖邮件的注册；发信还要求注册未关闭且验证开启。不要用关闭邮箱验证来绕过发信故障。
5. 获准真实验收后检查验证码接受/收件、注册消费、旧码失效、60 秒重发限制和失败提示；服务 accepted 不等于已投递。当前不执行真实发送，不更改套餐或按量付费。需要停用邮件时关闭 readiness；已有用户登录不依赖邮件就绪状态。

协议参考：[Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)、[错误语义](https://resend.com/docs/api-reference/errors)。HTTP provider 使用固定端点，不跟随重定向、不自动重试，错误响应详情和异常通过原生 `console.error` 写入 Cloudflare Workers Logs，对客户端仍返回通用错误。

#### 发码返回 503，但 Resend 没有记录

已确认的运行时陷阱：Workers 原生 `fetch` 不支持 `redirect: 'error'`，会在联网前抛出 `TypeError: Invalid redirect value`，随后被发送逻辑转换为 503；因此 Resend 不会收到请求。应使用 `redirect: 'manual'` 并显式拒绝 3xx。Node 的 fetch mock 不会执行这项参数校验，不能证明 Worker 能发出请求。`tests/auth/email-provider.test.ts` 通过原生 workerd fetch 和本地 HTTP 替身验证完整发码、D1/DO、验证码注册与会话恢复，以及同域/跨域重定向均不会被跟随；测试不发送真实邮件。

`POST /api/v1/auth/send-verify-code` 返回 `503` 且带 `Retry-After: 60`，表示发送结果为 `failed` 或 `unknown`，且该结果已经写回挑战记录。60 秒是应用重发冷却时间，不能据此推断 Resend 限流。Resend 无记录也不能单独证明 Worker 没有发起请求：鉴权失败、账户不匹配或网络故障仍需区分。

生产配置已启用 Cloudflare Workers Observability，`head_sampling_rate: 1` 保留所有调用的日志。部署后，在 Cloudflare Dashboard → Workers & Pages → `sub2api-cloudflare-production` → Observability → Logs 查看请求及其 console 日志；也可以从 `apps/worker` 运行 `pnpm exec wrangler tail --env production --format json` 实时观察。历史请求不会补产生日志。

2026-10-05 补齐全局错误日志：生产显式启用 `observability.logs` 的持久化、invocation logs 和全量采样，并上传 source map。API 的 5xx 通过 `console.error` 输出请求 ID、错误码、状态、原始 Error、堆栈及 cause 链；4xx 使用 `console.warn`。HTTP 入口记录 method、path、状态和耗时。渠道/模型/用户管理、认证、聊天、账务等原先将异常改写为 503 的位置保留原始 cause，不改变客户端响应格式。

上游请求、流式执行及结算、后台任务、KV 和租约续期失败也直接记录原始异常；JSON 上游 HTTP 拒绝记录已经读取的错误响应。未新增日志后端或 redact 流程，也不额外记录请求体、Authorization 或配置 Secret 值。

排查渠道创建时，先用界面上的 `request_id` 找到 `API request failed`，再展开同一 invocation 的日志。密钥配置失败会显示 `CHANNEL_KEYRING_JSON` 缺失/格式错误、`CHANNEL_ACTIVE_KEY_VERSION` 缺失/不存在等具体原因；数据库失败保留 D1 原始异常。这些新日志只在发布后的请求中生成，需要重新操作获取新的请求 ID。

本轮本地验证：Node/React 1,858 项、Worker 2,089 项测试通过；最终渠道/配置/API Key/租约/JSON 网关定向回归 94 项通过，包含两项原始异常与响应请求 ID 关联测试。类型检查、production dry-run 和 diff 检查通过。未执行线上发布或核验 Cloudflare 历史日志。

发码请求开始和结束使用 `console.debug` 记录 `request_id`，可以与浏览器响应匹配；同一次 Worker invocation 下的日志由 Cloudflare 关联。发送流程的 `catch` 使用 `console.error` 保留原始异常及堆栈，HTTP 拒绝包含 Resend 状态码及错误响应正文。还会记录请求开始、收到响应、耗时、超时或缺失 message ID，数据库和路由 catch 也会记录异常。没有自定义日志后端、诊断类型或回调。

排查时，401/403 看 Resend 错误正文以区分密钥、发送权限、域名或边缘拒绝；429 检查服务商限流；只有请求开始而没有响应日志时，查看随后的网络异常或超时。日志不主动打印 Worker Secrets、Authorization 请求头或验证码邮件请求体。对匿名客户端仍返回通用错误。

## 5. D1 迁移与初始管理员

当前源码迁移为 `0001_groups_settings.sql` 至 `0023_request_source_group.sql`，共 23 份。新环境应用全部迁移；升级环境先查实际水位，再按顺序应用所有未应用文件，不只执行最后一份：

```powershell
Get-ChildItem migrations -Filter '*.sql' | Sort-Object Name | Select-Object Name
node $deploymentWrangler d1 migrations list DB --config $deploymentConfig --env production --remote
node $deploymentWrangler d1 migrations apply DB --config $deploymentConfig --env production --remote
node $deploymentWrangler d1 migrations list DB --config $deploymentConfig --env production --remote
node $deploymentWrangler d1 execute DB --config $deploymentConfig --env production --remote --command "PRAGMA foreign_key_check;"
node $deploymentWrangler d1 execute DB --config $deploymentConfig --env production --remote --command "SELECT name,applied_at FROM d1_migrations ORDER BY id;"
```

执行前核对选定 `DB` binding 的数据库名和 UUID。也可改用已核实的数据库名作为 CLI 参数，以减少误指 binding 的风险。[D1 迁移约定](https://developers.cloudflare.com/d1/reference/migrations/)

`migrations apply` 没有本项目自定义的“整批 down”命令。Wrangler help 明确：某一迁移失败会回滚该迁移，前面已成功的迁移仍保留；交互确认在非交互执行时可能省略。因此发布程序应在命令前完成审阅，不能把交互提示当成 CI 的保护条件。

关键结构包括注册原子触发器 `0012`、记账原子触发器 `0013`、默认数据 `0014`、注册码批次 `0015`、Key 创建幂等记录 `0016`、Key 分组 `0017`、内置模型 `0018`。`0019` 移除默认输出配置，`0020` 添加分组倍率，`0021` 调整 web_chat 内部 Key，`0022` 添加聊天存储，`0023` 添加请求来源/分组记录。`0014` 不创建管理员、不授额；`0018` 不创建渠道映射或开放用户授权。

从已应用 0018 的环境升级聊天时，需要依次应用 0019–0023，并发布匹配的 Worker/前端。0021 涉及 Key 表结构及关联约束，应先核对备份、外键与回滚兼容性；保留既有用户、密钥、价格和账务，不通过重新创建数据库升级。

仅首次空环境需要管理员初始化；现有生产管理员不重复 bootstrap。必要时在交互终端运行 A29：

```powershell
node scripts/bootstrap-admin.ts --help
node scripts/bootstrap-admin.ts --remote --env production
```

脚本明确显示目标，交互输入邮箱和两次隐藏密码；不接受凭据命令行参数或管道。密码 6–128 个 Unicode 字符且最多 512 UTF-8 字节。它用实际 Argon2id 散列和一条条件 INSERT 创建零余额管理员；任何已有管理员（包括停用者）、重复邮箱或无可用默认组都会拒绝，不重置、不晋升旧用户。临时 SQL 含散列而非明文，脚本结束后删除；宿主机仍应使用受控临时目录和文件权限。若超时/确认丢失，先核对已存在管理员，不自动重试或改余额。

## 6. 发布 production

以下是实际发布命令，仅在资源、配置、迁移、Secret 文件和发布证据均核对后执行：

```powershell
$deploymentSecretsFile = Read-Host '输入仓库外受控 production Secrets 文件的绝对路径'
node $deploymentWrangler deploy --config $deploymentConfig --env production --strict --secrets-file $deploymentSecretsFile --message 'Reviewed production release'
node $deploymentWrangler deployments list --config $deploymentConfig --env production --json
node $deploymentWrangler versions list --config $deploymentConfig --env production --json
```

不要把 secrets 文件内容或其导出值写入发布记录。保存本次 Worker **version ID**、deployment ID、提交、迁移水位、DO tag、密钥版本标签（非值）、域名和测试结果。确认同一个版本携带匹配的 web assets、API 和 `scheduled` 入口。

production 发布前完成独立 PR 验证及生产专属检查；上述命令始终显式选择 `production` 和对应 Secret 文件。正常升级已经配置 Secrets 时可省略 `--secrets-file`，但仍必须核对活动 keyring 的保留版本兼容性。

## 7. 发布后验证和维护

下面是待执行验收，本文不将任何项目标记为远程通过：

1. 实际 HTTPS 域名上的 `/healthz` 返回 JSON；静态页面可加载，未知 `/api/*`、`/v1/*` 返回结构化错误而非 HTML。
2. 管理员登录/退出、安全 Cookie、Origin/CSRF 和普通用户越权拒绝通过；未配置邮件时注册保持 closed，不能用 readiness 标志冒充投递实测。
3. 对三个协议入口完成普通与增量 SSE、小输出、取消、超时、原生 usage 和账单一致性检查。当前源码已挂载 Chat Completions、Responses、Messages 和模型列表，但实际供应商/SDK/部署环境仍需独立验证，不能从模块测试推定线上可用。
4. 管理员渠道诊断只有显式 POST 才会调用真实上游，最多 16 输出 token，但仍可能花费供应商额度；需要事先限定测试账户和预算，不把 `userBalanceCharged:false` 解读为供应商免费。
5. 验证网页聊天：首页和历史会话、分组倍率、停止/重新生成、请求来源与计费；内部 web_chat Key 不应出现在普通 Key 列表或被用作 Bearer 凭据。
6. 验证 `scheduled_maintenance` 三项报告：到期身份清理、异常请求扫描、待结算重试。日志只看状态/计数，禁用调试原始正文日志。

B21 每次运行分别处理有界一页：结算默认 20、异常请求 20、身份清理 50；总预算默认 25 秒。结算最多五轮，退避为 1/5/15/60 分钟，耗尽后保留人工检查记录。异常请求按“最长请求时间 + 宽限”标记 `usage_unknown`，不编造零用量；只清理过期会话与邮箱 challenge，不删除账单或请求。`waitUntil` 与 `uncertain` 状态不是持久任务队列或成功证明。

Cron 配置由 Wrangler 管理；触发器更新传播可能需要最多 15 分钟，应观察实际调度后再验收，不以部署返回时间推定已生效。[官方 Cron 说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

出现回归先执行[兼容回滚判断](rollback.md)。云资源恢复属于 R05/R06 的隔离恢复流程，不在发布命令中顺手恢复旧数据库。
