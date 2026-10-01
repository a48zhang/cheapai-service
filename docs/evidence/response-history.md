# Q08 Responses 状态引用隔离

核对日期：2026-09-08。此证据只覆盖本地 mock upstream 的 Responses 状态引用边界，不代表真实 OpenAI/供应商历史 API 验收。

## 执行范围

`tests/gateway/response-history-integration.test.ts` 使用 Workers Vitest pool、真实本地 D1、真实 Gate Durable Object、主 `app.fetch` 和两个不同优先级渠道。上游响应由测试内的 `fetch` 替身提供，未访问外部网络，也未部署 Worker。

执行命令：

```powershell
C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules/vitest/vitest.mjs run tests/gateway/response-history-integration.test.ts --reporter=verbose
```

结果：1 个测试文件、2/2 通过。测试中 Wrangler 的日志目录权限和父目录静态分析提示属于已知本地运行环境告警。

## 已验证行为

首个 native Responses 请求选择高优先级 channel A。Worker 返回由内部 request UUID 派生的 `resp_<UUID>` 平台 ID，同时 D1 只保存经过验证的上游 response ID。使用同一 user 和同一 Key 携带该平台 ID继续请求时，准入仍选择原 channel A，并把请求中的引用改回上游 ID；channel B 的 mock upstream 没有被调用。

同一用户换用另一个 Key、或换用另一个用户携带相同平台 ID，均返回 400 的 Responses 错误，且没有新增上游调用。停用原 channel A 并清除路由缓存后，继续请求返回错误并拒绝切换到 channel B。将相同引用放到 Chat 请求中也返回 400，未调用上游。

成功请求产生两条 D1 consumption 账本记录；跨 user/Key/channel 的失败分支没有生成请求或账单副作用。平台响应 ID、Key、用户和渠道绑定均由服务端 D1/当前映射核对，客户端引用本身不授予跨范围访问权。

## 限制

本证据只覆盖 native Responses 固定路由及引用隔离，使用合成响应和 mock upstream；九格协议转换、真实供应商历史行为及长流引用验收由其他节点负责。
