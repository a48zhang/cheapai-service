# Runtime 集中验证：部分结果

日期：2026-10-04，Linux x64，Node 24.19.0，Vitest 4.1.11。

状态：**partial**。仅生命周期纯 Node 模块已验证；完整 Runtime/DSH、Bun 与原生打包仍未验证。

命令：`./node_modules/.bin/vitest run --project node tests/desktop/runtime-lifecycle.node.test.ts`。使用工作区内 XDG_CONFIG_HOME/WRANGLER_LOG_PATH；fake host、注入 HTTP、临时 home/workspace，没有实际端口绑定、模型调用或个人目录访问。

首轮：4 项中 2 通过、2 失败。失败是测试在真实计时器下调用 `vi.getTimerCount()`，不是进程状态断言失败。集中修正为全部用例注入 fake timeout timers 后，只重跑受影响单文件，**4/4 通过，退出 0**。

已覆盖：Host 握手超时后迟到响应、ready 前真实模拟退出码、重复 stop 的共享清理、restart 后旧 Host 回调隔离；检查关闭 child 的定时器与 listener 清理。静态审查同期修正了 per-run listener 释放和迟到代际保护；移除 stdout 解析后仍保持排空，防止子进程日志阻塞。

结果对应的 Git blob 指纹（避免把后续接线当成本次已验范围）：

| 文件 | Blob |
| --- | --- |
| `apps/desktop-runtime/src/dsh/lifecycle.ts` | `645664f830f014453fe0c292cd2f0a10b1cbac69` |
| `apps/desktop-runtime/src/dsh/connection-info.ts` | `72cdb6edcf719d01efa571359956d213c2224d2a` |
| `tests/desktop/runtime-lifecycle.node.test.ts` | `ba035cd347b01e1bd72aa73dcccd8b095ee72115` |
| `tests/desktop/helpers/fake-host.ts` | `10c885a60314d487bc792cc951cc4f1c7ef476ef` |

本批交接后执行 `./node_modules/.bin/tsc --project apps/desktop-runtime/tsconfig.json --noEmit`，退出 2，入口即报 TS2688：缺少 `node` 类型定义。此结果未检查到全部源码，不能认定新 transport/provider 的类型成立。F05 的新依赖和 workspace 链接尚未安装；未放宽策略或手工伪造依赖。

尚未运行：Runtime 构建、真实 DSH profile 启动和持久化、动态 Key provider、native decoded RPC、Node/Bun 同任务比较。新依赖与锁文件尚待 F05，普通网络受限；Rust/Bun 和目标 macOS/Windows 不可用。后续仅在相关实现或环境变化后补验，不能用这四项测试宣称完整模型链通过。
