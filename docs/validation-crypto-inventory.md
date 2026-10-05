# CheapAI 校验与密码学处理清点

> 本文保留审批前审计结果。用户随后批准的清理已实施，当前行为及必要保留项见[校验与接入政策简化](policy-simplification.md)。文中的“待确认”仅描述审计当时状态。

日期：2026-10-05。范围：`apps/worker`、`apps/web/src`、`apps/desktop/src`、`apps/desktop/src-tauri/src`、`apps/desktop-runtime/src`、`packages/contracts`、`packages/desktop-contracts`、`packages/api-client`、`packages/apicompat` 和 D1 migrations。排除依赖、dist 和测试。本报告只读生产代码，没有删除或放宽任何校验。所有建议都等待用户决定。

这是按行为/信任边界合并的清单，不把每个 `if` 都算一个独立产品规则。文件锚点以当前工作树为准；渠道与 Desktop Key 加密已在当前工作树移除，C01/C02 的路径记录删除前实现；其余锚点以本次审计时的代码为准。未读取任何 Secret 值，也未声称已验证生产资源配置。

## 结论与用户决策项

1. **已获授权删除的额外加密**：渠道上游 Key 与 Worker 保存的 Desktop 当前 API Key，共用 AES-GCM envelope 和 `CHANNEL_KEYRING_JSON` / `CHANNEL_ACTIVE_KEY_VERSION`。这是此次添加渠道 503 的配置依赖，已在当前工作树移除，尚未发布。它与用户登录密码哈希、会话 Token 哈希、桌面系统凭据存储不是同一件事。
2. **发现会拦截合法输入的限制冲突**：`auth/key-groups.ts:82` 允许最多100个用户分组，但 `admin/update-user.ts:63` 把整个分组数组送入 `admin/audit.ts:36,71`，其数组上限只有32。授权33–100个分组会因审计 `payload_too_large` 失败；已有大数组用户后续改group同样受影响。应统一业务与审计限制，先请用户决定。
3. **明显重复的检查，建议优先合并**：前端表单/controller 和 API client 重复调用同一个 input schema；HTTP 路由与仓储重复输入字段校验；网关第一次 parse 后能力识别再次 parse，选每个候选时又识别一次；平台鉴权后上游 headers 再查平台 Token 格式。
4. **可疑的过度防御，建议确认简化范围**：已由 JSON.parse 生成的数据再检查原型、Symbol、getter、属性描述符；大量内部 `Date.now()`、已 typed 的配置/options 在多层重新检查；财务 canonical JSON 自建通用序列化器的原型/descriptor/循环/深度框架。可统一到明确边界，但不能把金额、幂等一致性一起删。
5. **有实际产品限制效果，不能当纯冗余直接删**：上游仅 HTTPS、公网地址、无查询参数/无重定向；模型扩展参数须显式 allowlist、能力未声明即拒绝、Anthropic 固定版本及 beta allowlist；RPM 最大 4096；邀请码单批最多 100 / 最长 30 天；密码 6–128 字符；请求大小/超时；管理写请求 Origin+CSRF。需要用户明确保留、放宽或删除。
6. **仍有密码学/存储机制待确认**：Argon2id 密码哈希、随机 Token SHA-256、邮件验证码 HMAC、CSRF nonce/恒时比较、结算和幂等 SHA-256、OS keyring、更新签名验证。建议保留的原因见下表，用户尚未批准任何新增移除。
7. **发现现有脱敏，不是本次新设计**：D1 admin audit 字段 allowlist/限长、Desktop RPC/公开状态投影、apicompat 公共错误映射。它们不等于 CF 原始错误日志；若用户希望一并简化，需指定范围，不能混在加密删除里处理。

## A. 加密、哈希、签名、随机数完整入口分类

