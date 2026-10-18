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
- [已知问题](known-issues.md)：功能限制与排查入口

## 开发

- [本地开发](development.md)、[工具链](toolchain.md)：安装、启动与检查命令
- [身份与注册](registration-auth.md)、[计费与 KV](billing-cache.md)
- [协议转换](protocol-compatibility.md)、[协议源码基线](protocol-baseline.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)
- [React 模块边界](frontend-react-module-boundaries.md)、[外观主题](appearance.md)
- [接入政策](policy-simplification.md)、[前端接口映射](frontend-react-contract-map.md)
- [内置模型目录](builtin-models.md)

## Desktop

- [用户指南](desktop/user-guide.md)
- [架构](desktop/architecture.md)、[DSH 集成](desktop/dsh-integration.md)
- [运行时分发](desktop/runtime-distribution.md)、[发布](desktop/release.md)

## 维护

功能、路径或命令变化时同步使用指南。迁移、配置和版本以源码为依据；提交检查结果见 [Actions](https://github.com/a48zhang/cheapai-service/actions)。发布时按[部署步骤](deployment.md)核对目标环境、Worker 版本和 D1 迁移水位。
