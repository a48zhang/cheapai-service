# cheapai React V-04 管理资源目录：通过

**模块状态：通过。内置模型及 9 条资源 selector 浏览器用例均通过。37 条浏览器链路均已覆盖通过：完整批次 35/37，首轮失败的两项管理运营链路随后定向复跑 2/2 通过。这是分批覆盖，不是单次 37/37。**

## 集成结果

- 全部单元测试：198 个测试文件、3,847 项通过。
- 最新集成记录 /tmp/cheapai-integrated-final.log：全工作区 typecheck 通过；build 通过，Worker 部分为 Wrangler dry-run；React lint 通过；React 单测 8 个文件、35 项通过；PR preview self-test 通过。
- HTTPS proxy smoke 通过。以上为本地工作区验证，不代表云生产环境或 CI 结果。

## 管理资源覆盖

浏览器内置模型用例 tests/e2e/builtin-models.spec.ts 通过；tests/e2e/product-corrections.spec.ts 的 9 条 @resources selector 用例全部通过，覆盖候选跨页、去重、停用/当前 ID 保留、中页及重复 cursor 不完整结果拒绝、关闭重开后的迟到响应丢弃，以及独立重试 mapping 读取。

| 文件 | 结果 | 已覆盖风险 |
| --- | --- | --- |
| tests/unit/web-admin-contracts.test.ts | 7 项通过 | 账单倍率精确字符串、请求来源白名单与价格快照解码；渠道全量分页顺序、停用项保留与去重；重复 cursor 和中页失败拒绝部分结果。 |
| tests/admin/entity-details.test.ts | 12 项通过 | 渠道、模型、访问组、用户四种单项读取；未认证/普通用户拒绝、管理员安全投影、敏感配置不泄露、缺失实体 404、非法 query 拒绝。 |

较早的 /tmp/cheapai-contracts-results.log（3 文件/28 项）是本次完整单测集合的子集。其中 tests/unit/api-client.node.test.ts 的 9 项共享通信结果记录在 [V-01 身份链路](cheapai-react-auth.md)，此处不重复计数。

首轮 tests/e2e/admin.spec.ts 和 tests/e2e/product-corrections.spec.ts 的两项管理运营 UI locator 失败均在定向复跑中通过，见`/tmp/cheapai-browser-operations-pass.log`。内置模型与 9 条 selector 资源用例均在主批次中通过。
