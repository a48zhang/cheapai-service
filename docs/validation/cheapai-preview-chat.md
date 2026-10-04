# cheapai 预发聊天模块只读预检

执行时间：2026-10-04 01:21 UTC  
预发地址：<https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev>  
部署与本地代码 SHA：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`

## 已执行的只读检查

- `GET /`、`GET /chat/00000000-0000-4000-8000-000000000001` 和带聊天 `returnTo` 的登录页均返回 `200 text/html`。Chromium 最终落到 `/login`，保留了原聊天深链 `returnTo`；登录页可见，聊天输入框不可见。
- 登录状态 `GET /api/v1/auth/me` 返回 `401`。未认证的 `GET /api/v1/chat/models` 与聊天历史列表也都返回 `401`，对应 request ID 分别为 `ef2b12e7-8b3d-473d-a02d-520cf114d915` 和 `1a394625-9fb6-4217-a12c-d8d8500557d5`。
- 浏览器加载的 22 个公开 JS/CSS 资源均返回 `200`。
- 请求均为只读 GET。没有提交登录表单、创建测试账号或会话，也没有发送聊天请求；真实上游调用数为 0。

首次在默认沙箱启动 Chromium 时，浏览器因文件系统沙箱无法读取 NSS 信任库而报 `ERR_CERT_AUTHORITY_INVALID`。协调者验证了通过 `require_escalated` 运行只读浏览器预检可使用环境现有 CA 完成 HTTPS 访问；TLS 校验保持开启，没有使用证书忽略选项。我的一次临时信任项验证在命令退出时已清除；后续浏览器操作按协调者确认的只读执行方式运行，不再改动 NSS 库。

## 阻塞与未执行项

`/tmp/cheapai-preview-run/manifest.json` 当前为 `credentialsStatus: blocked-cloudflare-auth`。运行时没有可用的 Cloudflare 凭据绑定；主代理尚未分配聊天账号、授权模型/模型组及本 lane 预算。因此不能登录或执行任何聊天写入与真实推理。页面返回 200 和静态资源可加载不代表聊天业务链路通过。

创建会话、实际发送、SSE 增量显示、停止、刷新恢复、聊天操作重试、重新生成/版本切换、聊天记录分页、重命名/删除、IME 和草稿恢复均为**阻塞/未执行**。没有请求 ID、资源 ID或账单结果可以与真实推理关联。

待主代理提供 Cloudflare 认证、独立 chat 测试账号、指定模型/模型组及通过价格核算的调用预算后，再运行脚本。全局限制仍为最多 12 次上游调用、每次最多 128 个输出 token、累计预算不超过 `$0.10`。

## 本地待凭据脚本

脚本位于 `/tmp/cheapai-preview-run/chat/chat-module.mjs`，仅为未执行草稿。它在读取 `accounts.json` 前检查部署 SHA、`manifest.credentialsStatus === "ready"`、显式执行开关及模型/调用/预算分配；当前条件不满足时立即退出。草稿涵盖登录后模型选择、IME/草稿恢复、聊天发送与 SSE、刷新、重新生成和变体、停止及会话重命名/删除。它没有被运行，也没有用于当前预检的 GET 证据之外的远程操作。
