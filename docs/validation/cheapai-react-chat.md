# cheapai React 聊天验证

**状态：本地聊天模块验收通过。** 真实聊天、聊天竞态、历史与流式交互均通过浏览器覆盖。

## 当前证据

- 2026-10-03 16:52:33 开始的完整 Vitest 记录为 198 个测试文件、3847 项通过，见 `/tmp/cheapai-final-vitest.log`。该结果包含 React、Node 和 Workers 项目；汇总没有给出聊天功能的单独计数，因此不拆分或估算聊天通过数。
- 本地 Vite HTTPS 同源代理 smoke 通过，见 `/tmp/cheapai-proxy-smoke.log`。它检查登录请求保留 Origin、Host、CSRF token 和安全 Cookie，并确认 SSE delta 在 done 事件前到达。
- 完整浏览器运行 37 项中 35 项通过，聊天、竞态、聊天 UI、认证、full workflow 及资源 picker 路径通过，记录见 `/tmp/cheapai-browser-complete.log`。之后修复并定点复跑的两个管理端用例也通过，见 `/tmp/cheapai-browser-operations-pass.log`；37 项覆盖均已有通过证据，但分两次运行，不是单次 37/37。
- 2026-10-03 17:12:58 开始的整合后 React 项目定点运行有 8 个文件、35 项测试通过；完整 workspace typecheck/build、Worker dry-run、React ESLint 和 PR preview self-test 通过，见 `/tmp/cheapai-integrated-final.log`。该35项为单独定点运行，不与完整 Vitest 数量相加。

## 覆盖边界

聊天模块的浏览器链路已通过：草稿与身份隔离、流式生成、历史分页、失败重试、版本切换及并发发送均包含在聊天 E2E 覆盖中。所有本地浏览器用例也已在完整运行和后续两项定点复跑中覆盖通过。本报告只声明本地结果，不表示 GitHub CI 或真实生产环境已经验收。

其他阶段性聊天证据见 [聊天验证执行记录](../web-chat-execution.md)。旧的部分模块记录见 [身份链路](cheapai-react-auth.md) 与 [个人控制台](cheapai-react-personal.md)；它们未被本报告追认为功能完整验收。
