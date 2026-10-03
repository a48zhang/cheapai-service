# 验证证据索引与旧系统调研

## 2026-10-03 本轮状态

本轮实现仍在本地工作树，未推送或部署。当前状态与全部任务见[执行计划](implementation-plan.md)，剩余验证见[已知问题](known-issues.md)。

- 请求可靠性 B01–B07：Workers 170 项、Chat Node 10 项及额外启动回归 10 项局部回归通过，使用隔离存储/mock 上游
- 前端 FE-D01–FE-D11：Node 20 项、管理契约 7 项及 Web 类型检查/构建通过；Chromium socket EPERM 导致浏览器验收受阻
- 共享目录 A01–A07 与存储 S01–S02 已实现；AV01 38/38 通过，SV01 40/40 通过；本地 V-INTEGRATION 集中检查已完成
- 15 份文档已整合，V-DOC 已通过：141 个本地文档链接/锚点、路径与状态/命令引用核对；真实云、上游、邮件、容量、恢复、生产发布与 V-PROD 尚未执行

全包类型检查、Node 1859/1859（45 文件）、递归构建及 staging dry-run 通过；Workers 全量首轮为 2056 通过、1 失败（144 文件），失败为旧 lease-client 测试仍期待拒绝已支持的 operationId。仅更新 `tests/limits/client.test.ts` 后，受影响套件 28/28 通过，生产代码未变；最终唯一 Workers 用例数为 2058，未再整批重跑。 `git diff --check` 通过。详见[本地集成证据](evidence/release-local-2026-10.md)。staging dry-run 未部署，浏览器和全部远程验收仍待完成；后续发布记录须包含 Worker version/deployment ID、D1 水位与目标环境。

## 历史证据

- [基线 CI](https://github.com/a48zhang/sub2api-cloudflare/actions/runs/36874254293)：对应 `54d71d5` 的类型、Vitest 与构建，不含 Playwright 或部署
- [聊天交付](web-chat-delivery.md)：9 月 12 日本地验证和当次授权失败，保留原日期/数量
- [9 月 6 日审计](integration-audit-2026-09-06.md)、[9 月 8 日审计](integration-audit-2026-09-08.md)
- [staging 记录](evidence/staging-deploy.md)、[聊天证据](evidence/web-chat.json)：只证明各自记录的版本与环境

## 2026-09-05 旧系统调研

核对日期：2026-09-05。

> 本文调查的是重写前的四个 Worker 和当时的上游参考资料，不是当前 sub2api-cloudflare 的完整审计报告。以下“未完成”“本机源码不完整”等描述保留当时语境；现行功能、代码和验证入口见[仓库 README](../README.md)及[文档导航](README.md)。

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
