# Desktop Runtime 分发

桌面壳、自有 React 前端、Runtime 和固定 DSH 组合按同一应用版本打包。壳的 Cargo package、Tauri bundle、前端 package 和 Runtime package 版本必须相同。运行时选择来自 `scripts/desktop/runtime-versions.json`；Node 24.19.0 是固定对照，Bun 1.4.2 是候选，当前没有真实 DSH/Bun/native addon 兼容结论。

## 文件与数据位置

准备成功后，`resource_dir()/resources/generated/runtime` 是安装包资源，包含单一所选 `bin/<node|bun>`、编译后的 `dist/src/index.js`、生产 `node_modules` 闭包、`profiles/cheapai.yml`、`desktop-runtime.json`、`release-manifest.json` 和 notices。编译后 managed credential provider 位于 `dist/src/cheapai/dsh-credential-provider.js`；launcher 的动态 patch 只引用它的绝对 file URL，不包含 Token/Key。`release-manifest.json` 还记录 Tauri `frontendDist` 文件的路径、字节数和 SHA-256；清单本身不对自身生成递归 checksum。

DSH home 位于宿主应用用户数据目录并按稳定 userId 散列分区，偏好按账号保存在 WebView 本地存储；Token 使用系统凭据库。Runtime 入口已启用私有 bridge/provider，先由原生持久化 Token 再 restore、绑定 home 并启动 DSH。源码接线已完成，安装升级的数据保留和真实账号隔离仍需目标机验收。构建脚本只写 `apps/desktop/src-tauri/resources/generated/runtime`；发布升级不得覆盖用户数据目录，也不得依赖用户的外部 pnpm store。

Git、Python、项目编译器、包管理器和其他被 DSH 工具调用的项目命令由用户工作环境提供；它们并非这个桌面安装包自动提供。随包 Node/Bun 只提供 JavaScript runtime，不代表项目工具链或依赖开箱即用。

## 准备与版本选择

使用仓库固定 Node/pnpm、精确依赖策略和完整 pnpm lock；Rust/Cargo lock 也必须已存在。开发用 `dev:desktop`，原生打包用 `package:desktop -- --runtime <node|bun> --target <Rust target triple>`。构建流程不得隐式安装或验证；锁、编译输出或资源缺失时明确失败。运行时下载必须命中 `runtime-versions.json` 固定的官方 HTTPS URL 与 SHA-256，不能复用未校验二进制或伪造元数据。

目标资源准备只在匹配 OS/架构的 runner 上执行，不把一个平台的 native dependency closure 复制到另一个平台。发行清单 CLI 为 `node scripts/desktop/release-manifest.mjs --runtime <node|bun> --target <Rust target triple>`；它读取已准备资源与前端 `dist`，检查 shell/frontend/Runtime 版本、目标、DSH/runtime pins、现有资源 checksum、完整 lock 输入和 Git source commit，再写入固定 runtime resource 目录。CI 的 `GITHUB_SHA` 必须与干净 checkout 的 HEAD 一致。清单列出实际 production package 版本/资源路径、native `.node` addon 与文件哈希；它不执行下载、安装、编译或测试。

Node/Bun 为互斥选择，只改变 launcher/runtime executable，不维护第二套 Agent 或消息持久化实现。开发测试 Key 模式通过显式 `--development-key-mode` 开启，release/package 命令拒绝该选项；Runtime 也要求 startup.source 为 development 才接受静态 Key；发布入口默认要求账号。此边界已有源码接线，尚未经过真实安装包验收。

## 第三方声明

仓库 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 保留既有协议来源并增加桌面固定来源；[LICENSES/desktop](../../LICENSES/desktop) 保存 DSH、Bun 和 Node 的完整上游声明。`package-runtime.mjs` 将 notice 与三份完整文本复制到 `notices/THIRD_PARTY_NOTICES.md`、`notices/LICENSES/desktop/`，并完整复制每个已解析 npm package 内容，保留其 LICENSE/NOTICE/COPYING 文件。发行资源还须包含实际依赖包内的声明。

Bun 的声明还覆盖 JavaScriptCore/WebKit 与多种静态链接库，并给出重链接说明；不能只保留“Bun 是 MIT”的一句话。Node 的保存文本同样包含其嵌入库声明。实际 npm/Rust/前端依赖以锁和发行清单为准；清单文件对资源和依赖文件列出路径与 SHA-256，但这不等于完成每个依赖的许可审查。网络阻塞时未取得的依赖不能伪记为已打包、已审计或已通过原生验证。

## 当前验证范围

版本及固定来源文本已取得；完整 Runtime 下载/打包、发行清单生成、DSH 启动、Node/Bun 比较和 macOS/Windows 安装尚未验证。当前 `pnpm-lock.yaml` 缺 desktop/runtime/contracts importers，`apps/desktop/src-tauri/Cargo.lock`、Runtime dist 与 frontend dist 未生成，所以 package/release manifest 必须失败，不能称已有可发布 bundle 或完整依赖清单。生命周期纯 Node 测试与 Worker dry-run 的结果仅证明检查点列出的范围。后续结果写入 `docs/desktop/evidence/`；生产部署、公开安装包发布和签名/公证材料不由这些脚本自动完成。
