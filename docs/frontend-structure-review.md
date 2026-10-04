# cheapai 前端代码风格与结构审查

审查日期：2026-10-04。代码基线：`2b5b6b0`。本轮只增加审查记录，未修改业务实现。

## 范围与方法

覆盖 React `apps/web/src`、`packages/api-client/src`、`packages/contracts/src` 的文件规模、静态依赖、调用位置、样式变量和依赖使用情况；深入检查身份与应用装配、聊天、个人控制台、管理资源、运营页面、表单和共享 UI。补充检查与本次前端重构关联的 Worker 管理详情接口及用户投影。没有将既有 Worker 网关、协议转换和全部后端实现宣称为本轮完整人工审查范围。

| 范围 | 文件数 | 行数 |
| --- | ---: | ---: |
| React 源目录，含测试与样式 | 155 | 13,440 |
| React 排除测试文件和 test 目录 | 145 | 12,306 |
| API client | 20 | 1,446 |
| Contracts | 14 | 1,220 |

执行一次 `pnpm --filter @cheapai/web lint`，通过。没有执行全量单测、构建或预发写入。以下行为影响由源代码调用链确认；并未声称已经用浏览器复现所有竞态。

整体的 `app / pages / features / shared` 分层、框架无关 contracts/API client、路由懒加载以及聊天 reducer/operation/reconcile 分离值得保留。目前主要问题是规则和职责尚未收敛：相同能力有多种实现，局部抽象已经定义但没有成为实际使用入口。

优先级：P2 为应安排修复的行为或维护问题，P3 为低风险精简项。本轮记录 11 项 P2、3 项 P3；没有发现足以在这次结构审查中判为 P0/P1 的问题。

## 具体发现

### R01 · P2 · 会话详情同时由 Query 和 controller 独立读取

位置：[useChatController.ts](../apps/web/src/features/chat/hooks/useChatController.ts)，34、45–52 行；[controller.ts](../apps/web/src/features/chat/model/controller.ts)，798–818 行；[chat/api.ts](../apps/web/src/features/chat/api.ts)，58–65 行。

打开尚未加载的 `/chat/:id` 时，`useQuery` 调用 `api.getConversation`，effect 又调用 `controller.loadConversation`，后者直接调用同一接口。第二条路径不经过 Query，无法使用它的请求去重、错误和加载状态。于是 controller 可能已经有详情，页面仍显示另一条查询的加载或错误；后到的 Query 结果还会触发 `hydrate`。`hydrate` 在没有 activeRun 时直接替换详情，不能仅依赖现有发送锁保证版本不回退。

建议：普通路由详情读取只保留一个权威入口。Query 负责读取并将结果交给 controller；路由切换通过明确的 controller 命令同步取消/清空状态。发送后的最终核对仍留在 operation 流程内。最终状态是同一次页面进入只产生一条普通详情读取，展示状态与详情来源一致，旧版本快照不能覆盖新版本。

### R02 · P2 · 跨功能保存后的缓存更新没有统一归属

位置：[ChannelsPage.tsx](../apps/web/src/pages/admin/ChannelsPage.tsx)，48–52、83–89 行；[admin-groups/api.ts](../apps/web/src/features/admin-groups/api.ts)，15–21、53–55 行；[GroupForm.tsx](../apps/web/src/features/admin-groups/GroupForm.tsx)，131–136 行；[GroupDetailPage.tsx](../apps/web/src/pages/admin/GroupDetailPage.tsx)，29–33 行。

渠道引导使用 `['admin', 'groups', actor, epoch, 'setup-candidates']`，组页面使用 `['admin-groups', actor, ...]`。完成关联访问组后，只刷新引导候选和渠道缓存，没有更新真实组详情、组列表和模型映射缓存。已经加载过的组详情或映射页面可能继续展示旧关系/版本，直到缓存过期或重新读取。

另一方向也存在问题：编辑组只失效 `admin-groups`，不会失效引导候选。再次打开引导时可能拿到旧 version。组表单先 await 根失效，再通知详情页；详情页再失效列表，形成重复刷新。映射编辑也有子表单先失效、父面板再失效的重叠。

