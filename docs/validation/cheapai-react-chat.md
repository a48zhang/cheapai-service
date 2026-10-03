# CheapAI React 聊天验证

**状态：进行中。** 本地集中 Vitest 与 HTTPS 代理 smoke 已通过；完整浏览器套件当前有 12 个失败，聊天链路尚不能标记完成。

## 当前证据

- 2026-10-03 的完整 Vitest 记录为 198 个测试文件、3847 项通过，见 `/tmp/cheapai-final-vitest.log`。该结果包含 React、Node 和 Workers 项目；汇总没有给出聊天功能的单独计数，因此不拆分或估算聊天通过数。
- 本地 Vite HTTPS 同源代理 smoke 通过，见 `/tmp/cheapai-proxy-smoke.log`。它检查登录请求保留 Origin、Host、CSRF token 和安全 Cookie，并确认 SSE delta 在 done 事件前到达。
- 当前浏览器整套结果为 37 项中 25 项通过、12 项失败，见 `/tmp/cheapai-browser-final.log`。聊天浏览器覆盖仍在修复及重跑流程中；本报告不把总体 Vitest 或代理 smoke 当成完整聊天验收。

## 覆盖边界

全量 Vitest 通过支持聊天 API、状态和组件测试已有稳定基础，但不代表浏览器中的草稿恢复、身份切换、流式生成、历史分页、失败重试和版本选择全部通过。最终状态待根协调者完成修复后的浏览器重跑并更新本报告。

其他阶段性聊天证据见 [聊天验证执行记录](../web-chat-execution.md)。旧的部分模块记录见 [身份链路](cheapai-react-auth.md) 与 [个人控制台](cheapai-react-personal.md)；它们未被本报告追认为功能完整验收。