| 编号 | 机制 / 入口 | 作用与触发 | 判断与待定事项 |
|---|---|---|---|
| C01 | `apps/worker/catalog/secret-envelope.ts:24,49,73`；`catalog/channel-secrets.ts:29,43`；`channel-keyring.ts:16` | AES-GCM 256-bit、随机 12-byte nonce、带 channel ID/version 的 AAD，创建/换渠道 Key 加密，转发解密；keyring 16 项/8KiB/标准 base64 32-byte/活动版本校验 | 用户已明确要求移除，当前工作树已移除；不要误把 `encrypted_reasoning` 协议字段当此加密。 |
| C02 | `apps/worker/auth/desktop/key-cipher.ts:32,48`；`auth/desktop/keys.ts` | 同一 envelope 保存 Desktop 当前 API Key，AAD 绑定 session/key/version；恢复/刷新 Desktop Key 解密 | 已在当前工作树移除；Desktop session hash 与 OS keyring 是独立机制。 |
| C03 | `apps/worker/auth/password.ts:5,31,82,103,117` | 注册/管理员创建用户时 Argon2id；登录验证。19,456 KiB / 2 iterations / 1 parallelism、16-byte salt、32-byte hash；固定 PHC profile；恒时比较；密码字节清零 | 这是不可逆密码哈希，不需要线上额外加密 ENV。建议保留哈希。密码长度、Unicode检查、单 isolate KDF 并发=1 可另决策；当前128 Unicode标量每个至多4bytes，所以512-byte上限分支实际被字符上限涵盖，不能称“纯冗余”。 |
| C04 | `apps/worker/auth/tokens.ts:35,43,63` | API Key / web session / desktop session / 邀请码生成 32 随机 bytes，带用途前缀；D1 保存整个 token 的 SHA-256；`verifyToken` 恒时比较 | 不依赖用户配置密钥。建议保留高熵 token 与不可逆存储。固定前缀/43字 base64url 的 canonical 检查可集中，不能逐层重复。 |
| C05 | `apps/worker/auth/email-proof.ts:40,49,56,66,71,87` | 六位邮件验证码 rejection sampling 随机生成；HMAC-SHA256 签名/验证 email+purpose+generation+code；需 `EMAIL_HMAC_KEY` | 这是低熵验证码 MAC，不是可逆加密。是否保留邮件验证由产品决定；保留此功能建议保留 MAC。key 最少 32-byte、code6位、代数/格式为该协议约束。 |
| C06 | `apps/worker/auth/csrf.ts:45,71` | 32-byte 随机 CSRF nonce；双提交 cookie/header + Origin；恒时比较。覆盖匿名登录/注册和管理写请求 | 不需额外 secret ENV。用户确认是否保持 cookie-session CSRF；不建议把它与渠道加密绑定删除。 |
| C07 | `apps/worker/limits/auth-rate-limit.ts:82` | 登录/发码/注册的 IP/email SHA-256 转为 Gate 名称 | 标识哈希，不是秘密加密；用于稳定 DO key，减少直接暴露标识。可改可读标识但须考虑现有限流状态切换。 |
| C08 | `apps/worker/billing/fingerprint.ts:227,255` | 结算 facts + 价格/usage snapshot canonical JSON 的 SHA-256，避免同 operation ID 不同金额的重放 | 不需 ENV。建议保留内容一致性；是否用 hash 或原文比较可讨论，不可去掉幂等冲突判断。 |
| C09 | `apps/worker/auth/key-creation.ts:107`；`auth/registration-codes.ts:28` | API Key 创建、邀请码批次参数 SHA-256 用于同 operationId 重试一致性 | 不需 ENV；建议保留幂等语义，表示法可简化。 |
| C10 | `apps/worker/admin/balance-routes.ts:77` | `Idempotency-Key` SHA-256 派生管理员余额操作 ID | 防同一调账重复执行，不是金额加密。待决定是否保留派生形式；幂等本身建议保留。 |
| C11 | `apps/worker/admin/model-mappings.ts:22` | channel/model/protocol tuple SHA-256 作为审计 target ID | 纯稳定标识，非密码安全需求；可改复合 ID，收益小，会改变审计关联键。 |
| C12 | `apps/desktop-runtime/src/dsh/paths.ts:82` | server origin/account tuple SHA-256 派生每账号 DSH home | 路径隔离与稳定目录名，不是文件内容加密；换算法会影响找到旧对话目录。 |
| C13 | `packages/theme/vite.mjs:8` | 主题引导脚本 SHA-256 前12位用于静态文件名/cache bust | 构建资源版本标识，应保留；不需 secret。 |
| C14 | `apps/desktop/src-tauri/src/credentials.rs:79,87,109` | 原生 OS keyring 保存 Desktop bearer token+expiresAt；安装/账号 namespace、record version 检查 | 是平台凭据存储，项目未自写可逆算法；独立于 Worker channel keyring。移除会改凭据落盘策略，须用户另批准。 |
| C15 | `apps/desktop/src-tauri/src/updates.rs:233,346,374` | `tauri_plugin_updater` 使用 configured pubkey 验证下载包；校验 HTTPS endpoint；没有项目自写 sign 函数 | 二进制更新真伪验证；建议保留。签名算法实现属 Tauri 依赖，不在业务源码内。 |
| C16 | `apps/worker/limits/gate.ts:122`；`auth/email-proof.ts:45`；`gateway/select-channel.ts:29`；遍布 `crypto.randomUUID()` 和 desktop `randomUUID()` | Gate lease随机凭据、验证码、同优先级渠道随机顺序、请求/实体/操作/IPC ID | 是随机数与标识，非额外加密。UUID/lease token不能当无意义校验批删。 |
| C17 | `apps/worker/gateway/transport.ts:103`；`apps/desktop-runtime/src/cheapai/account-client.ts:221` | 网络 fetch 的 TLS 由 CF/系统实现；上游业务策略强制 HTTPS，而 Desktop API baseURL 目前允许 HTTP/HTTPS | 未发现项目自写 TLS、RSA、JWT/JWS、额外 payload签名、PBKDF2/scrypt。不要用代码中 `signature`/`encrypted_content` 这些模型协议载荷误报为本地密码学。 |

