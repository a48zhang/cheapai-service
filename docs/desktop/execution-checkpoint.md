# Desktop 全计划执行检查点

## 依赖恢复追加检查点（2026-10-04）

已在最新并发分支 `dbf9dcd` 上生成真实 pnpm/Cargo 锁；F05/N09 的网络/工具链阻塞解除。frozen + strict peers 安装、云端/桌面类型及 JS 构建通过；Node 50 文件/1782 用例通过。原生应用尚未启动：实际 Runtime bootstrap 暴露固定 DSH `/client` 发布物为 ModuleLoader 插件、并非 ESM named exports；本机 Cargo check 缺 gobject/GTK/WebKit。完整测试首次 3843/3844 通过，唯一旧统计字段断言已同步，CI 终态见后续记录。

本轮未新增测试、保留供应链保护；保留并发任务新增的自动安装包 workflow。详情见[依赖恢复证据](evidence/dependency-recovery.md)。以下原交接记录为恢复前历史状态，不代表最新安装结论。

更新：2026-10-04 UTC。按用户要求持续推进全计划，复用六个 `gpt-6-luna` / `max` 子代理，未在中间批次停止。所有可在本环境完成的实现、接线、测试作者和文档已交接；状态和实际证据随分支保存。

79 项：**70 completed、F05 blocked_network、N09 blocked_tooling、5 partial validation、2 blocked_target validation**。completed 仅表示产物完成，不能理解为对应端到端已通过。七份验证报告均已写出；外部阻塞保留，未伪造锁文件或安装包。

## 最终源码范围

- Tauri 私有 Runtime/DSH carrier、generation/request/stream 校验、凭据库、目录与固定网站入口、显式重启、关窗/Quit 确认、有界进程树与更新收尾。
- 官方 DSH Connection/Gateway、SessionEventStream/AssistantStreamAccumulator 和消息基础组件；自有蓝白对话、会话侧栏、发送/停止、工具等待交互与项目目录。
- 原生保存 Token 后 restore，稳定 userId home，private managed Key resolver、自然到期缓存/single-flight；默认生产登录优先，静态 Key 只允许显式开发模式。
- 登录、账号/真实余额、分类错误、草稿保留、账号变化清投影；默认模型/目录实际读写和生效，已有会话不覆盖默认。
- 标准 updater、手动构建工作流、完整固定许可文本、Runtime closure 与发行清单脚本、使用/架构/发行说明。

自然 Token 失效拒绝新 Key 并清除敏感缓存，保留已开始流；失效后保留的旧绑定仅在有效 replacement restore 验证后替换。不会隐式重放任务或提前轮换 Key。Token90天、独立Key30天且不超过Token截止规则未改。

## 集中检查

- 原云端三包及 contracts 类型通过，原云端构建与 Worker dry-run通过，contracts构建通过。直接 pnpm run 因旧安装图与新workspace配置不匹配而拒绝，后续采用已安装真实bin检查；未关闭guard。
- 全部 Node：49文件、1776用例通过；1对话suite缺dsh-llm无法加载。新增/修复后最终只复验受影响桌面4文件，21/21通过；数字有重叠。
- 桌面相关58个TS源码语法与相对import检查、7个mjs node --check通过。
- Runtime完整类型仍缺DSH/ws及派生诊断；React缺固定vite/client。集中暴露的独立源码类型错误已修复再检查。完整桌面构建未通过验收。
- Workers执行器listen EPERM，未成功执行用例或证明0024迁移已应用。本轮没有Rust/Cargo、Bun或macOS/Windows，原生测试、真实DSH/模型、IPC、安装/更新和历史恢复未运行。

## 具体外部阻塞

1. **F05**：Shell代理拒绝连接、直接DNS不可用，缺registry元数据/新依赖，不能生成真实pnpm importer/锁或完成frozen安装。只链接实际本地contracts和已安装精确Node类型，未注入假包。
2. **N09**：开发/打包脚本完成，Cargo.lock需要真实cargo与依赖解析，当前无工具及网络。没有伪造Cargo.lock或可发布资源。
3. **补验环境**：恢复网络/锁/依赖、可用Workers本地端口、macOS/Windows机器、真实隔离测试账号与已授权模型预算后，按证据补完整链。Bun仍是比较候选。updater未配置可信endpoint/pubkey，明确unavailable；签名/公证/公开发行未执行。

现有网络Git调用不可用，保存采用GitHub连接器并校验blob/tree/commit和远端ref；不逐子任务推送。没有PR、生产迁移、部署或公开发布。

[任务图](task-graph.json) · [Runtime](evidence/runtime.md) · [对话](evidence/conversation.md) · [后端](evidence/backend-account.md) · [登录到模型](evidence/account-e2e.md) · [macOS](evidence/native-macos.md) · [Windows](evidence/native-windows.md) · [候选发行](evidence/release.md)
