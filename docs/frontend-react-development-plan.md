# cheapai React 重构开发计划

状态：React 实现、目录切换与本地验收均已完成。本文保留原始 127 项任务拆分供追溯，并记录各完整模块的交付状态。汇总证据见[最终集中验证报告](validation/cheapai-react-final.md)。设计依据为 [前端设计规格](frontend-react-design.md)，视觉依据为用户认可的 [cheapai 三屏稿](design/cheapai-panels.png)。

## 当前实现进度（2026-10-03）

各首期模块均已交付并完成本地验收：

| 模块 | 已交付范围 | 状态 |
| --- | --- | --- |
| 基础设施与身份 | React shell、design system、contracts/API client、session/auth、路由与安全返回 | 本地验收完成 |
| 个人控制台 | Dashboard、API keys/once-secret、请求列表与详情、账单 | 本地验收完成 |
| Chat | 会话历史、草稿、流式 controller、composer、停止与恢复 | 本地验收完成 |
| 资源管理 | Channels、models、mappings、groups 与实体详情 | 本地验收完成 |
| 管理运营 | Users/余额、请求与详情、账单/对账、registration/codes、audit | 本地验收完成 |
| 目录切换与整合 | React 已在正式 `apps/web` workspace；Vue 完整归档到 `/workspace/cheapai-legacy-archive/react-cutover/apps-web`；CI/preview/Worker 路径已切换 | 本地验收完成 |

本地验收摘要（完整证据与边界见[最终集中验证报告](validation/cheapai-react-final.md)）：全量 Vitest 为 198 个文件、3,847 项通过，另有 2 项新增 Key 用例通过，累计覆盖 3,849 项；最新 main 的 workspace typecheck、build、Worker dry-run、React lint 和 PR preview self-test 均通过；React 定点测试 8 个文件、35 项通过。浏览器共覆盖 37 项：首轮 35 项通过，之后对剩余两项管理链定点复跑 2/2 通过，合并证据覆盖全部 37 项；这不表示曾有单次 37/37 全通过运行。未执行生产发布。

任务总数：**127 项**，包括 107 个实现任务、12 个必要测试编写/迁移任务、2 个目录搬迁任务、6 个集中验证任务。常规任务均限定为 1–3 个文件；目录搬迁是两项已说明原因的例外。

## 0. 必须遵守的执行规则

1. 实现任务 `I-*`、测试编写任务 `T-*`、目录迁移任务 `M-*` **不运行测试、类型检查、lint、构建、浏览器巡检或其他验证命令，也不将这些操作作为前置或完成条件**。依赖仅表示需要前一任务交付的代码或接口。必要的依赖安装与锁文件生成由指定依赖任务完成，不顺带执行检查。安装内置的签名、TLS、锁文件完整性与供应链校验保留，不能为了禁止测试而关闭它们。
2. 测试执行和人工/自动验证只发生在 `V-*` 集中任务中，且对应整个模块或业务链路已经实现。普通任务不依赖某个 V 任务的“通过”。协调者记录 V 发现的问题，归并后分派修复，再对受影响模块集中复跑一次；不逐个修复跑全量。
3. 默认一个任务只修改表内列出的 **1–3 个文件**，读取其他文件不限。新增文件、删除文件、重命名源/目标、锁文件都属于写集；同一文件的增删合计仍按一个路径计算。禁止把路径缩写理解为允许修改整个目录；表内每个文件名都是确切目标。
4. 单个文件也不能变成巨型任务：只实现“具体工作”列的能力；未列出的邻近功能交给其他任务。需要额外文件时，由协调者拆出新任务并补依赖，不能自行扩写公共模块。
5. 仅最终目录搬迁、旧应用删除有必要的多文件例外，分别在 M 任务说明原因与清单来源。依赖安装造成的受控生成目录不计为源码文件；不得提交缓存、密钥、测试数据和构建产物。
6. 同一文件同时只有一个 owner。公共路由、Provider、package.json、lockfile、测试配置和脚本均串行修改；开发者提交所需接口说明，不争抢公共文件。不同文件也须遵守模块依赖方向。
7. 每次派发一个任务或一条短的顺序任务链；subagent 只交付该任务。无需每个任务创建 PR、提交或执行 git 操作；整合节奏由协调者负责。现有 cloud checkout 已隔离，不另建 worktree，除非用户要求。
8. 测试只为真实行为风险增加：幂等、身份隔离、金额精度、协议解码、流式状态、分页完整性、权限和复杂编辑。优先迁移现有覆盖。**不增加文案逐字比较、class/DOM 结构快照、整页大快照、颜色像素精确比较、getter/setter 镜像测试。**
9. 所有用户可见品牌使用小写 **cheapai**，示例邮箱用 `alex@cheapai.dev`。浏览器标题、错误页、加载页、邮件或服务端返回中可能展示的文案也纳入最终界面盘点。兼容 Cookie 名、API Key 前缀、数据库与云资源名不做品牌式替换；它们是协议/部署标识，不作产品标题显示。
10. 已有实现必须保留的业务语义：Secure Cookie/CSRF、身份 epoch、分页 cursor、配置 version、幂等 operationId、金额整数字符串、执行/计费双状态、SSE 与停止/恢复、密钥仅展示一次。前端重构不改变计费算法、上游网关协议或数据库结构。

### subagent 任务交付模板

```text
任务：I-xxx
依赖：只列代码产物 ID，不写“先测试通过”
可改文件：复制本任务的确切写集
具体工作：复制本任务内容，携带相关公共契约摘要
最终状态：复制本任务最终状态
交付回复：改了哪些文件；提供什么导出/行为；已知未完成项
执行限制：不运行测试/检查/构建/浏览器验证；不扩写写集
```

完成状态按“待分配 / 实现中 / 代码已交付 / 存在阻塞”记录。代码已交付不等同于集中验证结果；验证结果由 V 任务单独记录。依赖缺失时报告所缺导出或字段，继续完成写集内不依赖它的部分。

## 1. 范围、命名和固定契约

### 首期范围

- 完成聊天、个人控制台、管理控制台与身份异常页的 React 等价迁移，以及已认可的视觉设计。
- 为渠道、模型、访问组、用户详情深链补必要的单项 GET；复用现有读取函数/投影与权限规则，无 D1 migration。
- 暂不实现用量聚合图表、实时渠道健康看板、会话全库搜索、自助支付、OAuth、上传/语音。前端不提供尚不存在的入口，不以当前页估算全量统计。
- 当前 React 应用位于正式路径 `apps/web`，workspace 包名为 `@cheapai/web`；旧 Vue 应用归档在 `/workspace/cheapai-legacy-archive/react-cutover/apps-web`，不属于 workspace。
- `@cheapai/contracts`、`@cheapai/api-client` 提供浏览器安全子路径导出，例如 `@cheapai/contracts/auth`、`@cheapai/api-client/client`、`@cheapai/api-client/chat-stream`；不要求另建每包大 barrel。任务表中有关旧 Vue 实现的描述仅为迁移行为来源记录。

### 文件缩写

原始任务表的迁移期缩写为 `N/` = `apps/web-next/`、`W/` = `apps/web-next/src/`、`C/` = `packages/contracts/`、`A/` = `packages/api-client/`、`B/` = `apps/worker/`。`N/` 和 `W/` 是历史分派写集；对应代码现位于 `apps/web/` 和 `apps/web/src/`。其他未用缩写的路径相对仓库根目录。

### 公共接口约定

