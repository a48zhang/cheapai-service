# Sub2API on Cloudflare

面向 Cloudflare 的跨协议 API 网关。已完成一期设计、微任务拆分和首批 8 个基础任务；注册、计费、实际协议转换和云部署仍待后续实现。

## 一期目标

用户通过开放注册或注册码注册，并按设置完成邮箱验证；登录后管理平台 API Key。管理员配置 OpenAI-compatible 或 Anthropic Messages 渠道。下游 Chat Completions、Responses、Messages 与三种上游协议的九种组合全部实现普通和流式转换，参考 Sub2API 的行为与测试。

计费采用预付费准入、请求结束后扣费，允许少量透支。D1 保存真实余额与账单，KV 为路由、价格和短期余额快照提供缓存。上游只用 Base URL/API Key，不涉及 OAuth。

## 简化架构

一个 Worker 部署，同时提供静态前端、管理 API、模型网关与 Cron。

- D1：用户、注册、Key、渠道、余额、请求及账单的唯一持久业务数据源。
- KV：可失效、可回源的缓存，不保存唯一账单、不执行余额增减。
- 轻量 Durable Object：用户/渠道并发租约与限流，无独立账本或渠道数据库。
- Email Service：发送验证邮件。
- 一期不使用 Queues、Outbox、异步查询投影或独立 jobs 服务；R2 按后续归档需求引入。

## 文档

1. [一期目标与验收](docs/phase-1.md)
2. [完整技术方案 v1.0](docs/architecture.md)：架构、数据表、注册鉴权、九种协议组合、计费/KV、接口、故障恢复、部署和验收。
3. [计费与 KV 策略](docs/billing-cache.md)
4. [注册与身份](docs/registration-auth.md)
5. [协议转换矩阵](docs/protocol-compatibility.md)
6. [实施顺序](docs/implementation-plan.md)
7. [现有实现与参考资料](docs/evidence.md)
8. [工具链与本机运行步骤](docs/toolchain.md)
9. [协议源码基线](docs/protocol-baseline.md)与[第三方声明](THIRD_PARTY_NOTICES.md)

## 工程布局

```text
apps/
  web/                  注册、用户与管理界面
  worker/               一个 Worker 的代码
    auth/               注册、会话、权限
    admin/              管理 API
    gateway/            路由、转发与取消
    billing/            准入、结算与余额查询
    cache/              KV 读取、失效与回源
    limits/             并发租约 DO
    scheduled/          过期数据和异常请求检查
packages/
  apicompat/            独立测试的协议转换模块
migrations/             D1 版本迁移
tests/                  契约、集成、故障与端到端测试
docs/                   目标与设计
```

TypeScript、Hono、Wrangler；前端采用 Vue 3/Vite 并评估复用 Sub2API 页面。使用 pnpm workspace 管理前端、Worker 和转换包，其他业务先用普通模块，不拆独立服务和发布包。现已固定 Node 24.19.0/pnpm 11.19.0、依赖和锁文件，并加入 strict 类型配置、Worker 健康入口、前端构建配置和协议类型契约；具体命令及 Windows Path 处理见工具链说明。

首批验证：三个工作区类型检查、协议声明构建、健康入口与未知 API 的 13 项本地断言通过。前端入口 F09、资源绑定 F06 和后续业务尚未完成，不能将这些结果视为全工程构建、协议兼容或生产验收通过。

完整方案已给出实施默认值：USD 定点记账、调用后原子扣费；路由/价格缓存先启用，余额 KV 保留开关、初始关闭，若启用则使用十五秒业务快照期限。这些是待实测的工程默认值，后续按运行数据调整。

## 约束

- 纯 Cloudflare，不依赖 VPS、外部 PostgreSQL 或 Redis。
- 新工程使用独立测试资源，保留原来的四个 Worker。
- 金额允许短暂负数，但不能重复扣费、丢失已提交账单或用 KV 覆盖真实余额。
- 管理权限、注册码核销、Key 撤销等安全约束不因允许透支而放松。
- 上游代码固定参考提交并记录来源和许可证；密钥不提交到 Git。
- 当前只有本地 Git 工程，未建立 GitHub 远程。
