# Q05：KV 故障、陈旧回填与最终权限/账单

## 可复现实验

测试文件是 [`tests/cache/failure-matrix.test.ts`](../../tests/cache/failure-matrix.test.ts)。它在 Workers Vitest 项目中使用本地原生 D1、KV 和 Gate Durable Object，建立 `q05-group`、`q05-user`、`q05-key`、`q05-channel`、`q05-model` 及 chat mapping；请求经过 `admitRequest`，账单经过 `settleRequest`，没有替换 G03、D1 或 Gate 的核心实现。

执行命令：

```text
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/cache/failure-matrix.test.ts --project workers --reporter verbose
```

结果：1 个 test file、2 个 test 全部通过。随后 `pnpm run typecheck` 的 `apps/web`、`packages/apicompat`、`apps/worker` 也全部通过。

## 证据一：乱序旧值和负余额缓存

测试 [`failure-matrix.test.ts:65`](../../tests/cache/failure-matrix.test.ts:65) 先从 D1 生成 v1 路由和价格快照（`66-70`），把 D1 的 group、channel、mapping 和 model 版本推进到 v2（`72-76`），再让 v2 快照先回填 KV（`81-83`）。随后把带有 `observed_at = now - 1` 的 v1 快照写回同一个 KV key（`86-89`），实际读到的是旧 v1 cache 值（`90-93`）。这复现了较慢的旧回填在较新的写入之后覆盖 KV 的顺序；旧时间戳没有被刷新。

测试再写入 `balance_units = -1` 的有效负缓存（`97-98`）。`readBalance` 返回 D1、且余额仍为 `1000000`（`99-101`）。使用重新认证的 v2 D1 subject 调用真实 G03 admission（`103-107`）后，两个 Gate subject 都各有一个活动 lease（`106-107`）。`settleRequest` 使用 admission 时固定的 v2 价格快照，`100` 个 input 与 `50` 个 output 的结算成本为 `50000` units（`108-109`），释放后 D1 余额为 `950000`，request 和 billing ledger 各一条（`110-113`）。因此旧 route/price cache 和负 balance hint 都没有获得权限，也没有改变 B04 结算事实。

对应生产边界：

- [`apps/worker/cache/snapshot.ts:24-29`](../../apps/worker/cache/snapshot.ts:24) 保留原始 `observed_at`；[`60-76`](../../apps/worker/cache/snapshot.ts:60) 将 KV miss、异常和无效快照交给调用方处理；[`76-98`](../../apps/worker/cache/snapshot.ts:76) 明确回填 best effort、无 CAS/重试，旧回填可能覆盖新值。
- [`apps/worker/cache/balance.ts:37-40`](../../apps/worker/cache/balance.ts:37) 将缓存定义为 soft hint；[`61-83`](../../apps/worker/cache/balance.ts:61) 只接受新鲜且足额的缓存，否则重新读 D1。最终 B05 检查在 [`apps/worker/billing/admission.ts:33-77`](../../apps/worker/billing/admission.ts:33) 直接查询 D1。
- [`apps/worker/gateway/admit.ts:78-116`](../../apps/worker/gateway/admit.ts:78) 比较 D1 版本并在不匹配时至多刷新一次 route；[`123-158`](../../apps/worker/gateway/admit.ts:123) 将选定价格快照写入 request 后才提交注册。B04 的结算使用该已注册 request，见 [`apps/worker/billing/settlement.ts:38-65`](../../apps/worker/billing/settlement.ts:38)。

## 证据二：KV 读异常、429 回填、开关关闭和权限撤销

测试 [`failure-matrix.test.ts:116`](../../tests/cache/failure-matrix.test.ts:116) 用只在测试中注入的 KV binding：`get` 和 `put` 都抛出带 429 文本的错误，`delete` 也抛错（`117-121`）。先以 `balanceCacheEnabled: false` 读取一个负余额 cache，结果仍是 D1，且 disabled cache 的 `get`/`put` 都没有调用（`122-133`）。这证明关闭软缓存不会把缓存内容当成权限或余额结论。

随后把同一个 failing KV 传给真实 admission（`135-142`）。prices/routes 的权威 D1 读取和 Gate user/channel lease 成功完成，KV 异常只影响 best-effort 读写。B04 settlement 成功，成本为 `20000` units，D1 余额为 `980000`，request 和 ledger 各一条（`143-149`）。

测试再把 route 先写入真实本地 KV（`150-151`），将 group 在 D1 中禁用（`152`），并强制刷新 route。结果为 `null` 且 KV key 已删除（`153-154`）。使用原先 subject 的下一次 admission 在 B05 处得到 `unauthorized`，request/ledger 计数不变，两个 Gate lease 也保持为零（`155-161`）。因此 cache 失效和权限撤销没有制造新的发送权限或账单。

对应生产边界：

- [`apps/worker/cache/prices.ts:50-58`](../../apps/worker/cache/prices.ts:50) 和 [`71-88`](../../apps/worker/cache/prices.ts:71) 将价格 cache 作为配置提示；D1 model 读取和回填失败不会撤销权威读取。
- [`apps/worker/cache/routes.ts:68-86`](../../apps/worker/cache/routes.ts:68) 在 cache 命中后仍要求 G03 重查；[`92-117`](../../apps/worker/cache/routes.ts:92) 对 disabled group/model 尝试删除 route key，但删除本身是 best effort。
- [`apps/worker/cache/snapshot.ts:60-98`](../../apps/worker/cache/snapshot.ts:60) 捕获 KV get/put 异常并返回 miss/false；这不改变 D1 事务。`readBalance` 的 disabled 分支和 D1 fallback 见 [`apps/worker/cache/balance.ts:61-83`](../../apps/worker/cache/balance.ts:61)。

## 可证明结论与限制

本批次可以证明：在当前代码和本地 Workers runtime 中，负缓存、旧值乱序回填、KV 读取异常、模拟的 429 回填失败、关闭 balance cache，以及 D1 group 撤销，均不能绕过最终 D1 admission；成功 admission 的 B04 settlement 仍按 request 内不可变价格快照记账。

本批次不能证明 Cloudflare 生产 KV 的真实 429 比例、边缘传播延迟、跨区域一致性、D1/DO 生产容量或真实上游可用性。KV 429、读/删故障是测试 binding 注入的异常，外部网络在 Workers Vitest 配置中禁用；因此文档不作生产容量或生产故障率声明。
