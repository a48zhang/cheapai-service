# Q10 HTTP 权限和安全边界

核对日期：2026-09-08。此证据覆盖本地 Worker HTTP 边界，不代表生产 WAF、DNS 重绑定防护或真实供应商安全行为。

## 执行范围

`tests/security/http-boundaries.test.ts` 通过主 `app.fetch` 使用真实本地 D1、真实 Gate Durable Object、会话/Key/管理路由和 mock upstream。测试没有部署 Worker、访问外部模型或发送邮件。

执行命令：

```powershell
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/security/http-boundaries.test.ts --reporter=verbose
```

结果：1 个测试文件、3/3 通过。Wrangler 日志目录权限和父目录静态分析提示是本地沙箱已知告警。

## 已验证行为

- 有效 Key 可完成一次 native Chat 请求；管理员撤销该 Key 后，下一次请求立即返回 401，upstream 调用数不增加。另一个 owner Key 可在用户停用前完成请求；管理员停用用户后，该 Key 的下一次请求也返回 401，upstream 不再调用。
- 普通用户读取其他用户 Key 返回 404；账户余额不接受客户端 `userId` 选择；普通用户调用管理员余额调整返回 403，且没有账单写入。
- 管理员用户修改缺少 CSRF token 时返回 403，用户状态/版本保持不变。`/v1` evil Origin 预检返回 403 且不反射 Origin；配置 Origin 的预检返回 204，不启用 credentialed CORS。
- gateway 的冲突 `Authorization`/`x-api-key` 在认证边界返回 400 且不调用 upstream。管理员渠道创建拒绝 URL 用户名密码、loopback IP、query 注入和上游 Secret 中的 CRLF；这些输入不会创建渠道。

## 限制

本证据使用合成凭据和 mock upstream，未执行真实 DNS、WAF、浏览器跨站网络栈或生产部署验证。CORS 只证明浏览器预检/响应头边界与服务端 Key 认证同时存在，不把跨域请求误判为已授权。
