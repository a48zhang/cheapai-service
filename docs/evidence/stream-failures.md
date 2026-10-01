# Q09 流生命周期故障注入

核对日期：2026-09-08。此证据覆盖本地 Worker 流生命周期与故障注入，不代表 Cloudflare 生产终止语义或真实供应商行为。

## 执行范围

`tests/gateway/stream-failures.test.ts` 通过主 `app.fetch` 调用 `/v1/chat/completions`，使用 Workers Vitest pool 的真实本地 D1、真实 Gate Durable Object 和 mock upstream SSE。测试没有部署 Worker、访问外部模型或发送邮件。

执行命令：

```powershell
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/gateway/stream-failures.test.ts --reporter=verbose
```

结果：1 个测试文件、4/4 通过。Wrangler 日志目录权限和父目录静态分析提示是本地沙箱已知告警。

## 已验证行为

- 慢读场景在响应头返回后不会预取 upstream；首次下游读取才推动一个上游 chunk。完整消费后 request 为 `succeeded/settled`，usage 为 input `2`、output `3`，消费账单为 `800` units，user/channel 租约均释放。
- Abort 场景在客户端尚未读取内容时模拟终止窗口。AbortSignal 同时传到 upstream，upstream 收到取消，request 标记为 `cancelled`，缺少 usage 时不产生消费账单，两个 Gate 租约均释放。
- upstream 只发送 partial 文本后 EOF，响应保留已收到的文本但没有 `[DONE]`；request 进入 `succeeded/usage_unknown`，usage quality 为 `missing`、cost 为 `NULL`，没有消费账单，租约释放。
- upstream 输出完整 usage 后模拟 D1 settlement batch 故障。request 仍可查询为 `succeeded/settlement_pending`，usage quality 为 `complete`、cost 为 `800`，没有账单写入；已知证据可留给后续恢复，user/channel 租约仍释放。

## 限制

测试中的 D1 故障是只阻断结算 batch 的本地替身，其他读取和恢复写入仍由真实 D1 执行；Abort 代表请求终止窗口的可控模拟。没有据此声称真实 Worker 进程被平台强制终止时具有额外投递保证。
