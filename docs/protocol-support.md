# 协议字段兼容矩阵

状态：2026-09-08 本地源码核对与合成响应/流代表用例。`defaultProtocolRegistry` 当前注册九个直接方向；每个方向分别有 JSON response adapter 与 SSE stream adapter，因此矩阵覆盖十八条路径。测试使用实际 registry `lookup` 和实际 adapter，不使用只判断 pair 存在的桩。

方向中的箭头始终是下游请求到上游协议。返回方向由注册的 response/stream adapter 直接完成。来源和行为参考固定的 Sub2API 提交 [`ab99d56e9626e6cd731592dae8553c9758a0efa2`](https://github.com/Wei-Shaw/sub2api/tree/ab99d56e9626e6cd731592dae8553c9758a0efa2)；本表记录本工程 TypeScript adapter 的实际边界，不宣称复制旧项目的全部行为。

## 九格与十八条路径

`✓` 表示已经注册且由本地代表用例调用；`条件` 表示必须先由模型/渠道能力检查批准；`拒绝` 表示 adapter 返回明确转换错误；`原生` 表示同协议透传仍受该协议 validator 和显式 extension 白名单约束。

| 下游 → 上游 | 请求字段 | JSON 返回（上游 → 下游） | SSE 返回（上游 → 下游） | 已核对的限制 |
| --- | --- | --- | --- | --- |
| Chat → Chat | 原生 | ✓ 原生 | ✓ 原生 | Chat 字段按原生 schema；未知扩展须白名单 |
| Chat → Responses | ✓ Chat→Responses | ✓ Responses→Chat | ✓ Responses→Chat | 文本、函数工具、tool choice、并行工具、图片输入、结构化输出和常见 reasoning effort 依能力通过；Responses 无等价 Chat `stop`、部分缓存/私有 reasoning、非空 annotations/logprobs 时拒绝 |
| Chat → Messages | ✓ Chat→Messages | ✓ Messages→Chat | ✓ Messages→Chat | 文本、函数工具、图片输入、输出上限、采样、stop、严格 JSON schema、常见 effort/cache 按能力通过；Messages 原生 `max_tokens` 必须有显式策略，签名/私有 thinking 和不可映射图片/引用拒绝 |
| Responses → Chat | ✓ Responses→Chat | ✓ Chat→Responses | ✓ Chat→Responses | Responses input/instructions、函数工具、图片和 schema 按能力映射；服务端历史引用需要原渠道绑定；Chat 返回的 annotations 非空、未知 finish、不可回传私有 reasoning 拒绝 |
| Responses → Responses | 原生 | ✓ 原生 | ✓ 原生 | 原生 item、历史、后台/扩展等仍由 Responses validator、能力和网关范围控制 |
| Responses → Messages | ✓ Responses→Messages | ✓ Messages→Responses | ✓ Messages→Responses | input/instructions、函数工具、图片、schema、常见 effort/cache 按能力映射；Messages 不支持 Responses content filter 等无等价终态，跨协议 signed/encrypted reasoning 拒绝 |
| Messages → Chat | ✓ Messages→Chat | ✓ Chat→Messages | ✓ Chat→Messages | 文本、tool_use、stop_sequence/max_tokens/tool_use、无签名公开 thinking 按能力映射；图片/cache/thinking budget、redacted/signed thinking 和工具后不可表达文本按能力或明确错误处理 |
| Messages → Responses | ✓ Messages→Responses | ✓ Responses→Messages | ✓ Responses→Messages | 文本、tool_use、公开 thinking、refusal、缓存 usage 展示按能力映射；签名/redacted thinking、不可表达 cache/图片/历史引用拒绝 |
| Messages → Messages | 原生 | ✓ 原生 | ✓ 原生 | Messages 原生 block、thinking signature、cache 和 usage 由自身 schema/能力决定 |

上述“图片”只表示对话输入中的 URL/base64/file 引用转换。独立图片生成接口、Realtime/WebSocket、后台任务和供应商内置服务端工具不因矩阵注册而获得支持；无法表达的约束在请求转换前由能力检查拒绝。

## 字段族边界

| 字段族 | 已实现的跨协议规则 | 明确不支持或需要条件 |
| --- | --- | --- |
| 文本、模型、响应 ID | 各直接 adapter 使用调用方的公开 `targetModel`、固定 `createdAt` 与稳定 `ResponseContext` ID；文本块/Responses item 顺序保留 | 不用上游私有模型名替换公开模型；不选择或丢弃多 choice/未知 output |
| 工具 | 可表示的 function/tool_use、调用 ID、名称、完整 JSON 对象参数和顺序直接映射；SSE 参数片段由各自状态机保留 | 非法/截断 JSON 不能伪装为完整普通 JSON；不合法或冲突 ID、未知 tool item、工具结果图片/错误需相应能力，否则明确拒绝 |
| 图片输入 | URL/base64/file_id 仅在目标能力声明后映射，默认不下载任意 URL | 图片 detail、文件引用、工具结果图片是条件字段；输出图片和独立生成不在一期 |
| 生成控制 | 输出上限、temperature/top_p、stop、tool choice、并行控制按目标协议的等价字段映射 | 没有等价字段时保留约束并返回错误；不通过删除字段换取成功。JSON object/schema 需目标能力，strict/schema 约束不能静默放宽 |
| 推理/thinking | 可公开表示的 reasoning summary/Chat reasoning alias 映射到目标公开块；不把 reasoning 当普通答案 | signed/encrypted/redacted/private payload 不伪造签名、不降格为文本；Messages thinking budget/adaptive 等源生控制按能力决定 |
| cache 与 usage | usage 只展示原始上游快照的可解释字段；Chat/Responses 的 inclusive input 与 Messages cache-exclusive input 只扣除/加回实际出现的 read/write bucket | 缺失 cache 细分不合成零；残余 `input_tokens` 是展示聚合，不是重新计量。计费读取原始 `UsageSnapshot`，不读取转换后的 body，也不重复扣费 |
| metadata、annotations、service tier | 官方形状的 `metadata`、`service_tier`、`annotations:[]` 可作为中立元数据验证；目标无对应字段时不放入生成正文 | 非空 citation/logprobs、未知 provider 字段和错误形状不能静默丢弃；同协议扩展也须显式 scope/name 白名单 |
| 终态与错误 | stop/end_turn/tool/length/refusal/content-filter/failed 在有等价目标字段时通过共享 P11 映射；错误 envelope 经过 P06 脱敏 | queued/in_progress、unknown/pause、无等价 content filter、私有错误正文不能变成正常成功；错误分支可没有成功响应的 usage |
| 历史引用 | 原生 Responses 的 `previous_response_id`/item reference 由网关按用户、Key、模型和原渠道绑定检查 | 跨协议不把供应商 ID 发给别的协议，也不建立隐式完整历史服务；真实归属与历史完整性由 G13 守卫，矩阵测试不代替它 |

## Messages 起始 usage 与原始计费快照

Messages SSE 的 `message_start` 需要合法的 usage 形状；Chat→Messages 和 Responses→Messages 流适配器会在尚无最终上游计数时发出 wire-only `{ input_tokens: 0, output_tokens: 0 }` 初始占位。这个占位只满足目标客户端的 envelope，不进入源 usage accumulator，也不代表一次真实计量。

普通 JSON 的 CM/RM adapter 要求成功的 Messages body 带合法 usage 和基础 input/output。Chat/Responses 的 inclusive 输入有已知 cache read/write 时只展示扣除已知 bucket 后的 residual；缺失 sibling 字段保持未分类并省略对应 detail。原始上游 usage 与 `UsageSnapshot` 仍由网关保存和计费，转换 body 不会回灌计费。

## 证据等级与未完成事项

`tests/apicompat/support-matrix.test.ts` 提供本地 registry wiring、实际 JSON adapter、实际 SSE adapter、基本/工具代表用例、标准元数据、私有 reasoning 拒绝、Messages 初始占位和 residual/原始 usage 分离断言。它不是真实供应商、真实 SDK、邮件、部署或公网测试，也不能证明所有版本 SDK 的无损兼容。

截至本表日期，CR/CM 的全部 S6 与终态 guard 已由对应本地测试收口，MC-S6 也已完成 20 个测试；P23 只记录当前源码和本地代表证据。真实上游、客户端/SDK 版本、费用、取消、背压和历史归属仍需按 `docs/protocol-baseline.md` 的后置验收记录，不能由本地矩阵宣称已完成。
