# cheapai React 前端 API 契约图

本文件为 React 重构的字段与路由依据，区分现存 Worker 契约和计划新增的详情读取接口。输入/输出按当前 apps/web/src/api 解码器和 apps/worker/routes.ts 实际挂载的路由记录；Worker 子路由决定权限、字段白名单与查询语义。没有记录在来源中的 UI 字段不能由新页面推断。

## 通用契约

- /api/v1/** 管理 API 成功响应为 { data, request_id }，错误响应为 { error: { code, message }, request_id }。列表通常返回 { items, nextCursor }，不提供 total 或 pageCount。
- Worker session API 使用同源 Cookie。所有管理端写操作及聊天写操作均须使用现有 CSRF 流程；浏览器端不保存 session/API Key 到 localStorage。401 只能使发起请求时捕获的身份失效，不能使之后登录的身份失效。
- 常规分页默认 limit=20，Worker 最大 100，cursor 是不透明 base64url 字符串；分页游标绑定调用身份、权限范围和筛选条件。筛选改变时清空 cursor。当前旧客户端大部分请求 20 条；给管理员用户表单选择访问组的辅助请求以 limit=100 分页读取 active 组。
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

## 聊天工作台

所有 /api/v1/chat/** 路由要求 session + 写请求 CSRF，数据按当前用户隔离。非流式响应仍使用管理 API envelope；发送和重新生成可以返回 text/event-stream，相同 operationId 的重放也可能返回 JSON { data: { conversation,messages,replayed:true } }。

| 操作 | Endpoint、输入或筛选 | DTO / 幂等与版本语义 |
| --- | --- | --- |
| 模型选择器 | GET /api/v1/chat/models；无筛选 | { items: ChatGroup[] }，每组 { id,name,billingMultiplier,models:[{publicModelId,maxOutputTokens?}] }。仅返回用户当前获授权的组与可用模型；没有价格或上下文窗口字段。倍率是十进制字符串，maxOutputTokens 缺失与正整数须区分。 |
| 会话历史 | GET /api/v1/chat/conversations?cursor&limit | { items: Conversation[],nextCursor }。Conversation: id,title,groupId,modelId,version,createdAt,updatedAt。只支持 cursor/limit，不支持服务端搜索。 |
| 新建会话 | POST /api/v1/chat/conversations，JSON { title?,groupId?,modelId? } | 返回 Conversation。组/模型可为 null（未选择）；服务端不要求 operationId。 |
| 会话详情 | GET /api/v1/chat/conversations/:id | { conversation,messages }；仅当前用户所有权范围内。消息含 id,conversationId,turnIndex,role,content,status,variant,selected,requestId,groupId,modelId,createdAt,updatedAt。requestId/groupId/modelId 可为 null；状态为 generating/completed/stopped/failed。 |
| 重命名/选择默认组模型 | PATCH /api/v1/chat/conversations/:id，JSON { version,title?,groupId?,modelId? } | 返回新 Conversation。version 是 CAS 版本；冲突保留编辑内容后刷新对比。未列字段应省略。 |
| 删除会话 | DELETE /api/v1/chat/conversations/:id，JSON { version } | 返回 { deleted:true }；使用当前会话 version。 |
| 发送消息 | POST /api/v1/chat/conversations/:id/messages，JSON { operationId,conversationVersion,groupId,modelId,content,maxOutputTokens? } | SSE 事件为 meta（conversation/userMessage/assistantMessage）、delta（text）、done（message/billingStatus?）、error（code/message/messageId?）。operationId 放 body，不是 Idempotency-Key；同一 payload 的不确定结果重试须复用原 ID。流式文本不是最终消息 DTO。 |
| 重新生成最后回答 | POST /api/v1/chat/conversations/:id/regenerate，JSON { operationId,conversationVersion,groupId,modelId,maxOutputTokens? } | 与发送使用相同 SSE / replay 合同，操作 ID 需要稳定。 |
| 切换回答版本 | POST /api/v1/chat/conversations/:id/select，JSON { conversationVersion,messageId } | 返回最新 { conversation,messages }，使用会话版本 CAS。 |
| 停止生成 | 无单独 cancel endpoint | 旧客户端通过中止对应流式 fetch，让服务端 request signal 收到取消；若结果不明，应 GET 会话详情核对持久化状态，再决定恢复，不创建第二个 operationId。 |

## 个人控制台

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / 权限与限制 |
| --- | --- | --- |
| 账户余额 | GET /api/v1/account/balance | 登录用户。{ currency:'USD',decimals:8,balance_units:string,balance_usd:string }；两字段必须精确一致，禁止浮点计算。 |
| 最近请求与请求列表 | GET /api/v1/usage/requests，query cursor,limit,from,to,status,billingStatus,model | 登录用户范围由 session 决定；from/to 是 UTC 毫秒且两端包含。返回 { items:RequestRecord[],snapshotAt,nextCursor }。RequestRecord 核心字段为 id,user_id,api_key_id,source,group_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,execution_status,billing_status,created_at,started_at,finished_at,updated_at,usage,usage_valid,price_snapshot,price_snapshot_valid,cost_units,error,retry_count,next_retry_at。历史旧行可能没有 source/group_id，缺省分别解为 api/null。 |
| 请求详情 | GET /api/v1/usage/requests/:id | 登录用户且 ID 必须属于当前用户，否则 404。返回同一 RequestRecord。cost_units:null 是未知/尚未结算，不是零；usage:null 与 usage_valid:null/false 也分别表达无记录/无效证据。执行状态和结算状态分开显示。 |
| 账单 | GET /api/v1/billing/entries，query cursor,limit,kind,requestId,createdFrom,createdBefore | 登录用户范围固定。时间为 UTC ms，createdFrom 包含、createdBefore 不包含。kind 为 consumption/grant/adjustment。返回 { items,nextCursor }；entry 字段 id,operationId,kind,userId,requestId,currency,deltaUnits,createdBy,reason,createdAt，金额是有符号最小 USD 单位整数字符串，requestId/createdBy/reason 可 null，createdAt 为 ISO 字符串。 |
| API Key 授权组 | GET /api/v1/account/key-groups | 登录用户；无筛选。返回 { items:[{id,name,models:string[]}] }，仅可授权组。不能与聊天模型目录混同：models 是该组中模型 ID 列表。 |
| API Key 列表 | GET /api/v1/keys，query cursor,state,limit | 登录用户范围固定。state: all/active/expired/revoked，客户端默认 20。KeyMetadata: id,userId,groupId,groupName,name,displayPrefix,status,allowedModels,expiresAt,createdAt,updatedAt,version。allowedModels:null 表示所选组允许范围内不额外限制模型；expiresAt:null 表示永不过期。 |
| API Key 详情 | GET /api/v1/keys/:id | 仅 Key 所有者可读；返回 KeyMetadata，永不返回明文 token。 |
| 创建 API Key | POST /api/v1/keys，JSON { name,expiresAt,groupId }；Worker 也接受 allowedModels? | 登录用户 + CSRF + Idempotency-Key。结果 union：{kind:'created',key,token} 或 {kind:'replayed',key}；明文 token 仅首次成功响应出现，replayed 不含 token。当前 Vue 类型未开放 allowedModels 输入，不要无意中把它当成已有 UI 字段。 |
| 编辑 API Key | PATCH /api/v1/keys/:id，JSON { version,name?,expiresAt?,groupId?,allowedModels? } | 登录用户 + CSRF；version CAS。将 expiresAt 设为 null 才表示不设到期日。更新按当前 API 输入整形，提交前保留用户未改字段。 |
| 撤销 API Key | POST /api/v1/keys/:id/revoke，JSON { version } | 登录用户 + CSRF；version CAS。结果 {kind:'revoked'|'already_revoked',key}。 |

个人概览首期只能以余额、已实现的请求列表和链接呈现。当前没有消费趋势、用量聚合、成功率、模型分布或全量统计接口；不得从 cursor 当前页推算总消费或请求数。

## API 接入指南

Key 管理复用上节 /api/v1/keys。文档示例指向由 Worker 提供的原生 OpenAI-compatible 接口，不属于 JSON 管理 envelope，也不是 React 自身的查询依赖：

| 外部调用 | 鉴权 / 返回 |
| --- | --- |
| GET /v1/models | Authorization: Bearer <API Key>；不接受 query；返回原生 {object:'list',data:[{id,object:'model',created,owned_by}]}，只含 Key 当前获授权并有 active channel 映射的模型。 |
| POST /v1/chat/completions | Bearer API Key；Chat Completions 原生 JSON/SSE 协议。 |
| POST /v1/responses | Bearer API Key；Responses 原生 JSON/SSE 协议。 |
| POST /v1/messages | Bearer API Key；Messages 原生 JSON/SSE 协议。 |

协议错误、流式数据不得经过管理 API envelope 解码器。当前 Server API 返回 owned_by:'sub2api' 是兼容协议字段，不是产品品牌标题；重构品牌只改用户可见界面，不改协议值、cookie/key 前缀或云资源标识。

## 管理控制台：资源配置

所有资源读取/写入均为 active admin + session；所有写入另需 CSRF。列表 cursor/status 筛选变化后从首批开始。admin channels/models/groups 当前没有单项 GET；详情页不能把路由存在当成读取接口存在。

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / version / operationId |
| --- | --- | --- |
| 渠道列表 | GET /api/v1/admin/channels，query cursor,status | status: active/disabled；返回 {items,nextCursor}。ChannelView: id,name,baseUrl,status,priority,concurrencyLimit,rpmLimit,configVersion,createdAt,updatedAt,hasCredential,models[]。models 含 publicModelId,upstreamModel,protocol,mappingVersion,priceVersion。只回 hasCredential，不回 secret。 |
| 新建渠道 | POST /api/v1/admin/channels，JSON { name,baseUrl,upstreamKey,concurrencyLimit?,rpmLimit?,priority?,status? } | CSRF；返回 ChannelView。Worker 写审计 operationId 为内部生成 UUID，无调用方幂等键。 |
| 更新渠道 | PATCH /api/v1/admin/channels/:id，JSON { version,name?,baseUrl?,upstreamKey?,concurrencyLimit?,rpmLimit?,priority?,status? } | version 必须是当前 configVersion，成功递增。省略 upstreamKey 表示保持原密钥；null/空字符串不能删除或清空密钥，空字段无“保持”特例。操作审计 ID 由 Worker 生成。 |
| 主动渠道诊断 | POST /api/v1/admin/channels/:id/test，JSON { publicModelId,protocol,channelVersion,mappingVersion,priceVersion } | active admin + CSRF；提交的三个版本必须和现有资源匹配。返回 diagnosticId,channelId,publicModelId,protocol,outcome,upstreamStatus,channelVersion,mappingVersion,priceVersion,maxOutputTokens,mayIncurUpstreamCost:true,userBalanceCharged:false。只有用户显式操作可触发，可能花费上游余额；不会生成业务账单。 |
| 模型列表 | GET /api/v1/admin/models，query cursor,status | status: active/disabled。返回 {items,nextCursor}。ModelView: publicModelId,status,sellPrices,priceVersion,admissionMinBalanceUnits,maxOutputTokens,createdAt,updatedAt。没有独立 version，priceVersion 同时作为所有模型字段修改的 CAS 版本。 |
| 创建模型 | POST /api/v1/admin/models，JSON { publicModelId,status?,sellPrices,admissionMinBalanceUnits,maxOutputTokens } | active admin + CSRF；sellPrices 至少含 input/output，可含 cacheRead/cacheWrite/cacheWrite5m/cacheWrite1h/reasoning；USD/百万 Token，精确十进制字符串，最多 8 位小数。admissionMinBalanceUnits 为整数单位字符串，maxOutputTokens 正整数。审计 operationId 由 Worker 生成。 |
| 更新模型 | PATCH /api/v1/admin/models/:id，JSON { version,status?,sellPrices?,admissionMinBalanceUnits?,maxOutputTokens? } | version 实际等于 priceVersion。若发送 sellPrices，是完整替换，不是部分合并，不提供缺失 bucket 的隐式零价。路径 ID 需作为单段编码；公开模型 ID 可包含 /、:。 |
| 模型渠道映射列表 | GET /api/v1/admin/models/:publicModelId/mappings，query protocol,activeOnly | protocol: chat/responses/messages；activeOnly 是字符串 boolean。返回 {items:ModelMappingView[]}；每项 channelId,publicModelId,protocol,upstreamModel,capabilities,configVersion。 |
| 新建映射 | POST /api/v1/admin/models/:publicModelId/mappings，JSON { channelId,protocol,upstreamModel,capabilities } | 返回 ModelMappingView；审计 operationId Worker 内部生成。mapping configuration 不代表该组已授权或协议适配一定可运行。 |
| 更新映射 | PATCH /api/v1/admin/models/:publicModelId/mappings/:channelId/:protocol，JSON { version,upstreamModel?,capabilities? } | version 必须等于 mapping configVersion，成功递增；路径中公开模型 ID 必须编码为单路径段，protocol 仍为 chat/responses/messages。 |
| 访问组列表 | GET /api/v1/admin/groups，query cursor,status | status: active/disabled。返回 GroupView[]：id,name,status,version,createdAt,updatedAt,channelIds,billingMultiplier。倍率为最多 18 位小数的非负十进制字符串；channelIds 是关联集合。 |
| 创建访问组 | POST /api/v1/admin/groups，JSON { name,status?,channelIds?,billingMultiplier? } | 返回 GroupView。默认 status active、channelIds 空、倍率 "1"；没有调用方 Idempotency-Key，audit operationId 使用 Worker request ID。 |
| 更新访问组 | PATCH /api/v1/admin/groups/:id，JSON { version,name?,status?,channelIds?,billingMultiplier? } | version 为 CAS；channelIds 是完整集合替换。停用默认组前须先迁移默认组配置；保留最后一个可用管理员等业务限制。audit operationId 使用 request ID。 |

ChannelView.concurrencyLimit/rpmLimit 和用户 limits 在成功读取中是安全整数，不以 null 输出。Worker 写入配置将 undefined、null 或 0 解释为无限制并归一化为 Number.MAX_SAFE_INTEGER（RPM 还接受该值本身作为无限制）；有限值是正整数。当前 Vue channel/user API 类型只接受 number，解码器也只接受 >=1 的整数，因此 React UI 必须把 Number.MAX_SAFE_INTEGER 显示为“无限制”，且需要显式支持提交 null/0 语义，不能显示一个巨大数字，也不能把 null 映射成无额度。该 null 规则不适用于余额、费用、渠道诊断 HTTP 状态或邀请码期限。

## 管理控制台：用户与授权

| 面板 / 操作 | Endpoint、输入或筛选 | DTO / 权限与状态 |
| --- | --- | --- |
| 用户列表 | GET /api/v1/admin/users，query cursor,status,groupId | status: active/disabled，groupId 精确匹配；返回 {items,nextCursor,snapshotAt}。row 是安全公开投影：所有 PublicUser 字段 + allowed_group_ids,group_name,concurrency_limit,rpm_limit,created_at,updated_at,version。snapshotAt 只限制新建用户，不冻结之后的状态/组编辑。cursor 绑定管理员、筛选与 snapshot。 |
| 用户可分配组 | GET /api/v1/admin/groups?status=active&limit=100&cursor | 当前前端用作用户编辑选项；响应包括完整 GroupView，但 UI 仅可使用 id/name/status。循环 cursor 直到 null，不能把单页的 100 条假称全集。 |
| 新建用户 | POST /api/v1/admin/users，JSON { email,password,groupId? } | active admin + CSRF；返回 PublicUser（snake_case），role/balance 不可由调用方设置；默认组来自 Worker 配置。审计 operationId 用 request ID。 |
| 编辑用户 | PATCH /api/v1/admin/users/:id，JSON { version,status?,groupId?,concurrencyLimit?,rpmLimit?,allowedGroupIds? } | version 为 CAS。字段可以部分提交；若更改 groupId 且省略 allowedGroupIds，授权集合重置成新主组；若传 allowedGroupIds，必须含当前主组。不能停用最后一个 active admin。Worker 响应还含若干列表字段，但旧客户端只解成 PublicUser，改后须重新读取用户 row 才拿到新 version/limits。 |
| 用户授额 | POST /api/v1/admin/users/:id/balance-adjustments，JSON { kind:'grant'|'adjustment',deltaUnits:string,reason:string,requestId?:string|null } | active admin + CSRF + Idempotency-Key。金额是有符号最小 USD 单位字符串；grant 必须正值。服务端把键摘要成稳定 operationId，返回 { entry,outcome:'inserted'|'existing' }；重试同一操作复用原键和 payload。entry.deltaUnits 保持字符串。 |
| 管理员撤销用户 Key | POST /api/v1/admin/keys/:id/revoke，JSON { version } | active admin + CSRF。version CAS；结果 { kind:'revoked'|'already_revoked', key:{id,userId,status,version,createdAt,updatedAt} }。仅撤销 API Key，不展示 token。 |

新增用户详情需要 GET 来支持 /admin/users/:id 深链。复用用户列表使用的安全公开投影（含授权组与 limits）；不得返回 password hash/凭据。详情关联请求、账单可使用已存在的 admin requests/billing userId 筛选，不新增全量查询接口。

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

## 目前缺少的 4 个资源详情 GET

前端目标路由已设计深链，但当前 apps/worker/routes.ts 只挂了这些资源的列表及 PATCH，并没有下列 GET。开发顺序需先完成读取路由/权限，再让 React 页面调用。

| 新增 Worker 路由 | 建议 DTO | 现有复用能力与边界 |
| --- | --- | --- |
| GET /api/v1/admin/channels/:id | ChannelView | 复用 getChannelById 安全投影，含 models 及 mapping/price version 和 hasCredential，绝不含 ciphertext/plaintext。 |
| GET /api/v1/admin/models/:id | ModelView | 复用 getModelById，CAS 版本是 priceVersion。:id 需支持斜杠、冒号 ID 的单段 URL 编码，与现有 client path guard 保持一致。 |
| GET /api/v1/admin/groups/:id | GroupView | 复用 getGroupById，channelIds 是集合，billingMultiplier 是十进制字符串，包含 version。 |
| GET /api/v1/admin/users/:id | UserListItem 安全投影 | 新增仅 admin 读取；与列表 DTO 对齐，含 allowed groups、主组名、limits、version；排除任何密码 hash/认证秘密。 |

这些读路由需与同资源列表采用同样的 session/admin 授权、no-store 和 JSON envelope；不存在详情路由时当前 UI 应保留列表摘要/提示，不能通过客户端过滤未加载完的列表伪造 detail endpoint。

## 契约特别风险与 React 实施提醒

1. **线格式命名不统一。** auth/user/request/audit DTO 含 snake_case；chat/channel/model/group/key/billing DTO 含 camelCase。不要以通用 adapter 全面 camelize。
2. **两个“版本”语义。** model 写入 body version 实际 CAS priceVersion；mapping 的 configVersion 与 channel configVersion 独立。渠道诊断必须同时携带这三个版本，保存其中一个资源会使旧探测请求冲突。
3. **limit 语义客户端与服务端不一致。** Worker 对 channel/user 接受 null/0 => unlimited 并对外输出 Number.MAX_SAFE_INTEGER 哨兵；旧 API TS 仅写 number 且 decode 强制 >=1。React 表单应将哨兵解释为无限制，并在接口边界规范化，不用 JS 浮点或巨大数字作为可见显示值。
4. **幂等支持不统一。** API Key 创建、管理员授额、邀请码批次用 Idempotency-Key；chat 在 JSON body 用 operationId；其他配置写入一般由 Worker 生成审计 ID，没有重放语义。未知网络结果只在有幂等合同的接口上复用相同 key，不要自动生成新键重放。
5. **列表快照不是通用 DB 快照。** request/audit/key/billing cursor 绑定查询和时间/行上界；admin users 的 snapshotAt 只筛掉之后创建的新用户，状态和组仍可能变化。切换筛选要重置 cursor；不能合并不同筛选的旧页。
6. **价格/usage 都是证据快照。** request cost_units、price snapshot、usage 可能 null 或 invalid。执行成功并不说明已结算；usage 子计数可能是 input/output 子集，按 semantics 展示，不重新求和或估算权威金额。
7. **密钥明文只出现一次。** API Key 与邀请码首次创建返回 plaintext；replayed 结果不带它。读取结果、React Query cache、日志和持久草稿均不能保存明文；仅临时显式结果态供用户复制。
8. **服务端能力边界。** 尚无渠道实时健康、概览聚合、usage 图表、全量会话搜索、支付/充值、用户详情 GET；渠道 active 不是在线探测成功，mapping 存在也不表示用户授权。首期 UI 不显示这些推断。

## 本图来源

- UI API client/types：apps/web/src/api/*.ts。
- Worker 路由装配：apps/worker/routes.ts；领域合同：apps/worker/auth/**、apps/worker/chat/routes.ts、apps/worker/admin/**、apps/worker/billing/**、apps/worker/gateway/request-query-routes.ts。
- 页面范围/路由：docs/frontend-react-design.md；实现拆分和后端新增约束：docs/frontend-react-development-plan.md。
