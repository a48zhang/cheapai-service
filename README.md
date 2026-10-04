# cheapai

cheapai 是运行在 Cloudflare 上的跨协议 AI API 网关，提供网页聊天、用户控制台和管理后台。产品界面采用 React、TypeScript 与 Vite；Cloudflare Worker 提供管理 API、模型网关、认证、计费和定时维护。

## 从哪里开始

| 你想做什么 | 入口 |
| --- | --- |
| 使用网页聊天或接入自己的客户端 | [用户上手指南](docs/user-guide.md) |
| 配置渠道、模型、分组和用户余额 | [管理员上手指南](docs/admin-guide.md) |
| 本地开发与集中检查 | [本地开发](docs/development.md) |
| 部署或升级已有环境 | [部署步骤](docs/deployment.md) → [备份恢复](docs/backup-restore.md) / [回滚](docs/rollback.md) |
| 了解支持的协议字段与限制 | [协议支持矩阵](docs/protocol-support.md) |
| 查找设计、实施计划与验收边界 | [文档导航](docs/README.md) |

## 实现与验证状态

工作树中包含 cheapai React 前端及其会话、聊天、用户 Key、请求、账单和管理功能。后端通过同源 `/api/v1` 管理 API 与 `/v1` 网关提供服务；支持 Chat Completions、Responses 和 Messages 协议，并按渠道、模型能力和[协议边界](docs/protocol-support.md)执行转换。

React 已切换到正式 `apps/web`。完整 Vitest 的 198 个文件、3,847 项测试通过，工作区类型检查、生产构建、Worker dry-run 和 React lint 通过；37 项浏览器用例已覆盖通过（完整运行 35 项通过，另 2 项修正测试定位后定点通过）。最新证据见[最终验收记录](docs/validation/cheapai-react-final.md)，开发入口见[本地开发](docs/development.md)。

## 本地开发

工具链使用 `.node-version` 和根 `package.json` 指定的 Node **24.19.0**、pnpm **11.19.0**。React 开发环境由 `scripts/start-react-dev.mjs` 同时启动本地 Worker 和启用 HTTPS 的 Vite，并将浏览器的相对 `/api` 请求代理到 Worker。证书、端口、数据库迁移和初始管理员设置见[本地开发指南](docs/development.md)。

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
node scripts/start-react-dev.mjs
```

## 代码库结构

```text
apps/web/                  React SPA：app composition、pages、features、shared
apps/worker/               Hono/Cloudflare Worker：认证、管理 API、网关和计费
packages/contracts/        按领域定义并校验 API 数据契约
packages/api-client/       浏览器 fetch、CSRF、envelope 解码与领域 API
packages/model-catalog/    内置模型参考元数据
packages/apicompat/        上下游协议校验与普通/流式转换
migrations/                D1 顺序迁移
scripts/                   开发、测试和运维辅助脚本
tests/                     Node、Workers、集成和浏览器测试
docs/                      使用指南、运行手册、设计与历史证据
```

前端内部按 `app → pages → features → shared` 组织。浏览器业务代码从 `@cheapai/contracts/<domain>` 和 `@cheapai/api-client/<domain>` 导入共享契约，不直接依赖 Worker 源码。

## 业务与兼容边界

- 新用户和初始管理员余额为零；注册码只提供注册资格。管理员授额后，用户才能正常调用模型。
- 内置模型仍需配置渠道、模型映射、分组关联和用户授权；“暂无可用模型”可按[管理员检查清单](docs/admin-guide.md#没有可用模型时的检查顺序)逐项排查。
- 计费使用预付费准入并在请求后结算，允许少量透支；网页聊天和 API 共用用户余额，分组倍率会影响费用。
- 登录采用同源 Secure Cookie 与 CSRF 校验；浏览器不把会话或平台 API Key 写入 localStorage。旧 Cookie 名与 `s2a_*` Key/令牌前缀继续作为协议兼容标识，不是用户界面的产品名称。
- 上游接入使用 Base URL/API Key，不包含账号 OAuth；密码找回、自助支付、Realtime/WebSocket 不在当前范围内。
- 不依赖 VPS、PostgreSQL、Redis、Queues 或独立 jobs 服务；密钥、数据库导出和本地状态不得提交到 Git。

协议参考来源与许可见[源码基线](docs/protocol-baseline.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。
