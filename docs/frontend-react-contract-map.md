# cheapai React 前端 API 契约图

本文件记录 React 前端使用的 Worker 字段与路由契约。输入/输出以 `packages/contracts`、`packages/api-client`、`apps/web/src/features` 中的解码器和查询适配器，以及 `apps/worker/routes.ts` 与领域路由为准。页面展示不扩展服务端未提供的事实。

## 通用契约

- /api/v1/** 管理 API 成功响应为 { data, request_id }，错误响应为 { error: { code, message }, request_id }。列表通常返回 { items, nextCursor }，不提供 total 或 pageCount。
- Worker session API 使用同源 Cookie。所有管理端写操作及聊天写操作均须使用现有 CSRF 流程；浏览器端不保存 session/API Key 到 localStorage。401 只能使发起请求时捕获的身份失效，不能使之后登录的身份失效。
- 常规分页默认 limit=20，Worker 最大 100，cursor 是不透明 base64url 字符串；分页游标绑定调用身份、权限范围和筛选条件。筛选改变时清空 cursor。React 列表通常请求 20 条；管理员用户表单读取 active 分组时按 limit=100 继续分页。
- 金额保持整数单位字符串；价格及倍率保持十进制字符串。null 代表未知/缺省/无限期等特定语义，不能统一填成 0。所有详情和管理读取都不返回上游密钥。
- operationId 是业务层操作标识，不等于通用 request ID。只有注明 Idempotency-Key 的接口支持调用方幂等键；其余 mutation 的审计 operation id 由 Worker 生成或取 request ID。写操作默认不自动重试。
- 除专门标注的匿名认证入口外，读取需要已登录用户；管理员接口还需要 active admin 身份及 active group。写操作还要求合法 Origin 与 CSRF token。

## 身份页面

| 页面 / 操作 | Endpoint、输入或筛选 | 返回 DTO 与交互约束 |
| --- | --- | --- |
| 初始化、注册状态 | GET /api/v1/settings/public；无查询参数 | 匿名。PublicSettings: registrationMode: closed/open/invite、emailVerificationEnabled、csrfToken。该读取会建立/刷新 CSRF 引导信息；邮件服务配置无效时 Worker 会 fail closed 投影注册状态。 |
| 恢复会话 | GET /api/v1/auth/me；无查询参数 | session 用户。PublicUser 字段保留 snake_case：id,email_normalized,role,status,group_id,group_status,balance_units,email_verified_at。余额是整数单位字符串，邮箱验证时间可为 null。 |
| 登录 | POST /api/v1/auth/login，JSON { email,password } | 匿名 + CSRF。返回 PublicUser，session 由 Cookie 建立；不以返回字段替代之后的权威 me 恢复。无幂等键。 |
| 注册 | POST /api/v1/auth/register，JSON { email,password,registrationCode?,emailCode? } | 匿名 + CSRF；具体必填受 public settings 控制。返回 { status:'created', user:{id,email_normalized}, session:'created' } 或 { ..., session:'login_required', next_action:'login' }。两种结果必须分别处理。 |
| 发送邮箱验证码 | POST /api/v1/auth/send-verify-code，JSON { email } | 匿名 + CSRF；邮件能力未就绪时不可用。返回 { status:'accepted', retry_after_ms }。5xx/网络错误不能推断邮件未送达；现有注册适配器将结果区分为 accepted / failed / unknown。 |
| 退出 | POST /api/v1/auth/logout，空 JSON body | 需现存 session + CSRF；返回 { loggedOut:true } 并清除 Cookie。 |

登录页按同一 PublicSettings.registrationMode 控制注册链接；关闭注册时隐藏入口，直接打开 `/register` 显示“当前未开放注册”。登录、注册之间以及注册成功后的跳转保留经本地路径校验的 `returnTo`。

## 网页聊天

所有 /api/v1/chat/** 路由要求 session + 写请求 CSRF，数据按当前用户隔离。非流式响应仍使用管理 API envelope；发送和重新生成可以返回 text/event-stream，相同 operationId 的重放也可能返回 JSON { data: { conversation,messages,replayed:true } }。

| 操作 | Endpoint、输入或筛选 | DTO / 幂等与版本语义 |
| --- | --- | --- |
| 模型选择器 | GET /api/v1/chat/models；无筛选 | `{ items: [{ id,name,billingMultiplier,models:[{publicModelId,maxOutputTokens,sellPrices}] }] }`。仅返回当前用户获授权的组与可用模型。`billingMultiplier` 和 `sellPrices` 报价使用十进制字符串，`sellPrices` 是 USD/百万 Token 的基价。React 选择项按 `(groupId,publicModelId)` 保留身份；报价展示应用分组倍率。`maxOutputTokens` 仅作服务端兼容数据，不显示为聊天控件。 |
| 会话历史 | GET /api/v1/chat/conversations?cursor&limit | { items: Conversation[],nextCursor }。Conversation: id,title,groupId,modelId,version,createdAt,updatedAt。只支持 cursor/limit，不支持服务端搜索。 |
| 新建会话 | POST /api/v1/chat/conversations，JSON { title?,groupId?,modelId? } | 返回 Conversation。组/模型可为 null（未选择）；服务端不要求 operationId。 |
| 会话详情 | GET /api/v1/chat/conversations/:id | { conversation,messages }；仅当前用户所有权范围内。消息含 id,conversationId,turnIndex,role,content,status,variant,selected,requestId,groupId,modelId,createdAt,updatedAt。requestId/groupId/modelId 可为 null；状态为 generating/completed/stopped/failed。 |
| 重命名/选择默认组模型 | PATCH /api/v1/chat/conversations/:id，JSON { version,title?,groupId?,modelId? } | 返回新 Conversation。version 是 CAS 版本；冲突保留编辑内容后刷新对比。未列字段应省略。 |
| 删除会话 | DELETE /api/v1/chat/conversations/:id，JSON { version } | 返回 { deleted:true }；使用当前会话 version。 |
| 发送消息 | POST /api/v1/chat/conversations/:id/messages；React JSON `{ operationId,conversationVersion,groupId,modelId,content }` | Worker 输入仍兼容可选 `maxOutputTokens`，React 当前请求不发送该字段。SSE 事件为 meta、delta、done、error；operationId 放 body，不是 Idempotency-Key。不确定结果的确认重试沿用同一 operationId。 |
| 重新生成最后回答 | POST /api/v1/chat/conversations/:id/regenerate；React JSON `{ operationId,conversationVersion,groupId,modelId }` | 与发送使用相同 SSE / replay 合同，React 不发送输出上限字段。重新生成是新的模型调用。 |
| 切换回答版本 | POST /api/v1/chat/conversations/:id/select，JSON { conversationVersion,messageId } | 返回最新 { conversation,messages }，使用会话版本 CAS。 |
| 停止生成 | 无单独 cancel endpoint | 浏览器中止对应流式 fetch，服务端 request signal 收到取消。若结果不明，客户端核对会话状态；确认重试继续使用原 operationId。 |

网页聊天路由为 `/` 与 `/chat/:id`。新对话先使用有效的最近选择，否则选目录中的首个授权项；已有会话保留原组和模型。匿名用户可以编辑草稿，登录后回到原地址，草稿恢复但不会自动发送。历史分页由滚动触底加载。

## 个人费用、使用记录与 API 接入

个人受保护页面使用轻量 `PersonalLayout`。`/dashboard` 仅为旧链接保留，使用 replace 跳转到 `/billing`。

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / 权限与限制 |
| --- | --- | --- |
| 账户余额 | GET /api/v1/account/balance | 登录用户。{ currency:'USD',decimals:8,balance_units:string,balance_usd:string }；两字段必须精确一致，禁止浮点计算。 |
| 最近请求与请求列表 | GET /api/v1/usage/requests，query cursor,limit,from,to,status,billingStatus,model | 登录用户范围由 session 决定；from/to 是 UTC 毫秒且两端包含。返回 { items:RequestRecord[],snapshotAt,nextCursor }。RequestRecord 核心字段为 id,user_id,api_key_id,source,group_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,execution_status,billing_status,created_at,started_at,finished_at,updated_at,usage,usage_valid,price_snapshot,price_snapshot_valid,cost_units,error,retry_count,next_retry_at。历史旧行可能没有 source/group_id，缺省分别解为 api/null。 |
| 请求详情 | GET /api/v1/usage/requests/:id | 登录用户且 ID 必须属于当前用户，否则 404。返回同一 RequestRecord。cost_units:null 是未知/尚未结算，不是零；usage:null 与 usage_valid:null/false 也分别表达无记录/无效证据。执行状态和结算状态分开显示。 |
| 费用明细与期间汇总 | GET /api/v1/billing/entries，query cursor,limit,kind,requestId,createdFrom,createdBefore | 时间为 UTC 毫秒，`createdFrom` 包含、`createdBefore` 不包含。返回 `{ items,nextCursor,summary? }`。条目 `modelId`、`source` 可空；来源为 `api` 或 `web_chat`。个人首屏 `summary` 含 `currency,consumptionUnits,createdFrom,createdBefore`；消费合计覆盖完整日期范围内全部 consumption 条目，不受 kind、requestId、cursor 或 limit 影响。管理响应和个人续页可以省略 summary。 |
| Key 可用分组与价格 | GET /api/v1/account/key-groups | 登录用户；返回 `{ items:[{id,name,models,billingMultiplier,modelPrices}] }`。`models` 为模型 ID 数组；`modelPrices` 按模型 ID 索引，值为十进制 USD/百万 Token 基价，`billingMultiplier` 单独返回。 |
| API Key 列表 | GET /api/v1/keys，query cursor,state,limit | 登录用户范围固定。state: all/active/expired/revoked，客户端默认 20。KeyMetadata: id,userId,groupId,groupName,name,displayPrefix,status,allowedModels,expiresAt,createdAt,updatedAt,version。allowedModels:null 表示所选组允许范围内不额外限制模型；expiresAt:null 表示永不过期。 |
| API Key 详情 | GET /api/v1/keys/:id | 仅 Key 所有者可读；返回 KeyMetadata，永不返回明文 token。 |
| 创建 API Key | POST /api/v1/keys，React JSON `{ name,expiresAt,groupId }` | 登录用户 + CSRF + Idempotency-Key。结果为 `{kind:'created',key,token}` 或 `{kind:'replayed',key}`；明文 token 只在首次创建响应出现。当前页面为所选分组创建 Key，不提交自定义 `allowedModels`。 |
| 编辑 API Key | PATCH /api/v1/keys/:id，JSON { version,name?,expiresAt?,groupId?,allowedModels? } | 登录用户 + CSRF；version CAS。将 expiresAt 设为 null 才表示不设到期日。更新按当前 API 输入整形，提交前保留用户未改字段。 |
| 撤销 API Key | POST /api/v1/keys/:id/revoke，JSON { version } | 登录用户 + CSRF；version CAS。结果 {kind:'revoked'|'already_revoked',key}。 |

费用页读取独立的完整期间消费汇总，不从当前游标页估算金额。使用记录默认显示时间、模型、来源、结果和费用；详情中的技术字段、Token 用量和价格快照按需展开。`cost_units:null` 按结算状态显示待结算或费用未知，不显示成 `$0`。

## API 接入指南

`/keys` 在同一页面连续呈现 Base URL、Key 列表和调用示例。Base URL 使用当前页面 origin 加 `/v1`；Vite 开发服务器也代理该路径。示例按所选 Key 的 `allowedModels` 与分组可用模型交集生成；没有选择 Key 时使用可用分组。Messages 示例保留外部协议要求的 `max_tokens`。这些 Worker 外部接口使用原生协议，不属于 JSON 管理 API envelope：

| 外部调用 | 鉴权 / 返回 |
| --- | --- |
| GET /v1/models | Authorization: Bearer <API Key>；不接受 query；返回原生 {object:'list',data:[{id,object:'model',created,owned_by}]}，只含 Key 当前获授权并有 active channel 映射的模型。 |
| POST /v1/chat/completions | Bearer API Key；Chat Completions 原生 JSON/SSE 协议。 |
| POST /v1/responses | Bearer API Key；Responses 原生 JSON/SSE 协议。 |
| POST /v1/messages | Bearer API Key；Messages 原生 JSON/SSE 协议。 |

协议错误和流式数据不得经过管理 API envelope 解码器。当前 Server API 的 `owned_by:'sub2api'` 是兼容协议字段，不是产品品牌标题；重构品牌不改变协议值、cookie/key 前缀或云资源标识。

## 管理控制台：资源配置

所有资源读取/写入均为 active admin + session；所有写入另需 CSRF。列表 cursor/status 筛选变化后从首批开始；渠道、模型和访问组详情使用各自的安全 GET 投影。

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / version / operationId |
| --- | --- | --- |
| 渠道列表 | GET /api/v1/admin/channels，query cursor,status | status: active/disabled；返回 {items,nextCursor}。ChannelView: id,name,baseUrl,status,priority,concurrencyLimit,rpmLimit,configVersion,createdAt,updatedAt,hasCredential,models[]。models 含 publicModelId,upstreamModel,protocol,mappingVersion,priceVersion。只回 hasCredential，不回 secret。 |
| 渠道详情 | GET /api/v1/admin/channels/:id | active admin；返回 ChannelView 安全投影，不含凭据明文。 |
| 新建渠道 | POST /api/v1/admin/channels，JSON { name,baseUrl,upstreamKey,concurrencyLimit?,rpmLimit?,priority?,status? } | CSRF；返回 ChannelView。Worker 写审计 operationId 为内部生成 UUID，无调用方幂等键。 |
| 更新渠道 | PATCH /api/v1/admin/channels/:id，JSON { version,name?,baseUrl?,upstreamKey?,concurrencyLimit?,rpmLimit?,priority?,status? } | version 必须是当前 configVersion，成功递增。省略 upstreamKey 表示保持原密钥；null/空字符串不能删除或清空密钥，空字段无“保持”特例。操作审计 ID 由 Worker 生成。 |
| 主动渠道诊断 | POST /api/v1/admin/channels/:id/test，JSON { publicModelId,protocol,channelVersion,mappingVersion,priceVersion } | active admin + CSRF；提交的三个版本必须和现有资源匹配。返回 diagnosticId,channelId,publicModelId,protocol,outcome,upstreamStatus,channelVersion,mappingVersion,priceVersion,maxOutputTokens,mayIncurUpstreamCost:true,userBalanceCharged:false。只有用户显式操作可触发，可能花费上游余额；不会生成业务账单。 |
| 模型列表 | GET /api/v1/admin/models，query cursor,status | status: active/disabled。返回 {items,nextCursor}。ModelView: publicModelId,status,sellPrices,priceVersion,admissionMinBalanceUnits,maxOutputTokens,createdAt,updatedAt。没有独立 version，priceVersion 同时作为所有模型字段修改的 CAS 版本。 |
| 模型详情 | GET /api/v1/admin/models/:id | active admin；返回 ModelView。 |
| 创建模型 | POST /api/v1/admin/models，JSON { publicModelId,status?,sellPrices,admissionMinBalanceUnits,maxOutputTokens } | active admin + CSRF；sellPrices 至少含 input/output，可含 cacheRead/cacheWrite/cacheWrite5m/cacheWrite1h/reasoning；USD/百万 Token，精确十进制字符串，最多 8 位小数。admissionMinBalanceUnits 为整数单位字符串，maxOutputTokens 正整数。审计 operationId 由 Worker 生成。 |
| 更新模型 | PATCH /api/v1/admin/models/:id，JSON { version,status?,sellPrices?,admissionMinBalanceUnits?,maxOutputTokens? } | version 实际等于 priceVersion。若发送 sellPrices，是完整替换，不是部分合并，不提供缺失 bucket 的隐式零价。路径 ID 需作为单段编码；公开模型 ID 可包含 /、:。 |
| 模型渠道映射列表 | GET /api/v1/admin/models/:publicModelId/mappings，query protocol,activeOnly | protocol: chat/responses/messages；activeOnly 是字符串 boolean。返回 {items:ModelMappingView[]}；每项 channelId,publicModelId,protocol,upstreamModel,capabilities,configVersion。 |
| 新建映射 | POST /api/v1/admin/models/:publicModelId/mappings，JSON { channelId,protocol,upstreamModel,capabilities } | 返回 ModelMappingView；审计 operationId Worker 内部生成。mapping configuration 不代表该组已授权或协议适配一定可运行。 |
| 更新映射 | PATCH /api/v1/admin/models/:publicModelId/mappings/:channelId/:protocol，JSON { version,upstreamModel?,capabilities? } | version 必须等于 mapping configVersion，成功递增；路径中公开模型 ID 必须编码为单路径段，protocol 仍为 chat/responses/messages。 |
| 访问组列表 | GET /api/v1/admin/groups，query cursor,status | status: active/disabled。返回 GroupView[]：id,name,status,version,createdAt,updatedAt,channelIds,billingMultiplier。倍率为最多 18 位小数的非负十进制字符串；channelIds 是关联集合。 |
| 访问组详情 | GET /api/v1/admin/groups/:id | active admin；返回 GroupView。 |
| 创建访问组 | POST /api/v1/admin/groups，JSON { name,status?,channelIds?,billingMultiplier? } | 返回 GroupView。默认 status active、channelIds 空、倍率 "1"；没有调用方 Idempotency-Key，audit operationId 使用 Worker request ID。 |
| 更新访问组 | PATCH /api/v1/admin/groups/:id，JSON { version,name?,status?,channelIds?,billingMultiplier? } | version 为 CAS；channelIds 是完整集合替换。停用默认组前须先迁移默认组配置；保留最后一个可用管理员等业务限制。audit operationId 使用 request ID。 |

ChannelView.concurrencyLimit/rpmLimit 和用户 limits 在成功读取中是安全整数，不以 null 输出。Worker 写入配置将缺省、null 或 0 解释为无限制并归一化为 Number.MAX_SAFE_INTEGER；有限值是正整数。React 表单把哨兵显示为“不限”，并在提交时将不限规范化为 Worker 接受的语义。该规则不适用于余额或费用金额。

## 管理控制台：用户与授权

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / 权限与状态 |
| --- | --- | --- |
| 用户列表 | GET /api/v1/admin/users，query cursor,status,groupId | status: active/disabled，groupId 精确匹配；返回 {items,nextCursor,snapshotAt}。row 是安全公开投影：所有 PublicUser 字段 + allowed_group_ids,group_name,concurrency_limit,rpm_limit,created_at,updated_at,version。snapshotAt 只限制新建用户，不冻结之后的状态/组编辑。cursor 绑定管理员、筛选与 snapshot。 |
| 用户详情 | GET /api/v1/admin/users/:id | active admin；返回与列表一致的安全公开投影，未找到时 404。 |
| 用户可分配组 | GET /api/v1/admin/groups?status=active&limit=100&cursor | 当前前端用作用户编辑选项；响应包括完整 GroupView，但 UI 仅可使用 id/name/status。循环 cursor 直到 null，不能把单页的 100 条假称全集。 |
| 新建用户 | POST /api/v1/admin/users，JSON { email,password,groupId? } | active admin + CSRF；返回 PublicUser（snake_case），role/balance 不可由调用方设置；默认组来自 Worker 配置。审计 operationId 用 request ID。 |
| 编辑用户 | PATCH /api/v1/admin/users/:id，JSON { version,status?,groupId?,concurrencyLimit?,rpmLimit?,allowedGroupIds? } | version 为 CAS。字段可以部分提交；若更改 groupId 且省略 allowedGroupIds，授权集合重置成新主组；若传 allowedGroupIds，必须含当前主组。不能停用最后一个 active admin。Worker 响应还含若干列表字段，但旧客户端只解成 PublicUser，改后须重新读取用户 row 才拿到新 version/limits。 |
| 用户授额 | POST /api/v1/admin/users/:id/balance-adjustments，JSON { kind:'grant'|'adjustment',deltaUnits:string,reason:string,requestId?:string|null } | active admin + CSRF + Idempotency-Key。金额是有符号最小 USD 单位字符串；grant 必须正值。服务端把键摘要成稳定 operationId，返回 { entry,outcome:'inserted'|'existing' }；重试同一操作复用原键和 payload。entry.deltaUnits 保持字符串。 |
| 管理员撤销用户 Key | POST /api/v1/admin/keys/:id/revoke，JSON { version } | active admin + CSRF。version CAS；结果 { kind:'revoked'|'already_revoked', key:{id,userId,status,version,createdAt,updatedAt} }。仅撤销 API Key，不展示 token。 |

详情页关联请求与账单可使用现有 admin requests/billing 的 userId 筛选，不新增全量查询接口。

## 管理控制台：账单、请求、注册和审计

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / 状态 |
| --- | --- | --- |
| 管理请求列表 | GET /api/v1/admin/requests，query cursor,limit,from,to,status,billingStatus,model,userId | active admin。筛选定义与个人请求相同，额外 userId；from/to 两端均包含 UTC 毫秒。返回 {items,snapshotAt,nextCursor} 与同一个 RequestRecord DTO。cursor 绑定管理员、范围和过滤器。 |
| 管理请求详情 | GET /api/v1/admin/requests/:id | active admin。返回 RequestRecord，服务端脱敏错误只有 {code,message}；原始上游正文、提示词和 provider JSON 不可见。 |
| 请求结算重试 | POST /api/v1/admin/requests/:id/retry-settlement，无 body 或 {} | active admin + CSRF。只重试 billing_status=settlement_pending 且具有完整一致 usage/价格证据的请求，不调用上游。没有 Idempotency-Key；Worker 用稳定 consume:<requestId> 并检查 ledger，返回 {status:'settled'|'already_settled',requestId,entryId,costUnits}。不可把其他结算状态都显示成可重试。 |
| 管理账本 | GET /api/v1/admin/billing/entries，query cursor,limit,kind,requestId,createdFrom,createdBefore,userId | active admin；与个人账本 DTO 相同。createdFrom 包含，createdBefore 不包含；kind=consumption/grant/adjustment。所有可选 query 单值；explicit null 不是可用筛选值。 |
| 账本余额核对 | GET /api/v1/admin/billing/reconciliation，query cursor,limit | active admin。返回 {items:[{userId,currency,balanceUnits,ledgerUnits,differenceUnits,entryCount,matches,negativeBalance}],nextCursor}。金额仍为字符串；不提供筛选。 |
| 注册策略读取 | GET /api/v1/admin/registration/settings | active admin。DTO 含 registrationMode,emailVerificationEnabled,version,updatedAt,valid,ready,emailAvailable,issues[]。前四项可为 null（缺少/损坏的存储状态）；issues 为 missing_settings/invalid_settings/email_unavailable。valid 与当前部署 ready 是不同事实。 |
| 更新注册策略 | PATCH /api/v1/admin/registration/settings，JSON { version,registrationMode,emailVerificationEnabled } | active admin + CSRF；version 必须有效并作为 CAS；Worker 支持单字段 patch，但当前 web API 发两字段。request ID 用于审计，无调用方幂等键。 |
| 邀请码列表 | GET /api/v1/admin/registration/codes，query cursor,limit,creatorFilter | active admin。返回 {items,nextCursor,snapshotAt}。row 字段 id,displayPrefix,ordinal,expiresAt,batchId,createdBy,createdAt,usedBy,usedAt,revokedAt,status；可空时间/用户保持 null；status 为 unused/used/expired/revoked。无 status filter。 |
| 生成邀请码 | POST /api/v1/admin/registration/codes，JSON { quantity,expiresAt } | active admin + CSRF + Idempotency-Key。quantity 在 1..后端限制（最多 100）；expiresAt 是必需的 UTC 毫秒绝对时间，必须是未来且不超过后端有效期上限。null 不代表永不过期。首次响应 { batchId,replayed:false,codes:[{id,displayPrefix,ordinal,expiresAt,token}] } 含 plaintext；重放返回 replayed:true 且只含 metadata，没有 token。 |
| 撤销邀请码 | POST /api/v1/admin/registration/codes/:id/revoke，无 body 或 {} | active admin + CSRF；无 caller idempotency key。返回 id/status/revokedAt；already used 是 conflict，not found 是 404。 |
| 审计日志 | GET /api/v1/admin/audit，query cursor,limit,from,to,actorId,action,targetType,targetId,operationId | active admin；from/to 为包含端点的 UTC 毫秒。返回 {items:[{id,actor_id,action,target_type,target_id,operation_id,created_at,changes,redaction_valid}],snapshotAt,nextCursor}；redacted changes 可能为 null，redaction_valid=false 表示不能安全解码。cursor 绑定操作者、时间上界和完整筛选。 |

## 管理资源详情读取

渠道、模型、访问组和用户详情 GET 均已由 Worker 挂载，要求 active admin session 并返回安全投影；凭据明文和密码材料不出现在响应中。

## 契约特别风险与 React 实施提醒

1. **线格式命名不统一。** auth/user/request/audit DTO 含 snake_case；chat/channel/model/group/key/billing DTO 含 camelCase。不要以通用 adapter 全面 camelize。
2. **两个“版本”语义。** model 写入 body version 实际 CAS priceVersion；mapping 的 configVersion 与 channel configVersion 独立。渠道诊断必须同时携带这三个版本，保存其中一个资源会使旧探测请求冲突。
3. **limit 语义客户端与服务端不一致。** Worker 对 channel/user 接受 null/0 => unlimited 并对外输出 Number.MAX_SAFE_INTEGER 哨兵；旧 API TS 仅写 number 且 decode 强制 >=1。React 表单应将哨兵解释为无限制，并在接口边界规范化，不用 JS 浮点或巨大数字作为可见显示值。
4. **幂等支持不统一。** API Key 创建、管理员授额、邀请码批次用 Idempotency-Key；chat 在 JSON body 用 operationId；其他配置写入一般由 Worker 生成审计 ID，没有重放语义。未知网络结果只在有幂等合同的接口上复用相同 key，不要自动生成新键重放。
5. **列表快照不是通用 DB 快照。** request/audit/key/billing cursor 绑定查询和时间/行上界；admin users 的 snapshotAt 只筛掉之后创建的新用户，状态和组仍可能变化。切换筛选要重置 cursor；不能合并不同筛选的旧页。
6. **价格/usage 都是证据快照。** request cost_units、price snapshot、usage 可能 null 或 invalid。执行成功并不说明已结算；usage 子计数可能是 input/output 子集，按 semantics 展示，不重新求和或估算权威金额。
7. **密钥明文只出现一次。** API Key 与邀请码首次创建返回 plaintext；replayed 结果不带它。读取结果、React Query cache、日志和持久草稿均不能保存明文；仅临时显式结果态供用户复制。
8. **服务端能力边界。** 尚无渠道实时健康、通用概览聚合、usage 图表、全量会话搜索或支付/充值。个人账单期间汇总只来自专门的 billing summary；不能从分页明细推算其他聚合。渠道 active 不是在线探测成功，mapping 存在也不表示用户授权。

## 本图来源

- Contracts 与 API client：packages/contracts/src/*.ts、packages/api-client/src/*.ts；React feature 查询适配器位于 apps/web/src/features/。
- Worker 路由装配：apps/worker/routes.ts；领域合同：apps/worker/auth/**、apps/worker/chat/routes.ts、apps/worker/admin/**、apps/worker/billing/**、apps/worker/gateway/request-query-routes.ts。
- 页面路由与实现边界：apps/web/src/app/router.tsx、docs/frontend-react-module-boundaries.md；UX 目标与文件级任务：docs/ux-redesign-plan.md。
