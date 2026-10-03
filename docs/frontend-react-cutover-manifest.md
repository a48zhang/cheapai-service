# cheapai React 切换清单

状态：M-121/M-122 目录切换及本地验收均已完成。验收证据与范围见[最终集中验证报告](validation/cheapai-react-final.md)。2026-10-03 的只读盘点列在下方，供追溯旧文件来源。React 已位于正式 `apps/web` workspace，Vue 已完整归档；本地验收不表示已执行生产发布。

## 1. 路径与归档目标

| 内容 | 当前正式路径 / 标识 | 回滚来源 / 保留位置 |
| --- | --- | --- |
| React 前端 | `apps/web`，workspace 包名 `@cheapai/web` | React 目前在正式路径；如需回滚，先移回 `apps/web-next` |
| 旧 Vue 前端 | `/workspace/cheapai-legacy-archive/react-cutover/apps-web`，包名 `@sub2api/web` | checkout 外的完整可逆归档 |
| Worker 静态资源目录 | `apps/worker/wrangler.jsonc` 中 `../web/dist`，当前指向 React 产物 | Vue 恢复到 `apps/web` 后，同一相对路径指向旧 Vue 产物 |

上述归档是 checkout 外的本地可逆备份，不加入 Git。归档前旧应用有 **66 个已跟踪路径**，没有未忽略的未跟踪文件；`dist/`、`node_modules/` 等忽略/生成内容已随整个目录保留在归档中，不应加入提交。

## 2. 旧 Vue 前端归档前的已跟踪文件

以下为移动前 `git ls-files apps/web` 的完整结果。它们现在位于 `/workspace/cheapai-legacy-archive/react-cutover/apps-web/` 下对应的相对路径；M-121 移动的是整个目录，不仅是这些已跟踪文件。

```text
apps/web/.gitkeep
apps/web/env.d.ts
apps/web/index.html
apps/web/package.json
apps/web/tsconfig.json
apps/web/vite.config.ts
apps/web/src/App.vue
apps/web/src/main.ts
apps/web/src/router.ts
apps/web/src/api/account.ts
apps/web/src/api/admin-audit.ts
apps/web/src/api/admin-billing.ts
apps/web/src/api/admin-channels.ts
apps/web/src/api/admin-groups.ts
apps/web/src/api/admin-models.ts
apps/web/src/api/admin-registration.ts
apps/web/src/api/admin-requests.ts
apps/web/src/api/admin-users.ts
apps/web/src/api/auth.ts
apps/web/src/api/billing.ts
apps/web/src/api/chat.ts
apps/web/src/api/client.ts
apps/web/src/api/keys.ts
apps/web/src/api/registration.ts
apps/web/src/api/requests.ts
apps/web/src/api/session-expiry.ts
apps/web/src/api/types.ts
apps/web/src/components/AppLayout.vue
apps/web/src/components/CreateKeyDialog.vue
apps/web/src/components/EditKeyDialog.vue
apps/web/src/components/RequestFilters.vue
apps/web/src/components/admin/BalanceAdjustmentDialog.vue
apps/web/src/components/admin/ChannelEditor.vue
apps/web/src/components/admin/ChannelModelsDialog.vue
apps/web/src/components/admin/CreateCodesDialog.vue
apps/web/src/components/admin/CreateUserDialog.vue
apps/web/src/components/admin/EditUserDialog.vue
apps/web/src/components/admin/ModelEditor.vue
apps/web/src/components/admin/ModelMappingEditor.vue
apps/web/src/components/chat/ChatComposer.vue
apps/web/src/components/chat/ChatMessage.vue
apps/web/src/components/chat/ChatSidebar.vue
apps/web/src/composables/chat/useChatDraft.ts
apps/web/src/composables/chat/useChatModelSelection.ts
apps/web/src/composables/chat/useConversationHistory.ts
apps/web/src/stores/session.ts
apps/web/src/styles/console.css
apps/web/src/views/BillingView.vue
apps/web/src/views/ChatView.vue
apps/web/src/views/DashboardView.vue
apps/web/src/views/HomeView.vue
apps/web/src/views/KeysView.vue
apps/web/src/views/LoginView.vue
apps/web/src/views/RegisterView.vue
apps/web/src/views/RequestDetailView.vue
apps/web/src/views/RequestsView.vue
apps/web/src/views/admin/AuditView.vue
apps/web/src/views/admin/BillingView.vue
apps/web/src/views/admin/ChannelsView.vue
apps/web/src/views/admin/GroupsView.vue
apps/web/src/views/admin/ModelsView.vue
apps/web/src/views/admin/RegistrationCodesView.vue
apps/web/src/views/admin/RegistrationSettingsView.vue
apps/web/src/views/admin/RequestDetailView.vue
apps/web/src/views/admin/RequestsView.vue
apps/web/src/views/admin/UsersView.vue
```

## 3. 正式路径外部引用的当前状态

