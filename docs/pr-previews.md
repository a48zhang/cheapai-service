# PR 预发

本项目不启用自动预发。2026-10-17 已关闭 production Worker 的 Cloudflare 原生 Preview 总开关，并移除 Worker 级 Builds 配置；回读确认父配置及 12 个自动生成的分支构建配置均已不存在。单独删除分支触发器不足以停用预发，父级配置仍可能为新 PR 创建触发器。

GitHub Actions 保留类型检查、测试、lint、构建、浏览器验收及相关 Desktop 构建。PR 分支不部署、不执行远程 SQL；合并到 main 后由 [Production release](../.github/workflows/production-release.yml) 自动迁移并正式发布，详见[部署步骤](deployment.md)。

此次清理仅涉及 Cloudflare Builds 配置；生产 Worker 本体、数据库、KV、Secrets、仓库连接和历史构建记录保留。旧提交上的失败构建记录不会随配置删除而消失。
