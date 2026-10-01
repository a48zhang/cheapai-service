# Sub2API on Cloudflare 一期完整技术方案

版本：v1.0 · 2026-09-05  
状态：实施基线。首批 8 个基础任务已完成，包含固定依赖、类型配置、健康入口、前端构建配置、协议契约和源码基线；业务实现及云部署仍待后续任务。实际完成状态与验证范围见 [实施进度](implementation-plan.md)。

本文是整体设计主文档，统一架构、数据、接口、运行时行为和验收标准。产品范围以 [一期核心目标](phase-1.md) 为准；[计费](billing-cache.md)、[注册](registration-auth.md)、[协议转换](protocol-compatibility.md) 文档提供专题细节。文中的初始数值是工程建议，可配置、须实测，不代表已经验证的容量或平台保证。

## 1. 目标与设计取舍

一期交付一个纯 Cloudflare 的多用户 API 网关：用户注册、验证邮箱、登录并创建平台 Key；管理员配置上游与模型、授额；用户用熟悉的 Chat Completions、Responses 或 Messages 接口调用；平台完成跨协议转换、并发控制、按用量扣费和查询。

上游使用管理员设置的 Base URL 与 API Key，不涉及账号 OAuth、订阅凭据或自动刷新。参考 Sub2API 的业务行为与转换测试，重写适合 Workers 的后端，不直接搬运 Go 服务、PostgreSQL 或 Redis。

| 决策 | 一期采用 | 原因 |
| --- | --- | --- |
| 部署单元 | 一个 Worker，包含前端资源、HTTP API、网关、DO 类、Cron | 减少发布和跨服务故障 |
| 业务数据 | 一个 D1 数据库 | 注册、账单和查询使用同一权威数据源 |
| 缓存 | 一个 KV namespace | 适合低频变化的路由、价格和可失效快照 |
| 协调 | 一个 Gate DO 类，按主体实例化 | 解决用户/渠道并发和强一致限流 |
| 计费 | 预付费准入，调用后扣费，允许负余额 | 用户已接受少量透支，不做逐请求预算冻结 |
| 协议 | 三入口 × 三种上游，全部普通/SSE | 客户端不用了解上游协议 |
| 注册 | closed/open/invite，邮箱验证独立开关 | 对齐已确认的 Sub2API 注册需求 |
| 邮件 | Cloudflare Email Service binding | 保持纯 Cloudflare 部署 |

一期不建设 UserLedger、渠道业务状态 DO、Queues、Outbox、查询投影、事件总线、独立 jobs 服务或通用补偿框架。也不建设支付系统、复杂订阅、OAuth、Realtime、文件服务和完整对话历史服务。对话中的图片输入属于协议转换范围，独立图像生成接口暂缓。

少量透支只放宽调用资格的余额时效，不放宽权限、一次性凭证消费或账单正确性。D1 账单必须幂等；缓存和日志不能覆盖真实余额。

## 2. 总体架构与工程

~~~mermaid
flowchart LR
    Browser["注册 / 用户 / 管理页面"] --> Worker["一个 Worker\nHono API + 网关 + 静态资源"]
    Client["Chat / Responses / Messages 客户端"] --> Worker
    Worker --> D1["D1\n身份、配置、请求、余额、账单"]
    Worker --> KV["KV\n路由、价格、短期快照"]
    Worker --> Gate["Gate DO\n并发租约、限流、冷却"]
    Worker --> Upstream["API Key 上游\nChat / Responses / Messages"]
    Worker --> Email["Email Service\n邮箱验证码"]
    Cron["同一 Worker 的 Cron"] --> D1
~~~

### 2.1 技术栈与边界

后端采用 TypeScript、Hono、Workers 原生 Fetch/Streams/Web Crypto；D1 使用参数化 SQL 与显式迁移，不先引入通用 ORM。前端采用 Vue 3、Vite、Vue Router，优先评估复用固定 Sub2API 版本的页面和组件；管理接口按新工程定义适配。

pnpm workspace 仅包含 web、worker 和 apicompat。协议包独立测试，不访问 D1、KV 或 Worker Secret；计费、认证、路由使用普通模块和明确函数接口，不做插件注册平台。

~~~text
apps/
  web/                       注册、登录、用户和管理页面
  worker/
    auth/                    身份、注册、会话和权限
    admin/                   管理接口及审计
    gateway/                 入口、路由、上游连接、流生命周期
    billing/                 资格检查、用量归一化、价格与结算
    cache/                   KV 读取、回源、失效
    limits/                  Gate DO
    scheduled/               分页清理、异常发现与有限结算重试
packages/
  apicompat/
    types/                   三种协议与共享语义类型
    requests/                请求转换
    responses/               JSON、错误、usage 映射
    streams/                 SSE 解析、各方向状态机
    capabilities/            可映射性检查
migrations/                  D1 版本化 SQL
tests/                       契约、数据库、运行时、端到端测试
docs/                        设计、证据、实施与运维说明
~~~

以上为目标布局，子模块和代码在实施时创建。依赖版本、Wrangler compatibility_date 与锁文件在 M0 固定；不使用自动漂移的生产依赖版本。

### 2.2 资源和路由

| Binding / 配置 | 用途 | 隔离规则 |
| --- | --- | --- |
| ASSETS | 前端构建资源 | 随 Worker 版本发布 |
| DB | D1 | 测试与生产数据库独立 |
| CACHE | KV namespace | 环境隔离，键带 schema version |
| GATE | Gate DO namespace | 同一类按 user/channel/auth 主体实例化 |
| EMAIL | Email Service 发送 binding | 发件身份与账户能力须验证 |
| Cron Trigger | 五分钟一次的初始巡检计划 | 同一 Worker 的 scheduled handler |

