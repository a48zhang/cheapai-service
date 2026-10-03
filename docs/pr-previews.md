# Pull request 预发

`.github/workflows/preview.yml` 在同仓库 PR 的 opened、synchronize、reopened 事件部署分支 head（包括 draft），closed 时停用它的公开 URL。Fork 和 Dependabot PR 不获得部署凭据；不使用 `pull_request_target`。原有 `Local checks` 独立执行完整类型检查、测试和构建，preview 成功不能替代这些检查。

## 一次性启用

1. Cloudflare 账户须已开通 workers.dev、D1、KV 和 SQLite Durable Objects，并有足够配额。建议使用专用预发账户；同账户的命名隔离不等于 API Token 权限隔离。
2. 在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) **自行创建**仅限目标账户的 CI token。所需账户权限：Workers Scripts: Edit、Workers KV Storage: Edit、D1: Edit。Worker 部署包含自身的 Durable Object migration；不操作 DNS、自定义域名、Routes、Email Routing，也不需要 Zone、用户资料或账户全局管理权限。不要使用 Global API Key 或本地 Wrangler OAuth refresh token。
3. 在仓库 Settings → Secrets and variables → Actions：Secrets 下保存 `CLOUDFLARE_API_TOKEN`；Variables 下保存 `CLOUDFLARE_ACCOUNT_ID`。Token 直接在 GitHub 安全输入框填写，勿发送到聊天、提交 Git 或粘贴日志。当前配置使用的 Cloudflare 账户 ID 是 `4ac5221079fd3481ce2d92f1d1e049cd`；如使用独立账户，填写该账户的 ID。
4. 推送 PR 或重跑失败的 `PR preview`。未配置时工作流明确失败并给出设置提示，不会伪报已部署。GitHub connector 不能读取 Secrets 元数据；是否已有同名 secret 以 GitHub 设置页或实际运行结果为准。

新 token 与向 GitHub 保存 token 由账户持有人完成。只有仓库写权限的可信分支能使用这条自动部署路径；这些分支内的代码可以读取该 CI token，因此不要向可信分支引入未经审核的不可信工作流。

## 资源与 URL

资源名称固定为 `sub2api-<仓库名 SHA256 前10位>-pr-<PR号>`。每个 PR 独立拥有 Worker、D1、KV；Gate DO 不使用其他 Worker 的 `script_name`，由自己的 Worker 创建。不会读取、覆盖 production 或已永久退役的共享 staging bindings。生成配置只写入已忽略的 `.wrangler/pr-preview-<PR号>.json`。

流程：构建前端 → 查询/创建本 PR D1 和 KV → Wrangler strict dry-run → 顺序应用 D1 迁移 → 发布 Worker 和静态资源 → 检查 `/healthz` 与首页 HTML。URL、确切 head SHA 和资源名显示在 Actions run Summary。URL 公开可访问；没有自动配置 Cloudflare Access。

同一 PR 串行，不会中断正在应用的迁移。部署前重新读取 GitHub 的 PR 状态和 head，过期任务跳过，已关闭任务停用公开入口。不同 PR 互不共用数据库。后续 push 保留本 PR 的数据并应用新增迁移；修改已应用的 migration 不会自动重放，应增加迁移或由管理员明确删除本 PR 资源后重建。预发不自动备份，不复制生产或历史共享预发数据。

## 首次登录与真实模型测试

新 D1 只有仓库迁移/种子，没有管理员、余额、渠道密钥或真实上游。首页和 health check 成功只表示部署连通，不能算登录、邮件或模型调用验收。

在本地可信终端使用仓库固定的 Node/pnpm 版本，安装依赖后，先为这次本地操作配置 Cloudflare token/account 环境变量（不要把 token 写入 shell 命令历史）。读取现有 PR 资源并生成本地配置：

```sh
PR_NUMBER=1 node scripts/pr-preview.mjs --config-only
node scripts/bootstrap-admin.ts --remote --preview 1
```

第二条命令会显示 PR 目标并交互询问管理员邮箱/隐藏密码；它不会重置现有管理员，初始余额为 0。输入前确认 PR 编号正确。共享 staging 操作入口已移除，PR 初始化只使用 `--preview PR_NUMBER`。

如要配置真实渠道，账户持有人还需为这个 Worker 设置仅预发使用的 `CHANNEL_KEYRING_JSON`（版本名映射至32字节密钥的标准 base64）与 `CHANNEL_ACTIVE_KEY_VERSION`。在 Cloudflare Worker Settings → Variables and Secrets 中直接输入，或使用 Wrangler 的交互式 secret prompt：

```sh
pnpm --filter @sub2api/worker exec wrangler secret put CHANNEL_KEYRING_JSON --config ../../.wrangler/pr-preview-1.json
pnpm --filter @sub2api/worker exec wrangler secret put CHANNEL_ACTIVE_KEY_VERSION --config ../../.wrangler/pr-preview-1.json
```

不要复用生产密钥；已有渠道加密后不要随意覆盖 keyring，否则旧密文可能不可读。CI 不自动生成、读取或复制这些密钥。管理员登录后按[管理员指南](admin-guide.md)配置渠道、模型映射、分组、授权和余额，再验证聊天/网关。生成配置的 `ENVIRONMENT: staging` 是非生产安全模式，不引用旧共享资源。邮件和 cron 在 PR 环境关闭；需要邮件、定时维护、容量或恢复验收时需另行明确配置并授权完整隔离验证环境，不能复用已删除的共享 staging，不能由此 smoke test 推断。

## 关闭、重试与清理

PR 关闭后，workflow 将该 Worker 的 workers.dev 和 version preview URL 都停用；资源和数据保留以便重新打开，未执行不可逆自动删除。D1/KV/DO 仍占配额且可能有存储费用。管理员确定无需保留时，在 Cloudflare 控制台逐项核对上面的完整 PR 资源名称，再删除该 Worker 及其 DO、D1、KV；不要按宽泛前缀批量删除。

关闭操作失败时重跑该 closed-event run。GitHub 对有合并冲突的 `pull_request` 可能不触发运行：此时在 Cloudflare 手工关闭这个确切 Worker 的 workers.dev，再按需清理。失败的部署保留已分配资源；重跑会按准确名称复用，不自动重复创建/删除。若部署成功但烟测失败，Actions 会保持失败并提供 URL 供排查。

官方参考：[Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[GitHub pull_request 事件与 fork 限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)、[Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/)。
