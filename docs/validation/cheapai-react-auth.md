# V-01 身份链路：集中结果

**状态：单元测试、全工作区 typecheck/build、React lint 和 HTTPS proxy smoke 已通过；浏览器身份链路仍在复跑，V-01 尚未完成。**

## 已记录的测试结果

当前完整单元测试集合共 198 个测试文件、3,847 项通过。全工作区 typecheck 与 build 通过，React lint 通过，HTTPS proxy smoke 通过。以下较早的领域日志用于说明本模块覆盖边界，属于当前总数中的子集，不重复计数。

| 来源日志 | 结果 | 与身份/通信相关的覆盖 |
| --- | --- | --- |
| `/tmp/cheapai-contracts-results.log` | Vitest 4.1.11，3 个测试文件、28 项通过；总耗时 5.51 秒。 | 其中 `tests/unit/api-client.node.test.ts` 的 9 项覆盖请求路径编码与拒绝绕过、CSRF 与幂等键、错误响应、401 失效回调及 cursor 解码。另两份文件的 19 项计入个人控制台/资源契约记录，见相应报告。 |
| `/tmp/cheapai-react-results.log` | Vitest 4.1.11，7 个测试文件、26 项通过；总耗时 4.66 秒。 | React 集合包含 session 风险用例：请求身份快照与过期竞态、恢复请求 single-flight、迟到恢复不能覆盖新登录、登出失败时保留身份、unavailable 与 anonymous 的区分，以及安全返回路径限制。日志汇总未按领域给出单项数，故不拆分 26 项。 |

## 浏览器覆盖边界

- 浏览器身份链路仍在复跑，尚无最终结果可记录：登录/注册、401/403/5xx、CSRF、安全返回、移动导航，以及通过本地开发代理登录。
- HTTPS proxy smoke 只记录代理连通性，不代替浏览器登录与身份状态链路。
- 因此当前记录不表示 V-01 最终通过。
