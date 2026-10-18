# 协议转换

网关提供 Chat Completions、Responses 和 Messages 三种入口，根据渠道映射转换请求，并将 JSON 响应或 SSE 转回客户端协议。九个直接方向及字段范围见[协议支持矩阵](protocol-support.md)。

## 实现结构

- `packages/apicompat/types`：协议 schema 和内部类型。
- `packages/apicompat/requests`：请求转换。
- `packages/apicompat/responses`：JSON 响应、错误与 usage 映射。
- `packages/apicompat/streams`：各方向的 SSE 状态机及共享帧处理。
- `packages/apicompat/capabilities`：请求特征与可转换性判断。
- `apps/worker/gateway`：上游认证、地址、超时、渠道选择和请求生命周期。

同协议保留扩展字段，跨协议按目标协议映射。无法表达的工具、图片、推理或结构化输出约束返回转换错误。

## SSE 与计费

每个请求维护响应 ID、内容块和工具索引、工具调用 ID、参数片段、终态及 usage。解析支持 UTF-8 跨字节切分、跨 chunk 帧、多行 data 和心跳。

各协议分别处理块与消息生命周期。工具参数片段在完整后解析，完成事件只发送一次；截断作为异常处理。流转换保留背压，限制缓冲，并将取消信号传给上游。

计费读取原始上游 usage 和请求固定的价格快照。下游 usage 的格式转换不参与再次结算。

## 多轮与状态引用

跨协议多轮请求携带完整消息和工具结果。`previous_response_id` 在原生 Responses 路径中按用户、Key、模型和原渠道检查归属，并保存响应 ID 映射。无法解析的引用返回错误，调用方需提交完整历史。

GET/DELETE response、后台任务、Realtime/WebSocket 不在当前接口范围内。签名 thinking、加密 reasoning 和供应商工具按[字段矩阵](protocol-support.md)处理。

参考来源见[协议源码基线](protocol-baseline.md)；实际供应商与 SDK 检查见[真实上游兼容测试](live-compatibility-testing.md)。
