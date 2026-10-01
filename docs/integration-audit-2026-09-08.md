# 本地实现与集成回归（2026-09-08）

本轮继续执行原计划，补齐九方向 HTTP 集成测试，并修复集成中发现的问题。最新逐文件回归结果：**178 个文件、3788 项用例全部通过**；真实本地浏览器套件 **9/9** 通过；workspace 类型检查与构建通过。

## 证据口径

这是按测试文件合并的回归记录，不是一次全绿的全量命令：首次全量为 169 文件、3707 项，3705 通过、2 失败；唯一失败文件是原生 HTTP 测试的渠道选择 fixture。修正后，对整个网关及新增矩阵复测 415/415，再对最终九方向矩阵复测 81/81。后一次相同文件的结果替换前一次结果，没有累加重复用例。详细时间、命令阶段及源哈希见 [结构化结果](integration-audit-2026-09-08.json)。

网关复测前后生产代码（apps/packages/migrations，排除 dist、node_modules、.wrangler）保持一致：`49edebaa0a9a33af84d11dcc3ea4df7a4634a360a73a95f1882e1e82c9f25c56`，共 225 个文件。新增补充用例只修改测试与 fixture。

## 本轮完成内容

- 九种 Chat / Responses / Messages 上下游组合通过真实 Worker `app.fetch`、D1、DO 执行，验证 JSON/SSE、文本多轮、单个及并行工具、工具 ID/参数/结果续接、错误脱敏、原始用量、单次扣账和租约清理。
- 本地请求转换在发往上游前失败时，JSON 与 SSE 均返回 400 并标记 `not_chargeable`；配置/数据库失败与已派发的不确定请求仍分别处理。不会把根本未派发的请求记成用量未知。
- 原生路由测试改用协议独立模型和渠道，消除共享模型多候选造成的测试不确定性。管理浏览器测试采用端口专属连接文件。
- [注册浏览器证据](evidence/auth-workflow.md)、[管理操作证据](evidence/admin-workflow.md)、[注册到计费完整链路](evidence/full-workflow.md)覆盖真实本地业务。统一浏览器运行 9/9：余额可扣至负数，后续请求被拦截，充值后恢复；最终余额与追加账单合计一致。

## 复现与边界

使用工程锁定的 Node 24.19.0 / pnpm 11.19.0。工程根目录运行 `pnpm run typecheck`、`pnpm run test`、`pnpm run build`；矩阵可单独运行 `pnpm exec vitest run --project workers tests/gateway/matrix`，浏览器运行 `pnpm exec playwright test`。

所有上游和邮件都使用本地替身，不访问真实供应商、发送真实邮件或修改远程 Cloudflare 资源。此前用户后置的云端、真实供应商/SDK、邮件、负载、恢复/轮换演练和最终验收仍保留在 [任务清单](implementation-plan.md)，不把本地通过当成这些验收完成。2026-09-06 的旧审计文件仅作为历史记录。
