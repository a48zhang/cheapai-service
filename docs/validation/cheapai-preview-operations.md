# V-05 预发管理运营

状态：管理运营主链路与多组授权补充链路均通过；本轮用户及临时组已清理到停用状态。

- 预发：<https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev>
- 本轮管理链路部署提交：`a3f7bdaab508253d10099c15f2215699ab3b3344`
- 运行：`qa-pr5-20261004`
- 主链路执行时间：2026-10-04 01:41:41–01:41:55 UTC
- 多组授权补充链路：2026-10-04 01:45:26–01:45:31 UTC
- 浏览器：Chromium `/usr/bin/chromium`，使用既有代理和 NSS 信任，TLS 校验保持开启。

## 本轮管理运营链路

在管理员登录后创建了本轮专属普通用户，只使用服务端默认组 `default`，初始状态为 active、余额为 0。随后将该用户的组授权设为仅含默认组，限制设为 concurrency `2`、RPM `10`；详情读取确认授权和限制生效。用户状态按 active → disabled → active 切换，链路结束时仅停用本轮用户。多组授权由后续独立 fixture 子链路补验。

用户 ID：`6f0316a9-6640-45c2-b62e-775fd22557a6`。创建 request ID：`84b05199-2474-462b-8970-f9ae385caf05`；授权/限制更新：`3a49398d-0fcb-41cd-9ce1-ad0ec62676f9`；停用：`d0e845e2-66b2-409c-9c4e-3af19c4d4a82`；启用：`5060e6d2-cf62-4b44-975e-c8a4a914b962`；最终清理停用：`2bd3c849-b340-4f35-822c-6be270c529e1`。最终状态为 disabled。

对该用户授予 `1,000,000` 个 USD 最小单位，等于 `$0.01000000`。首次结果为 `inserted`，同一幂等键重放返回 `existing`，两次指向同一账本条目；管理员账单查询中该 operation 仅有一行、delta 为 `1000000`。额度 operation ID：`balance:f098fb2b6efb37f1065bd1de7b8932089b03af87d2204346ce2766477c87b82d`；账本 entry ID：`be8c7e4a-380c-4f1f-a754-71dcaeb6ac49`。

通过邀请码管理 UI 一次创建 2 枚邀请码。初次结果页显示一次性秘密；刷新后页面和列表 API 均不再包含明文。随后逐枚撤销，两个结果均为 `revoked`，列表状态核对通过。**本报告及附件不包含邀请码明文。** Batch ID：`6f17e9a4-e37d-4759-898a-4da54d168475`；Code ID：`de24f336-d1f1-454a-9e74-c331fac44e80`、`46a9d2a2-e04a-4fcc-8ceb-276f6b9011d3`；创建 request ID：`592286cd-5cd3-4e17-9588-6d700c9a1827`。

创建用户、三次用户更新、余额授予和邀请码批次的审计查询全部匹配对应用户/operation/目标。注册设置仅 GET 读取：`registrationMode=closed`、`emailVerificationEnabled=true`、`version=1`；前后值一致。没有注册用户，也没有 PATCH 全局注册策略或邮件配置。

主链路记录 28 次管理 API 调用，真实供应商 `upstreamCalls=0`，没有发出模型推理。操作结果和资源清单保存在 `/tmp/cheapai-preview-run/operations/`，权限为受限模式；结果文件只含本轮资源 ID 和脱敏状态，不含账号凭据或邀请码明文。

## 多组授权补充链路

在协调者授权后，复用上面的本轮用户 `6f0316a9-6640-45c2-b62e-775fd22557a6`，创建唯一命名的隔离副组 `qa-pr5-20261004-ops-2ec66850f8`。该组仅用于本轮，创建时 `billingMultiplier=1`、`channelIds=[]`，没有关联模型或渠道。用户在补验开始时已停用；临时将 `allowedGroupIds` 扩为 `[default, 6012aa28-d558-46bd-a7a0-982a249a4825]` 后，读取确认副组出现在授权列表且 primary `group_id` 仍是 `default`。随后将授权恢复为仅 `default`，停用副组，并再次确认用户仍为 disabled、primary 组仍为 `default`、授权列表仅含 `default`。新组和用户的审计均匹配。

副组 ID：`6012aa28-d558-46bd-a7a0-982a249a4825`；创建 request ID：`08896107-7273-4db2-84c3-33cb22b7291c`；临时增加授权：`224af526-6b24-4311-9b04-56167df54648`；恢复默认授权：`277fc6c2-748e-49f6-a0b8-7b4d773ec1e3`；停用副组：`5bed8ec4-f630-4b61-8094-b1f764af1fa0`。副组清理后状态为 disabled，渠道列表仍为空；用户最终状态为 disabled。

补充链路记录 15 次管理 API 调用，`upstreamCalls=0`。两条运营链路共 43 次管理 API 调用；没有调用模型供应商，也没有重复执行授额或邀请码操作。

## 未认证只读预检（早期部署）

以下证据来自部署提交 `a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`，执行于 2026-10-04 01:21 UTC；它与上面的管理业务链路部署分开记录。公开 `GET /api/v1/settings/public` 返回 `200`、`Cache-Control: no-store`，显示注册模式为 closed、邮箱验证启用。CSRF nonce 与 cookie 未写入报告。

未认证身份和管理查询 API 均返回 JSON `401 unauthorized`，带 `Cache-Control: no-store`：

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

在无 cookie 的 Playwright context 中依次打开 `/admin/users`、`/admin/billing`、`/admin/audit`、`/admin/registration/settings` 和 `/admin/registration/codes`。各页面加载后，`GET /api/v1/auth/me` 返回 `401`，客户端转到 `/login` 并保留相应 `returnTo`；未见管理数据泄露。

最短复现：以全新无 cookie context 打开 `/admin/users`，确认 `GET /api/v1/auth/me` 返回 `401 unauthorized`，随后地址变为 `/login?returnTo=%2Fadmin%2Fusers`。直接请求 `GET /api/v1/admin/users?limit=1` 同样返回 `401`，request ID 为 `c447ea07-486f-4e4e-b862-28b9492e5785`。未认证拒绝符合预期，没有记录到 V-05 权限缺陷。
