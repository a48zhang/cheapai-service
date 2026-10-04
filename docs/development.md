# cheapai React 本地开发

本文说明最终 React 应用位于 `apps/web` 时的开发入口。所有命令从仓库根目录执行。工具链使用 `.node-version` 与根 `package.json` 锁定的 Node **24.19.0**、pnpm **11.19.0**。

## 1. 安装与集中检查

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile --strict-peer-dependencies --registry=https://registry.npmjs.org
```

React 工作区的定点命令：

| 命令 | 内容 |
| --- | --- |
| `pnpm --filter @cheapai/web run typecheck` | React 应用 TypeScript 检查 |
| `pnpm --filter @cheapai/web run test` | React 应用 Vitest 测试 |
| `pnpm --filter @cheapai/web run build` | React 类型检查与 Vite 构建 |
| `pnpm exec vitest run --project react` | 单独运行 React Vitest 项目 |
| `pnpm exec vitest run --project node` | 单独运行 Node 项目 |
| `pnpm exec vitest run --project workers` | 单独运行 Workers 项目 |
| `pnpm run typecheck` | 检查所有 workspace 类型 |
| `pnpm run test` | 集中运行 React、Node 和 Workers Vitest 项目 |
| `pnpm run build` | 构建 workspace；Worker 使用 Wrangler dry-run，不会发布 |
| `pnpm run check` | 依次运行 typecheck、完整 Vitest 与 build，失败即停止；不含浏览器测试 |
| `pnpm exec playwright test` | 使用独立临时数据库与测试 Worker 运行浏览器端到端测试 |

截至 2026-10-03，完整 Vitest **198 个文件、3,847 项测试**、工作区类型检查、生产构建、Worker dry-run 与 React lint 已通过。同源 HTTPS 开发代理的登录、CSRF、Secure Cookie 和增量 SSE 已通过本地烟雾检查。37 项浏览器用例已覆盖通过：完整运行 35 项通过，剩余 2 项修正定位后定点通过；完整结果见[验收记录](validation/cheapai-react-final.md)。Playwright 需先安装 Chromium：

```sh
pnpm exec playwright install chromium
```

## 2. React 与本地 Worker 联合开发

`node scripts/start-react-dev.mjs` 同时启动 Vite 和本地 Wrangler Worker。React 页面使用 HTTPS，Worker 仅监听本机 HTTP；Vite 把浏览器发出的相对 `/api` 请求转发到 Worker，不需要为浏览器配置跨域 API 地址。

1. 为 `127.0.0.1` 准备由本机信任的 HTTPS 证书。证书需要包含 `127.0.0.1` 的 IP subject alternative name。将示例复制到忽略的本地文件，并填写证书与私钥路径：

```sh
cp apps/web/.env.example apps/web/.env.local
```

`.env.local` 支持以下设置。证书路径可为绝对路径，也可相对 React 应用目录；端口是可选项。

```dotenv
CHEAPAI_WEB_TLS_KEY_FILE=/path/to/127.0.0.1-key.pem
CHEAPAI_WEB_TLS_CERT_FILE=/path/to/127.0.0.1-cert.pem
CHEAPAI_WEB_PORT=5173
CHEAPAI_WORKER_PORT=8787
```

默认地址为 `https://127.0.0.1:5173`，本地 Worker 使用 `http://127.0.0.1:8787`。启动脚本按 Web 端口设置 Worker 的 `PUBLIC_BASE_URL`，生成临时 Wrangler 配置，并把现有 `apps/worker/.dev.vars` 安全地复制到本次运行目录。退出后临时配置会清理；本地 D1 状态保留在 `.wrangler/cheapai-react-dev/state`。启动脚本不会迁移数据库或创建管理员。

2. 首次启动前，将 D1 迁移应用到同一个本地状态目录；需要登录时，再通过受保护的交互式引导创建首个管理员：

```sh
node apps/worker/node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --config apps/worker/wrangler.jsonc --local --persist-to .wrangler/cheapai-react-dev/state
node scripts/bootstrap-admin.ts --local --persist-to .wrangler/cheapai-react-dev/state
```

引导脚本只创建第一个管理员，不会重置已有账户；密码在交互终端中输入且不回显。初始管理员余额为零。不要对真实环境使用本地参数，也不要将生产 Secrets 复制到本地。

3. 启动两个本地服务：

```sh
node scripts/start-react-dev.mjs
```

