# 兼容回滚步骤（R04）

核对日期：2026-09-06。**代码回滚不回滚余额、账单、请求或 DO 租约。** 已发生的消费、授额和调整必须继续保留；不能恢复旧 D1 来撤销一次代码发布。本文是操作步骤，没有执行过远程 rollback 或数据恢复。

## 1. 先判断是否允许回退

Cloudflare rollback 会创建一个新的 deployment，让指定旧 version 承接流量；绑定资源的数据不会随之回到旧时刻。资源删除或 DO 类生命周期变更可能使平台拒绝回滚。当前官方还将可回滚范围限制为最近发布的 100 个版本；不要把本地 git tag 当成远端可用 version ID。[官方 rollback 规则](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

在执行命令前，把目标版本与**当前数据**逐项比较：

| 兼容项 | 必须满足 |
| --- | --- |
| D1 schema | 旧代码能读取当前表/列/约束/触发器；新增字段允许向后兼容，删列或改语义则不能直接回退 |
| 财务事实 | 目标版本仍支持当前 `operation_id`、消费唯一性、fingerprint、账单触发器和只追加语义 |
| 待结算记录 | 能解释当前 `price_snapshot`、`usage_json`、质量、retry_count、next_retry_at；不能把缺失字段当 0 或重复计费 |
| 协议快照 | 当前 B03 `schema_version`、`canonical_json_version`、`calculation_version` 都为 1；旧代码必须读懂仍保留的所有版本 |
| Response ID | 仍遵守 P05 `seed=request.id` → `resp_<内部UUID>`；D09 `response_id` 是原生上游 ID，续接不得改成跨用户/Key 查找 |
| DO | `Gate` 类/namespace 身份、RPC 输入输出及存量状态兼容；当前租约存储 `gate:leases`、`schemaVersion:1` 不能被旧代码静默重置 |
| 密钥 | 目标运行版本拥有当前与历史密文所需的全部渠道密钥；旧 key 名相同而字节不同不算兼容 |
| 静态页面/API | 旧页面能使用对应旧 API，浏览器中尚存的新页面调用也有明确兼容或刷新行为 |
| 缓存 | 无法识别的 `v1:*`/快照 schema 按 miss 回源，不让旧快照成为授权或余额真相 |
| Cron | 目标版本仍导出可兼容的 scheduled handler，继续处理存量异步结算和身份清理 |

任一项不满足，保持当前数据，做向前修复或部署兼容适配版本。不要为了通过 rollback 删除 DO namespace、篡改迁移历史或清空数据库。

## 2. 限制新增影响并留存事实

记录当前和拟回退的 version/deployment ID、提交、迁移水位、DO tag、保留 key 版本标签、故障开始时间及未结请求计数。只保留必要元数据，禁止抓取 prompt/输出/Authorization 或 Secret 值来做发布证据。

按已批准的入口控制或已有管理操作限制新的生成流量，保留运维登录和结算恢复路径。**关闭注册不会阻止既有用户调用**；本工程没有可直接设置的通用 `MAINTENANCE_MODE`，不要编造该开关。让已在途的流在有界生命周期中完成/取消，并关注租约释放和结算完成，而不是把 HTTP handler 返回当作流结束。

若故障本身位于 scheduled/结算代码，应在入口控制下安排兼容维护版本或经审阅的调度调整。不要简单永久关闭 Cron 后宣布恢复：待结算仍是账务责任。Cron 更新传播存在延迟，不能作为瞬时停机工具。[调度说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

以下只读检查从工程根执行，先采用 [deployment.md](deployment.md) 的固定 Node 与 Wrangler 路径变量。目标环境必须明确：

```powershell
$rollbackWrangler = Join-Path (Get-Location).Path 'apps/worker/node_modules/wrangler/bin/wrangler.js'
$rollbackConfig = Join-Path (Get-Location).Path 'apps/worker/wrangler.jsonc'
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location).Path '.wrangler/rollback.log'
node $rollbackWrangler deployments list --config $rollbackConfig --env production --json
node $rollbackWrangler versions list --config $rollbackConfig --env production --json
node $rollbackWrangler d1 execute DB --config $rollbackConfig --env production --remote --command "SELECT name,applied_at FROM d1_migrations ORDER BY id;"
node $rollbackWrangler d1 execute DB --config $rollbackConfig --env production --remote --command "SELECT billing_status,COUNT(*) AS count,MIN(created_at) AS oldest_created_at FROM requests GROUP BY billing_status;"
node $rollbackWrangler d1 execute DB --config $rollbackConfig --env production --remote --command "SELECT COUNT(*) AS negative_users FROM users WHERE balance_units<0;"
```

`versions list`/`deployments list` 当前 help 只列最近 10 项；更老版本应依据已保存的发布记录和 Dashboard 核实。远程记录中没有的版本不能靠猜 ID 回滚。

## 3. 执行代码回滚

确认兼容矩阵、流量安排和具体目标后，显式传入旧 **version ID**：

```powershell
$rollbackVersion = Read-Host '输入已核对兼容性的目标 Worker version ID'
node $rollbackWrangler rollback $rollbackVersion --config $rollbackConfig --env production --message 'Compatibility-reviewed rollback'
node $rollbackWrangler deployments list --config $rollbackConfig --env production --json
```

保留交互确认，不使用自动 `--yes` 跳过审阅。Wrangler 4.129.0 源码会说明这是 100% 流量切换，且不会改变本地工作目录或回滚 D1/KV/DO 数据。如果目标之后改过 Secret，还可能出现额外的 Secret 变更确认；在确认前核对下面的 keyring 兼容规则，不能把它当成无关警告。

回滚后本地 checkout 不会自动变成目标代码。保留故障版本用于分析，发布分支另行明确调整，避免下一次自动部署重新覆盖稳定版本。若平台因 DO 生命周期变更拒绝回滚，停止直接 rollback 路径，部署能读取现有 DO 状态的修复版本；不要伪造旧 `migration_tag`。

## 4. 渠道密钥版本与 Secret 回退

当前 [channel-keyring.ts](../apps/worker/channel-keyring.ts) 只接受最多 16 个版本、每个 32 字节的标准 base64 AES key；新密文由 `CHANNEL_ACTIVE_KEY_VERSION` 选择，旧密文按 envelope 中的 `key_version` 精确解密。AAD 绑定渠道 ID 与版本，因此只改密文的版本标签会使认证失败。

轮换顺序：

1. 把新版本加入 keyring，同时保留旧版本，先确保拟回滚版本也能读取扩展后的 keyring/格式。
2. 将完整 keyring 与新活动版本一并部署，避免活动版本指向不存在的 key。
3. 通过已实现并审阅的渠道更新流程逐条重新加密，核对新旧密文；当前没有可凭空调用的批量轮换后台命令。
4. 只有所有仍需读取的数据和恢复材料都不再依赖旧 key，且回滚/恢复窗口明确结束后，才考虑移除。**保留数据期间，旧 ciphertext 必须仍可解密**；备份里还有旧密文时，受控恢复副本也必须保留相应密钥。

普通 `secret put` 会立即部署版本，不是只改一个待发布草稿。[官方 Secrets 行为](https://developers.cloudflare.com/workers/configuration/secrets/) 回滚到缺少新 key 的旧 Secret 集合，可能让新写入的渠道全部不可解密；这时应采用兼容旧代码 + 当前完整 keyring 的新发布版本，而不是确认一个已知会丢失解密能力的旧配置。

不得从 Secret 列表、日志或数据库“恢复明文”。数据库仅有密文；恢复依赖部署者保管的独立受控密钥材料。邮箱 HMAC 与渠道 AES 是两套用途，不能互换。

## 5. D1 与 DO 迁移不倒放

D1 `migrations apply` 按未应用文件前进，`d1_migrations` 是真实水位。已成功文件不能通过删除迁移记录后重跑来“撤销”；迁移故障也不表示所有先前文件都回滚。先增加兼容结构、部署双读/兼容代码，再经过保留窗口移除旧结构。[D1 迁移说明](https://developers.cloudflare.com/d1/reference/migrations/)

本项目当前仍采用 Wrangler 已支持的 `migrations: [{tag:"v1",new_sqlite_classes:["Gate"]}]`，不是在 R04 自动迁移到新的 DO `exports` 配置。保留已部署 tag 历史；新增、重命名或删除 DO 类必须是单独审阅的变更。Cloudflare 最新 DO 类生命周期配置与已有 legacy migrations 有区别，应使用发布时固定版本支持的字段。[DO 生命周期配置](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

清空 Gate 存储来适配旧代码，会破坏尚有效的用户/渠道租约、限流计数与冷却状态。旧代码读不懂 `schemaVersion` 时应失败关闭并向前修复，不能重建空状态让并发额度重新满额。

## 6. 回滚后的账务和协议核验

1. 验证实际域名、API JSON/SPA 边界、管理员登录与权限；不能只看 deploy 命令成功。
2. 对同一已结算 `operation_id` 的受控重放确认不新增账单、不再扣款。不要以调用真实上游重放来验证数据库幂等。
3. 核对 `settlement_pending`、`usage_unknown`、未结束请求和负余额统计。负余额按真实事实保留，不截零、不覆盖。需要纠错时由正式授额/调整用例追加账目并记录原因。
4. 确认 B21 仍分批运行：完整证据才重试结算，五轮耗尽保留人工处理；未知用量不可推导零费用，失败的后台回调不能伪报成功。
5. 既有请求继续使用登记时保存的完整价格/usage/fingerprint，不能按回滚后的“当前价格”重新计算历史费用。保留新版本发出的平台 response ID 的归属与原生 ID 还原规则。
6. 验证正常/取消/超时流仍释放租约、结束有界完成回调，日志只输出 G21 的安全字段。对未实现或缺乏远程证据的协议路径继续标记未验收。

若需要恢复数据库到过去时间点，这是独立的隔离恢复事件：恢复到隔离资源，核对账本、幂等记录、未结请求和 keyring，再决定切换。必须解释恢复点之后已经发生的交易如何保全；不能以代码回滚之名直接覆盖生产余额或账单。
