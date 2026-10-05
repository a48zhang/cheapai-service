# 备份与隔离恢复步骤（R05）

核对日期：2026-10-05。本文交付 D1 备份、隔离副本恢复和恢复后只读核对的操作边界。本文没有创建远程 D1、导出云端数据、恢复数据库、读取 Secret 或切换任何 Worker binding。真实恢复演练属于后续 R06；渠道 Key 的可用性需要在恢复副本上单独验证。

恢复的目标是得到一个可核对的隔离副本。不要把“代码回滚”当成“数据库恢复”：余额、账单、请求幂等记录和 Durable Object 状态不会随 Worker version 回退。D1 的 Time Travel restore 会在原库上覆盖数据，本文不把它用于生产恢复。

## 数据边界与材料清单

D1 是用户、Key、渠道配置、请求和追加账单的权威数据源。导出的 SQL 可能包含用户行、不可逆的 `password_hash`/`token_hash`/`key_hash`、注册码 MAC、审计快照、渠道明文 `upstream_key` 和 Desktop 明文 `current_key`，以及尚未替换的历史 `secret_ciphertext`。这些仍是敏感备份材料，应放在仓库之外的受控、加密存储中；不要把 SQL 导出或其内容提交 Git。

从迁移 0025 起，渠道上游 Key 直接存入 `channels.upstream_key`，不再使用渠道加密 Secret。迁移保留历史 `secret_ciphertext` 和 `secret_key_version`，这类渠道需要管理员重新填写 Key 后才能转发。迁移 0026 起 Desktop 当前 Key 也直接保存在 D1，旧加密会话需要重新登录。`EMAIL_HMAC_KEY` 和邮件配置仍由 Worker Secret 管理。恢复校验只返回凭据就绪数量，不读取或打印 Key 内容。

KV 是可丢弃缓存，不能作为余额或账单恢复材料。Gate Durable Object 的租约/限流状态也不在 D1 SQL 中；不要用清空 namespace 的方式伪造恢复成功。恢复副本保持脱离 Worker，直到数据库、密钥材料和应用兼容性均由单独的变更流程核对完毕。

## 备份前记录与导出

备份操作者先在受控终端固定 Node、pnpm 和 Wrangler 版本，参照 [toolchain.md](toolchain.md)。以下变量只表示目标名称和本机文件路径；不要把凭据放入命令行或文件名：

```powershell
# Use a controlled backup location outside this checkout.
$backupRoot = Read-Host 'Absolute path in controlled backup storage (outside repository)'
$backupFile = Join-Path $backupRoot 'd1.sql'
$backupConfig = Join-Path (Get-Location).Path 'apps/worker/wrangler.jsonc'
$backupWrangler = Join-Path (Get-Location).Path 'apps/worker/node_modules/wrangler/bin/wrangler.js'
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location).Path '.wrangler/r05-backup.log'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

# Fill these only after independently confirming the account, database UUID and environment.
$sourceDatabase = Read-Host 'Exact source D1 database name'
$sourceEnvironment = Read-Host 'Wrangler environment (approved source only)'

node $backupWrangler d1 info $sourceDatabase --config $backupConfig --env $sourceEnvironment --json
node $backupWrangler d1 time-travel info $sourceDatabase --config $backupConfig --env $sourceEnvironment --json
node $backupWrangler d1 migrations list $sourceDatabase --config $backupConfig --env $sourceEnvironment --remote
node $backupWrangler d1 execute $sourceDatabase --config $backupConfig --env $sourceEnvironment --remote --command "SELECT name,applied_at FROM d1_migrations ORDER BY id;" --json

# This is a read-only export. Keep the resulting file outside source control.
node $backupWrangler d1 export $sourceDatabase --config $backupConfig --env $sourceEnvironment --remote --output $backupFile --skip-confirmation
Get-FileHash $backupFile -Algorithm SHA256
```

The record for each export should contain UTC capture time, exact database name and UUID, Wrangler version, applied migration names, current Time Travel bookmark, SQL file SHA-256, retention expiry. Do not save terminal output that contains credentials or Secret values. The current Wrangler 4.129.0 help supports the `d1 export --remote --output ... --skip-confirmation` form above; recheck `node $backupWrangler d1 export --help` after a deliberate Wrangler upgrade.

[D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) documents `d1 export`, local/remote selection and the migration commands. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) explains the `d1_migrations` waterline and why database names are safer than mutable binding names.

## Time Travel 的限制

