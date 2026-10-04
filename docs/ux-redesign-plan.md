# cheapai UX 重设计开发计划

状态：开发及本地集成验证完成，准备 draft PR。核对日期：2026-10-04。实施分支：`codex/ux-redesign-20261004`。

## 1. 基线与执行规则

- 仓库：`a48zhang/cheapai-service`，原名 `sub2api-cloudflare`，仓库 ID `1400110254`。
- 实施基线为 `37493ee2d578eaf25e844d876504fddce562a092`，核对时本地 HEAD 与远端 `main` 一致。以下现状以该提交为准，保留并继续当前分支已有的实施改动。
- 组件边界沿用 `docs/frontend-react-module-boundaries.md`；发布复用 `docs/pr-previews.md` 与 `docs/deployment.md` 的当前机制。
- 完整设计一次规划，不分 MVP。每个开发任务限定 1–3 个精确文件；新增、删除各计 1 个文件，移动按源、目标计 2 个。共享文件按依赖串行。
- 开发任务只实现目标。模块完整后进入独立验证节点，复用既有检查和用例，最后集中集成一次；不扩展测试体系。

统一边界：用户已授权使用 gpt-6-luna、max、priority 子代理完成实施、模块验证、推送独立分支、创建 draft PR 并跟进 CI；不合并、不发布生产，P01–P03 保留为未来发布节点。设计不含安全审查、刁钻场景、首次调用引导、聊天内部执行路径改造或 desktop 分支工作。保留服务端技术限制、外部 API 参数和现有结算机制；前端命令层仅删除输出上限字段及透传。

## 2. 信息架构与页面骨架

用户只需完成三类任务：直接聊天、查看费用、接入 API。使用记录是消费的追溯入口，管理功能独立。

| 路径 | 页面与入口 | 目标结构 |
| --- | --- | --- |
| `/`、`/chat/:id` | 首页直接聊天 | 顶部品牌、API 接入、头像；左侧新对话与历史；正文；底部模型选择与输入框 |
| `/billing` | 头像菜单「费用」 | 当前余额、期间消费、本月日期范围、费用明细 |
| `/keys` | 顶部「API 接入」 | Base URL、Key 列表/创建、调用示例，同页连续展示 |
| `/requests`、`/requests/:id` | 头像菜单「使用记录」及费用明细链接 | 简洁列表，点击进入技术详情 |
| `/dashboard` | 旧链接兼容 | `replace` 到 `/billing`，不再保留中转页面 |
| `/admin/*` | 管理员头像菜单独立入口 | 保留管理导航与管理权限；返回聊天，不再切换“工作台模式” |
| `/login`、`/register` | 登录与注册 | 登录后回到原页面；注册入口遵循同一公开配置 |

桌面聊天保留窄历史侧栏，移动端用现有抽屉；API 接入在移动端顶部仍可见。个人费用、API、记录页使用同一轻量顶部布局，不再出现个人控制台侧栏。管理员布局继续承载管理功能。

### 2.1 聊天

```text
cheapai                              API 接入   头像
新对话 / 历史        对话正文
                     模型名称（有多个有效选项才可展开）
                     输入消息…                 发送 / 停止
```

删除工作台切换、泛化提示卡、大装饰、输出上限控件与解释。空白正文只保留「有什么想聊的？」。模型选择只出现一处，贴近输入框；默认使用最近有效选择，唯一选项以文字呈现。

未登录可以输入，主按钮为「登录后发送」。点击登录保留当前草稿和返回地址，登录回来显示草稿，由用户发送，不自动代发。网页聊天沿用现有会话授权，不要求用户创建 API Key。

消息保留正文、实际模型、复制；最新一轮提供「重新回答」；确有多个回答版本才显示版本切换。删除常驻「已完成」、整行时间和无效按钮解释。生成时输入区显示「停止」；停止、失败只保留必要短状态。历史首次自动读取，滚动到底自动续页，失败才出现「重试」；改名在原列表行完成。

### 2.2 费用

```text
费用
当前余额 $…             本月已结算消费 $…
开始日期 — 结束日期      本月 / 类型
时间 | 类型 / 模型 | 来源 | 金额 | 查看记录
```

