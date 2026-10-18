# PR 预发

GitHub PR 检查运行类型检查、测试、lint、构建和浏览器验收，不执行远程 SQL 或部署。main 推送由 [Production release](../.github/workflows/production-release.yml) 自动迁移并正式发布，详见[部署步骤](deployment.md)。

仓库已提供 Cloudflare 原生 Preview 配置。启用分支预览需要配置 Workers Builds；实际启用状态在 Dashboard 核对。

## Cloudflare Workers Builds 配置

Worker workspace 固定使用 Wrangler 4.151.1，该版本的 `wrangler preview` 标记为 open beta。仓库的顶层 `previews` 指定预览 CACHE、DB，声明独立 GATE，并设置可观测性；关闭问题检测使用该版本支持的 `observability.issues.enabled: false`。

Builds 根目录为仓库根目录时，使用以下设置：

| 设置 | 值 |
| --- | --- |
| 根目录 | `/`（仓库根目录） |
| 构建命令 | `pnpm run build`（Worker 步骤为 dry-run） |
| 生产分支 Deploy command | `pnpm run deploy` |
| 非生产分支 Preview command | `pnpm --filter @sub2api/worker exec wrangler preview --env production` |
| 分支控制 | 启用 Enable Preview Builds |

这里的 `production` 是仓库已有的 Wrangler 配置段，用于选中父 Worker `sub2api-cloudflare-production` 及公共构建设置。真正决定操作的是子命令：`deploy` 发布 Worker，`preview` 创建分支预览。原生 Preview 使用独立 `previews` 设置，不会直接继承 `env.production` 的 DB、KV、vars 或生产流量路由。不要为自动构建固定 `--name pr-21`，让 Cloudflare/Wrangler 按分支选择预览名称。

`pnpm --filter @sub2api/worker exec` 在 Worker workspace 使用锁文件固定的 Wrangler 和配置文件。

旧 Builds 项目可能还需要在 Dashboard 完成 **Set up Worker Previews**，之后启用预览分支构建；详见 [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)。当前 `previews` 未显式配置 vars 或 Secrets，它们需要在 Preview base config / Preview Secrets 中具备，或通过预览专属配置提供。数据库迁移和指定资源的可访问性也需要确认。

`preview` 会上传并创建或更新远端预览，没有 `--dry-run` 选项。Preview 创建后，核对预览 URL、绑定、迁移状态和所需 Secrets，再进行功能验收。
