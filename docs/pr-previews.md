# PR 预发

PR 预发由 Cloudflare Workers Builds 中配置的原生 Preview 负责。预发 URL、构建记录和预览绑定在 Cloudflare Dashboard 对应 Worker 中查看。

仓库已移除 GitHub Actions 的 PR preview 部署工作流、分支 Worker 创建脚本和旧共享预发配置。GitHub Actions 继续执行类型检查、测试、lint、构建和浏览器验收，不再部署预发 Worker、执行预发 D1 迁移或处理 PR 关闭后的预发下线。

Workers Builds 的部署命令使用 `pnpm run deploy`，通过 Worker workspace 中安装的 Wrangler 执行。Dashboard 设置不由 Git 自动覆盖，详细设置见[部署步骤](deployment.md)。原生 Preview 的配置、环境变量、Secrets 和数据库绑定以 Cloudflare 中当前设置为准。

旧 CI 曾创建的 `sub2api-<仓库标识>-pr-<PR号>` Worker 和 `cheapai-preview` 共享资源不会因删除工作流自动删除；本次仅移除仓库中的 CI 部署链路。旧预发 URL 不再随 PR 更新，新的预发入口以 Cloudflare 原生 Preview 为准。
