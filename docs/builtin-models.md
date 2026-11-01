# 内置模型目录

核对日期：2026-11-01。当前维护 27 个参考模型，OpenAI 从 GPT-5.5 到 GPT-6.1，Anthropic 从 Claude 4.5 到 Claude 5.5。

- OpenAI：GPT-5.5 / Pro，5.6（Sol 别名）/ Sol / Terra / Luna，6 Astra / Sol / Luna，6.1 Sol / Terra。
- Anthropic：Haiku 4.5 / 5.5，Sonnet 4.5 / 4.6 / 5 / 5.5，Opus 4.5 / 4.6 / 4.7 / 4.8 / 5 / 5.5，Fable 5 / 5.1，Mythos 5 / 5.1。Mythos 的实际访问限于供应商授权账户。

迁移 `0034_refresh_builtin_models.sql` 在保留历史迁移 `0018` 的基础上更新目录。GPT-5.5 以前及 Claude 4.5 以前的正式 ID、旧版变体和日期快照退出目录：没有渠道映射、请求或聊天引用的条目直接移除；已有引用的条目停用并增加价格版本，保留原始价格、渠道映射和历史记录。保留版本及新型号的同名配置通过 `ON CONFLICT DO NOTHING` 保护，管理员售价、状态和版本不被覆盖。自定义厂商前缀别名不按名称推断版本。

`packages/model-catalog/index.ts` 是参考元信息的维护入口。通过 `node scripts/generate-model-seeds.mjs --check` 核对当前目录与 `seeds/builtin-models.sql` 一致；不带参数运行该脚本会更新当前 schema 的种子 SQL。后续更新应新增迁移，不能改写已部署迁移。

迁移不创建渠道映射或开放分组授权。管理员关联渠道后，公开目录、聊天选模和 API 才会按实际分组权限展示模型；默认填入官方原生接口与同名上游模型，管理员可调整别名。输出参数仍由调用方提供。

初始售价沿用官方标准档的数值，以积分 / 百万 Token 展示，不进行汇率换算。输入、输出、缓存读取与写入分别计价。GPT-6.1 Sol / Terra 的缓存读取分别是 0.1 / 0.05；Claude Opus 5.5 / Sonnet 5.5 分别是 0.2 / 0.1，Fable / Mythos 5.1 均为 0.25，不能统一按输入价的 10% 推算。GPT-5.5 Pro 没有官方缓存折扣，未设置缓存价。

Claude Haiku 5.5 初始采用输入不超过 10 万 Token 的标准档数值；官方超过该阈值会加价，本站仍按管理员配置的固定售价计费。长上下文、Fast/Batch/Flex、地区加价和不同缓存保留时长不自动切换售价。GPT-5.6 Sol 的参考促销价官方承诺至少持续至 2026-11-21，之后需重新核对。

官方来源：

- [OpenAI 模型目录](https://developers.openai.com/api/docs/models)及各型号页面（每条记录的 source）。
- [OpenAI 定价](https://developers.openai.com/api/docs/pricing)，包含 GPT-6.1 Sol / Terra 的标准档缓存费率。
- [Claude 模型概览](https://platform.claude.com/docs/en/models/overview)和[价格表](https://platform.claude.com/docs/en/about-claude/pricing)。
- [Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) 的分档价格。
