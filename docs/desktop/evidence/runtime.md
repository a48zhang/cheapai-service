# Runtime 集中验证：部分通过

日期：2026-10-04 UTC。Linux x64，Node 24.19.0、pnpm 11.19.0、TypeScript 5.9.3、Vitest 4.1.11。候选提交的父提交为 `dc2617455036e22ad06c876e52aaef0ac71928f6`；精确测试范围以下述源码 blob 绑定。

状态：**partial**，没有完整 Runtime/DSH 或 Bun 兼容结论。

集中运行 `./node_modules/.bin/vitest run --project node`：49 文件、1776 用例通过；1 文件（conversation-events）因未安装 `@deepseek-ai/dsh-llm/assistant-stream` 无法加载，整体退出 1。后续新增失效/迟到回调/活动基线用例并修复类型错误，最终仅复验受影响四文件：

```sh
./node_modules/.bin/vitest run --project node tests/desktop/runtime-lifecycle.node.test.ts tests/desktop/account-lifecycle.node.test.ts tests/desktop/account-controller.node.test.ts tests/desktop/session-monitor.node.test.ts
```

最终 **4 文件、21 用例全部通过，退出 0**（05:23 UTC）。其中 Runtime fake-child 生命周期 4/4。资源为注入时钟、fake Host/API、临时 home，未绑定实际服务端口、未请求模型。两轮通过数有重叠，不能相加为独立用例总数。

Runtime 类型命令 `./node_modules/.bin/tsc --project apps/desktop-runtime/tsconfig.json --noEmit` 最终退出 2：缺 DSH/Cordis/credentials/Gateway/Connection/typert/ws 模块；同时有缺少基类类型产生的 override 诊断与缺少类型推断产生的 implicit-any 诊断。链接的是工作区内真实 contracts 和已安装的精确 @types/node 24.13.3，没有伪造依赖。集中检查曾发现独立的 callback return、Record 转换与 exactOptionalPropertyTypes 问题，已统一修复再复验；仍不能认定完整源码类型成立。Runtime 构建未执行，依赖与锁文件待 F05。

桌面相关 58 个 TypeScript 源码经过 TypeScript parser 和相对 import 存在性检查，退出 0；七个 scripts/desktop/*.mjs 经 `node --check`，全部退出 0。这是语法检查，不能代替类型、打包或兼容验收。共享 contracts 类型和构建均退出 0。

| 文件 | Git blob |
| --- | --- |
| `apps/desktop-runtime/src/dsh/lifecycle.ts` | `9200072b26b02c221a3bfa02184d6edc50dff78f` |
| `apps/desktop-runtime/src/cheapai/session-manager.ts` | `303941ea9bef2e5a1b3f40c7eeacbc4ccbcdc437` |
| `apps/desktop-runtime/src/cheapai/account-controller.ts` | `fd25183e9e1e8d5df7f67ed41fbea32b41f36557` |
| `tests/desktop/runtime-lifecycle.node.test.ts` | `ba035cd347b01e1bd72aa73dcccd8b095ee72115` |
| `tests/desktop/account-lifecycle.node.test.ts` | `acd53c6f6f224664849b8d0b077435b358540d71` |
| `tests/desktop/account-controller.node.test.ts` | `ae0104b0e5754be19172d9147f1143d2fe86a246` |
| `tests/desktop/session-monitor.node.test.ts` | `262e0bfeb3ed6bd8a909a2be9402f5d00f850d22` |

未运行：真实 DSH/profile/凭据 IPC、模型流/工具/持久化任务、Bun 对比、原生安装。Shell 代理拒绝连接且直接 DNS 不可用，无法完成新依赖安装和锁生成；没有 Rust/Bun 或目标 macOS/Windows。所有具体范围均保留为未验证。
