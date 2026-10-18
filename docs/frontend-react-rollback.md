# React 切换后的回滚

React 已位于 `apps/web`，包名为 `@cheapai/web`。旧 Vue 应用不在当前 workspace；迁移时的本机归档不随仓库分发。

## 优先修复当前版本

现有 Worker API、共享契约、依赖和数据结构已继续演进。界面回归优先在当前 React 版本修复。涉及线上版本回退时，先按[兼容回滚步骤](rollback.md)核对数据库、凭据、API 和静态资源。

## 需要取回旧前端时

1. 从最新 main 创建独立分支，定位[React 切换 PR](https://github.com/a48zhang/cheapai-service/pull/5)的合并提交。
2. 从 Git 历史取回需要比较的文件，检查前端、workspace、依赖锁、测试入口与 Worker API 的差异。
3. 如需回退整个合并提交，先确认它是带两个父提交的 merge commit，再使用 `git revert -m 1 <merge-commit>`。对 squash 提交使用普通 `git revert <commit>`。
4. 解决后续改动冲突，保留当前生产资源、发布流程和数据库迁移。不要恢复已移除的 staging 配置或旧 PR 部署脚本。
5. 运行匹配版本的类型检查、构建和用户/管理员浏览器流程，再通过 PR 审阅。

Git 回退只改变受跟踪文件。生产部署按[部署步骤](deployment.md)执行；数据库恢复按[备份与恢复](backup-restore.md)执行。
