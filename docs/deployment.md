# 部署步骤

先读[管理员配置顺序](admin-guide.md)。正式入口为 https://cheapai.dev 和 https://www.cheapai.dev；站内导航保留当前 host，两个入口分别使用 host-only 会话和 CSRF Cookie。原生 Preview 配置见[PR 预览](pr-previews.md)。

## 发布前准备

从仓库根目录执行 `pnpm run production:check`（Windows 可用 `pnpm.cmd`）。它先构建前端，再对 **production** 执行 `deploy --dry-run --strict`，输出到忽略提交的 `.wrangler/build-production`；不会上传、应用远程迁移、配置 Secrets 或发布。

### Cloudflare 自动构建与手动发布

main 推送包含 `docs/**` 和根 `README.md` 之外的改动时，触发 GitHub Production release 工作流，执行正式迁移与发布。Cloudflare 原生 Preview 的启用和资源配置见[PR 预览](pr-previews.md)。

`pnpm run build` 只构建前端并对 Worker 执行 dry-run。`pnpm run deploy` 明确选择 `apps/worker/wrangler.jsonc` 的 `production` 环境，会执行正式发布，不能用作 PR Preview 的替代命令。Wrangler 安装在 Worker workspace；后续配置原生 Preview 时，需要从该 workspace 执行命令，并明确目标 Worker、配置文件和预发绑定。

手动发布命令显式选择 production 配置。发布前核对当前账户、绑定和路由；本地 dry-run 检查打包与配置，远端授权和资源状态需另行核对。

构建和发布日志应显示 `ENVIRONMENT=production`、生产 DB/CACHE，且不包含 local 邮件占位绑定。显式选择 `--env production` 才会加载对应绑定和变量。

production 使用 Resend，显式配置 `send_email: []`。Wrangler 的邮件绑定继承提示不需要通过添加本地邮件占位绑定处理。

发布者必须核对目标账户及现有资源，不能重复创建或替换：

| production 项目 | 配置值 |
| --- | --- |
| Cloudflare account | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker | `sub2api-cloudflare-production` |
| D1 / `DB` | `sub2api-cloudflare-production` / `d85930ad-8e4f-41b7-9fb6-ddf97719e41d` |
| KV / `CACHE` | `3da22af80f0946cdbb9cd85caee9810d` |
| 公网 origin | `https://cheapai.dev` |
| routes | `cheapai.dev/*`、`www.cheapai.dev/*`、`pre.cheapai.dev/*` |

以下为只读核对，不读取 Secret 值：

```sh
pnpm --filter @sub2api/worker exec wrangler whoami
pnpm --filter @sub2api/worker exec wrangler d1 info sub2api-cloudflare-production --env production
pnpm --filter @sub2api/worker exec wrangler kv namespace list --env production
pnpm --filter @sub2api/worker exec wrangler d1 migrations list DB --env production --remote
pnpm --filter @sub2api/worker exec wrangler secret list --env production
pnpm --filter @sub2api/worker exec wrangler deployments list --env production
```

发布前确认账户权限、备份、30 份迁移水位及邮件运行时 Secrets。邮件启用前必须验证发件身份、投递与获批收件人。真实上游调用、负载及恢复验证另行限定目标、权限和预算。

发布前完成提交检查，核对生产目标、备份和迁移；发布后执行第 7 节的功能验收。预览环境的邮件和定时任务需单独配置与验证。

## 正式 CI 发布入口与失败恢复

非 docs-only 改动合并到 `main` 后，GitHub Actions 自动执行 `pnpm run deploy:ci`，顺序为：

1. `pnpm run build:cloud` 成功，产出匹配的前端和 Worker。
2. 从 Worker workspace 执行 `wrangler d1 migrations apply DB --config wrangler.jsonc --env production --remote`。
3. 迁移成功后执行 `wrangler deploy --config wrangler.jsonc --env production`。
4. 请求 `https://cheapai.dev/healthz`，检查成功响应及 JSON 的 `status: "ok"`，再执行第 7 节的业务检查。

