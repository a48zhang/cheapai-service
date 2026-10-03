# 初始管理员

首次部署的完整顺序见[管理员上手指南](admin-guide.md)；本地迁移和服务须使用同一个状态目录，见[本地开发](development.md)。本文只处理第一个管理员，不负责渠道、授权、授额或密码恢复。

脚本只创建第一个管理员；存在任意管理员（包括已停用的管理员）时不再创建，不会重设密码或提升既有普通用户权限。没有公开初始化接口，也没有默认密码。

先使用工程固定的 Node 版本并安装依赖，应用目标 D1 的全部缺失迁移，当前源码范围为 `0001`–`0023`；升级已有环境先读实际迁移水位并备份。默认组必须存在且启用。运行前核对 Wrangler 配置中的 DB 绑定；远程资源占位 ID 必须先替换。

```powershell
node scripts/bootstrap-admin.ts --local
# 如果本地 Worker 使用自定义状态目录，两者必须一致：
node scripts/bootstrap-admin.ts --local --persist-to .wrangler/my-local-state
```

在交互终端输入邮箱及两次密码。密码不回显、不接收命令行或环境变量输入；复用业务的邮箱规范化、密码策略与 Argon2id 实现。管理员从零余额开始，邮箱保留未验证，不消耗注册码、不自动开放注册。登录验证使用与 `PUBLIC_BASE_URL` 一致的可信 HTTPS，保留 Secure Cookie 与 Origin/CSRF 约束。

准备好远程资源后，部署者可显式执行以下命令。它会写入所选环境，日常本地实现和测试不会自动运行它：

```powershell
node scripts/bootstrap-admin.ts --remote --env staging
node scripts/bootstrap-admin.ts --remote --env production
```

一次条件 INSERT 同时检查既有管理员、邮箱唯一性与默认组，避免两个初始化进程各创建一个管理员。脚本不直接修改余额、注册设置或既有账户。管理员密码摘要暂存为仅包含本次 SQL 的临时文件，通过 Wrangler 写入后清理；明文密码不写文件，数据库只保存摘要。不要将终端调试输出或 Wrangler 日志对外分享。

命令失败或超时且提交结果不确定时，先检查目标 D1 是否已存在本次管理员，再尝试登录。脚本不会自动重试；再次执行也不会覆盖既有管理员。管理员被停用或忘记密码需要单独的受控恢复操作，本脚本不承担恢复功能。