建议：资源所属 feature 提供明确的“资源已保存”缓存入口，由一次操作的一个层级负责调用；其他页面通过公共入口使用，禁止手写资源内部 key。跨资源引导按已保存的 channel、mapping、group 更新对应缓存。不要为了同一实体强行将所有列表形状合成一个缓存项。

### R03 · P2 · 游标分页规则分散，防重复与合并策略不一致

位置：[admin-users/api.ts](../apps/web/src/features/admin-users/api.ts)，45–50、67–72 行；[admin-audit/api.ts](../apps/web/src/features/admin-audit/api.ts)，8–11 行；[admin-models/api.ts](../apps/web/src/features/admin-models/api.ts)，29 行；[api-access/api.ts](../apps/web/src/features/api-access/api.ts)，31 行；[billing/api.ts](../apps/web/src/features/billing/api.ts)，23 行；[个人 RequestsPage.tsx](../apps/web/src/pages/requests/RequestsPage.tsx)，64–94、118–121 行。

用户、审计、管理账单等自行复制重复游标检查；模型、渠道、访问组、个人账单、Key 列表没有同样的保护。个人请求又在 `useQuery` 之外用 state/effect 手工累计分页，聊天历史另有游标环检测和版本去重。重复 cursor 会在部分列表中持续提供“加载更多”，个人请求可能不断尝试同一页。直接 flatMap 的资源列表也没有统一去重策略。

建议：抽取小型纯函数，统一游标终止/环检测、分页错误重试和按 ID 合并规则；版本化实体明确保留较新版本。个人请求的 URL cursor 深链需要保留，可使用专用 hook 承载累计页状态，不能直接删掉 URL 行为。无需引入配置驱动的通用 CRUD 页面框架。

### R04 · P2 · 筛选表单重复实现时间转换，URL 与输入框不同步

位置：[个人 RequestsPage.tsx](../apps/web/src/pages/requests/RequestsPage.tsx)，36–57 行；[KeyForm.tsx](../apps/web/src/features/api-access/KeyForm.tsx)，41–52 行；[管理 RequestsPage.tsx](../apps/web/src/pages/admin/RequestsPage.tsx)，30–43 行；[AuditPage.tsx](../apps/web/src/pages/admin/AuditPage.tsx)，20–32 行。

个人请求和 Key 各自实现 epoch 与 datetime-local 转换；管理请求和审计再用内联 FormData 实现转换。管理请求/审计的 URL 已有 from/to 时，日期输入框没有 defaultValue，仍显示为空；只更改其他筛选条件并提交会删除原来的时间范围。此处已有实际行为分歧，不能只做格式整理。

建议：扩展共享 datetime 工具提供本地输入格式化/解析，feature 负责自己的支持字段和合法区间。让页面草稿明确从 URL 初始化及同步；先修复已存在筛选条件被隐式丢弃的问题。

### R05 · P2 · 聊天 controller 是明显的职责集中点

位置：[controller.ts](../apps/web/src/features/chat/model/controller.ts)，160–888 行。

全文件 888 行，单个 factory 覆盖订阅通知、身份生命周期、pending registry、路由加载、创建会话、发送、流事件处理、最终快照重试、再生成、版本选择、停止和销毁。`performOperation`、`reconcileFinalSnapshot` 与 `performSend` 各自约 75–120 行，密集修改相互依赖的闭包状态。模块级 `pendingOperations` 还承担跨 controller 生命周期的保留职责。

建议：按真实职责逐步提取 pending registry、流执行与最终确认、版本选择执行三个内部模块，controller 保留唯一运行锁、状态分发及身份/路由协调。跨实例 pending 保留必须有明确生命周期，不能改成每次卸载都丢弃。避免同时建立新的 controller 类、事件总线或额外状态管理库。

### R06 · P2 · 大型表单同时承担字段、schema、转换和操作生命周期

