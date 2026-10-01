# Q06：Gate Durable Object 重启、补偿、续租与过期回收

## 可复现实验

测试文件是 [`tests/limits/lifecycle-integration.test.ts`](../../tests/limits/lifecycle-integration.test.ts)。它使用本地原生 D1、Gate Durable Object 和 `evictDurableObject`，建立一个共享 `q06-user`、两个 API Key、一个 `q06-channel`、一个 chat model/mapping；没有把核心 D1 admission 或 DO 状态转换替换为 mock。

执行命令：

```text
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/limits/lifecycle-integration.test.ts --project workers --reporter verbose
```

结果：1 个 test file、4 个 test 全部通过。`pnpm run typecheck` 的 `apps/web`、`packages/apicompat`、`apps/worker` 也全部通过。

## 证据一：跨 Key 的共享用户限额

测试 [`lifecycle-integration.test.ts:120`](../../tests/limits/lifecycle-integration.test.ts:120) 先用 Key A 经过真实 G03 admission；`q06-user` 的活动 user lease 和 channel lease 各为 1（`121-125`）。Key B 使用同一 user、同一 channel 再 admission 时得到 `rate_limited`，而 D1 request 仍只有一条、原有两个 lease 没被误删（`126-131`）。释放第一条 permit 后两个 subject 都归零，再用 Key B 成功 admission，request 总数为 2（`132-138`）。这直接验证 Key ID 没有被当作 user quota subject。

## 证据二：真实 DO 重建后的 L10 续租和幂等释放

测试 [`lifecycle-integration.test.ts:141`](../../tests/limits/lifecycle-integration.test.ts:141) 通过实际 `acquireDualLease` 获得两个 Gate lease，启动 L10 lifecycle（`142-147`）。在续租计时器触发前分别 `evictDurableObject` user/channel stub（`149-150`），时间推进 30 秒后仍由原 permit 的 client 对重建后的 DO 续租成功（`151-156`）；两个 SQLite-backed lease 的 expiry 都更新到 `now + 90000`。并发调用两次 `lifecycle.close()` 返回同一个 cleanup Promise、cleanup complete，且 timer 与两个 DO lease 都归零（`157-162`）。

生产状态依据是 [`apps/worker/limits/storage.ts:36-71`](../../apps/worker/limits/storage.ts:36) 每次事务从 DO SQLite storage 恢复并 prune；[`apps/worker/limits/gate.ts:94-152`](../../apps/worker/limits/gate.ts:94) 在同一 DO 事务处理 lease/报警；L10 的两侧续租、失败停止和一次性 release 见 [`apps/worker/limits/lease-lifecycle.ts:144-180`](../../apps/worker/limits/lease-lifecycle.ts:144)。

## 证据三：channel 获取响应丢失后的实际补偿

测试 [`lifecycle-integration.test.ts:165`](../../tests/limits/lifecycle-integration.test.ts:165) 的 binding wrapper 仍调用真实 channel DO 的 `acquire`，只在第一次拿到成功结果后释放 RPC 结果并抛出合成传输错误（`61-90`）。`acquireDualLease` 因此把 channel 阶段标为 `acquire_error`，用同一个 request ID 恢复并释放可能已经提交的 channel lease，再反向释放 user lease；结果 cleanup complete，两个真实 DO 的活动 lease 都为零（`166-170`）。这覆盖“第二个 subject 获取失败/回复不确定”时不能遗留 user slot 的路径。

该补偿路径的实现依据是 [`apps/worker/limits/dual-lease.ts:137-181`](../../apps/worker/limits/dual-lease.ts:137)：先获取 user、再获取 channel，失败时按反向顺序 cleanup；无 handle 时用原 request ID 恢复，不把 transport failure 当成“肯定没有提交”。

## 证据四：失联续租取消和过期回收

测试 [`lifecycle-integration.test.ts:172`](../../tests/limits/lifecycle-integration.test.ts:172) 先取得真实双 lease 并启动 L10，然后直接通过真实 channel client 释放 channel lease（`173-181`），模拟 DO 侧 lease 已消失。下一次 renewal 收到 `missing`，lifecycle 进入 `renewal_failed`，cleanup complete，user/channel 都归零（`182-186`）。

同一测试随后用真实 user DO 获取 1 秒 lease，先驱逐 DO，再把时间推进到 expiry 边界；新的 request 获取会在 DO storage 恢复时 prune 过期项并成功占用唯一 slot（`188-195`），最后释放并确认归零（`196-198`）。`LeaseStorage` 的“恢复后先验证、再 prune”逻辑见 [`apps/worker/limits/storage.ts:27-47`](../../apps/worker/limits/storage.ts:27)，所以过期回收没有依赖进程内缓存。

## 可证明结论与限制

本批次可以证明：在当前代码和本地 Workers runtime 中，同一用户的多个 API Key 共享真实 user DO 限额；user/channel 双 lease 在 DO wrapper 重建后可由 L10 续租；channel 获取回复丢失时会以原 request ID 补偿并释放 user；channel lease 失联会停止 lifecycle、释放另一侧；DO 重建后的新请求会回收已过期 lease。

本批次不能证明 Cloudflare 生产 DO 的跨区域故障恢复、真实网络分区、生产容量、报警调度延迟或上游可用性。`evictDurableObject` 是本地 runtime 的重建控制，丢回复由测试 wrapper 注入，时钟由测试推进；因此文档不作生产容量或真实故障率声明。
