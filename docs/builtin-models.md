# 内置模型目录

迁移 `0018_builtin_models.sql` 为新安装和现有部署直接添加 23 个公开模型，管理员无需逐个创建。已有同名模型的状态、价格和版本保持不变。迁移不会创建渠道映射或开放用户分组。

包含 GPT-5 / mini / nano、5.1、5.2、5.3-Codex、5.4 / mini / nano、5.5、5.6（Sol 别名）、5.6 Sol / Terra / Luna、6 Astra；Claude Sonnet 4.6 / 5、Opus 4.6 / 4.7 / 4.8 / 5、Fable 5、Mythos 5。Mythos 5 的实际访问限于供应商授权账户。

`packages/model-catalog/index.ts` 是参考元信息的维护入口，包括厂商、正式 ID、上下文窗口、原生接口、参考价格和来源。通过 `node scripts/generate-model-seeds.mjs --check` 核对当前目录与 `seeds/builtin-models.sql` 一致；不带参数运行该脚本会更新当前 schema 的种子 SQL，保持已部署迁移不变。后续版本更新应新增迁移，不能改写已部署迁移或自动覆盖管理员售价。

输出参数由调用方提供；模型目录中的上下文窗口用于展示参考信息，网关不据此计数或截断请求。

渠道模型管理支持从模型目录选择模型；使用内置参考时填入对应原生接口和同名上游模型，无需配置流式或工具调用开关。管理员可修改上游别名或新增其他协议的映射，并需确认供应商账户具备访问权限。

初始销售单价取官方标准档 USD / 百万 Token，采用现有平价桶计费机制。缓存读取和写入分开计价，Claude 包含 5 分钟及 1 小时写入价格；未知用量不推算为零。长上下文加价、Fast/Batch/Flex、地区加价及账户特价不自动计入本站售价。模型编辑页的折叠元信息提供这一说明与官方来源。GPT-5.6 Sol 的参考促销价官方承诺至少持续至 2026-11-21，之后需重新核对。

官方来源：

- [OpenAI 模型目录](https://developers.openai.com/api/docs/models)及各型号页面（目录中每条记录的 source）。
- [OpenAI 定价](https://developers.openai.com/api/docs/pricing)。
- [Claude 模型概览](https://platform.claude.com/docs/en/models/overview)、[发布记录](https://platform.claude.com/docs/en/release-notes/overview)及[价格表](https://platform.claude.com/docs/en/about-claude/pricing)。Sonnet 5 采用当前永久标准价 $2 / $10，而非已取消的 $3 / $15 涨价计划。
