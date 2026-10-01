# 当前依据与限制

核对日期：2026-09-05。

## 现有四个 Worker

| Worker | 从部署代码与绑定中确认的内容 |
| --- | --- |
| sub2api-pages | 内嵌前端资源；无绑定 |
| sub2api-api | 用户、Key、OAuth 登录与支付等路由；D1、KV、JWT Secret |
| sub2api-admin | 账号、渠道、分组、用户及运营路由；D1、KV、JWT Secret |
| sub2api-proxy | 多种模型路由；D1、KV、Usage Queue；ConcurrencyLimiter、SessionSticky、AccountHealth DO |

仅证明代码和绑定存在，不代表全部功能正确或与原版等价。四份部署 JS 已在本次任务中另行备份，新工程不包含凭据或线上数据库。

静态检查发现：三个 DO 的相关状态存于实例内存；网关并发释放在处理函数返回后的 finally 执行且未等待；余额准入读取 KV 缓存。这些是重设计和测试的依据，不是完整审计结论。

后续用户已明确允许少量透支。新方案允许将余额快照用于 KV 软卡口，并保留 D1 真实账单与幂等扣费；旧实现使用余额缓存本身不再被视为设计错误，关键是时效、回源和正式计费是否正确。下方 Queues 资料保留为历史参考，一期简化方案不接入 Queues。

进一步核对了 Sub2API 固定提交的余额资格检查、usage_billing_repo、Redis billing_cache、扣后缓存更新与负余额回归测试。普通余额路径明确允许透支并返回 BalanceOverdrafted；详细位置和与 Cloudflare KV 的差异记录在 [计费方案](billing-cache.md)。这属于源码阅读结论，没有运行上游 Go 测试，也没有修改旧 Worker。

本机原版源码目录不完整：找到 go.mod 和部分源文件，但没有完整前端及预期的服务目录。实施必须重新取得固定上游版本。

## 官方参考资料

- [Sub2API 原项目及技术栈](https://github.com/Wei-Shaw/sub2api)
- [Workers 运行限制与 HTTP 流生命周期](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 存储和吞吐限制](https://developers.cloudflare.com/d1/platform/limits/)
- [Durable Objects 持久化存储](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Queues 至少一次投递](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Workers TCP 能力边界](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

平台限制会变化；实施和容量评估时重新核对。新工程一期上游与下游均支持 Chat Completions、Responses、Messages，接入方式为 Base URL/API Key，不继承旧实现的上游 OAuth 范围。尚未完成新方案具体上游的 Cloudflare 实测，也未取得新工程的生产容量数据。

协议参考提交：`ab99d56e9626e6cd731592dae8553c9758a0efa2`。已查看 `backend/internal/pkg/apicompat/` 下的 `chatcompletions_anthropic_bridge.go`、`responses_to_anthropic.go`、`anthropic_to_responses.go` 和 `streaming_stop_reason_test.go`。前者明确使用 Messages 与 Chat Completions 直连转换以避免串联 Responses 状态机；其他文件显示直接转换可保留更多 thinking、cache_control 和结构化 system 语义。这里只完成初步源码阅读，未完成整个模块审计、代码移植或回归测试。
