# 部署步骤（R04）

核对日期：2026-09-06。本文基于当前源码、已安装 Wrangler **4.129.0** 的 `--help` / 配置 schema 与 Cloudflare 官方资料。本文没有创建云资源、部署 Worker、应用远程迁移、读取真实 Secrets 或执行真实上游调用。CLI 参数可用不等于云端验收通过；完整入口、邮件、供应商兼容和恢复演练仍按任务证据验收。

## 1. 发布单元和配置基线

发布单元是同一个 Worker 的 HTTP 入口、`Gate` DO、`scheduled` handler 和 Vue 静态资源。当前配置在 [wrangler.jsonc](../apps/worker/wrangler.jsonc)，入口在 [index.ts](../apps/worker/index.ts)，binding 类型在 [env.ts](../apps/worker/env.ts)。

| 项目 | 当前值 / 发布要求 |
| --- | --- |
| Node / pnpm / Wrangler | 24.19.0 / 11.19.0 / 4.129.0；遵守锁文件，不临时升级 |
| compatibility_date | `2026-08-15`；不要用 `--latest` 随发布漂移 |
| 前端 | `apps/web/dist`；相对 Worker 配置为 `../web/dist`，必须先构建 |
| 静态路由 | `ASSETS`；`/api`、`/api/*`、`/v1`、`/v1/*`、`/healthz` 先运行 Worker，未知 API 不能落成 SPA HTML |
| D1 / KV | 每环境独立 `DB` / `CACHE`；配置中的零前缀 ID 均是占位符 |
| DO | `GATE` → `Gate`，`migrations` 的 `v1` 使用 `new_sqlite_classes: ["Gate"]` |
| 邮件 | `EMAIL` / `send_email`；所有 `.invalid` 发件人和收件人都是占位符 |
| 定时任务 | 顶层、staging、production 均显式配置每五分钟一次 |
| 公网入口 | 当前 `workers_dev: false`、`preview_urls: false`，且未配置真实域名；不能假定 deploy 后已有可访问 URL |

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
pnpm.cmd --filter @sub2api/web run build
node $deploymentWrangler deploy --config $deploymentConfig --env staging --dry-run --outdir .wrangler/build-staging
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

## 3. 首次环境准备

先确认目标 Cloudflare 账户和获批的环境。以下命令会创建远程资源，只由部署者在确认目标后执行；已有环境先核对既有资源，不重复创建：

```powershell
node $deploymentWrangler d1 create sub2api-cloudflare-staging --config $deploymentConfig --env staging --update-config=false
node $deploymentWrangler kv namespace create sub2api-cloudflare-staging-cache --config $deploymentConfig --env staging --update-config=false
```

把返回的真实 D1 UUID、数据库名与 KV namespace ID 填入 `env.staging`，保留 binding 名 `DB`、`CACHE`。production 使用独立资源和对应 `env.production`；不要复用旧四个 Worker、测试库或其 Secrets。DO namespace 由部署配置中的类声明建立，不手工复制测试 DO 数据。

在选定环境中配置真实路由/自定义域名，并核对实际流量落到对应 Worker。由于本项目关闭 `workers.dev` 和 preview URL，未配置域名时不要将“上传成功”记为外网可用。邮件发件身份和允许的收件策略需在目标账户单独验证，移除 `.invalid` 占位符后再部署。

## 4. 环境值和 Secrets

[routes.ts](../apps/worker/routes.ts) 与 [channel-keyring.ts](../apps/worker/channel-keyring.ts) 按请求解析配置，缺少必需值时失败关闭；不存在从客户端 Host/Origin 推断信任域名的回退。

| 名称 | 类型与要求 |
| --- | --- |
| `ENVIRONMENT` | 环境 `vars`，必须与目标一致：staging 或 production |
| `PUBLIC_BASE_URL` | 环境 `vars`，实际控制台的 canonical HTTPS origin，可有一个尾斜杠；无账号密码、路径、query、fragment |
| `EMAIL_VERIFICATION_READY` | `vars`，初始设 `"false"`；真实发件身份/投递能力验证后才设 `"true"` |
| `EMAIL_FROM` | `vars`，与已验证发件身份一致的地址 |
| `EMAIL_HMAC_KEY` | Secret，标准 canonical base64，解码 32–512 个随机字节；不与渠道 AES 密钥共用 |
| `CHANNEL_KEYRING_JSON` | Secret，JSON 对象；键为保留版本名，值为标准 canonical base64 的 **32 字节** AES-256 key（44 字符、尾部 `=`） |
| `CHANNEL_ACTIVE_KEY_VERSION` | Secret，当前写入版本名，必须存在于 keyring 中 |

渠道版本名为 1–64 字符，首字符字母/数字，其余可用字母、数字、`.`、`_`、`-`；keyring 最多 16 项、JSON UTF-8 最多 8192 字节。不得提供示例全零密钥作为生产配置，也不要把 keyring 放入 `vars`。

Secrets 由受控密钥工具生成并放入仓库外的临时部署文件或密钥管理系统；本文不要求输出其值。使用 JSON secrets 文件时，`CHANNEL_KEYRING_JSON` 本身是一个 JSON **字符串**，不是外层嵌套对象。文件应包含本环境的完整保留版本集合和活动版本，并单独保存可恢复的受控副本。

首次发布使用已安装 CLI 支持的 `deploy --secrets-file` 将代码和 Secrets 一并提交。不要假定不存在的 Worker 可以预先 `secret put`。普通 `secret put` 会建立并立即部署新版本；需要只准备版本时另评估 `versions secret put`，不能把前者当成无发布副作用的配置写入。[官方 Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)

