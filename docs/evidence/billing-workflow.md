# Q04 模拟消费计费闭环

核对日期：2026-09-08。此证据只覆盖 Q04 的本地模拟闭环，不代表真实供应商调用、邮件投递或云端验收。

## 执行范围

`tests/billing/workflow.test.ts` 使用 Workers Vitest pool 的本地真实 D1、真实 Gate Durable Object 和主 `app.fetch` 入口。上游由测试内的 `fetch` 替身响应，未访问外部模型；没有部署 Worker。

执行命令：

```powershell
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/billing/workflow.test.ts --reporter=verbose
```

结果：1 个测试文件、1/1 通过。Wrangler 的日志目录权限和静态导出分析告警仍是测试环境已知提示，不影响该 Workers pool 测试执行。

## 已验证行为

管理员通过真实 HTTP 路由给普通用户授额 `100000` units。mock Chat 上游返回 `1000` input tokens 和 `500` output tokens；模型价格为 input `1`、output `2` USD/百万 tokens，因此产生精确 `200000` units 消费。用户余额从 `100000` 变为 `-100000`，请求记录为 `succeeded/settled`，上游只收到一次调用。

余额为负后，第二次相同请求在准入阶段返回 native 402；没有新增 request 记录，也没有再次调用上游。管理员再授额 `300000` units 后余额为 `200000`，第三次调用完成并再次扣 `200000`，余额回到 `0`。

D1 最终包含两条 grant 和两条 consumption 账本记录，所有消费使用原子结算。测试同时读取用户和渠道 Gate DO 的 LeaseStorage，确认两者均无残留租约。

## 限制

本证据使用一个 native Chat 映射和 mock usage，只证明授额、准入、负余额、拒绝、充值恢复及本地租约/账本闭环；不证明真实上游兼容性或其他协议矩阵路径。
