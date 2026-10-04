# Desktop 执行检查点

更新：2026-10-04（UTC）。已按用户要求恢复 `feat/cheapai-desktop`，用六个 `gpt-6-luna` / `max` 子代理完成本批小任务及交接。代码、任务状态和验证证据一起保存；本批结束时无正在运行的子代理任务。没有创建 PR 或部署。

## 恢复入口

- [详细计划](./implementation-plan.md)
- [任务图与当前状态](./task-graph.json)
- [固定 DSH 接入点与新增适配风险](./dsh-integration.md)
- [版本与发行校验值](../../scripts/desktop/runtime-versions.json)
- [Runtime 验证](./evidence/runtime.md)、[后端账号验证](./evidence/backend-account.md)、[页面检查](./evidence/conversation.md)

`completed` 只表示小任务产物已核对交接，不表示测试、构建或端到端验证通过。当前 79 项中：43 completed、3 partial、1 blocked_network、32 pending。补充接线/修复独立记录在任务图 `execution_adjustments`，不混算为额外主任务完成。

## 分支与本批产物

恢复了远端原始桌面检查点 `d338460db185a9935a08fe6adeb62b4b59ce6087` 的完整 Git 对象并校验 SHA，合并 main `9b3038c9ec53d8dcb5b05f1424242654d1ff2616`，无冲突。原本地合并为 `b42d1ea`；通过 GitHub 连接器保存的等价合并为 `b3c0fad3bf69c8805e0d8731ff0d3fbb9a818551`，两者 tree 均为 `9ad3d6c9458ba0d9d07a8a3da2fe54a0b2eb931a`。普通 Git 联网调用曾阻塞并被用户中断，因此使用连接器同步，不再次发起同类权限等待。

保留之前 F01–F04/F06、R01–R06、U01/U02/U12、P01、N01/N02/N06、A01–A13 和 AT01/AT02 产物，并补齐：

- R07、RT01：严格临时 fixture、显式 Node/Bun 开发启动脚本、四项生命周期行为用例；修复 per-run listener 清理和 stdout 排空。
- U03、U04：官方 Connection/Gateway/Session 客户端适配，会话 list/create/rename/page 及按账号、目录、generation 清理的页面 store。打开会话仅选择 address；follow/snapshot 仍待 U05。固定 DSH 无 Session delete，明确返回 unsupported。
- N03 与补充 transport：Rust 拥有 Runtime 子进程、私有 NDJSON、生命周期状态与有界收尾；注册 call/open/uplink/end/cancel invoke 和流事件，严格 endpoint/generation 校验。
- R09 与入口接线：Runtime 用官方 unary RPC 和官方 Gateway mux，认证 Cookie/Origin 留在私有进程侧；ready 时创建 carrier，stop/失败/重启时 dispose。Gateway 的 `openRemoteStream` 是需随固定版本维护的内部方法。
- L01–L03：账号 API/client/state、Key 自然到期缓存和并发合并、私有账号命令及安全公开投影。密码不持久化，Token/Key 不进普通页面事件；原生账号存储接线仍待后续。
- R08 补充：私有 credential socket、薄 LocalCredentialProvider 子类、条件 profile patch。每个 DSH model resolve 都调用 session manager，managed Key 不落 credentials 文件。修复 listen/close 并发清理；此桥尚未在入口启用。
- N07/N10 已核对；Runtime 打包改为包含全部 production dependency closure，修复 prepare-runtime 缺少 realpath 导入。没有执行资源下载或原生打包。
- AT01 补充 managed Key 的普通列表隔离、禁止通用更新、显式撤销后不自动恢复行为用例；该新增用例未执行。

## 实际验证结果

同一环境集中执行，未逐子任务运行测试。

- 生命周期 Node 测试：四项全部通过。首轮两项测试因 fake timers 使用不正确失败，集中修正后仅重跑受影响文件。没有真实 DSH、端口或模型调用。
- Worker 本地 dry-run 构建：通过，未部署。
- Worker 类型检查：两处缺少未安装/链接的 contracts workspace，未通过。
- Workers 测试：执行器启动时 `listen EPERM 127.0.0.1`，没有用例执行成功；不能声明 0024 迁移已在本轮 fixture 应用。
- Runtime 类型检查：缺少 `node` 类型定义；React 类型检查：缺少 `node`、`vite/client`。均在检查完整源码前阻塞，不能宣称新接线类型成立。
- 真实 DSH、动态凭据 provider、Node/Bun 比较、浏览器与原生 macOS/Windows 验证均未执行。

## 下一批优先事项与具体阻塞

1. **F05 依赖/锁文件**：环境带有旧云端 node_modules，但新 desktop workspace 依赖和链接尚未安装。`pnpm install --lockfile-only --offline --ignore-scripts` 即使使用工作区 cache/store，也会因供应链元数据请求 EPERM 被 30 秒上限终止，锁文件未变。不放宽依赖年龄、allowBuilds 或 TLS。联网能力改变后由一位负责人统一补齐锁与安装，再做集中类型/构建。
2. **N08 页面 carrier**：将 Rust invoke/event 映射成 U03 的官方 `ClientConnectionRpc`。call 返回 `{generation, requestId, value: ConnectionRpcResult}`，页面适配须校验关联并取内层 value；stream 事件携 generation/streamId/sequence。端到端尚未组装或验证。
3. **U05–U11**：事件与消息投影、工具交互、发送/停止、目录选择和对话页装配。不得新增 Agent 循环或第二套消息持久化。
4. **N04/N05、L04/L05/L06**：原生异常恢复/关窗行为、目录和网页命令，Token keychain 接线、稳定 userId 的 DSH home 分区及唯一账号启动/退出顺序。当前 U04 只能隔离 UI 状态；同目录历史的真实账号分区必须由 L05 完成。
5. **真实 Key 接线**：R08 bridge/provider/profile 已写好，但当前 index 保留原开发配置 `credentials.set/unset`，没有启用 managed bridge。L06 必须先恢复账号并选 home，listen 新 bridge 后再启动子进程；切换前先停止旧账号 DSH 并关闭旧 bridge，防止旧任务拿新账号 Key。启用 managed provider 后不能再把 reserved Key 写进旧 store。不要把这些未装配的产物视为闭环。
6. **发布安全顺序仍待 L06**：现有 Runtime start 仍能启动无账号的 DSH；发布包默认登录优先、不隐式开发 Key 模式尚未实现。不能把当前检查点当可发布桌面产品。
7. **原生与 runtime artifact**：Rust/Bun 与目标 macOS/Windows 不可用；Cargo.lock、N09 启动命令及最终安装包未生成。Bun 1.4.2 仅候选，Node artifact 的正式 URL/hash 尚缺，不能伪造值或用 Linux 结果替代目标机验证。

## 保持的执行约束

继续优先使用六个 `gpt-6-luna` / `max` 子代理，每次一个小任务、1–3 文件，精确写锁；普通实现/研究/测试编写任务不运行验证。依赖和锁产物由指定负责人准备；验证由协调者集中执行，同一环境同时一个。补充问题拆小任务，不逐小任务推送。

范围不变：Tauri + 自有 React 蓝白 UI + DSH；无图片/视频、新权限模式、device-code、额外远程调用 Token或网站重构。桌面 Token 90 天；每 Token 独立 Key，Key 30 天且不超过 Token 到期，只在首次或自然过期时创建。无 PR、部署或生产迁移。
