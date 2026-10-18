# 文档导航

使用者从[用户指南](user-guide.md)开始；管理员按[管理员指南](admin-guide.md)配置服务；部署和维护参考[部署步骤](deployment.md)、[备份与恢复](backup-restore.md)及[回滚](rollback.md)。

## 使用与运维

- [用户指南](user-guide.md)：注册、登录、网页聊天、API Key 与 API 调用
- [管理员指南](admin-guide.md)、[初始管理员](admin-bootstrap.md)：初始化与渠道、模型、用户管理
- [协议支持矩阵](protocol-support.md)：请求、普通响应与流式转换的字段范围
- [部署步骤](deployment.md)、[Worker 配置清单](worker-environment-inventory.md)：运行时配置、迁移和发布
- [PR 预览](pr-previews.md)、[CI](ci.md)：分支检查、原生 Preview 配置与 main 自动发布
- [备份与恢复](backup-restore.md)、[回滚](rollback.md)：数据恢复和版本兼容
- [真实上游兼容测试](live-compatibility-testing.md)：供应商调用与费用控制
- [已知问题](known-issues.md)：问题与验证记录

## 开发

- [本地开发](development.md)、[工具链](toolchain.md)：安装、启动与检查命令
- [技术方案](architecture.md)：系统设计
- [身份与注册](registration-auth.md)、[计费与 KV](billing-cache.md)
- [协议转换](protocol-compatibility.md)、[协议源码基线](protocol-baseline.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)
- [React 模块边界](frontend-react-module-boundaries.md)、[外观主题](appearance.md)
- [当前校验与接入政策](policy-simplification.md)
- [内置模型目录](builtin-models.md)

## Desktop

- [用户指南](desktop/user-guide.md)
- [架构](desktop/architecture.md)、[DSH 集成](desktop/dsh-integration.md)
- [运行时分发](desktop/runtime-distribution.md)、[发布](desktop/release.md)
- [执行记录](desktop/execution-checkpoint.md)、[实现计划](desktop/implementation-plan.md)、[任务图](desktop/task-graph.json)

## 实现与发布依据

仓库包含 `0001` 至 `0030` 共 30 个 D1 迁移。production 配置见 [wrangler.jsonc](../apps/worker/wrangler.jsonc)；原生 Preview 使用指定的预览 D1/KV，并分配独立 Gate。main 推送触发正式迁移和发布，PR 的 GitHub 检查不执行远程 SQL。

| 内容 | 依据 |
| --- | --- |
| 当前功能、接口和数据结构 | 源码、迁移和对应使用指南 |
| 提交检查结果 | 对应提交的 [Actions](https://github.com/a48zhang/cheapai-service/actions) |
| 已发布版本与数据库结构 | 目标环境的 Worker deployment/version 和 D1 migration list |
| 历史测试结果 | 记录中的提交、日期、环境和用例 |

## 设计与历史记录

以下内容记录当时的方案、任务和验收结果。操作命令以现行使用与运维文档为准。

- [一期目标](phase-1.md)、[实施计划](implementation-plan.md)、[微任务清单](task-breakdown.md)、[任务图](task-graph.json)
- [旧系统调研](evidence.md)、[9 月 6 日集成审计](integration-audit-2026-09-06.md)、[9 月 8 日集成审计](integration-audit-2026-09-08.md)
- [React 设计](frontend-react-design.md)、[开发计划](frontend-react-development-plan.md)、[结构审查](frontend-structure-review.md)、[接口映射](frontend-react-contract-map.md)
- [React 验收](validation/cheapai-react-final.md)、[目录切换](frontend-react-cutover-manifest.md)、[迁移回滚](frontend-react-rollback.md)
- [产品调整](product-adjustments-2026-09-09.md)、[界面调整](ui-redesign-2026-09-09.md)、[不限额策略](unlimited-limits-2026-09-10.md)
- [聊天方案](web-chat-plan.md)、[执行记录](web-chat-execution.md)、[交付记录](web-chat-delivery.md)
- [校验与密码学审计](validation-crypto-inventory.md)、[移除默认输出上限](remove-default-output.md)
- [共享 staging 退役记录](staging-resources.md)、[staging 部署证据](evidence/staging-deploy.md)、[聊天验收证据](evidence/web-chat.json)
- [预览验收汇总](validation/cheapai-preview-summary.md)、[渠道诊断方案](channel-diagnostics-prd.md)、[渠道诊断计划](channel-diagnostics-development-plan.md)

## 维护约定

- 功能、路径或命令变化时，同步入口和使用指南。
- 迁移范围、配置和版本以源码为依据；历史迁移保持原样。
- 验收记录包含提交、日期、环境、命令和结果；后续结果另行记录。
- 截图和 JSON 保留原始证据。未提交的工作区日志路径用于追溯，不能作为仓库中的交付文件。
- 文档和日志不保存密钥、密码、完整请求正文或数据库导出。
