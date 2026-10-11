# 渠道诊断浏览器验证

2026-10-11，针对完整 React 构建，通过系统 Chromium 与现有本地 HTTPS Worker 测试夹具执行。没有修改证书信任；本地测试配置沿用仅针对测试环境的 `ignoreHTTPSErrors`。

## 执行结果

- `tests/e2e/channel-diagnostics.spec.ts`：3/3 通过。
- `tests/e2e/product-corrections.spec.ts`：首轮 16/17 通过；修正诊断步骤的 Tab 定位断言后，仅重跑 `six-character password` 场景，1/1 通过。合计 20 个场景均有通过结果。

命令：

```sh
CHEAPAI_CHROMIUM_EXECUTABLE=/usr/bin/chromium CHEAPAI_E2E_REUSE_BUILD=1 pnpm exec playwright test tests/e2e/channel-diagnostics.spec.ts tests/e2e/product-corrections.spec.ts
CHEAPAI_CHROMIUM_EXECUTABLE=/usr/bin/chromium CHEAPAI_E2E_REUSE_BUILD=1 pnpm exec playwright test tests/e2e/product-corrections.spec.ts --grep 'six-character password'
```

本地 XDG_CONFIG_HOME/XDG_CACHE_HOME 设置在 `/tmp/cheapai-diagnostics-validation`，关闭 Wrangler metrics。首轮日志为该目录的 `browser.log`，复跑日志为 `browser-legacy-rerun.log`。测试服务器每轮创建独立的本地 D1/KV 状态。

## 覆盖和边界

新增场景检查列表/详情入口、键盘切 Tab、选择映射、零隐式请求、单次显式 POST、长正文内部滚动、390px 手机宽度和可见底部操作、复制、占位凭据 cURL、JSON 下载、HTML 纯文本、断线未确认状态和运行中关闭确认。API 由浏览器 fixture 拦截，不会向真实供应商发送请求，也不用于证明预发 Worker 实际执行情况。

旧产品场景仍使用真实本地 Worker 完成登录、渠道和映射配置等流程；其中诊断 POST 使用专用 route fixture，避免向示例 upstream 发送请求。首次失败发生在响应 Tab 中查找结果 Tab 的提示；最终改为校验缺失正文时复制按钮禁用，避免依赖提示文案。

本地 Worker 日志包含 Chromium 首次连接自签证书时的 TLS handshake 警告；测试均能访问页面并执行成功。预发 HTTPS、D1 与真实 provider 错误报告另见预发验证记录。
