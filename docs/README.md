# 文档导航

更新：2026-10-03；本轮修改基于 `54d71d5d74a6cadc83c3e6acdb3e9cb866efaa2a`，尚未推送或发布。

## 按角色阅读

### 使用者

1. [用户上手指南](user-guide.md)：注册/登录、网页聊天、API Key、第一次 API 调用与故障自查
2. [协议支持矩阵](protocol-support.md)：普通响应和流式转换的实际字段边界
3. [已知问题](known-issues.md)：本轮修复状态、浏览器受阻及尚未完成的发布验收

### 管理员与部署者

1. [管理员上手指南](admin-guide.md)：从空库到第一个可用模型的配置顺序
2. [初始管理员](admin-bootstrap.md)：首次初始化限制，不含密码重置
3. [部署步骤](deployment.md)：环境、Secrets、迁移和发布后检查
4. [备份与恢复](backup-restore.md)、[回滚](rollback.md)：版本与数据库兼容性判断
5. [真实上游兼容测试](live-compatibility-testing.md)：涉及真实供应商调用和费用，应在明确环境与预算后执行

### 开发者

1. [本地开发](development.md)：跨平台日常命令、完整本地环境及浏览器测试
2. [工具链记录](toolchain.md)：固定版本、安装策略及历史 Windows 故障说明
3. [技术方案](architecture.md)：整体设计基线；阅读时结合下方专题和现行源码
4. [身份与注册](registration-auth.md)、[计费与 KV](billing-cache.md)、[协议转换设计](protocol-compatibility.md)
5. [协议源码基线](protocol-baseline.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)

## 当前状态怎么看

不要把“有设计”“有实现”“本地通过”和“已在线上验证”混为一项状态。

| 问题 | 应查看的依据 |
| --- | --- |
| 当前有哪些功能和入口？ | [仓库 README](../README.md)、当前源码和迁移 |
| 接口支持哪些字段？ | [协议支持矩阵](protocol-support.md)及对应测试 |
| 当前提交是否通过检查？ | 对应提交的 [Actions](https://github.com/a48zhang/sub2api-cloudflare/actions)；明确区分 Vitest、构建和独立 Playwright |
| 哪些事项还没完成？ | [实施记录](implementation-plan.md)、[聊天交付记录](web-chat-delivery.md) |
| 线上到底是什么版本？ | 目标环境的 Worker version/deployment ID、D1 migration list 和同一环境的新鲜验收记录；仓库文件不能单独证明 |

当前源码包含 0001–0023 共 23 个 D1 迁移。部署配置保留本地模拟与使用真实独立资源的 production（cheapai.dev）；分支验证使用每个 PR 独立的预发配置。旧共享 staging 已于 2026-10-03 完成永久退役，相关 Worker、D1、KV 和 Gate DO 已删除并回读确认，相关操作入口已移除。配置存在不等于已部署、可访问或已通过真实上游验收。

## 设计、变更和历史证据

以下文档保留原日期和验证边界，不删除历史失败，也不把旧失败当作当前故障：

- [一期目标与验收](phase-1.md)：产品范围及验收要求
- [本轮执行计划与状态](implementation-plan.md)：2026-10-03 的 27 项开发及独立验证；文末另存旧 507 节点历史
- [桌面客户端详细计划](desktop/implementation-plan.md)、[机器可读任务图](desktop/task-graph.json)：Tauri、Bun/DSH、自有 React 界面和 Token + Key 接入；79 项小粒度任务，全部为待执行计划，测试与验证按完整模块集中进行
- [旧微任务清单](task-breakdown.md)、[旧任务图](task-graph.json)：历史完成与未收口事项，不与本轮同名 ID 混算
- [旧系统调研](evidence.md)：2026-09-05 对旧四个 Worker 的调查，不能直接代表本仓库当前实现
- [9 月 6 日集成审计](integration-audit-2026-09-06.md)、[9 月 8 日集成审计](integration-audit-2026-09-08.md)
- [产品调整](product-adjustments-2026-09-09.md)、[界面调整](ui-redesign-2026-09-09.md)、[不限额策略](unlimited-limits-2026-09-10.md)
- [内置模型目录](builtin-models.md)、[移除默认输出上限](remove-default-output.md)：参考模型信息与历史迁移说明；供应商能力和价格应在使用前重新核对
- [聊天方案](web-chat-plan.md)、[聊天执行记录](web-chat-execution.md)、[聊天交付](web-chat-delivery.md)
- [共享 staging 退役记录](staging-resources.md)、[staging 基础部署证据](evidence/staging-deploy.md)、[聊天验收证据](evidence/web-chat.json)

`docs/evidence/` 中的截图、JSON 和文字记录只证明记录所注明的时间、版本、环境与用例。工作区里的未提交日志路径可能不在其他 checkout 中，不能当作可直接复现的交付文件。

## 文档维护约定

- 功能或路径变化时，优先更新 README、对应使用指南及运行手册
- 修改迁移范围、环境开关、命令或版本号时，对照源码/配置；不改写已发布迁移来让文档“对齐”
- 验收记录写明日期、提交、环境、执行命令、通过/失败/未运行项目，避免只写“全部通过”
- 历史记录追加说明或新证据，不覆盖原始结果；`CHAT-RELEASE` 等发布任务仅在对应环境完成验证后关闭
- 不把密钥、完整请求/响应正文、账户密码或数据库导出放入文档、截图或日志