- 契约文件使用 Zod schema 作为浏览器 DTO 的唯一类型来源，导出推导类型和 `decodeX` 适配器；保留当前对合法/非法数据的语义。不是顺便重写 Worker 输入校验。
- `createApiClient({ fetch, getCsrfToken, captureIdentity, onUnauthorized })` 依赖注入；返回 get/post/put/patch/delete。跨包不导入应用的 session 单例。
- session 控制器导出 `getSnapshot/subscribe/restore/login/logout/expire`；身份用 `{ userId, epoch }`。401 仅失效发起该请求的身份，网络故障进入 unavailable。
- feature 的 `api.ts` 导出 query options/mutation 函数，组件不直接拼 URL；写入默认不自动重试。
- feature 组件由 props 接收操作和状态，页面负责组合。按明确文件路径导入，不依赖多人维护的巨大 barrel。
- Query key 至少含用户与 personal/admin 范围；logout/换号清缓存并取消请求。API Key、邀请码明文不进 Query/mutation 长生命周期缓存或开发工具记录。
- Controller 管活动流，Query 管持久化快照；按消息 ID/version 合并。回调携带 operationId，旧操作不能覆盖新操作。
- 主列表 cursor 分页不引入虚构 total/pageCount；筛选仅使用后端允许字段。状态码/协议字段/精度等字符串可以有精确契约断言，禁止的是把可变显示文案当业务行为。
- 不将测试中的固定 timeout、真实供应商、共享账户或联网请求带入新测试。浏览器使用仓库的隔离 D1/模拟上游；一个测试服务同一时刻只由一个验证任务使用。

## 2. 阶段与并行分配

| 批次 | 交付模块 | 可并行 lane | 集中任务 |
| --- | --- | --- | --- |
| A | 骨架、通信、身份、设计系统 | 依赖/工具链；契约；基础 UI；身份 | V-01 身份完整链路 |
| B | 个人控制台 | 请求；账单；API 接入；概览 | V-02 个人控制台 |
| C | 聊天 | 历史/草稿；controller；消息/输入 UI | V-03 聊天完整链路 |
| D | 管理资源配置 | 详情 GET；渠道；模型映射；访问组 | V-04 资源配置完整链路 |
| E | 管理运营 | 用户授额；注册；全局记录与审计 | V-05 管理运营完整链路 |
| F | 归位、清理与发布准备 | 协调者串行目录切换；文档与 CI 按文件 owner | V-06 最终一次全量 |

这不是要求批次完全串行。B/C 的无写集冲突任务可在身份代码交付后并行，D/E 的契约和 UI 也可提前；V 严格等对应完整模块交付。只保留一个安装/锁文件 owner 和一个测试执行 owner，避免重复构建、多个 workerd/浏览器同时占用资源。最多按实际可用槽位分派，优先 3–4 条功能 lane。

以下依赖列为直接依赖，传递依赖自动成立。`a–b` 表示闭区间全部任务；加号表示并集。每行都是独立可派发任务，默认写集不超过三个文件。

## 3. 基础设施与设计系统任务

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-001 | 无 | `docs/frontend-react-contract-map.md` | 依据现有客户端和路由，记录每个页面用到的 endpoint、输入、DTO、权限、version/idempotency、可用筛选；列出 4 个新增详情 GET。只读代码，不执行检查。 | 文档成为契约任务的字段依据，未知字段显式列出，不能靠 UI 猜测。 |
| I-002 | I-001 | `C/package.json`；`C/tsconfig.json`；`A/package.json` | 建两个 ESM 私有包；提供类型与子路径 exports，contracts 依赖 Zod，api-client 依赖 contracts；规定 typecheck 脚本与浏览器安全入口。 | 两包身份和导入方式固定，无应用层依赖。 |
| I-003 | I-002 | `A/tsconfig.json`；`N/package.json`；`N/tsconfig.json` | 配置 React/ReactDOM/类型包、Vite React/Tailwind 插件、router、Query/Table、RHF/Zod、Radix、Lucide、Markdown；同时固定 RTL、DOM 环境、ESLint/React Hooks 插件依赖；固定兼容版本，建立 dev/build/typecheck/test 脚本。 | 新应用包名为 `@cheapai/web`，依赖与 TS 编译边界明确。 |
| I-004 | I-003 | `pnpm-workspace.yaml`；`package.json`；`pnpm-lock.yaml` | 加入三个 workspace；根提供明确的 React 命令和共享包测试依赖；集中安装、生成锁文件，保留供应链/校验策略。不得调用 check/build/test。 | 新包可由 workspace 解析，唯一锁文件与清单一致。 |
| I-005 | I-003 | `N/vite.config.ts`；`N/index.html`；`W/main.tsx` | 配置 React/Tailwind，HTML 标题 cheapai；main 挂载 StrictMode 与待交付 App；Vite dev 使用指定本地可信证书；`/api` 代理到仅绑定 loopback 的 HTTP Wrangler，原样转发 Origin/Cookie/CSRF 并关闭流式缓冲；证书/端口来自本地配置。 | 浏览器入口和开发代理结构完成，API 路径保持现有同源契约；不启动服务器。 |
| I-006 | I-003 | `N/vitest.config.ts`；`W/test/render.tsx`；`W/test/setup.ts` | 建 DOM 测试配置与最小 provider helper，固定每个用例新 QueryClient、关闭测试自动重试、卸载后清理。 | React 用例具备隔离基础，无测试执行。 |
| I-007 | I-006 | `vitest.config.ts` | 根配置增加名为 `react` 的 project，包含新应用 `src/**/*.test.{ts,tsx}`，保留 node/workers 原有 include；防止重复收集。 | 根测试入口能表达三项目边界，不执行收集或测试。 |
| I-008 | I-003 | `N/eslint.config.js`；`docs/frontend-react-module-boundaries.md` | 配置必要的 React Hooks、受限跨层 import 与 public API 规则；写明允许依赖图。不引入格式化全仓任务。 | feature 不依赖其他 feature 内部、shared 不依赖 pages/Worker 的规则有配置。 |
| I-009 | I-001 | `W/shared/styles/tokens.css`；`W/shared/styles/base.css`；`W/shared/brand.ts` | 实现认可的颜色/字号/间距/圆角，基础焦点/缩放/reduced-motion；集中 cheapai 名称与产品元信息。 | 视觉与品牌由统一 token/常量表达。 |
| I-010 | I-003 + I-009 | `W/shared/ui/Button.tsx`；`W/shared/ui/Input.tsx`；`W/shared/ui/Field.tsx` | 按统一规格实现按钮、输入、字段 label/error/description；支持 busy/disabled 与 aria 关系。 | 页面可以组合表单，无业务请求或财务逻辑。 |
| I-011 | I-010 | `W/shared/ui/Dialog.tsx`；`W/shared/ui/Sheet.tsx`；`W/shared/ui/ConfirmAction.tsx` | 采用 Radix 实现弹窗/侧栏、焦点恢复与移动全屏；确认组件由调用者提供动作。 | 简单编辑和危险操作共用交互骨架。 |
| I-012 | I-010 | `W/shared/ui/Select.tsx`；`W/shared/ui/Tabs.tsx`；`W/shared/ui/DropdownMenu.tsx` | 封装键盘可用选择器/标签页/菜单，不复制组件库底层焦点逻辑。 | 基础交互统一、接口足够供页面使用。 |
| I-013 | I-009 | `W/shared/patterns/AsyncState.tsx`；`W/shared/patterns/PageHeader.tsx`；`W/shared/ui/StatusBadge.tsx` | 提供加载/空/错误/保留旧数据的呈现、页面标题与带文字状态标签。 | 失败、无数据和刷新可分别呈现，文案由 feature 提供。 |
| I-014 | I-003 + I-013 | `W/shared/patterns/CursorTable.tsx`；`W/shared/patterns/DetailPanel.tsx`；`W/shared/patterns/FilterBar.tsx` | 表格接受行、列、cursor 状态及加载下一批回调；详情可侧栏或全页；筛选条只负责排版。 | 通用骨架不推断总页数、不自行拼接请求、不含业务 CRUD 配置。 |
| I-015 | I-001 | `W/shared/lib/money.ts`；`W/shared/lib/datetime.ts`；`W/shared/lib/return-path.ts` | 迁移现有精确金额显示与 safeReturnPath；统一时区/日期格式。保留整数/十进制字符串，禁止浮点金额计算。 | 三个独立工具提供纯函数 API，安全回跳规则得到保留。 |
| I-016 | I-011 + I-013 | `W/shared/ui/Toast.tsx`；`W/shared/patterns/ApiErrorNotice.tsx` | 统一短成功反馈与错误/重试/requestId 展示；只显示脱敏服务端错误。 | 页面可以选择就地反馈或 Toast，不重复弹多份身份错误。 |
| I-017 | I-005 | `scripts/start-react-dev.mjs`；`N/.env.example` | 编写本地启动编排：从 `@cheapai/web` 实际 workspace 路径解析应用根，读取用户指定证书路径，使用相同 PUBLIC_BASE_URL 启动 HTTPS Vite 和 loopback HTTP Worker；缺证书报告具体配置，保护现有 .dev.vars，子进程退出时清理自己启动的进程。仅编写，不执行。 | React 热更新开发流程有单一入口，数据仍用既定本地 D1 状态；没有关闭 TLS 校验或修改 Cookie 属性。 |

