# 管理控制台浏览器闭环证据（Q11）

检查日期：2026-09-08（Asia/Shanghai）。本证据来自当前 checkout 的一次 [admin.spec.ts](../../tests/e2e/admin.spec.ts) Playwright 浏览器运行，覆盖管理员从登录到管理配置、异常请求调查、账务核对和审计读取的真实页面操作。它只证明本次本地 harness 中这些操作的结果，不代表生产、Cloudflare 远程资源、真实邮件或真实供应商已验收。

## 运行边界

主控提供的 [playwright.config.ts](../../playwright.config.ts) 启动 [start-local-test-server.mjs](../../scripts/start-local-test-server.mjs)：自动构建 `apps/web`，启动仅监听 `127.0.0.1` 的 HTTPS Worker，应用全部 16 个本地 D1 迁移，使用新建本地 D1/DO/KV 状态和一次性管理员。测试使用 [http-test-worker.ts](../../tests/helpers/http-test-worker.ts) 的本地邮件 KV 替身；Worker 侧只允许 `https://e2e-upstream.example.invalid`，所有其他上游域名都会被本地 guard 拒绝。

本次测试没有 `page.route` 管理 API mock。管理 API 的读取和写入均由页面真实提交；测试只使用已登录的 Playwright API context 做 harness 登录、读取断言和发起一次合法网关请求。生成的管理员密码、渠道上游 Key、平台 Key 和控制 token 只存在本地临时 harness/进程内，没有写入仓库或本证据。

## 可复现命令

从工程根目录先按 [toolchain.md](../toolchain.md) 选择 Node.js **24.19.0**、pnpm **11.19.0**，然后运行：

```powershell
$toolchainOriginalPath = $env:Path
Remove-Item Env:PATH -ErrorAction SilentlyContinue
$env:Path = 'C:\Users\a4871\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $toolchainOriginalPath
$env:WRANGLER_SEND_METRICS = 'false'

pnpm.cmd exec playwright test tests/e2e/admin.spec.ts --config playwright.config.ts
```

本次结果：

```text
Running 1 test using 1 worker
ok 1 tests\e2e\admin.spec.ts ... (10.5s)
1 passed (51.6s)
```

`51.6s` 包含一次性 harness 构建、迁移、HTTPS Worker 启动和测试；页面测试本身显示约 `10.5s`。Node 在运行现有 `.ts` bootstrap helper 时可能打印 `MODULE_TYPELESS_PACKAGE_JSON`，以及 Playwright 进程可能提示 `NO_COLOR` 被 `FORCE_COLOR` 覆盖；本次两项均不改变退出码。JSON、trace 和 harness 状态属于本地忽略产物，不作为仓库证据提交。

## 页面操作与结果

| 页面流程 | 真实操作 | 观察到的结果 |
| --- | --- | --- |
| 管理员登录 | 打开 `/login`，填写 harness 管理员凭据并点击“登录” | 跳转 `/dashboard`，主导航显示管理员身份和管理入口 |
| 注册设置 | 打开“注册设置”，将模式从关闭改为开放并保存 | 页面显示“注册设置已保存”，重新渲染为开放模式；生成 `registration.settings.update` 审计 |
| 渠道 | 打开“渠道”，填写名称、HTTPS 基础 URL、合成上游 Key、并发/RPM/优先级并创建 | 列表显示渠道和“已配置（掩码）”，页面没有回显上游 Key；生成 `channel.create` 审计 |
| 模型价格 | 打开“模型”，填写公开模型 ID、准入余额、输出上限以及 input/output 单价并保存 | 列表显示新模型和单价；生成 `model.create` 审计 |
| 模型映射 | 从模型行打开“管理映射”，选择渠道/Chat、填写上游模型和 `streaming` 能力并创建 | 映射列表显示渠道与 Chat 版本；生成 `channel_model.create` 审计 |
| 访问组 | 打开“访问组”，创建新组并在多选框中关联新渠道 | 分组行显示渠道关系；生成 `group.create` 与 attach 记录 |
| 用户 | 打开“用户管理”，通过“创建普通用户”填写合成邮箱、密码和组 | 新用户以普通角色、目标组和零余额出现在列表；生成 `user.create` 审计 |
| 用户设置 | 编辑管理员，将其移入新组并更新并发/RPM；再编辑普通用户为 `3 / 90` | 两行列表显示目标组和更新后的限额；生成 `user.update` 审计 |
| 授额 | 在管理员行打开“余额调整”，提交 `100000000` 最小单位和明确原因 | 页面显示“余额调整已写入”，管理员余额更新；生成 `balance.grant`，账单核对为一致 |
| 平台 Key | 打开 `/keys`，创建继承当前模型权限的 Key，并关闭一次性明文显示 | 页面显示掩码；测试只在内存中使用 bearer，未写入 localStorage 或证据文件 |
| 异常请求 | 使用该 Key 发起合法 Chat 请求；渠道被页面编辑到 harness 拒绝的合成失败域名 | Worker 返回 502；请求已登记为失败/用量未知，没有外部网络调用或供应商响应 |
| 请求调查 | 打开“全局请求”，进入该模型的请求详情 | 列表显示“失败”“用量未知”；详情显示 `upstream_error`，安全结算重试按钮禁用 |
| 账务核对 | 打开“管理账单” | 授额账单显示原因和 `100000000`，余额与追加账单总和显示“一致” |
| 审计 | 打开“管理审计” | 页面读取并显示注册设置、渠道、模型、映射、分组、用户更新和授额等动作；上游 Key 与平台 Key 均未回显 |

异常请求故意在 `sendUpstream` 前后经过本地网络 guard，使用合法请求体而不是伪造管理 API 响应。这样既验证了异常请求能够进入真实管理查询面，也不会把真实供应商或 Secret 当成浏览器验收依赖。

## 证据边界

这次运行验证了管理页面到当前本地 Worker/D1/DO 的操作闭环，并覆盖配置写入、账单追加、余额核对和脱敏审计读取。测试没有切换生产 binding、执行远程 SQL、部署 Worker、读取真实 Secret、发送真实邮件或调用真实上游；真实 Cloudflare、浏览器完整产品和最终一期验收仍由后置任务处理。页面可操作也不代表任务图中尚未完成的其他协议、网关和产品模块已经验收。