| 文件 | 行数 | 集中职责 |
| --- | ---: | --- |
| [MappingForm.tsx](../apps/web/src/features/admin-models/MappingForm.tsx) | 365 | 能力草稿转换、映射选择、双查询、版本冲突、保存、两栏展示 |
| [ChannelSetup.tsx](../apps/web/src/features/admin-channels/ChannelSetup.tsx) | 350 | 三步草稿、校验、controller 桥接、候选和所有步骤 UI |
| [KeyForm.tsx](../apps/web/src/features/api-access/KeyForm.tsx) | 336 | 创建/编辑、pending intent、身份及挂载保护、授权候选、一次性明文交接 |
| [ChannelForm.tsx](../apps/web/src/features/admin-channels/ChannelForm.tsx) | 323 | 手工字段校验、限额转换、凭据语义、创建结果不明、表单 UI |
| [UserForm.tsx](../apps/web/src/features/admin-users/UserForm.tsx) | 269 | 双模式 schema、初始化、组候选、权限保存、对话框 |

建议先提取 feature 内 `*-form-model.ts` 的草稿 schema、初始值、转换和 patch 生成；再将复杂生命周期放入专用 hook。渠道引导可按完整步骤提取视图组件。组件边界依据职责确定，200–250 行只作复审提示，不作为必须拆分的硬限制。

表单与 contracts 的重复值得一起清理。例如 MappingForm 自建协议数组和弱化后的字段 schema，再在 transform 内调用 contract.parse；GroupForm 自建 name/channelIds 校验，再重复排序/去重；ModelForm 重复价格字符串规则。优先复用 contract 字段，UI 只负责空字符串等输入形态转换，再 pipe 到正式 schema。现有 Zod resolver 会捕获 ZodError，不能把 transform 内 parse 一概描述为当前必然产生未捕获异常；问题在于重复规则及 schema 组合方式不稳定。

### R07 · P2 · 品牌与 design tokens 有定义，但没有成为统一入口

位置：[brand.ts](../apps/web/src/shared/brand.ts)；[tokens.css](../apps/web/src/shared/styles/tokens.css)；[ConsoleLayout.tsx](../apps/web/src/app/layouts/ConsoleLayout.tsx)，23–26 行；[ChatLayout.tsx](../apps/web/src/features/chat/components/ChatLayout.tsx)，22 行；[AuthLayout.tsx](../apps/web/src/app/layouts/AuthLayout.tsx)，6 行；[BalanceAdjustmentDialog.tsx](../apps/web/src/features/admin-users/BalanceAdjustmentDialog.tsx)，185 行。

brand 没有生产调用方。控制台使用立方体 SVG，聊天和认证使用字母 c；颜色和侧栏宽度又硬编码。tokens 定义了 87 个变量，其中 52 个在源代码中没有显式 var 引用；声明的间距、圆角、动效等大多被 Tailwind 默认值替代。token 名称还同时有长短两套别名。余额调整 textarea 使用未定义的 `--ring`，这是已确认的变量引用错误；Radix 自行提供的 `--radix-select-trigger-width` 不属于该错误。

建议：确定一种品牌标记，提取 BrandMark/BrandLink；采用一套主要语义变量并按组件迁移。先修复 `--ring`，再区分真实需要的主题变量与尚未使用的设计草案。52 个无引用变量不是自动删除名单；字体/尺寸仍需结合 Tailwind 的实际编译规则判断。

### R08 · P2 · 风格检查未覆盖格式，短文件掩盖复杂代码

位置：[eslint.config.js](../apps/web/eslint.config.js)，82–117 行；[RegistrationCodesPage.tsx](../apps/web/src/pages/admin/RegistrationCodesPage.tsx)，24–31 行；[ChatLayout.tsx](../apps/web/src/features/chat/components/ChatLayout.tsx)，24–27 行；[contracts/users.ts](../packages/contracts/src/users.ts)；[api-client/users.ts](../packages/api-client/src/users.ts)。