## 4. API 与契约任务

领域契约任务必须依据 I-001 和当前实现。每项只覆盖列出的领域，保留 camelCase/snake_case 的真实边界，不顺手修改服务端字段。为了分派清楚，将模型和模型映射分开。

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-020 | I-002 + I-001 | `C/src/common.ts`；`A/src/types.ts`；`A/src/errors.ts` | 定义响应 envelope、cursor、requestId、错误结构及 fetch 注入接口；迁移 ApiClientError 分类。 | 所有领域共用基础契约，无 React/Vue 依赖。 |
| I-021 | I-020 | `A/src/url.ts`；`A/src/csrf.ts` | 迁移 API 路径编码与防穿越规则、受限模型 ID 编码例外和 CSRF cookie 读取；Cookie 协议名保持兼容。 | 通信核心可调用路径与 CSRF helpers，外部 URL 不被当作内部 API。 |
| I-022 | I-021 | `A/src/client.ts` | 实现请求/取消/envelope 解码、identity capture 和 401 回调；写入不隐式重试；保留 non-JSON/网络/中止错误区分。 | injectable client 提供各领域需要的方法，完全不 import 应用 session。 |
| I-023 | I-022 | `C/src/auth.ts`；`A/src/auth.ts` | 迁移公开设置、身份、登录/退出、注册和发验证码；保留 bootstrap 合并、CSRF、验证码重发语义。 | 一个 auth API factory 覆盖当前 auth/registration 客户端能力。 |
| I-024 | I-022 | `C/src/account.ts`；`A/src/account.ts` | 迁移账户余额 DTO 与读取。 | 余额单位和精度原样传输，无统计伪数据。 |
| I-025 | I-022 | `C/src/keys.ts`；`A/src/keys.ts` | 迁移可授权组、Key 列表/详情/创建/编辑/撤销；created 与 replayed 分支明确。 | 新 Key 明文只在 created 结果存在，操作 ID 与 version 保留。 |
| I-026 | I-022 | `C/src/requests.ts`；`A/src/requests.ts` | 迁移个人/全局请求 DTO、双状态、usage semantics、价格快照和列表/详情 API；保留精确字段校验。 | 个人和管理查询共享 DTO，但调用路径与权限范围明确。 |
| I-027 | I-022 | `C/src/billing.ts`；`A/src/billing.ts` | 迁移个人/管理账本分页；精确传输所有金额和类型。 | 请求费用与账本变动不混合，null 不被转成 0。 |
| I-028 | I-022 | `C/src/chat.ts`；`A/src/chat.ts` | 迁移会话/消息/版本/模型组与会话 CRUD，定义发送和再生成的输入/事件 schema；流读取交给 I-029。 | 非流 chat API 和事件契约可被 controller 使用。 |
| I-029 | I-028 | `A/src/chat-stream.ts` | 迁移 fetch SSE parser，处理跨 chunk/UTF-8、事件解码、401、abort、结束和断流；暴露 typed 回调。 | 流适配层保留 POST/Cookie/CSRF，独立于 React 和业务状态机。 |
| I-030 | I-022 | `C/src/channels.ts`；`A/src/channels.ts` | 迁移渠道列表/写入/探测，声明详情 get；密钥只写，limits 的 null/无限制语义依据 Worker 真实契约。 | 渠道 API 包含 version/探测版本和成本事实，不泄露密钥。 |
| I-031 | I-022 | `C/src/models.ts`；`A/src/models.ts` | 迁移模型目录/价格 CRUD 与详情 get；明确价格版本和计费 bucket。 | 模型 schema 与精确价格字段固定。 |
| I-032 | I-031 | `C/src/mappings.ts`；`A/src/mappings.ts` | 迁移渠道映射/能力和创建编辑 API；保持协议、channelId 和 mapping version。 | 映射是独立 API，模型包不形成循环依赖。 |
| I-033 | I-022 | `C/src/groups.ts`；`A/src/groups.ts` | 迁移访问组列表/创建/更新与详情 get；保留倍率字符串、关联 channelIds。 | 访问组契约适用于 API 授权与管理页面。 |
| I-034 | I-023 | `C/src/users.ts`；`A/src/users.ts` | 迁移用户列表/新增/修改/详情、余额操作与管理撤销 Key；保留权限、version、operationId。 | 用户管理 factory 具备当前接口能力，余额写入不自动重试。 |
| I-035 | I-023 | `C/src/registration-admin.ts`；`A/src/registration-admin.ts` | 迁移注册策略与邀请码批次，区分初次返回明文和重放元数据。 | 策略版本、邮件可用性、批次状态与一次性明文表达完整。 |
| I-036 | I-026 | `C/src/audit.ts`；`A/src/audit.ts`；`A/src/settlements.ts` | 迁移审计分页与结算重试客户端，沿用实际结算响应字段。 | 两个操作入口独立于展示层，结算写入仅显式触发。 |

## 5. 应用壳与身份任务

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-040 | I-023 | `W/features/session/controller.ts` | 从旧 session store 提取框架无关控制器，实现 unknown/authenticated/anonymous/unavailable、epoch 与异步竞态。 | 身份状态只有一个权威来源；旧请求不能改变新会话。 |
| I-041 | I-040 | `W/shared/api/runtime.ts`；`W/shared/api/query-client.ts` | 组装 API client 与 session 回调；提供身份范围的 QueryClient、分类重试与身份切换取消/清理。 | 通信、会话和 Query 连接完成，无 client→React 循环。 |
| I-042 | I-041 + I-016 | `W/features/session/SessionProvider.tsx`；`W/features/session/useSession.ts`；`W/app/providers.tsx` | 用 useSyncExternalStore 订阅身份；Provider 注入 Query/Session/Toast，管理初始化生命周期。 | React 可消费稳定 snapshot；StrictMode 不重复发起业务写入。 |
| I-043 | I-042 + I-015 | `W/app/guards/SessionBoundary.tsx`；`W/app/guards/AdminBoundary.tsx`；`W/pages/auth/SessionUnavailablePage.tsx` | 区分身份未知、过期、服务不可用与非管理员；实现安全 returnTo 和恢复身份。 | 守卫分别呈现登录回跳、403、身份重试，不把 5xx 视为退出。 |
| I-044 | I-010 + I-023 + I-042 | `W/features/session/LoginForm.tsx`；`W/pages/auth/LoginPage.tsx`；`W/app/layouts/AuthLayout.tsx` | 登录表单、字段反馈、提交锁与成功回跳，使用 cheapai 品牌。 | 登录页通过 controller 完成身份更新。 |
| I-045 | I-044 | `W/features/session/RegisterForm.tsx`；`W/features/session/VerificationCodeField.tsx`；`W/pages/auth/RegisterPage.tsx` | 按公开策略显示邀请码/验证码；重发倒计时依据返回值，处理关闭注册与邮件不可用。 | 注册流程覆盖现有策略，不新增密码找回/OAuth 假入口。 |
| I-046 | I-009 + I-012 + I-042 | `W/app/navigation.ts`；`W/app/layouts/ConsoleLayout.tsx`；`W/app/layouts/AdminLayout.tsx` | 实现个人/管理独立导航、工作区切换、移动抽屉与账户退出。 | 导航显式按角色展示，布局可承载页面。 |
| I-047 | I-043–I-046 + I-005 | `W/app/router.tsx`；`W/app/App.tsx`；`W/pages/NotFoundPage.tsx` | 接入已完成身份页和布局，配置 router fallback/error boundary；未交付功能暂不挂空占位路由。 | 应用入口、身份链路及错误边界组成可集成的模块。 |
| I-048 | I-003 | `scripts/start-local-test-server.mjs`；`playwright.config.ts` | harness 增加 `CHEAPAI_WEB_ROOT` 受限应用根选择 `apps/web`/`apps/web-next`，构建改用选中包脚本；显式支持仅本批已构建产物的 `CHEAPAI_E2E_REUSE_BUILD=1`；React suite 可指定系统 Chromium，输出报告分开。默认既有流程保留，凭据不输出。 | 后续 V 可选择 React 真正产物；不在该任务启动服务或浏览器。 |

