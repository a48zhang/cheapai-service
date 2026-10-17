# PR 预发

2026-10-17 已移除失效的 Cloudflare Workers Builds 分支触发器。自动预发暂不启用，后续由维护者重新配置；旧预发 URL 不作为当前 PR 的验证入口。

仓库已移除 GitHub Actions 的 PR preview 部署工作流、分支 Worker 创建脚本和旧共享预发配置。GitHub Actions 继续执行类型检查、测试、lint、构建、浏览器验收及相关 Desktop 构建，不部署预发 Worker，也不执行预发 D1 迁移。

重新配置 Cloudflare 原生 Preview 时，需要使用 Worker workspace 中安装的 Wrangler，明确目标 Worker、配置文件及预发的环境变量、Secrets 和数据库绑定。`pnpm run deploy` 是正式发布命令，不是 PR Preview 命令；详见[部署步骤](deployment.md)。

移除构建触发器不会删除 Worker、数据库、KV、Secrets、GitHub 仓库连接或历史构建记录；本次未修改这些资源。
