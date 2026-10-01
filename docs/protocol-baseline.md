# 协议源码与用例基线（P21）

核对日期：2026-09-05。状态：固定来源、目录完整性和代表性源码/测试对应的静态核对已完成；本任务没有移植代码、复制 fixture 到工程、运行上游 Go 测试或验证 Workers/真实供应商兼容性。实施范围仍以 [架构](architecture.md)、[协议方案](protocol-compatibility.md) 和 [证据限制](evidence.md) 为准。

## 固定来源和取证范围

唯一上游为 [Wei-Shaw/sub2api 固定提交](https://github.com/Wei-Shaw/sub2api/tree/ab99d56e9626e6cd731592dae8553c9758a0efa2)，commit `ab99d56e9626e6cd731592dae8553c9758a0efa2`；不使用 main 或最新版本替代。

从 GitHub 官方 API 取得 [递归目录树](https://api.github.com/repos/Wei-Shaw/sub2api/git/trees/ab99d56e9626e6cd731592dae8553c9758a0efa2?recursive=1)：返回 sha 与固定提交一致，`truncated=false`，共 4040 个条目。仅下载根 LICENSE 和 `backend/internal/pkg/apicompat/` 的 48 个文件到工程外的 `../../work/p21-protocol-reference/`；未下载整个旧工程，也未读取或复制部署凭据。临时文件名将 `/` 替换为 `__`，目录树为 `tree.json`。该路径只是本次工作证据，不是构建依赖。

49 个下载文件逐一以 `git hash-object` 对照目录树的 blob SHA，全部匹配。完整目录树按 LICENSE/NOTICE/COPYING 文件名核对，只发现根 `LICENSE`；未发现独立 NOTICE、COPYING 或 apicompat 专用许可证。模块源文件未发现版权头、SPDX 或额外许可声明；这是本次检查范围内的结果，不能代替未来新增依赖的核查。根 LICENSE 是 GNU LGPL version 3（2007-06-29），详见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 转换方向与用例对应

以下文件名均相对 `backend/internal/pkg/apicompat/`，完整固定链接和 blob 身份见后面的清单。方向指函数处理的数据方向，不将“请求转换”与“返回转换”混为一项。函数和测试均从下载源码核对；列出测试不表示执行通过。

| 数据方向 / 类型 | 来源函数与文件 | 已核对的代表性测试 | 未来本地对应要求 |
| --- | --- | --- | --- |
| Chat → Responses 请求 | `ChatCompletionsToResponses`，`chatcompletions_to_responses.go` | `chatcompletions_responses_test.go`：`TestChatCompletionsToResponses_BasicText`、`TestChatCompletionsToResponses_ToolCalls` | 文本、system、多轮工具历史和参数控制 |
| Responses → Chat 请求 | `ResponsesToChatCompletionsRequest` / `WithOptions`，`chatcompletions_responses_bridge.go` | `chatcompletions_responses_bridge_test.go`：`TestResponsesToChatCompletionsRequest_InstructionsAndInputDeveloperRole`、`TestResponsesToChatCompletionsRequest_TextFormatJsonObject` | instructions/developer 顺序及结构化输出；显式记录旧行为差异 |
| Messages → Responses 请求 | `AnthropicToResponses`，`anthropic_to_responses.go` | `anthropic_responses_test.go`：`TestAnthropicToResponses_BasicText`、`TestAnthropicToResponses_ThinkingWithoutSignatureIgnored` | 图片、系统内容块、工具和签名语义 |
| Responses → Messages 请求 | `ResponsesToAnthropicRequest`，`responses_to_anthropic_request.go` | `responses_to_anthropic_instructions_test.go`：`TestResponsesToAnthropicRequest_Instructions`；`responses_to_anthropic_tool_pairing_test.go`：`TestAnthropicPairing_ParallelBothAnswered` | 多轮工具配对、instructions、未知内容块处理 |
| Messages → Chat 请求；Chat → Messages JSON/SSE 返回 | `AnthropicToChatCompletionsRequest`、`ChatCompletionsResponseToAnthropic`、`ChatCompletionsChunkToAnthropicEvents`，`chatcompletions_anthropic_bridge.go` | 同名 `_test.go`：`TestChatCompletionsResponseToAnthropic_CacheTokens`、`TestChatCompletionsChunkToAnthropicEvents_ParallelToolCalls`、`TestFinalizeChatCompletionsAnthropicStream_NoOpAfterStop` | 直接桥接，只运行一次流状态机；工具索引、usage、终态唯一 |
| Chat → Responses JSON/SSE 返回 | `ChatCompletionsResponseToResponses`、`ChatCompletionsChunkToResponsesEvents`、`FinalizeChatCompletionsResponsesStream`，`chatcompletions_responses_bridge.go` | `chatcompletions_responses_stream_lifecycle_test.go`：`TestStream_ReasoningOpensItemBeforeDelta`；`chatcompletions_reasoning_alias_test.go`：`TestChatReasoningAlias_ResponsesSharedPaths` | item/content 生命周期、reasoning、工具参数增量 |
| Responses → Chat JSON/SSE 返回 | `ResponsesToChatCompletions`、`ResponsesEventToChatChunks`、`FinalizeResponsesChatStream`，`responses_to_chatcompletions.go` | `streaming_stop_reason_test.go`：`TestResponsesToChatCompletions_ContentFilter`、`TestResponsesToChatCompletionsStreaming_ContentFilter` | 过滤与长度等结束原因、终态 usage 和 Chat 结束标记 |
| Messages → Responses JSON/SSE 返回 | `AnthropicToResponsesResponse`、`AnthropicEventToResponsesEvents`、`FinalizeAnthropicResponsesStream`，`anthropic_to_responses_response.go` | `anthropic_to_responses_stream_test.go`：`TestAnthropicEventToResponses_ItemLifecycleIsBalanced`；`streaming_stop_reason_test.go`：`TestAnthropicStreamingMaxTokens_MapsToIncomplete` | block/item 索引、完整 output、截断不能伪装成功 |
| Responses → Messages JSON/SSE 返回 | `ResponsesToAnthropic`、`ResponsesEventToAnthropicEvents`、`FinalizeResponsesAnthropicStream`，`responses_to_anthropic.go` | `anthropic_responses_test.go`：`TestStreamingCachedTokensUseAnthropicInputSemantics`；`responses_to_anthropic_parallel_tool_test.go`：`TestStreamingParallelToolUseNoGhostDelta` | 缓存 token 语义、并行工具、结束事件 |
| 共享类型与 wire | `types.go`、`responses_stream_event_wire.go`、`response_format.go` | `responses_stream_event_wire_test.go`：`TestWire_IndexFieldsPresentAtZero`、`TestWire_ArgumentsDonePresentEvenEmpty` | 零索引和空参数不能被错误省略；共享类型不可访问绑定或密钥 |

**已知来源缺口：** 该模块直接桥接文件只提供 Messages 请求到 Chat 及其反向返回；没有据此证明 Chat 请求到 Messages 及其反向返回存在完整直接实现。未来该方向须自行实现并测试，可参考 Chat↔Responses、Messages↔Responses 的语义，不能将两次流转换冒充已验证的直接实现。同协议三格、网络 SSE 分帧/UTF-8/背压/取消、HTTP 错误处理、用户归属和计费幂等也不能由这些模块测试推出。

**需要明确的兼容差异：** 上游测试包含 server tool 丢弃、无效历史工具调用丢弃、reasoning-only 合成可见文本等既有行为。新工程须遵守协议方案的显式拒绝/能力路由及不将私有思考变成普通文本的规则；不能机械复制这些期望。缓存用量保持原上游语义供一次结算使用，不因返回格式转换重复计费。

## Fixture 来源与以后移植登记

模块目录中有三个外置 fixture，均由 `chatcompletions_reasoning_alias_test.go` 的 `readIssue5302Fixture` 使用；其余选定测试多在 Go 中构造输入和断言，不能将测试文件误列成现成 JSON fixture 包。

| 外置 fixture（位于 testdata/issue5302） | 消费测试 | 语义 |
| --- | --- | --- |
| `nonstream_reasoning.json` | `TestChatReasoningAlias_AnthropicNonStreaming`、`TestChatReasoningAlias_ResponsesSharedPaths` | reasoning 别名用于普通返回 |
| `stream_reasoning.json` | `TestChatReasoningAlias_AnthropicStreaming`、`TestChatReasoningAlias_ResponsesSharedPaths` | reasoning 别名用于流增量 |
| `reasoning_content_precedence.json` | `TestChatReasoningAlias_ReasoningContentTakesPrecedence` | reasoning_content 优先 |

本任务不将这三个样例声明为真实供应商录制数据。未来复制或翻译源码、Go 内嵌输入/期望或外置 fixture 时，逐项登记：本地路径、来源 commit/文件/blob、测试函数、改动与日期、许可声明、合成/上游派生/真实录制类别和执行结果。自编 fixtures 也需明确为合成数据。录制样例必须去除 Authorization、API Key、Cookie、个人内容和供应商秘密；不能依赖只清除某一个字段。

未来验证须覆盖九格十八条普通/SSE 路径，再补工具多轮、图片、错误、截断、缺失 usage、UTF-8 任意切分、取消和能力拒绝。每条分别记录“未实现、静态核对、mock 通过、远程 Workers 通过、真实供应商通过”，不将本清单当作已通过报告。

## 固定文件清单

下表 blob SHA 来自固定提交目录树，并与实际下载字节核对。测试文件清单用于后续逐项选择，未声称逐条审计所有测试断言。

| 文件（固定 GitHub 链接） | Git blob SHA-1 |
| --- | --- |
| [LICENSE](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/LICENSE) | `153d416dc8d2d60076698ec3cbfce34d91436a03` |
| [anthropic_responses_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/anthropic_responses_test.go) | `539ccda0d7e841464e8baf6ad2528609226bd727` |
| [anthropic_to_responses.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/anthropic_to_responses.go) | `dfbe7b5e0523373a613976d64739ecd5ac57b3c3` |
| [anthropic_to_responses_response.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/anthropic_to_responses_response.go) | `43542dfaaf34ccf4de2da43a56e5802d8d42d3e3` |
| [anthropic_to_responses_stream_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/anthropic_to_responses_stream_test.go) | `e21f4175ef90fbf819ebb26d2e5b04ac9ceaa3f0` |
| [chatcompletions_anthropic_bridge.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_anthropic_bridge.go) | `47d4601c24d2213fe2cb2a646a89f7aa0e5b5cdd` |
| [chatcompletions_anthropic_bridge_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_anthropic_bridge_test.go) | `8ebd5092fa5e03a1ff1a575dd0d1b6da75fc7fb5` |
| [chatcompletions_anthropic_reasoning_passback_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_anthropic_reasoning_passback_test.go) | `007a5face60dfea08f8cf8da7fc68dfe7bc173df` |
| [chatcompletions_reasoning_alias_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_reasoning_alias_test.go) | `69d633f0a9275e39d46c757769a56d698d9dc083` |
| [chatcompletions_responses_bridge.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go) | `e9f7ff03540047747e98670b5f8a875947afead6` |
| [chatcompletions_responses_bridge_custom_tools_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_bridge_custom_tools_test.go) | `bd5672954520a7a8368e9f5db483715d6913f269` |
| [chatcompletions_responses_bridge_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_bridge_test.go) | `6060d0216680c2f1860ae1526074b41bc2805a6b` |
| [chatcompletions_responses_reasoning_cache_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_reasoning_cache_test.go) | `dacedfc61d40267bdf280eefbb29af8dad08ecef` |
| [chatcompletions_responses_request_invariants_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_request_invariants_test.go) | `e54a453279d0c5dd3e6cdbdd94d8c5de3aceac06` |
| [chatcompletions_responses_stream_lifecycle_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_stream_lifecycle_test.go) | `1a986b60d9d7a3de543a8b04fbe5cfe522fc9989` |
| [chatcompletions_responses_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_test.go) | `a57bd73f91776b38b153965d21bd75d7c84aad23` |
| [chatcompletions_responses_tool_output_media_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_responses_tool_output_media_test.go) | `46c9c8b4cdc4ad0bf4496ad1a8da490e44edb71a` |
| [chatcompletions_to_responses.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_to_responses.go) | `f72b5faf6d4c5584e276637366d128376f7d9c87` |
| [chatcompletions_x_search_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/chatcompletions_x_search_test.go) | `79230edecd1b91c48a99db9a0ae485e0f951c756` |
| [response_format.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/response_format.go) | `afb5c3e2fd655b2aac7aae840a735791947f433b` |
| [responses_anthropic_cache_creation_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_anthropic_cache_creation_test.go) | `aa5ecbe5baf14c31b840c5c0c65623b7872e7b65` |
| [responses_client_tools.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_client_tools.go) | `c5377610628534a9d322a79cb24741e92c18171a` |
| [responses_client_tools_item_id_helper_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_client_tools_item_id_helper_test.go) | `66448ed661bff9842b396f1a6b068dab67307901` |
| [responses_client_tools_item_id_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_client_tools_item_id_test.go) | `724f77b75dc3307ac0739ac2df1924d50916b22f` |
| [responses_client_tools_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_client_tools_test.go) | `dd8bb74fea496af9856e80e8def93e06ff53d29e` |
| [responses_created_at_wire_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_created_at_wire_test.go) | `57f4b2866e2c1d95463db6787bf5f733661b4739` |
| [responses_namespace.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_namespace.go) | `a5549760c5bb873b2465aad0cad43f54fc232d28` |
| [responses_namespace_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_namespace_test.go) | `4c8e313c5d07a47c90af40e0d9068c968d95b013` |
| [responses_stream_event_wire.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_stream_event_wire.go) | `c2ebcd3eeee3347c0928a7f7a09a7f1803b3267e` |
| [responses_stream_event_wire_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_stream_event_wire_test.go) | `fb138a14695e1824d6beda8f78f7e27deb14c545` |
| [responses_to_anthropic.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic.go) | `129fff08d52225f1c358cefa1f117de4f571d823` |
| [responses_to_anthropic_cc_chain_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_cc_chain_test.go) | `d64680f4fac711472801f4939286d063030ec3fa` |
| [responses_to_anthropic_instructions_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_instructions_test.go) | `b63787cd44edc35a4894d9480956baa73afde91e` |
| [responses_to_anthropic_invalid_blocks_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_invalid_blocks_test.go) | `ed410f68519a5af7a878355c6d7d8f9efc9efa27` |
| [responses_to_anthropic_parallel_tool_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_parallel_tool_test.go) | `c3171adbfa162dd6d18209c54105b5689dc2b6c1` |
| [responses_to_anthropic_read_tool_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_read_tool_test.go) | `0fc45b7249d1885cc8cfe6ec542fa386e69b7258` |
| [responses_to_anthropic_request.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_request.go) | `51ffe8baafa3c54e9d50614b2370e5f531995085` |
| [responses_to_anthropic_tool_pairing_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_tool_pairing_test.go) | `42dd2d0cc574b7c043ec5958cf239d5a8d50ed5b` |
| [responses_to_anthropic_tools_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_anthropic_tools_test.go) | `54873b547ea70cf7f7121ba63e8e5c51fb4355e5` |
| [responses_to_chatcompletions.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_chatcompletions.go) | `d288b31bea08823de678bca8f743bef6422e7463` |
| [responses_to_chatcompletions_codex_events_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_chatcompletions_codex_events_test.go) | `c792be13b500147ae72748f160f07d0f1629352a` |
| [responses_to_chatcompletions_tool_name_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_to_chatcompletions_tool_name_test.go) | `c30ca9738922288adbf56f0f9ef31bcb87c5ae17` |
| [responses_tool_search_discoveries.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/responses_tool_search_discoveries.go) | `55298c0eef29213c527c1d64a4bc9a8fcc2503f0` |
| [service_tier_passthrough_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/service_tier_passthrough_test.go) | `6c8dd0205c888929ab5acfa4b34e00dac953ddfe` |
| [streaming_stop_reason_test.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/streaming_stop_reason_test.go) | `7147e901051c5bf657ce9f0149b620add41f6bfd` |
| [testdata/issue5302/nonstream_reasoning.json](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/testdata/issue5302/nonstream_reasoning.json) | `e31e463b28b3284058e93482a57ce7407f2ee4c8` |
| [testdata/issue5302/reasoning_content_precedence.json](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/testdata/issue5302/reasoning_content_precedence.json) | `5040d46f2cf0ed620c8778e09cde0f2467d4d00b` |
| [testdata/issue5302/stream_reasoning.json](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/testdata/issue5302/stream_reasoning.json) | `66c4e8ae7be2ac18aa13da3488a4b024971b1329` |
| [types.go](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat/types.go) | `3a9d0a8ff2d62672fb4f1e86cd5c06535e6d4a97` |
