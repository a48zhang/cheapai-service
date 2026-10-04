# cheapai PR #5 预发个人控制台 V-02

- 预发：`https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev`
- 部署提交：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`；本地 `HEAD` 与清单一致。
- 执行时间：2026-10-04 01:16 UTC。
- 身份：未认证访客。未创建账号、未登录、未写入远程数据；上游调用 0 次。

## 实际结果

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| 个人页面文档 GET：`/dashboard`、`/keys`、`/requests`、`/requests/<probe-id>`、`/billing` | 通过 | 全部返回 `200 text/html`，标题 `cheapai`。文档状态只说明 SPA 外壳可访问。 |
| 浏览器未认证访问个人路由 | 通过 | Chromium 逐页访问上述五条路由，页面文档均为 200，`GET /api/v1/auth/me` 均为 `401 unauthorized`，随后页面到达 `/login`。 |
| 详情深链回登录页 | 通过 | 直接访问 `/requests/qa-pr5-20261004-v02-unauth-probe?status=failed` 后，登录页 `returnTo` 完整保留路径和查询参数。成功登录后的回到详情页未执行。 |
| 个人 API 未认证访问 | 通过 | 余额、可用组、Key 列表、请求列表、请求详情和账单 API 均拒绝匿名访问，状态码为 401，错误码为 `unauthorized`。 |
| 登录后概览、Key 生命周期/组限制、个人请求列表与详情、账单及请求关联 | 阻塞 | `/tmp/cheapai-preview-run/manifest.json` 的 `credentialsStatus` 仍为 `blocked-cloudflare-auth`；远程 personal 用户尚未创建。未尝试登录，也未创建测试 Key。 |

匿名 API 的 request ID：

| API | 状态 | request ID |
| --- | --- | --- |
| `/api/v1/auth/me` | 401 `unauthorized` | `b0049a5a-ca98-41ae-b36c-b87ddbf7e415` |
| `/api/v1/account/balance` | 401 `unauthorized` | `bf9b0198-70e5-49fb-b7a5-f374fe8f6690` |
| `/api/v1/account/key-groups` | 401 `unauthorized` | `e6c95092-d4b2-4d7f-8abb-1c04ef06936b` |
| `/api/v1/keys` | 401 `unauthorized` | `3cee435e-90d6-4a58-8afc-0c94a983c404` |
| `/api/v1/usage/requests?limit=1` | 401 `unauthorized` | `74ca78e2-0eda-4bbf-821a-578586121068` |
| `/api/v1/usage/requests/<probe-id>` | 401 `unauthorized` | `f06c1003-30fe-4a8e-b7a0-9c7b4cb257f9` |
| `/api/v1/billing/entries?limit=1` | 401 `unauthorized` | `d47598bb-82e7-4116-b8dc-de1e6f18ae22` |

## 执行边界与后续准备

浏览器流量使用继承的 `HTTPS_PROXY` 和现有 CA 信任，TLS 校验保持开启；未使用 `ignoreHTTPSErrors` 或证书忽略参数。浏览器仅使用临时 `/tmp/cheapai-preview-run/personal` profile，结束后清理。未改写 HOME 或 NSS 信任库。

未认证浏览器脚本、API 探针和凭据就绪后的独立链路脚本保存在 `/tmp/cheapai-preview-run/personal/`，权限为目录 0700、脚本 0600。凭据链路脚本要求清单 `credentialsStatus=ready`、显式 `PERSONAL_CREDENTIALS_READY=1`、personal 角色为普通用户且 `accounts.json` 权限不宽于 0600 才会登录。它只用 personal 用户数据，并在成功创建 Key 后验证明文关闭/刷新清理、组绑定、请求与账单读取，最后撤销本轮 Key；不会进行模型上游调用。脚本已通过 `node --check`，没有运行本地测试套件。

此轮没有确认真实产品缺陷。后续收到可用的 personal 用户凭据和就绪通知后，需执行被阻塞的登录后链路；若该用户没有本人请求记录，请求详情及请求账单关联继续标记阻塞，不用其他 lane 的数据代替。
