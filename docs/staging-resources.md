# 独立 Cloudflare staging

2026-09-08，按用户“部署 cf 进行基本测试”的授权创建并部署。配置为 `apps/worker/wrangler.jsonc` 的 `staging` 环境。

| 资源 | 当前值 |
| --- | --- |
| 账户 | `4ac5221079fd3481ce2d92f1d1e049cd` |
| Worker | `sub2api-cloudflare-staging` |
| 地址 | https://sub2api-cloudflare-staging.alphazhang689.workers.dev |
| D1 | `sub2api-cloudflare-staging` / `50fe8c8c-6945-4a15-a3f6-83904632aec2` |
| KV CACHE | `6fe5850647504132a0ce70f2c5bd2056` |
| Durable Object | 同 Worker 的 `Gate`，SQLite migration tag `v1` |
| Cron 配置 | 每五分钟；部署成功不等同于已完成运行效果验收 |

原来的 `sub2api-admin`、`sub2api-api`、`sub2api-pages`、`sub2api-proxy` 及旧 D1/KV 未修改。production 仍保留占位配置。

初始管理员为 `staging-admin@example.invalid`。随机密码只保存在本机 Git 忽略的 `secrets/staging-bootstrap.json`；渠道加密 keyring 与邮箱 HMAC 密钥分别随机生成，保存于被忽略的 `secrets/staging-worker.json` 并通过发布上传为 Secrets。不要提交、发布或复制这些文件到文档。

当前注册关闭、邮箱验证能力关闭，无真实邮件 binding，未配置模型上游。基本测试中创建的普通账户已停用、余额已恢复为零，账单与审计保留。详见 [云端测试证据](evidence/staging-deploy.md)。