默认本月，可切换日期；当前余额始终是实时账户余额，期间消费是所选日期内全部已结算模型消费。授额和余额调整在明细保留，但不计入消费合计。日期和类型选择直接生效，不设独立「应用」按钮。类型仅筛选明细，不改变期间消费合计。删除常驻请求 ID 筛选输入；旧链接中的 requestId 继续由底层兼容，以可清除的筛选提示呈现。

进入页面、回到窗口或已知消费变动后自动更新余额与费用；沿用现有查询缓存、分页和快照机制。正常态删除刷新按钮，失败才提供重试。页面不新增充值入口。

### 2.3 API 接入

```text
API 接入
Base URL   https://当前实际服务域名/v1       复制
API Key                                    创建 Key
名称 | 掩码 | 状态 | 编辑 | 撤销
调用示例   协议选择 / 授权模型选择           复制示例
```

删除外层「API Keys / 接入指南」标签页。创建名称预填「我的 API Key」，可直接编辑；唯一可用组自动选且不显示下拉，多组保留真实组名、模型范围和价格区别。编辑保存成功即关闭并更新列表。列表保留一个撤销入口，编辑按钮只叫「编辑」；沿用现有一次确认。

创建成功显示完整 Key、按钮「复制」「完成」，只保留一句「完整 Key 仅显示一次，请复制保存。」。示例自动填实际域名和当前 Key 授权范围内的模型，保留真实协议选择；Key 值通过现有环境变量方式输入，不从列表掩码假造。没有 Key 时仍可阅读地址、组和示例，不增加首次调用流程。

### 2.4 使用记录

默认五列：时间、模型、来源、结果、费用。模型或行内「详情」链接打开详情。来源使用已有 `web_chat/api` 数据，显示「网页聊天 / API」。结果显示用户能理解的执行结果；待结算或费用未知不显示 `$0`。

请求 ID、组、上下游协议、上游模型、重试次数放入详情；Token 用量与价格快照按需展开。管理员仍可使用完整技术列表。筛选保留现有时间、模型、执行和计费状态能力，次要筛选收进「更多筛选」。

### 2.5 状态短文案

| 情况 | 文案 / 行为 |
| --- | --- |
| 新对话 | 有什么想聊的？ |
| 未登录输入 | 登录后发送 |
| 普通输入 / 生成 | 发送 / 停止 |
| 停止 / 失败 | 已停止 / 生成失败 |
| 复制完成 | 已复制 |
| 模型读取 | 正在加载模型… |
| 无授权模型 | 暂无可用模型 |
| 历史模型不可用 | 此模型已不可用，请重新选择 |
| 历史读取失败 | 对话加载失败 · 重试 |
| 无历史 | 还没有对话 |
| 费用期间无数据 | 本期间暂无费用记录 |
| 使用记录无数据 | 还没有使用记录 |
| 主动筛选无结果 | 没有符合筛选条件的记录 · 清除筛选 |
| 金额待结算 / 未知 | 待结算 / 费用未知 |
| Key 保存 / 撤销成功 | 已保存 / 已撤销 |
| 无 Key | 还没有 API Key · 创建 Key |
| 注册关闭 | 当前未开放注册 |

正常状态不叠加说明卡。字段错误留在字段旁；可恢复的请求失败只给一次简短提示和可执行动作。

## 3. 数据与组件设计

### 3.1 已核到的调用链

以下根路径缩写用于本文件所有任务表，均为仓库相对路径，展开后是唯一文件：

- `W` = `apps/web/src`
- `S` = `apps/worker`
- `C` = `packages/contracts/src`
- `A` = `packages/api-client/src`