## 6. 个人控制台任务

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-050 | I-026 + I-041 | `W/features/request-history/api.ts`；`W/features/request-history/filters.ts` | 构建 personal/admin 范围 query options、cursor/filter URL 状态与详情查询；只接受实际支持参数。 | 切换筛选清 cursor，个人/管理缓存隔离。 |
| I-051 | I-026 + I-015 + I-013 | `W/features/request-history/RequestStatus.tsx`；`W/features/request-history/UsageBreakdown.tsx`；`W/features/request-history/PriceSnapshot.tsx` | 展示执行/结算状态、usage 子集语义、精确费用与价格快照。 | unknown、pending、null 有独立呈现，不重复加算 Token。 |
| I-052 | I-050 + I-051 + I-014 | `W/features/request-history/RequestTable.tsx`；`W/pages/requests/RequestsPage.tsx`；`W/pages/requests/RequestDetailPage.tsx` | 实现个人请求列表、筛选和可直达详情，保留返回列表的条件。 | 认可稿的列表与详情结构接上真实 query。 |
| I-053 | I-027 + I-041 + I-014 + I-015 | `W/features/billing/api.ts`；`W/features/billing/BillingTable.tsx`；`W/pages/billing/BillingPage.tsx` | 实现个人账本分页、支持的筛选及相关请求链接；使用金额工具。 | 账单按服务端账本呈现，不从请求估算余额。 |
| I-054 | I-025 + I-041 | `W/features/api-access/api.ts`；`W/features/api-access/key-operation.ts` | key queries 与 created/replayed 操作控制；保存原 operationId 处理结果不明，明文走组件短生命周期通道。 | token 不进入 Query/mutation cache，重放不声称能再次显示明文。 |
| I-055 | I-054 + I-011 | `W/features/api-access/KeyForm.tsx`；`W/features/api-access/KeySecretDialog.tsx` | 实现创建/编辑表单、组授权和过期时间，明文展示/复制/关闭销毁。 | 表单保持已有 API 能力，关闭或换号销毁明文。 |
| I-056 | I-054 + I-055 + I-014 | `W/features/api-access/KeyTable.tsx`；`W/features/api-access/IntegrationGuide.tsx`；`W/pages/keys/KeysPage.tsx` | 实现密钥列表与撤销、接入协议示例；示例用变量引用密钥。 | `/keys` 同时承担密钥管理与指南，不泄露真实 Key 到示例。 |
| I-057 | I-024 + I-050 + I-041 + I-013 + I-015 | `W/features/dashboard/api.ts`；`W/features/dashboard/BalanceCard.tsx`；`W/pages/dashboard/DashboardPage.tsx` | 实现真实余额、最近请求、接入入口与余额不足提示。 | 概览仅显示已存在数据，无伪造成功率/趋势/支付入口。 |
| I-058 | I-047 + I-052 + I-053 + I-056 + I-057 | `W/app/router.tsx`；`W/app/navigation.ts` | 一次性挂载个人控制台路由与导航、请求详情直达。 | 个人控制台形成完整可导航模块；不运行检查。 |

## 7. 聊天任务

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-060 | I-028 + I-041 | `W/features/chat/api.ts`；`W/features/chat/query-keys.ts` | 实现模型组、会话分页、会话详情 query 与 CRUD mutation；明确身份/会话 key。 | 持久化聊天数据有独立缓存入口。 |
| I-061 | I-028 | `W/features/chat/model/state.ts`；`W/features/chat/model/reducer.ts` | 实现 idle/creating/submitting/streaming/stopping/finalizing/interrupted/failed 状态和 typed events。 | reducer 不含 fetch、DOM 或隐式副作用，旧 operation 事件被忽略。 |
| I-062 | I-061 | `W/features/chat/model/operation.ts`；`W/features/chat/model/reconcile.ts` | 定义 operationId 生命周期、结果不明重用、消息 ID/version 合并与最终状态核对。 | 新操作和重试边界明确；不会因重渲染产生新收费操作。 |
| I-063 | I-029 + I-060 + I-062 | `W/features/chat/model/controller.ts` | 组合发送、必要时创建会话、SSE、停止、断流和确认最终快照；同步获取发送锁。 | controller 暴露 send/stop/retry/getSnapshot/subscribe/dispose，无 UI 依赖。 |
| I-064 | I-061 + I-062 | `W/features/chat/model/regenerate.ts`；`W/features/chat/model/variants.ts` | 定义最后一轮再生成和版本选择的命令与状态规则，区分拒绝、接收后失败、停止和成功。 | 原回答/替代回答的 selected 状态与服务端一致。 |
| I-065 | I-063 + I-064 | `W/features/chat/model/controller.ts` | 将再生成/版本命令接入 controller，统一操作锁与结果核对；只改现有组合层。 | 发送与再生成共享同一操作生命周期，避免并发重复操作。 |
| I-066 | I-040 | `W/features/chat/model/drafts.ts`；`W/features/chat/hooks/useDraft.ts` | 迁移草稿按 user/conversation 隔离、即时保存与存储异常容错；定义过期登录后的同用户恢复。 | 草稿与身份生命周期相连，换号不会泄漏其他账户输入。 |
| I-067 | I-060 + I-012 | `W/features/chat/hooks/useHistory.ts`；`W/features/chat/components/ConversationSidebar.tsx` | 会话分页合并/去重、重命名删除、首次/后续失败重试，拒绝重复 cursor 导致无限循环。 | 历史完整按页加载，不伪装提供全库搜索。 |
| I-068 | I-060 + I-012 | `W/features/chat/hooks/useModelSelection.ts`；`W/features/chat/components/ModelPicker.tsx` | 组→模型选择、当前失效选择保留及提示、倍率/输出上限展示。 | 只展示用户已授权模型，不用内置目录冒充可调用列表。 |
| I-069 | I-010 + I-066 | `W/features/chat/components/Composer.tsx` | 多行输入、IME、Enter/Shift+Enter、busy/stop、输出上限、移动 safe-area；操作通过 props。 | 输入 UI 不自行发请求，不因中文 composition 误发送。 |
| I-070 | I-003 + I-009 | `W/features/chat/components/MessageContent.tsx`；`W/features/chat/components/CodeBlock.tsx` | 安全 Markdown/GFM、代码复制、链接策略、文本空白保真；禁用 raw HTML，不加载全部高亮语言。 | 消息内容呈现安全，代码和原始消息不被破坏。 |
| I-071 | I-064 + I-070 + I-012 | `W/features/chat/components/Message.tsx`；`W/features/chat/components/MessageActions.tsx` | 角色排版、状态、复制、回答版本和最后一轮动作；不可操作状态提供原因。 | 单条消息有完整动作入口与 props 契约。 |
| I-072 | I-071 | `W/features/chat/hooks/useScrollAnchor.ts`；`W/features/chat/components/MessageList.tsx` | 自动跟随/主动向上阅读、回到底部、历史插入锚点和节流播报；先采用实测需要前的简单渲染策略。 | 长消息与流式变化不强迫用户滚到底部。 |
| I-073 | I-065 + I-066 + I-040 | `W/features/chat/hooks/useChatController.ts`；`W/features/chat/components/ChatNotice.tsx` | React 生命周期订阅、StrictMode 清理、身份过期草稿交接与业务错误操作提示。 | controller 生命周期与身份切换绑定，卸载不把未知结果误判为失败。 |
| I-074 | I-067–I-069 + I-072 + I-073 + I-046 | `W/app/layouts/ChatLayout.tsx`；`W/pages/chat/ChatPage.tsx` | 组合认可的聊天布局、匿名入口、历史/模型/消息/输入/notice；旧 URL 兼容。 | 一个完整聊天页面承载新会话和历史会话。 |
| I-075 | I-058 + I-074 | `W/app/router.tsx`；`W/app/navigation.ts` | 挂载 `/` 与 `/chat/:id`，加入工作区切换与登录返回路径。 | 聊天形成从进入、发送到恢复的完整链路。 |

