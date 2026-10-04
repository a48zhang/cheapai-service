# 桌面账号后端集中验证

日期：2026-10-04 UTC。Linux x64，Node 24.19.0。状态：**partial**，D1/Workers 模块行为验收未通过。

`pnpm run typecheck:cloud` 直接入口因 workspacePackagePatterns 与旧安装图不一致退出 1，提示 pnpm install。没有关闭依赖检查；随后用已安装的真实 bin 对完整原云端模块集中检查：

| 检查 | 实际结果 |
| --- | --- |
| Worker tsc --project apps/worker/tsconfig.json --noEmit | 退出 0。真实 contracts workspace 链接解决了前次缺包错误。 |
| Web vue-tsc --project apps/web/tsconfig.json --noEmit | 退出 0。 |
| apicompat tsc --project packages/apicompat/tsconfig.json --noEmit | 退出 0。 |
| contracts 类型/构建 | 两者退出 0。 |
| 原云端构建 | apicompat tsc、Web vite build、Worker wrangler deploy --env= --dry-run 均退出 0。未部署。 |
| 全部 Node 用例 | 49 文件/1776 通过，1 桌面对话 suite 缺新 DSH 依赖而未加载；见 runtime.md。 |
| 全部 Workers 用例 | `vitest run --project workers` 退出 1，执行器启动时 listen EPERM 127.0.0.1，无成功用例数。 |

迁移源码覆盖 0001–0024；执行器未启动，不能声称本轮 0024 已应用到 D1 fixture。并发 Key、首次/自然到期、撤销、隔离、响应丢失、网关/计费链测试已编写，但仍待可绑定本地端口的环境执行。

旧云端依赖已安装，桌面新 importer/锁仍未生成；本轮未改供应链年龄、allowBuilds、TLS、strict peer 或生产 TTL。网络诊断为代理拒绝连接与直接 DNS 不可用；离线锁尝试此前因缺 registry 元数据超时，锁文件保留原值。

仅本地隔离检查；没有生产数据库、迁移、授额、真实上游、发信或发布。日志保存在忽略目录 work/desktop-validation/final/。
