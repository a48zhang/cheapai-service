# cheapai PR #5 预发个人控制台 V-02

- 预发：`https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev`
- 部署提交：`a3f7bdaab508253d10099c15f2215699ab3b3344`，个人脚本先校验了清单中的相同 SHA。
- 执行时间：2026-10-04 01:42 UTC。
- 身份：本轮 personal 普通用户。账号凭据、邮箱、用户 ID、Cookie、CSRF token 和 Key 明文均未写入报告或日志。
- 上游模型调用：0 次。

## 实际结果

| 案例 | 结果 | 证据 |
| --- | --- | --- |
| 登录 | 失败后恢复 | 首次正常登录请求返回 HTTP 503；当时脚本未记录响应 envelope/request ID，未据此推断根因。一次正常重试返回 200，角色为普通用户，request ID `498f927a-ea58-4d66-ac19-bbcdaf634e6a`。未发送错误密码或做重复尝试。 |
| 账户概览 | 通过 | 账户余额和最近请求均成功读取；balance request ID `99329d69-09a2-44ec-b042-0cacf066b187`，最近请求 request ID `995c466d-5c85-40e1-bb46-f2d0001380eb`。 |
| Key 创建与一次性明文清理 | 通过 | UI 创建请求返回 201，整个运行只发送一次创建请求。密钥只在内存中检查形状；关闭弹窗、刷新页面后不再出现在 UI、Web Storage 或 Key 列表响应中。没有截图或输出明文。 |
| Key 组限制 | 通过 | 创建请求的 `groupId` 与选中的授权组相同，刷新后 Key metadata 的 `groupId` 也匹配。该 Key 的 `allowedModels` 为 `null`，因此限制范围是所选组内的模型，没有设置组内单独模型白名单。创建后的 Key 列表 request ID `9c1edda3-faeb-4020-8e25-74665f0b9416`。 |
| 个人请求列表、游标与详情 | 列表通过；详情阻塞 | 列表 API 返回 200，当前首屏 `items=0`、`nextCursor=null`，request ID `29bcba80-4bc9-4fb0-81a5-9aee0cb1667f`。无本轮个人请求记录，无法验证详情深链或下一页；未用其他 lane 的记录替代。 |
| 个人账单与请求关联 | 列表通过；关联阻塞 | 账单 API 返回 200，当前结果 `entries=0`，request ID `ad00a314-6ca4-4e77-9ede-500b9bc2cc84`。没有本人的 request ID 可用于账单筛选关联。 |
| 本轮 Key 撤销与核对 | 通过 | 首次运行的清理段在页面导航后立即查询行，未等待列表载入，报告了未确认。独立清理脚本等待 Key 列表及目标行出现后撤销成功，request ID `0969c5af-7764-44c4-b574-ab3d6d24d267`；随后 `state=active` 查询确认本轮命名空间下有效 Key 数为 0，request ID `f301e173-322a-4b17-9dbd-ce0d2526a5d6`。这是脚本等待时序问题，清理已完成。 |

## 执行边界与问题

登录和业务步骤均通过真实预发浏览器及 Worker API 执行。浏览器沿用 `HTTPS_PROXY` 和现有 NSS 信任，TLS 校验开启；未用 `ignoreHTTPSErrors`、证书忽略参数、模型供应商调用或本地 `__test__` API。临时浏览器 profile 在结束时删除，没有保存 storageState。

首次登录 503 是本轮实际观察到的瞬时失败；一次正常重试后登录成功。现有证据不足以确认根因，因此记录为待查现象，不归类为已确认产品缺陷。

凭据就绪链路、修正后的清理等待和单独撤销脚本保存在 `/tmp/cheapai-preview-run/personal/`，目录权限 0700、脚本权限 0600。脚本以 `body.request_id` 提取 request ID，不将它误读为 Worker envelope 的 `requestId` 字段。没有本轮个人请求或账单记录，因此详情和 requestId 账单关联仍未覆盖。
