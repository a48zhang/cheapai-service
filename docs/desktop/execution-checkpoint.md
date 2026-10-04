# Desktop 执行检查点

更新：2026-10-04。用户要求停止当前开发，将工作与计划提交并推送到 `feat/cheapai-desktop`，修改环境后继续。**本次不创建 PR，也不部署。**

## 恢复入口

- [详细计划](./implementation-plan.md)
- [任务图与当前状态](./task-graph.json)
- [固定 DSH 接入点](./dsh-integration.md)
- [版本与 Bun 发行校验值](../../scripts/desktop/runtime-versions.json)

`completed` 仅表示小任务实现产物已交接，**不表示验证通过**。`written_unreviewed` 表示文件已存在，但暂停时尚未核对完整交接。不要依据文件存在就把后续集成任务标为完成，多个任务会修改同一个文件。

## 已保存的工作

- F01–F04、F06：版本固定、contracts、Runtime/React 包和忽略规则。F05 已修改 workspace 与根命令，但锁文件尚未重新生成。
- R01–R06：DSH profile、Node/Bun CLI 启动器、生命周期和连接发现、provider/model catalog、私有 NDJSON 宿主控制以及 Runtime 入口。均未实际启动验证。
- U01、U02、U12、P01：React 入口、蓝白基础控件和样式、设置页与按账号隔离的本地偏好。对话页面和登录页面尚未实现。
- N01、N02、N06：Rust 清单、Tauri 配置和系统凭据适配。N07/N10 打包与图标脚本已写入，待核对；Rust 宿主 lib/runtime/account 接线尚未实现，Cargo.lock 尚未生成。
- A01–A11、A13：共享登录、独立桌面 Token、迁移、Key 密文、到期轮换、账号/退出接口、根路由和密文清理。A12 父会话约束及 AT01/AT02 四个测试文件已写入，待核对交接和集中执行。
- 协调中增加的单文件或少量文件接线/修复列在任务图的 `execution_adjustments` 中。

## 尚未完成的关键链路

1. U03–U11：真实 DSH transport、会话和事件投影、消息与工具展示、发送/停止、目录选择及对话页面装配。
2. N03–N05、N08–N09：原生进程生命周期、目录/网页命令、React 到 Tauri 的连接和锁文件/启动命令。
3. L01–L11：客户端登录、系统凭据恢复、按账号绑定 DSH home、退出清理和错误恢复。
4. 其余必要测试编写、全部集中验证、整包版本/更新/构建工作流和交付文档。

## 恢复时先处理的具体问题

- **安装与锁文件**：没有 `node_modules`；`pnpm-lock.yaml` 仍是旧锁，尚不覆盖新 workspace。不要直接宣称 frozen install 或 CI 可以通过。网络恢复后由单个任务负责人统一安装/生成锁，按实际解析结果处理精确版本、peer 和现有 allowBuilds/依赖年龄规则。
- **联网执行阻塞**：普通 shell 的 `curl` 连接代理 `proxy:8080` 立即失败；追加网络权限和升级执行的工具请求多次长时间不返回，最终被中断，未得到 stdout、退出码或 session id。不能据此认定安装曾执行。GitHub 连接器读取正常。不要再重复会阻塞协调者的权限调用；先确认调整后的环境可执行联网命令。
- **真实 Key 到期接线尚未完成**：DSH `llm-pi-ai` 每个 stream 会调用 `ctx.credentials.resolve(ref)`，但 CLI 子进程里的 resolver 无法直接调用父 Runtime 的 `getKey()`。当前 R06 通过 `credentials.set/unset` 更新值，只是配置接线；L02 必须补上在每个新模型请求前获取到期 Key 的真实扩展点。不能把启动环境变量、只在 UI prompt 前刷新或未连接的 callback 当成闭环；DSH 内部工具循环/子 agent 也会发起模型请求。固定源码确实导出 `PiAiAdapter` 的 `resolveApiKey` 钩子，后续选择薄插件/私有控制通道或程序化 composition，避免重做 Agent。
- **前端跨源**：Tauri 自有页面直连 DSH loopback 会受其跨源校验限制。U03/N03 需要实际 native/runtime transport，复用 DSH hooks/protocol；不能假设浏览器 fetch 能设置 Cookie/Origin。
- **Runtime 路径**：宿主需提供 `SUB2API_DSH_HOME`、`SUB2API_DSH_WORKSPACE_DIRECTORY`、`SUB2API_DSH_RESOURCE_DIRECTORY`。包内目录约定为 `resource_dir()/resources/generated/runtime`，包含 `bin/<bun|node>`、`node_modules/@deepseek-ai/dsh` 和 `profiles/cheapai.yml`。检查开发 TypeScript `.ts` import 与 tsc 输出配置是否一致。
- **原生环境**：当前只有 Linux，未安装 Rust/Bun 和 Tauri 所需 GTK/WebKit 开发包。macOS/Windows 实际交付验证未执行，不能用 Linux 结果替代。Bun 1.4.2 仍是候选运行时，未证明 DSH 或 native modules 兼容。Bun 的官方 URL/hash 已记录，Node 备选 artifact checksum 尚待补充。
- **远端 main**：本地基于 `5b721891e89ff52e7293bdc03061ecc454e9084d`；执行中观察到 main 已到 `9b3038c9ec53d8dcb5b05f1424242654d1ff2616`，新增两提交涉及 preview/bootstrap 文档和脚本。此检查点未合并它们；恢复后先同步最新 main 并处理可能的后续冲突。

## 验证状态与执行约束

本次没有运行产品测试、类型检查、构建、浏览器验收、真实模型调用或原生安装验证。已有四个后端测试文件只是编写完成，不是通过证明。没有测试结果应被标为通过。

用户要求恢复时尽量使用六个 `gpt-6-luna`、`max` 推理 subagents。每次领取一个小任务，通常最多三个文件；按精确文件写锁避免冲突，独立任务可以并行。测试编写必须有实际行为风险依据；测试执行集中到完整模块/链路之后，同一环境只运行一个验证任务。不要逐小任务运行测试或推送。

保持既定范围：Tauri + 自有 React 蓝白 UI + DSH；无图片/视频、无新权限模式、无 device-code、无额外远程调用 Token；桌面 Token 90 天、每 Token 独立 Key，Key 30 天且不超过 Token 到期时间，只在首次或自然过期时创建。网站重构不属于本轮。
