# V-05 预发管理运营

状态：阻塞（未认证预检完成；管理员业务链路未执行）

- 预发：<https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev>
- 部署提交：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`
- 执行时间：2026-10-04 01:21 UTC
- 运行：`qa-pr5-20261004`
- 浏览器：Chromium `/usr/bin/chromium`；通过配置代理访问，沿用现有 CA 并保持 TLS 校验。

## 已执行的只读预检

`GET /api/v1/settings/public` 返回 `200`、`Cache-Control: no-store`。匿名可见的注册模式为 `closed`，邮箱验证为启用。该响应 request ID 为 `32bea0dd-4485-4ddd-b214-13b70ea0f232`。响应含 CSRF nonce 和 cookie；脚本只记录“存在”，没有保存或输出 nonce/cookie。没有调用注册、发信、模型或管理写接口。

未认证身份和管理查询 API 全部返回 JSON `401 unauthorized`，带 `Cache-Control: no-store` 和服务端 request ID：

| API | HTTP / 错误 | request ID |
| --- | --- | --- |
| `GET /api/v1/auth/me` | `401 unauthorized` | `c2a534e8-05a7-4d62-b86e-bdb431ae6a32` |
| `GET /api/v1/admin/users?limit=1` | `401 unauthorized` | `c447ea07-486f-4e4e-b862-28b9492e5785` |
| `GET /api/v1/admin/users/qa-pr5-preview-missing` | `401 unauthorized` | `3a3d491e-6b86-4285-8908-904fa3d0ef1f` |
| `GET /api/v1/admin/billing/entries?limit=1` | `401 unauthorized` | `5ff35ae1-a73a-42cc-93f8-104a2c03e996` |
| `GET /api/v1/admin/billing/reconciliation?limit=1` | `401 unauthorized` | `b087fc6b-0b37-45e7-be7b-bfb46f7a5fd1` |
| `GET /api/v1/admin/audit?limit=1` | `401 unauthorized` | `b6fe7745-41d0-49c8-a655-ce41e7416fc6` |
| `GET /api/v1/admin/registration/settings` | `401 unauthorized` | `04e7d86d-064a-4e79-acd2-b6d2f6cfebbf` |
| `GET /api/v1/admin/registration/codes?limit=1` | `401 unauthorized` | `7c49b0c7-3804-41fe-a91d-33fd02eb8edd` |

Playwright 在全新 context 依次打开 `/admin/users`、`/admin/billing`、`/admin/audit`、`/admin/registration/settings` 和 `/admin/registration/codes`。每个页面入口返回 `200`；客户端调用 `/api/v1/auth/me` 得到 `401` 后，均落到 `/login`，并保留对应的 `returnTo`。登录页标题为 `cheapai`，主标题为“欢迎回来”。深链没有泄露任何管理数据。

## 登录与写入阻塞

清单当前 `credentialsStatus` 为 `blocked-cloudflare-auth`，管理员账号尚未创建。没有可用于登录的管理员凭据，因此登录、授权组/限额、用户停启、授额、账本/审计核对、邀请码创建/撤销都标记为阻塞，未执行。当前公开注册策略为关闭，未尝试注册，也没有修改全局策略、默认组或既有用户。

为遵守本轮远程写入禁令，没有发送 POST、PATCH 或撤销请求。对代码路由的只读核对显示，用户创建/更新、用户余额调整、注册设置更新、邀请码创建/撤销都先经过 `requireSession` 与 `requireAdmin`，然后才验证 CSRF 和读取写入数据；这些写路由的匿名拒绝行为尚未在预发发送请求验证。

最短复现：用新的无 cookie 浏览器 context 打开 `/admin/users`，确认随后 `GET /api/v1/auth/me` 为 `401 unauthorized`，地址变为 `/login?returnTo=%2Fadmin%2Fusers`。直接 `GET /api/v1/admin/users?limit=1` 也返回 `401 unauthorized`，request ID 为 `c447ea07-486f-4e4e-b862-28b9492e5785`。

当前没有发现 V-05 相关的预发权限缺陷；其余管理业务状态待凭据和协调者后续开窗后执行。未认证探测原始脱敏结果及后续执行脚本位于 `/tmp/cheapai-preview-run/operations/`。
