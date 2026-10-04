# cheapai PR #5 预发验证进度

本轮完成公开预检，认证后的业务验证仍受 Cloudflare 凭据阻塞。测试账号尚未在远程创建，不能据此认定主要面板或真实推理链路已验证通过。

## 部署与执行范围

- 目标：https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev
- 业务代码与已部署 SHA：`a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`。
- [对应 CI 部署](https://github.com/a48zhang/sub2api-cloudflare/actions/runs/37141551749)成功，日志确认地址与 SHA。
- 日期：2026-10-04 UTC；运行标识：`qa-pr5-20261004`。
- 并发：6 个 `gpt-6-luna / max` 验证代理，独立浏览器 context、附件目录及报告写集。
- 所有浏览器访问保留环境 HTTPS 代理和 TLS 校验，不使用 `ignoreHTTPSErrors`。
- 本轮初始证据对应上面的业务代码 SHA。V-06 发现关闭注册页有两个重复的登录入口；已交付仅修改 `RegisterForm.tsx` 的修复，保留父页面登录入口。修复后的部署与集中复验结果记录在 PR #5 的验证说明中，初始证据不自动继承到新版本。

## 已有证据与覆盖边界

| 模块 | 已执行的公开预检 | 未执行的认证链路 | 记录 |
| --- | --- | --- | --- |
| 身份权限 | HTTPS 登录页、管理深链的 `returnTo`、公开配置/CSRF、匿名会话及管理 API 401、缺失/错配 CSRF 的写入 403。 | 登录、恢复、退出、普通用户管理权限、跨用户资源隔离。 | [V-01](cheapai-preview-auth.md) |
| 个人控制台 | 五条个人页面深链实际回到登录页且保留路径/查询参数；会话及六个个人 API 返回 401。 | 概览、key 创建/一次性秘密/撤销、授权组限制、请求详情及账单。 | [V-02](cheapai-preview-personal.md) |
| 聊天 | 公开 SPA 与聊天深链、匿名模型/会话 API 拒绝、静态资源加载。 | 会话写入、真实模型、SSE、停止、恢复、重试与变体，以及对应结算。 | [V-03](cheapai-preview-chat.md) |
| 管理资源 | 渠道/模型/组列表与详情的匿名 API 保护、管理深链。 | 专属渠道→模型→映射→组配置；渠道提交结果不确定时的查回。 | [V-04](cheapai-preview-catalog.md) |
| 管理运营 | 用户、账单、审计、注册与邀请码相关匿名 API 保护及页面深链。 | 用户创建/授权、额度幂等与账本审计、邀请码生成/撤销。 | [V-05](cheapai-preview-operations.md) |
| 视觉交互 | 桌面/平板/手机的公开登录、关闭注册、表单原生校验、受保护路由与不存在路由。 | 聊天、个人控制台及管理面板的登录后布局与交互。 | [V-06](cheapai-preview-visual.md) |

这些结果仅说明已执行案例的行为。匿名 401 不证明登录后的角色或所有权校验；登录页截图也不证明主要面板布局通过。已发现的产品问题是关闭注册页的重复登录入口，属于低影响视觉问题；修复保留关闭注册提示和父页面的登录入口，不新增测试。

该模块交付后的集中检查已完成：`pnpm --filter @cheapai/web build`（包含 TypeScript 检查）及 `pnpm --filter @cheapai/web lint` 均通过。没有为这一视觉调整执行本地全量测试或编写文案断言。

## 实际预发截图

以下截图来自本轮真实 HTTPS 部署，已检查不含密码、Cookie、CSRF token 或一次性秘密。

- [桌面登录页，1440×1000](assets/cheapai-preview-login-desktop.png)
- [平板登录页，768×1024](assets/cheapai-preview-login-tablet.png)
- [手机登录页，390×844](assets/cheapai-preview-login-mobile.png)
- [手机注册关闭状态](assets/cheapai-preview-register-mobile.png)

## 环境阻塞及已处理项

1. 当前运行实例未提供 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 绑定。原生 `wrangler whoami` 返回未认证；正常代理路径的 Cloudflare 只读 API 请求也返回缺少认证。GitHub/CI 的已有权限不等于当前实例有 Cloudflare 权限。
2. 已在环境配置草稿中保存 Token 需求（目标域 `api.cloudflare.com`）和 Account ID 建议值，保留已有脚本与配置；补充了预发验证及浏览器启动说明。草稿返回 `saved`、`requires_publish: true`。需要在环境设置中填入凭据、保存并发布，再核对运行实例与实际 Wrangler 操作。仅保存草稿没有解除阻塞。
3. Chromium 在默认文件系统沙箱中曾报 `ERR_CERT_AUTHORITY_INVALID`。文件访问诊断显示其现有 NSS 数据库因只读挂载返回 `EROFS`；使用经权限审查的浏览器执行命令后，登录页返回 200、标题为 `cheapai`，各代理继续验证。保留原有 CA、代理与 TLS 校验，不更改 HOME。
4. 预发当前注册策略为 `closed`。邮件和 cron 在预发关闭，本轮不修改全局策略，也不通过自行注册绕过账号准备。

## 账号、预算与续跑

协调者已在仓库外的受限目录准备一个管理员及三个普通用户的本地随机身份，并编写三阶段账号准备脚本；未执行远程创建。脚本限定 PR 5 的 Worker、Account、共享预发 D1 与 PUBLIC_BASE_URL，新增管理员初始余额为 0；普通用户通过产品管理接口创建。

当前没有有效登录、预发业务数据写入或供应商调用，远程测试资源清理无需执行。CSRF 负例请求已被拒绝，未产生有效数据变更。没有秘密、浏览器 profile、原始响应或本地凭据进入本次提交。上游预算仍完整保留：最多 12 次、单次最多 128 输出 token、合计不超过 $0.10。

凭据就绪后按[执行计划](../preview-validation-plan.md)继续：核对配置→Wrangler 新增专属管理员→创建普通用户与隔离资源/有限额度→重新触发六个代理完成各自模块→集中修复/复验→一次跨模块链路→清理临时 key、邀请码及衍生资源。各模块待运行脚本有凭据就绪门槛；其存在或语法检查结果不是业务验证证据。
