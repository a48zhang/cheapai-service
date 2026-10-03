# 执行计划与实施状态

更新：2026-10-03。基线为 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a`；本轮代码仍在本地工作树，未推送、未部署。

## 本轮进度

| 范围 | 实施状态 | 验证状态 |
| --- | --- | --- |
| B01–B07 请求可靠性 | 已实现 | BV01–BV03 局部回归已执行：Workers 170 项、Chat Node 10 项及额外启动回归 10 项通过；使用隔离存储和 mock 上游 |
| A01–A07 共享目录 | 已实现 | AV01 38/38 通过 |
| S01–S02 存储边界 | 已实现 | SV01 40/40 通过 |
| FE-D01–FE-D11 前端 | 已实现 | Node 20 项、管理契约 7 项、Web 类型与构建通过；FE-V01–FE-V03 浏览器部分因 Chromium socket EPERM 受阻 |
| D01–D05 文档 | 15 份修订已完成 | V-DOC 已通过：141 个本地文档链接/锚点、路径与状态/命令引用核对 |
| V-INTEGRATION | 本地集中检查完成，浏览器仍受阻 | 类型、Node 1859/1859、递归构建及 staging dry-run 通过；Workers 首轮 2056 通过/1 失败，单文件测试维护后定向 28/28 通过，详见下方 |
| R01–R04、V-CONFIG、staging 验收与 V-PROD | 未执行 | 云目标、真实上游/邮件、负载、恢复与发布仍需相应环境和授权 |
| D06 发布收口 | 未执行 | `CHAT-RELEASE` 和旧 26 项后置验收保留开放 |

### 本地集成结果

类型检查、Node 1859/1859（45 文件）、递归构建、staging dry-run 与差异检查通过。Workers 首轮 2056 通过、1 失败（144 文件）；修正过时的 operationId 测试断言后，受影响套件 28/28 通过。合并证据覆盖最终 2058 个用例，未整批重跑。详见[本地验收记录](evidence/release-local-2026-10.md)。

本轮维持原 Chat HTTP/SSE 桥接、单 Worker、D1 权威账单与少量透支语义；不加入首次调用引导、连接配置区或测试请求入口。开发与验证分开，每个开发任务最多修改指定的三个文件。

- [完整任务范围](#本轮完整任务计划)
- [验证边界](known-issues.md)与[证据索引](evidence.md)
- [旧 507 节点记录](#旧-507-节点实施历史)：旧 ID 与本轮 B/A/S/FE/D/R ID 属于不同计划

## 本轮完整任务计划

以下保留 2026-10-03 批准的任务范围、依赖和完成标准，实际进度以上方状态表为准。共 27 项代码开发任务：后端 16 项、前端 11 项；文档、配置、发布和验证另列。

## 范围与共同规则

基线：原审查已于 2026-10-03 读取 [main 提交 54d71d5](https://github.com/a48zhang/sub2api-cloudflare/commit/54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a)，与 10 月 1 日一致；执行前若基线变化，调整受影响任务。所有路径相对仓库根目录。

范围包括聊天、渠道调度、限流、登录、分页修复，低耦合组件整理，文档与发布验收。排除聊天内部执行接口/HTTP-SSE 调用方式重构、首次调用引导/连接配置区/测试请求入口，以及已延期的 OAuth、支付、订阅功能。

- 每个开发任务改动 1–3 个指定文件，新增和移动路径均计入；同文件任务串行。
- 开发任务不加测试或验证。模块完成后集中验证，优先复用现有测试；全量检查统一放在 V-INTEGRATION。
- 保留单 Worker、D1 权威账单和少量透支语义；组件拆分沿用现有业务规则。
- 验证记录版本和结果；推送、部署及有费用的调用在执行时确认。

## 执行顺序

1. B01–B07 → BV01/BV02 → BV03；前端不同文件的链路可并行
2. A01–A07 → AV01 → S01–S02 → SV01
3. 前端认证链 → FE-V01；聊天链 → FE-V02；管理选择器链 → FE-V03
4. 相关代码模块完成 → D01–D05 → V-DOC；全部模块验证完成 → V-INTEGRATION
5. R01 → R02 → V-CONFIG → R03 → staging 验收 → R04 → V-PROD → D06

## 后端开发

### 请求可靠性
#### B01 修复 Chat 失败终止

依赖：无
修改文件：`apps/worker/chat/stream.ts`、`apps/worker/chat/service.ts`（2）
目标：Chat 失败或取消统一走一次性收尾：先取消执行，再有界保存最终消息，关闭 SSE 并清理 reader 与监听；成功终态不被迟到 abort 改写。网关负责租约释放与结算，保存或取消失败不能卡住终止流程。

#### B02 分离 RPM 身份与租约身份

依赖：无
修改文件：`apps/worker/limits/client.ts`、`apps/worker/limits/dual-lease.ts`（2）
目标：LeaseClient 接受经校验的内部 rate.operationId，缺省使用 requestId，并透传到 Gate、保留在双租约快照中。RPC 恢复沿用原租约 ID 与 rate 参数；租约和 D1 requestId 的关联保持不变。

#### B03 接入逻辑请求 RPM 身份

依赖：B02
修改文件：`apps/worker/gateway/dispatch.ts`、`apps/worker/gateway/admit.ts`（2）
目标：dispatch 为一次逻辑调用生成一个服务端用户 RPM operationId，供全部候选准入复用；不同调用分别计数，渠道 RPM 与并发租约仍使用各自身份。保留现有最多三次候选、清理门槛及原生历史绑定规则。

#### B04 暴露有界上游响应观察点

依赖：无
修改文件：`apps/worker/gateway/execute-json.ts`、`apps/worker/gateway/execute-stream.ts`（2）
目标：JSON/SSE executor 在读取响应体前，向可选内部回调传递 channelId、HTTP status 和 Retry-After。回调有超时边界，失败不改变上游错误分类、取消和资源释放。

#### B05 接入渠道冷却写入

依赖：B04
修改文件：`apps/worker/gateway/dispatch.ts`、`apps/worker/limits/cooldown.ts`（2）
目标：生产 dispatch 接入 Gate 冷却回调，对 401/403/429 按现有 TTL 与 Retry-After 边界写入渠道冷却，后续请求由 Gate.acquire 跳过冷却渠道。冷却写入有界等待，结果不确定时如实记录。

#### B06 统一有限 RPM 配置上限

依赖：B02
修改文件：`apps/worker/config.ts`、`apps/worker/limits/rate-window.ts`（2）
目标：配置解析与 rate-window 共用已有上限，有限 RPM 仅接受 1–4096 的安全整数，用户/渠道管理入口同步生效；保留 0/null/undefined 和内部 sentinel 的不限语义。已存超限值继续拒绝执行，纠正数据另列操作。

#### B07 合并网关资源收尾所有权

依赖：B01–B06 全部完成
修改文件：`apps/worker/gateway/request-lifecycle.ts`（新增）、`apps/worker/gateway/execute-json.ts`、`apps/worker/gateway/execute-stream.ts`（3）
目标：JSON/SSE 复用 startLeaseLifecycle，并由小型 request-lifecycle owner 统一取消、超时、定时器/监听清理和一次性租约释放；正常结算期间可有界续租，错误或续租失败停止上游。各 executor 保留协议解析、SSE 背压与 usage、D1 开始 CAS、permit 防护及记录/结算顺序。

### 请求链独立验证

#### BV01 Chat 到网关终止

依赖：B01–B07 全部完成
测试文件：`tests/chat/stream.node.test.ts`、`tests/chat/integration.test.ts`、`tests/gateway/stream-failures.test.ts`
验证：正常结束、失败/挂起与取消竞争经真实 Chat HTTP/SSE 桥接到 executor 后都能终止，上游取消、租约释放与一次结算可追踪；释放不确定时明确记录，无悬挂流或残留定时器。使用 mock 上游。

#### BV02 RPM 与渠道冷却

依赖：B01–B07 全部完成
测试文件：`tests/gateway/dispatch.test.ts`、`tests/gateway/admit.test.ts`、`tests/limits/cooldown.test.ts`
验证：候选切换只计一次用户 RPM，不同请求独立计数，回退遵守清理和历史绑定；管理保存与运行时的有限/不限边界一致。JSON/SSE 的冷却不依赖错误体格式，Retry-After 受限，下一请求可跳过故障渠道。
容量说明：4096 是配置上限，现有 64 KiB 状态预算下长 ID 的实际接纳能力另行记录；改变预算需独立开发任务。

#### BV03 后端集成

依赖：BV01、BV02
修改文件：无
验证：在隔离 D1/KV/DO 环境确认真实路由装配冷却回调，外部 API 与 Web Chat 共用修复链，并核对并发/冷却状态；环境未就绪则记为未验。

### 模型与渠道共享层

仅提取运行期共享读取、校验和凭据操作；admin 保留权限、写入、审计、CAS 和必要转导出，A05–A07 完成运行期消费者迁移。

#### A01 提取共享模型读取

依赖：BV03
修改文件：`apps/worker/catalog/models.ts`（新增）、`apps/worker/admin/model-repository.ts`（2）
目标：将 ModelView、投影/解码、共享价格与字段校验、getModelById 移至 catalog；admin 复用共享实现并保留写入、审计和 CAS。金额单位、响应形状及坏价格拒绝执行的语义不变。

#### A02 提取渠道凭据与读取

依赖：A01
修改文件：`apps/worker/catalog/channel-secrets.ts`（新增）、`apps/worker/admin/channel-secrets.ts`、`apps/worker/catalog/channels.ts`（新增）（3）
目标：将凭据加解密移至 catalog，原路径转导出；catalog/channels 新增只读类型、投影/解码、getChannelById 和 readChannelForForwarding，旧读取调用在 A03 切换。密文格式、AAD、key-version、懒解密及脱敏规则保持不变。

#### A03 归并渠道读取实现

依赖：A02
修改文件：`apps/worker/admin/channel-repository.ts`、`apps/worker/catalog/channels.ts`（2）
目标：admin 渠道仓库复用 catalog 类型、投影/解码和读取，ChannelEncryptionKey 同归 catalog，移除过渡期重复实现。admin 保留分页、写入和审计。

#### A04 提取共享模型映射

依赖：A01、A03
修改文件：`apps/worker/catalog/model-mappings.ts`（新增）、`apps/worker/admin/model-mappings.ts`（2）
目标：将映射只读类型、capability 校验、解码及 get/list 移至 catalog；admin 复用它们并保留写入审计与版本 CAS。映射权限、模型价格和分组授权仍按原链路重查。

#### A05 切换准入与缓存消费者

依赖：A04
修改文件：`apps/worker/gateway/admit.ts`、`apps/worker/cache/routes.ts`、`apps/worker/cache/prices.ts`（3）
目标：准入、路由缓存和价格缓存统一从 catalog 导入模型/渠道/映射能力。缓存键、观察时间、价格快照、权威版本重查与候选筛选保持不变。

#### A06 切换执行器与 dispatch 消费者

依赖：A04、B07
修改文件：`apps/worker/gateway/execute-json.ts`、`apps/worker/gateway/execute-stream.ts`、`apps/worker/gateway/dispatch.ts`（3）
目标：两个 executor 与 dispatch 的转发读取和 ChannelKeyring 类型改从 catalog 导入，保留 B 模块的资源收尾和执行语义。

#### A07 切换密钥装配与诊断路由

依赖：A04
修改文件：`apps/worker/channel-keyring.ts`、`apps/worker/gateway/test-channel-route.ts`（2）
目标：密钥装配与渠道诊断使用 catalog 的共享类型和读取；诊断路由继续保留 admin 权限检查与审计。

### 共享层独立验证

#### AV01 共享所有权回归

依赖：A01–A07 全部完成
测试文件：`tests/admin/model-repository.test.ts`、`tests/admin/channel-repository.test.ts`、`tests/admin/model-mappings.test.ts`
验证：运行期导入来自 catalog，共享读取唯一且无反向依赖；原管理路径行为等价。集中检查价格/密钥版本/capability、写入审计与冲突回滚、缓存失效及配置重查。

### 存储边界

只整理 Chat D1 装配和 KV I/O/编码边界，已有 `db.ts`、`limits/storage.ts` 保持原位。

#### S01 提取 Chat D1 适配器

依赖：AV01、B01
修改文件：`apps/worker/chat/storage.ts`（新增）、`apps/worker/chat/d1-storage.ts`（新增）、`apps/worker/chat/service.ts`（3）
目标：ChatStorage 及输入/结果契约移至 storage，createD1ChatStorage 及 messages/repository 装配移至 d1-storage，service 消费契约并保留默认装配和兼容导出。保留 CAS、幂等 ID、generation lock、删除后不复活、regenerate 上下文及请求关联语义。

#### S02 分离 KV I/O 与缓存编码

依赖：S01
修改文件：`apps/worker/cache/snapshot-codec.ts`（新增）、`apps/worker/platform/kv-snapshots.ts`（新增）、`apps/worker/cache/snapshot.ts`（3）
目标：Snapshot 类型、编解码与 freshness 判定移至 snapshot-codec，KV I/O、最小 TTL 与尽力写入移至 kv-snapshots，snapshot 保留兼容导出。适配器单向依赖 codec，保持 observed_at、故障回源和权威 D1 查询边界，过期缓存不用于授权。

### 存储独立验证

#### SV01 存储适配器回归

依赖：S01、S02 全部完成
测试文件：`tests/chat/integration.test.ts`、`tests/cache/snapshot.test.ts`
验证：隔离存储与 D1 适配器遵循同一 ChatStorage 契约，保持幂等、版本冲突、checkpoint、删除和请求关联行为；KV codec 无平台依赖，无效快照为 miss，故障回源、最小 TTL 和观察时间不变。

## 前端开发与模块验证

### 聊天正文与操作状态

#### FE-D01 修正聊天正文校验

依赖：无
修改：`apps/web/src/api/chat.ts`
目标：分开元数据与正文校验：正文、delta 和发送内容保留原始空白、换行及格式，允许空 delta 和生成中的空 assistant 正文；仅拒绝纯空白用户输入。沿用现有长度预算、SSE 解码与 done/replay 协议。

#### FE-D02 修正操作身份与重新生成终态

依赖：FE-D01
修改：`apps/web/src/views/ChatView.vue`
目标：用 operationId 加 owner/route scope 识别操作，runGeneration 明确返回本地终态，pending/streaming/sendLocked 仅由所属操作清理。regenerate 成功或停止保留新结果，前置失败恢复旧选择，meta 后失败遵循服务端状态；仅结果未知的重试复用 ID，再次发送创建新 ID。

### 会话过期与草稿恢复

#### FE-D03 接入无环的过期通知

依赖：FE-D01
新增：`apps/web/src/api/session-expiry.ts`
修改：`apps/web/src/api/client.ts`、`apps/web/src/api/chat.ts`
目标：新增不依赖 router/store 的会话过期通知，JSON API 与 sendStream 的受保护 HTTP 401 均携带请求开始时的身份代际通知上层，判定不依赖错误体解码。公开认证接口失败、非 401 和 SSE 供应商错误不触发本地会话过期。

#### FE-D04 连接会话失效与安全回跳

依赖：FE-D03
修改：`apps/web/src/stores/session.ts`、`apps/web/src/main.ts`、`apps/web/src/router.ts`
目标：store 按会话代际失效并合并同时到来的 401，保留 cookie 写串行和 SessionSupersededError；main 在请求发出前绑定通知、store 与 router。过期后携带 safeReturnPath 约束的 returnTo 进入登录，保留最少失效原因/身份上下文供恢复使用，登录成功沿用 replace(destination)。

#### FE-D05 拆出草稿并接上过期恢复

依赖：FE-D02、FE-D04
新增：`apps/web/src/composables/chat/useChatDraft.ts`
修改：`apps/web/src/views/ChatView.vue`
目标：将草稿持久化、owner 校验和清理移至 useChatDraft，输入变化即保存；会话过期保留原 owner 草稿，同账号重新登录可恢复。主动退出/换账号清除或隔离旧草稿，storage 故障不阻断聊天，保留当前单草稿语义。

#### FE-V01 会话恢复独立验证

依赖：FE-D03、FE-D04、FE-D05 全部完成
测试文件：`tests/unit/api-client.node.test.ts`、`tests/e2e/web-chat-ui.spec.ts`
验证：受保护 API/流式 HTTP 401 正确回登录，公开接口和非 401 不误触发；并发/迟到通知、安全回跳、同账号草稿恢复与换账号隔离正确。使用现有 HTTPS Playwright 服务与 mock。

### 历史分页与页面拆分

#### FE-D06 抽出历史状态并实现分页

依赖：FE-D05
新增：`apps/web/src/composables/chat/useConversationHistory.ts`
修改：`apps/web/src/views/ChatView.vue`
目标：useConversationHistory 管理列表、cursor、加载/错误和 reset/loadMore/upsert/remove，注入现有 API 与 owner guard；首屏替换、追加去重、成功才推进 cursor，失败保留重试位置。追加单飞，刷新/owner reset 丢弃旧响应，新增/改名/删除保持服务端排序与最新版本。

#### FE-D07 接上历史加载更多入口

依赖：FE-D06
修改：`apps/web/src/components/chat/ChatSidebar.vue`、`apps/web/src/views/ChatView.vue`
目标：侧栏通过 props 展示分页状态并 emit loadMore/retry；有 cursor 时显示加载更多，加载中禁用重复点击，失败保留列表并提供重试。首屏错误与空列表分开显示，桌面/移动共用数据，末页隐藏按钮。

#### FE-D08 拆出模型目录与选择状态

依赖：FE-D07
新增：`apps/web/src/composables/chat/useChatModelSelection.ts`
修改：`apps/web/src/views/ChatView.vue`
目标：将目录、分组/模型选择、选项派生、selection storage 和目录加载移至 useChatModelSelection，注入 API 与 owner guard。ChatView 保留生成编排和现有对话的版本化 PATCH/回滚，选择顺序仍为对话、存储、首个可用项。

#### FE-V02 聊天模块独立验证

依赖：FE-D01、FE-D02、FE-D05 至 FE-D08，以及 FE-V01 完成
测试文件：`tests/unit/web-chat-client.test.ts`、`tests/e2e/web-chat-ui.spec.ts`、`tests/e2e/web-chat-races.spec.ts`
验证：正文保真，重新生成各终态及未知结果重试正确；重复发送、停止、路由/账号切换不串状态。覆盖首屏至多页、末页、分页失败重试与刷新/删除竞争，并确认目录和草稿提取行为等价。

### 管理渠道选择器

#### FE-D09 增加共享的完整渠道读取

依赖：无
修改：`apps/web/src/api/admin-channels.ts`
目标：保留 list({cursor,status})，新增选择器共用的完整读取方法，顺序消费至 nextCursor=null 并按 ID 去重；重复 cursor 或中途失败明确报错。渠道主列表仍使用原分页。

#### FE-D10 分组选择器接入完整渠道

依赖：FE-D09
修改：`apps/web/src/views/admin/GroupsView.vue`
目标：分组编辑器在所有渠道页成功后提交候选，保留 busy/error、重试和失败禁止保存；已有绑定 ID 与停用渠道继续回显。用读取代际隔离编辑器重开/关闭与卸载后的迟到结果。

#### FE-D11 模型映射选择器接入完整渠道

依赖：FE-D09
修改：`apps/web/src/components/admin/ModelMappingEditor.vue`
目标：映射编辑器用完整读取加载渠道，与现有映射读取分别管理状态；读取失败可重试，未完整加载或提交中禁止保存。保留固定 channelId/protocol、当前项回显、版本冲突处理，并隔离重读/卸载后的旧响应。

#### FE-V03 管理选择器独立验证

依赖：FE-D09、FE-D10、FE-D11 全部完成
测试文件：`tests/e2e/admin.spec.ts`、`tests/e2e/product-corrections.spec.ts`、`tests/unit/web-admin-contracts.test.ts`
验证：两个选择器均可选择第 21、41 个渠道，保留已有绑定/停用项；中途失败、重复 cursor/项及弹窗重开不产生错误候选、额外写入或诊断请求。

前端调度：FE-D01 → FE-D02 → FE-D05 → FE-D06 → FE-D07 → FE-D08；FE-D03/04 与 FE-D02 可并行，在 FE-D05 汇合。FE-D09 完成后 FE-D10/11 可并行。

## 文档整理

复用已完成的 15 份文档修订，更新为本轮实现状态。

| ID | 依赖 | 文件范围 | 目标 |
|---|---|---|---|
| D01 | 所有相关代码模块完成 | `README.md`、`docs/README.md`（新增）、`docs/implementation-plan.md` | 入口、导航与任务状态一致；移除过时描述及已拒绝建议，新计划与旧 507 节点历史分开 |
| D02 | D01 | `docs/user-guide.md`（新增）、`docs/admin-guide.md`（新增）、`docs/known-issues.md`（新增） | 指南对应现有页面，区分已修与待验收问题 |
| D03 | D02 | `docs/development.md`、`docs/toolchain.md`、`docs/admin-bootstrap.md` | 本地运行、可信 HTTPS、Cookie 安全和管理员初始化符合实际工具链 |
| D04 | D03 | `docs/architecture.md`、`docs/phase-1.md`、`docs/protocol-compatibility.md` | 组件归属和依赖对应实现，准确说明调用/计费边界与延期能力 |
| D05 | D04 | `docs/deployment.md`、`docs/evidence.md`、`docs/web-chat-delivery.md` | 迁移说明覆盖到 0023，区分 staging/production；9 月 12 日失败保留为历史 |
| V-DOC | D05 | 默认无；修正按上述文档每任务 1–3 文件 | 集中检查链接、文件名、状态与部署命令引用 |

## 最终集成、配置与发布

### V-INTEGRATION 集成验证

依赖：全部代码模块验证与 V-DOC 完成
文件：`docs/evidence/release-local-2026-10.md`（新增，仅结果）
执行：在最终完整代码上集中运行现有类型检查、Node/Workers 测试、前端构建和 Worker dry-run，汇总模块结果；未通过则暂停发布。

### R01 发布准备

依赖：V-INTEGRATION，目标环境明确
范围：仓库 0 文件；环境清单记录在 `docs/evidence/staging-deploy.md`
目标：读取目标账户、当前 Worker、D1 迁移水位、绑定、域名与备份能力，确定发布对象及回退条件。

### R02 环境配置

依赖：R01，配置变更获授权
文件：`apps/worker/wrangler.jsonc`（仅选定环境）
目标：指向正确 D1/KV/Gate、HTTPS 入口和邮件身份，保持环境隔离；凭据通过安全途径配置。

### V-CONFIG 配置验证

依赖：R02
文件：`docs/evidence/staging-deploy.md`
执行：集中核对实际目标、绑定、权限/Secrets 及备份恢复入口；满足后进入 R03。

### R03 staging 发布

依赖：V-CONFIG，部署获授权
范围：源码 0 文件；结果写 `docs/evidence/staging-deploy.md`
目标：备份后应用缺失迁移，发布同一提交的 Worker 与前端并记录版本/水位；仅当前水位为 0018 时，缺失范围才是 0019–0023。

## staging 独立验收

### V-CLOUD 完整业务链路

依赖：R03
文件：`docs/evidence/full-workflow.md`、`docs/evidence/web-chat.json`
验证：登录、Key/权限、分组/模型、聊天与重生成、分页、取消和账单形成完整链路；真实多 Key 共享限额及 Cron 恢复正确，无数据泄漏或重复扣费。

### V-UPSTREAM 真实供应商

依赖：R03；供应商、模型、账户及费用上限获批准
文件：`docs/evidence/real-upstream-2026-10.md`（新增）
验证：复用 `scripts/verify-upstream-matrix.ts`，以固定小额样例覆盖 Chat/Responses/Messages 九种组合的 JSON/SSE、工具多轮、usage/价格、取消和可安全重试边界；不支持与未测能力分别记录。

### V-MAIL 邮件链路

依赖：R03，发件域与收件人明确
文件：`docs/evidence/mail-2026-10.md`（新增）
验证：发送/重发、验证码有效性与错误限制、投递失败及注册开关，记录真实收信结果；通过后才标记生产邮箱验证就绪。

### V-CAPACITY 容量与故障

依赖：V-CLOUD，负载目标、持续时间和预算获批准
文件：`docs/evidence/capacity-2026-10.md`（新增）
验证：隔离账户和受控上游下测定并发/RPM、长流/断连、渠道/存储故障、资源释放及透支边界，报告实际支撑范围；不对第三方真实模型端点压测。

### V-RESTORE 恢复

依赖：R01，隔离恢复环境获批准
文件：`docs/evidence/restore-2026-10.md`（新增）
验证：按 `docs/backup-restore.md`、`docs/rollback.md` 在隔离环境恢复，复用 `scripts/verify-restored-database.ts` 确认数据关系及可运行版本；不覆盖生产库。

## production 发布与收口

### R04 production 发布

依赖：V-CLOUD、V-UPSTREAM、V-MAIL、V-CAPACITY、V-RESTORE；生产发布获批准
范围：源码 0 文件；`docs/evidence/production-release-2026-10.md`（新增）
目标：备份、按差异迁移并发布已验收提交，记录版本和回退关联。

### V-PROD 发布后验收

依赖：R04
文件：`docs/evidence/production-release-2026-10.md`
验证：对实际 HTTPS 入口、静态资源、登录、授权小额调用和账单做烟测，并观察一次真实 Cron；关联发布版本，未达标按预定条件回退。

### D06 状态收口

依赖：V-PROD
文件：`docs/implementation-plan.md`、`docs/evidence.md`、`docs/known-issues.md`
目标：完成项附证据，受阻/未完成项保留状态；CHAT-RELEASE 在发布验收后关闭，旧 26 项依 `docs/task-graph.json`、`docs/task-breakdown.md` 逐项对照证据回填。

## 完成标准

27 项开发达到目标，模块及集成验证通过；发布记录包含实际版本、迁移水位和线上验收结果。


# 旧 507 节点实施历史

> 本文保留既有 507 节点计划与任务状态。它是实施历史和未收口事项入口，不是新用户上手说明，也不作为线上当前版本证明。文档整理未改动任务完成状态或替代后置验收；使用入口见[文档导航](README.md)，实际代码已超出早期基础工程阶段。

状态：持续实现中，完成480 / 进行中0 / 待实现1 / 后置验收26。

实施依据为 [完整技术方案 v1.0](architecture.md)。原来的 M0–M4 大阶段已细分为 **507 个节点**，每个实现任务最多三个文件，含必要的独立集成/修复节点。

- [完整微任务清单与拓扑层](task-breakdown.md)
- [结构化任务图与合法串行顺序](task-graph.json)
- [一期目标与验收范围](phase-1.md)

## 执行规则

默认一次只执行一个节点。先确认该节点的有效前置和外部输入，只改列出的最多三个版本控制文件；实现、测试、迁移、锁文件和路由挂载都计数。需要第四个文件时先拆新节点，不把多个小任务合并成一次大改动。

任务之间既有功能依赖，也有写同一文件产生的顺序依赖。使用 task-graph.json 的 effective_dependencies 判断是否就绪；同层可并行，但层不是全局屏障，外部输入受阻不妨碍另一分支推进。

不为每次业务变更强制更新计划或 README。需要记录进度时安排独立文档变更，避免隐性增加第四个文件。这里的任务是工作单元，不自动创建应用中的独立任务或启动后台执行。

## 历史进度

已完成 **480** 项，进行中 **0** 项，待实现 **1** 项，用户暂缓验收 **26** 项。总节点 507（新增小型集成/修复任务仍限制每次最多三文件）。

已完成：`F01`、`P21`、`F02`、`P21-L`、`F03`、`F04`、`F14-D`、`F05`、`F08`、`P01`、`F06`、`F09`、`F04-WEB-LIB`、`X01`、`A16`、`F06-W`、`F07`、`F10`、`F11`、`F12`、`F13`、`L01`、`L04`、`C01`、`C02`、`B01`、`P02`、`P03`、`P04`、`P05`、`P07`、`F07-ISO`、`F14`、`D01`、`L02`、`A13`、`C12`、`B02`、`P06`、`P08`、`P10`、`P11`、`P12`、`P13`、`P14`、`P-CR-Q1`、`P-CR-J1`、`P-CM-Q1`、`P-CM-J1`、`P-RC-Q1`、`P-RC-J1`、`P-RM-Q1`、`P-RM-J1`、`P-MC-Q1`、`P-MC-J1`、`P-MR-Q1`、`P-MR-J1`、`U01`、`F10-FIX`、`G04-BODY`、`P04-OUTPUT-CONFIG`、`F15`、`D02`、`D07`、`D14`、`L03`、`P09`、`P15`、`P16`、`P17`、`P-CR-Q2`、`P-CR-J2`、`P-CM-Q2`、`P-CM-J2`、`P-RC-Q2`、`P-RC-J2`、`P-RM-Q2`、`P-RM-J2`、`P-MC-Q2`、`P-MC-J2`、`P-MR-Q2`、`P-MR-J2`、`G04`、`G05`、`G06`、`AUDIT-CLIENT`、`G04-BODY-HARDEN`、`F16`、`D03`、`D04`、`D05`、`D06`、`D08`、`D11`、`L05`、`A01`、`C15`、`P18`、`P19`、`P20`、`P-CR-Q3`、`P-CR-J3`、`P-CR-S1`、`P-CM-Q3`、`P-CM-J3`、`P-CM-S1`、`P-RC-Q3`、`P-RC-J3`、`P-RC-S1`、`P-RM-Q3`、`P-RM-J3`、`P-RM-S1`、`P-MC-Q3`、`P-MC-J3`、`P-MC-S1`、`P-MR-Q3`、`P-MR-J3`、`P-MR-S1`、`D01-FIX`、`AUDIT-CLIENT-MODEL`、`D09`、`D12`、`O01`、`L06`、`A02`、`A14`、`A25`、`A29`、`B17`、`P-CR-Q4`、`P-CR-J3-E`、`P-CR-S2`、`P-CM-Q4`、`P-CM-J3-E`、`P-CM-S2`、`P-RC-Q4`、`P-RC-J3-E`、`P-RC-S2`、`P-RM-Q4`、`P-RM-J3-E`、`P-RM-S2`、`P-MC-Q4`、`P-MC-J3-E`、`P-MC-S2`、`P-MR-Q4`、`P-MR-J3-E`、`P-MR-S2`、`A11-D`、`A25-D`、`L08-GATE-PEEK`、`P22-EXPORTS`、`D10`、`L07`、`L08`、`A03`、`A09`、`A11`、`A15`、`A21`、`A23`、`C03`、`C06`、`C08`、`P-CR-Q4-O`、`P-CR-J3-T`、`P-CR-S3`、`P-CM-Q4-O`、`P-CM-J3-T`、`P-CM-S3`、`P-RC-Q4-O`、`P-RC-J3-T`、`P-RC-S3`、`P-RM-Q4-O`、`P-RM-J3-T`、`P-RM-S3`、`P-MC-Q4-O`、`P-MC-J3-T`、`P-MC-S3`、`P-MR-Q4-O`、`P-MR-J3-T`、`P-MR-S3`、`A25-IDEM`、`L09-GATE`、`D13`、`L10`、`A04`、`A06`、`A07`、`A11-L`、`A17`、`A25-L`、`C10`、`C14`、`B03`、`P-CR-Q5`、`P-CR-J4`、`P-CR-S4`、`P-CM-Q5`、`P-CM-J4`、`P-CM-S4`、`P-RC-Q5`、`P-RC-J4`、`P-RC-S4`、`P-RM-Q5`、`P-RM-J4`、`P-RM-S4`、`P-MC-Q5`、`P-MC-J4`、`P-MC-S4`、`P-MR-Q5`、`P-MR-J4`、`P-MR-S4`、`L08-REG`、`L09-CLIENT`、`L09`、`A05`、`A08`、`A11-R`、`A18`、`A20`、`A25-U`、`A26`、`A27`、`A30`、`C13`、`B04`、`B09`、`P-CR-Q6`、`P-CR-S5`、`P-CM-Q6`、`P-CM-S5`、`P-RC-Q6`、`P-RC-S5`、`P-RM-Q6`、`P-RM-S5`、`P-MC-Q6`、`P-MC-S5`、`P-MR-Q6`、`P-MR-S5`、`R04`、`CF-D1-CASE`、`A10`、`A12`、`A19`、`A20-O`、`A22`、`A26-C`、`A28`、`C04`、`C07`、`C09`、`C11`、`C16`、`B05`、`B06`、`B10`、`B11`、`P-CR-S6`、`P-CM-S6`、`P-RC-S6`、`P-RM-S6`、`P-MC-S6`、`P-MR-S6`、`G01`、`G15`、`U06`、`O02`、`Q06`、`B09-TIME`、`CM-STREAM-OPTIONS`、`A12-C`、`A22-C`、`A26-U`、`C04-C`、`C07-C`、`C09-C`、`B07`、`B08`、`B10-A`、`B12`、`B13`、`B19`、`P22`、`G02`、`G13`、`U07`、`U18`、`U34`、`A31-EARLY`、`A10-LAZY`、`B11-TIME`、`CR-TERMINAL-GUARD`、`A12-R`、`A24`、`A26-R`、`C05`、`C07-U`、`C09-U`、`B14`、`P23`、`G03`、`G20`、`U09`、`U14`、`U24`、`R05`、`A31-SESSION`、`C17-ENV`、`B10-TIME`、`G01-STRICT`、`P22-REQUEST-BUDGET`、`B15`、`B18`、`G12`、`U02`、`U10`、`U15`、`U17`、`U19`、`U21`、`U25`、`U27`、`U30`、`U33`、`Q05`、`AUDIT-ENTRY`、`AUDIT-LOGIN`、`A12-LAZY`、`A22-LAZY`、`G03-HISTORY`、`B16`、`G07`、`G08`、`U03`、`U08`、`U11`、`U16`、`U20`、`U22`、`U26`、`U28`、`U31`、`AUDIT-BOOTSTRAP`、`A31`、`B21`、`G09`、`U04`、`U12`、`U23`、`U29`、`U32`、`AUDIT-HTTPS`、`C17`、`G10`、`U05`、`U04-REGISTER`、`Q03-HARNESS`、`G11`、`U13`、`U05-LINK`、`B20-EARLY`、`B20`、`G14`、`G21`、`Q03`、`U35-REGISTRATION`、`G11-STREAM`、`G16`、`G17`、`G18`、`U35`、`Q04`、`Q03-EVIDENCE`、`JSON-NOFETCH`、`STREAM-NOFETCH-EXECUTE`、`G19`、`STREAM-NOFETCH-DISPATCH`、`UI-FOUNDATION`、`G22`、`G23`、`Q07`、`Q08`、`HTTP-INTEGRATION-NATIVE-FIX`、`Q-MATRIX-HELPER`、`UI-PUBLIC`、`O03`、`Q-CC`、`Q-CR`、`Q-CM`、`Q-RC`、`Q-RR`、`Q-RM`、`Q-MC`、`Q-MR`、`Q-MM`、`Q09`、`R01`、`UI-WORKSPACE`、`Q10`、`Q11`、`R02`、`R03`、`Q-MC-SSE`、`Q-MR-SSE`、`Q-MM-SSE`、`UI-USAGE`、`Q12`、`Q11-PORT`、`CF-STAGING-BASIC`、`UI-ROUTING`、`LOCAL-COMPLETION-EVIDENCE`、`UI-ADMIN`、`UI-REGISTRATION`、`UI-AUDIT-KEYS`、`UI-FORM-CONTROLS`、`UI-CONFIG-EDITORS`、`UI-USER-EDITORS`、`UI-BROWSER-ASSERTIONS`、`UI-DELIVERY`、`UI-CAPTURES`、`PC-PASSWORD`、`PC-CONCURRENCY`、`PC-GROUP-SCHEMA`、`PC-USER-GRANTS`、`PC-KEY-GROUPS`、`PC-ADMISSION`、`PC-CLIENTS`、`PC-KEY-FORMS`、`PC-ADMIN-FORMS`、`PC-CHANNEL-MODELS`、`PC-HOME`、`PC-FORM-LAYOUT`、`PC-DIALOG-LAYOUT`、`PC-ADMIN-TESTS`、`PC-KEY-TESTS`、`PC-BROWSER-COMPAT`、`PC-BROWSER-FLOW`、`PC-SPEC`、`PC-DELIVERY`、`LIMIT-DEFAULTS`、`LIMIT-ADMISSION`、`LIMIT-USERS`、`LIMIT-UI`、`LIMIT-CHANNELS`、`LIMIT-BROWSER`、`LIMIT-DELIVERY`、`CAT-SEEDS`、`CAT-UI`、`CAT-D1`、`CAT-BROWSER`、`CAT-DELIVERY`、`CHAT-DEPS`、`CHAT-GROUP-SCHEMA`、`CHAT-KEY-SCHEMA`、`CHAT-GROUP-API`、`CHAT-PRICE`、`CHAT-KEY-AUTH`、`CHAT-REQUEST-SCHEMA`、`CHAT-STORE-SCHEMA`、`CHAT-RECOVERY`、`CHAT-KEY-MGMT`、`CHAT-ADMISSION`、`CHAT-STORAGE`、`CHAT-ADMIN`、`CHAT-LOG-API`、`CHAT-GATEWAY`、`CHAT-STREAM`、`CHAT-LOG-ADMIN`、`CHAT-LOG-USER`、`CHAT-HTTP`、`CHAT-MOUNT`、`CHAT-CLIENT`、`CHAT-WEB-PARTS`、`CHAT-WEB`、`CHAT-INTEGRATION`、`CHAT-UI-TEST`、`CHAT-COMPAT-1`、`CHAT-COMPAT-2`、`CHAT-DOCS`、`CHAT-EVIDENCE`

历史记录中的下一项：

依赖已就绪：`CHAT-RELEASE`

真实云、邮件、模型调用、负载和最终验收按用户指示后置；不将其标为通过。本地类型、构建、原生D1/DO及必要单元测试随实现进行。工具命令见 [工具链说明](toolchain.md)。

## 起步顺序

从 F01 固定工作区开始，随后 F02 声明包、F03 固定锁文件、F04 类型配置。P21 来源/许可证核对可独立穿插。具体前十步和后续全部任务见微任务清单。

基础工程之后，数据库、协议公共类型、租约限流和前端骨架按各自依赖展开。注册、渠道、计费和转换分别完成后，再接网关与端到端验证。没有功能依赖时，不强制等整个 M1 完成才能写协议转换。

## 里程碑

| 原阶段 | 只读收口节点 | 达成条件 |
| --- | --- | --- |
| M0 最小工程与可行性 | K0 | 工具/版本固定；真实 D1、KDF、邮件、三种上游通过 |
| M1 注册与身份 | K1 | 三模式×验证开关、会话/Key、权限与原子核销、页面闭环 |
| M2 渠道与简单计费 | K2 | 模型/组/渠道、租约、KV 回源、允许负余额和幂等结算正确 |
| M3 三协议端到端 | K3 | 九格普通/SSE、真实客户端、工具多轮、usage、取消和引用隔离 |
| M4 控制台与交付 | K4 | P1-01 至 P1-13 有证据，含安全、负载、备份/恢复与部署说明 |

## 范围保持

一个 Worker + D1 + KV + 轻量 Gate DO + Email Service；无用户/渠道业务 DO 账本、Outbox、Queues、异步查询投影或独立 jobs 服务。余额缓存初始关闭、可配置启用；正式账单始终在 D1 原子提交，允许少量透支。

持续推进全部可实现节点；本地检查随代码进行。用户已要求暂缓真实上游、邮件、云环境、负载及最终验收，相应节点保留待验证状态。