生产 TS/TSX 中 35 个文件有超过 240 字符的行；ChatLayout 最长行 660 字符。共享 UI 多数省略分号，业务文件多数使用分号；部分管理页面和 contracts 将完整表单、多个语句或 DTO 压在同一行。当前 lint 只覆盖 React src 的基础 TS、Hooks 和依赖边界；没有 formatter，也没有 API client/contracts 的相应风格检查。因此 lint 通过不能说明这部分风格一致。

建议：采用一套 formatter 规则并覆盖 React、API client、contracts，在独立机械整理批次中执行。复杂事件处理先命名为函数，避免仅把巨大 JSX 换行后宣称结构问题已解决。不要为每个组件增加自定义 ESLint 插件；现有本地边界规则可以保留。

### R09 · P3 · 未使用的封装、别名和直接依赖增加维护面

确认没有实际调用的入口包括 `DetailPanel`、`useToast`、`createGroupCommands`、`createModelMappingCommands`；ToastProvider 虽在根部挂载，却没有通知调用方。`features/admin-registration/public.ts` 只有一个重导出，也没有消费者。brand 的处理见 R07。

API client 的 channels/groups 在模块顶层创建 defaultAuth/defaultClient，并导出 `channelsApi`/`groupsApi` 及 admin 别名；仓库消费者都走注入式 factory。Mappings 同时提供 listMappings/mappings/list、createMapping/create、updateMapping/update 多组别名。当前没有证据需要保持这些内部私有 workspace API 的全部别名。

`@radix-ui/react-separator`、`class-variance-authority`、`clsx`、`tailwind-merge` 作为 web 直接依赖存在，但应用没有引用。

建议：删除确定未使用的封装和直接依赖；API factory 统一必需注入 client，保留确实使用的命名。移除直接依赖不等于保证从锁文件消失，其他包仍可能传递依赖它们。无需为了“用上依赖”重写所有 UI。

### R10 · P2 · shared runtime 反向依赖 feature，造成装配层例外

位置：[shared/api/runtime.ts](../apps/web/src/shared/api/runtime.ts)，4、32 行；[SessionProvider.tsx](../apps/web/src/features/session/SessionProvider.tsx)，3–7 行；[eslint.config.js](../apps/web/eslint.config.js)，24、65–70 行。

runtime 放在 shared，却创建 feature 的 session controller；SessionProvider 又从 runtime 取默认单例。现有 lint 特意为 runtime 豁免 shared → feature 禁令。这属于已经存在的装配层错位，在层级之间形成双向依赖，依赖方向不再能由目录名可靠表达；这不等于已确认 JavaScript 模块初始化存在循环。

建议：将实际实例创建放到 app 装配层，抽出不创建实例的 runtime 类型/Context 接口；SessionProvider 接收注入值。不要让 feature 直接改为 import app/runtime，这会产生另一种反向依赖。最终状态是 shared/feature 只依赖类型和注入接口，app 负责唯一默认实例，删除专用边界豁免。

### R11 · P2 · 查询取消能力在大多数领域 API 中断开

位置：[shared/api/runtime.ts](../apps/web/src/shared/api/runtime.ts)，22–24 行；[api-client/types.ts](../packages/api-client/src/types.ts)，41–45 行；各 feature `api.ts` 的 queryFn；[channel-options.ts](../apps/web/src/shared/catalog/channel-options.ts)，66 行。

底层 transport 支持 AbortSignal，runtime 在身份变化时调用 cancelQueries，但大多数 queryFn 没有读取 Query 的 signal，领域 GET factory 也没有接受 signal 的参数。只有渠道候选明确一路传递 signal。Query 的逻辑取消与缓存清理仍然有用，不能据此声称跨账号缓存一定泄漏；问题是对应 HTTP 读取无法随关闭、切换或退出真正中止，徒增旧读取和恢复处理分支。

建议：为读取方法提供轻量 request options 并传递 signal；UI 不直接绕过领域 API 去调用底层路径。写操作的结果不明规则保持独立，禁止将 GET 的取消策略直接套到收费或创建写入。

### R12 · P2 · 错误展示重复改写，丢失已经支持的诊断信息