## B. 所有校验能力（按功能与信任边界）

| 编号 | 文件锚点 | 校验内容 / 触发点 | 判断 / 用户决策 |
|---|---|---|---|
| V01 | `apps/worker/config.ts:105,127,135,151,210,224` | 运行配置必须 plain object、拒未知字段；安全正整数、金额格式；验证码固定6位；重发<有效期、续租<租期、各超时≤总时限；渠道/模型限额 | 类型/关系错误宜尽早报；原型/Reflect多余候选。配置规则有运维影响，所有具体上限须用户确认。 |
| V02 | `apps/worker/routes.ts:55,73`；`auth/registration-settings.ts` | PUBLIC_BASE_URL 格式；可选邮件 binding/sender/HMAC 可用性；注册开放/邀请码/邮件验证依赖；生产/local来源规则 | 外部 ENV 边界必要。勿让可选邮件配置阻断无关登录/渠道；实际配置依赖由 env清单任务报告。 |
| V03 | `apps/worker/gateway/read-json.ts:16`；`admin/channel-routes.ts:36`；各 `admin/*-routes.ts`、`auth/*-routes.ts`、`chat/routes.ts:54` | Content-Type、body存在、字节上限、严格UTF-8、JSON对象、允许字段、方法/路径/查询重复参数 | HTTP 边界建议保留；每路由重新实现同一 reader 是冗余可抽共用。拒多余 query/未知 body字段是兼容性政策待定。 |
| V04 | `apps/worker/http.ts:75`；`admin/channel-repository.ts:151`；`billing/entry-queries.ts`；`gateway/request-query-routes.ts` | limit1–100、cursor长度/base64url规范、解码版本/排序键/筛选和owner绑定 | 范围/owner建议保留；过度 canonical 编码回环检查可审；cursor无加密无签名，编码不是加密。 |
| V05 | `apps/worker/auth/password.ts:31,69,82`；`auth/login-core.ts:36`；`auth/register.ts:49`；`admin/create-user.ts:24` | 密码6–128 Unicode标量/512bytes、拒孤立surrogate；PHC固定算法参数；KDF并发1、登录前/后用户身份状态一致 | 哈希不可替代；重复输入validate可合并。并发=1可能导致登录503，需容量决策，非数据库不通。 |
| V06 | `apps/worker/auth/email-proof.ts:20`；`auth/send-code.ts:61`；`auth/register.ts:99`；`auth/challenge-repository.ts` | 邮箱trim/lowercase、Unicode/domain/length；验证码6位、代次、TTL、重发间隔、剩余尝试、使用一次、邮件HMAC准备度 | 邮箱语法为自定义子集，有拒合法但特殊地址可能；次数/TTL是产品规则；原子消费建议保留。 |
| V07 | `apps/worker/auth/registration-codes.ts:8,24,48`；`auth/registration-settings.ts` | closed/open/invite策略；邀请码hash、过期/已使用；一批1–100、有效≤30天；同opId批次一致 | 功能政策待定；会直接影响管理员操作。 |
| V08 | `apps/worker/auth/tokens.ts:14,21,63`；`auth/api-key-auth.ts:25,53` | Token用途/长度/规范编码、Bearer/x-api-key双头一致、D1 active/expiry/user/group查验 | 真正认证边界建议保留；重复格式层可合并。 |
| V09 | `apps/worker/auth/sessions.ts`；`auth/session-repository.ts:35`；`auth/middleware.ts:25`；`auth/roles.ts:9`；`auth/desktop/authenticate.ts` | Web cookie/Desktop bearer、token hash、session过期/吊销、账号active、角色admin；Cookie重复/格式 | 认证与角色授权，删除会改变谁能读写；等待用户决定，建议保留。 |
| V10 | `apps/worker/auth/csrf.ts:21,54,71`；所有管理写路由 | 精确HTTPS Origin、__Host cookie、header匹配；cookie8KiB限制、重复值/非规范nonce拒绝 | 主认证不能替代CSRF。exactOrigin需与线上域名一致，误配会403；严格cookie解析可简化但不能去掉源检查不说明。 |
| V11 | `apps/worker/auth/key-creation.ts:67`；`auth/key-repository.ts`；`auth/key-groups.ts`；`auth/web-chat-auth.ts`；`auth/desktop/key-repository.ts` | Key name/expiry/group/models<=100/去重、用途绑定；用户与group可用/准入；Desktop session/key ownership及轮换CAS；Web chat内部身份隔离 | ownership/用途/CAS必要；name NFC、禁止secret样式子串、数量100等是附加产品约束待定。 |
| V12 | `apps/worker/admin/channel-routes.ts:97,114`；`admin/channel-repository.ts:24`；`catalog/models.ts:29`；`catalog/model-mappings.ts`；`admin/group-repository.ts` | routes和repository重复允许字段、类型、ID、时间、version；repository再查prototype/ownKeys/descriptor | **优先合并候选**：由JSON.parse得到的值无getter/Symbol/自定义prototype，HTTP路径的这部分防御无额外效果；共享库独立调用边界需先确定。 |
| V13 | `apps/worker/gateway/upstream-url.ts:60,105`；`gateway/transport.ts:116` | 仅HTTPS、无userinfo/query/fragment；公网IP与域名规则、排localhost/internal等、路径去歧义，固定/v1 endpoint；拒3xx | 会阻断HTTP、本地/VPN渠道、带query的供应商、重定向。**业务范围待用户确认**。现仅做字面host排除，不DNS解析，不能宣称完整SSRF保障。 |
| V14 | `apps/worker/gateway/headers.ts:25,49` | 上游key ASCII/no whitespace/no s2a_*；重新检查downstream平台凭证格式；重建上游Auth，不复制client headers；固定Anthropic version，beta/tenant头allowlist | **平台token重复校验可合并**；上游不得错发平台凭证。禁止s2a_*会阻止以另一个CheapAI为上游，需确认产品是否允许级联。Anthropic版本/beta策略待确认。 |
| V15 | `apps/worker/gateway/parse-chat.ts:27`、`parse-responses.ts:27`、`parse-messages.ts:32`；`packages/apicompat/types/{chat,responses,messages}.ts` | 三协议schema、model ID、messages/tool参数/数字/JSON结构、token limit、unknown preserve；JSON/HTTP/SSE结构 | 入站协议解析建议保留；自定义prototype/descriptor可合并边界。不能因同为“校验”删掉原生必需字段。 |
| V16 | `packages/apicompat/capabilities/check.ts:94,374`；`apps/worker/gateway/select-channel.ts` | parse后identify又完整parse；每候选check再次identify/parse；features/stream usage/reasoning/cacheTTL/扩展allowlist，Messages必须显式max tokens，background不支持 | **真实重复计算**：可把parsed/features一次传递；能力政策尤其同协议unknown字段目前也显式许可，否则拒，是可用性限制待定。跨协议不可表达内容应报明确错误。 |
| V17 | `packages/apicompat/requests/*`、`responses/*`、`passthrough/*`、`streams/*`；`types/shared.ts`；`ids.ts:53`；`finish-reasons.ts` | 请求/响应/stream事件、序号、ID、tool关系、增量/终态、不可表示内容；opaque signed/encrypted reasoning转跨协议拒绝；保持同协议载荷 | 不是自写对用户内容加密；转换正确性与未知扩展兼容策略应分开，不能整包删除检查。 |
| V18 | `apps/worker/gateway/admit.ts:65,87`；`billing/admission.ts:52`；`gateway/response-history.ts` | 用户/Key/group/model授权、余额>0及模型最低余额、配置版本一致、缓存刷新、模型输出上限、同用户history/file引用绑定 | 准入和跨账号数据隔离；多次D1重读包含防TOCTOU，不全部属于重复。内部options/clock类型检查可独立收敛。 |
| V19 | `apps/worker/gateway/read-json.ts`；`gateway/transport.ts:31`；`gateway/execute-json.ts`、`execute-stream.ts`；`packages/apicompat/streams/parser.ts`、`buffers.ts` | body8MiB/admin64KiB、单SSE帧1MiB、tool args4MiB、header60s/idle120s/总900s、空响应/未知状态/流提前结束 | 资源界限有真实效果，建议保留可配置；数值由用户决定。 |
| V20 | `apps/worker/limits/auth-rate-limit.ts:30,47,73`；`limits/rate-window.ts:2,48,53`；`limits/gate.ts:29` | 可信IP规范、登录/注册/发码配额；DO RPC类型/字段/时间、window/limit<=4096、状态64KiB；重复opId不重复扣数 | RPM4096是实现上限，不是通用Worker限制。用户决定是否调整算法/上限；RPC/client/gate纯形状重复可以收敛。 |
| V21 | `apps/worker/limits/client.ts:46,73`；`dual-lease.ts`；`leases.ts:32,48`；`storage.ts:24`；`cooldown.ts:36,47,80`；`lease-lifecycle.ts` | 用户+渠道双lease、token/owner、租期/续租/释放、持久状态恢复、429/401 cooldown≤5min、remote响应形状及时间关系、请求结束清理 | 并发计数正确性/故障处理；边界重复字段校验候选；lease状态机不应当作无用校验删除。 |
| V22 | `apps/worker/billing/money.ts:14,27,39`；`pricing.ts`；`fingerprint.ts:127,141,154,227` | USD8位、整数安全范围、非负价格、usage质量与包含关系、group倍率、四舍五入、快照版本/金额一致性 | 财务正确性，建议保留；严格限制字符串canonical形式可视产品是否要接受宽松输入再规范化。 |
| V23 | `apps/worker/billing/fingerprint.ts:27` | 通用canonicalJSON深度64/node10万/1MiB；拒prototype/循环/Symbol/getter/稀疏array/non-enumerable，排序key | 框架复杂度候选；当前hash历史数据依赖序列化输出，简化必须保持结果或迁移版本，不可直接JSON.stringify替换改变幂等。 |
| V24 | `apps/worker/billing/settlement-repository.ts:57,85,125`；`adjustments.ts`；`settlement.ts`；`recovery.ts`；`reconciliation.ts` | operationId/request/owner/fingerprint/snapshot匹配；重放同结果、不同payload冲突；complete usage才结算；余额溢出；失败恢复对账 | 与SQL约束重叠但负责业务错误/重试，而数据库负责竞态原子性；建议保留原子保障，裁减重复需逐项证据。 |
| V25 | `migrations/0001–0026*.sql`；重点 `0012_registration_atomic.sql`、`0013_billing_atomic.sql:5,20`、`0010_billing_entries.sql`、`0022_chat.sql`、`0024_desktop_sessions.sql` | CHECK / UNIQUE / FK、不可变账本、余额/账单同事务触发器、注册邀请码/邮箱消费、请求状态/快照/usage、chat owner/幂等、Desktop session关联 | 防并发/直接SQL破坏数据，不是简单TS重复；任何移除均需用户批准且migration，不能改历史SQL冒充线上生效。 |
| V26 | `apps/worker/db.ts:14,48,67`；`admin/channel-repository.ts:65` 等SQL guard | D1 result.success/error/batch长度；`changes()=1`不成立故意SQL error使batch rollback；乐观version/当前状态再检查 | Worker/D1接缝与原子审计；看起来奇怪的json_extract/abs guard不是加密，是事务回滚手段。建议保留，integration验证另任务做。 |
| V27 | `apps/worker/cache/snapshot-codec.ts:21,34`；`platform/kv-snapshots.ts`；`cache/{routes,prices,balance}.ts` | KV JSONschema/version/source/时间/TTL、绑定key与owner、过时/未来/错版本回退D1；价格/balance shape | KV是外部不强一致边界。保留回退；同对象decode次数可优化但不能信任陈旧KV覆盖D1。 |
| V28 | `apps/worker/chat/routes.ts:49,62,110`；`chat/repository.ts:19,25,35,40,222`；`chat/messages.ts`；`chat/service.ts` | body字段；对话owner、ID/title/content限长、conversation version、operation ID同payload重放、同一running消息、重生成状态、未提交上下文选择 | owner/幂等/状态检查有行为意义；routes/service/repository对同字串重复检查是可收敛点。 |
| V29 | `apps/worker/scheduled/{cleanup,abandoned,settlements}.ts`；`gateway/request-lifecycle.ts`、`retry-policy.ts` | 扫描窗口/batch/time、只清理到期/终态、并发claim/CAS、最大重试/预算、派发后不任意重试避免双收费 | 运行可靠性；用户决定重试/保留政策，不建议全去掉。 |
| V41 | `apps/worker/auth/key-groups.ts:82`；`admin/update-user.ts:63`；`admin/audit.ts:36,71` | 分组选择允许100项，审计数组仅32项；合法33–100项请求在审计构造时失败 | **明确规则冲突**；应先由用户决定统一上限或审计按差异记录。未更改代码。 |
| V30 | `apps/worker/admin/audit.ts:36,57,115`；`gateway/observability.ts`；`http.ts:49` | admin audit严格字段白名单/嵌套规则/8KiB；公共HTTP只返回固定错误；诊断projection，原始log单独记录 | 已存在的输出限制，**不是渠道加密**。若要更清楚错误应改善CF日志原因，而非把私密HTTP响应与audit当同一层。所有进一步变更等待用户。 |
| V31 | `packages/contracts/src/{auth,common,account,audit,billing,channels,chat,groups,keys,mappings,models,registration-admin,requests,users}.ts` | Web/API共用Zod输入、响应、分页和SSE契约；大量strict未知字段拒绝、refine价格/计数/时间关系；public schema不接受新增字段 | 网络response decode建议保留；strict会让后端新增字段导致前端整页invalid_response，可决定response改strip/passthrough。input严格与response向前兼容应分开决定。 |
| V32 | `packages/api-client/src/client.ts`、`chat-stream.ts:29,75,194`、各资源client | HTTP成功/错误envelope、JSON/requestId、所有response契约；写请求CSRF；stream meta/delta/done/error顺序/格式与终止；分页重复cursor | 浏览器网络边界校验；分页无进展/流缺终态有必要。API client对已经form/controller parse的request再次parse可删一层。 |
| V33 | `apps/web/src/features/admin-channels/channel-form-model.ts:87,95,134,138`、`setup-form-model.ts:38,50` → `packages/api-client/src/channels.ts:62,71`；`apps/web/src/features/chat/model/controller.ts:125,457` → `packages/api-client/src/chat.ts:174,195` | form field校验/组装whole schema，再client same schema；send/regenerate controller same schema再client same schema | **已核实重复**。建议表单只提供可读字段错误、client或提交边界保留单一parse；不要删用户输入提示而留下更隐蔽错误。 |
| V34 | Web `features/admin-{users,groups,models,mappings,registration}`、`features/api-access`；`shared/forms`；`features/chat/hooks/useModelSelection.ts:50`；`packages/theme/src/bootstrap.js` | 登录/注册/金额/限额/模型映射表单、重试opId、localStorage版本/类型/JSON/failure兜底、主题枚举、选模保存 | 用户输入和本地存储是边界；schema重用可减少冗余，HTMLrequired/disabled和服务器授权不是同层重复。 |
| V35 | `apps/desktop-runtime/src/cheapai/account-client.ts:80,219`；`session-manager.ts:272,280`；`credential-bridge.ts:389,407,447,476`；`account-state.ts:199` | Worker HTTP响应、Desktop token/key形状/expiry、bridge framing/id/status/endpoint/timeout；账号状态投影；refresh/epoch避免旧请求污染新账号 | client→manager→bridge有重复shape检查，但经过不同进程边界，不能简单全删；内部copy/projection可合并。 |
| V36 | `apps/desktop-runtime/src/dsh/connection-info.ts:53,93,189`；`transport.ts:401,435,506,522`；`host/{control,protocol}.ts` | DSH ready行 URL/loopback/固定path/动态port/token、session cookie/RPC握手；所有请求和stream保持验证过origin；generation/requestId/frame限制；命令许可 | 防本地服务/旧进程串线，是runtime接缝校验；字段重复可收敛，loopback和generation建议保留。 |
| V37 | `apps/desktop-runtime/src/dsh/{paths,launcher}.ts`；`cheapai/provider.ts:50` | 绝对路径/账号home隔离、所启动进程所有权、仅http/https backendURL无credentials/query/hash、模型配置有效 | 路径和进程防误杀/串账号；自有typed config可少复验。 |
| V38 | `apps/desktop/src-tauri/src/{protocol,runtime,account}.rs`；`credentials.rs:148`；`native.rs:32`；Tauri capabilities | serde deny_unknown_fields、IPC命令和payload/generation、runtime私有URL验证、账号存储namespace、原生目录绝对且存在、仅固定cheapai注册链接/控制台可打开 | Rust<->JS<->renderer是真跨边界；strict response兼容性可讨论；不能将namespace校验等同内容加密。 |
| V39 | `apps/desktop/src-tauri/src/updates.rs:183,274,346` | 配置endpoint/pubkey、offer generation/stale/busy、必须下载/验证后安装、活动任务确认/停止 | 保护更新正确性；签名见C15。与Worker env和渠道加密无关。 |
| V40 | `apps/desktop/src/adapters/native/runtime.ts`、`features/conversations/composer-controller.ts`、`features/settings/preferences.ts` | native消息形状/服务状态、选模型/空内容/发送并发/取消、pref schema版本及account scope | UI避免非法动作和坏持久值；跨进程字段验证建议留在adapters；同层重复分支可后续简化。 |

