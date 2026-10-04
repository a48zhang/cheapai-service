# 桌面构建与发行

## 固定输入

工具链和目标记录在 `scripts/desktop/runtime-versions.json`，Node/pnpm 也由仓库根约束。Bun 是固定版本的比较候选，未完成兼容验证时不得称为已支持。必须先取得真实的 `pnpm-lock.yaml` 与 `apps/desktop/src-tauri/Cargo.lock`，遵守已有依赖年龄、构建脚本与严格 peer 策略；不能手写虚假 integrity 或 Cargo lock。

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm dev:desktop -- --runtime node --target aarch64-apple-darwin
pnpm typecheck:desktop
pnpm build:desktop
pnpm package:desktop -- --runtime node --target aarch64-apple-darwin
```

`--target` 必须匹配当前宿主。支持的打包目标为 macOS arm64/x64 与 Windows x64；切换目标需使用对应机器。开发可传 `--runtime-executable <absolute-path>`；`--development-key-mode` 仅开发命令接受，它本身不读取或提供 Key，默认走账号登录流程。打包擦除开发 Key 开关和父进程模型密钥环境。

package 命令依次构建桌面 workspace、准备固定 Runtime/DSH 资源和图标、生成发行清单，再调用 Tauri 打包。资源下载必须匹配已记录 SHA-256，生产依赖完整随包。清单绑定实际 app/runtime/DSH 版本、目标、资源 hash 与干净源码提交；用户 home 不属于清单或安装资源。

## 手动构建与验证

`.github/workflows/desktop-package.yml` 只由 workflow_dispatch 触发，按目标系统使用固定工具链与冻结依赖，上传未签名开发安装产物和发行清单。依赖锁缺失或不匹配时失败，不在 CI 暗中生成替代锁。它不部署 Worker，不创建公开 Release，不执行签名或公证，也不证明安装后任务链通过。

集中验收见 `evidence/runtime.md`、`conversation.md`、`backend-account.md`、`account-e2e.md`、`native-macos.md`、`native-windows.md` 与 `release.md`。目标机器应覆盖不预装 Node/Bun、中文和空格路径、工具停止及进程收尾、账号切换和历史保留。更新源、签名、macOS 公证与 Windows 交付条件缺失时逐项记录未运行。

验证环境使用本地隔离 Worker/D1 或现有 PR 独立预发环境，不使用退役的共享 staging。真实网关任务需要已有测试 Key 和预算；mock 不证明模型兼容。生产部署、生产迁移和公开发布需要单独授权，不随本开发计划自动执行。

## 更新与许可

Tauri 标准 updater 配置可信源与公钥，私钥只属于发布签名环境。未配置时返回 unavailable。检查与安装分离，安装前对运行任务或未知活动状态确认，并有界停止自有 DSH 和 Runtime。Windows SDK 会启动安装器并退出；macOS/Linux SDK 替换资源后由宿主退出。用户重新打开应用确认实际版本；不自动重放模型请求。更新失败后允许显式重启本地服务。整包更新同时替换壳、前端与 Runtime，账号历史不在替换资源内。

完整许可文本在 `LICENSES/desktop/`；原有仓库 notices 保留，生产包 closure 内各依赖的 LICENSE/NOTICE 保留。见 [运行时分发](runtime-distribution.md) 与根 `THIRD_PARTY_NOTICES.md`。源码实现完成不等于许可审计或正式发行完成。
