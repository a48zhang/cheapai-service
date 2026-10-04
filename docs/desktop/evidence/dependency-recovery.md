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

## Runtime 加载与装配追加修复（2026-10-04）

基于 `70caf21ebc2af19ba1c7ead30b0e0dbd1091483a`，只修复 Runtime 客户端适配、资源清单收集和本文证据，未改安装包工作流、依赖锁或认证规则。

- 固定的三个 DSH 客户端包由局部 `window.__ModuleLoader__.load` 注册接口执行真实发布 factory；校验包版本、注册 ID 和必要导出，仅向 factory 提供同一 Cordis 实例。不伪造 ESM 导出、不全局注入 window、不加载远端或用户输入代码。
- Gateway 服务在 Cordis 插件 setup 提交后再读取。Node ws 保留错误监听，避免 Gateway 清理 CONNECTING 通道后触发无人处理的 EventEmitter error；错误仍由 Gateway 原有监听处理。
- 清单递归使用同一累积数组，移除对整个目录子树的 `push(...files)`；真实闭包超过 V8 函数参数数量限制，不应通过提高堆栈上限掩盖。
- 桌面三包 typecheck 通过，Runtime typecheck/build 通过；现有 `vitest run --project node tests/desktop` 5 文件、23 用例通过，无新增测试文件。
- 源码 Runtime bootstrap 实际通过。无账号 fixture 加 `--development-key-mode` 请求 DSH start，仍正确返回 `account-required`（没有提供静态 Key）；没有削弱账号守卫或制造凭据。
- 官方 Connection/Registry/Gateway 对未使用的 loopback fixture 完成初始化、销毁并恢复全局 hooks；禁止 HTTP 调用，无模型请求。这是初始化 smoke，不是真实 DSH/IPC E2E。
- `node --use-env-proxy scripts/desktop/prepare-runtime.mjs --target x86_64-unknown-linux-gnu --runtime node` 实际通过。Node 使用环境已配置的正常代理，未改代理/DNS/TLS。清单覆盖 264,667 个文件，文件总字节 2,446,089,308，包含编译后 client-modules.js。
- 随包官方 Node 启动资源目录内 `dist/src/index.js`，以标准 `host.startup/source=sidecar` 消息取得 `runtime.event/bootstrapped`，退出 0。原生窗口、真实账号/DSH任务与模型调用仍未通过验收。

新提交的三平台安装包必须另看 CI 终态，Linux 资源装配成功不代表 macOS/Windows 安装包已生成或可安装。

## Tauri 原生依赖配对修复（2026-10-04）

`a23cc3f` 的 Local checks 全部成功（198 文件、3844 用例）。ARM macOS 与 Windows 均已越过真实 Runtime 资源装配和发行清单，随后在 `tauri-runtime-wry` 编译失败：宽松传递约束选中了不兼容的 `tauri-runtime 2.12.1` / `tauri-runtime-wry 2.9.3`，出现 trait 签名/缺失方法以及 Windows 类型版本冲突。

参照官方 `tauri-v2.8.5` 发布的 Cargo.lock，使用真实 `cargo update --precise` 将 runtime/runtime-wry 配对为 2.8.0/2.8.1；其余应用依赖声明未变。官方 crates.io 下载、`cargo fetch --locked` 与 `cargo metadata --locked` 成功，未手写 checksum、取消 locked 或调整工作流。原生编译结论仍以新 SHA 三平台 CI 为准；本机 Linux 系统库限制仍在。

## Renderer 发布物加载修复（2026-10-04）

独立 QA 在 Renderer 构建产物中发现同类 ModuleLoader 入口错误。新增 Vite 适配只处理固定版本的四个官方 `/client` bundle（Connection、Gateway、Typert Registry、Session Controller），将真实 factory 与允许的静态依赖转为 ESM；开发模式排除这些非 ESM 原包的预打包。没有在浏览器执行 eval、新建假服务或修改账号/IPC 接口。

桌面 typecheck/build、现有 5 文件 23 用例通过。本机真实 Chromium 分别打开 production preview 与 Vite dev：均无未捕获异常，React 已挂载并显示“桌面服务不可用／请使用桌面应用”的正确浏览器限制提示。该验证证明 Renderer 初始化错误解除，不代表 Tauri WebView、原生 IPC 或真实 DSH 会话通过。`db1ca55` 常规 CI 已全部成功（198 文件、3844 用例），安装包与本追加变更的 CI 另跟踪。

Tauri 补充：`db1ca55` ARM 构建已越过 runtime/wry，但较新的 macros 2.7.1 生成了 Tauri 2.8.5 不存在的 `UnexpectedMenuKind`。继续按官方 2.8.5 发布锁完整配对内部族：macros/codegen/plugin 2.4.0、utils 2.7.0（runtime 2.8.0、runtime-wry 2.8.1、build 2.4.1）；应用插件版本不变。全部由官方 `cargo update --precise` 生成，fetch/metadata --locked 通过。Tauri/Tauri-build 声明采用 CLI 实际写回的空 features 表形式，避免构建仅因声明格式被改写而污染源文件；版本和功能不变。

`c1ffab0` 常规 CI 全部成功；ARM 安装包已通过 Tauri 内部依赖编译，暴露应用源码 6 个编译错误。本次补齐 updater 的 DshLifecycleState 导入、launch 错误代码借用，并将 runtime status 与三个 updater 异步 command 包装为 Tauri 要求的 Result。Ok 仍序列化为原来的状态对象，既有 updater 业务错误仍保留在对象内，认证/更新逻辑不变。完整原生编译和安装包仍由后续 CI 验收。
