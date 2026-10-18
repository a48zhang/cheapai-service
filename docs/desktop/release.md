# 桌面构建与发行

## 固定输入

工具链和目标记录在 `scripts/desktop/runtime-versions.json`，Node/pnpm 也由仓库根约束。发行使用 Node；Bun 为实验候选。使用已提交的 `pnpm-lock.yaml` 与 `apps/desktop/src-tauri/Cargo.lock` 安装依赖。

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm dev:desktop -- --runtime node --target aarch64-apple-darwin
pnpm typecheck:desktop
pnpm build:desktop
pnpm package:desktop -- --runtime node --target aarch64-apple-darwin
```

`--target` 必须匹配当前宿主。支持的打包目标为 macOS arm64/x64 与 Windows x64；切换目标需使用对应机器。开发可传 `--runtime-executable <absolute-path>`；`--development-key-mode` 仅开发命令接受，它本身不读取或提供 Key，默认走账号登录流程。打包擦除开发 Key 开关和父进程模型密钥环境。

package 命令依次构建桌面 workspace、准备固定 Runtime/DSH 资源和图标、生成发行清单，再调用 Tauri 打包。资源下载必须匹配已记录 SHA-256，生产依赖完整随包。清单绑定实际 app/runtime/DSH 版本、目标、资源 hash 与干净源码提交；用户 home 不属于清单或安装资源。

## CI 自动打包与验证

`.github/workflows/desktop-package.yml` 在 `main` 推送桌面相关改动、相关 PR 和手动 Run workflow 时运行。三个任务分别构建 Windows x64 NSIS `.exe`、macOS Apple Silicon `.dmg`、macOS Intel `.dmg`，固定使用 Node Runtime。打开对应 Actions 运行的 Artifacts，下载 `desktop-installer-<target>-<commit>`；产物保留 14 天。

CI 只执行 frozen + strict peers 安装和 cargo fetch --locked，不修改依赖锁或源码。各目标的实际锁同时上传为 `desktop-locks-<target>-<commit>`；安装包内的清单绑定触发构建的源码提交与锁文件 hash。

安装包未签名、未公证，通过 Actions 产物分发。安装检查在对应目标系统执行。

目标机器检查覆盖：不预装 Node/Bun、中文和空格路径、工具停止和进程收尾、账号切换及历史保留。

验证使用隔离环境。真实网关任务需配置测试 Key、模型和费用预算。

## 更新与许可

Tauri 标准 updater 配置可信源与公钥，私钥只属于发布签名环境。未配置时返回 unavailable。检查与安装分离，安装前对运行任务或未知活动状态确认，并有界停止自有 DSH 和 Runtime。Windows SDK 会启动安装器并退出；macOS/Linux SDK 替换资源后由宿主退出。用户重新打开应用确认实际版本；不自动重放模型请求。更新失败后允许显式重启本地服务。整包更新同时替换壳、前端与 Runtime，账号历史不在替换资源内。

完整许可文本在 `LICENSES/desktop/`；原有仓库 notices 保留，生产包 closure 内各依赖的 LICENSE/NOTICE 保留。见 [运行时分发](runtime-distribution.md) 与根 `THIRD_PARTY_NOTICES.md`。
