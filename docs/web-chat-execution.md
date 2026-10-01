# Web chat 实施任务与协作约定

2026-09-12：8 个 Luna max 子代理已完成实现与交叉审查，root 已集成并验收。本地完成，E2 远程发布因 CF 授权过期待执行。结果与证据见 web-chat-delivery.md。以下保留执行时的职责和约定：每个实现节点最多改 2–3 个文件；跨文件工作拆节点连续完成。测试只用本地模拟上游，不发送真实邮件，不消耗真实模型额度。

## 负责人和依赖

| 负责人 | 范围 | 节点顺序 |
| --- | --- | --- |
| billing | 0020 分组倍率；分组后端；精确计算/快照/结算 | 倍率迁移 → 分组接口 → 快照/计算 → 结算兼容 → 测试 |
| keys | 0021 虚拟 Key；普通 Key 隔离；聊天内部身份 | Key 迁移 → 普通 Key 查询隔离 → 虚拟身份 → 测试 |
| gateway | 0023 请求来源/分组；准入与可信聊天分发 | 等待身份/倍率约定 → 余额准入 → 最终注册 → 分发入口 → 测试 |
| storage | 0022 会话/消息；存储与版本/幂等 | schema/types → 会话 CRUD → 消息接受/关联 → 保存/恢复/版本 → 测试 |
| chat_api | 聊天路由、流式桥接、权限、上下文 | 接口搭建 → 模型目录/CRUD → 发送 → 保存/取消/恢复 → 测试 |
| web | 聊天客户端、界面、Markdown、路由入口 | 客户端契约 → 聊天布局 → 发送/流式 → 历史/版本 → 页面路由 |
| admin_ui | 分组倍率表单与客户端；日志来源显示 | 倍率客户端 → 表单 → 日志来源 |
| integration | 独立集成测试和审查 | 先阅读测试设施/准备验收 → 模拟 HTTP 测试 → 浏览器测试 → 修正验证 |

root 负责协调接口、入口装配、最终类型/构建/集成检查和发布。新的源码目录不要假装功能已就绪；各负责人必须提交实际验证结果，不能仅凭文件存在标完成。

迁移固定顺序：0019 是已有未发布更改；0020 倍率、0021 虚拟 Key、0022 聊天、0023 请求来源。不得修改已部署 0001–0018。API key 重建必须保留请求外键、索引、旧触发器与创建幂等兼容。

## HTTP 契约（共同遵守，必要调整先通知其他负责人）

统一 `/api/v1/chat` 前缀，普通响应使用现有 `{data: ...}` 外壳；错误使用现有错误外壳和状态码。写入需要登录及 CSRF，所有 ID 要校验归属。

- GET `/models` → data `{items: ChatGroup[]}`。ChatGroup `{id,name,billingMultiplier,models:[{publicModelId,maxOutputTokens}]}`，仅包含能承载流式聊天的映射。
- GET `/conversations?cursor=...` → data `{items: Conversation[],nextCursor:string|null}`。
- POST `/conversations` body `{title?,groupId?,modelId?}` → data Conversation。
- GET `/conversations/:id` → data `{conversation:Conversation,messages:Message[]}`。
- PATCH `/conversations/:id` body `{version,title?,groupId?,modelId?}` → data Conversation。
- DELETE `/conversations/:id` body `{version}` → data `{deleted:true}`。
- POST `/conversations/:id/messages` body `{operationId,conversationVersion,groupId,modelId,content,maxOutputTokens?}`。
- POST `/conversations/:id/regenerate` body `{operationId,conversationVersion,groupId,modelId,maxOutputTokens?}`。
- POST `/conversations/:id/select` body `{conversationVersion,messageId}` → data `{conversation,messages}`。

Conversation `{id,title,groupId:string|null,modelId:string|null,version,createdAt,updatedAt}`。
Message `{id,conversationId,turnIndex,role:'user'|'assistant',content,status:'generating'|'completed'|'stopped'|'failed',variant,selected:boolean,requestId:string|null,groupId:string|null,modelId:string|null,createdAt,updatedAt}`。
字段 TypeScript 定义由 storage 写入 `apps/worker/chat/types.ts`；web 的响应解码独立实现，避免引用 worker 运行时代码。

发送/重新生成正常返回 SSE：

- `event: meta` data `{conversation,userMessage:Message|null,assistantMessage:Message}`。
- `event: delta` data `{text:string}`（增量文本）。
- `event: done` data `{message:Message,billingStatus?:string}`。
- `event: error` data `{code:string,message:string,messageId?:string}`。

已接受的重复 operationId 不重新调用上游，可返回普通 JSON data `{conversation,messages,replayed:true}`。前端按 Content-Type 区分，刷新读取持久化状态。不做流式续传或后台持续生成。停止通过取消发送连接，禁止自动重试模型请求。

## 内部衔接

- keys 提供 `authenticateWebChat(database,userId,groupId,now)` 返回可信 InternalPlatformKeyAuth，并提供幂等虚拟 Key 创建；groupId 是本次选择，virtual key 本身不变。
- gateway 暴露服务端可信身份分发函数，沿用现有 JSON/SSE、计费和终结；明确区分外部 Bearer 路径，不允许 HTTP header/body 设置 trusted identity。函数实际签名由 gateway 第一时间告知 chat_api。
- gateway 提供发送上游前的 `onRegistered(requestId)` 异步挂钩，chat_api 持久化关联成功后才能继续。失败应走正常清理路径，不能漏账或发送未关联请求。
- billing 的快照新增可选组/倍率字段并兼容历史快照，向 gateway 告知参数；现有倍率默认为精确字符串 `1`。
- storage 对接受发送的唯一操作 ID、单会话生成锁、请求关联和消息终结提供原子接口，并将签名尽早通知 chat_api。
- 不恢复默认输出配置/后台补值；最大输出的现有客户端参数语义不得擅自改变。
- 网页本身作为客户端可从所选模型的有效能力上限显式提交 maxOutputTokens，以满足 Messages 等协议的必填参数；服务端仅验证并映射这个客户端参数，不能另造 4096/8192 等缺省值。目录有效上限需考虑可用渠道映射上限。

## 文件边界

billing 独占 `apps/worker/billing/{pricing,fingerprint,settlement}.ts`、分组后端及 0020；gateway 独占 `billing/admission.ts`、gateway 分发/准入/注册及 0023；keys 独占 auth Key 模块和 0021；storage 独占 chat/types/repository/messages 与 0022；chat_api 独占 chat/routes/service/stream/models。共享 `apps/worker/routes.ts` 最终由 root 装配，任何人需要改先通知 root。

web 独占聊天 Vue/客户端、router 与前端导航；admin_ui 独占分组界面、分组客户端及请求列表/详情展示；integration 独占新增 `tests/e2e/web-chat.spec.ts`、新增聊天集成用例，测试基础设施变更先通知 root。现有测试按对应源码负责人归属，避免覆盖其他代理尚未完成的修改。

## 验收关口

1. 普通 API、旧价格快照及恢复幂等不回归；倍率最终只舍入一次。
2. 虚拟 Key 无哈希凭据、不出现在普通 Key 管理、无法走 Bearer；用户与组权限不能越界。
3. 不同会话/分组不串渠道倍率；重复发送只生成一次；重新生成独立收费。
4. SSE、停止、失败、刷新、版本切换、删除和移动端 UI 完整可用。
5. 类型、构建、相关本地测试和浏览器闭环通过后，再处理 CF 授权与部署；授权不可用必须记录未上线，不能冒称部署成功。