| 模块 | 已有调用链与缺口 |
| --- | --- |
| 聊天目录 | `S/chat/models.ts` → `S/chat/routes.ts` → `C/chat.ts` → `A/chat.ts` → `W/features/chat/api.ts` → `hooks/useModelSelection.ts` → `components/ModelPicker.tsx` → `W/pages/chat/ChatPage.tsx`。目录有组、倍率、模型和输出技术上限，缺实际价格。 |
| 聊天发送 | `ChatPage.tsx` → `hooks/useChatController.ts` → `model/controller.ts`、`model/operation.ts`、`model/regenerate.ts` → `A/chat.ts`。这些位置有输出上限的状态或传参，需要完整清理；hook 已有 onDetailConfirmed 回调，可接费用查询失效，无需改控制器执行路径。 |
| 费用 | `S/billing/entry-queries.ts` → `entry-routes.ts` → `C/billing.ts` → `A/billing.ts` → `W/features/billing/api.ts` → `W/pages/billing/BillingPage.tsx`、`BillingTable.tsx`。日期后端已支持，前端 `BillingFilters` 仅 Pick `kind/requestId`；条目缺模型/来源，响应缺全期间消费汇总。 |
| 余额 | `S/billing/balance-routes.ts` → `C/account.ts` → `A/account.ts` → 当前 `features/dashboard/api.ts`、`BalanceCard.tsx`。复用余额接口，查询和卡片迁入 billing，移除 dashboard 专属实现。 |
| Key | `S/auth/key-groups.ts` → `key-routes.ts` → `C/keys.ts` → `A/keys.ts` → `W/features/api-access/api.ts` → `useKeyForm.ts`、`KeyForm.tsx`、`KeysPage.tsx`。组目录仅有 id/name/models，补真实展示数据；CRUD 与一次性明文机制已有。 |
| 使用记录 | `S/gateway/request-query-routes.ts` → `C/requests.ts` → `A/requests.ts` → `features/request-history/api.ts`、`filters.ts`、`useRequestPages.ts` → 列表/详情。模型、来源、费用、执行与结算状态已提供，本次不重做该接口。 |
| 注册 | `C/auth.ts` 的 `publicSettings.registrationMode` 经 session 暴露；`RegisterForm.tsx` 已识别关闭注册，`LoginPage.tsx` 的注册链接目前无条件显示。 |

相关存储已具备：`models.sell_prices_json`、`groups.billing_multiplier`、组与渠道关系，`requests.public_model_id/source/group_id`，`billing_entries.request_id/delta_units/created_at`。本计划无需数据库迁移。

### 3.2 模型选择：沿用真实组身份

- 统一 picker 将现有授权目录平铺为选项；每项仍对应一个 `(groupId, publicModelId)`，以该元组的规范 JSON 编码作为内部键。
- 不按 modelId 跨组去重。同名模型属于不同组时，使用「模型名 · 真实组名」区分；价格不同再显示各自实际输入/输出报价。即使模型名、价格相同，也保留不同组身份，因为现有组可能关联不同渠道池；不据此推测服务等级或自动合并。
- 模型名唯一时省略组名；只有一个有效元组选项时静态显示，不出现下拉。价格细项按需展开，不常驻倍率、技术限制等解释。
- 新对话沿用最近有效元组，否则使用现有目录默认顺序的首个可用项。既有会话保持原 groupId/modelId；原选项不可用时提示重选，不静默换组。继续使用现有按用户隔离的偏好存储。
- 聊天模型补 `sellPrices`；Key 组补 `billingMultiplier` 和按 modelId 索引的 `modelPrices`。复用 `C/models.ts` 的 sellPricesSchema，以原始十进制价格字符串传输。
- 一个共享纯函数计算「基价 × 组倍率」并格式化为 USD/百万 Token，供 picker 和 Key 表单使用。缺少报价显示「价格暂不可用」，不当作免费。授权查询、渠道关联和选路保持现状，不增加目录服务。

API 创建时唯一真实授权组自动选，多组显示真实组名、模型范围和价格；编辑既有 Key 保留其 groupId。`A/chat.ts`、`A/keys.ts` 及 feature API 已调用相应合同解码器，扩展字段会随已有类型传递，无需另建客户端接口。

### 3.3 费用：完整期间汇总与真实来源

