# V-04 管理资源目录：集中结果

**状态：单元测试、全工作区 typecheck/build、React lint 和 HTTPS proxy smoke 已通过；管理资源浏览器链路仍在复跑，V-04 尚未完成。**

## 已记录的测试结果

当前完整单元测试集合共 198 个测试文件、3,847 项通过。全工作区 typecheck 与 build 通过，React lint 通过，HTTPS proxy smoke 通过。`/tmp/cheapai-contracts-results.log` 是较早的 3 个测试文件、28 项通过的领域子集，用于说明覆盖边界，不与当前总数重复计数。与管理目录直接相关的文件为：

| 文件 | 结果 | 已覆盖风险 |
| --- | --- | --- |
| `tests/unit/web-admin-contracts.test.ts` | 7 项通过 | 账单倍率精确字符串、请求来源白名单与价格快照解码；渠道全量分页顺序、停用项保留与去重；重复 cursor 和中页失败拒绝部分结果。 |
| `tests/admin/entity-details.test.ts` | 12 项通过 | 渠道、模型、访问组、用户四种单项读取；未认证/普通用户拒绝、管理员安全投影、敏感配置不泄露、缺失实体 404、非法 query 拒绝。 |

同一次 contracts 汇总中的 `tests/unit/api-client.node.test.ts` 另有 9 项通过，作为共享 API 通信证据记录在 [V-01 身份链路](cheapai-react-auth.md)，不在本表重复计数。

## 浏览器覆盖边界

- 浏览器资源链路仍在复跑，尚无最终结果可记录：渠道→模型映射→访问组、实体详情深链刷新、多页候选、版本冲突、分步保存和模拟诊断。
- 当前单元与静态/build 结果不能代替管理资源页面的端到端验收；当前记录不表示 V-04 最终通过。
