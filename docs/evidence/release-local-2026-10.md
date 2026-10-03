# 2026-10 本地集成验证

日期：2026-10-03。对象：本轮实现与文档合并后的本地工作树；检查时本地 HEAD 为 `fbc29084f54fc68e1897354e9bb64fa4cea7a6f8`，功能变更尚在工作树。下文保留初次验证及后续测试清理复验的时间顺序；本证据不代表已部署或通过完整发布验收。

## 工具与边界

- Node `24.19.0`、pnpm `11.19.0`、Vitest `4.1.11`、Wrangler `4.129.0`
- 使用已安装的锁定依赖；未更新依赖或锁文件
- Workers 测试使用本地 D1、KV、Durable Object 与模拟上游；`remoteBindings: false`，测试框架禁止外部上游网络
- Wrangler 日志定向到可写的本地验证目录；关闭使用统计；部署命令均有 `--dry-run`
- 开发和验证分开执行；初次验证单独修订一个过期测试文件，随后按独立任务清理冗余测试并全量复验；这些测试维护任务均未修改生产代码

## 结果

| 检查 | 状态 | 精确结果 |
| --- | --- | --- |
| `pnpm run typecheck` | 通过 | Web、协议包、Worker 类型检查均通过 |
| 初次 `pnpm run test:node` | 通过 | 45 文件，1,859 项通过 |
| 初次 `pnpm run test:workers` | 初次失败，已定点修复并验证 | 144 文件，2,056 项通过、1 项失败；失败源于旧断言仍禁止现在合法的内部逻辑请求 ID |
| `pnpm exec vitest run --project workers tests/limits/client.test.ts` | 修复后通过 | 1 文件，28 项通过；替换旧断言并新增正向契约检查 |
| 清理后 `pnpm exec vitest run --project node` | 全量通过 | 45 文件，1,759 项通过，2.26 秒 |
| 清理后 `pnpm exec vitest run --project workers` | 全量通过 | 144 文件，2,048 项通过，245.61 秒 |
| `pnpm run build` | 通过 | 协议包、Web 构建及 Worker 本地 dry-run 均通过 |
| `pnpm --filter ./apps/worker exec wrangler deploy --env staging --dry-run --outdir <本地输出目录>` | 通过 | 读取 50 个前端资源；Worker 打包 1,211.41 KiB，gzip 227.19 KiB；未部署 |
| `git diff --check` | 通过 | 无空白格式错误 |
| Chromium 浏览器验收 | 未执行成功／环境阻塞 | 前序浏览器任务启动时遭遇 socket EPERM；本次按边界不再重试 |
| 真实 Cloudflare、上游、邮件、容量、恢复与发布验收 | 未运行 | 本次未执行远程资源变更、真实请求或发布 |

初次 Workers 全量运行并非全绿：当时仅修复并重跑失败文件，覆盖数从 2,057 增至 2,058，由全量结果和 28 项定点复测共同支持。随后完成下述测试清理，重新运行完整 Node 与 Workers 项目，最终 189 个文件、3,807 项全部通过；这次是清理后的独立全量结果。

## 初次验证修订：内部逻辑请求 ID 测试契约

`tests/limits/client.test.ts` 仍将 `rate.operationId: 'forged'` 当作非法输入。B03 为同一逻辑请求多次渠道尝试只计一次 RPM，已明确允许可信内部调用方提供合法逻辑请求 ID。旧测试因此调用了返回空值的模拟绑定，得到 `invalid_response`，而非旧预期的 `invalid_input`。

独立测试维护任务只改该文件：将拒绝样例换为含换行的非法 ID；新增合法逻辑 ID 与尝试 requestId 独立、完整转发到绑定的断言。修订后 28 项全部通过。顶层 operationId、调用方时钟、令牌、非法格式仍被拒绝；无需放宽生产校验。

## 后续测试清理与全量复验

按测试职责去重，15 个测试文件共删除 110 个展开用例：Node 从 1,859 减至 1,759，Workers 从 2,058 减至 2,048，总数从 3,917 减至 3,807；另移除重复断言和相同输入行。主要是重复的注册表冒烟矩阵、终止原因别名的目标端重复映射、适配器与原生解析器的重复校验、只断言自身字面量的测试，以及已有更强覆盖的审计路由冒烟测试。

未通过跳过测试、缩小运行范围或将参数表改成循环来降低统计。保留九种协议方向的 JSON/SSE/工具调用及计费契约、鉴权与所有者隔离、取消和租约清理、并发与幂等、账本原子性及失败恢复。按编号执行到各自版本的数据库迁移测试仍保留，不能由当前完整 schema 的集成测试替代。测试数量主要来自协议组合和不同验证分支；本轮没有为凑数量删除独立契约。

## 非阻断提示与剩余门槛

- Vite 提示未来原生配置加载器不支持当前 CommonJS 文件中的 ESM 配置语法；本轮检查成功
- 环境检测到代理变量；未据此改变测试的外部网络禁用规则
- 默认 Worker 构建提示存在多个环境；其命令仅 dry-run。另已显式运行 staging dry-run
- staging 故意没有邮件绑定，且 `EMAIL_VERIFICATION_READY=false`；Wrangler 输出 send_email 不继承提示，不构成真实邮件可用性证据
- 浏览器和真实环境验收尚未关闭，不能声称完整发布就绪。参见[已知问题](../known-issues.md)和[执行计划](../implementation-plan.md)

## 本地日志索引

完整命令日志保存在验证输出目录，未作为项目发布材料提交。文件：`toolchain.log`、`typecheck.log`、`node-tests.log`、`workers-tests.log`、`workers-client-recheck.log`、`build.log`、`staging-dry-run.log`。后续清理另有 `node.log`、`node-results.json`、`workers.log`、`workers-results.json` 和清理摘要。此文仅保留计数、边界和必要诊断，不包含凭据或私密运行日志。