M-121/M-122 后，主 workspace、Worker 依赖和预览 build 已指向 React。下表记录当前正式配置，以及为历史追溯或防止误导入而保留的引用。

| 引用位置 | 当前状态 | 后续处理 |
| --- | --- | --- |
| `package.json` | `dev:web`、`lint:web` 和 `production:check` 使用 `@cheapai/web`；主分支已移除 `staging:check`。 | 当前生产 dry-run 命令使用正式 React workspace；保留正式包名，不重新引入 `web-next` 别名。 |
| `pnpm-workspace.yaml`、`pnpm-lock.yaml` | workspace/importer 使用 `apps/web`；锁定的 app 包为 `@cheapai/web`。 | 正式 React workspace 已归位。 |
| `apps/worker/package.json` | Worker workspace 依赖 `@cheapai/web`。 | 正式依赖已归位。 |
| `apps/worker/wrangler.jsonc`、`scripts/pr-preview.mjs` | 静态资源均从 `../web/dist` / `apps/web/dist` 读取。 | 路径与 React 正式目录一致；回滚 Vue 到 `apps/web` 后仍是旧资源位置。 |
| `.github/workflows/preview.yml`、`.github/workflows/check.yml` | Preview build 与 React lint 使用 `@cheapai/web`。 | 主流程已指向正式 workspace。 |
| `scripts/start-local-test-server.mjs`、`vitest.config.ts` | 浏览器 server 使用 `apps/web`；React Vitest project 加载 `apps/web/vitest.config.ts`。 | 主入口已指向正式路径。 |
| `scripts/start-react-dev.mjs` | 按 `@cheapai/web` 解析 app，并提示配置 `apps/web/.env.local`。 | 正式路径已归位。 |
| `apps/web/eslint.config.js` | `@sub2api/web` 出现在 restricted-import 列表中，阻止 React 导入归档 Vue app。 | 这是有意保留的禁止导入规则，不是活跃依赖，不应删除。 |
| `tests/unit/api-client.node.test.ts` | 从 `apps/web/node_modules/typescript` 导入编译器。 | 该路径现在指向 React app；可在后续工具链整理中改成显式 workspace 工具依赖。 |
| `README.md`、`docs/development.md` | 已描述 React 位于 `apps/web`。 | 当前说明与正式路径一致。 |
| `docs/deployment.md` | build 命令使用 `@cheapai/web`，静态资源位于 `apps/web/dist`、Worker 相对路径为 `../web/dist`；正文描述 React 静态资源。 | 当前命令、文案和配置路径均指向 React；保留 Worker 相对资源路径。 |
| `docs/frontend-react-design.md`、`docs/frontend-react-development-plan.md`、`docs/frontend-react-module-boundaries.md` | 当前应用路径均为 `apps/web`；旧 `apps/web-next` 只保留在原始任务表的历史写集说明中。 | 活跃说明已归位；保留任务拆分历史以便追溯。 |
| `docs/frontend-react-contract-map.md`、`docs/task-breakdown.md`、`docs/implementation-plan.md`、`docs/task-graph.json` | 保存 Vue 源码路径与任务来源。 | 作为历史来源处理；涉及 `apps/web/src` 的旧源码路径应注明来自归档树。 |
| `docs/toolchain.md`、`docs/evidence/*` | 记有旧 app/npm 工具路径或旧 UI 的历史运行证据。 | 保留历史记录，避免描述成 React 的新验证结果；仅修正文档中仍被当作当前命令使用的部分。 |

React 的正式 package manifest 为 `apps/web/package.json`，包名保持 `@cheapai/web`。旧 Vue `@sub2api/web` 仅存在于外部归档，未注册为 workspace。

## 4. 已完成切换与剩余工作

以下目录操作由 root 完成；最终本地验收结果另见[集中验证报告](validation/cheapai-react-final.md)。本清单不记录生产发布。

1. **M-121 完成：** 旧 `apps/web` Vue 目录整体归档到 `/workspace/cheapai-legacy-archive/react-cutover/apps-web`，保留本地归档内容。
2. **M-122 完成：** React `apps/web-next` 已归位为正式 `apps/web`，包名仍为 `@cheapai/web`。
3. Workspace、Worker 包依赖、preview build、React build/dev 入口与主要测试配置已使用 `apps/web` / `@cheapai/web`；历史路径和有意保留的禁止导入规则见上一节。
4. 本地验收已完成：全量 Vitest 198 个文件、3,847 项通过，另有 2 项新增 Key 用例通过，累计覆盖 3,849 项；workspace typecheck/build、Worker dry-run、React lint、8 文件 35 项 React 定点测试及 preview self-test 通过。
5. 浏览器共覆盖 37 项：首轮 35 项通过，之后管理链两项定点复跑 2/2 通过，合并证据覆盖全部 37 项；并非单次 37/37 运行。具体日志、运行范围和结论边界见[最终集中验证报告](validation/cheapai-react-final.md)。

No production deployment, PR publication, archive deletion, or secret/cache commit is part of this cutover manifest.