位置：[ApiErrorNotice.tsx](../apps/web/src/shared/patterns/ApiErrorNotice.tsx)，5–10 行；[MappingForm.tsx](../apps/web/src/features/admin-models/MappingForm.tsx)，229–235 行；[GroupForm.tsx](../apps/web/src/features/admin-groups/GroupForm.tsx)，137–143 行；[ModelForm.tsx](../apps/web/src/features/admin-models/ModelForm.tsx)，137–140 行；[ChannelForm.tsx](../apps/web/src/features/admin-channels/ChannelForm.tsx)，174–181 行。

共享错误组件能显示和复制 request_id，但多个表单 catch 后只创建普通 Error、拼接文案，丢失原始 ApiClientError 的 request_id/status/code。渠道表单另有自己的 message/requestId 展示结构。结果是同类错误在不同配置页呈现和可追踪信息不同。

建议：抽取错误展示数据转换，保留 message、request_id、原始 cause；feature 可补充冲突或未确认结果的说明。不要合并所有领域的可重试判定：Key 创建、余额调整、非幂等渠道创建具有不同协议约束。

### R13 · P3 · Worker 用户安全投影在列表与详情重复

位置：[user-routes.ts](../apps/worker/admin/user-routes.ts)，25、133–139 行；[user-detail.ts](../apps/worker/admin/user-detail.ts)，2、8–17 行。

两处重复 SELECT 字段、关联组、allowed_group_ids_json 聚合和 JSON 投影；详情类型还反向引用 route 文件里的列表类型。当前投影没有发现泄露密码列，问题在于下一次新增展示字段时容易只更新一处。

建议：提取用户读取 repository 中的安全投影与结果解码；route 只处理授权、筛选和响应。保持显式字段选择，不能改为 SELECT *。四个详情接口本身只有约 113–190 行，不需要为了行数继续拆分。

### R14 · P3 · 少量循环存在直接可简化的重复计算

位置：[MessageList.tsx](../apps/web/src/features/chat/components/MessageList.tsx)，43–66、103–105 行；[GroupForm.tsx](../apps/web/src/features/admin-groups/GroupForm.tsx)，63–64 行。

消息行构建对每个 turn 遍历全部 messages，约 O(turns × messages)，同一组件又计算一次 assistant 分组。组关系比较在 every 的每次迭代都复制并排序右侧数组，约 O(n² log n)。消息行已有 useMemo，不应把它描述为每个流式 delta 都必然重新计算全部分组。

建议：一次建立 turn → 用户/回答分组，供列表和动作共同消费；组 ID 比较各排序一次或使用 Set。当前不需要引入虚拟列表、Worker 计算或额外缓存框架。

## 整理顺序与边界

1. 首先处理 R01/R02/R03/R04：收敛读取、资源缓存更新、分页与筛选行为；避免把行为变化埋在机械格式化中。
2. 然后处理 R05/R06/R10/R11/R12：按职责提取内部模块、表单 model/hook，理顺装配与传输选项。采用连续小批次，常规实现任务控制在 1–3 个文件。
3. 最后处理 R07/R08/R09/R13/R14：统一品牌和主题使用，格式化、删除死代码/依赖、提取投影、简化局部算法。格式化涉及多个文件时应单独形成明确的机械整理批次。

实现任务不附带逐项测试或验证前后条件；完成一整个功能模块或链路后集中检查。需要保留或补充的测试针对读取竞态、缓存行为、游标环、日期筛选、幂等恢复等真实行为，不增加品牌文案严格比较之类的测试。本轮未编写新测试。

金额整数精度与展示精度分离、Key/邀请码明文短生命周期、原 operationId 重试、渠道创建结果不明保护、identity epoch 和 SSE 最终快照确认均有具体业务用途。结构整理必须保留这些约束。仅调用已存在 factory 的短封装可以删减；这些有业务语义的保护不应因为代码较长就被移除。

## 后续实施记录

本节追加于原审查之后，保留上文为代码基线 `2b5b6b0` 的历史记录。以下状态根据当前工作区源码核对；实现采用小批次任务；格式化作为独立机械整理批次，完成模块后统一检查。最终验证记录列在本文末尾。

