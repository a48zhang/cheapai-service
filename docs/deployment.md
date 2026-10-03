# 部署步骤

更新：2026-10-03；本轮实现基于 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a`，未执行推送或远程发布。CLI 用法与说明沿用 2026-09-06 在 Wrangler **4.129.0** 的历史核对；执行时仍需核对本机版本、目标环境和命令输出。本文是操作手册，不是本次远程发布成功记录。

先读[管理员配置顺序](admin-guide.md)，再按本文准备和发布。仓库已有 staging 资源记录，production 仍含占位配置；不要重复创建已有资源。网页聊天 9 月 12 日的授权失败是[历史记录](web-chat-delivery.md)，今天的授权、部署版本与迁移水位应重新查询。

## 预发快速准备（本轮入口）

从仓库根目录执行 `pnpm run staging:check`。该命令先构建前端，再用锁定的 Wrangler 对 **staging** 执行 `deploy --dry-run --strict`，输出到忽略提交的 `.wrangler/build-staging`；不会上传、应用远程迁移、配置 Secrets 或发布。Windows 可用 `pnpm.cmd run staging:check`。它只验证打包和配置，不替代测试，也不证明云端可用。

此前环境准备记录的 `staging:check` 在文档基准提交 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a` 上退出 0（当时的前端类型检查/构建及 staging dry-run 通过）。这是历史结果，不代表当前 React 切换后的 staging dry-run 或最终验证通过；当前 React 的最终验证仍在集中进行。Wrangler 4.129.0 当时提示顶层 `send_email` 未继承、binding 名为 `undefined`；staging 的空邮件绑定是有意配置，输出中没有 `EMAIL`。不要为消除提示添加 `.invalid` 发件身份或提前启用邮件。该警告不代表邮件已验证。

以下都是仓库已有的配置记录，本轮未修改或重新创建资源；发布者必须在目标账户复核其存在和归属：

| staging 项目 | 已记录值 |
| --- | --- |
| Cloudflare account | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker | `sub2api-cloudflare-staging` |
| D1 / `DB` | `sub2api-cloudflare-staging` / `50fe8c8c-6945-4a15-a3f6-83904632aec2` |
| KV / `CACHE` | `6fe5850647504132a0ce70f2c5bd2056` |
| 公网 origin | `https://sub2api-cloudflare-staging.alphazhang689.workers.dev` |

2026-10-03 本轮准备环境的 `wrangler whoami` 返回 **未认证**。因此不能确认远程资源、现有部署、Secrets 名称清单和迁移水位；不是缺少 ID，也不是已部署成功。不要使用临时 preview 账户替代这个 staging 账户。

部署者在自己的受控终端准备好现有 Cloudflare 身份后，可从仓库根目录做以下只读核对（不会读取 Secret 值）：

```sh
pnpm --filter @sub2api/worker exec wrangler whoami
pnpm --filter @sub2api/worker exec wrangler d1 info sub2api-cloudflare-staging --env staging
pnpm --filter @sub2api/worker exec wrangler kv namespace list --env staging
pnpm --filter @sub2api/worker exec wrangler d1 migrations list DB --env staging --remote
pnpm --filter @sub2api/worker exec wrangler secret list --env staging
pnpm --filter @sub2api/worker exec wrangler deployments list --env staging
```

若 Worker 尚未存在，最后两项可能返回不存在，按首次发布处理；不要因此重建已有 D1/KV。核对实际 workers.dev 子域名与上述 origin 相同后再发布。

发布前还需：

- **渠道密钥**：确认该环境有 `CHANNEL_KEYRING_JSON` 和 `CHANNEL_ACTIVE_KEY_VERSION`；保留旧版本以解密现有渠道。只检查名称不等于验证格式或密钥可用，不在聊天、日志或仓库提供值
- **数据与权限**：确认目标账户访问、D1/KV/Worker/DO 操作权限、备份与 23 份迁移的水位；实际应用迁移、bootstrap 和发布按下文单独执行
- **邮件分阶段启用**：当前 `send_email: []`、`EMAIL_VERIFICATION_READY: "false"`，可先验收已有/初始管理员登录与控制台。启用验证邮件才需 `EMAIL` binding、验证过的 `EMAIL_FROM`、`EMAIL_HMAC_KEY` 和获批测试收件人；保持注册关闭，不能只改 readiness 为 true
- **上游验收**：管理员另行配置真实上游渠道凭据、模型映射/价格、用户额度及分组，限定付费测试预算后再做真实协议和网页聊天请求

