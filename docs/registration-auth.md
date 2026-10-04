# 注册与身份技术方案

状态：注册和身份流程已实现。2026-09-09 起密码门槛为六位；分组授权和已部署验证见 product-adjustments-2026-09-09.md。

本文是 [完整技术方案](architecture.md) 第 4 章的专题补充；会话、KDF、默认限流及部署初始化以主文档为实施基线。

## 对照 Sub2API

参考提交 `ab99d56e9626e6cd731592dae8553c9758a0efa2`。已阅读注册服务、邀请码并发回归测试和 RegisterView 相关片段：注册开关、邀请码开关和邮箱验证独立控制；邀请码校验后还须与创建用户一起原子核销。

新工程沿用该行为，界面将前两个开关合成为三种注册模式。注册码对应注册邀请码，与充值兑换码、推广邀请码分开；一期单次使用，可设置有效期，不附带余额。

## 设置与用户流程

| 注册模式 | 所需资料 | 邮箱验证开启时 |
| --- | --- | --- |
| closed | 不允许自助注册；保留已有用户登录 | 不发送注册验证码 |
| open | 邮箱、密码 | 还需邮箱验证码 |
| invite | 邮箱、密码、注册码 | 还需邮箱验证码 |

可映射原版 registration_enabled、invitation_code_enabled；独立保留 email_verification_enabled。默认 closed、邮箱验证开启。管理员先完成邮件配置才能开放依赖验证的注册；设置变更需要权限和审计。

注册页读取公开设置，按模式显示输入项。先发验证码，再提交注册；前端预校验不占用注册码，提交时后端重新核对权威设置。注册成功时 D1 内已原子创建用户与零余额账户，随后建立普通用户会话。无需等待 DO 初始化或异步激活。

初始管理员通过受控部署初始化流程建立，公开注册不能选择管理员角色。注册码的生成、分页列表、使用记录与禁用在管理后台完成，明文只在生成时返回。

## 邮箱验证与发送

- 初始参数：随机六位码、10 分钟有效、重发间隔 60 秒、每个挑战最多 5 次错误尝试。实现时固定并测试，不是平台限制。
- 绑定规范化邮箱、注册用途及版本；存 HMAC 摘要，密钥放 Worker Secret。
- 新一轮重发作废旧版；使用后不可重放，不能跨邮箱或用途验证。
- 正确验证码在注册事务成功时消费。错误尝试次数独立持久化，不能随注册失败回滚。
- 发送前持久化挑战，发送成功只代表邮件服务接受；失败或超时有明确状态，不宣称已送达。
- 请求内等待 Email Service 接受；失败或超时提示稍后重发，新一轮发码使旧版失效。初版不建邮件队列、不保存可解密的验证码任务。
- 按 IP 和邮箱双维度限流，使用强一致计数；KV 读改写不作为安全限流。
- 邮箱统一 trim/大小写规范化并设唯一键；不任意去掉 + 后缀或点号合并地址。
- 关闭验证时创建的邮箱标记为未验证；之后开启开关不自动把旧邮箱变成已验证。