浏览器应使用 `https://127.0.0.1:<CHEAPAI_WEB_PORT>` 访问。证书必须被浏览器信任；`localhost` 与 `127.0.0.1`、HTTP 与 HTTPS 都是不同 origin。修改 Web 端口后，启动脚本会同步更新 Worker 的可信 `PUBLIC_BASE_URL`。

如需连接本地或模拟上游渠道，在被忽略的 `apps/worker/.dev.vars` 中配置 `CHANNEL_KEYRING_JSON` 与 `CHANNEL_ACTIVE_KEY_VERSION`。Keyring 是版本到 canonical Base64 32 字节 AES key 的 JSON 对象；邮件能力默认关闭。详细格式见[部署配置](deployment.md#4-环境值和-secrets)。不要把密钥、证书或 `.env.local` 提交到 Git。

### 相对 API、HTTPS 与认证兼容

浏览器调用 `/api/v1/...` 相对路径。Vite 代理 `/api` 时保留浏览器的 `Origin`、Cookie 与 `X-CSRF-Token`，并将 SSE 响应保持为流；前端生产构建由 Worker 同源提供。开发服务器只绑定 `127.0.0.1`，不得把代理作为公网入口。

认证与令牌格式保持服务端兼容：

- 会话 Cookie 仍名为 `__Host-sub2api_session`，使用 `Secure; HttpOnly; Path=/; SameSite=Lax`。浏览器不读取或写入会话令牌，也不把会话存进 localStorage。
- CSRF Cookie 仍名为 `__Host-sub2api_csrf`，由同源浏览器代码读取并通过 `X-CSRF-Token` 回传。所有管理写请求（包括登录和注册）都要求 HTTPS origin 与双提交 CSRF 值匹配。
- `/v1` 平台 Key 继续使用 `s2a_key_` 前缀；会话与邀请码令牌分别保留 `s2a_session_` 和 `s2a_invite_` 前缀。这些是兼容标识，界面品牌统一为 cheapai。

如果写请求返回 403，先核对访问 origin、TLS 证书、服务端 `PUBLIC_BASE_URL`、CSRF Cookie 和请求头；不要通过关闭 Secure Cookie 或 CSRF 检查来规避问题。

## 3. 浏览器端到端测试

浏览器测试启动独立的测试 Worker、D1 状态和 React 构建，不会连接本地开发数据库或真实上游。运行前安装浏览器，然后执行：

```sh
pnpm exec playwright install chromium
pnpm exec playwright test
```

测试服务通过 `scripts/start-local-test-server.mjs` 创建新的 `.wrangler/e2e/run-*` 状态、应用迁移并初始化测试管理员；上游和邮件使用模拟服务。默认地址是 `https://127.0.0.1:9789`，可用 `SUB2API_E2E_PORT` 选其他本机端口。Playwright 忽略该隔离环境的测试证书错误，不代表生产 TLS 配置。测试控制路由只存在于测试 Worker，绝不能部署到生产。

浏览器未启动、用例被跳过或只启动了本地服务都不计为通过。若 Chromium 提示缺少系统依赖，应根据 Playwright 报错补齐；不要用 Node 测试代替浏览器验收。

## 4. 故障排查与边界

| 现象 | 先检查 |
| --- | --- |
| Vite 页面正常但 API 报错 | 使用 `scripts/start-react-dev.mjs` 同时启动 Worker；单独 Vite 不提供完整登录链路 |
| 登录或注册写请求 403 | 浏览器 origin、HTTPS 证书、Worker 的 `PUBLIC_BASE_URL` 和 CSRF Cookie/header 是否一致 |
| 页面没有可用模型或提示余额不足 | 配置渠道、映射、分组关联与用户授权，并由管理员授额；默认账户余额为零 |
| 应用提示找不到资源或数据库表 | 在启动前检查 `DB` 迁移是否应用到 `.wrangler/cheapai-react-dev/state` |
| 本地渠道无法解密 | 检查 `.dev.vars` 中活动 keyring 版本和对应 32 字节 AES key，不使用占位值 |
| Worker 正常但邮件未送达 | 本地邮件 binding 不提供真实投递；邮件服务就绪状态与本地连通性需分别处理 |

开发任务按完整功能模块集中执行测试。完整验收需分别记录 React/Worker 测试、类型检查、构建、浏览器与真实云端结果；局部结果不能替代其他项目。