## 8. 管理详情 GET 与资源配置任务

详情 GET 使用现有 session/admin/no-store 中间件，只返回当前管理 DTO。优先复用 `catalog/channels.getChannelById`、`catalog/models.getModelById`、`admin/group-repository.getGroupById`；用户读取复用现有列表的安全投影。禁止为详情读取调用包含解密 Key 的转发函数。

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-080 | I-001 + I-030 | `B/admin/channel-routes.ts` | 增加带 ID 校验的 GET `.../channels/:id`，复用脱敏读取，缺失返回 404。 | 渠道子路由提供与列表一致的详情 DTO，无密钥明文。 |
| I-081 | I-001 + I-031 | `B/admin/model-routes.ts` | 增加模型 GET，沿用模型 ID 编码和价格/能力投影。 | 含斜杠的合法模型 ID 可经统一编码用于详情。 |
| I-082 | I-001 + I-033 | `B/admin/group-routes.ts` | 增加访问组 GET，返回组版本/倍率/关联。 | 访问组详情独立于列表是否已加载。 |
| I-083 | I-001 + I-034 | `B/admin/user-routes.ts`；`B/admin/user-detail.ts` | 提取/复用安全用户投影，增加单项读取；保留管理员限制，不暴露密码 hash。 | 用户深链所需详情可以单项获取。 |
| I-084 | I-080–I-083 | `B/routes.ts` | 在总路由挂载四个详情 GET，保留现有 PATCH 与精确路由优先级。 | 四条新接口实际可由 Worker 入口访问，不只存在于子路由。 |
| I-085 | I-030 + I-041 + I-084 + I-014 | `W/features/admin-channels/api.ts`；`W/features/admin-channels/ChannelTable.tsx`；`W/pages/admin/ChannelsPage.tsx` | 渠道列表/筛选/分页/详情入口，状态仅 active/disabled，不伪造健康率。 | 渠道列表接上真实管理 API。 |
| I-086 | I-085 + I-011 | `W/features/admin-channels/ChannelForm.tsx`；`W/features/admin-channels/credential-input.ts` | 创建与编辑字段、限额/优先级、凭据替换语义、version 冲突保留输入。 | 未填新密钥不提交替换，配置值遵守真实 null/限额契约。 |
| I-087 | I-032 + I-030 + I-041 | `W/features/admin-channels/ChannelDiagnostics.tsx`；`W/features/admin-channels/diagnostic-operation.ts` | 选择映射和协议显式探测，携带三个版本；展示成本提示与真实 outcome，不自动探测。 | 诊断是独立操作，无周期请求和隐式计费。 |
| I-088 | I-031 + I-041 + I-014 | `W/features/admin-models/api.ts`；`W/features/admin-models/ModelTable.tsx`；`W/pages/admin/ModelsPage.tsx` | 模型列表/分页/详情入口，区分模型启用与渠道可用。 | 模型目录页有真实查询和深链。 |
| I-089 | I-088 + I-010 + I-015 | `W/features/admin-models/ModelForm.tsx`；`W/features/admin-models/PriceFields.tsx` | 模型与价格表单，明确每百万 Token/缓存/推理字段和版本；金额字符串处理。 | 模型编辑无浮点舍入，冲突保留原输入。 |
| I-090 | I-032 + I-041 | `W/features/admin-models/mapping-api.ts`；`W/features/admin-models/MappingTable.tsx`；`W/features/admin-models/public.ts` | 模型映射的查询/创建/编辑入口与状态展示；公共入口先导出稳定的表格与 query 工厂。 | 模型与映射操作有各自版本和请求，跨 feature 消费有明确入口。 |
| I-091 | I-030 + I-014 + I-041 | `W/shared/catalog/channel-options.ts`；`W/shared/catalog/ChannelPicker.tsx` | 完整加载/去重渠道候选，记录终止 cursor；中页失败不可当完整列表提交，支持停用/缺失当前值及关闭重开取消。 | 模型与组共同使用完整、可恢复的渠道选择器。 |
| I-092 | I-090 + I-091 + I-012 | `W/features/admin-models/MappingForm.tsx`；`W/features/admin-models/CapabilityFields.tsx`；`W/features/admin-models/public.ts` | 映射字段、能力选项与版本冲突；mapping 读取重试与渠道候选重试独立；公共入口补导出 MappingForm。 | 映射编辑保持已有字段和当前值，不因候选变化清掉选择。 |
| I-093 | I-088–I-090 + I-092 | `W/pages/admin/ModelDetailPage.tsx` | 组合模型、价格、映射详情与保存反馈；ID 统一编码。 | 模型配置在一个可刷新的详情页完成。 |
| I-094 | I-033 + I-041 + I-091 + I-084 | `W/features/admin-groups/api.ts`；`W/features/admin-groups/GroupForm.tsx`；`W/features/admin-groups/GroupTable.tsx` | 组列表/详情/写入、精确倍率与渠道关联，复用 ChannelPicker。 | 组 CRUD 的数据与组件层完成，不实现未经后端解析的授权预览。 |
| I-095 | I-094 + I-014 | `W/pages/admin/GroupsPage.tsx`；`W/pages/admin/GroupDetailPage.tsx` | 组合组列表与详情，显示授权关系说明和配置冲突。 | 访问组页面支持深链及实际关联编辑。 |
| I-096 | I-086 + I-087 + I-090 + I-092 | `W/features/admin-channels/ChannelMappingPanel.tsx`；`W/pages/admin/ChannelDetailPage.tsx` | 在渠道详情组合配置、映射、诊断；通过明确公共导出复用映射能力，不 deep import 内部文件。 | 渠道详情与模型详情管理同一批真实映射。 |
| I-097 | I-086 + I-094 + I-092 | `W/features/admin-channels/setup-controller.ts`；`W/features/admin-channels/ChannelSetup.tsx` | 通过注入的 createChannel/createMapping/updateGroup 命令逐步创建渠道、添加映射、关联组，记录每步已保存 ID 与版本，部分失败保留成果并继续。 | 引导不声称原子事务，不因重试重复创建已成功资源。 |
| I-098 | I-096 + I-097 + I-093 + I-095 | `W/pages/admin/ChannelsPage.tsx` | 从页面层组合各领域命令并注入新增渠道引导，接入已交付的映射公共入口，不在引导组件 deep import 其他 feature。 | 资源配置模块组合完整，跨 feature 依赖仅通过明确公共入口。 |
| I-099 | I-075 + I-098 | `W/app/router.tsx`；`W/app/navigation.ts` | 挂载渠道、模型、组列表/详情；`/admin` 默认跳渠道，管理员守卫覆盖全组。 | 管理资源模块形成完整可导航链路。 |