脚本位置为 [`scripts/release-production.mjs`](../scripts/release-production.mjs)。任一步失败即退出，不继续后续步骤，不自动回滚数据库或 Worker。`pnpm run deploy:ci --dry-run` 只构建并执行本地 production 打包，明确跳过远程迁移、正式发布和线上 health 请求。原 `pnpm run deploy` 保持仅发布 Worker 的手动语义；不要把它配置成需要自动迁移的 CI 入口。[Production release 工作流](../.github/workflows/production-release.yml) 在包含非文档改动的 PR 合并到 `main` 后自动运行此入口，使用该次合并的提交；实际触发事件是 `push` 到 `main`。D1 自动跳过已执行的迁移，依次应用尚未执行的 SQL。运行中的迁移和发布不会因后续提交被取消。PR 分支的检查不执行远程 SQL。

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置 `CLOUDFLARE_API_TOKEN`，需要能迁移目标 D1 并发布 production Worker 及其绑定。工作流从 Secret 注入凭据，目标账户和资源 ID 使用仓库 production 配置。未配置或权限不足时发布会失败。Cloudflare Workers Builds 独立监听 Git，路径过滤见[PR 预览](pr-previews.md#构建路径过滤)。

发布前保存当前 Worker version/deployment ID、D1 实际迁移清单及备份恢复点。从仓库根目录核对远端数据库，并将导出文件保存到仓库外的受控位置（含渠道与 Desktop 凭据，不提交 Git）：

```sh
pnpm --filter @sub2api/worker exec wrangler d1 time-travel info DB --config wrangler.jsonc --env production
pnpm --filter @sub2api/worker exec wrangler d1 export DB --config wrangler.jsonc --env production --remote --output /controlled-backups/cheapai-before-release.sql
pnpm --filter @sub2api/worker exec wrangler d1 migrations list DB --config wrangler.jsonc --env production --remote
```

按既有恢复流程在隔离数据库验证备份；发布记录保留恢复点、时间、迁移水位与校验结果，不记录凭据。正式 CI 执行环境需要具备 Wrangler 所用的 Cloudflare 账户凭据；备份和恢复点在执行真实发布前由发布者准备。

**0029 存在不兼容窗口。** 它删除 `models.max_output_tokens`、`models.admission_min_balance_units` 与 `channel_models.capabilities_json`。迁移提交后到新 Worker 完成流量切换前，旧 Worker 仍可能查询已删除的列。使用已有入口控制安排维护窗口，处理在途请求与待结算工作；当前项目没有可直接开启的通用 `MAINTENANCE_MODE`。零停机升级需要先发布兼容过渡版本。

迁移失败时，Wrangler 回滚失败的那一份迁移，之前成功的迁移仍保留。流水线停止发布；先回读真实迁移水位和故障，保留数据库与备份，通过修复后继续向前应用。若 0029 尚未应用，也要确认 0027/0028 后的数据仍与运行中的旧版本兼容，尤其是已经接受的空上游模型名或无到期时间邀请码。

迁移成功但发布失败时，数据库已经处于新结构，旧 Worker 不会因此恢复兼容。保持维护窗口，优先重试同一已构建提交的发布，或发布能够读取当前结构的修复版本。发布成功但 health 失败时，保存新 version/deployment ID，核对路由、配置和日志，再完成数据库及业务验收。

0029 后不能直接把 Worker 回滚到依赖旧列的版本。按[兼容回滚步骤](rollback.md)判断目标代码；数据库恢复会影响恢复点之后的用户、凭据、请求及账务，不能把恢复旧 D1 当作普通代码回滚。确需恢复时保持入口受控，核对恢复点后的写入与账务事实，走已有隔离恢复和对账流程，再切换匹配的 Worker，保留故障现场与数据。

## 1. 发布单元和配置基线

发布单元是同一个 Worker 的 HTTP 入口、`Gate` DO、`scheduled` handler 和 React 静态资源。当前配置在 [wrangler.jsonc](../apps/worker/wrangler.jsonc)，入口在 [index.ts](../apps/worker/index.ts)，binding 类型在 [env.ts](../apps/worker/env.ts)。

| 项目 | 当前值 / 发布要求 |
| --- | --- |
| Node / pnpm / Wrangler | 24.19.0 / 11.19.0 / 4.151.1；遵守锁文件，不临时升级 |
| compatibility_date | `2026-08-15`；不要用 `--latest` 随发布漂移 |
| 前端 | `apps/web/dist`；相对 Worker 配置为 `../web/dist`，必须先构建 |
| 静态路由 | `ASSETS`；production 的 `run_worker_first: true` 确保可信 origin 选择和安全响应头先于静态资源；本地的 API 和 health 路径先运行 Worker，未知 API 不能落成 SPA HTML |
| D1 / KV | 每环境独立 `DB` / `CACHE`；配置中的零前缀 ID 均是占位符 |
| DO | `GATE` → `Gate`，`migrations` 的 `v1` 使用 `new_sqlite_classes: ["Gate"]` |
| 邮件 | `EMAIL` / `send_email`；所有 `.invalid` 发件人和收件人都是占位符 |
| 定时任务 | 顶层本地配置和 production 显式配置每五分钟一次；Preview 定时任务需单独核对 |
| 公网入口 | local 为 `workers_dev: false`；production 与 Dashboard 同步为 `workers_dev: true`、`preview_urls: true`，保留 cheapai.dev、www.cheapai.dev 和 pre.cheapai.dev 路由；分支预览见 PR 预览文档 |

`remote: false` 描述本地开发 binding 行为，不会让发布后的 Worker 使用本地数据库。远程 D1 操作仍必须明确 `--remote --env ...`。这与已安装 Wrangler schema 及[开发 binding 模式](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)一致。

## 2. 工具和本地发布检查

以下 PowerShell 命令都从工程根目录执行。使用 `.node-version` 和 `package.json` 固定的 Node、pnpm，以及 Worker workspace 中的 Wrangler。Windows 命令查找故障见[工具链](toolchain.md)。

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

每一步失败都停止发布。保存提交、锁文件 SHA-256、退出码、测试结果、迁移清单和 dry-run 摘要；记录不包含密码或 Key。

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

production 已有独立资源和域名，bindings/vars 明确位于 `env.production`。Cloudflare 原生 Preview 的配置见[预览说明](pr-previews.md)。GitHub PR 检查不执行部署或远程迁移。

当前 Git 生产配置为 `send_email: []`、`EMAIL_VERIFICATION_READY: "true"`，通过 Resend 发信；运行时 Secrets 和投递检查见下文。

## 4. 环境值和 Secrets

[routes.ts](../apps/worker/routes.ts) 按请求解析配置，缺少必需值时失败关闭；不存在从客户端 Host/Origin 推断信任域名的回退。

| 名称 | 类型与要求 |
| --- | --- |
| `ENVIRONMENT` | 环境 `vars`：生产为 production；预览环境需独立配置，不从父 Worker 变量推定 |
| `PUBLIC_BASE_URL` | 环境 `vars`，实际控制台的 canonical HTTPS origin，可有一个尾斜杠；无账号密码、路径、query、fragment |
| `EMAIL_VERIFICATION_READY` | `vars`，初始设 `"false"`；真实发件身份/投递能力验证后才设 `"true"` |
| `EMAIL_FROM` | `vars`，与已验证发件身份一致的地址 |
| `EMAIL_PROVIDER` | `vars`，`cloudflare`（未设置时默认）或 `resend`；Resend 不需要 `EMAIL` binding |
| `RESEND_API_KEY` | 仅 Resend 使用的 Worker Secret；由用户在安全配置界面输入 Sending access key，不放进 `vars` 或前端 |
| `EMAIL_HMAC_KEY` | Secret，标准 canonical base64，解码 32–512 个随机字节 |

渠道和 Desktop 当前 API Key 直接存入 D1；用户密码及认证 Token 使用散列校验。D1 备份和管理权限应按包含凭据的数据处理。

邮件 Secrets 通过受控密钥工具或管理界面配置，不写入 Git 中的 `vars`。Wrangler 正常发布会保留已有 Worker Secrets；构建环境变量和本地 `.dev.vars` 不会自动成为线上运行时绑定。

首次发布使用已安装 CLI 支持的 `deploy --secrets-file` 将代码和 Secrets 一并提交。不要假定不存在的 Worker 可以预先 `secret put`。普通 `secret put` 会建立并立即部署新版本；需要只准备版本时另评估 `versions secret put`，不能把前者当成无发布副作用的配置写入。[官方 Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)

### 渠道和 Desktop 凭据

从旧版本升级时，按迁移顺序处理 `0025`、`0026` 的凭据变化，再继续应用后续迁移。`0025` 增加渠道 `upstream_key`，旧渠道密文及版本仍保留；这些旧渠道需要在管理界面重新填写真实上游 Key，新写入不再加密。没有明文 Key 的旧渠道会被明确拒绝。

`0026` 增加 Desktop 会话的 `current_key`，撤销持有旧密文的会话及其活动 API Key，保留旧密文与历史记录。受影响 Desktop 用户重新登录后即可取得新凭据；未持有旧密文的会话、普通 API Key 和账务不受此迁移影响。退出或过期清理只清除新会话的可返回 Key，不删除历史密文。

### Resend 验证码邮件

当前 Git 生产配置为 `EMAIL_PROVIDER: "resend"`、`EMAIL_FROM: "noreply@mail.cheapai.dev"`、`EMAIL_VERIFICATION_READY: "true"`，`send_email` 保持空数组。仍需确认运行时 Secrets、发送域和实际投递；邮件配置不包含密码找回功能。

1. 在 Resend 完成 `mail.cheapai.dev` 的发信域名验证；发件地址必须属于已验证域名。沿用可用于该域名的 Sending access key，无需为了接入再创建 key。不要将 key 粘贴到聊天、仓库、日志或 CheapAI 管理界面。
2. 用户自行打开 Cloudflare Dashboard → Workers & Pages → `sub2api-cloudflare-production` → Settings → Variables and Secrets → Add，选择 **Secret**，名称填 **`RESEND_API_KEY`**，值由用户私下输入。`EMAIL_HMAC_KEY` 是原有验证码 HMAC Secret，需另行安全配置（canonical base64，解码 32–512 字节），不能复用 Resend key；已有值不需要读取或复制。Dashboard 保存部署和 CLI `secret put` 可能发布版本，应在获准的发布窗口操作。[Cloudflare Secret 配置](https://developers.cloudflare.com/workers/configuration/secrets/)
3. 核对目标 Worker 的运行时 Secrets 并完成投递验收。当前 `env.production.vars` 已将 `EMAIL_VERIFICATION_READY` 设为 `"true"`；后续调整该开关时同步修改配置，避免被下次发布覆盖。`PUBLIC_BASE_URL` 为 `https://cheapai.dev`。不要将生产 Secrets 注入 PR 预览。
4. CheapAI 现有管理后台继续控制 `registrationMode`（closed/open/invite）和 `emailVerificationEnabled`。要求邮箱验证时，只有 provider、from、HMAC 和 readiness 完整才允许依赖邮件的注册；发信还要求注册未关闭且验证开启。不要用关闭邮箱验证来绕过发信故障。
5. 获准真实验收后检查验证码接受/收件、注册消费、旧码失效、60 秒重发限制和失败提示，并确认收件箱投递。需要停用邮件时关闭 readiness；已有用户登录不依赖邮件就绪状态。

协议参考：[Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)、[错误语义](https://resend.com/docs/api-reference/errors)。HTTP provider 使用固定端点，不跟随重定向、不自动重试，错误响应详情和异常通过原生 `console.error` 写入 Cloudflare Workers Logs，对客户端仍返回通用错误。

#### 发码返回 503，但 Resend 没有记录

Resend 发送使用 `redirect: 'manual'` 并拒绝 3xx；Workers 原生 fetch 不支持 `redirect: 'error'`。

`POST /api/v1/auth/send-verify-code` 返回 `503` 且带 `Retry-After: 60`，表示发送结果为 `failed` 或 `unknown`，且该结果已经写回挑战记录。60 秒是应用重发冷却时间，不能据此推断 Resend 限流。Resend 无记录也不能单独证明 Worker 没有发起请求：鉴权失败、账户不匹配或网络故障仍需区分。

生产配置已启用 Cloudflare Workers Observability，`head_sampling_rate: 1` 保留所有调用的日志。部署后，在 Cloudflare Dashboard → Workers & Pages → `sub2api-cloudflare-production` → Observability → Logs 查看请求及其 console 日志；也可以从 `apps/worker` 运行 `pnpm exec wrangler tail --env production --format json` 实时观察。历史请求不会补产生日志。

生产启用 `observability.logs` 的持久化、invocation logs 和全量采样，并上传 source map。API 的 5xx 通过 `console.error` 输出请求 ID、错误码、状态、原始 Error、堆栈及 cause 链；4xx 使用 `console.warn`。HTTP 入口记录 method、path、状态和耗时。渠道、模型、用户管理、认证、聊天和账务错误保留原始 cause，客户端使用统一错误响应。

上游请求、流式执行及结算、后台任务、KV 和租约续期失败也直接记录原始异常；JSON 上游 HTTP 拒绝记录已经读取的错误响应。请求体、Authorization 和配置 Secret 值不写入日志。

排查渠道创建时，先用界面上的 `request_id` 找到 `API request failed`，再展开同一 invocation 的日志。数据库失败保留 D1 原始异常；旧渠道尚未重新填写 Key 时返回明确原因。

发码请求开始和结束使用 `console.debug` 记录 `request_id`，可以与浏览器响应匹配；同一次 Worker invocation 下的日志由 Cloudflare 关联。发送流程的 `catch` 使用 `console.error` 保留原始异常及堆栈，HTTP 拒绝包含 Resend 状态码及错误响应正文。还会记录请求开始、收到响应、耗时、超时或缺失 message ID，数据库和路由 catch 也会记录异常。

排查时，401/403 看 Resend 错误正文以区分密钥、发送权限、域名或边缘拒绝；429 检查服务商限流；只有请求开始而没有响应日志时，查看随后的网络异常或超时。日志不主动打印 Worker Secrets、Authorization 请求头或验证码邮件请求体。对匿名客户端仍返回通用错误。

## 5. D1 迁移与初始管理员

当前源码迁移为 `0001_groups_settings.sql` 至 `0030_channel_soft_delete.sql`，共 30 份。`pnpm run deploy` 只发布 Worker，不自动应用或核验 D1 迁移。新环境应用全部迁移；升级环境先查实际水位，再按顺序应用所有未应用文件，不只执行最后一份：

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

关键结构包括注册原子触发器 `0012`、记账原子触发器 `0013`、默认数据 `0014`、注册码批次 `0015`、Key 创建幂等记录 `0016`、Key 分组 `0017`、内置模型 `0018`。`0019` 移除默认输出配置，`0020` 添加分组倍率，`0021` 调整 web_chat 内部 Key，`0022` 添加聊天存储，`0023` 添加请求来源/分组记录，`0024` 添加 Desktop 会话及 API Key 归属关系；`0025`、`0026` 移除渠道和 Desktop 的二次加密依赖。`0014` 不创建管理员、不授额；`0018` 不创建渠道映射或开放用户授权。

当前版本依赖全部迁移。`0027` 允许上游模型名原样保存；`0028` 允许邀请码不设到期时间；`0029` 删除模型输出上限、最低余额与渠道能力字段；`0030` 增加渠道软删除。按顺序应用缺失迁移后发布匹配版本。

仅首次空环境需要管理员初始化；现有生产管理员不重复 bootstrap。必要时在交互终端运行初始化脚本：

```powershell
node scripts/bootstrap-admin.ts --help
node scripts/bootstrap-admin.ts --remote --env production
```

脚本明确显示目标，交互输入邮箱和两次隐藏密码；不接受凭据命令行参数或管道。密码 6–128 个 Unicode 字符且最多 512 UTF-8 字节。它用实际 Argon2id 散列和一条条件 INSERT 创建零余额管理员；任何已有管理员（包括停用者）、重复邮箱或无可用默认组都会拒绝，不重置、不晋升旧用户。临时 SQL 含散列而非明文，脚本结束后删除；宿主机仍应使用受控临时目录和文件权限。若超时/确认丢失，先核对已存在管理员，不自动重试或改余额。

## 6. 发布 production

以下是实际发布命令，仅在资源、配置、迁移、Secret 文件和发布证据均核对后执行：

```powershell
$deploymentSecretsFile = Read-Host '输入仓库外受控 production Secrets 文件的绝对路径'
node $deploymentWrangler deploy --config $deploymentConfig --env production --secrets-file $deploymentSecretsFile --message 'Reviewed production release'
node $deploymentWrangler deployments list --config $deploymentConfig --env production --json
node $deploymentWrangler versions list --config $deploymentConfig --env production --json
```

不要把 secrets 文件内容或其导出值写入发布记录。保存本次 Worker **version ID**、deployment ID、提交、迁移水位、DO tag、域名和测试结果。确认同一个版本携带匹配的 web assets、API 和 `scheduled` 入口。

production 发布前完成独立 PR 验证及生产专属检查；上述命令始终显式选择 `production` 和对应 Secret 文件。正常升级已经配置 Secrets 时可省略 `--secrets-file`，但仍必须核对邮件所需 Secrets 和 D1 迁移水位。

## 7. 发布后验证和维护

发布后在目标环境逐项验证：

1. 实际 HTTPS 域名上的 `/healthz` 返回 JSON；静态页面可加载，未知 `/api/*`、`/v1/*` 返回结构化错误而非 HTML。
2. 管理员登录/退出、安全 Cookie、Origin/CSRF 和普通用户越权拒绝通过；未配置邮件时注册保持 closed。
3. 对三个协议入口完成普通与增量 SSE、小输出、取消、超时、原生 usage 和账单一致性检查。
4. 管理员渠道诊断只有显式 POST 才会调用真实上游，参数由调用方填写，调用会消耗供应商额度，需事先限定测试账户和预算。
5. 验证网页聊天：首页和历史会话、分组倍率、停止/重新生成、请求来源与计费；内部 web_chat Key 不应出现在普通 Key 列表或被用作 Bearer 凭据。
6. 验证 `scheduled_maintenance` 三项报告：到期身份清理、异常请求扫描、待结算重试。日志只看状态/计数，禁用调试原始正文日志。

定时维护每次运行分别处理有界一页：结算默认 20、异常请求 20、身份清理 50；总预算默认 25 秒。结算最多五轮，退避为 1/5/15/60 分钟，耗尽后保留人工检查记录。异常请求按“最长请求时间 + 宽限”标记 `usage_unknown`，不编造零用量；只清理过期会话与邮箱 challenge，不删除账单或请求。

Cron 配置由 Wrangler 管理；触发器更新传播可能需要最多 15 分钟，应观察实际调度后再验收，不以部署返回时间推定已生效。[官方 Cron 说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

出现回归先执行[兼容回滚判断](rollback.md)。数据库恢复按[备份与恢复](backup-restore.md)执行。