D1 Time Travel is always enabled for databases on the production storage backend. It provides a bookmark/time point within the plan's retention window (currently up to 30 days on Workers Paid and 7 days on Workers Free). `wrangler d1 time-travel info` is a read-only way to capture a current or historical bookmark.

`wrangler d1 time-travel restore` is destructive: it overwrites the named database and cancels in-flight work. Current D1 documentation also describes cloning/forking as a future capability, so a Time Travel bookmark is not an isolated copy. Do not run the following against this project's production database as part of R05:

```powershell
# Destructive in-place operation; reserved for a separately approved incident runbook.
node $backupWrangler d1 time-travel restore $sourceDatabase --config $backupConfig --env $sourceEnvironment --bookmark '<reviewed-bookmark>'
```

Use an encrypted SQL export for an isolated copy when a database must be inspected without changing the source. See [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/) for bookmark retention, restore semantics and the current export/R2 guidance.

## 恢复到隔离 D1

恢复操作者应使用一次性、可识别为恢复用途的数据库名称，例如 `sub2api-cloudflare-restore-20260907`，并保留 Cloudflare 返回的真实 UUID。不要把恢复库的 ID 填回 production binding，也不要让恢复库挂载到正在服务的 Worker。

```powershell
$restoreDatabase = 'sub2api-cloudflare-restore-<UTC-date-and-unique-suffix>'

# Creates a separate remote resource. Confirm account and name before running.
node $backupWrangler d1 create $restoreDatabase --config $backupConfig --update-config=false

# The export includes schema and data by default. Keep this target isolated.
node $backupWrangler d1 execute $restoreDatabase --config $backupConfig --remote --file $backupFile --yes
node $backupWrangler d1 info $restoreDatabase --config $backupConfig --json
node $backupWrangler d1 migrations list $restoreDatabase --config $backupConfig --remote
```

If the export was intentionally made with `--no-schema`, first compare its migration waterline with the backup record and apply only the reviewed checked-in migrations to the isolated database. Do not delete rows from `d1_migrations`, rewrite migration filenames, or apply a newer schema merely to make a command green. A restore made from a full export must still be compared with the source migration list because an SQL file does not prove that the application version can interpret every row.

The SQL import restores D1 rows and indexes/triggers represented by the export. It does not restore KV, Gate Durable Object storage, Worker versions, routes, assets, or Secret bindings. Keep those resources disconnected; R05 has no cutover command.

## 恢复后只读核对

[`scripts/verify-restored-database.ts`](../scripts/verify-restored-database.ts) accepts only fixed SELECT/PRAGMA checks through Wrangler. It verifies the checked-in migration/schema waterline, foreign-key violations, the exact D1 integer balance against the full billing ledger, billing and Key creation idempotency identities, registration-batch idempotency, and whether channels have usable direct upstream keys. It never accepts a SQL argument, runs restore/export/migrate, inserts/updates/deletes rows, repairs balances, or reads key material.

For a local restored state:

```powershell
node scripts/verify-restored-database.ts --local `
  --database DB `
  --config apps/worker/wrangler.jsonc `
  --persist-to .wrangler/r05-restore-verify `
  --json
```

For an isolated remote database, the explicit `--isolated` guard is required. The verifier rejects production-like names/environments before starting Wrangler:

```powershell
node scripts/verify-restored-database.ts --remote --isolated `
  --database $restoreDatabase `
  --config apps/worker/wrangler.jsonc `
  --json
```

The `channel-credentials` check reports `readyChannels` and `needsKeyReentry`. Legacy encrypted rows remain preserved, but the report fails until their upstream keys are re-entered. It does not decrypt the legacy envelope or make an upstream API request.

The JSON report exits 0 only when every check is `pass`. `negativeUsers` is reported but is not itself a failure: this service allows a bounded negative balance after a charge. Any `mismatchedUsers`, foreign-key violation, missing migration/trigger, duplicate idempotency identity, or channel requiring Key re-entry is a failure that stops the recovery review. Preserve the report, command versions, database UUID, SQL checksum and bookmark without adding row secrets.

## 不能作为恢复证据的结果

An HTTP 200 from a restored Worker, a successful `d1 execute --file`, a local Miniflare database, a KV hit, or a `wrangler deploy` result does not prove financial or identity recovery. The source database remains authoritative until the isolated report, migration compatibility review, and channel credential readiness checks are complete. If a check fails, retain the isolated copy and evidence for investigation; do not repair it with ad-hoc SQL or switch production traffic under the R05 procedure.

For platform details, consult [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/). Secret values remain governed by the deployment process in [deployment.md](deployment.md) and [rollback.md](rollback.md).