- 复用 `/api/v1/billing/entries`，增加响应中的 `summary`：`currency`、`consumptionUnits`、`createdFrom`、`createdBefore`。消费是选定日期全部 `kind=consumption` 的 `-delta_units` 精确总和，范围只受当前用户与日期约束。
- 服务端用独立聚合查询计算所选完整期间消费，不受明细 kind/requestId、LIMIT 或 cursor 影响。首屏响应携带汇总，续页只追加明细；自动刷新沿用现有查询重取机制。既有明细游标和水位规则不改，不增加跨页协调协议。
- 使用数据库整数聚合并以十进制文本返回，金额在客户端继续走现有单位格式化。成功查询的空期间可返回真实 `0`；请求失败、缺少响应或未知费用不可显示假 0。
- 条目通过 `request_id` 左连接 `requests`，增加可空 `modelId/source`；无关联请求的授额、调整仍完整保留。请求 ID 收进「查看记录」链接，模型/来源直接可读。
- 日期用浏览器当前时区定义本月起点和下月起点，传已有 UTC 毫秒 `createdFrom <= t < createdBefore`；日期结束项包含所选当天，转为下一天零点的排他上界。URL 保存明确边界，清除额外筛选回到本月。
- 个人页读取汇总；共用 schema 允许 admin 响应省略 summary，管理表继续保持既有信息。新增条目字段可空并兼容旧响应。

### 3.4 API 地址、授权模型与协议

生产域名依据当前部署为 `https://cheapai.dev`。运行时使用页面实际同源 origin：SDK Base URL 展示 `${origin}/v1`，curl 地址为 `${origin}/v1/<endpoint>`，避免重复 `/v1`。本地 Vite 增加 `/v1` 到本地 Worker 的代理，使展示地址与服务一致。

示例模型集合来自现有 key-groups：选中 Key 时取其真实组模型与 `allowedModels` 的交集；新建成功使用返回的 Key 元数据；尚无 Key 时用当前可用组的模型。空授权集合显示「暂无可用模型」，不用 `YOUR_MODEL_ID` 冒充已完成示例。

保留 Chat Completions、Responses、Messages 三种已有对外协议示例，并沿用各自请求形状。Messages 的 `max_tokens` 属于外部协议参数，继续保留。这里的协议选择不是内部上游协议标签，也不新增可用性探测或试调用。

### 3.5 组件边界

页面负责组合和 URL；feature 负责查询、状态和业务组件；跨 feature 通过 `public.ts`；shared 只放通用 UI 或纯函数。新增账户菜单由 session feature 提供公开入口，个人布局和聊天布局复用。费用查询独立留在 billing，通过 public.ts 暴露查询失效函数；聊天 hook 的已有完成回调调用该函数。费用查询自身启用进入页面和回到窗口重取，不改全局查询默认值。

## 4. 文件级开发任务

表内「改/新/删」明确文件操作；每行列出的文件是该任务全部修改范围。依赖为直接前置节点，隐含包含其祖先。开发与验证按第 1 节规则分开执行。

### 4.1 导航与入口

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| N01 | DOC01 | 新 `W/features/session/AccountMenu.tsx`；改 `W/features/session/public.ts`（2） | 公开复用账户菜单：费用、使用记录、管理员入口、退出；匿名显示登录；API 接入链接作为同一导航组件的一部分，移动端可见。 |
| N02 | N01 | 新 `W/app/layouts/PersonalLayout.tsx`（1） | 组合品牌、账户导航和 Outlet，费用/API/记录页面使用无侧栏个人布局。 |
| N03 | N01 | 改 `W/features/chat/components/ChatLayout.tsx`（1） | 接入账户导航，删除工作台模式切换；保留聊天历史抽屉和内容区域。 |
| N04 | N01 | 改 `W/app/layouts/ConsoleLayout.tsx`；改 `W/app/layouts/AdminLayout.tsx`（2） | ConsoleLayout 收敛为管理布局，去掉个人模式和模式切换；管理侧栏保留，返回链接直达聊天。 |
| N05 | N04 | 改 `W/app/navigation.ts`；改 `W/app/guards/AdminBoundary.tsx`（2） | 删除个人控制台导航定义，保留 adminNavigation；非管理员提示后的返回入口指向 `/`。 |
| N06 | N02, N05, B06 | 改 `W/app/router.tsx`；删 `W/pages/dashboard/DashboardPage.tsx`（2） | 个人受保护路由改用 PersonalLayout；`/dashboard` replace 到 `/billing`；删除 DashboardPage 的 lazy 引入及文件。 |
| N07 | N06, B04 | 删 `W/features/dashboard/api.ts`；删 `W/features/dashboard/BalanceCard.tsx`（2） | 删除已被 billing 接管的 dashboard 专属查询、余额卡；不留下对旧 feature 的业务引用。 |
| N08 | N03 | 改 `W/pages/auth/LoginPage.tsx`；改 `W/pages/auth/RegisterPage.tsx`；改 `W/features/session/RegisterForm.tsx`（3） | 根据同一 registrationMode 呈现注册入口；closed 时入口隐藏、直达注册页显示一致短文案；登录/注册跳转保留 returnTo。 |