> 映射公共入口由 I-090 创建、I-092 补齐，I-096 之后消费；只导出 MappingTable、MappingForm 和具名 query/command 工厂，内部状态不外露。引导需要多个领域命令时由页面层组装并注入。

## 9. 管理运营任务

| ID | 依赖 | 确切写集 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-100 | I-034 + I-041 + I-084 | `W/features/admin-users/api.ts`；`W/features/admin-users/UserTable.tsx`；`W/pages/admin/UsersPage.tsx` | 用户列表、实际支持筛选、分页与详情入口。 | 用户管理可按状态/组等真实参数定位。 |
| I-101 | I-100 + I-033 + I-011 | `W/features/admin-users/UserForm.tsx`；`W/features/admin-users/UserAccessPanel.tsx` | 新建/修改用户、角色只读展示、状态/组授权与接口支持的管理撤销 Key；候选分页和版本处理沿用真实 API。 | 用户权限编辑完整，未支持的细分角色不出现在 UI。 |
| I-102 | I-100 + I-015 | `W/features/admin-users/balance-operation.ts`；`W/features/admin-users/BalanceAdjustmentDialog.tsx` | 精确金额输入、操作 ID 生命周期、提交锁、结果不明显式恢复；显示目标用户/说明。 | 同一授额重试复用 operationId，避免重复余额变动。 |
| I-103 | I-101 + I-102 | `W/pages/admin/UserDetailPage.tsx`；`W/pages/admin/UsersPage.tsx` | 组合资料/授权/余额与请求账单入口，并接入创建用户。 | 用户管理从列表到授权/授额形成闭环。 |
| I-104 | I-035 + I-041 + I-010 | `W/features/admin-registration/api.ts`；`W/features/admin-registration/SettingsForm.tsx`；`W/pages/admin/RegistrationSettingsPage.tsx` | 注册模式、邮件验证、邮件可用性和 version 冲突提示；禁用不满足条件的写入。 | 策略页面表达后端真实 readiness。 |
| I-105 | I-104 + I-011 | `W/features/admin-registration/code-operation.ts`；`W/features/admin-registration/CodeBatchDialog.tsx` | 邀请码批次创建/重放/一次性明文复制和清理；固定 operationId。 | 明文不进入持久缓存，重放只显示允许返回的元信息。 |
| I-106 | I-105 + I-014 | `W/features/admin-registration/CodeTable.tsx`；`W/pages/admin/RegistrationCodesPage.tsx` | 批次记录、状态/有效期、支持的筛选与撤销，说明注册资格和余额关系。 | 邀请码管理闭环完成。 |
| I-107 | I-050–I-052 + I-036 + I-046 | `W/pages/admin/RequestsPage.tsx`；`W/pages/admin/RequestDetailPage.tsx`；`W/features/request-history/SettlementAction.tsx` | 使用管理范围请求及展示公共入口，增加用户/渠道字段和适用状态的结算重试。 | 管理请求与个人缓存隔离，结算操作状态明确。 |
| I-108 | I-027 + I-036 + I-053 + I-014 | `W/pages/admin/BillingPage.tsx`；`W/features/admin-audit/api.ts`；`W/pages/admin/AuditPage.tsx` | 全局账本和审计查询/分页/详情；保留脱敏结果与关联请求入口。 | 运营记录可以定位余额/配置变动来源。 |
| I-109 | I-099 + I-103 + I-104 + I-106–I-108 | `W/app/router.tsx`；`W/app/navigation.ts` | 一次性挂载所有管理运营路由，完善管理员导航与直接访问。 | 全部首期业务页面完成接线。 |

## 10. 必要测试的编写/迁移任务：不执行

现有 189 个 Vitest 文件、3,807 项用例曾在环境配置阶段通过；这只是历史结果，不作为新实现结论，也不要求每个 subagent 重跑基线。既有浏览器 2 个失败是 `returnTo` 编码形式断言问题，按 T-011 修正实际目标语义。

以下 T 任务先盘点列出文件中已有覆盖，在原文件迁移或新增缺失行为。每个任务交付时说明“保留的用例/新增的行为风险/未新增重复用例”。**T 最终状态是测试代码已编写，不是测试通过。** 不以已有不合理的字符串断言作为新前端兼容要求。

| ID | 依赖 | 确切写集 | 为什么必要与具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| T-001 | I-022 + I-040–I-043 + I-066 | `tests/unit/api-client.node.test.ts`；`W/features/session/session.test.tsx`；`W/features/chat/model/drafts.test.ts` | 原 api-client 用例含旧 Vue session/router/draft 引用；将纯通信保留原文件并切新包，把身份竞态/回跳移至 session、草稿隔离移至 drafts。保留 CSRF、编码穿越、401/non-JSON、旧身份晚到与存储异常行为；去掉对 Vue 实现细节依赖。 | 三个文件按责任承接既有有价值断言，不新写显示文案比较。 |
| T-002 | I-030–I-036 + I-051 | `tests/unit/web-admin-contracts.test.ts`；`W/shared/lib/money.test.ts` | 迁移现有渠道/组/请求解码测试到新包；补契约确实允许的无限制值与 null 精度风险。金额仅覆盖边界、负值和大值，不枚举每个格式样式。 | 合法/非法 API 数据与金额行为有必要覆盖。 |
| T-003 | I-025–I-027 + I-054–I-058 | `tests/e2e/full-workflow.spec.ts`；`W/features/api-access/key-operation.test.ts` | 现有完整链路复用 signup→Key→授额→九协议对→账本；按语义定位迁移。仅给新操作控制器补 created/replayed、响应丢失复用 ID 与明文清理。 | 既有跨层链路保留，新 Key 控制器特殊风险被覆盖。 |
| T-004 | I-047 + I-048 | `tests/e2e/auth.spec.ts` | 迁移登录/注册、邮件/邀请码策略及身份失败的语义 locator；回跳按解析后的路径断言。需要落到尚未挂载的聊天首页时，仅断言目标 URL 与身份 API，不断言聊天内容。 | 浏览器身份 suite 独立于聊天实现，可供完整身份模块集中执行。 |
| T-005 | I-065 + I-067 + I-068 + I-029 + I-006 | `tests/unit/web-chat-client.test.ts`；`W/features/chat/model/controller.test.ts`；`W/features/chat/hooks/history-selection.test.tsx` | 既有纯 SSE 用例改新客户端；原 Vue history/model-selection 行为移至 hooks 的 DOM 用例，用公共 hook 驱动。新 controller 仅补连点、结果不明、停止/卸载、过期事件与再生成状态组合缺口。 | 旧 Vue 依赖移除，流传输与新操作状态机有明确风险覆盖。 |
| T-006 | I-075 | `tests/e2e/web-chat.spec.ts`；`tests/e2e/web-chat-races.spec.ts` | 迁移现有 chat 和 races 用例到语义 locator，保留 HTTP mock 延迟/丢响应注入、一次操作一次扣费、版本/停止/移动场景。 | 既有重要 E2E 能操作 React UI，不另复制一套同义用例。 |
| T-007 | I-084 | `tests/admin/entity-details.test.ts` | 只为新增 GET 增加 Worker 用例，参数化覆盖四实体的 401/403、404、合法投影、敏感字段不存在与模型 ID 编码。复用现有 D1 helpers，不扩展网关测试。 | 新接口的权限与脱敏行为有回归，既有读取函数不写镜像测试。 |
| T-008 | I-099 | `tests/e2e/builtin-models.spec.ts`；`tests/e2e/product-corrections.spec.ts` | 迁移模型/修正用例的语义 locator 与编辑入口，保留多页候选、中页失败、关闭重开晚返回、mapping 冲突。按 case 标签区分资源和运营；涉及用户的现有用例保留，待运营模块完成在 V-05 执行。 | 资源业务覆盖复用原用例，标签只做调度，不永久 skip 未迁移功能。 |
| T-009 | I-073 + I-074 + I-006 | `W/features/chat/components/Composer.test.tsx` | 仅补真实 DOM/事件特有的 IME composition 与 busy/stop 可操作性；已有浏览器用例已覆盖的普通发送不重复。 | 中文输入与操作锁这两个 React 交互风险有小范围覆盖。 |
| T-010 | I-055 + I-105 + I-006 | `W/features/api-access/secret-lifecycle.test.tsx` | 同一必要用例组覆盖 Key/邀请码明文关闭、换号、卸载后清理及重放无明文；检查实际状态/缓存，不抓截图或匹配说明文字。 | 一次性凭据跨两个入口遵循同一生命周期约束。 |
| T-011 | I-075 | `tests/e2e/web-chat-ui.spec.ts` | 保留同用户/换号草稿、版本和历史等 UI 用例，迁移语义 locator；`returnTo` 使用 URL pathname/searchParams 断言实际目标，不能只删掉失败断言。 | 聊天 UI 行为得到保留，修正等价 URL 编码形式造成的假失败。 |
| T-012 | I-109 | `tests/e2e/admin.spec.ts` | 迁移管理员配置、用户授额、请求排障的既有完整链路，采用语义 locator；按实际后端操作结果和账本断言，保留业务失败用例。 | 运营完整链路在旧 suite 内接上新页面，不新增一份同义 E2E。 |

