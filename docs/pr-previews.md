# PR 预发

本项目不启用自动预发。2026-10-17 已关闭 production Worker 的 Cloudflare 原生 Preview 总开关，并移除 Worker 级 Builds 配置；回读确认父配置及 12 个自动生成的分支构建配置均已不存在。单独删除分支触发器不足以停用预发，父级配置仍可能为新 PR 创建触发器。

GitHub Actions 保留类型检查、测试、lint、构建、浏览器验收及相关 Desktop 构建。PR 分支不部署、不执行远程 SQL；合并到 main 后由 [Production release](../.github/workflows/production-release.yml) 自动迁移并正式发布，详见[部署步骤](deployment.md)。

重新配置 Cloudflare 原生 Preview 时，需要使用 Worker workspace 中安装的 Wrangler，明确目标 Worker、配置文件及预发的环境变量、Secrets 和数据库绑定。`pnpm run deploy` 是正式发布命令，不是 PR Preview 命令；详见[部署步骤](deployment.md)。

## Cloudflare Workers Builds 自动 Preview

2026-10-18 已将 Worker workspace 的 Wrangler 固定为 4.151.1，该版本的 `wrangler preview` 标记为 open beta。仓库的顶层 `previews` 包含指定的 CACHE、DB、GATE 资源和可观测性设置；关闭问题检测使用该版本支持的 `observability.issues.enabled: false`。

针对当前 Dashboard 的根目录 `/`、构建命令 `pnpm run build`，Workers Builds 应使用以下设置：

| 设置 | 值 |
| --- | --- |
| 根目录 | `/`（仓库根目录） |
| 构建命令 | `pnpm run build`（Worker 步骤为 dry-run） |
| 生产分支 Deploy command | `pnpm run deploy` |
| 非生产分支 Preview command | `pnpm --filter @sub2api/worker exec wrangler preview --env production` |
| 分支控制 | 启用 Enable Preview Builds |

这里的 `production` 是仓库已有的 Wrangler 配置段，用于选中父 Worker `sub2api-cloudflare-production` 及公共构建设置。真正决定操作的是子命令：`deploy` 发布 Worker，`preview` 创建分支预览。原生 Preview 使用独立 `previews` 设置，不会直接继承 `env.production` 的 DB、KV、vars 或生产流量路由。不要为自动构建固定 `--name pr-21`，让 Cloudflare/Wrangler 按分支选择预览名称。

根目录未安装 Wrangler，配置文件也位于 Worker workspace，原先的裸 `npx wrangler preview` 不是该目录下可靠的调用方式。`pnpm --filter @sub2api/worker exec` 会进入正确的 workspace 并使用锁文件固定的 Wrangler。若将 Builds 根目录改为 `apps/worker`，Preview command 才可简写为 `npx wrangler preview --env production`。

Cloudflare 官方的 [Preview command 文档](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#preview-command) 明确支持 `wrangler preview --env <环境名>`。若以后把父 Worker 的公共配置提升到顶层，才可以相应简化为默认的 `npx wrangler preview`；当前顶层仍是 local 占位配置。Workers Builds 注入的父 Worker 名称覆盖也不等于选择了完整的命名环境配置。

旧 Builds 项目可能还需要在 Dashboard 完成 **Set up Worker Previews**，之后启用预览分支构建；详见 [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)。当前 `previews` 未显式配置 vars 或 Secrets，它们需要在 Preview base config / Preview Secrets 中具备，或通过预览专属配置提供。数据库迁移和指定资源的可访问性也需要确认。

`preview` 会上传并创建或更新远端预览，没有 `--dry-run` 选项。命令帮助、前端构建和 `deploy --dry-run --strict` 已在本地验证；这不证明远端 Preview 已成功创建。本次未修改 Dashboard 的 Builds 设置，也未创建远端预览。

移除构建触发器不会删除 Worker、数据库、KV、Secrets、GitHub 仓库连接或历史构建记录；本次未修改这些资源。
