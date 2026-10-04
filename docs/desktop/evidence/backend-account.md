# 桌面账号后端集中检查

日期：2026-10-04。执行时后端源码与测试基于桌面检查点 `d338460db185a9935a08fe6adeb62b4b59ce6087` 与 main `9b3038c9ec53d8dcb5b05f1424242654d1ff2616` 的本地合并提交 `b42d1ea`。随后单文件补充了 AT01-managed-key 行为测试；该新增用例没有执行，后端实现源码未变。

状态：**partial，尚未通过模块验收**。仅本地命令，不部署、不调用真实上游或发送邮件。

| 检查 | 实际结果 |
| --- | --- |
| Worker 类型检查 | `./node_modules/.bin/tsc --project apps/worker/tsconfig.json --noEmit` 退出 2。两处 TS2307 均为尚未安装/链接的 `@sub2api/desktop-contracts`，位于桌面 account/login 类型导入。F05 依赖准备仍阻塞。 |
| Workers 集中测试 | 新增四文件及受影响的 login/login-routes/session-routes/tokens/key-repository/api-key-auth/channel-secrets/scheduled cleanup/integration，在一次 Vitest workers 调用中选择。退出 1，执行器在测试启动前因 `listen EPERM 127.0.0.1` 退出，没有通过用例数。 |
| Worker 本地构建 | 在 `apps/worker` 执行 `wrangler deploy --env='' --dry-run --outdir ../../work/desktop-validation/worker-dist`，退出 0。使用工作区内 XDG_CONFIG_HOME 与 WRANGLER_LOG_PATH，未发送部署请求。 |

迁移加载范围为源码 0001–0024；因为 Workers 执行器没有启动，**不能声明 0024 已在本轮 D1 测试中应用**。并发 Key、自然过期、响应丢失重试、多端隔离、父会话鉴权和计费链的测试已编写并核对范围，但本轮均未实际执行成功。

F05 准备尝试：普通 pnpm 的默认缓存路径不可写；将缓存和 store 指向工作区后，即使指定离线锁文件模式，锁文件供应链策略仍尝试获取缺失 registry 元数据并遭遇 EPERM。命令由 30 秒上限终止（退出 124），未生成新的锁文件，未放宽依赖年龄或 allowBuilds 策略。

首次 dry-run 从仓库根目录误选工作区、随后默认 Wrangler 配置目录不可访问；指定正确 Worker 目录与工作区配置目录后构建成功。类型检查和 Workers 测试仍需在 F05 完成且执行器支持本地端口后集中补验，不能用构建结果替代。

本地详细日志位于忽略目录 `work/desktop-validation/`；报告不包含凭据或原始登录响应。macOS/Windows、Rust 构建、真实 DSH/模型、生产迁移与发布均未执行。
