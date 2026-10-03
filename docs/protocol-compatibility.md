# 一期协议转换方案

> 本文说明设计目标和转换原则。当前已注册方向、字段拒绝/条件支持与本地验证边界，请先看[协议支持矩阵](protocol-support.md)；九格适配器存在不等于所有真实供应商或 SDK 都已验收。

本文是 [完整技术方案](architecture.md) 第 6 章的专题补充；架构与默认行为以主文档为实施基线。

## 本轮实现边界

2026-10-03 的整理不改三协议 wire 形状或 Chat HTTP/SSE 桥接。共享 catalog 读取与 request-lifecycle 收尾归属见[架构](architecture.md)；用户 RPM、冷却和取消的修复不扩大协议支持范围。JSON/SSE 错误观察在读取响应体前发生，401/403/429 冷却写入有界，不依赖供应商错误体格式。

本地 mock 与隔离 Workers 回归不替代真实供应商验收；九种组合仍需在明确供应商、模型、账户和费用上限后执行 V-UPSTREAM，并分别记录不支持与未测能力。

## 核心要求

用户使用自己的客户端协议，不必了解上游协议或手工改写请求。网关根据模型与渠道能力自动转换请求，并把普通响应、流事件、工具调用、错误和 usage 转回客户端协议。上游均以 API Key 接入，不涉及 OAuth。

OpenAI 在本工程中明确拆为 Chat Completions 和 Responses；Messages 指 Anthropic Messages。以下九种组合全部属于一期，不是任选其一。

| 下游入口 / 上游协议 | Chat Completions | Responses | Messages |
| --- | --- | --- | --- |
| /v1/chat/completions | 同协议 | 双向转换 | 双向转换 |
| /v1/responses | 双向转换 | 同协议 | 双向转换 |
| /v1/messages | 双向转换 | 双向转换 | 同协议 |

每一格同时验收普通 JSON 与 SSE。上游只提供其中一种协议也可服务另外两种下游的可映射请求。不得通过隐藏入口或要求用户更换 SDK 回避转换。

## 参考与实现结构

参考 Sub2API 固定提交 `ab99d56e9626e6cd731592dae8553c9758a0efa2` 的 [apicompat 模块](https://github.com/Wei-Shaw/sub2api/tree/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat)。移植前保留来源及适用许可证，不宣称已经复刻全部行为。

- `apicompat/types`：三种 wire schema 与内部类型，包含协议扩展字段。
- `apicompat/requests`：六个方向的请求转换和同协议路径。
- `apicompat/responses`：普通响应、错误与 usage 映射。
- `apicompat/streams`：每个方向独立的有状态 SSE 转换器，共享帧解析和事件辅助工具。
- `apicompat/capabilities`：模型特性与可转换性检查，供路由使用。
- `apps/worker/gateway` 内的上游模块：认证、Base URL、超时、HTTP 错误和渠道差异，不另拆 providers 发布包。

使用共享语义类型减少重复，但不强制所有流先转为某一种 wire 协议再转出。参考原版的直接桥接路径，避免两次流状态机转换和独有字段丢失。同协议路径尽量保留允许的扩展字段；跨协议路径显式映射，不将未知字段随意发送给另一个提供商。

## 映射范围

| 语义 | 一期要求 |
| --- | --- |
| 系统与消息 | system/developer、字符串与内容块、角色、多轮次序；明确优先级映射 |
| 文本与图片输入 | 文本、URL/base64 图片映射；模型不支持图片时在调用前明确拒绝 |
| 工具 | 工具定义/schema、tool choice、并行调用、参数增量、工具结果；ID 稳定可回传 |
| Responses items | message/function_call/function_call_output 与其他协议对应项映射；ID、索引与完成状态一致 |
| 控制参数 | 模型名、输出上限、采样、stop 与结构化输出；冲突参数和无法表达的约束显式处理 |
| 思考与缓存 | 对照 Sub2API 处理可映射的 reasoning/thinking 和缓存元数据；不伪造签名、不将私有思考内容变为普通文本 |
| 结束状态 | 正常结束、长度截断、工具调用、拒绝/过滤、错误分开映射；不能一律记成功 |
| 用量 | 输入/输出、缓存命中/写入、reasoning 等保留来源；累计值与增量分开处理，避免双计 |
| 错误 | HTTP 错误转为下游 error 格式；流内错误按下游事件规则结束，不能回头修改已发送状态码 |

“无感”指协议适配对客户端透明，不意味着可以模拟上游不存在的模型能力。无法等价表达的请求应先选另一兼容渠道，确实无可用渠道时返回该入口的明确错误；不得静默删除工具、图片或结构化输出约束。

## SSE 状态机

按请求维护响应 ID、内容块/工具索引、调用 ID、JSON 参数片段、结束状态及 usage。支持 UTF-8 跨字节切分、SSE 跨 chunk、多行 data、心跳和未知扩展事件策略。

Messages 的 block/message 生命周期、Chat Completions 的 chunks 与结束标记、Responses 的 item/content 生命周期和终态需要分别编码。工具参数不假设每个增量都能 JSON.parse；不得重复发送完成事件，截断不能伪装正常完成。转换保持背压，限制缓冲大小，取消信号传递到上游。

计费从上游原始 usage 语义提取一次，转换为下游 usage 不得触发第二次结算。跨协议 token 计数未必等同，账单明确按选定上游模型与价格快照计算。

## 有状态和独有能力

基础跨协议多轮使用完整历史与工具结果，不依赖上游账号会话。previous_response_id 一期仅在原生 Responses 上游支持时按用户/Key 归属校验、绑定原渠道与模型；请求表保存必要的响应 ID 映射。跨协议不保存完整对话来模拟服务端历史，无法解析的引用明确报错并提示提交完整历史。所有方向仍须实现完整历史多轮；不得把供应商 ID 发给其他渠道，也不得声称已实现通用状态恢复。GET/DELETE response、后台任务和完整历史服务不在本期范围。

上游内置工具、加密 reasoning、签名 thinking 和特定缓存语义需要逐项标注能力。相同协议能保留的能力尽量保留；跨协议无等价能力时按上面的显式错误规则处理。Realtime/WebSocket 和后台任务不在本期 HTTP 转换范围。

## 验收方法

1. 对固定 Sub2API 转换函数及测试用例建立对应关系，记录支持、差异与原因；不把只读源码当成验证结果。
2. 九种组合各有普通/流式 golden fixtures：文本、多轮、单/并行工具、参数分片、结束原因、usage。
3. 增补图片、system 内容块、空响应、流内错误、取消、缺失 usage、畸形参数与不支持特性测试。
4. 覆盖真实 OpenAI-compatible 与 Messages 上游、三类下游客户端/SDK。模型文字可不同，比较协议结构、事件顺序与语义，不比对随机生成文本。
5. 真实网络测试确认 Workers 环境的流式首字与背压表现；报告支持的字段矩阵，所有缺口可见。

参考协议文档：[Anthropic SSE](https://platform.claude.com/docs/en/build-with-claude/streaming)、[OpenAI Chat 类型](https://github.com/openai/openai-node/blob/main/src/resources/chat/completions/completions.ts)、[OpenAI 工具及流处理](https://github.com/openai/openai-node/blob/main/docs/tools.md)。实施时固定实际 SDK 版本与文档基线。