| 项目 | 当前实现结果 | 留存事项 |
| --- | --- | --- |
| R01 | 普通会话详情读取由 Query 承担，结果交给 controller hydrate；路由切换通过 `syncConversation` 重置 controller。Query 与 API 读取传递 `AbortSignal`。 | controller 中为发送、再生成和最终确认保留的详情读取仍在 operation 流程内。 |
| R02 | 增加 `recordChannelSaved`、`recordMappingSaved`、`recordGroupSaved` 缓存入口，分别更新详情或已有映射数据并刷新所属列表、候选；渠道快速配置调用这些入口。 | 资源的列表形状仍各自缓存，没有合并成通用 CRUD 缓存。 |
| R03 | 增加共享游标终止/重复检测和按 ID 合并函数，已接入管理列表、账单、Key、注册、请求等查询；版本化列表按版本选择较新记录。个人请求由 `useRequestPages` 管理 URL cursor 下的累计页，并隔离用户、session epoch 与筛选条件。重复游标在 Query 分页回调中安全终止，个人请求仍提供错误反馈。 | 聊天历史继续保留自己的游标环检测与会话版本合并规则。 |
| R04 | 共享 datetime helper 负责本地输入的格式化、严格解析和范围校验；个人请求草稿随 URL 筛选同步，管理请求/审计从 URL 初始化日期输入，Key 表单复用共享转换。 | 必要回归测试检查 URL 时间戳不变、导航与返回同步，而非严格比较展示文案。 |
| R05 | controller 已将 pending registry、写操作执行、版本选择执行、最终快照协调和再生成命令拆入独立模块；controller 继续协调唯一运行锁、身份、路由与状态。 | operation 不确定结果的保留与重试语义继续由 controller/pending registry 管理。 |
| R06 | 多个表单已提取 `*-form-model.ts` 与专用 hook，包括 Mapping、Model、Channel、Group、Key 和 User；ChannelSetup 抽出草稿模型和完整步骤视图 `ChannelSetupSteps`。 | 边界依据输入规则、提交生命周期和完整视图职责确定，未按行数建立通用表单框架。 |
| R07 | `brand.symbol` 与共享 `BrandLink` 提供统一的 cheapai 字母 `c`，Console、Chat、Auth 均使用它；控制台侧栏读取 `--sidebar-width`，品牌色使用 `--color-primary`。清除了未消费的间距、尺寸和动效草案变量，并修正了 `--ring` 引用。 | 短变量引用已全部迁移到 `--color-*`，并移除短别名定义；保留被 CSS 或 Tailwind 消费的字体、圆角、阴影变量。 |
| R08 | 根目录已有 Prettier 配置与 `format:web`、`format:check:web` 脚本，覆盖 React、API client 和 contracts；新增共享包 lint 脚本。 | 已完成全量格式整理；CI 同时执行 React lint、共享包 lint 和格式检查。根 ESLint 配置确保共享目录纳入规则，而非被忽略。 |
| R09 | 删除无消费者的 `Toast.tsx`、`DetailPanel.tsx`；Web 直接依赖中移除已确认未使用的包。 | **更正原 R09：** `features/admin-registration/public.ts` 并非无消费者；`features/api-access/secret-lifecycle.test.tsx` 跨 feature 从该 public entry 导入并实际渲染 `CodeBatchDialog`，因此保留该入口。API client 删除未使用的默认实例和 mapping 重复命名；保留当前生产调用的注入式 factory 命名。 |
| R10 | `app/runtime.ts` 创建唯一默认 runtime；`shared/api/runtime.ts` 只导出结构类型。SessionProvider 必须接收注入的 runtime，缺少 Provider 时抛出明确错误；AppProviders 负责装配默认实例，shared → feature 的 lint 特例已移除。 | 身份变化时的 Query 取消/清理条件、identity epoch 和恢复 singleflight 保持原有语义。 |
| R11 | API read options 已将 `AbortSignal` 从 Query 函数传至各领域 API 和 API client transport；写操作没有套用读取取消策略。 | 取消测试覆盖 factory、请求前取消、响应体取消和完整分页 signal 传递。共享 auth bootstrap 的 singleflight 保留。 |
| R12 | 增加 `withErrorContext`，对 `ApiClientError` 保留 kind、status、code、request_id 和 cause；Mapping、Model、Key、User、Group、Channel 表单 hook 已采用。 | 各领域的冲突、幂等和结果不确定性仍分别处理。 |
| R13 | Worker 用户列表与详情共用显式安全投影和解码；详情类型来自共享投影，查询仍明确选择展示列。 | 继续避免 `SELECT *`；列表与详情的权限、字段和整数金额文本语义保留。 |
| R14 | `message-rows.ts` 单次按 turn 建立 user/assistant 分组，MessageList 的时间线和最新 assistant turn 边界复用该结果；`variants.ts` 复用同一排序规则。访问组 channel ID 比较也改为左右数组各排序一次。 | selected variant、active stream 覆盖、用户消息顺序、最新一轮权限规则及滚动锚点保留。 |

