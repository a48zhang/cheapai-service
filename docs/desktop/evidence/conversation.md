# 对话页面集中验证

日期：2026-10-04 UTC，Linux x64。状态：**partial**。

U03–U11/N08 的官方 Connection/Gateway、native decoded carrier、SessionEventStream、消息投影、工具交互、发送/停止、目录选择和整页接线已交接。默认设置已连接真实 catalog/目录，默认模型仅用于新 Session；失败后保留真实已创建 Session 和草稿。它们是源码产物，尚无真实浏览器/DSH UI 验收。

| 检查 | 结果 |
| --- | --- |
| 前端类型 | `./node_modules/.bin/tsc --project apps/desktop/tsconfig.json --noEmit` 退出 2，缺少固定 Vite 的 `vite/client` 类型；尚未检查完整源码类型。 |
| 前端构建/浏览器 | 未运行，React/Vite/Tauri/DSH 新依赖未安装，pnpm frozen graph 尚未生成。 |
| UT01 conversation-events | 同一次 Node 集中调用中无法导入 dsh-llm/assistant-stream，0 用例执行；未用替代 reducer 或假包冒充。 |
| 全局活动监控 | 最终受影响四文件共 21 用例通过；monitor 包含旧代次迟到结果/事件/错误、断连不报零、未成功 baseline 不报告全局任务数、刷新等待恢复行为。 |
| TypeScript 语法 | 桌面相关 58 文件 parser 与相对 import 存在性检查通过，不能代替完整类型。 |

Native call 对关联 generation/requestId 校验后取内层 ConnectionRpcResult；stream 携带 generation/streamId/sequence。Controller 和投影的迟到响应隔离已写入；真实 native transport、消息重连、历史页、持续回答与原生交互未验证。固定上游没有 Session delete，明确 unsupported。

| 文件 | Git blob |
| --- | --- |
| `apps/desktop/src/adapters/native/runtime.ts` | `f19a18ba26d1c1fb14d41fead01a86f1b5df0909` |
| `apps/desktop/src/components/layout/AppShell.tsx` | `7938c19ac4d33edc50c769a217faca82ccc7e55f` |
| `apps/desktop/src/features/conversations/session-monitor.ts` | `652377aba94a49a31344c690f5c3ebbd821a4a67` |
| `apps/desktop/src/features/conversations/event-projection.ts` | `defa72adbadd7554e5eaf8b139e61a93c0a39213` |
| `apps/desktop/src/features/conversations/message-store.ts` | `45211b545192b613917d5a5ef76a545db40e03b0` |
| `tests/desktop/conversation-events.node.test.ts` | `9326e789324e985303345c3da5f014510138b876` |
