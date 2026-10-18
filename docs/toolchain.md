# 工具链与依赖

Node 版本由 `.node-version` 固定，pnpm 版本由根 `package.json` 的 `packageManager` 固定。依赖版本和安装策略分别见 `pnpm-lock.yaml`、`pnpm-workspace.yaml`。

从仓库根目录安装并核对：

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
pnpm --filter @sub2api/worker exec wrangler --version
```

Windows PowerShell 可使用 `pnpm.cmd`。使用 workspace 中的 Wrangler；直接调用入口为 `node apps/worker/node_modules/wrangler/bin/wrangler.js`。

Desktop 还使用 `apps/desktop/src-tauri/Cargo.lock` 和 `scripts/desktop/runtime-versions.json` 固定 Rust、Tauri、DSH 及随包运行时，安装步骤见[桌面发行](desktop/release.md)。

本地启动、数据库初始化与检查命令见[本地开发](development.md)。