## C. 建议用户按组确认

可以直接回复编号和操作：

- **D0：修复分组审计限制冲突**（V41）：业务允许100组与审计32项冲突，选择统一上限或记录差异。
- **D1：合并纯重复检查**（V12/V16/V33/V14平台token重复部分），保持所有现有外部接口规则。
- **D2：简化 JS 对象防御框架**（prototype/descriptor/Symbol；V12/V15/V23），只保留JSON/HTTP/DB/IPC入口检查；财务fingerprint输出必须保持不变。
- **D3：上游接入政策**（V13/V14）：允许 HTTP/私网/查询参数/重定向/CheapAI级联中的哪些；Anthropic版本/beta是否放宽。
- **D4：模型协议政策**（V16/V17）：同协议未知扩展是否默认透传；能力声明是否作为硬拦截；跨协议不可映射仍需明确错误。
- **D5：产品数量/时间/格式政策**（V01/V05/V07/V19/V20）：RPM4096、邀请码100/30天、密码长度、KDF并发、payload/timeout是否调整。
- **D6：认证与密码学**（C03–C06、C14–C15、V08–V11）：密码hash、会话hash、验证码HMAC、CSRF、OS keyring、更新签名逐项决定；建议保留。
- **D7：账务/幂等/数据库/lease**（C08–C10、V18/V21–V29）：建议保留语义，只去重复封装。
- **D8：输出strict/脱敏**（V30/V31/V35）：API响应schema允许新增字段；现有audit/desktop投影是否调整，单独处理，不影响CF原始错误日志。

本报告没有证明哪条历史规则来自原设计：只能证明当前代码实现及影响。所有“建议”均是审查判断，不替用户批准删除。