## 实施期间保留的业务约束

- 金额以整数单位参与存储和运算，展示精度继续单独处理；访问组倍率仍保留十进制文本语义。
- Key 与邀请码的明文只在交接生命周期中使用，不进入 Query 缓存；secret 生命周期测试仍通过 `admin-registration/public.ts` 使用邀请码对话框。
- 聊天写操作结果不确定时保留原 operationId 和 pending operation 以便恢复；身份 epoch 防止旧身份操作覆盖新状态，SSE 完成后仍通过最终快照确认结果。
- 渠道创建结果不确定时继续阻止盲目重复创建，直到用户通过现有恢复流程确认结果。

## 整合时修复的恢复与竞态问题

- Key form 使用用户 ID 与 session epoch 隔离响应，按请求持有提交锁；旧身份请求完成不能清掉新身份的忙碌状态或交接旧密钥。成功创建后内部关闭可以执行清理，用户仍不能在写入进行时关闭。
- 新会话创建期间 Stop 后仍发布已经创建的会话并同步路由，不发送消息；创建响应不明时恢复草稿、停止普通重复创建，先核对会话列表再明确新建。现有创建接口没有幂等恢复协议，不能冒充消息 operation 的自动恢复。
- 同版本、同毫秒的 generating 快照不能覆盖已持久化 terminal 消息与当轮选中版本；合法版本选择随更高 conversation version 更新。
- 聊天 hook 在 effect 中订阅并清理身份监听，避免 StrictMode 丢弃 render 时遗留 controller 订阅。保存资源前取消旧详情读取，并保留已经缓存的更高配置版本。

## 集中验证记录

- 全工作区 typecheck、React lint、API client/contracts lint 和 Prettier 检查通过。
- 全工作区 build 通过；最后一批仅涉及前端的恢复修复后，再构建 React 产物通过。
- 首轮全量 Vitest：206 个文件、3,870 项，205 个文件通过，只有日期输入规范化的两项断言失败。修正断言为 epoch 数值比较后，恢复修复后的 React/Node 全项目集中复跑：62 个文件、1,815 项全部通过；首轮已通过的 Worker 测试不重复执行。
- 回归涵盖读取/路由竞态、原 operation 恢复、分页环路、URL 日期、资源缓存与旧读取、取消传递、一次性秘密和身份切换，不增加产品文案严格比较测试。
- 浏览器首轮完整运行 44 条链路，42 条通过；正常完成/停止重新生成的两条链路暴露了同版本 selection 合并过严的问题。修正为信任服务端完整终态快照，仅在明确生成态回退时保护现有 selection；增加瞬时双选中到服务端单选中的回归。
- 修正后聊天模块集中复跑：5 个单测文件、25 项通过；重建产物上的聊天浏览器模块 12/12 通过。其余未受此次修正影响的 32 条浏览器链路沿用首轮通过结果，全部 44 条链路已覆盖。
