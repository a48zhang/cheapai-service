# 候选版本集成检查

日期：2026-10-04 UTC。状态：**partial / 不具备发行验收结论**。

已完成全部可在此环境交接的桌面实现、测试作者、设置/更新/构建流程和文档。原生 installer、完整 pnpm/Cargo 锁及真实完整模型链尚无产物；本分支不是可发布安装包。

| 范围 | 结果 |
| --- | --- |
| 原云端三包类型/构建 | 使用已安装真实 bin 集中执行，全部退出 0；Worker为dry-run。 |
| contracts 类型/构建 | 退出 0。 |
| 全部 Node | 49文件、1776通过；conversation-events缺DSH依赖未加载，整体退出1。 |
| 最终受影响桌面 Node | 4文件、21/21通过，范围与前行重叠。 |
| 桌面58个TS源码与7个mjs | 语法检查通过；不替代完整类型/运行。 |
| Runtime / React完整类型 | 未通过，缺新registry依赖/固定vite类型；独立源码类型错误已收集修复并复验。 |
| Workers/D1行为 | 执行器listen EPERM，未运行用例。 |
| Rust/macOS/Windows/Bun | 无对应工具或环境，未执行。 |
| 打包/发行清单/更新 | 未生成或运行；缺锁、真实Runtime/frontend dist、资源与可信更新配置。 |

F05：保留旧 pnpm-lock.yaml，未加入虚假 importer/integrity，安装代理不可用。N09：开发/打包入口已实现，Cargo.lock因无cargo与网络阻塞未生成。普通 pnpm脚本会识别旧安装图不匹配并要求安装；未绕过此guard。CI为manual workflow_dispatch，仅源码中准备，未触发，没有上传开发artifact或公开Release。

P03 updater配置为空时返回unavailable；没有伪造endpoint/pubkey或签名、没有下载/安装更新。Windows SDK与macOS/Linux的安装行为根据固定SDK源码接线，尚无目标系统结果。安装前有界停止整个Runtime，失败允许显式重启，不自动重放模型任务。

七份证据均已写出，环境缺失的项目保留not_run/partial；没有把源码交接、mock、语法检查或Linux结果当作发行通过。继续完成外部阻塞需要恢复registry网络、真实pnpm/Cargo锁与目标机器，再补完整类型/构建、D1、DSH/模型、安装升级验收。生产迁移、部署和公开发布未执行。
