# cheapai PR #5 V-01 身份与权限验证

执行时间：2026-10-04 01:15 UTC  
预发：`https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev`  
部署 SHA：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`  
执行清单：`qa-pr5-20261004`

## 公开身份链路

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| PUB-01 HTTPS 登录页 | 通过 | 真实 HTTPS 页面返回 200；“欢迎回来”、邮箱、密码和登录控件可见。截图：`/tmp/cheapai-preview-run/auth/01-login-public.png`。 |
| PUB-02 未认证管理深链回跳 | 通过 | 直接打开 `/admin/models/actions/create?qa-auth-return=1` 后到达 `/login`，`returnTo` 保留完整站内路径。截图：`/tmp/cheapai-preview-run/auth/02-unauth-deep-link.png`。 |
| PUB-03 公开配置与 CSRF 可读行为 | 通过 | `GET /api/v1/settings/public` 返回 200、`Cache-Control: no-store`；注册模式为 `closed`，`emailVerificationEnabled` 为 `true`。浏览器读到格式有效的 CSRF 值，且能读取对应 cookie；报告与日志均未记录其值。request ID：`3da8eb71-d28a-4a36-ba65-713b9cd25f0c`。 |
| PUB-04 未认证会话 API 拒绝 | 通过 | `GET /api/v1/auth/me` 返回 401 `unauthorized`，JSON、`no-store`。request ID：`9b020bcc-2d3b-4819-8ec2-38b6f2b06d1f`。 |
| PUB-05 未认证管理 API 拒绝 | 通过 | `GET /api/v1/admin/channels` 返回 401 `unauthorized`，JSON、`no-store`。request ID：`c7591ed5-4942-45ed-8781-c216de1f6973`。 |
| PUB-06 缺少 CSRF 的写入拒绝 | 通过 | 匿名浏览器对 `/api/v1/auth/logout` 发出不带 `X-CSRF-Token` 的 POST，返回 403 `forbidden`。request ID：`c2db3a6f-2bfe-4e42-9ebb-c386844af016`。 |
| PUB-07 错误 CSRF 的写入拒绝 | 通过 | 对同一路径发送格式有效但与 cookie 不匹配的 CSRF 值，返回 403 `forbidden`。request ID：`399cda9e-852e-486c-95b5-922202c94d90`。 |

两次 POST 都在 CSRF 校验阶段被拒绝；没有有效会话，未执行退出或其他数据变更。公开请求未发现产品缺陷。

浏览器使用系统 Chromium 和会话 HTTPS 代理，TLS 校验保持开启；没有设置 `ignoreHTTPSErrors` 或 TLS 绕过参数。受限执行沙箱不能读取 Chromium 已有 NSS 信任库，因此通过授权执行通道读取该现有信任库后完成验证；没有修改 NSS 数据库或 HOME。脚本、脱敏结果和截图位于 `/tmp/cheapai-preview-run/auth/`。

## 阻塞项

完整 V-01 暂未执行。清单中的 `credentialsStatus` 仍为 `blocked-cloudflare-auth`，测试账号尚未在预发创建；没有读取协调者的本地凭据文件，也没有提交登录请求。普通用户登录后的刷新恢复、深链登录后回跳、退出、管理页面/API 拒绝，以及跨用户 key、聊天和请求所有权检查均为阻塞，不能据公开链路结果推断通过。

待协调者把预发凭据状态更新为 `ready` 并通知执行后，可运行 `/tmp/cheapai-preview-run/auth/validate.cjs`。脚本只接受 manifest 指定的受限凭据目录，检查文件权限，并在 `credentialsStatus` 非 `ready` 时不打开凭据文件；每个账号只提交一次登录，失败不重试。它按 `accounts.auth`、`accounts.personal`、`accounts.chat` 读取本轮身份，并只读收集可用的 key、会话和请求 ID 做所有权隔离检查。
