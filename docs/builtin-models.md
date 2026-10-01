# 内置模型目录

核对日期：2026-09-10。迁移 `0018_builtin_models.sql` 为新安装和现有部署直接添加 23 个公开模型，管理员无需逐个创建。已有同名模型的状态、价格、版本和输出限制保持不变。迁移不会创建渠道映射或开放用户分组。

包含 GPT-5 / mini / nano、5.1、5.2、5.3-Codex、5.4 / mini / nano、5.5、5.6（Sol 别名）、5.6 Sol / Terra / Luna、6 Astra；Claude Sonnet 4.6 / 5、Opus 4.6 / 4.7 / 4.8 / 5、Fable 5、Mythos 5。未将所有日期快照、Pro 和历史 Codex 变体重复加入；Mythos 5 的实际访问限于供应商授权账户。

`packages/model-catalog/index.ts` 是参考元信息的维护入口，包括厂商、正式 ID、上下文窗口、最大输出、原生接口、参考价格和来源。通过 `node scripts/generate-model-seeds.mjs --check` 核对初始目录与迁移一致。后续版本更新应新增迁移，不能改写已部署迁移或自动覆盖管理员售价。

默认输出配置已移除，网关不再替客户端补充输出限制。历史迁移 0018 中的 4096 随迁移 0019 删除，不影响已有模型价格。参考最大输出为 128000 Token；GPT 老系列上下文为 400000，GPT-5.4 主型号及 5.5 / 5.6 / 6 为 1050000，Claude 为 1000000。上下文是参考元信息，未增加新的网关上下文计数或硬性限制。

渠道配置自动读取全部启用模型；选择预设时填入对应原生接口、同名上游模型，以及流式/工具调用开关。已有映射的接口和能力配置优先保留；管理员仍可改为兼容上游实际提供的接口和别名。供应商元信息不能证明具体渠道已经开通该模型。

初始销售单价取官方标准档 USD / 百万 Token，采用现有平价桶计费机制。缓存读取和写入分开计价，Claude 包含 5 分钟及 1 小时写入价格；未知用量不推算为零。长上下文加价、Fast/Batch/Flex、地区加价及账户特价不自动计入本站售价。模型编辑页的折叠元信息提供这一说明与官方来源。GPT-5.6 Sol 的参考促销价官方承诺至少持续至 2026-11-21，之后需重新核对。

官方来源：

- [OpenAI 模型目录](https://developers.openai.com/api/docs/models)及各型号页面（目录中每条记录的 source）。
- [OpenAI 定价](https://developers.openai.com/api/docs/pricing)。
- [Claude 模型概览](https://platform.claude.com/docs/en/models/overview)、[发布记录](https://platform.claude.com/docs/en/release-notes/overview)及[价格表](https://platform.claude.com/docs/en/about-claude/pricing)。Sonnet 5 采用当前永久标准价 $2 / $10，而非已取消的 $3 / $15 涨价计划。

验证：原生 D1 迁移、模型管理与分组模型接口共 5 文件 47 用例通过；浏览器内置目录与原有分组链路 2 用例通过；前端类型检查通过。测试使用隔离数据库和模拟上游，无真实模型调用。线上检查见 `docs/evidence/builtin-models.json`。