共享测试文件只由一个 T 任务修改，不按个人/聊天/管理 subagent 同时编辑。T-001 内 JSX 用例仅在 React project 运行，Node 原文件不再引用 Vue 或 JSX 模块。若盘点发现上述某项已被现有用例完整覆盖，迁移原用例即可，不增加数量指标。

## 11. 集中测试执行与验证任务

V 任务由专门 runner 领取，**只出报告，不顺手改业务代码或测试断言**。报告记录目标产物/源码版本、执行命令、退出码、实际用例数、失败类别、未执行项和复现信息。每个 V 最多构建所需 React 产物一次；同一产物内可复用服务和浏览器。脚本启动前的产物准备归本 V，不分散到实现任务。

原则：模块级 V 只运行该模块相关 suite，不运行全仓 `check`；最终 V-06 才执行一次全量。已有 Workers 网关/协议/迁移/账本套件不在前端每个模块重复跑。资源默认浏览器 workers=1，D1/DO 套件沿用仓库串行规则。验证跨过提交或应用源码变化就重新准备对应产物；不把旧报告当新结果。

| ID | 完整模块所需代码产物 | 本次集中执行范围 | 唯一交付文件 |
| --- | --- | --- | --- |
| V-01 | I-001–I-017、I-020–I-023、I-040–I-048、I-066；T-001、T-004 | 身份链路接通后一次 React/共享包 typecheck 和目标 build；通信与 session 风险用例；浏览器身份 suite 覆盖登录/注册/401/403/5xx、CSRF、安全返回与移动导航；同一批验证本地开发代理的登录能力，凭据/证书只保存在忽略路径。草稿业务用例留到 V-03。 | `docs/validation/cheapai-react-auth.md` |
| V-02 | I-050–I-058；T-002/T-003；身份代码 | 一次个人控制台 typecheck/build；金额与 Key 操作用例；请求分页/详情/账单/Key 创建撤销/once-secret；复用现有 full-workflow 里个人链路适用用例，不提前声称聊天 UI 已验证。 | `docs/validation/cheapai-react-personal.md` |
| V-03 | I-060–I-075；T-001 的草稿部分、T-005/T-006/T-009/T-011；个人/身份代码 | 一次聊天模块 typecheck/build；SSE/controller/草稿/IME 用例；完整聊天浏览器链路（发送、断流、停止、幂等、版本、过期和换号恢复）。在同一轮检查桌面/移动滚动、键盘焦点及本地 Vite 同源代理的流式转发。 | `docs/validation/cheapai-react-chat.md` |
| V-04 | I-080–I-099；T-007；T-008 的资源部分 | 一次资源管理 typecheck/build；只跑新增详情 Workers 用例；渠道→模型映射→访问组配置链路，包含真实深链刷新、多页候选、冲突、部分保存与模拟诊断。个人访问新详情接口的权限由此一起覆盖。 | `docs/validation/cheapai-react-catalog.md` |
| V-05 | I-100–I-109；T-008 的运营部分；T-010/T-012 | 一次运营模块 typecheck/build；用户授权→Key→授额→请求/账本→结算/审计，注册策略→邀请码→注册两条完整链路；一次性凭据、余额重复提交与冲突。 | `docs/validation/cheapai-react-admin.md` |
| V-06 | 所有 I/T/M 代码交付 | 已完成本地集中验收：workspace typecheck/build、Worker dry-run、React lint、完整 Vitest 与必要新增风险用例、React 定点测试、PR preview self-test、浏览器完整覆盖。浏览器结果按首轮与两项定点复跑合并记录；未执行生产发布。 | `docs/validation/cheapai-react-final.md` |

V-01/V-02 如已有 suite 混有尚未迁移页面，按 case/标签选择本链路，报告排除范围；不删除或长期 skip 用例。V-06 所有相关用例必须被实际收集与执行，0 tests 不能当通过。新功能开发不会因某个模块 V 未执行而被迫逐任务等待；已发现的契约冲突由协调者立即反馈给受影响 lane。

### runner 的固定命令入口

I-003/I-007/I-048 必须提供这些入口；以下命令只供 V 任务使用，不向普通任务复制。

```sh
# 模块级准备：共享包按实际改动选择，React 产物本批只构建一次。
pnpm --filter @cheapai/contracts --filter @cheapai/api-client run typecheck
pnpm --filter @cheapai/web run typecheck
pnpm --filter @cheapai/web run build
# 精确选择本 V 的文件；不要把这些尖括号当作真实参数。
pnpm exec vitest run --project node <本模块的原 Node 测试文件>
pnpm exec vitest run --project react <本模块的 React 测试文件>
# 只有 V-04 的新增 GET，以及最终全量需要 Workers 测试。
pnpm exec vitest run --project workers tests/admin/entity-details.test.ts
# harness 的正式环境变量由 I-048 固定如下；已有产物复用限定在同一 V。
CHEAPAI_WEB_ROOT=apps/web CHEAPAI_E2E_REUSE_BUILD=1 pnpm exec playwright test <本模块 spec/标签>
# 最终 V-06：目录切换后根入口各执行一轮。
pnpm run check
pnpm exec playwright test
pnpm --filter @cheapai/web exec eslint src
```

I-048 的 `CHEAPAI_E2E_REUSE_BUILD=1` 只跳过重复构建，不跳过 D1/fixture 隔离与服务就绪检查；由 V runner 在本批构建后显式设置。当前 `CHEAPAI_WEB_ROOT` 默认及正式目标为 `apps/web`；示例命令选择的 React 产物必须由同一 V 任务准备。模块使用哪些 spec/标签由表内范围决定，不因示例命令列出了 Workers 就每批运行它。类型检查包含其他模块时，协调者使用稳定源码交付点或合并记录明确的错误范围，不要求每个小任务先过全应用编译。

### 失败处理与修复批次

