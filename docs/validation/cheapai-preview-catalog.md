# cheapai PR 5 预发：V-04 管理资源

状态：公开访问与未认证拒绝已检查；管理员页面、资源写入和丢响应场景因当前会话没有 Cloudflare 预发管理员认证而阻塞。没有尝试登录，也没有远端写入。

## 验证基线

- 预发：<https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev>
- Worker 提交：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`；本地 `HEAD` 与该 SHA 一致。
- 本轮 owner 前缀：`qa-pr5-20261004`。
- `/tmp/cheapai-preview-run/manifest.json` 当前为 `credentialsStatus: blocked-cloudflare-auth`。
- 环境使用继承的 HTTP(S) 代理和配置的 CA。首页 `curl` 请求在默认 TLS 校验下返回 HTTP 200。管理深链用 Chromium 151、系统代理及现有 NSS 信任库访问；没有设置 `ignoreHTTPSErrors`，也没有改 CA、NSS 或 HOME。

## 已完成的只读检查

Chromium 对下列每个路径取得 HTTP 200 的 SPA 文档，随后 React 路由将浏览器导向 `/login`，显示 cheapai 登录页。没有提交登录表单。

| 深链 | 浏览器结果 |
| --- | --- |
| `/admin/channels` | `/login` |
| `/admin/models` | `/login` |
| `/admin/models/actions/create` | `/login` |
| `/admin/models/new` | `/login` |
| `/admin/groups`、`/admin/groups/new` | `/login` |
| `/admin/channels/qa-pr5-20261004-owned-channel` | `/login` |
| `/admin/models/qa-pr5-20261004-owned-model` | `/login` |
| `/admin/groups/qa-pr5-20261004-owned-group` | `/login` |

未带 Cookie 的 HTTPS `GET` 管理 API 均返回 JSON 401：渠道、模型、访问组列表，以及各自的详情端点。详情路径使用不存在的本轮占位 ID；响应未读取或打印任何数据主体。

## 部署源码发现

在给定 SHA 上，独立模型创建路由是 `/admin/models/actions/create`；`/admin/models/:id` 是详情路由，所以 `/admin/models/new` 按模型 ID `new` 进入详情读取流程。执行计划中的 `/new` 是路径笔误，不是该提交缺少创建功能。已将正确深链放入后续验证步骤。

渠道 `POST /api/v1/admin/channels` 每次都会分配新 UUID，没有幂等键。当前表单将传输失败等情况视为结果不确定：保留输入、禁止关闭和重试，并提示在新标签核对列表与审计。400、401、403、413、429 属明确拒绝，按源码逻辑不进入不确定态。V-04 的定向场景应对本轮唯一渠道名的第一次 POST 调用 `route.fetch()`，等服务端成功响应后仅丢弃浏览器收到的响应；随后通过管理列表分页精确查回这个名称，断言恰有一个匹配且创建按钮已禁用。不得再点创建。

## 凭据就绪后的 V-04 顺序

1. 协调者先将清单标为 `ready`，生成管理员 storage state（受限 credentials 目录、权限 0600），再明确通知启动。不要从 `accounts.json` 手动打印密码或将凭据放入报告。
2. 通过允许读取现有 Chromium NSS 信任库的审核命令运行 `/tmp/cheapai-preview-run/catalog/run-owned-channel-uncertain.mjs`，保持代理和 TLS 校验。脚本还要求显式 `--arm-owned-write`、协调者提供 `--storage-state <受限文件路径>`，并会拒绝重复运行。它只创建 `qa-pr5-20261004-catalog-channel`，为测试表单响应不确定使用新生成的随机占位凭证，不回显、不落盘、不复用既有渠道密钥。它不会诊断或调用上游。
3. 收到脚本记录的唯一 `channelId` 后，继续验证专属链路：从该渠道详情刷新并编辑优先级；在 `/admin/models/actions/create` 创建 `qa-pr5-20261004-catalog-model`，从模型详情创建 Chat 映射；从 `/admin/groups/new` 创建只关联该渠道的 `qa-pr5-20261004-catalog-group`。每次写后都从详情深链刷新核对。所有列表核对仅保留本轮精确资源的 ID 和状态。
4. 编辑本轮模型价格和访问组倍率，核对新版本；最后停用本轮组、模型及渠道。不要改其他资源，不点连接诊断，不发聊天或推理请求。脚本和本报告不包含账密、Cookie、CSRF token 或渠道凭证。

## 当前阻塞

管理页面最终只能到 `/login`，六个未认证管理 API 请求均被拒绝；因此本轮尚不能验证登录后详情、新建、映射、组关联、编辑、停用或表单行为。脚本没有执行，浏览器没有登录，预发没有收到写请求。恢复条件是协调者提供本轮已创建管理员的受限 storage state、将 manifest 标为 `ready`，并通知可以开始 V-04 专属资源写入。
