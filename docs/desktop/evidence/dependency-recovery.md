# Desktop 依赖恢复与集中验证（2026-10-04 UTC）

基线：`8c8f7b307d3f54ec5b8a46dd664204673f53591e`，`feat/cheapai-desktop`。开始时远端无新提交，工作树干净；本仓库未找到 AGENTS.md 或 .agents/skills 指令。

## 安装策略与原生锁

- 本次环境可通过正常网络访问 GitHub、官方 npm 注册表、static.rust-lang.org 与 crates.io；未改变代理、DNS 或 TLS 设置。
- 使用仓库固定 Node 24.19.0 / pnpm 11.19.0。pnpm store 放在可写的工作区，不更改仓库包管理器配置。
- 首次 pnpm 解析被既有 `minimumReleaseAge: 1440` 拦下：`@deepseek-ai/dsh-client-ui-settings-account@0.2.1-alpha.1` 发布时间为 2026-10-03 05:44:33.423 UTC。等待满 24 小时再解析，未添加年龄豁免、关闭供应链检查或取消 frozen 安装约束。
- 官方 rustup 安装固定 Rust/Cargo 1.99.0 到工作区，`cargo generate-lockfile --manifest-path apps/desktop/src-tauri/Cargo.toml` 成功生成真实 Cargo.lock；`cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` 成功。
- `cargo check --locked` 在本机缺失的 `gobject-2.0` 系统库处失败。pkg-config 同时确认缺 GTK 3 / WebKitGTK 4.1；这不是 Rust 源码检查通过的证据。
- 并发任务已获用户授权新增自动 Windows/macOS 安装包工作流。本轮快进至 `dbf9dcd86b20a0cbde96923dfc2fb8eddbf5ac5e`，完整保留其 workflow、运行脚本及精确 packageExtensions/allowBuilds，再由 pnpm 重新生成匹配锁；没有覆盖或修改并发任务。

## 集中验证结果

本机安装与 pnpm 验证命令统一使用 `CI=true`；pnpm 11 的默认 global virtual store 行为在 CI 与交互模式不同，混用会被 `verifyDepsBeforeRun` 正确拒绝。Wrangler 日志目录通过 `XDG_CONFIG_HOME=/tmp/desktop-xdg` 放在可写目录。

- `pnpm install --frozen-lockfile --strict-peer-dependencies --store-dir /workspace/.pnpm-store --registry=https://registry.npmjs.org` 成功，1032 个锁条目通过供应链检查。
- `pnpm run typecheck:cloud`、`pnpm run typecheck:desktop` 成功。修复真实依赖暴露的品牌 ID、远端事件投影类型、可选属性、Markdown labels、updater 参数推断及 Runtime declaration 类型；未降低 strict/skipLibCheck 标准。
- `pnpm run build:cloud` 成功，Worker 仅 dry-run；`pnpm run build:desktop` 成功（contracts、Runtime tsc 和 Vite），有大 chunk 提示。
- `pnpm run test:node`：50 文件、1782 用例通过，没有新增测试。
- 首次 `pnpm run test`：198 文件中 197 通过，3844 用例中 3843 通过。唯一失败为旧 scheduled/cleanup 精确断言缺少新增的两个桌面统计字段；同步为 0/false，保留严格 toEqual，不扩大用例范围。该文件复验及新 SHA CI 终态另记。
- 修复现有 `create-fixture.mjs` 的 executableName 作用域错误后，真实临时 fixture 创建成功。

## 尚未通过的启动边界

`node scripts/desktop/dev-runtime.mjs --runtime node --home <新临时目录> --workspace <fixture/workspace>` 实际失败：`@deepseek-ai/dsh-client-connection/client` 不提供 ESM named export `installConnection`。固定 npm 包的 `lib/client.js` 实际以 `window.__ModuleLoader__.load({ id, factory })` 注册官方客户端模块，现有 Runtime 静态 ESM import 不兼容该发布格式。类型声明/构建通过不能代替这条真实启动链；未伪造导出或把插件 bundle 当成可运行 ESM。

Tauri 启动入口也已执行，尚未打开原生窗口。本 Linux 缺 gobject/GTK/WebKit 系统库；macOS/Windows 安装、原生 IPC、真实 DSH/模型调用和 Token/Key 链路均未在本机通过验收。没有创建账号或密钥、调用付费模型、部署生产或合并。

后续应接入固定 DSH 官方客户端模块加载协议，再验收 Runtime bootstrap 和 IPC，而不是用类型断言或 external 配置掩盖运行时缺失。
