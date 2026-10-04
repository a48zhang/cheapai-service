# cheapai PR #5 V-01 身份与权限验证

本报告保留较早部署的公开检查记录，并单独报告当前预发部署上的结果。测试凭据只由进程读取；报告、结果文件和截图均不包含邮箱、密码、会话 cookie、CSRF token 或 API key token。

## 当前预发结果

执行日期：2026-10-04 UTC
预发：https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev
部署 SHA：a3f7bdaab508253d10099c15f2215699ab3b3344
执行清单：qa-pr5-20261004

当前部署上重新执行的公开检查：

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| PUB-01 HTTPS 登录页 | 通过 | 页面与邮箱、密码、登录控件均返回并可见；HTTP 200。截图：/tmp/cheapai-preview-run/auth/01-login-public.png。 |
| PUB-02 未认证管理深链 | 通过 | 打开管理深链后到达登录页，完整站内路径保留在 returnTo；HTTP 200。截图：/tmp/cheapai-preview-run/auth/02-unauth-deep-link.png。 |
| PUB-03 公开配置与 CSRF bootstrap | 通过 | HTTP 200，Cache-Control 为 no-store；注册模式 closed，邮件验证启用；浏览器端 CSRF 值格式正确且 cookie 可读，报告未记录其值。request ID：994ff6c1-3523-493e-8a71-a6447fe338e6。 |
| PUB-04 未认证 /auth/me | 通过 | HTTP 401 unauthorized，JSON 且 no-store。request ID：389969a7-5228-4b5c-8ee5-f41e65e7ea4c。 |
| PUB-05 未认证管理 API | 通过 | HTTP 401 unauthorized，JSON 且 no-store。request ID：ba0dec94-9d34-46c8-a743-6ebd812ada2e。 |
| PUB-06 匿名写入缺少 CSRF | 通过 | POST /api/v1/auth/logout 返回 HTTP 403 forbidden。request ID：c7e31461-fce7-497f-8158-b71fc2800276。 |
| PUB-07 匿名写入使用错误 CSRF | 通过 | POST /api/v1/auth/logout 返回 HTTP 403 forbidden。request ID：68571863-c6ad-427e-abf5-2bc228bff95f。 |

### 已认证链路

Chromium 浏览器表单登录的一次授权重试返回 HTTP 503 service_unavailable，request ID 为 e4fe7899-dff9-45d9-8876-60f736fa76aa。随后 /auth/me 返回 401 unauthorized（request ID：eb3cc5ee-83e5-46d4-bd4a-353ddc43ad57），浏览器仍停在 /login，因此没有建立会话，浏览器表单成功登录后的 returnTo 行为未验证。按协调者的单次诊断授权，Playwright API transport 对同一 auth 普通用户提交一次登录，返回 HTTP 200，role 为 user、status 为 active；request ID 为 01015826-4fe9-4456-82d3-2d5929473b62。输入与私有凭据文件相符，结果只记录布尔值。API 返回的 cookie state 仅在进程内存中传给新的 Chromium context，没有写入磁盘。

这两个结果分开记录：浏览器表单登录返回了 503，API transport 登录成功。worker 登录边界会把 PasswordBusyError 以及 D1、Durable Object、crypto 等运行时错误映射为同一个 service_unavailable 响应；公开响应不足以确认本次 503 的内部原因。源码中的 Argon2 KDF 每 isolate 并发上限为 1，因此并发忙碌是可能原因，但本次证据不能证实它。没有再次提交浏览器登录。

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| auth API 登录 | 通过 | HTTP 200，active 普通用户；request ID：01015826-4fe9-4456-82d3-2d5929473b62。 |
| auth session 导入独立浏览器 context | 通过 | 导入后 /auth/me 为 HTTP 200。request ID：67d363b4-3917-4b96-ab29-f820625f07df。 |
| auth 刷新后会话恢复 | 通过 | 刷新后 /auth/me 为 HTTP 200。request ID：d4e1a5e5-606e-43c2-91fe-7fe8186867ad。 |
| 普通用户管理页面/API 拒绝 | 通过 | 管理页面显示无权访问；GET /api/v1/admin/channels 返回 HTTP 403 forbidden。request ID：6ef06d18-3975-44e8-935b-76007b1cdf6a。 |
| 登录态写入缺少 CSRF | 通过 | POST /api/v1/auth/logout 返回 HTTP 403 forbidden。request ID：3f926e1f-4314-48ba-83fc-93fcfb1d29be。 |
| 登录态写入使用错误 CSRF | 通过 | 同一路径返回 HTTP 403 forbidden。request ID：0abb8c7e-24a7-4d94-abd9-6e580b84dd30。 |
| CSRF 拒绝后会话仍有效 | 通过 | /auth/me 仍返回 HTTP 200。request ID：469f7b7a-3488-4d60-b5b7-9c61a558e72f。 |
| auth 退出登录 | 通过 | UI 退出后 /auth/me 返回 HTTP 401 unauthorized。request ID：6c8d7d34-071d-4c38-ac15-77a4db8433a7。 |
| auth 浏览器表单登录后的 returnTo | 阻塞 | 表单登录返回 503，没有成功会话可验证登录后的回跳；未将匿名 deep link 检查替代为已认证回跳。 |

