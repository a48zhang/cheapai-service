# CheapAI React 重构集中验证

**总体状态：浏览器验收进行中，暂不标记完成。** 本报告记录 2026-10-03 已存在的本地结果与静态工程审查。浏览器套件当前仍有失败，等待修复后的最终重跑。

## 结果摘要

| 范围 | 当前结果 | 证据与边界 |
| --- | --- | --- |
| 完整 Vitest | 198 个测试文件、3847 项通过 | `/tmp/cheapai-final-vitest.log`；汇总包含 React、Node 与 Workers 项目。 |
| Workspace typecheck | 通过 | `/tmp/cheapai-final-affected.log`；之后的同一日志继续执行 build/lint，再开始定点 Vitest。 |
| Workspace build | 通过 | `/tmp/cheapai-final-build-lint.log`；包含 `apps/web` Vite build。 |
| Worker build | Wrangler dry-run 通过 | 同一 build 日志；读取 `apps/web/dist` 的静态资源，没有部署 Worker。 |
| React ESLint | 通过 | `/tmp/cheapai-final-build-lint.log` 与 `/tmp/cheapai-final-affected.log`；针对 `apps/web/src`。 |
| HTTPS 代理 smoke | 通过 | `/tmp/cheapai-proxy-smoke.log`；覆盖 Origin/Host、CSRF、安全 Cookie 和 SSE delta-before-done。 |
| 浏览器 E2E | 37 项中 25 项通过、12 项失败；修复中 | `/tmp/cheapai-browser-final.log`；这阻止整体验收标记完成。 |

日志保存在当前执行环境的 `/tmp` 下，供此次结论追溯；它们不是提交进仓库的原始 CI artifact。

## 全量结果后的定点补充

- 完整 Vitest 记录为 198 个文件、3847 项通过。之后新增的 Key 契约风险用例另有 2 项通过，见 `/tmp/cheapai-final-affected.log`（17:01:51）。因此已明确覆盖的合计是 3849 项：完整运行 3847 项，加上新增的 2 项。
- Key 一次性凭据生命周期用例在修复后定点复跑为 5/5 通过，见 `/tmp/cheapai-secret-final.log`（17:02:59）。这是对已有用例的修复确认，不重复计入上面的 3849 项。
- 浏览器 E2E 最终验收仍未通过；最终修复后的浏览器汇总尚待根协调者提供。

## 工程入口审查

只读审查确认以下配置已指向正式 React workspace `apps/web`：

- `pnpm-workspace.yaml` 注册 `apps/web`，其 workspace 名为 `@cheapai/web`；应用包脚本提供 Vite dev/build、typecheck、lint 和 Vitest。
- `.github/workflows/check.yml` 的配置顺序为 workspace typecheck、完整 Vitest、workspace build、React ESLint 和 Playwright 浏览器流程。
- `.github/workflows/preview.yml` 构建 `@cheapai/web`；`scripts/pr-preview.mjs` 与 Worker Wrangler 配置使用 `apps/web/dist`。
- `scripts/start-react-dev.mjs` 和 `scripts/start-local-test-server.mjs` 使用 `apps/web`；前者运行本机 HTTPS Vite 与 loopback HTTP Worker，后者将本地 React 产物用于隔离浏览器检查。
- `apps/web/eslint.config.js` 在 React 源码上启用 Hook 规则、模块边界规则及 Worker/旧 Vue 导入限制。边界文档正由其负责人按目录切换和最终规则同步。

以上是配置一致性审查与本地日志摘要，不表示 GitHub Actions 或 PR preview 已执行。没有在本次文档审查中运行测试、lint、构建、浏览器或远程部署。

## 尚未完成

浏览器 E2E 仍有 12 个失败，根协调者正在处理。完成后应以最终 Playwright 汇总替换当前计数，并同步更新 [聊天](cheapai-react-chat.md)、[管理端](cheapai-react-admin.md)、[身份链路](cheapai-react-auth.md)、[管理资源目录](cheapai-react-catalog.md) 和 [个人控制台](cheapai-react-personal.md) 的状态，再将整体状态改为通过。
