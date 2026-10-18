# CI 触发与构建范围

## GitHub Actions

| 工作流 | 自动触发 | 文档变更 |
| --- | --- | --- |
| [Local checks](../.github/workflows/check.yml) | PR 更新、推送到 `main` | 仅修改 `docs/**` 或根 `README.md` 时跳过 |
| [Production release](../.github/workflows/production-release.yml) | 推送到 `main` | 使用相同路径排除 |
| [Desktop installers](../.github/workflows/desktop-package.yml) | PR 更新、推送到 `main`，且命中 Desktop 路径列表 | 文档目录和根 README 不在列表中 |

混合提交只要包含排除范围之外的文件，Local checks 和对应的 main 发布流程就会运行。Desktop 继续按自身路径列表判断；`LICENSES/desktop/**` 和 `THIRD_PARTY_NOTICES.md` 是打包输入，保留监听。Local checks 与 Desktop installers 的手动运行入口保持可用。

GitHub 的 PR 路径判断覆盖整个 PR 相对基线的差异。因此，包含代码或工作流修改的 PR 后续只补文档时，仍会检查整个 PR。功能分支 push 不重复运行 GitHub PR 检查；同一 ref 的旧检查会被新运行取消。

路径过滤会跳过整个工作流。仓库当前没有必需状态检查，因此 docs-only PR 不会等待被跳过的检查。若配置必需检查，应同步调整检查策略；不能将会被路径过滤跳过的检查直接设为必需。[GitHub 路径过滤说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)

## 检查内容

Local checks 执行云端类型检查、测试、构建、lint 和浏览器流程。格式差异通过 `continue-on-error` 步骤报告。Desktop 类型检查、构建和外观检查仅在 Desktop 范围变化时运行。

Desktop 范围包含应用、契约、共享主题、相关脚本和测试、构建配置、CI 检测器及工作流。锁文件变化会比较 Desktop workspace importer 及其可达依赖图，包括 workspace 链接、peer 快照、可选依赖和包元数据。无关依赖变化跳过 Desktop；全局锁策略变化或无法解析的依赖图触发检查。

PR 比较 merge base 与 head，push 比较事件 before/after，手动运行检查 Desktop。检测器回归命令为 `node --test scripts/ci/desktop-changes.test.mjs`。

## 生产发布

`pnpm run deploy:ci` 依次构建云端应用、向 production D1 应用缺失迁移、发布 Worker 和静态资源，再检查 `https://cheapai.dev/healthz`。任一步失败会停止流程，故障处理见[部署步骤](deployment.md)。

工作流使用 Actions Secret `CLOUDFLARE_API_TOKEN`，账户和资源来自 production Wrangler 配置。发布共享一个并发组，后续提交不会取消进行中的迁移或发布。PR 检查不部署。

`pnpm run deploy:ci --dry-run` 执行本地构建和打包；`pnpm run deploy` 手动发布 Worker，不应用 D1 迁移。

## Cloudflare Workers Builds

Cloudflare Workers Builds 是独立的 Git 集成，GitHub Actions 路径过滤不影响它。它的生产和 Preview 构建需要单独配置 Build watch paths，见[PR 预览](pr-previews.md#构建路径过滤)。