发送通过独立 `EmailSenderBinding` 注入：`EMAIL_PROVIDER` 未设置时沿用 Cloudflare Email Service 的 send_email binding；设为 `resend` 时使用 Workers 原生 HTTPS fetch 和 `RESEND_API_KEY` Secret，不需要 SDK 或 EMAIL binding。Resend 适配器仅支持当前纯文本邮件，不自动重试；明确拒绝记为 failed，网络中断、超时和不确定响应记为 unknown，返回有效 message ID 才记为 accepted（不代表收件箱投递成功）。验证码业务、限流、挑战状态和管理设置保持不变。配置步骤见[部署说明](deployment.md#resend-验证码邮件)。上线前核对发送域名、账户能力、额度和退信处理；本地验证使用模拟发送，服务未就绪或发送失败不绕过邮箱验证。密码找回仍未实现，新增 provider 不会启用密码恢复。

## 数据模型与原子边界

| 表 | 主要内容 |
| --- | --- |
| settings | 注册模式、验证开关、版本与更新时间 |
| users | 唯一 email_normalized、角色、状态、邮箱验证时间、版本化密码摘要、余额（默认零） |
| sessions | token_hash、user_id、到期与撤销时间 |
| registration_codes | 唯一码摘要、状态、有效期、创建人与使用记录 |
| email_challenges | 邮箱、用途、版本、摘要、到期时间、尝试次数、发送/消费状态 |

注册事务必须原子核对提交时的设置、邮箱唯一性、注册码和验证码，并一起创建用户、密码摘要、零余额和凭证消费记录。实现时验证 D1 条件 SQL/触发器与原子 batch 方案：任一条件失败须整批回滚，不能先 SELECT 再无条件 UPDATE，也不能假设存在跨请求的数据库事务。

提交顺序：

1. 校验资料、正文大小、限流和注册策略，执行密码 KDF；不核销一次性凭证。
2. 同一 D1 原子操作创建普通用户与零余额、核销注册码、消费验证码；失败整批回滚。
3. 提交后建立会话；若会话响应丢失，用户可直接登录，不重复创建账户。
4. 如需后续授额，通过 D1 幂等记账接口完成；不从注册码推断余额。

用户创建与凭证核销不依赖 DO 业务账户初始化、KV 或异步事件；登录/发码等入口仍使用 Gate DO 限流。邮件投递与数据库没有共同事务，发码失败不能绕过验证；注册提交后的会话创建失败不退还已使用注册码。

## 接口草案

以下是新工程接口草案，不宣称已逐项兼容原版：

| 接口 | 用途 |
| --- | --- |
| GET /api/v1/settings/public | 公开注册设置 |
| POST /api/v1/auth/send-verify-code | 发注册邮箱验证码，返回冷却时间而非验证码 |
| POST /api/v1/auth/register | 提交邮箱、密码、注册码和验证码 |
| POST /api/v1/auth/login | 邮箱密码登录 |
| POST /api/v1/auth/logout | 撤销当前会话 |
| GET /api/v1/auth/me | 当前身份 |
| GET/PATCH /api/v1/admin/registration/settings | 注册策略查询与修改 |
| POST/GET /api/v1/admin/registration/codes | 生成/分页查询注册码 |
| POST /api/v1/admin/registration/codes/:id/revoke | 禁用未使用码 |

## 安全与验收

密码选用成熟、版本化 Argon2id 与独立盐，参数和运行时实现通过 M0 实测后锁定；不可用时另行记录替代 KDF 决策。浏览器使用随机高熵会话令牌，数据库仅存摘要；初始七天固定会话，Cookie 为 HttpOnly/Secure/SameSite，写接口校验 Origin/CSRF。登录错误统一，发码接口避免暴露邮箱是否已有账户。管理员接口检查真实角色，不依赖页面隐藏。

验证码、密码、注册码不写日志；失败返回稳定错误码。Turnstile 保留可配置接入点，不替代后端限流和原子核销。密码找回、社交登录与登录二次验证暂缓。

必须覆盖：

- 三模式 × 验证开关；旧页面不能绕过新设置。
- 同邮箱争抢、同单次码争抢仅一人成功；事务失败不误消耗码。
- 错误/过期/已用/禁用码、跨邮箱验证、旧版码和尝试超限被拒。
- 邮件失败、重复发送、注册提交成功但响应丢失均有确定行为，不重复创建或授额。
- 注册到登录、发 Key、调用、账单查询全流程；普通用户越权、退出、到期、CSRF 验证通过。

参考：[Sub2API 注册服务](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/service/auth_service.go)、[邀请码并发测试](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/backend/internal/service/auth_service_invitation_race_test.go)、[Cloudflare 邮件 API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)。
