# 2026-10 本地集成验证

日期：2026-10-03。对象：本轮实现与文档合并后的本地工作树；检查时本地 HEAD 为 `fbc29084f54fc68e1897354e9bb64fa4cea7a6f8`，功能变更尚在工作树。本证据不代表已推送、部署或通过完整发布验收。

## 工具与边界

- Node `24.19.0`、pnpm `11.19.0`、Vitest `4.1.11`、Wrangler `4.129.0`
- 使用已安装的锁定依赖；未更新依赖或锁文件
- Workers 测试使用本地 D1、KV、Durable Object 与模拟上游；`remoteBindings: false`，测试框架禁止外部上游网络
- Wrangler 日志定向到可写的本地验证目录；关闭使用统计；部署命令均有 `--dry-run`
- 开发和验证分开执行；最终验证只发现并单独修订一个过期测试文件，没有修改生产代码

## 结果

| 检查 | 状态 | 精确结果 |
| --- | --- | --- |
| `pnpm run typecheck` | 通过 | Web、协议包、Worker 类型检查均通过 |
| `pnpm run test:node` | 通过 | 45 文件，1,859 项通过 |
| `pnpm run test:workers` | 初次失败，已定点修复并验证 | 144 文件，2,056 项通过、1 项失败；失败源于旧断言仍禁止现在合法的内部逻辑请求 ID |
| `pnpm exec vitest run --project workers tests/limits/client.test.ts` | 修复后通过 | 1 文件，28 项通过；替换旧断言并新增正向契约检查 |
| `pnpm run build` | 通过 | 协议包、Web 构建及 Worker 本地 dry-run 均通过 |
| `pnpm --filter ./apps/worker exec wrangler deploy --env staging --dry-run --outdir <本地输出目录>` | 通过 | 读取 50 个前端资源；Worker 打包 1,211.41 KiB，gzip 227.19 KiB；未部署 |
| `git diff --check` | 通过 | 无空白格式错误 |
| Chromium 浏览器验收 | 未执行成功／环境阻塞 | 前序浏览器任务启动时遭遇 socket EPERM；本次按边界不再重试 |
| 真实 Cloudflare、上游、邮件、容量、恢复与发布验收 | 未运行 | 本次未执行远程资源变更、真实请求或发布 |

Workers 的最后一次全量运行不是全绿运行：在该次 143 个文件通过后，仅修复并重跑失败文件，没有重复运行已完成的测试。最终覆盖的用例数为 2,058（原 2,057 加新增 1 项），由全量结果与 28 项定点复测共同支持；不要将此表述为“修复后重新全量通过”。

## 唯一修订：内部逻辑请求 ID 测试契约

`tests/limits/client.test.ts` 仍将 `rate.operationId: 'forged'` 当作非法输入。B03 为同一逻辑请求多次渠道尝试只计一次 RPM，已明确允许可信内部调用方提供合法逻辑请求 ID。旧测试因此调用了返回空值的模拟绑定，得到 `invalid_response`，而非旧预期的 `invalid_input`。

独立测试维护任务只改该文件：将拒绝样例换为含换行的非法 ID；新增合法逻辑 ID 与尝试 requestId 独立、完整转发到绑定的断言。修订后 28 项全部通过。顶层 operationId、调用方时钟、令牌、非法格式仍被拒绝；无需放宽生产校验。

## 非阻断提示与剩余门槛

- Vite 提示未来原生配置加载器不支持当前 CommonJS 文件中的 ESM 配置语法；本轮检查成功
- 环境检测到代理变量；未据此改变测试的外部网络禁用规则
- 默认 Worker 构建提示存在多个环境；其命令仅 dry-run。另已显式运行 staging dry-run
- staging 故意没有邮件绑定，且 `EMAIL_VERIFICATION_READY=false`；Wrangler 输出 send_email 不继承提示，不构成真实邮件可用性证据
- 浏览器和真实环境验收尚未关闭，不能声称完整发布就绪。参见[已知问题](../known-issues.md)和[执行计划](../implementation-plan.md)

## 本地日志索引

完整命令日志保存在验证输出目录，未作为项目发布材料提交。文件：`toolchain.log`、`typecheck.log`、`node-tests.log`、`workers-tests.log`、`workers-client-recheck.log`、`build.log`、`staging-dry-run.log`。此文仅保留计数、边界和必要诊断，不包含凭据或私密运行日志。