### 4.2 真实模型目录

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| M01 | DOC01 | 改 `C/chat.ts`；改 `C/keys.ts`（2） | 复用现有 sellPricesSchema；聊天模型补 sellPrices，Key 组补 billingMultiplier/modelPrices，原 id/name/models 语义保留；缺失报价可明确呈现。 |
| M02 | M01 | 改 `S/chat/models.ts`（1） | 在现有授权目录查询中读取 sell_prices_json 并返回 sellPrices；保留原组/模型身份、授权条件和技术上限。 |
| M03 | M02 | 改 `S/auth/key-groups.ts`（1） | 现有组目录补 billingMultiplier/modelPrices，价格来自已授权模型；原 models 列表和实际渠道关联保持现状。 |
| M04 | M01 | 新 `W/shared/lib/model-price.ts`（1） | 提供十进制基价乘倍率及金额展示的纯函数，供聊天 picker 与 Key 表单复用；不增加新服务或目录协议。 |
| M05 | M02, M04 | 新 `W/features/chat/model/model-options.ts`；改 `W/features/chat/hooks/useModelSelection.ts`（2） | 将现有目录平铺为保留 groupId/modelId 的选项；提供统一 selectOption；新对话使用最近有效值，历史会话保持原身份，不跨组去重。 |
| M06 | M05 | 改 `W/features/chat/components/ModelPicker.tsx`（1） | 两级选择收敛为一个控件；单项静态显示；同名跨组选项附真实组名，必要时展示实际价格；移除输出上限解释。 |

### 4.3 聊天交互

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| H01 | M06, N03 | 改 `W/pages/chat/ChatPage.tsx`；改 `W/features/chat/components/Composer.tsx`（2） | 删除 output/ceiling 状态和控件、send/regenerate 传参；模型选择移到输入区域且仅保留一处；移除提示卡和大装饰；匿名按钮「登录后发送」保留草稿；生成时「停止」。 |
| H02 | H01 | 改 `W/features/chat/model/controller.ts`；改 `W/features/chat/model/operation.ts`；改 `W/features/chat/model/regenerate.ts`（3） | 仅删除 maxOutputTokens 命令字段、快照字段与透传片段；发送、重答、恢复和取消的执行分支保持原结构。 |
| H03 | H02 | 改 `A/chat.ts`（1） | 删除网页聊天发送/重答请求体中的输出上限序列化及 bodyWithOutput helper。`C/chat.ts` 可保留服务端兼容输入声明；网页入口和网络请求不再生成该字段，外部 `/v1` 参数不改。 |
| H04 | H01 | 改 `W/features/chat/components/Message.tsx`；改 `W/features/chat/components/MessageActions.tsx`；改 `W/features/chat/components/MessageList.tsx`（3） | 显示消息真实 modelId；移除已完成徽标和时间行；仅最新轮显示重答，真实多版本才显示切换；删除常驻禁用原因，保留短停止/失败状态与复制。 |
| H05 | H01 | 新 `W/features/chat/components/ConversationRow.tsx`；改 `W/features/chat/components/ConversationSidebar.tsx`；改 `W/pages/chat/ChatPage.tsx`（3） | 抽出历史行，行内改名 Enter 保存/Escape 取消；复用 history.renameConversation，移除改名弹窗，删除弹窗继续独立保留。 |
| H06 | H05 | 改 `W/features/chat/components/ConversationSidebar.tsx`；改 `W/features/chat/hooks/useHistory.ts`（2） | 以列表底部可见哨兵触发既有 loadMore；保留已有分页并发控制；去掉常驻加载更多按钮；失败暂停自动续页并显示重试。 |
| H07 | H03, H04, H06 | 改 `W/features/chat/components/ChatNotice.tsx`（1） | 余额不足链接直达 `/billing`；错误文案缩短为状态和现有恢复动作，正常状态不出现说明卡。 |

