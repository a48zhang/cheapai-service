# Cloudflare staging 发布与基本测试

测试日期：2026-09-08。地址：[staging 控制台](https://sub2api-cloudflare-staging.alphazhang689.workers.dev)。

发布版本：`9773a17b-f375-4b14-ae2b-b388c96e0143`。同一 Worker 携带 Vue assets、API、Gate DO 和定时维护入口；部署输出确认 HTTP URL 与每五分钟触发器。Worker startup 为 12 ms（这不是密码哈希 CPU 指标）。[资源清单](../staging-resources.md)记录独立资源 ID。

## 数据库与迁移修复

全新远程 D1 的 16 份迁移全部成功，`PRAGMA foreign_key_check` 无结果；六个 `billing_entries_*` 验证、原子更新及不可修改/删除触发器均存在。

首次运行第 13 份迁移遇到 `incomplete input`，前 12 份成功。将 `SELECT CASE ... END` 改为等价的 `SELECT (CASE ... END)` 后，原有原子记账回归 11/11 通过，远程标准 `d1 migrations apply --remote --env staging` 接着完成第 13–16 份迁移，未手动跳过迁移或关闭任何验证。Cloudflare 曾记录相同的未加括号 CASE 分句问题：[workers-sdk #4727](https://github.com/cloudflare/workers-sdk/issues/4727)。本轮远程复测验证了修复效果。

## 公网基本测试

使用本机 Edge headless 与 Playwright 访问真实 HTTPS Worker，**33 项检查通过**，未使用请求 mock。具体检查见 [结构化结果](staging-basic.json)。

- 健康检查、静态页面、实际渲染的仪表盘余额、未知 API 404。
- 管理员实际 Argon2 登录，Secure / HttpOnly / SameSite 会话，匿名访问和跨 Origin 写入拒绝。
- 用户、渠道、模型、分组管理接口读取；临时邀请码注册，验证普通用户角色与零余额、普通用户越权拒绝。
- Key 创建与一次性明文显示；鉴权后模型列表为空。三个生成入口拒绝未配置模型，本轮没有上游推理调用。
- D1 追加账单授额、相同幂等键重放不重复授额、负余额、恢复零余额，三条账单精确求和为零。
- 用户与管理员退出后会话失效；恢复关闭注册策略、停用唯一合成测试账户；管理页面再次确认注册关闭。

本轮使用的测试控制器位于工作区 `work/cf-deploy/`，未打包或部署测试专用入口。初始管理员的随机凭据保留本机 `secrets/staging-bootstrap.json`。未发送邮件、调用真实供应商或对旧服务执行操作。

## 发布复现与仍未覆盖的范围

使用工程锁定的 Node 24.19.0 / pnpm 11.19.0 / Wrangler 4.129.0。先构建前端并核对 staging 资源，然后执行：

```powershell
node apps/worker/node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --config apps/worker/wrangler.jsonc --env staging --remote
node apps/worker/node_modules/wrangler/bin/wrangler.js deploy --config apps/worker/wrangler.jsonc --env staging --strict --secrets-file secrets/staging-worker.json
```

只对首次空数据库运行 bootstrap，不重复创建或重设管理员；普通后续发布使用现有 Secrets，保留全部渠道历史密钥版本。邮件、真实供应商/SDK、密码 CPU/内存/并发测量、负载、Cron 实际执行效果与恢复演练仍需各自证据，本次登录成功不替代这些测试。之前的本地审计源哈希是历史快照；本次部署增加了 staging 配置及 SQL 兼容修复。