personal 与 chat 各自在独立浏览器 context 中登录一次，HTTP 200，角色为普通用户且状态 active。两者登录后均恢复了各自的 dashboard returnTo；退出后 /auth/me 均返回 401 unauthorized。personal 的请求 ID 为 8c20cc4e-5bdd-47cb-9cc5-1d4f21e27299，chat 的请求 ID 为 5a413a38-6d0c-4f92-bfc3-df1d29f0a648。三种成功会话均已退出。

### 所有权检查与清理

每项跨用户 404 都先由资源 owner 使用当前创建的资源 ID 得到 HTTP 200；没有把不存在的 ID 当成所有权通过。

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| auth 自有 key | 通过 | 本轮创建的 key 由 auth owner 读取为 HTTP 200；request ID：87b70fdd-dab0-4d7c-b835-5104a9efbdfe。 |
| personal 读取 auth key | 通过 | 使用 auth owner 已确认的 fixture ID 返回 HTTP 404 not_found。request ID：2fc38e7e-2e3b-48db-9cbf-61bc71e7f827。 |
| personal 自有 key 反向隔离 | 阻塞 | 只读数量预检发现 personal 已有 1 把 key；未读取、创建或修改它。该账号作为 owner 的反向检查没有执行，也没有将 404 记为通过。 |
| auth 与 chat 空会话相互隔离 | 通过 | 双方各自的空会话先由 owner 读取为 HTTP 200，再由另一身份读取为 HTTP 404 not_found。 |
| request 记录所有权 | 阻塞 | chat 用户可用模型数量为 0；本轮没有运行真实推理、创建 request 记录或借用历史记录。模型清单 request ID：6c7314b0-cc3d-4f07-8ecb-205154a33ee3。 |

清理已确认：auth fixture key 返回 revoked；auth 与 chat 的空会话均返回 deleted=true。fixture ID、版本和清理标志保存在权限为 0600 的 /tmp/cheapai-preview-run/auth/fixture-cleanup.json；没有保存 key token。personal 现存 key 未被读取或修改。协调者在本 lane 完成后停用了专用 auth、personal、chat 测试账号。

### 执行与限制

HTTPS 请求经过会话 HTTPS 代理，TLS 校验保持开启。Chromium 使用系统已有 CA/NSS 信任库和 --no-sandbox；执行授权只用于访问现有信任库，没有改写 HOME、导入证书或设置 TLS 绕过选项。Playwright API request context 使用默认 TLS 校验。没有发起模型推理，没有改动用户资料、注册设置或产品源码。

完整脱敏结果位于 /tmp/cheapai-preview-run/auth/results.json。测试脚本位于 /tmp/cheapai-preview-run/auth/validate.cjs。

## 较早部署的公开证据

2026-10-04 01:15 UTC，SHA a68dc9d30c4c2a343ec62e3590548c9f05e08ccd 上的 PUB-01 至 PUB-07 曾全部通过。其 request ID 保留在原始报告记录中，仅作为较早部署证据；当前结论以上方 a3f7bdaab508253d10099c15f2215699ab3b3344 的复测为准。