### 4.4 费用数据与页面

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| B01 | DOC01 | 改 `C/billing.ts`；改 `A/billing.ts`（2） | 增加可空模型/来源与 summary schema/type/decoder 导出；日期仍用原 BillingQuery。个人响应带汇总，管理响应兼容省略汇总。 |
| B02 | B01 | 改 `S/billing/entry-queries.ts`；改 `S/billing/entry-routes.ts`（2） | 左连接请求事实返回模型/来源；首屏附完整日期期间的消费聚合，独立于明细类型、requestId 和分页；沿用已有游标及快照规则。 |
| B03 | B02 | 改 `W/features/billing/api.ts`；新 `W/features/billing/filters.ts`（2） | 接通日期参数、本月/结束日边界及 URL；提供余额查询和按用户失效函数；费用查询启用 mount/focus 重取，沿用无限查询分页，不设轮询。 |
| B04 | B03 | 新 `W/features/billing/BillingSummary.tsx`（1） | 组合紧凑余额与期间消费；直接消费后端精确单位字符串；正常态无刷新和充值按钮，失败提供重试。 |
| B05 | B03 | 改 `W/features/billing/BillingTable.tsx`（1） | 个人列改为时间、类型/模型、来源、金额、记录入口；增加空态参数；admin scope 保持其技术字段。 |
| B06 | B04, B05 | 改 `W/pages/billing/BillingPage.tsx`（1） | 接入余额、汇总及默认本月日期；日期/类型直接生效，删除请求 ID 输入和应用按钮；兼容旧 requestId URL，完成两种空态。 |
| B07 | B06, H07 | 新 `W/features/billing/public.ts`；改 `W/features/chat/hooks/useChatController.ts`（2） | 公开 B03 的费用查询失效函数；在已有聊天完成回调中标记该用户余额/费用过期，覆盖发送、重答和停止后确认；保持控制器执行流程不变。 |

### 4.5 API 接入

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| K01 | M03, M04 | 改 `W/features/api-access/key-form-model.ts`；改 `W/features/api-access/useKeyForm.ts`（2） | 创建预填可编辑名称；唯一组自动选，多组保持真实选择；编辑成功调用现有 onChanged 后关闭。保留既有创建操作和一次性明文生命周期。 |
| K02 | K01 | 改 `W/features/api-access/KeyForm.tsx`；改 `W/features/api-access/KeyTable.tsx`（2） | 表单单组静态、多组展示真实范围与价格；列表向页面回传选中 Key 元数据供示例使用；「编辑」与唯一「撤销」入口分明。 |
| K03 | K02 | 改 `W/features/api-access/KeySecretDialog.tsx`（1） | 成功态仅保留一次性说明、完整 Key、「复制」「完成」；完成沿用已有清除 secret 行为。 |
| K04 | M03, M04 | 新 `W/features/api-access/integration-model.ts`；改 `W/features/api-access/IntegrationGuide.tsx`（2） | 纯函数构造同源 Base URL、已授权模型及三种协议示例；组件接收 Key 元数据/组目录，动态输出真实域名和模型；保留必要协议参数。 |
| K05 | K04 | 改 `apps/web/vite.config.ts`（1） | 增加 `/v1` 本地 Worker 代理；开发页面显示的同源 API 地址可达，不把生产域名写死进开发示例。 |
| K06 | K03, K04, K05 | 改 `W/pages/keys/KeysPage.tsx`（1） | 删除外层 Tabs 和重复控制台标题；同页组合地址、Key、示例；复用 keyGroupsQueryOptions，选中/新建/编辑后将真实 Key 元数据提供给示例；无 Key 正确显示创建入口。 |

### 4.6 使用记录

