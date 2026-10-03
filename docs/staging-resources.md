# 共享 staging 退役记录

状态（2026-10-03）：已获授权并完成永久退役。共享 staging Worker、D1、KV 和 Gate DO 均已删除；删除后的资源清单已回读确认，旧地址不再作为服务入口。仓库已移除命名 staging 配置与操作入口；以下资源 ID 仅供精确核对和历史追溯，不得用于新部署。正式环境见[部署步骤](deployment.md)，分支测试见[PR 预发](pr-previews.md)。

2026-09-08，按用户“部署 cf 进行基本测试”的授权创建并部署。历史上使用 `apps/worker/wrangler.jsonc` 的 `staging` 环境。

| 历史资源 | 记录值 |
| --- | --- |
| 账户 | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker | `sub2api-cloudflare-staging` |
| 历史主机名 | `sub2api-cloudflare-staging.alphazhang689.workers.dev` |
| D1 | `sub2api-cloudflare-staging` / `50fe8c8c-6945-4a15-a3f6-83904632aec2` |
| KV CACHE | `6fe5850647504132a0ce70f2c5bd2056` |
| Durable Object | 同 Worker 的 `Gate`，SQLite migration tag `v1` |
| Cron 配置 | 每五分钟；部署成功不等同于已完成运行效果验收 |

2026-09-08 的部署未修改原来的 `sub2api-admin`、`sub2api-api`、`sub2api-pages`、`sub2api-proxy` 及旧 D1/KV；该描述仅属于当时记录。当前 production 已使用独立真实资源，不能按历史占位配置处理。

历史初始管理员为 `staging-admin@example.invalid`。当时随机密码只保存在本机 Git 忽略的 `secrets/staging-bootstrap.json`；渠道加密 keyring 与邮箱 HMAC 密钥分别随机生成，保存于被忽略的 `secrets/staging-worker.json` 并通过发布上传为 Secrets。不要提交、发布或复制这些文件到文档。

历史基本测试时注册关闭、邮箱验证能力关闭，无真实邮件 binding，未配置模型上游。当时基本测试中创建的普通账户已停用、余额已恢复为零，账单与审计保留于旧测试库；该库现已永久删除，历史验收记录不表示数据仍可恢复。详见 [云端测试证据](evidence/staging-deploy.md)。

本次清理保留生产 Worker、D1、KV、Gate DO 和活动版本 `f0acf994-2e54-4198-ba63-0594a6b31eea`。资源保留已核对；本轮执行环境的公网 `/healthz` 返回 403，不能据此标记公网健康验收通过。