## 5. D1 迁移与初始管理员

本次核对源码迁移为 `0001_groups_settings.sql` 至 `0017_key_groups.sql`。发布时重新列出目录，按顺序应用全部未应用文件，不只执行最后一份：

```powershell
Get-ChildItem migrations -Filter '*.sql' | Sort-Object Name | Select-Object Name
node $deploymentWrangler d1 migrations list DB --config $deploymentConfig --env staging --remote
node $deploymentWrangler d1 migrations apply DB --config $deploymentConfig --env staging --remote
node $deploymentWrangler d1 migrations list DB --config $deploymentConfig --env staging --remote
node $deploymentWrangler d1 execute DB --config $deploymentConfig --env staging --remote --command "PRAGMA foreign_key_check;"
node $deploymentWrangler d1 execute DB --config $deploymentConfig --env staging --remote --command "SELECT name,applied_at FROM d1_migrations ORDER BY id;"
```

执行前核对选定 `DB` binding 的数据库名和 UUID。也可改用已核实的数据库名作为 CLI 参数，以减少误指 binding 的风险。[D1 迁移约定](https://developers.cloudflare.com/d1/reference/migrations/)

`migrations apply` 没有本项目自定义的“整批 down”命令。Wrangler help 明确：某一迁移失败会回滚该迁移，前面已成功的迁移仍保留；交互确认在非交互执行时可能省略。因此发布程序应在命令前完成审阅，不能把交互提示当成 CI 的保护条件。

关键结构包括注册原子触发器 `0012`、记账原子触发器 `0013`、默认数据 `0014`、注册码批次 `0015`、Key 创建幂等记录 `0016`。`0014` 只设置默认组和 closed 注册配置，不创建管理员、不授额、不覆盖现有配置。

应用迁移后，在交互终端运行 A29：

```powershell
node scripts/bootstrap-admin.ts --help
node scripts/bootstrap-admin.ts --remote --env staging
```

脚本明确显示目标，交互输入邮箱和两次隐藏密码；不接受凭据命令行参数或管道。密码 6–128 个 Unicode 字符且最多 512 UTF-8 字节。它用实际 Argon2id 散列和一条条件 INSERT 创建零余额管理员；任何已有管理员（包括停用者）、重复邮箱或无可用默认组都会拒绝，不重置、不晋升旧用户。临时 SQL 含散列而非明文，脚本结束后删除；宿主机仍应使用受控临时目录和文件权限。若超时/确认丢失，先核对已存在管理员，不自动重试或改余额。

## 6. 发布 staging，再发布 production

以下是实际发布命令，仅在资源、配置、迁移、Secret 文件和发布证据均核对后执行：

```powershell
$deploymentSecretsFile = Read-Host '输入仓库外受控 staging Secrets 文件的绝对路径'
node $deploymentWrangler deploy --config $deploymentConfig --env staging --strict --secrets-file $deploymentSecretsFile --message 'Reviewed staging release'
node $deploymentWrangler deployments list --config $deploymentConfig --env staging --json
node $deploymentWrangler versions list --config $deploymentConfig --env staging --json
```

不要把 secrets 文件内容或其导出值写入发布记录。保存本次 Worker **version ID**、deployment ID、提交、迁移水位、DO tag、密钥版本标签（非值）、域名和测试结果。确认同一个版本携带匹配的 web assets、API 和 `scheduled` 入口。

production 在 staging 验收后独立重复资源核对、迁移、bootstrap（仅首次）和发布；命令的 `--env` 必须显式改为 `production`，并选择 production 的 Secret 文件。正常升级已经配置 Secrets 时可省略 `--secrets-file`，但仍必须核对活动 keyring 的保留版本兼容性。

## 7. 发布后验证和维护

下面是待执行验收，本文不将任何项目标记为远程通过：

1. 实际 HTTPS 域名上的 `/healthz` 返回 JSON；静态页面可加载，未知 `/api/*`、`/v1/*` 返回结构化错误而非 HTML。
2. 管理员登录/退出、安全 Cookie、Origin/CSRF 和普通用户越权拒绝通过；未配置邮件时注册保持 closed，不能用 readiness 标志冒充投递实测。
3. 对每个已挂载协议入口完成普通与增量 SSE、小输出、取消、超时、原生 usage 和账单一致性检查。尚未挂载或未实现的适配器不能因模块测试通过就标为入口可用。
4. 管理员渠道诊断只有显式 POST 才会调用真实上游，最多 16 输出 token，但仍可能花费供应商额度；需要事先限定测试账户和预算，不把 `userBalanceCharged:false` 解读为供应商免费。
5. 验证 `scheduled_maintenance` 三项报告：到期身份清理、异常请求扫描、待结算重试。日志只看状态/计数，禁用调试原始正文日志。

B21 每次运行分别处理有界一页：结算默认 20、异常请求 20、身份清理 50；总预算默认 25 秒。结算最多五轮，退避为 1/5/15/60 分钟，耗尽后保留人工检查记录。异常请求按“最长请求时间 + 宽限”标记 `usage_unknown`，不编造零用量；只清理过期会话与邮箱 challenge，不删除账单或请求。`waitUntil` 与 `uncertain` 状态不是持久任务队列或成功证明。

Cron 配置由 Wrangler 管理；触发器更新传播可能需要最多 15 分钟，应观察实际调度后再验收，不以部署返回时间推定已生效。[官方 Cron 说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

出现回归先执行[兼容回滚判断](rollback.md)。云资源恢复属于 R05/R06 的隔离恢复流程，不在发布命令中顺手恢复旧数据库。