| ID | 依赖 | 精确文件（数量） | 修改与目标状态 |
| --- | --- | --- | --- |
| U01 | DOC01 | 新 `W/features/request-history/presentation.ts`；改 `W/features/request-history/RequestTable.tsx`（2） | 集中结果与费用文案；personal 默认五列，admin 保留技术列；将详情链接放到模型/详情动作，未知费用不用 0 替代。 |
| U02 | U01 | 改 `W/pages/requests/RequestsPage.tsx`（1） | 标题改「使用记录」；常用时间/模型筛选与更多筛选分层；保留 useRequestPages 和 URL 回退；传入未使用/筛选无结果两种空态。 |
| U03 | U02 | 改 `W/pages/requests/RequestDetailPage.tsx`（1） | 首屏展示时间、模型、来源、结果、费用；技术字段归入详情区域；Token 与 PriceSnapshot 放入可展开区；保持管理员复用入口及返回筛选链接。 |

## 5. 文档任务

文档任务与开发、验证、发布分别登记，不夹在开发任务末尾。

| ID | 依赖 | 精确文件（数量） | 目标状态 |
| --- | --- | --- | --- |
| DOC01 | 无 | 新 `docs/ux-redesign-plan.md`（1） | 本次交付：基线、设计、数据口径、任务与依赖完整可执行。 |
| DOC02 | N07, N08, H07, B07, K06, U03 | 改 `docs/user-guide.md`；改 `docs/frontend-react-contract-map.md`（2） | 实施后更新聊天/费用/API/记录路径、价格字段和汇总口径；移除工作台及输出上限用户说明。 |

## 6. 模块验证与一次最终集成

只安排三个完整模块验证和一次最终集成。模块完成后复用现有对应测试与正常浏览器流程；仅在旧字段、控件或文案变化导致原断言不再适用时，适配现有测试。未覆盖的展示做一次正常流程验收，不预排测试修改任务，不扩测试体系。结果统一回填本计划。

| ID | 依赖 | 范围与目标状态 |
| --- | --- | --- |
| V01 | N07, N08, H07, B07 | 聊天与导航完整验证：登录保留草稿→发送/停止→最新重答/真实版本→历史改名/自动续页；模型单控件、真实组身份和报价；头像入口、旧 dashboard 跳转、注册关闭一致及管理区独立。复用现有聊天、登录与导航检查，宽窄屏各走一次。 |
| V02 | B07, U03, N07 | 费用与使用记录完整验证：本月/自选日期与类型直接生效，跨页不改变完整期间消费，余额自动更新；明细→五列使用记录→展开详情→返回筛选；授额/调整口径、未知费用和两种空态正确。复用现有费用及个人记录检查。 |
| V03 | K06, N06 | API 接入完整验证：同页地址/Key/示例，创建→复制→完成，编辑保存即关闭，唯一撤销入口；单组自动选、多组保留身份及实际报价；示例使用所选 Key 授权模型和真实协议。复用现有 Key 合同、生命周期与页面检查。 |
| V04 | V01, V02, V03, DOC02 | 最后集中集成一次：执行现有全仓检查与浏览器流程，确认三个模块组合后的行为，记录结果。 |

V04 使用现有命令：

```sh
pnpm run check
pnpm run lint:web
pnpm run lint:shared
pnpm run format:check:web
CHEAPAI_E2E_REUSE_BUILD=1 pnpm run test:e2e
```

`check` 已包含 typecheck、test、build，不再分别重复。后续只有新增修改或真实失败才重跑对应检查。

## 7. 依赖、串行与并行安排

任务表是依赖的唯一依据，执行分为以下几条链：

- 导航：N01 → N02/N03/N04 → N05；B06 可承接费用后，由 N06 切路由、N07 删除旧 dashboard；N08 完成注册入口。
- 聊天：M01 定价格字段，M02/M03 补目录，M04 提供纯函数，M05/M06 接 picker；H01–H07 完成交互，B07 接已知消费变动后的刷新。
- 费用与记录：B01–B06 完成数据到页面，U01–U03 完成记录呈现；B07 完成刷新接线。
- API：M03/M04 后，K01–K03 完成 Key 表单，K04/K05 完成示例与地址，K06 组合页面。
- 文档更新 DOC02 与三个模块验证完成后进入 V04；通过后 P01 → P02 → P03。

导航、费用、使用记录可并行；目录价格字段确定后，聊天与 API 可并行。共享文件必须串行：