这次准备不新增云端身份、不保存凭据、不应用远程迁移，也不执行发布。以下章节保留部署者的完整手动流程。环境 bindings/vars 明确列在 `env.staging`，不依赖继承本地 binding；参考 [Wrangler 环境配置](https://developers.cloudflare.com/workers/wrangler/configuration/)。

## 本轮发布门槛

先完成[执行计划](implementation-plan.md)的模块验证、V-DOC 与最终 V-INTEGRATION。浏览器因 Chromium socket EPERM 受阻的项目仍需重新运行，不能用历史结果代替。

发布顺序为 R01 核对目标/备份 → R02 获授权后配置 → V-CONFIG → R03 staging → V-CLOUD、V-UPSTREAM、V-MAIL、V-CAPACITY、V-RESTORE → R04 production → V-PROD → D06。真实上游、邮件收件人、负载预算、隔离恢复和部署分别满足相应环境与授权后执行。当前没有本轮远程发布结果。

## 1. 发布单元和配置基线

发布单元是同一个 Worker 的 HTTP 入口、`Gate` DO、`scheduled` handler 和 React 静态资源。当前前端 workspace 为 `apps/web` / `@cheapai/web`；Worker 配置在 [wrangler.jsonc](../apps/worker/wrangler.jsonc)，入口在 [index.ts](../apps/worker/index.ts)，binding 类型在 [env.ts](../apps/worker/env.ts)。

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
| 公网入口 | local/production 保留 `workers_dev: false`；staging 显式 `workers_dev: true` 且有 PUBLIC_BASE_URL。preview URLs 关闭；每次发布仍要核对实际域名与访问结果 |

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

在选定环境核对公网入口和实际流量：staging 配置启用 workers.dev，并设置对应 PUBLIC_BASE_URL；production 仍需准备独立的真实路由/自定义域名或明确启用的入口，不能直接沿用 staging 地址。不要将“上传成功”记为外网可用。staging 的 send_email 为空且 EMAIL_VERIFICATION_READY 为 false；只有完成真实发件身份和投递验证后才启用验证邮件。production 的 `.invalid` 地址是占位符。

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

当前源码迁移为 `0001_groups_settings.sql` 至 `0023_request_source_group.sql`，共 23 份。新环境应用全部迁移；升级环境先查实际水位，再按顺序应用所有未应用文件，不只执行最后一份：

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

关键结构包括注册原子触发器 `0012`、记账原子触发器 `0013`、默认数据 `0014`、注册码批次 `0015`、Key 创建幂等记录 `0016`、Key 分组 `0017`、内置模型 `0018`。`0019` 移除默认输出配置，`0020` 添加分组倍率，`0021` 调整 web_chat 内部 Key，`0022` 添加聊天存储，`0023` 添加请求来源/分组记录。`0014` 不创建管理员、不授额；`0018` 不创建渠道映射或开放用户授权。

从已应用 0018 的环境升级聊天时，需要依次应用 0019–0023，并发布匹配的 Worker/前端。0021 涉及 Key 表结构及关联约束，应先核对备份、外键与回滚兼容性；保留既有用户、密钥、价格和账务，不通过重新创建数据库升级。

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
3. 对三个协议入口完成普通与增量 SSE、小输出、取消、超时、原生 usage 和账单一致性检查。当前源码已挂载 Chat Completions、Responses、Messages 和模型列表，但实际供应商/SDK/部署环境仍需独立验证，不能从模块测试推定线上可用。
4. 管理员渠道诊断只有显式 POST 才会调用真实上游，最多 16 输出 token，但仍可能花费供应商额度；需要事先限定测试账户和预算，不把 `userBalanceCharged:false` 解读为供应商免费。
5. 验证网页聊天：首页和历史会话、分组倍率、停止/重新生成、请求来源与计费；内部 web_chat Key 不应出现在普通 Key 列表或被用作 Bearer 凭据。
6. 验证 `scheduled_maintenance` 三项报告：到期身份清理、异常请求扫描、待结算重试。日志只看状态/计数，禁用调试原始正文日志。

B21 每次运行分别处理有界一页：结算默认 20、异常请求 20、身份清理 50；总预算默认 25 秒。结算最多五轮，退避为 1/5/15/60 分钟，耗尽后保留人工检查记录。异常请求按“最长请求时间 + 宽限”标记 `usage_unknown`，不编造零用量；只清理过期会话与邮箱 challenge，不删除账单或请求。`waitUntil` 与 `uncertain` 状态不是持久任务队列或成功证明。

Cron 配置由 Wrangler 管理；触发器更新传播可能需要最多 15 分钟，应观察实际调度后再验收，不以部署返回时间推定已生效。[官方 Cron 说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

出现回归先执行[兼容回滚判断](rollback.md)。云资源恢复属于 R05/R06 的隔离恢复流程，不在发布命令中顺手恢复旧数据库。
