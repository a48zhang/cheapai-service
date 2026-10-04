# macOS 原生验证

日期：2026-10-04 UTC。目标：aarch64-apple-darwin / x86_64-apple-darwin。状态：**not_run / blocked_target**。

当前只有 Linux x64 工作区，没有目标机器、Rust/cargo/rustfmt、完整冻结 pnpm 图或 Cargo.lock。未执行 cargo test/build、Tauri 打包、安装、系统凭据库、目录/链接、中文/空格路径、关窗/Quit、进程树、更新或持久化验收。没有安装包、签名或公证结果。

源码产物包含原生宿主、私有协议、Token 持久化、按账号 home、目录与固定网站入口、显式 Runtime 重启、未知任务确认、generation/PID 所有权收尾和标准 updater。NT01 仅编写 Rust 协议/关联/公开投影用例，未运行；Linux Node fake-child 测试不能替代原生行为。

需要具备真实 pnpm/Cargo 锁和固定资源后，在对应目标机器运行独立 desktop 构建任务并验证：不预装 Node/Bun 的启动，系统凭据恢复，同账号历史保留/异账号隔离，工具/停止，普通关闭与用户 Quit，异常残留进程，安装/整包更新失败与成功路径。Bun 为比较候选，不能写成已支持。

本报告是缺失环境的真实记录，不是通过证明。没有远程运行 CI 或公开安装包发布。