| 文件 | 修改顺序 |
| --- | --- |
| `W/pages/chat/ChatPage.tsx` | H01 → H05 |
| `W/features/chat/components/ConversationSidebar.tsx` | H05 → H06 |
| `W/app/router.tsx` | 只由 N06 修改，等待 B06 |
| `docs/ux-redesign-plan.md` | DOC01 后由单一记录者汇总模块结果，再写 V04、P01–P03 结果 |

其余开发任务的修改文件互不重叠。组件仍按页面、feature、shared 的现有边界组织，不借本轮扩大基础架构。

## 8. 发布准备与验收（未来节点）

复用当前实际 PR 预发与生产机制：PR 的 Worker/URL 独立，底层 D1、KV 和 Gate 共享；旧独立 staging 已退役，二者不混淆。发布仍使用现有 Worker 与静态资源单元。

| ID | 依赖 | 精确记录文件（数量） | 目标状态 |
| --- | --- | --- | --- |
| P01 | V04 | `docs/ux-redesign-plan.md`（1） | 记录候选提交、现有 PR 预发结果及 `production:check` 结果；本次无数据库迁移。 |
| P02 | P01 | `docs/ux-redesign-plan.md`（1） | 按 `docs/deployment.md` 发布同一候选版本，记录部署标识和上一版本。 |
| P03 | P02 | `docs/ux-redesign-plan.md`（1） | 一次集中发布验收：主页聊天入口、头像费用/记录、API 同页与真实地址、旧 `/dashboard` 跳转、注册入口、管理员独立入口；记录结果。 |

发布验收以用户任务为准：聊天无需先建 Key；模型选择与实际组/报价一致；费用合计覆盖整个期间；API 地址与示例可直接配置；使用记录能追溯且未知金额不冒充零。需要回退时沿用现有 `docs/rollback.md`，回到上一完整 Worker/前端版本。

## 9. 简短完成清单

共 46 个节点：37 个开发任务（导航 8、模型 6、聊天 7、费用 7、API 6、记录 3），2 个文档任务、3 个模块验证、1 次最终集成、3 个发布节点。

- [x] 只读核到最新 main 基线和调用链。
- [x] 完成全量 UX 目标、删留、短文案与数据口径。
- [x] 每个开发任务明确 ID、依赖、1–3 个精确文件和目标状态。
- [x] 文档、开发、模块验证、集中集成、发布分别列出。
- [x] 静态核对：依赖无环且无缺失 ID，开发任务均为 1–3 文件，共享文件修改顺序明确；已核对价格解码、费用刷新和 Key 选择的调用方。
- [x] 开发实施：N01–N08、M01–M06、H01–H07、B01–B07、K01–K06、U01–U03。
- [x] 模块验证与最后一次集中集成。
- [ ] 经授权的发布与验收。

计划制定无剩余阻塞。

## 10. 本分支实施记录

- 使用六个 `gpt-6-luna`、`max` 子代理并行完成独立模块，使用可用的 `priority` 档位；共享文件按任务依赖串行。
- 模型目录相关现有检查：4 个文件、26 项通过。
- 聊天输入、控制器和客户端现有检查：3 个文件、17 项通过。
- 费用条目与使用记录分页现有检查：4 个文件、31 项通过。
- API Key 生命周期现有检查：2 个文件、10 项通过。
- 模块完成后适配现有测试的旧控件、文案及响应断言；未新增测试框架或测试矩阵。
- 集成检查发现并修正费用组件可选属性类型；全仓类型、两项 lint、格式检查通过，207 个测试文件共 3,876 项通过，前端构建与 Worker dry-run 通过。Worker 首次 dry-run 遇到本机默认配置目录不可写，使用临时 `XDG_CONFIG_HOME` 后通过，未修改仓库配置。
- 既有浏览器套件 44 条全部通过：首轮 43 条通过，1 条旧侧栏导航断言改为顶部链接/头像菜单后单独重跑通过。测试数量保持不变。
- 使用构建产物完成一次桌面 1440×1000、移动端 390×844 正常流程验收：匿名草稿登录后手动发送、真实组/模型选择、行内改名、费用日期/类型/期间汇总、五列使用记录与详情展开、API 同源地址及授权示例。未添加仓库测试文件。截图复核后修正用户消息复制按钮对齐和窄屏 Key 状态换行。
- 推送、draft PR 和 CI 结果将在完成后补充；尚未合并或发布生产。
