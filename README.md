# Sub2API on Cloudflare

一个运行在 Cloudflare 上的跨协议 AI API 网关，同时提供网页聊天、用户控制台和管理后台。后端使用 TypeScript/Hono，前端使用 Vue 3/Vite；一个 Worker 提供前端静态资源、管理 API、模型网关和定时维护。

## 从哪里开始

| 你想做什么 | 入口 |
| --- | --- |
| 使用网页聊天或接入自己的客户端 | [用户上手指南](docs/user-guide.md) |
| 配置渠道、模型、分组和用户余额 | [管理员上手指南](docs/admin-guide.md) |
| 在本地开发、运行测试 | [本地开发](docs/development.md) |
| 部署或升级已有环境 | [部署步骤](docs/deployment.md) → [备份恢复](docs/backup-restore.md) / [回滚](docs/rollback.md) |
| 了解支持的协议字段与限制 | [协议支持矩阵](docs/protocol-support.md) |
| 查找设计、历史验收或实施任务 | [文档导航](docs/README.md) |

## 当前实现与验证边界

更新：2026-10-03。本轮基于 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a` 实施修复；以下状态指本地工作树，尚未推送或发布。

- 已实现注册策略、邮箱验证码流程、登录会话、平台 API Key、用户/分组/渠道/模型管理、余额授额、请求记录、账单与审计
- 网关入口：`GET /v1/models`，以及 `POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`
- Chat Completions、Responses、Messages 三种上下游协议的九个组合均有直接适配器，分别处理普通 JSON 和 SSE；具体字段仍受模型/渠道能力及[支持边界](docs/protocol-support.md)约束
- 网页聊天包含历史会话、流式回答、停止生成、最后一轮重新生成及回答版本选择；使用登录会话，不需要用户先创建 API Key
- D1 迁移已到 `0023_request_source_group.sql`；迁移中的内置模型目录不等于已配置可调用渠道

本轮请求可靠性 B01–B07 与前端 FE-D01–FE-D11 已实现：聊天正文保真、操作收尾、会话过期/草稿恢复、历史分页、完整渠道选择器，以及逻辑请求 RPM、渠道冷却和有界资源释放。共享目录与存储拆分已实现；完整范围与状态见[执行计划](docs/implementation-plan.md)。

已完成的局部检查：后端 Workers 170 项、Chat Node 10 项，前端 Node 20 项、管理契约 7 项及 Web 类型检查/构建通过。Chromium 启动遇到 socket EPERM，本轮浏览器验收未通过。完整代码的集中检查与真实云、上游、邮件、容量及恢复验收仍待完成。

原基线的 [GitHub Actions](https://github.com/a48zhang/sub2api-cloudflare/actions/runs/36874254293) 与 [9 月 12 日聊天交付](docs/web-chat-delivery.md)保留为历史证据。旧 507 节点中的 `CHAT-RELEASE` 和 26 项后置验收仍未关闭；本地实现不等于已发布。剩余事项见[已知问题与验证边界](docs/known-issues.md)。

## 本地检查

先按 `.node-version` 和 `package.json` 使用 Node **24.19.0**、pnpm **11.19.0**，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
pnpm run check
```

`check` 依次运行类型检查、Vitest、构建；Worker 构建使用 `wrangler deploy --dry-run`，不会发布。浏览器端到端测试单独运行，完整的可登录本地环境还需要 D1 迁移、可信 HTTPS、`PUBLIC_BASE_URL` 和本地配置，见[本地开发](docs/development.md)。仅运行 Vite 或访问 `/healthz` 不能证明注册、聊天和网关可用。

## 架构与目录

- **D1**：用户、身份、渠道、模型、聊天、请求和账务的持久业务数据；余额与账单在此正式提交
- **KV**：可失效、可回源的路由/价格等缓存，不承担独立账本或余额增减
- **Gate Durable Object**：并发租约与限流
- **Email binding**：发送注册验证码，必须由部署者配置并验证投递能力
- **Cron**：到期身份清理、异常请求检查和结算重试

```text
apps/web/              Vue 用户与管理界面、网页聊天
apps/worker/           Hono API、网关、鉴权、计费、聊天与维护
packages/apicompat/    协议校验和普通/流式直接转换
packages/model-catalog/ 内置模型参考元信息
migrations/            D1 顺序迁移
scripts/               初始化、测试和运维辅助脚本
tests/                 单元、Workers、集成与浏览器测试
docs/                  使用指南、运行手册、设计与历史证据
```

## 使用前要知道

- 新用户和初始管理员余额都是零；注册码只提供注册资格，不附带余额。管理员授额后才能正常调用
- 内置模型仍需启用渠道、模型映射、分组关联与用户授权；“暂无可用模型”应按[管理员检查清单](docs/admin-guide.md#没有可用模型时的检查顺序)逐项排查
- 计费是预付费准入、请求后结算，允许少量透支；网页聊天和 API 共用用户余额，分组倍率会影响费用
- 上游接入使用 Base URL/API Key，不包含账号 OAuth；密码找回、自助支付、独立图片生成、Realtime/WebSocket 不在当前一期范围
- 不依赖 VPS、PostgreSQL、Redis、Queues 或独立 jobs 服务；密钥、数据库导出和本地状态不得提交到 Git

协议参考来源与许可见[源码基线](docs/protocol-baseline.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。
