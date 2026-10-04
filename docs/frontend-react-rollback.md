# cheapai React 切换回滚说明

状态：目录切换已完成，回滚预案未执行。当前 React 位于正式 `apps/web`，旧 Vue 完整保存在本机归档中；如后续出现阻塞，可按此顺序恢复旧目录与构建引用。此处的本机目录恢复不包括生产发布或云资源回滚；其他 checkout 的 Git 回滚另见下文。

根协调者报告核心模块部分 28 项测试、chat 24 项测试及标准 React build 已成功；浏览器流程仍有失败项正在修复。回滚状态与最终完整 check 状态相互独立；这些局部结果不代表整体最终通过。

## 保留位置

- 旧 Vue app：`/workspace/cheapai-legacy-archive/react-cutover/apps-web`，原包名 `@sub2api/web`。
- 新 React app：当前位于正式 workspace `apps/web`，包名 `@cheapai/web`。回滚时先将它移回 `apps/web-next`，保留新代码以便修复或再次切换。
- Worker 静态资源相对路径：`apps/worker/wrangler.jsonc` 中 `../web/dist`。当前指向 React 产物；旧 Vue app 恢复到 `apps/web` 后，同一相对路径再次指向 Vue 构建产物。

归档目录位于 checkout 外，是可逆恢复源。归档中可能包含 `dist/`、`node_modules/` 等被忽略的本地文件；恢复或再次归档时保留它们，不纳入 Git 提交。

## 回滚顺序

1. 停止本地 Vite、Worker 和浏览器测试进程，确认没有其他代理在同时修改 app 目录。
2. 检查 `apps/web-next` 是否为空缺的目标。若 React 当前在 `apps/web` 且 `apps/web-next` 不存在，将 React 整目录移回 `apps/web-next`，保留其内容。若目标已有文件，停止并先保护两份内容，不覆盖或合并未知文件。
3. 检查 `apps/web` 已空出，再将 `/workspace/cheapai-legacy-archive/react-cutover/apps-web` 整目录恢复到 `apps/web`。若归档源或目标缺失/冲突，停止并报告路径，不删除备份或目标内容。
4. 恢复 workspace 与 app 包依赖：`pnpm-workspace.yaml` 注册 Vue `apps/web`，如保留 React 则同时注册 `apps/web-next`；Worker 及相应 preview build target 指向 Vue app；`pnpm-lock.yaml` 对应恢复后的 workspace。以当前 main 为配置基线，只还原恢复 Vue 所需的 app 路径和包依赖。保留后续 main 合入的共享 preview backend 配置与 `production:check`，不要恢复旧 `staging:check`、旧 staging 设置或整份切换前的 package/workflow 文件。
5. 恢复测试/开发入口到旧 app：`vitest.config.ts` 的 React project 指回 `apps/web-next/vitest.config.ts`；本地浏览器启动器默认构建旧 `apps/web`。Playwright 使用旧 app 的 build。保留 `scripts/pr-preview.mjs` 与 `apps/worker/wrangler.jsonc` 的 `apps/web/dist` 资源目标。
6. 检查 Worker 本地和部署配置的 `assets.directory` 均指向旧 `apps/web/dist`。若切换期间有人改过 `../web/dist`，恢复该相对路径；不要把静态资产改到归档目录。
7. 按恢复后的 `pnpm-lock.yaml` 使用仓库的冻结锁文件安装流程重建链接依赖。旧 app 的本地 `node_modules` 可能随归档恢复，但 workspace 链接可能需要重新生成。
8. 保留 React 目录、Vue 归档和相关配置修改，直到根协调者决定修复后再次切换或结束迁移。集中验证由授权 runner 统一执行；本回滚预案不声称任何验证已通过。

## 不可覆盖的冲突处理

- 归档目标 `/workspace/cheapai-legacy-archive/react-cutover/apps-web` 不存在时才可作为首次归档目标；已存在就先保留并调查，不覆盖。
- `apps/web` 与 `apps/web-next` 都有内容时，不运行整目录移动；逐项确认归属后由 root 安排新的可逆路径。
- 回滚期间只恢复本清单提到的代码树、依赖和路径配置，不恢复或删除 D1、KV、Worker 部署、密钥和其他云资源。
- 归档成功与恢复成功都只是文件路径状态，不等同于应用可运行或已验证。

## 其他 checkout 的 Git 回滚

本机归档目录在 checkout 外，不会随 Git 或 PR 同步。若在其他机器上没有该归档，不要从路径猜测或复制本机内容；在 Git 历史中通过回退 React 切换 PR 恢复切换前受跟踪的 Vue app 与 workspace 文件：

1. 从最新 `origin/main` 创建独立回滚分支，并找到 React 切换 PR 的 merge commit。
2. 只回退该 merge commit，使用 main 作为主线父提交：

   ```sh
   git revert -m 1 <React-cutover-PR-merge-commit>
   ```

3. 检查回退差异并解决重叠文件冲突。保留之后合入 main 的共享 preview backend 配置（包括 PR4 的更新），保留当前 `production:check`；不要回退共享 preview PR、重置到旧 main，也不要恢复已移除的旧 staging 配置或 `staging:check` 命令。
4. 通过 PR 审阅并合并回退提交。该操作只恢复 Git 追踪的文件；本地生成目录仍按当前 checkout 的开发流程生成。