前端与 API 同源。/api/*、/v1/*、/healthz 必须进入 Worker 逻辑，未知 API 路径返回结构化 404，不回退为 SPA 的 HTML；其余前端路由可使用静态资源回退。使用 Workers Static Assets 的路由配置实现，实施时验证 API 前缀优先级。[Static Assets 配置](https://developers.cloudflare.com/workers/static-assets/binding/)

## 3. 数据模型与数据库规则

### 3.1 公共约定

业务 ID 使用随机不可预测 ID；时间以 UTC 毫秒 INTEGER 保存，接口输出 ISO 8601。邮箱单独保存规范化唯一值。金额、费率和 token 数有显式单位，不使用浮点余额。所有用户资源查询必须带 user_id 权限条件，不能只凭 ID 查找后直接返回。

身份和账单涉及的父记录采用停用/软删除；未完成请求及其关联用户、Key、渠道不得硬删除。启用外键、唯一约束和必要 CHECK。普通枚举/标量进入独立列；协议 usage 和价格快照使用有 schema_version 的 JSON，不把整套数据库做成 JSON 文档库。

### 3.2 表与必要索引

| 表 | 主要字段 | 约束与用途 |
| --- | --- | --- |
| users | id、email_normalized、password_hash、role、status、email_verified_at、group_id、balance_units、concurrency_limit、rpm_limit、created_via、registration_code_id、created_at | email 唯一；role 为 user/admin；余额默认零，允许负数；记录自助/管理员/部署初始化来源 |
| sessions | id、token_hash、user_id、expires_at、revoked_at、created_at | token_hash 唯一；索引 user_id、expires_at；无需每请求写 last_seen |
| settings | key、value_json、version、updated_at | key 主键；注册开关及运营参数；不保存 Secret |
| registration_codes | id、code_hash、display_prefix、expires_at、revoked_at、used_by、used_at、created_by | 摘要唯一；单次使用；保留使用记录 |
| email_challenges | id、email_normalized、purpose、generation、code_mac、expires_at、attempts、send_status、consumed_at | email + purpose 唯一活动记录；重发递增 generation；索引 expires_at |
| api_keys | id、user_id、group_id、key_hash、display_prefix、name、status、expires_at、allowed_models_json（旧版兼容） | 摘要唯一；user_id 索引；不保存明文 |
| groups | id、name、status | 渠道访问组；用户可获得多个组的授权 |
| user_group_access | user_id、group_id、created_at | 管理员授予的可选分组；联合主键 |
| channels | id、name、base_url、secret_ciphertext、secret_key_version、status、priority、concurrency_limit、rpm_limit、config_version | 全局上游配置；不存到 DO 作为第二份业务库 |
| channel_groups | channel_id、group_id | 联合唯一，允许一个渠道服务多个组 |
| models | public_model_id、status、sell_prices_json、price_version、admission_min_balance_units、max_output_tokens | 公开模型名和统一售卖价格；价格必须显式配置 |
| channel_models | channel_id、public_model_id、upstream_model、protocol、capabilities_json、config_version | channel + public_model + protocol 唯一；一个上游可支持多个协议 |
| requests | id、user_id、api_key_id、channel_id、协议/模型、price_snapshot、execution_status、billing_status、usage_json、usage_quality、cost_units、fingerprint、retry_count、next_retry_at、upstream_request_id、response_id、时间及脱敏错误 | 调用前登记；索引 user_id + created_at、channel_id + created_at、billing_status + next_retry_at；response_id 按用户/Key 归属查询 |
| billing_entries | id、operation_id、kind、request_id、user_id、delta_units、fingerprint、usage/price_snapshot、created_by、reason、created_at | operation_id 唯一；消费 request_id 唯一；只追加；索引 user_id + created_at |
| admin_audit | id、actor_id、action、target_type、target_id、redacted_change_json、operation_id、created_at | 记录配置、授额、撤销与异常人工处理；无密码或完整 Key |

一期不提供组继承、组折扣或多币种。每个新 Key 选择管理员已为该用户开放的一个分组，使用该组关联渠道的模型；用户保留一个默认组，另有可多选的授权组。旧 Key 的非空模型限制保留兼容，重新保存分组后采用整组权限。models 配置售卖单价，channel_models 配置实际上游模型和能力；上游供应商成本估算可另存展示字段，不参与用户余额扣款。

requests 额外允许保存有限的 attempt 摘要：尝试号、渠道、HTTP 状态、是否已发送、失败类别。只为最多两次的受控路由尝试留证，不增加调度任务表。

### 3.3 事务与一致性

采用参数化语句；跨多条 SQL 的业务操作使用 D1 原子 batch。D1 的 batch 遇 SQL 失败会回滚，但 UPDATE 影响零行不是 SQL 错误，因此必须显式防止“创建成功但凭证没核销”或“账单存在但余额没更新”。不把上游网络调用包进数据库事务。[D1 batch 与读取会话](https://developers.cloudflare.com/d1/worker-api/d1-database/)

注册使用带完整条件的 INSERT…SELECT，再由限定用途的触发器消费一次性凭证；记账采用插入账单触发余额增减和请求状态更新。触发器承担这些原子约束和默认分组的兼容回填，不承载路由、邮件或重试。失败使用事务回滚语义，SQL 方案必须先通过本地与远程 D1 的并发测试。[SQLite 触发器与 RAISE](https://www.sqlite.org/lang_createtrigger.html)

一期不启用 D1 读副本。若以后引入，身份、资格回源、快照采样和写后查询必须使用主库或有明确当前性保证的 session；报表才可接受适度滞后。

## 4. 注册、登录与权限

### 4.1 注册设置

| registration_mode | 注册条件 | 邮箱验证开关 |
| --- | --- | --- |
| closed | 不允许自助注册，已有用户可登录 | 不发送注册验证码 |
| open | 邮箱、密码 | 开启后必须额外提供邮箱验证码 |
| invite | 邮箱、密码、有效注册码 | 开启后必须额外提供邮箱验证码 |

默认 closed、email_verification_enabled=true。管理员初始化邮件配置后再开放注册。注册码只提供资格，不自动充值；单次使用，支持过期、撤销与使用记录。明文只在生成时返回。

页面读取公开设置决定字段；提交时重新检查 D1 当前设置。公开注册只能创建普通用户，初始余额为零。关闭验证注册的邮箱保留“未验证”，后续开启开关不自动修改历史验证状态。

### 4.2 发码与原子注册

邮箱 trim 并统一大小写；不去掉加号后缀或点号合并不同地址。验证码初始六位随机数字，有效十分钟，重发间隔六十秒，最多五次错误。用带用途和 generation 的 HMAC 保存验证摘要，密钥放 Secret。

发送过程为：检查当前注册策略和 IP/邮箱限流 → 原子创建/替换挑战 → 调用 EMAIL.send → 按 generation 更新 accepted/failed/unknown 状态。更新旧发送任务的结果不得覆盖新挑战。发送超时可能已经投递，界面提示稍后重发；结果无法确认时不绕过验证。验证只接受当前、未消费、未过期且发送状态合格的挑战；旧 generation 永远失效。

发送 API 不返回验证码，也不披露已有账户。初期直接等待邮件服务接受，不建立邮件队列。邮件服务接受与邮件送达是两个状态。[Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)

只有 accepted 状态的当前挑战可完成验证。超时后即使邮件后来到达，若无法确认该挑战状态也须重发；失败状态不能被客户端改写。注册与发码在执行昂贵 KDF/发送前都有限流，IP 来源使用 Cloudflare 提供的可信连接信息，不信任任意客户端转发头。

注册操作固定为：

1. 语法/大小/限流校验、当前策略预检查，执行密码 KDF；此时不消费注册码或验证码。
2. 单个带条件的用户插入检查当前策略、邮箱唯一性、所需码的有效期/状态/摘要；成功插入携带注册码来源信息，邮箱已验证标记仅由成功验证路径写入。
3. 同一原子操作中的用户创建触发器核销所用注册码，并消费该邮箱注册用途的当前挑战。任何预期消费未发生则回滚用户创建；管理员创建/部署初始化使用显式独立路径。
4. 确认只创建一行后建立会话。若用户创建成功而会话响应丢失，用户直接登录；不再次创建或授额。

错误验证码尝试次数用独立原子更新持久化，不能随注册失败回滚。正确匹配与最终创建仍须在条件插入中重新验证尝试次数和 generation，防止并发重发/超限绕过。注册事务无需初始化任何 DO 或等待后台激活。

### 4.3 密码与会话

密码使用版本化 Argon2id 编码、随机独立盐，选成熟实现；M0 首先验证 Workers 中的 CPU、内存和并发行为。若运行时无法满足安全参数，调整实现或另行记录替代 KDF 决策，不能以单次 SHA-256 或静默降低参数替代。[OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

密码规则按用户要求调整为 6–128 个字符并限制 UTF-8 字节数；允许粘贴与密码管理器，不截断。管理员与用户共用身份体系，通过后端角色校验区分。

KDF 同时设置每个运行实例的并发保护，超额快速拒绝，避免仅靠 IP 限流仍被并发内存占用拖垮；具体并发值随 M0 内存测试确定。

浏览器使用 256 bit 随机会话令牌，D1 只存摘要。Cookie 使用 __Host- 前缀、Secure、HttpOnly、Path=/、SameSite=Lax；有效期建议七天，初期不做滑动续期写库。登录更换令牌，退出撤销当前会话，停用用户立即影响后续服务端验证。写接口校验 Origin 和 CSRF token；不得用 localStorage 保存登录凭据。

初始管理员由部署者在本地交互生成密码摘要，通过受控初始化脚本写入 D1；无公共 /setup 接口、无固定默认密码。管理员人工创建用户也走明确权限路径并从零余额开始，授额另行记账。

### 4.4 平台 Key

平台 Key 使用独立前缀和 256 bit 随机秘密，创建时仅返回一次。保存摘要和显示前缀；列表只显示掩码。用户可创建、命名、限制模型、设置期限和撤销自己的 Key；管理员可撤销任意用户 Key。

网关只接受平台 Key。上游密钥由渠道生成请求头，永不返回用户。D1 在上游发送前确认 Key、用户、组/模型和渠道仍有效；KV 只能用于定位或展示。撤销/停用的边界是最终准入检查：此前已经准入的请求可以完成，之后的检查必须拒绝。不承诺跨 D1、DO 和上游网络的瞬时强制撤回。

## 5. 渠道、模型与调用流程

### 5.1 渠道配置和选择

渠道保存管理员允许的 HTTPS Base URL、加密 API Key、优先级、并发/RPM 以及可用模型/协议。Base URL 是协议路径之前的根路径，可带供应商前缀；例如根路径以 /v1 结束时追加 /chat/completions、/responses 或 /messages，不重复拼 /v1。渠道页显示已配置的上游模型，支持就地维护映射；禁止客户端覆盖地址或认证头。

每个公开模型匹配一个或多个 channel_models。能力字段描述工具、并行工具、图片、结构化输出、输出上限、reasoning、usage 和缓存语义。价格未配置或无法可靠解释 usage 的渠道不默认当作免费渠道上线。

路由步骤：

1. 根据用户组、Key 模型限制、公开模型启用状态筛选。
2. 根据请求实际特性和上游协议筛选可映射能力。
3. 按 priority 分层；同层随机选择，避免全局轮询计数器。
4. 请求用户租约，再尝试渠道租约；忙或冷却时尝试其他候选。
5. D1 最终核对配置版本与权限，原子登记本次执行所用协议、模型、价格快照；配置已变则重新加载，最多一次，仍冲突则返回可重试错误。

DO 只执行额度计数与租约操作；管理员停用的准入判断由 D1 负责。并发获取过程中的临时租约可能被拒绝并释放，不代表已获授权调用。

### 5.2 请求生命周期

~~~mermaid
sequenceDiagram
    participant C as 客户端
    participant W as Worker
    participant D as D1
    participant G as Gate DO
    participant U as 上游
    C->>W: 平台 Key + 下游请求
    W->>D: 身份与资格检查、配置回源
    W->>G: 获取用户/渠道租约
    W->>D: 最终授权 + requests 登记
    W->>U: 转换后调用
    U-->>W: JSON / SSE + usage
    W-->>C: 按下游协议返回
    W->>D: 以 request_id 原子结算
    W->>G: 幂等释放租约
~~~

图中省略 KV 命中路径。初期最终 D1 检查如已取得余额，直接使用该余额；不额外查一次 KV。请求登记未成功时不得发上游。非流式响应应先尝试结算再返回；流式已经输出的内容不能因后续结算失败撤回。

执行过程有一个拥有明确生命周期的任务，负责读取上游、转换、续租、完成/取消、提取 usage、结算和释放。不能在 fetch handler 返回 Response 时就运行 finally 释放并发。

### 5.3 重试与渠道冷却

一期默认一个实际生成尝试。仅在尚未输出且能确认上游未执行的情形，允许一次换渠道，例如本地转换前失败、明确的限额拒绝；不能因为“没有收到首字”就断言请求没有产生费用。

连接超时、上游断开、含糊的 5xx 或已接受后的异常不自动重放生成；保留本次失败和用量不确定状态。客户端自行重试是新调用，会获得新的内部 request_id。

429 按受限的 Retry-After 冷却；上游认证错误可短期隔离并提示管理员。DO 仅保存短期 cooldown_until 和错误分类；渠道是否停用仍在 D1。不因一次错误永久修改业务配置。

## 6. 三协议兼容与流处理

### 6.1 必须实现的矩阵

| 下游入口 / 上游协议 | Chat Completions | Responses | Messages |
| --- | --- | --- | --- |
| POST /v1/chat/completions | 同协议 | 双向转换 | 双向转换 |
| POST /v1/responses | 双向转换 | 同协议 | 双向转换 |
| POST /v1/messages | 双向转换 | 双向转换 | 同协议 |

九格每格均包含普通 JSON 和 SSE，共十八条基本路径。GET /v1/models 返回当前身份可访问的公开模型，不暴露渠道密钥或内部模型映射。Messages 客户端采用自己的认证与响应格式，无需改成 Chat SDK。

请求和返回使用六个方向的直接转换器；共用语义类型、SSE parser、ID/usage 辅助函数，不强制通过 Responses 作为两次转换的中转。固定参考 Sub2API 提交 ab99d56e9626e6cd731592dae8553c9758a0efa2 的 [apicompat 源码与测试](https://github.com/Wei-Shaw/sub2api/tree/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/pkg/apicompat)。

### 6.2 语义覆盖

| 内容 | 实现规则 |
| --- | --- |
| 消息和系统指令 | 映射 system/developer、角色、多轮、字符串/内容块；保持顺序及可表达的优先级 |
| 文本与图片输入 | 映射 URL/base64 图片和媒体类型；不支持的图片能力在路由前拒绝；默认不代客户端下载任意图片 URL |
| 工具定义与调用 | 保留 schema、tool_choice、调用 ID、并行调用及工具结果；工具调用由客户端执行，网关不运行用户工具 |
| Responses items | message、function_call、function_call_output 对应映射；稳定 ID、索引和结束状态 |
| 生成控制 | 输出上限、采样、stop、结构化输出按能力映射；不静默丢弃约束 |
| reasoning/thinking | 仅映射可表达语义；不伪造签名，不把私有思考改为普通回答 |
| 缓存 | 保留能表达的 cache_control 与 usage 细分；记录字段来自哪个上游 |
| 结束/错误 | 区分正常、长度截断、工具调用、过滤/拒绝与错误；使用下游错误结构 |
| 用量 | 累计量/增量分别归一化；输入/输出、缓存和 reasoning 不重复计数 |

同协议可透传经过允许的扩展字段；跨协议必须明确解释字段。请求包含当前渠道无法表达的特性时先选兼容渠道，没有候选再返回明确错误，不能用删除字段换取表面成功。

“无感转换”针对可映射的协议行为，不代表让没有图片、内置工具或状态存储能力的上游凭空具备这些能力。兼容报告逐字段给出支持和限制，不能仅列 HTTP 路由存在。

### 6.3 SSE 生命周期

增量解析器必须处理 UTF-8 跨字节、跨 chunk、多行 data、心跳和未知事件，不逐网络 chunk 直接 JSON.parse。每次请求的转换器保存响应 ID、内容块/工具索引、参数片段、usage 累计和终态。

Chat 的 delta/finish_reason/[DONE]、Messages 的 message/content_block 生命周期、Responses 的 item/content 和 completed/incomplete/failed 事件分别编码。工具参数可跨多段组成 JSON；不能要求每段都是完整对象，不能重排并行工具的关联关系。

保持背压与可配置缓冲上限，增量文本及时转出；不能为统一格式先收完整输出。收到截断或错误时不发正常成功终态。HTTP 头已发送后，异常只能按下游流内错误结束，不能假装改成新 HTTP 状态。

### 6.4 多轮与特有能力边界

基础多轮与工具往返采用客户端完整历史，九种转换均必须实现。previous_response_id 属于额外的服务端历史引用：一期在原生 Responses 上游确有该能力时，保存响应 ID 的所属用户/Key、原渠道与模型映射；续接先查归属并固定原渠道，不能跨用户、跨渠道误用。

跨协议路径不默认保存完整 prompt/输出来模拟历史。未能解析的引用返回明确不支持或已过期错误，提示提交完整历史；这不是省略 Responses 入口或多轮转换。Responses 的完整历史存储、GET/DELETE response 与后台任务不在本期范围，须在兼容说明公开。独有能力的透传同样受模型能力约束。

### 6.5 中断和 usage

客户端取消要传递 AbortSignal，停止下游写入并尝试取消上游；不能假设上游立即停计费或一定返回最终 usage。只对可证实的计费用量自动结算。缺失/部分 usage 保存为 missing/partial，进入待核对；不能按下游文本长度伪造精确上游 token。

计费只读取一次上游规范化结果；给下游映射 usage 不会产生第二张账单。普通失败、用户取消和长度截断都可能有真实 usage，是否收费由计量证据决定，不能只看 HTTP 200 或 execution_status。

## 7. Gate DO：并发、限流与租约

一个 Gate 类使用 user:{id}、channel:{id}、auth:{kind}:{subject_hash} 等内部对象名。前两类承担并发/RPM，auth 类承担登录和发码限流。注册不要求预建对象；密码、Key、角色、余额和账单都不放入 DO。

内部方法为 acquire(request_id, limits, lease_ttl)、renew(request_id, lease_token)、release(request_id, lease_token)，以及必要的 rateCheck/cooldown。只有 Worker binding 可调用；不暴露可被外部构造的 DO 管理 HTTP 路径。

租约和计数窗口持久化到 DO 存储，不能只放实例内存。获取与续租在对象内原子执行；同 request_id 的内部重试不重复占位，释放幂等。取消后的迟到 renew 不得重新创建已释放租约，靠 lease_token 匹配而不是无条件 upsert。

初始建议租约 TTL 90 秒、每 30 秒续租；两个对象均须续租成功。第二个 acquire 失败要释放第一个；Worker 崩溃后由过期清理回收。alarm 按最早到期时间调度，操作入口也主动清理过期项，避免完全依赖 alarm 的准点执行。alarm 可能重复执行，清理必须幂等。[DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

续租失联时在安全余量内停止继续服务并尝试取消上游；不无期限占用本地旧租约。该机制约束平台承认的活跃请求数，上游在网络分区后继续执行的尾部不受 DO 强制控制，不能宣称严格限制供应商的所有在途执行。

用户所有 Key 共享同一用户并发；渠道所有用户共享渠道并发。初期不做排队等待，忙时切候选或返回 429/503 及适当 Retry-After。每次实际候选尝试计入渠道频率；用户请求不因内部重复 acquire 被重复统计。

## 8. 计费、金额与 KV

### 8.1 业务语义与 Sub2API 对照

默认余额大于零才有调用资格，可按模型提高 minimum admission balance；这是资格门槛，不是该请求的最大费用预扣。实际 usage 到达后扣完整费用，余额不足也扣成负数；已准入流不中途因为别的请求扣款而停止。

准入比较固定为 balance_units > 0 且 balance_units >= admission_min_balance_units；配置门槛为零时等同于正余额检查，正门槛处允许等值通过。

Sub2API 固定版本的普通余额路径在不足时仍执行扣款；回归案例包含余额 0.50、消费 0.75、扣后 -0.25，然后失效缓存、拒绝后续余额不合格请求。此结论来自源码与测试阅读，未运行其 Go 测试。[原版扣费实现](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/repository/usage_billing_repo.go#L243)、[负余额回归案例](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/service/billing_cache_service_balance_test.go#L67)

用户并发、RPM、模型权限和输出上限限制风险，但正余额卡口不是绝对透支金额上限。较贵模型、长请求和在途并发可能放大负余额；后台展示负余额总额与用户列表，参数通过运行数据调整。

### 8.2 金额与价格

一期使用 USD 计价，1 USD = 100,000,000 units，即最小记账单位 10^-8 USD。余额/费用存 D1 INTEGER；JSON API 返回十进制字符串并标明 currency/scale。金额运算使用 BigInt 或经过验证的十进制定点函数，不用 JS 浮点累加。

为避免 D1 JavaScript 数字转换损失，持久化金额限定在安全整数范围内，绑定前与数据库 CHECK 同时校验。费率也以字符串进入验证器；超界输入拒绝，不能静默截断。

模型价格按每百万 token 配置输入、输出和已启用的缓存细分类。一次请求选定价格后保存不可变快照，包含 price_version、币种、尺度、计费项定义及取整版本。请求中途改价只影响新准入。

金额计算为各个互斥计费桶 token 数乘单价之和，统一除以百万，最后按 half-up 取整到一个 unit。若上游的缓存量是输入的子集，先从普通输入中扣出；若其输入字段已经不含缓存，则分别相加。reasoning 通常可能属于输出细分，必须按该上游的定义处理，不能再额外重复收费。无法解释的 usage 标记异常。

例如普通输入 1,000 tokens × $1/百万、输出 500 tokens × $2/百万，总费为 $0.002，即 200,000 units。缓存、批量和其他价目未配置时不能自动猜价；明确零单价才表示免费。

### 8.3 原子结算和幂等

一个内部 request_id 对应一次用户调用的消费结算；管理员授额使用独立 operation_id。客户端自带 request ID 仅用于追踪，不能作为免除再次计费的键。

结算采用以下原子契约：

1. 从已登记请求取得用户、模型和价格快照，校验 usage，计算费用和内容 fingerprint。
2. 插入 billing_entries，消费 delta_units 为负，授额为正。operation_id 和消费 request_id 唯一。
3. 账单插入触发器检查请求/用户匹配、消费尚未结算、金额范围，然后执行 users.balance_units = balance_units + delta_units，并更新 requests 的 usage、cost 和 billing_status。
4. 任何关联或更新不符合预期，触发器中止本次插入；账单、余额、请求要么全部生效，要么全部不变。
5. 重复 operation_id 时读取原账单并比对 fingerprint；相同返回原结果，不同报幂等冲突。冲突插入不能再触发余额更新。

实现优先使用普通 INSERT 的唯一约束冲突分支；不使用 INSERT OR REPLACE 覆盖账单，也不使用“ON CONFLICT 忽略后继续无条件扣款”。触发器只在真正插入成功时运行。提交响应超时后查询该 operation_id，不凭一次网络错误断言未扣款。

授额、扣减、纠错均追加账目，管理员必须填写原因并带幂等键。原始消费记录不可改写；纠错使用独立 adjustment 关联原 request_id，消费唯一索引只约束 consumption 类型。用户余额可与全部 delta 之和核对；不允许管理接口直接 PATCH 余额覆盖现值。

### 8.4 缓存策略

| 键示例 | 内容 | 应用层初始时效 | 回源与授权 |
| --- | --- | --- | --- |
| v1:routes:{group}:{model} | 渠道候选、协议、配置版本；无明文密钥 | 60 秒 | 最终登记仍核对版本、权限和启用状态 |
| v1:price:{model} | 售卖价格、price_version | 60 秒 | 最终登记检查版本并保存快照 |
| v1:public-settings | 公开注册显示配置 | 60 秒 | 提交注册重新查 D1 |
| v1:balance:{user} | balance_units、observed_at、schema_version | 15 秒 | 仅可选软卡口；低余额/过期/错误回源 |
| 不入 KV | 会话授权、码核销、正式账单、余额增减、强一致计数 | — | D1 或 Gate DO |

KV 的业务时效与物理 TTL 分开。余额 observed_at 取主库读取开始的时间，写入、重试和复制不能刷新它；应用已过期的值必须回源，不通过 stale-while-revalidate 放行。

KV 跨地区更新可能需要六十秒或更久，旧值和不存在的查询都可能被缓存；删除不提供全局即时失效。因此这里的十五秒是应用检查快照年龄，不是 KV 同步保证。[KV 工作方式](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

KV 没有 Redis Lua 式余额原子扣减，同键写入有每秒一次限制。只在回源后按需、保守节流地回填；低余额、充值和改配置后尽力失效。跨地区同时回填出现覆盖或 429 属于缓存失败，不重建持久化同步系统，也不让缓存失败回滚已提交账单。[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)

**默认先启用路由/价格缓存，余额 KV 通过开关提供，初始关闭。** 原因是付费请求已有 D1 最终授权与登记，可以一起得到真实余额。若测量证明余额快照能减少额外读取，再打开：新鲜且高于回源阈值的正快照可先通过软检查；低/负余额必须回源，以免充值后被旧值持续误拒。最终查询已经拿到真实余额时，以真实值为准。

KV 不可用则回源 D1；D1 不可用则拒绝新的付费调用，缓存不能替代安全检查和请求登记。缓存命中率、回源次数、KV 总调用量和 D1 延迟一起评估，不能只看“用了缓存”。

## 9. 请求状态、故障和恢复

### 9.1 执行与记账分开记录

| 维度 | 状态 | 含义 |
| --- | --- | --- |
| execution_status | admitted | 已通过最后校验并登记，是否已发上游仍有故障窗口 |
| execution_status | succeeded / failed / cancelled / abandoned | 正常结束、失败、客户端取消、超时巡检发现未收尾 |
| billing_status | awaiting_usage | 等待可靠计量或最终状态 |
| billing_status | settled | 账单与余额已原子提交 |
| billing_status | not_chargeable | 有证据证明无付费调用/无消费，不等同于未知 |
| billing_status | settlement_pending | 可重试的完整计量和价格快照已持久化，正式结算未完成 |
| billing_status | usage_unknown | 缺失/不完整/不可信的用量，无法自动得出精确费用 |

用户取消但有完整 usage 可以是 cancelled + settled；正常输出后计费失败可以是 succeeded + settlement_pending。普通 JSON 接口不额外包一层管理 API 的结构来承载账单状态；用户在用量页按 request_id 查询。

### 9.2 正常收尾与失败窗口

正常结束直接执行一次原子结算，不先为每个 token 或每个 usage 事件写库。暂时失败时，在当前生命周期内重试同一 operation_id，建议最多三次尝试、总预算六秒。

若结算仍失败但 D1 已恢复可写，退一步保存完整 usage、价格快照、计算版本和 fingerprint 到 requests，标为 settlement_pending，交给 Cron 再调用同一结算函数。这个恢复记录仅用于异常路径，不增加常态消息队列。

恢复记录的更新必须带“尚无消费账单且未 settled”的条件；先前结算可能已经成功，不能因响应超时又把请求降级为待结算。Cron 标异常和重试次数更新使用同样的终态保护。

如果 D1 完全不可用，连恢复记录也无法保证写入；进程终止后只剩初始请求记录。Cron 将超过最大请求时长与宽限期的 awaiting_usage 标为 usage_unknown/abandoned，提示人工检查，不能从“请求登记过”推断精确 token 或擅自计零。

服务端已登记、上游尚未发出或已发出但响应丢失，这些边界无法与外部供应商共享事务。保守记录事实：只有确认未发送的请求才自动记 not_chargeable；含糊状态不自动重放或扣猜测金额。

客户端断开后的 waitUntil 只是有限补充时间，不能视为可靠队列。Cloudflare 对这类任务有执行时间限制，运行时也可能结束；实际流管理和异常恢复须在 Workers 环境测试。[Workers 生命周期限制](https://developers.cloudflare.com/workers/platform/limits/)

### 9.3 故障处理表

| 故障 | 当前请求 | 后续处理 |
| --- | --- | --- |
| KV 读取/写入失败 | D1 回源，已提交账单不受影响 | 记录命中/失败指标，有限回填 |
| D1 在准入时失败 | 返回 503，不发上游 | 恢复后接收新调用 |
| Gate 获取失败 | 不发上游，释放已取得租约 | 返回 429/503，TTL 兜底 |
| Gate 续租失败 | 安全余量内中止服务、尝试取消上游 | 释放/过期清理，按实际 usage 处理 |
| 上游明确拒绝且未执行 | 映射错误或进行受控候选切换 | 记录原因与短期冷却 |
| 上游超时/断流/取消后无最终 usage | 流内错误或取消结束 | 保存已知字段，usage_unknown |
| 结算提交成功但结果超时 | 不重新发生成 | 查询 operation_id，再幂等重试 |
| usage 已知但结算暂时失败 | 不重复扣费，不撤回已输出内容 | 有持久化证据才进入自动重试 |
| 验证邮件失败/不确定 | 不允许用未合格挑战完成注册 | 限时重发，不绕过验证 |
| 管理操作重复提交 | 返回既有结果或幂等冲突 | 不重复授额/核销 |
| 管理员停用用户/Key/渠道 | 最终准入之前的检查拒绝 | 已准入请求可正常收尾 |

### 9.4 Cron 和人工恢复

五分钟巡检一次，每次固定批量、按索引游标推进，不扫描整个请求表。主要工作是：

- 清理过期会话、过期验证码和短期辅助数据；保留注册码使用审计。
- 重试已经保存完整证据的 settlement_pending，仍使用原 operation_id。
- 检查超过最大时长加宽限的未收尾请求；先核对是否已有账单，再标异常，避免晚到结算被误报。
- 汇总待核对请求、透支余额、异常积压和数据库存储趋势。

Cron 重复或重叠执行时靠条件更新和账单唯一键收敛；不声称严格执行一次。自动结算重试建议最多五轮并记录 next_retry_at/retry_count，之后保留待处理标记，由管理员决定。完整 usage 后来可靠到达时仍可从 usage_unknown 转为 settled，重复提交不得二次扣款。

人工恢复界面只能重新执行已有证据的结算，或追加有理由的 adjustment；不能编辑原账单。外部账单、供应商 request ID 等补充证据记录来源，未经核实的估计只能作为估计展示。

## 10. HTTP 接口与界面

### 10.1 管理 API 公共约定

管理 API 前缀 /api/v1，返回 JSON。成功形态为 {data, request_id}，失败为 {error: {code, message}, request_id}；分页使用 cursor/limit，建议默认 20、上限 100。列表默认时间倒序并使用稳定 ID 作为第二排序键。

金额输出字符串；日期输出 UTC ISO 8601。配置更新携带 version，过期版本返回 409，避免管理员互相覆盖。授额、手工调整、批量生成注册码等有重复副作用的操作携带 Idempotency-Key。

一次展示的 Key/注册码在响应丢失后不能从摘要恢复明文。重复创建操作只返回已创建对象的 ID 和掩码，提示撤销后重新生成，不为重放保存可解密的凭证明文。金额操作重放返回原账单身份与金额；另行查询的当前余额明确标为当前值，不冒充原结算时快照。

网关 /v1 下直接遵循对应协议的 JSON/SSE/error schema，不套管理 API envelope。鉴权失败 401，权限不足 403，参数/能力不支持 400，正文过大 413，并发/频率限制 429，平台暂不可用 503；上游错误做脱敏映射。余额不足采用 402 和入口对应的错误对象，记录 SDK 的实际处理行为并纳入兼容测试。

### 10.2 接口清单

| 身份 | 方法与路径 | 功能 |
| --- | --- | --- |
| 公开 | GET /api/v1/settings/public | 最小公开注册配置 |
| 公开 | POST /api/v1/auth/send-verify-code | 发码，返回冷却时间 |
| 公开 | POST /api/v1/auth/register | 注册与一次性凭证原子消费 |
| 公开 | POST /api/v1/auth/login | 邮箱密码登录 |
| 用户会话 | POST /api/v1/auth/logout | 撤销当前会话 |
| 用户会话 | GET /api/v1/auth/me | 当前身份、角色、验证状态 |
| 用户会话 | GET/POST /api/v1/keys | 查询/创建个人平台 Key |
| 用户会话 | PATCH /api/v1/keys/:id | 名称、期限、模型限制 |
| 用户会话 | POST /api/v1/keys/:id/revoke | 撤销个人 Key |
| 用户会话 | GET /api/v1/account/balance | D1 真实余额 |
| 用户会话 | GET /api/v1/usage/requests、/:id | 个人请求及计费状态 |
| 用户会话 | GET /api/v1/billing/entries | 个人账单明细 |
| 管理员 | GET/PATCH /api/v1/admin/registration/settings | 注册模式和邮箱验证 |
| 管理员 | GET/POST /api/v1/admin/registration/codes | 分页查询/生成注册码 |
| 管理员 | POST /api/v1/admin/registration/codes/:id/revoke | 撤销未使用码 |
| 管理员 | GET/POST /api/v1/admin/users | 查询/人工创建用户 |
| 管理员 | PATCH /api/v1/admin/users/:id | 状态、默认组、开放分组、并发和 RPM |
| 管理员 | POST /api/v1/admin/users/:id/balance-adjustments | 幂等授额/调整，必须填写原因 |
| 管理员 | POST /api/v1/admin/keys/:id/revoke | 撤销指定平台 Key |
| 管理员 | GET/POST /api/v1/admin/channels、PATCH /:id | 渠道创建、配置、启停 |
| 管理员 | POST /api/v1/admin/channels/:id/test | 显式触发最小上游测试，记录可能费用 |
| 管理员 | GET/POST /api/v1/admin/groups、PATCH /:id | 访问组及渠道关系 |
| 管理员 | GET/POST /api/v1/admin/models、PATCH /:id | 模型映射、价格、能力和输出上限 |
| 管理员 | GET /api/v1/admin/requests、GET /api/v1/admin/billing/entries | 全局用量、异常与账单 |
| 管理员 | POST /api/v1/admin/requests/:id/retry-settlement | 对完整证据重试同一次结算 |
| 管理员 | GET /api/v1/admin/audit | 管理审计 |
| 平台 Key | GET /v1/models | 有权限的公开模型 |
| 平台 Key | POST /v1/chat/completions | Chat Completions JSON/SSE |
| 平台 Key | POST /v1/responses | Responses JSON/SSE |
| 平台 Key | POST /v1/messages | Messages JSON/SSE |
| 探活 | GET /healthz | 不泄露配置的进程健康状态 |

表中逗号后的 /:id 是同一资源路径的简写。渠道模型映射作为模型/渠道配置的子资源，在实现 OpenAPI 契约时确定字段；不通过任意 JSON 配置入口代替类型校验。平台 Key 不能访问管理 API，浏览器 Cookie 不能隐式替代网关 Key。

### 10.3 页面范围

| 页面 | 必备交互 |
| --- | --- |
| 注册/登录 | 按注册设置显示字段；倒计时、错误提示、验证码重发；登录后跳转 |
| 用户概览 | 真实余额、近期用量、负余额状态、接入地址 |
| 个人 Key | 创建时一次展示、复制、期限/模型限制、撤销 |
| 个人用量/账单 | 按时间、模型、状态筛选；显示原协议、usage、费用与待核对原因 |
| 注册管理 | 模式/验证开关、注册码生成和使用记录 |
| 用户管理 | 用户状态、组、限额、授额及调整流水 |
| 渠道/模型管理 | 上游模型与映射、密钥掩码、价格、并发、测试结果 |
| 运维视图 | 负余额、失败渠道、未知 usage、待结算、审计与关联 request_id |

前端不展示尚未实现的支付、OAuth 或套餐按钮。普通用户只看到自己的数据，管理员页面仍由后端 RBAC 保护。首版中英文接口字段固定，界面优先中文；协议响应使用标准字段。

## 11. 安全、配置与数据边界

### 11.1 Secret 与密码学

上游 Key 采用 AES-GCM 加密后保存 D1，使用独立随机 nonce、渠道 ID/版本作为附加认证数据，密文带 key_version。加密主密钥放 Worker Secret。轮换时保留旧解密版本，逐条重加密并验证，确认完成后再移除旧 Secret；不能直接覆盖旧主密钥导致所有渠道不可用。

邮箱验证码 HMAC Secret 与渠道加密 Secret 分离。高熵平台 Key、会话令牌和注册码只存摘要；密码使用 KDF。密码、验证码、Secret 和 Authorization 不进日志。环境文件、Wrangler 本地状态、导出的生产数据不提交 Git。

### 11.2 请求边界

上游仅由管理员配置，允许 HTTPS、公网主机和已确认的路径前缀；禁止 URL 内嵌用户名密码、loopback/link-local/private IP 字面量和任意下游 URL 覆盖。不自动携带凭据跟随跨主机重定向。此检查不是完整 DNS 层网络隔离的替代，默认不代理下载用户提供的任意资源。

每种协议生成对应认证头，清除下游 Authorization/x-api-key、Host、hop-by-hop 和其他不应转发的头。自定义上游头仅允许受限名单，不能覆盖平台安全规则。错误回包不暴露上游 Key、完整内部地址或原始供应商调试正文。

网关支持 Bearer 平台 Key；Messages 可使用 x-api-key。两种认证头同时存在且值冲突时拒绝。版本头和 beta 能力按协议与渠道允许列表处理，不能原样送到另一个协议。

浏览器 CORS 默认同源，跨域网关仅允许管理员配置的 origin；禁止携带 Cookie 的任意来源访问。静态界面配置 CSP，管理写操作防 CSRF，所有接口限制正文和分页规模。

### 11.3 配置的权威来源

| 位置 | 内容 |
| --- | --- |
| Wrangler 配置 | 环境 binding、静态资源路径、兼容日期、DO 类迁移、Cron |
| Worker vars | PUBLIC_BASE_URL、EMAIL_FROM、环境名、构建版本 |
| Worker Secrets | 渠道加密密钥及版本、邮箱验证码 HMAC、可选 Turnstile Secret |
| D1 settings / 业务表 | 注册策略、准入门槛、用户/渠道限额、模型价格、访问权限 |
| KV | 上述可缓存内容的副本；禁止保存唯一配置或唯一恢复凭证 |

配置启用需校验相互约束：例如启用邮箱验证注册前须邮件可用；新模型须显式价格及输出上限；禁用最后一个管理员应拒绝。配置更新与审计同一 D1 原子操作，缓存失效在提交之后尽力执行。

## 12. 初始参数与观测

### 12.1 实施默认值

以下为首版建议，在 M0 的实测与账户能力核对后写入配置；不存在用户已承诺的生产容量。

| 参数 | 初始值/规则 | 调整依据 |
| --- | --- | --- |
| 注册策略 | closed；邮箱验证开启 | 管理员配置与邮件就绪 |
| 邮箱验证码 | 六位、十分钟、重发六十秒、最多五次错误 | 邮件延迟与滥用情况 |
| 发码限流 | 每邮箱每小时五次、每 IP 每小时二十次 | 单位时间发码与误伤观察 |
| 登录限流 | 每账号十五分钟十次失败；每 IP 十五分钟五十次尝试 | KDF 压力与登录失败率 |
| 会话 | 七天固定有效期 | 会话安全与使用习惯 |
| 用户并发 / RPM | 新用户并发和 RPM 均不限，管理员可按需设置 | 上游成本与负载 |
| 渠道并发 / RPM | 并发和 RPM 均默认不限，留空/0/null 表示不限 | 不设置业务并发数值上限，仅校验整数表示 |
| Gate 租约 / 续租 | 九十秒 / 三十秒 | 实际运行时与故障恢复 |
| 准入门槛 | 余额 > 0；模型可设更高门槛 | 负余额与昂贵模型风险 |
| 余额 KV | 开关保留，初始关闭；启用时快照十五秒 | 是否减少数据库读取及总延迟 |
| 路由/价格业务缓存 | 六十秒，最终登记核对版本 | 管理变化频率与命中率 |
| 网关正文 | 初始 8 MiB；管理正文 64 KiB | 图像内容与 Workers 内存实测 |
| 输出上限 | 每公开模型必须配置；不隐式无限输出 | 模型能力与运营预算 |
| 上游响应头 / 空闲超时 | 六十秒 / 一百二十秒；允许按模型覆盖 | 推理模型、心跳与真实上游 |
| 单次调用最长时间 | 初始十五分钟 | 成本与长流实测，不代表平台上限 |
| 转换器缓冲 | 不完整帧初始 1 MiB；累计工具参数 4 MiB | 工具 schema、输出和并发内存 |
| 即时结算重试 | 最多三次尝试，总预算六秒 | D1 延迟与错误 |
| Cron | 五分钟；异常扫描按十五分钟上限另加五分钟宽限 | 积压、扫描成本与长请求设置 |
| 明细保留 | 请求详细元数据九十天；短期调试日志七天 | 存储与隐私需要 |

超时和缓冲阈值在达到之前明确拒绝或终止，不能静默截断用户要求的工具参数。请求超过模型输出上限时返回参数错误并告知允许值；未填输出上限时使用公开默认值，并映射到对应协议。

会话/验证码和限流数据按用途过期；请求详情到期可脱敏、压缩字段，但账单引用的最小请求记录、幂等键与未结异常不能直接删除。账单和管理审计一期不自动删除，上线前确定存储预算和后续归档触发点；不把“保留”理解为无限容量承诺。

### 12.2 指标和日志

每次调用用内部 request_id 贯穿接入、渠道、转换与账单；上游提供 request ID 时单独保存。日志不含完整 prompt/输出，默认仅保存模型、协议、计数、阶段耗时和脱敏错误。账单可保存必要的 usage 元数据，不能把供应商整份正文当 usage。

关注：

- 准入总延迟、首字时间、端到端时间和各阶段 p50/p95/p99。
- 各协议组合成功/失败/取消比例，SSE 解析错误和缺失 usage。
- 结算失败、待结算最老年龄、未知用量、重复/冲突结算。
- 余额为负的人数和总额、每请求费用分布、单位用户突增。
- D1 读写/扫描量、数据库容量、KV 命中/过期/失败和 DO 活跃租约。
- 邮件发送接受/失败、验证失败、注册拒绝和管理员修改。

用户界面显示业务可理解的失败原因；内部原始异常只进入受控运维日志。对外不声称已经采集到这些指标；它们是实施交付要求。

### 12.3 成本和容量原则

成本由 Worker 请求/CPU、D1 读写与存储、KV 操作、DO 请求/存储与活动时间、邮件发送，以及上游模型消费组成；实际单价按部署时账户计划核对。

每个正常模型请求至少需要一次 D1 准入登记和一次原子结算；这些操作内部可能涉及多条 SQL/索引写入。并发协调包含两个主体的获取/释放和长请求续租，不能把一条调用等同于一次 DO 操作。KV 降低部分读取，无法消除账单写入。

性能瓶颈候选包括单个 D1 的写入串行度、热点渠道 DO、KDF 和流缓冲。M0 记录目标用户数/峰值并发，M4 逐级实测；报告具体上游、模型、地区、计划、样本量与瓶颈，不从 Workers 全球节点数量推导业务吞吐。

## 13. 测试与验收

### 13.1 测试层次

1. **纯函数/契约测试**：六方向请求与响应转换、九格普通/SSE fixtures、价格与取整、错误映射、usage 归一化。
2. **D1 集成测试**：实际迁移与触发器；并发注册、单次码争抢、相同结算重放、fingerprint 冲突、回滚与负余额。
3. **Workers/DO 集成测试**：真实流生命周期、背压、取消、租约跨实例重启、失联续租与 TTL 回收、缓存故障回源。
4. **浏览器端到端**：注册模式 × 验证开关、登录、个人 Key、管理员配置/授额、调用与账单查询、越权和 CSRF。
5. **真实供应商/客户端测试**：固定三种上游协议的模型与 SDK 版本；十八条基本路径、工具往返与 usage；不把 mock 成功当供应商兼容。
6. **负载/故障测试**：多 Key 同用户共享限额、热点渠道、长流与慢客户端、D1/KV 故障、重复结算、缓存陈旧及透支观察。

建议使用 Vitest 与 Workers 测试运行时、Playwright 浏览器测试；版本和执行命令在 M0 固定。远程集成资源与生产隔离，真实供应商测试需显式配置密钥和测试成本上限。

### 13.2 必过的关键案例

| 场景 | 通过条件 |
| --- | --- |
| 缓存 0.50、调用费用 0.75 | D1 为 -0.25，账单完整；下一次查到不足后拒绝，不截零 |
| 两个请求同时结算 | 余额等于两笔 delta 之和，无覆盖丢失 |
| 同一结算提交十次且有超时 | 只产生一笔消费；每次返回相同已提交结果 |
| 相同 operation_id 不同金额 | 幂等冲突，余额不变，不覆盖原账单 |
| 原子操作中途故障 | 用户/凭证或账单/余额不出现半成功 |
| 同一码/同邮箱并发注册 | 只有一个用户创建，失败方不误消费其他凭证 |
| 发码后重发与旧回调竞争 | 仅当前 generation 可用，旧发送结果不能覆盖新状态 |
| 管理员改价/停用，KV 仍旧 | 最终 D1 检查拒绝旧权限/配置；当前请求价格快照稳定 |
| 长流超过原租约 TTL | 续租使并发仍占用；结束或异常后可回收 |
| Worker 在上游消费后退出 | 异常可发现；无完整证据时显示未知，不伪造零费 |
| 取消、长度截断、工具调用 | 结束状态和客户端协议正确；有可靠 usage 才精确计费 |
| 工具 JSON 任意分片、多工具交错 | ID/索引/参数正确，完成事件唯一，下一轮工具结果可回传 |
| 用户跨账号查请求/Key/历史引用 | 返回权限错误，不泄漏数据 |
| KV 完全关闭 | 功能和正式账单正确，性能变化可测量 |

### 13.3 与一期目标对应

| 目标 | 设计章节 | 必须提交的证据 |
| --- | --- | --- |
| P1-01 / P1-05 | 5、6、10 | 九格十八路径测试、真实上下游记录、字段兼容报告 |
| P1-02 / P1-04 / P1-13 | 4、10、11 | 管理员初始化、用户/Key/会话、权限端到端测试 |
| P1-03 / P1-06 | 5、7 | 模型/组路由、停用准入、并发与租约故障测试 |
| P1-07 / P1-08 | 8、9、12 | 负余额、幂等扣费、账本核对、故障发现与恢复记录 |
| P1-09 | 2、14 | 干净环境构建、迁移、测试、部署及恢复步骤 |
| P1-10 / P1-11 / P1-12 | 4、10 | 三模式与验证开关、邮件实测、验证码/注册码并发测试 |

测试报告必须区分未实现、mock 通过、远程运行时通过、真实供应商通过；只有文档或路由存在不能标“已完成”。

## 14. 部署、发布与恢复

### 14.1 环境与上线顺序

local 使用本地 D1/KV/DO 模拟与邮件替身；staging 使用独立 Cloudflare 资源、测试发件身份及受限上游 Key；production 独立 binding、Secret、域名与数据。沿用一个工程和一种部署拓扑，不复用旧四个 Worker 的资源来做试验。

首次部署顺序：

1. 固定 Node/pnpm/Wrangler 和 compatibility_date，生成依赖锁文件，构建静态资源与 Worker。
2. 创建独立 D1、KV、Gate DO binding/类迁移，设置 Email binding、vars 与 Secrets。
3. 应用 D1 初始迁移、索引和触发器；初始化默认 settings、默认组及零余额管理员。
4. 部署 Worker/Assets，确认 API 路由、Cookie 域、Secret 版本与邮件发送身份。
5. 管理员配置真实渠道/模型/价格、用户限额和测试授额；注册保持关闭。
6. 在 staging 完成注册邮件和三协议普通/流式的烟测及关键故障验证。
7. 按已验证版本部署生产，先小范围使用，再按管理设置开放所需注册模式。

这里描述部署流程，不代表本次已创建资源或上线。现有 sub2api-pages/api/admin/proxy 保持原状，旧线上数据迁移不在一期自动动作中。

### 14.2 迁移和版本回滚

D1 SQL 迁移与 DO 类迁移随源码管理。生产优先增加字段/兼容读取，再部署使用新字段的代码，最后在后续版本清理；禁止把不可逆删列和代码回滚绑成一个随意操作。

缓存键带 schema version；改缓存结构可换前缀并让旧缓存自然过期。价格快照、账单计算版本和 KDF 格式向后可读。DO lease schema 变化要兼容正在执行的租约，部署不应清空所有租约造成瞬间超额。

应用回滚到上一兼容版本，先检查数据库与加密版本是否仍可读。不能通过回滚 D1 余额来“撤销部署”，这会丢失部署后的真实账单。

### 14.3 备份与恢复

上线前确认账户的 D1 恢复能力和保留窗口，建立受控导出与恢复演练说明。备份包含数据库、迁移版本、配置版本和加密 Secret 的恢复途径；单独拥有加密后的渠道表不能恢复上游 Key。Secret 由部署者安全保管，不导出到仓库。

恢复流程先进入维护状态，恢复到隔离数据库，核对用户余额与账单 delta、幂等键、未结请求、渠道解密和管理员登录，再切换 binding。恢复到过去时间点会遗漏之后的调用，必须对照已有证据处理，不承诺天然零数据丢失。

初版不做自动 R2 归档或双库灾备。日志/账单接近存储预算时再设计归档与查询，而不是直接删除财务明细来腾空间。

## 15. 实施顺序与扩展条件

### 15.1 里程碑

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| M0 工程/可行性 | 固定版本与基线、最小 Worker、D1 原子注册/结算实验、KDF、Email、三种上游连通和流处理 | 关键平台依赖实测，默认参数和测试上游记录完成 |
| M1 身份 | 注册、验证、单次码、会话、管理员、个人 Key 与页面 | 六种注册模式组合及权限/竞争条件测试通过 |
| M2 渠道/计费 | D1 模型配置、组权限、KV、Gate DO、请求记录、负余额记账、Cron | 模拟调用的资格、幂等、回滚、故障恢复正确 |
| M3 转换网关 | 六方向桥接、同协议、SSE、取消、真实上游、计费接入 | 九格十八路径和工具多轮真实链路验证完成 |
| M4 控制台/上线 | 运维和账单界面、联合测试、负载测量、部署/恢复说明 | P1-01 至 P1-13 均有可检查证据 |

M0 先验证最可能推翻方案的依赖，再做完整页面。M1–M3 每步都有可运行闭环；不把协议转换留到最后用接口占位替代。

### 15.2 仍需真实环境确认的事项

- Cloudflare 当前账户/计划对 Email Service 的实际可用性、发件域名和额度。
- 三种上游协议的 Base URL、模型、usage 行为、超时和测试预算。
- Argon2id 实现及安全参数在 Workers 中的资源消耗。
- D1 条件注册与记账触发器在远程运行时的事务、返回值与并发行为。
- SDK 版本、Responses 原生历史引用可用性及供应商独有字段。
- 预期用户数、峰值并发、数据保留预算和首版参数调优。

这些是实施验证项目，不另开一套待选架构。若某项不可用，明确记录受影响范围和替代决策；不能把未验证的 Email、状态恢复或容量写成已上线能力。

### 15.3 何时才扩展架构

| 观测到的问题 | 首先处理 | 确有必要时再考虑 |
| --- | --- | --- |
| D1 延迟/扫描量高 | 索引、合并查询、减少写入、保留策略 | 分库/拆分查询负载 |
| 余额 KV 收益差 | 关闭余额缓存，继续 D1 准入 | 不为此增加余额同步服务 |
| 结算异常长期积压，当前恢复窗口不可接受 | 修复持久化与重试、评估真实损失 | 可靠队列或事务 Outbox，并单独重审一致性 |
| 热点渠道 DO 成瓶颈 | 调整调用频率、租约和上游容量 | 经验证的分片或分层限额 |
| 请求/账单容量接近预算 | 保留策略、明细压缩与导出 | R2 归档及相应查询 |
| 业务要求严格零透支 | 重新确认成本与业务要求 | 额度预留/强一致账本，不沿用软卡口承诺 |

当前架构足以形成一期闭环；是否增加机制由测量和业务要求触发，不预先复制原版全部基础设施。

## 16. 参考与状态声明

源码基线固定为 Sub2API ab99d56e9626e6cd731592dae8553c9758a0efa2。已核对部分注册、转换和普通余额计费源码；移植时记录具体文件、测试对应关系与适用许可证，保留要求的声明。当前本机旧源码不完整，必须取得完整固定版本后再复用代码。

- 注册设计依据：[Sub2API 注册服务](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/service/auth_service.go)、[注册码竞争测试](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/service/auth_service_invitation_race_test.go)。
- 计费源码与 Redis/KV 差异：[计费专题](billing-cache.md)。
- 字段与方向兼容说明：[协议专题](protocol-compatibility.md)。
- 现有四个 Worker 的调查结论及限制：[现有证据](evidence.md)。

本文描述完整技术方案，不作为功能已完成的证明。首批基础代码的本地检查见 [实施进度](implementation-plan.md) 与 [工具链记录](toolchain.md)；真实供应商验证、邮件投递、数据库故障实验、性能数据、GitHub 远程仓库及生产发布仍未验收。

2026-09-10：用户确认同时取消默认 RPM 限制；实现和旧默认值处理见 [不限配置记录](unlimited-limits-2026-09-10.md)。