1. runner 将失败区分为环境、产品行为、契约/fixture、用例不合理、截图/视觉偏差；不反复运行相同失败命令。
2. 协调者按 feature 归并问题，建立 `FIX-模块-序号`，同样列明确切 ≤3 个文件、动作和最终状态；FIX 任务不运行测试。
3. 同一功能模块的这一批修复都交付后，由原 V 任务集中复跑受影响 suite。新增修改未触及的模块不重跑；全量只有最终一次及有明确全局影响的复跑。
4. 不为绿灯放宽业务断言、强行 sleep、增加无依据 retry 或跳过失败。涉及 URL 显示编码的用例改成结构语义断言，仍保证正确返回目标。

## 12. 目录切换、清理与交付任务（保留原计划记录）

表格保留原计划中的写集与任务说明。M-121/M-122 已完成：React 当前位于 `apps/web`，旧 Vue 完整归档于 `/workspace/cheapai-legacy-archive/react-cutover/apps-web`。实现切换不执行生产发布；最终质量仍由 V-06 集中记录。

| ID | 依赖 | 确切写集/受控例外 | 具体工作 | 最终状态 |
| --- | --- | --- | --- | --- |
| I-120 | I-109 + T-001–T-012 | `docs/frontend-react-cutover-manifest.md` | 根据当前文件树列出旧 Vue 文件、需要迁移的测试导入、所有 apps/web/旧包名引用、未跟踪本地文件处理与移动清单；只读盘点，不跑检查。明确 M 写集，不包含密钥/缓存/无关用户文件。 | 后续移动/删除都有具体枚举和可回退来源。 |
| M-121 | I-120 | **必要例外：清单中整个旧 `apps/web` 目录的移动**；`docs/frontend-react-cutover-manifest.md` | 用不覆盖目标的目录移动将旧应用移至 checkout 外归档，连同本地文件原样保留；优先同文件系统 rename，不复制后删除，不提交该归档。 | 已完成：旧 Vue 位于 `/workspace/cheapai-legacy-archive/react-cutover/apps-web`；本地归档保留，不属于 workspace。 |
| M-122 | M-121 | **必要例外：整个 `apps/web-next` → `apps/web` 的目录移动**；`docs/frontend-react-cutover-manifest.md` | 使用不覆盖目标的目录移动一次归位，记录源/目标路径。仅移动目录，不夹带业务修改。 | 已完成：React 位于正式 `apps/web`，workspace 包名为 `@cheapai/web`。 |
| I-123 | M-122 | `pnpm-workspace.yaml`；`package.json`；`B/package.json` | 移除迁移期 web-next 项，将命令改回最终路径，Worker 构建依赖切到 `@cheapai/web`，移除 Vue 专用脚本和临时命令。 | monorepo 构建图指向 React，应用保留 cheapai 包名。 |
| I-124 | I-123 | `pnpm-lock.yaml` | 依赖 owner 集中更新安装与锁文件，清除失去引用的 Vue 依赖；保留供应链限制，不执行构建或测试。 | 最终依赖图与清单对应，没有迁移期重复应用。 |
| I-125 | I-123 | `vitest.config.ts`；`scripts/start-local-test-server.mjs`；`playwright.config.ts` | 根 React project、测试服务选择和报告路径归位；默认测试目标为 React，去掉只为旧 Vue 保留的构建分支。 | 正式测试入口不依赖 web-next 或 vue-tsc。 |
| I-126 | I-125 | `tests/unit/api-client.node.test.ts`；`tests/unit/web-chat-client.test.ts`；`tests/unit/web-admin-contracts.test.ts` | 仅按清单修正归位后的应用纯逻辑 import、虚拟类型消费者路径，移除剩余 Vue 特有路径；不改业务断言。 | 旧测试文件连接最终 React/共享包位置。 |
| I-127 | I-123 | `.github/workflows/check.yml`；`.github/workflows/preview.yml`；`scripts/pr-preview.mjs` | 更新旧包名过滤和产物路径，CI 维持单一完整检查入口；预览指向最终 React assets，清除可见旧品牌。 | CI/预览配置指向新应用；不触发远程工作流/部署。 |
| I-128 | I-123 | `apps/web/index.html`；`apps/web/src/shared/brand.ts`；`apps/web/src/app/navigation.ts` | 根据整合清单收口页面标题、品牌常量和导航，全部 cheapai；其余页面若残留品牌由对应小 FIX 处理，不在本任务改第四文件。 | 产品入口统一命名，保留必要协议标识。 |
| I-129 | I-124–I-128 | `docs/development.md`；`docs/frontend-react-design.md`；`README.md` | 更新开发命令、应用目录、同源 HTTPS、环境变量/证书方式和设计实施状态；明确新增功能与仍未做的图表等范围。 | 文档描述最终代码位置和启动流程，不将未执行的验证写成已通过。 |
| I-130 | I-129 | `docs/frontend-react-cutover-manifest.md` | 汇总回退旧前端所需源码/产物引用、包清单与锁文件、API 兼容性和部署配置；标记仅准备、未发布。 | 回退范围覆盖构建图与资源，不只是保留一张截图。 |

M-121/M-122 是仅有的多文件源码操作例外：把整个应用移动按每次三个文件切开会造成高协调成本与长时间目录不一致。两项移动均已完成。其他任务即使属于清理，也遵守三文件写集；归档不是 workspace，不提交其中的本地缓存或密钥。

## 13. 协调者的分派与收口方式

- 首先派 I-001、I-002/I-003、I-009；I-004 只由依赖 owner 执行一次。公共接口按第 1 节冻结后，通信/UI/身份三 lane 启动。
- router/nav 的修改顺序固定为 I-047 → I-058 → I-075 → I-099 → I-109 → I-128；功能子组件可提前完成，路由整合等待实际导出交付。
- 共享写文件的其他顺序：controller I-063 → I-065；模型公共入口 I-090 → I-092；ChannelsPage I-085 → I-098；UsersPage I-100 → I-103；root Vitest I-007 → I-125；harness I-048 → I-125；依赖变更 I-002/003 → I-004 → I-123 → I-124。
- 新模块只消费固定契约，不自行加导航项/Provider/全局样式；公共文件修改请求由其 owner 合并处理。
- 每个模块完成时集中收取代码交付和必要 T 任务，再分派对应 V。V 与不相干模块编码可并行，但不和同目标文件的修改并行运行，以免测到混合产物。
- 实现、目录切换和本地 V-06 验收均已完成；最终结果见 `docs/validation/cheapai-react-final.md`。真实邮件/供应商和生产部署不纳入本前端本地验证。
- 最终交付：cheapai React 应用、共享契约/API 包、保留必要行为的测试代码、6 份集中验证记录、开发文档、目录切换清单。是否发布由后续发布任务处理，本计划不创建或执行部署。

## 14. 每个模块的业务最终状态摘要

| 模块 | 代码交付时应具备的结果 |
| --- | --- |
| 身份/应用壳 | 登录注册、Secure Cookie/CSRF、角色守卫、安全返回、服务故障恢复、cheapai 导航 |
| 个人控制台 | 精确余额、Key 创建与撤销、指南、请求双状态/详情、真实账本 |
| 聊天 | 历史分页、授权模型、保真消息、流式/停止/再生成/版本、幂等恢复、身份草稿隔离 |
| 管理资源 | 实体深链、渠道配置/诊断、模型价格映射、访问组、完整候选、version 冲突和分步继续 |
| 管理运营 | 用户授权/授额、邀请码/注册策略、全局请求、结算操作、账本与脱敏审计 |
| 最终仓库 | React 在 `apps/web`，Vue 完整归档于 workspace 外，CI/脚本/Worker assets 对齐，文档与品牌一致；最终验证结论待 V-06 |

这些是代码和产品行为描述，不包含“先跑测试/测试通过/自行截图检查”等实现任务完成条件。
