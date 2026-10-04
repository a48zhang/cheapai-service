# cheapai.dev Desktop：分模块开发与集中验证计划

日期：2026-10-03（Asia/Shanghai）。状态：**按用户要求暂停，等待环境调整；逐项状态以 task-graph.json 为准，恢复入口见 execution-checkpoint.md**。

仓库：[a48zhang/sub2api-cloudflare](https://github.com/a48zhang/sub2api-cloudflare)。
本计划基于已读取的 main 提交 `5b721891e89ff52e7293bdc03061ecc454e9084d`。
本文是桌面端专项计划，不覆盖或改写仓库原有 507 节点及其他实施计划的完成状态。

## 1. 执行者必须遵守的规则

1. 一个 subagent 一次领取一个任务 ID。只修改该任务列出的文件；新建、修改、移动的源文件和跟踪锁文件都计数。
2. 每项任务均限制为 1–3 个文件。遇到必须扩展的改动，由协调者另拆任务或明确记录必要例外，不能把“顺手修复”藏在当前任务中。
3. **implementation、integration、research、documentation 任务不运行测试、类型检查、构建验收、浏览器验收或冒烟。它们的前后条件只描述文件、接口和代码状态，不要求任何测试或验证通过。**
4. **test_authoring 只编写确有必要的测试，不执行。validation 统一在完整模块/链路组装后执行。**依赖图中没有普通任务依赖 validation 节点。
5. 安装依赖、生成 pnpm/Cargo 锁文件只由列出的锁文件任务执行；这属于产物准备，不附带测试命令。生成的缓存、临时 fixture、dist、target 不提交。
6. 同文件只能有一个写入者。即使依赖允许并行，协调者也必须按精确文件路径加写锁。根 package.json、锁文件、App.tsx、lib.rs 和 key-repository.ts 特别串行。
7. 没有修改的测试集合不重跑。失败后收集同模块问题、拆小修复任务、统一修复，再由对应 validation 任务只重跑受影响范围。不要把“修一个文件→跑一套测试”作为循环。
   同一执行环境同时只派发一个 validation 任务，避免共享本地数据库、端口和构建目录冲突；独立 macOS/Windows 环境可以并行。
8. 不给纯样式、文案、简单组件包装和静态配置加测试；不加大快照、中文文案严格比较、SQL/源码字符串匹配、镜像实现的测试。协议机器字段和业务错误码的断言可以保留。
9. 所有测试资源隔离；测试不得使用个人 DSH home、真实项目目录、生产数据库或隐式真实模型调用。注入时钟，不等待真实 30/90 天；当前 Workers fixture 会 reset 数据库，保持其串行规则。
10. subagent 在最终交接中报告实际文件、实现行为、未解决接口、是否存在测试执行（普通任务应为“未执行，按集中计划”）；不顺带推送、部署、发布或修改其他 agent 的文件。
11. 不要求每个 subagent 修改本计划、graph 或统一状态文件。状态由协调者维护；任务交接消息作为独立进度输入，避免文档成为并行冲突点。
12. 若后续发现 AGENTS/技能的默认“每改即测”规则，本轮用户明确要求的集中执行方式优先；必须完成的检查仍纳入模块或最终链路验证。

## 2. 已冻结的产品边界

- 同一个仓库开发。现有 Vue 网站本轮不重构；不建设网站/桌面公共 UI 库。
- Tauri 自有桌面壳、React 自有蓝白界面；**不是整页嵌入 DSH**。
- DSH 提供 Agent 循环、上下文、会话持久化、工具执行与既有用户交互。优先复用其协议、组件和投影，适配集中维护。
- 不新增权限设置页、只读/Full Access 开关、沙箱、审批引擎。DSH 如发出必要交互，页面接入原生机制，不让任务因无人响应而悬挂。
- 页面范围：登录、新对话、历史对话、设置（账号/通用/关于更新）。蓝白主色，侧栏+会话正文+底部输入框。
- 图片、视频、团队、插件市场、跨设备历史同步、复杂后台调度、托盘常驻不进入本轮。
- Runtime 优先选择 Bun sidecar + DSH 文件目录。开发包管理继续用现有 Node/pnpm，不把整个 Cloudflare 仓库迁移到 Bun。
- Bun 兼容性未知。Node 是对照基线及明确备选；不维护两套 Agent 实现，不默认同时把两个运行时发给用户。
- 先完成 Runtime、自有对话和 Tauri 打包的验证产物，再投入完整账号与产品收口。后面的任务提前列明，但不表示第一轮要全部启动。
- 普通窗口关闭采用退出语义，有运行任务时提示；退出停止本地服务。重启只恢复历史，不自动重放中断任务。
- 本地会话按稳定 userId 隔离，退出保留历史，同账号新 Token 不导致历史丢失。
- 工作目录遵循 DSH 真实 workspace 要求；未选择时不暗中把应用目录当用户项目。已开始工作的会话换目录采用新会话。
- 多会话执行沿用 DSH 能力，不新增“同目录并发锁”或自己的任务调度机制；是否支持及边界写入接入文档。

### 2.1 Token + API Key 的唯一规则

1. 登录 Token 为不透明随机凭据，每次独立登录一个，90 天有效，服务端存摘要。
2. 每个 Token 独立关联一把当前真实 API Key。模型请求继续走现有 /v1 模型网关。
3. Key 有效期为 min(创建时刻+30天，Token 到期时刻)。
4. 同一 Token 重复取 Key、重启、网络重试，都返回同一把未过期 Key。
5. 只有首次不存在 Key 或自然过期时才创建；不提前轮换。
6. 并发取 Key 只产生一把当前有效 Key；提交成功但响应丢失后仍能取回同一值。
7. 主动撤销的 Key、损坏的绑定、分组权限失效不能被解释成“自动新建 Key”。
8. 退出只撤销当前 Token 和所属 Key；其他桌面登录及网页 Cookie 会话不受影响。
9. 父 Token 无效时，关联 Key 不再接受新模型请求；已开始的流不因自然到期强行中断。
10. 当前 Key 需要被重复返回，因此桌面绑定额外保存加密值；api_keys 继续保存摘要。用户不手工管理这些 Key。
11. 网页聊天的 kind=web_chat 虚拟 Key 不导出、不变成桌面凭据。新桌面 Key 的 kind=api，费用仍进入同一用户余额。
12. 首版 Key 绑定用户当前默认且已授权的分组。有效 Key 不随默认分组设置变化自动轮换；分组不再可用时如实提示。

### 2.2 最小后端契约

| 方法与路径 | 输入身份 | 返回/行为 |
| --- | --- | --- |
| POST /api/v1/desktop/login | 邮箱、密码 | 新 Token、Token 截止时间、公开用户信息 |
| POST /api/v1/desktop/key | Bearer Token | 当前 Key、Key ID、截止时间；仅首次/过期时创建 |
| GET /api/v1/desktop/account | Bearer Token | 公开用户、当前余额，金额沿用现有字符串/单位 |
| POST /api/v1/desktop/logout | 当前 Token | 幂等撤销当前会话及 Key |
| /v1/models 与既有模型协议 | API Key | 复用现有模型目录、准入和计费 |

成功与错误沿用 Worker 现有 envelope；F02/A01 记录具体类型。原始 Token/Key 只允许出现于其私有交付路径，普通页面状态只包含账号、期限与状态。

## 3. 仓库事实与代码落点

本轮读取到的事实：

- pnpm-workspace.yaml 是 apps/web、apps/worker、packages/apicompat 的显式清单，新增包必须显式登记。
- Node 固定 24.19.0，pnpm 固定 11.19.0；engineStrict、依赖年龄、allowBuilds 已启用。
- 根 build/typecheck 使用递归命令；原 Local checks 在 Linux 执行，新增桌面包需要隔离原生构建入口。
- 网页 login 当前直接创建 Cookie session；桌面 90 天 Token 不能通过放宽网页 session 上限实现。
- createPlatformKey 的幂等重放只返回元信息，不能直接拿它恢复 Key 明文；桌面绑定与 Key 创建必须原子组成。
- D1 batch 是原子批次，但零行更新不会自动回滚；实现必须以 SQL 条件与结果保证业务原子性。
- 当前迁移到 0023；计划使用 0024_desktop_sessions.sql，若执行时编号被占用仅顺延新文件。
- 现有共享 staging 已退役；使用本地隔离环境或现有 PR 独立预发，不重建旧 staging。
- packages/model-catalog 当前不是显式 workspace 包，本轮不借桌面计划顺手做目录大调整。

目标目录：

    apps/desktop/                  React 自有界面 + src-tauri/
    apps/desktop-runtime/          Bun/Node launcher、DSH、cheapai 接入
    packages/desktop-contracts/    不依赖平台的账号/宿主 DTO
    apps/worker/auth/desktop/     桌面账号与 Key 服务
    scripts/desktop/              资源准备、开发、打包
    docs/desktop/                 计划、接入记录和模块证据

运行层边界：Tauri 管理 sidecar 和系统存储；Runtime 管理账号接线、Provider 和 DSH；React 只渲染状态并发起用户操作。sidecar 控制通道先就绪，DSH 用户会话在登录后就绪，不能互相等待造成登录死锁。

## 4. 调度与交接

### 4.1 任务类型

| 类型 | 允许做什么 | 不做什么 |
| --- | --- | --- |
| research | 读源码、定位接口、固定版本并写文档 | 不启动兼容性实验、不宣称运行通过 |
| implementation / integration | 修改指定实现或连接模块 | 不跑测试、类型检查、构建验收、冒烟 |
| test_authoring | 模块完整后编写必要用例 | 不执行；不为覆盖率堆用例 |
| documentation | 根据已存在事实编写使用/交付说明 | 不代替实际验证 |
| validation | 模块/链路完成后集中运行并记录 | 不边验边改业务代码、不偷偷扩大范围 |

“最终状态”描述交付文件和行为，不等于“已在真实系统通过”。验证报告可以是失败或未运行；诚实的报告就是该验证任务的产物，不能把失败改成实现任务的隐形前置测试。

### 4.2 建议批次

| 批次 | 实现/产物任务 | 集中验证 |
| --- | --- | --- |
| 1：Runtime 最小链 | F01–F06、R01–R07、RT01 | RV01 |
| 2：自有对话链 | U01–U12、UT01 | UV01 |
| 3：原生交付链 | N01–N10、NT01 | NV01 / NV02 |
| 4：账号服务模块 | A01–A13、AT01–AT02 | AV01 |
| 5：登录到模型链 | L01–L11、LT01 | LV01 |
| 6：产品与候选包 | P01–P07 | PV01 |

第一轮建议只领取批次 1–2；可以并行写独立 UI 样式，但不要在 Runtime 未有完整产物前展开大量账号/发布工作。
批次是优先级与集中运行边界，**不是把“上一轮测试通过”加为每个实现任务的依赖**。具体实现依赖只看任务 ID 对应的产物；集中报告用于协调者安排少量适配/修复和选择 Runtime，不让所有 subagent 反复自测。

若 Bun 的问题仅需局部接线，可拆一个明确 1–3 文件的修复任务；若需要持续修改 DSH 核心，则在版本清单/launcher/打包资源里选择随包 Node。自有 UI 和账号工作无需因此重做。没有实际证据时，版本清单将该 runtime 标为 candidate，不能写 supported。

### 4.3 subagent 领取模板

    任务：<ID 和标题>
    允许修改：<任务列出的精确文件>
    只读参考：本计划、依赖任务产物、相关 DSH 固定版本源码
    工作：<该任务工作项>
    最终状态：<文件/接口/行为>
    执行限制：不运行测试或验证（validation 任务除外）
    交接：实际文件、完成的行为、接口变化、未完成项；不要声称未执行的检查通过

协调者以图中的 depends_on 决定可领取任务，再按文件加互斥锁。发生共享文件冲突时串行派发或使用隔离 worktree 后串行合入，不让 agent 在同一文件上相互覆盖。只有协调者更新集中状态，普通任务不自行改任务 ID、合并任务或扩大文件范围。

## 5. 任务清单

以下所有任务初始状态均为 pending；每项的文件列表也是写入预算。没有隐藏的“先跑测试”“跑通才交付”要求。

总计 **79 项**：1 项源码定位、55 项实现、8 项接线、6 项测试编写、7 项集中验证、2 项文档。每项写入预算均为 1–3 个文件。

### 基础与接口

#### F01 — 记录固定版本和上游接入点

- 类型：源码定位
- 产物依赖：无
- 允许修改（2）：`scripts/desktop/runtime-versions.json`、`docs/desktop/dsh-integration.md`

**做什么：** 只阅读 DSH 指定版本的源码、包清单和发布说明，选定精确 DSH/Bun/Node 对照版本与目标架构，记录可用的 Tauri/Rust 与 React 版本约束。记录真实 launcher、profile、会话接口、消息流、工具交互、持久化和静态资源入口；逐项标出公共接口与需随版本维护的接口。不得把 Bun 兼容性写成已成立。

**最终状态：** 版本清单无 latest/浮动分支；接入文档提供实际源码路径和方法签名，未确定项明确标记。此任务不启动 DSH。

#### F02 — 建立最小共享契约包

- 类型：实现
- 产物依赖：无
- 允许修改（3）：`packages/desktop-contracts/package.json`、`packages/desktop-contracts/tsconfig.json`、`packages/desktop-contracts/src/index.ts`

**做什么：** 定义本计划约定的账号 DTO、登录/Key 响应、公开账号状态和宿主启动事件。导出纯 TypeScript 类型，不引入 React、Node、Tauri 或 DSH 依赖；区分包含凭据的私有消息与可发给页面的状态。使用仓库既有响应 envelope 和金额字符串表示。 包名固定为 @sub2api/desktop-contracts。

**最终状态：** Worker、Runtime、React 可导入同一接口类型；普通页面状态类型不包含 Token/Key。

#### F03 — 创建本地 Runtime 包

- 类型：实现
- 产物依赖：F01、F02
- 允许修改（2）：`apps/desktop-runtime/package.json`、`apps/desktop-runtime/tsconfig.json`

**做什么：** 声明精确 DSH 依赖、contracts workspace 依赖及 dev/build/typecheck 脚本；编译配置与 Workers 类型隔离。开发包管理仍用仓库 Node/pnpm，执行运行时可选择 Bun 或 Node，不修改根 engines。 包名固定为 @sub2api/desktop-runtime。

**最终状态：** Runtime 有独立清单和编译边界，尚未假定 Bun 运行兼容。

#### F04 — 创建独立 React 前端包

- 类型：实现
- 产物依赖：F01、F02
- 允许修改（3）：`apps/desktop/package.json`、`apps/desktop/tsconfig.json`、`apps/desktop/vite.config.ts`

**做什么：** 按 DSH 实际组件依赖选定兼容 React 版本；声明 Vite、Tauri 前端接口和 contracts 依赖。普通 build 只构建前端资源，原生打包使用独立脚本名。开发服务固定桌面独立端口。 包含后续资源准备所用的固定 Tauri CLI 依赖，避免打包阶段临时 npx 下载。 包名固定为 @sub2api/desktop。

**最终状态：** 桌面前端与现有 Vue 网站分别构建，不要求网站重构或共享组件库。

#### F05 — 接入 workspace 并隔离云端命令

- 类型：接线
- 产物依赖：F03、F04
- 允许修改（3）：`pnpm-workspace.yaml`、`package.json`、`pnpm-lock.yaml`

**做什么：** 把 desktop、desktop-runtime、desktop-contracts 加入显式 workspace 清单；只生成一次本批依赖锁。保留现有 Node/pnpm、年龄和 allowBuilds 规则，仅按实际依赖添加精确例外。将既有云端 build/typecheck/check 明确限定原有云端包，增加桌面独立命令，避免现有 Linux CI 顺带要求 Rust/WebView。 新增 typecheck:desktop 与 build:desktop；原生 package:desktop 留给 N09。

**最终状态：** 依赖关系落在同一个 pnpm lock；云端和桌面有清晰命令入口；没有自动安装依赖的运行脚本。生成锁文件属于此任务，不附带测试/构建执行。

#### F06 — 标记桌面本地产物

- 类型：实现
- 产物依赖：无
- 允许修改（1）：`.gitignore`

**做什么：** 增加桌面 Rust target、sidecar 下载缓存、生成资源、测试专用 DSH home、安装包及诊断输出的忽略项；保留应提交的 Cargo.lock、版本清单和源文件。不要忽略整个 apps/desktop 或掩盖现有跟踪文件。

**最终状态：** 运行数据、凭据和大体积构建产物有明确的本地存放位置。

### DSH运行链

#### R01 — 配置 cheapai 的 DSH 组合

- 类型：实现
- 产物依赖：F01、F03
- 允许修改（2）：`apps/desktop-runtime/profiles/cheapai.yml`、`apps/desktop-runtime/src/dsh/config.ts`

**做什么：** 按上游实际配置格式组合对话、会话、工具、持久化和所需 Web/RPC 服务。使用独立 home、loopback 动态端口和 no-open 模式。沿用 DSH 原生执行/权限策略，不增加只读/Full Access 选择器或自定义沙箱。排除官方账号和整页 UI 对产品外壳的接管。

**最终状态：** 存在固定的 cheapai profile，路径和 endpoint 来自启动参数，配置中没有实际密钥。

#### R02 — 实现可切换运行时的启动器

- 类型：实现
- 产物依赖：R01
- 允许修改（2）：`apps/desktop-runtime/src/dsh/launcher.ts`、`apps/desktop-runtime/src/dsh/paths.ts`

**做什么：** 依据 F01 中的真实入口用显式 Bun/Node 路径启动 DSH；不依赖 npx、全局 PATH 或 Node shebang。区分开发目录和安装包资源目录，使用参数数组处理空格与中文路径。传递 profile/home，不把原始 Key 放进命令行。

**最终状态：** 同一套启动代码接受 runtime=bun 或 node；不产生两套 DSH 业务实现。

#### R03 — 定义服务生命周期与就绪信息

- 类型：实现
- 产物依赖：R02
- 允许修改（2）：`apps/desktop-runtime/src/dsh/lifecycle.ts`、`apps/desktop-runtime/src/dsh/connection-info.ts`

**做什么：** 统一 starting/ready/stopping/stopped/failed 状态；从真实 Host 就绪信号取得端口和 DSH 连接信息。实现启动超时、一次性退出收尾和服务重启；保留 DSH 原有连接鉴权方式，不伪造 ready 或依赖任意 stdout 字符串猜测。 若上游缺少独立就绪消息，使用其文档定义的 readiness 接口，由连接适配统一实现，不在各组件中轮询。

**最终状态：** 外层能获得明确的服务状态及连接描述，失败保留可诊断的阶段信息。

#### R04 — 接入测试 Key 与模型目录

- 类型：实现
- 产物依赖：R01
- 允许修改（2）：`apps/desktop-runtime/src/cheapai/provider.ts`、`apps/desktop-runtime/src/cheapai/model-catalog.ts`

**做什么：** 将测试网关 Base URL、协议、Key 和模型配置接入上游 Provider 扩展点。从 /v1/models 获取可见模型，并结合实际模型能力提供工具调用所需配置；不声称目录接口能返回全部上下文或工具能力。测试凭据只从本地受保护配置/环境读取。

**最终状态：** Runtime 能配置 cheapai Provider；凭据更新集中到一个入口，前端构建不包含 Key。

#### R05 — 建立宿主控制通道

- 类型：实现
- 产物依赖：R03、R04、F02
- 允许修改（2）：`apps/desktop-runtime/src/host/control.ts`、`apps/desktop-runtime/src/host/protocol.ts`

**做什么：** 实现宿主到 Runtime 的启动、停止、状态请求及私有配置消息；控制通道使用父子进程管道并与普通日志分离。对页面输出仅提供状态和 DSH 所需连接描述。预留账号命令分发扩展点，但不提前实现登录流程。

**最终状态：** 宿主可管理 Runtime，普通日志不会破坏控制消息，命令结果不会无差别广播给页面。

#### R06 — 装配本地服务入口

- 类型：接线
- 产物依赖：R05
- 允许修改（1）：`apps/desktop-runtime/src/index.ts`

**做什么：** 连接配置、Provider、DSH launcher、生命周期和控制通道；处理进程退出信号并清理自有监听。提供开发模式入口与 sidecar 模式入口，共用实际执行路径。

**最终状态：** 一个入口拥有启动与关闭顺序，Runtime 不另建 Agent、消息历史或工具调度器。

#### R07 — 准备统一启动脚本和任务目录

- 类型：实现
- 产物依赖：R06、F05、F06
- 允许修改（2）：`scripts/desktop/dev-runtime.mjs`、`scripts/desktop/create-fixture.mjs`

**做什么：** 添加显式 --runtime bun|node 的开发启动脚本。fixture 脚本在指定临时目录生成少量文本和一个可执行的小程序，供完整链路使用；拒绝覆盖已有用户目录。脚本只负责准备和启动，不在每次启动时执行测试或安装依赖。

**最终状态：** Node/Bun 可使用同一 profile、模型和任务目录；验证不会修改真实项目。

#### RT01 — 补充 Runtime 收尾行为测试

- 类型：必要测试编写（不执行）
- 产物依赖：R06、R07
- 允许修改（2）：`tests/desktop/runtime-lifecycle.node.test.ts`、`tests/desktop/helpers/fake-host.ts`

**做什么：** 仅覆盖启动超时、ready 前崩溃、重复 stop、重启后的旧回调失效和监听释放。使用可控进程接口/fake host，无真实模型请求、固定端口或真实用户目录；测试中按资源所有者释放句柄。

**最终状态：** 存在可重复执行的行为用例，覆盖有可能遗留进程或串状态的分支；本任务不执行。

**为什么需要这些测试：** 生命周期多处异步回调会导致残留服务和迟到状态，这是上线后难以发现的实际错误；不测试日志文本或配置快照。

#### RV01 — 集中执行 DSH Node/Bun 运行链

- 类型：模块/链路集中验证
- 产物依赖：RT01
- 允许修改（1）：`docs/desktop/evidence/runtime.md`

**做什么：** 在整个 R 模块和 RT01 完成后，一次性执行桌面 Runtime 的类型/构建及 RT01；随后用同一固定版本、profile、临时任务比较 Node 基线和 Bun：启动、流式对话、读写、命令、停止、持久化、退出。真实网关需要已有授权的测试 Key 和预算；缺少时记录该段未执行，不能用 mock 冒充兼容通过。

**最终状态：** 报告按 runtime/OS/架构记录版本、命令、结果和具体阻塞；Bun 不兼容时定位到 API/原生依赖/加载方式。此任务只产生报告，不修改实现或顺带升级依赖。

### 自有对话界面

#### U01 — 建立独立前端入口

- 类型：实现
- 产物依赖：F04
- 允许修改（3）：`apps/desktop/index.html`、`apps/desktop/src/main.tsx`、`apps/desktop/src/app/App.tsx`

**做什么：** 挂载自有 React 根组件，先提供启动状态和空工作区；不嵌入 DSH 整页、不使用 iframe。为后续会话页和账号页预留明确路由/状态出口。

**最终状态：** 桌面有自己的应用入口，DSH 只作为能力来源。

#### U02 — 定义蓝白主题和基础控件

- 类型：实现
- 产物依赖：U01
- 允许修改（3）：`apps/desktop/src/styles/theme.css`、`apps/desktop/src/styles/global.css`、`apps/desktop/src/components/ui/controls.tsx`

**做什么：** 实现统一颜色/间距/字号/圆角变量及少量按钮、输入框、菜单控件；样式覆盖键盘焦点和禁用状态。只建设本客户端使用的组件，不抽跨网站设计系统。

**最终状态：** 登录、对话、设置后续可使用同一视觉基线；无权限控件。

#### U03 — 连接真实 DSH 协议

- 类型：实现
- 产物依赖：F01、R05、U01
- 允许修改（2）：`apps/desktop/src/adapters/dsh/client.ts`、`apps/desktop/src/adapters/dsh/connection.ts`

**做什么：** 按 F01 确认的接口封装 DSH 客户端和连接生命周期，支持断开与重新订阅。优先调用上游现有客户端，私有接口集中在该目录；不另造聊天 REST 协议。开发模式通过 Runtime bootstrap 取得连接信息。

**最终状态：** 业务组件不直接依赖散落的 DSH URL、WebSocket 帧格式或内部服务名。

#### U04 — 接入会话列表及操作

- 类型：实现
- 产物依赖：U03
- 允许修改（2）：`apps/desktop/src/features/conversations/session-service.ts`、`apps/desktop/src/features/conversations/session-store.ts`

**做什么：** 连接 DSH 的列表、新建、打开、重命名、删除能力；维护选中会话与列表缓存。搜索先限于已加载标题并明确范围；若上游支持分页则沿用，不悄悄加载整份历史或维护第二套持久化。

**最终状态：** 会话操作以 DSH 结果为准，本地 store 只负责界面投影。

#### U05 — 投影消息与流式状态

- 类型：实现
- 产物依赖：U03
- 允许修改（2）：`apps/desktop/src/features/conversations/event-projection.ts`、`apps/desktop/src/features/conversations/message-store.ts`

**做什么：** 优先复用 DSH 已有投影；仅补 UI 所需映射。按真实事件 ID/游标规则处理增量、最终消息、工具结果及连接恢复后的快照，避免文本重复和终态倒退；草稿按会话保存。

**最终状态：** 页面获得稳定消息列表与执行状态；重连不会重复追加已提交消息。

#### U06 — 实现消息展示

- 类型：实现
- 产物依赖：U02、U05
- 允许修改（3）：`apps/desktop/src/features/conversations/MessageList.tsx`、`apps/desktop/src/features/conversations/MessageBody.tsx`、`apps/desktop/src/features/conversations/conversation.css`

**做什么：** 适配可复用的 DSH 消息组件，统一用户浅蓝背景、Assistant 正文、Markdown 与代码块。跟随最新消息但尊重向上阅读的位置，提供回到最新入口；代码复制使用组件事件，不执行代码。

**最终状态：** 消息展示使用蓝白风格，长代码和长输出有明确滚动边界。

#### U07 — 承接工具展示和 DSH 原生交互

- 类型：实现
- 产物依赖：U02、U03、U05
- 允许修改（2）：`apps/desktop/src/features/conversations/ToolCall.tsx`、`apps/desktop/src/features/conversations/DshInteraction.tsx`

**做什么：** 展示工具名称、执行状态和折叠详情；对 DSH 发出的用户问题或必要确认复用其既有交互协议/组件并返回结果。不新增权限模式、不实现自己的审批策略，也不能把上游等待输入状态丢弃。

**最终状态：** 工具状态和用户交互都能回到 DSH，同一请求不会重复提交回答。

#### U08 — 实现发送与停止

- 类型：实现
- 产物依赖：U02、U03、U05
- 允许修改（2）：`apps/desktop/src/features/conversations/Composer.tsx`、`apps/desktop/src/features/conversations/composer-controller.ts`

**做什么：** 接入发送、停止和模型选择，保留输入草稿并处理中文输入法组合状态；使用 DSH 已支持的模型切换语义。未发生明确失败时不自动重发模型请求，防止重复执行和扣费。

**最终状态：** 输入框没有权限选择器；运行状态下显示停止，失败后保留可恢复的输入。

#### U09 — 实现会话侧栏

- 类型：实现
- 产物依赖：U02、U04
- 允许修改（2）：`apps/desktop/src/components/layout/Sidebar.tsx`、`apps/desktop/src/features/conversations/SessionMenu.tsx`

**做什么：** 连接新对话、已加载标题搜索、时间分组、当前会话和重命名/删除菜单；显示运行中标记。底部预留账号和设置入口，不添加任务中心或资产库。

**最终状态：** 侧栏操作真实会话服务，业务状态不硬编码为静态演示数据。

#### U10 — 接入目录选择边界

- 类型：实现
- 产物依赖：U02、U03
- 允许修改（2）：`apps/desktop/src/features/workspace/WorkspacePicker.tsx`、`apps/desktop/src/adapters/native/directories.ts`

**做什么：** 定义目录选择 adapter，浏览器原型使用 DSH 已有目录选择能力，原生宿主后续替换为 Tauri 对话框。新会话可先显示未选目录；开始任务时遵循 DSH 真实工作区要求，必要时提示选择，不能默认对应用目录执行。已开始工作的会话换目录采用新会话，不另造目录权限机制。

**最终状态：** 目录路径成为会话配置，不使用进程 cwd 隐式操作仓库。

#### U11 — 装配完整对话页面

- 类型：接线
- 产物依赖：U06、U07、U08、U09、U10
- 允许修改（3）：`apps/desktop/src/features/conversations/ConversationPage.tsx`、`apps/desktop/src/components/layout/AppShell.tsx`、`apps/desktop/src/app/App.tsx`

**做什么：** 组装侧栏、标题/目录、消息区、输入区和空会话页；绑定当前会话状态。切换会话不自动停止任务，任务仍由 DSH 管理，不另建调度系统。接入错误/等待交互，保留账号入口占位。

**最终状态：** 自有页面能表达完整会话链，所有 UI 命令均有真实 adapter 落点。

#### U12 — 建立设置页与本地偏好

- 类型：实现
- 产物依赖：U02
- 允许修改（2）：`apps/desktop/src/features/settings/SettingsPage.tsx`、`apps/desktop/src/features/settings/preferences.ts`

**做什么：** 实现通用、账号占位、关于三个分区；存储默认模型、默认目录等非敏感偏好，并提供默认值和版本字段。余额尚未接入时显示未加载状态，不显示虚构数字。

**最终状态：** 设置页面沿用统一组件，偏好与 DSH 消息历史分开。

#### UT01 — 补充消息恢复和终态测试

- 类型：必要测试编写（不执行）
- 产物依赖：U11、U12
- 允许修改（2）：`tests/desktop/conversation-events.node.test.ts`、`tests/desktop/helpers/dsh-events.ts`

**做什么：** 仅在自有 event projection 包含实际逻辑时增加用例：增量与最终消息交接、重连快照不重复、旧会话事件不污染新会话、取消后迟到事件不恢复运行。若完全复用上游投影，仅覆盖本地订阅切换，删除重复上游用例。

**最终状态：** 测试针对会导致丢消息或错误显示执行状态的行为；fixture 根据固定 DSH 版本构造，任务不执行。

**为什么需要这些测试：** 断线恢复和异步事件归属是自有 UI 的真实风险；不对文案、DOM 类名、消息全文或组件快照做严格比较。

#### UV01 — 集中执行自有页面到 DSH 链路

- 类型：模块/链路集中验证
- 产物依赖：UT01、RT01
- 允许修改（1）：`docs/desktop/evidence/conversation.md`

**做什么：** 在完整 U 模块组装后一次性执行前端类型/构建和 UT01；浏览器只跑一条完整业务链：新会话→发送→工具交互→停止→切换会话→刷新恢复。使用同一固定 runtime 配置；以任务结果、状态和历史归属判定，不做像素/中文文案比较。

**最终状态：** 报告区分真实 DSH、模拟事件和真实模型的范围；明确可复用组件和本地适配清单。只记录问题，修复另开小任务。

### Tauri宿主与打包

#### N01 — 建立 Rust 宿主清单与入口

- 类型：实现
- 产物依赖：F04
- 允许修改（3）：`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/build.rs`、`apps/desktop/src-tauri/src/main.rs`

**做什么：** 声明精确 Tauri、进程、目录/浏览器、系统凭据和后续更新所需依赖；只启用实际使用的 feature。创建标准构建入口与 main，原生 build 与普通前端 build 分开。

**最终状态：** Rust 包有独立依赖声明和启动入口；此任务不生成安装包或运行 cargo check。

#### N02 — 配置应用窗口和资源路径

- 类型：实现
- 产物依赖：N01、U01
- 允许修改（2）：`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/capabilities/default.json`

**做什么：** 配置应用 ID、窗口初始尺寸、前端开发地址/产物目录、sidecar 与资源目录；原生能力仅配置当前功能需要的窗口/目录/打开网址等入口。这是 Tauri 接线，不映射为用户权限档位。

**最终状态：** 前端和随包 Runtime 路径确定，无远程整页替换自有界面。

#### N03 — 启动 sidecar 并接收就绪信息

- 类型：实现
- 产物依赖：N02、R05
- 允许修改（3）：`apps/desktop/src-tauri/src/runtime.rs`、`apps/desktop/src-tauri/src/protocol.rs`、`apps/desktop/src-tauri/src/lib.rs`

**做什么：** 实现 Runtime 进程启动、控制消息解码、超时/异常状态和公开连接描述。只启动应用自己的服务；前端请求状态时不泄露账号凭据。运行时路径来自打包清单而非用户 PATH。

**最终状态：** 应用宿主拥有一个 Runtime，页面通过明确命令取得启动状态及 DSH 连接。

#### N04 — 完成关闭、重启和进程收尾

- 类型：实现
- 产物依赖：N03
- 允许修改（2）：`apps/desktop/src-tauri/src/runtime.rs`、`apps/desktop/src-tauri/src/lib.rs`

**做什么：** 实现退出时先正常停止再有界终止自有服务/子进程；运行任务的退出提示采用现有活动状态。服务崩溃支持显式重启，避免自动重启循环。首版不承诺托盘常驻；普通关窗按明确的应用退出行为处理。

**最终状态：** 关闭应用不会遗留应用管理的 DSH 服务；服务异常有恢复入口，重启不自动重放任务。

#### N05 — 连接原生目录与外部链接

- 类型：实现
- 产物依赖：N03
- 允许修改（2）：`apps/desktop/src-tauri/src/native.rs`、`apps/desktop/src-tauri/src/lib.rs`

**做什么：** 提供目录选择、打开 cheapai 注册/控制台地址的宿主命令；取消选择返回空结果。目录选择不创建或修改目录，打开网页不向 URL 附加登录 Token/Key。

**最终状态：** 前端通过小接口使用系统目录对话框和浏览器，不依赖 Electron bridge。

#### N06 — 提供系统凭据存储适配

- 类型：实现
- 产物依赖：N01
- 允许修改（1）：`apps/desktop/src-tauri/src/credentials.rs`

**做什么：** 以应用和账号/当前安装会话为命名空间实现读取、保存、删除登录凭据；使用系统安全存储。定义供 Runtime 私有控制通道调用的接口，不建立额外密码库或设备指纹体系。

**最终状态：** 宿主有可复用的凭据读写能力，普通页面只能取得公开账号状态。

#### N07 — 准备可搬移的 Bun/DSH 资源

- 类型：实现
- 产物依赖：F03、N02、F01
- 允许修改（2）：`scripts/desktop/prepare-runtime.mjs`、`scripts/desktop/package-runtime.mjs`

**做什么：** 按版本清单准备目标 OS/架构的 Bun 和 DSH 生产依赖及资源；移除对开发机绝对路径、全局 node_modules 和失效 symlink 的依赖。原生依赖按目标平台准备，保留 Node 备选路径。首版不做 bun compile 单文件化。 下载源、版本与 checksum 由已固定的发行元数据指定；Bun/Node 二选一进入正式包，不把两个运行时默认全部打包。

**最终状态：** 脚本产生可整体复制进安装包的 Runtime 目录及资源清单，不在应用首次启动时下载运行环境。

#### N08 — 连接前端与真实宿主

- 类型：接线
- 产物依赖：N04、N05、U10、U11
- 允许修改（3）：`apps/desktop/src/adapters/native/runtime.ts`、`apps/desktop/src/adapters/native/directories.ts`、`apps/desktop/src/app/App.tsx`

**做什么：** 将启动等待、服务重试和目录选择从开发 adapter 接到 Tauri；收到 ready 后才建立 DSH 连接。保留明确的浏览器开发模式，不因缺少 native 全局对象而伪报宿主已就绪。

**最终状态：** 同一 React UI 能在 Tauri 中使用随包服务，并呈现真实启动/失败状态。

#### N10 — 准备最小桌面图标资源

- 类型：实现
- 产物依赖：N02、N07
- 允许修改（3）：`apps/desktop/src-tauri/icons/app.svg`、`scripts/desktop/prepare-icons.mjs`、`apps/desktop/src-tauri/tauri.conf.json`

**做什么：** 提供简单的 cheapai 蓝白源图标，用固定 Tauri CLI/已有图像工具生成各平台打包所需 PNG/ICO/ICNS 到忽略目录，并配置资源路径。生成脚本只作为打包步骤，不启动应用或检查界面，不增加品牌设计系统。

**最终状态：** 安装包与应用窗口有完整图标资源来源，不依赖开发机遗留图标。

#### N09 — 收口原生依赖与开发命令

- 类型：接线
- 产物依赖：N06、N07、N08、F05、N10
- 允许修改（3）：`apps/desktop/src-tauri/Cargo.lock`、`package.json`、`scripts/desktop/dev-desktop.mjs`

**做什么：** 集中生成本批 Cargo.lock，增加 dev:desktop、build:desktop、package:desktop 独立命令；脚本负责按依赖顺序准备资源、启动，不嵌入自动测试。桌面安装命令与 Cloudflare 部署命令没有隐式互调。 package:desktop 接受 --target <Rust target triple>；图标准备在 Runtime/安装包资源装配前运行。

**最终状态：** 宿主、前端、Runtime 有完整命令编排；锁文件统一由该任务写入。

#### NT01 — 补充宿主消息与生命周期测试

- 类型：必要测试编写（不执行）
- 产物依赖：N09
- 允许修改（2）：`apps/desktop/src-tauri/src/runtime.rs`、`apps/desktop/src-tauri/src/protocol.rs`

**做什么：** 仅对本地拥有的协议解析和状态迁移增加 Rust 单元测试：分块控制消息、进程退出、重复停止、重启世代隔离、私有凭据消息不会进入公开事件。使用内存输入和 fake process，不在 cargo test 中启动真实 DSH 或系统弹窗。

**最终状态：** 存在针对进程泄漏/状态串线风险的用例，且不与 RT01 重复测试同一层；不执行。

**为什么需要这些测试：** Tauri 和 Runtime 之间存在独立的异步边界，错误会泄漏进程或把私有响应发给错误接收方；不验证打印字符串。

#### NV01 — 集中完成 macOS 原生交付验证

- 类型：模块/链路集中验证
- 产物依赖：NT01
- 允许修改（1）：`docs/desktop/evidence/native-macos.md`

**做什么：** 在 N 模块完整后执行一次原生构建及新增 Rust 测试，在目标 macOS 上安装并操作新建会话、工具执行、停止、退出、重启恢复；至少在不依赖预装 Node/Bun 的环境操作。记录 arm64/x64 实际覆盖，中文/空格路径、包体、启动时间、空闲内存和服务退出情况。未提供架构不得写为已验。

**最终状态：** 形成 macOS 安装与 Runtime 的实际证据；只写报告，不顺带修改业务代码。

#### NV02 — 集中完成 Windows 原生交付验证

- 类型：模块/链路集中验证
- 产物依赖：NT01
- 允许修改（1）：`docs/desktop/evidence/native-windows.md`

**做什么：** 对 Windows x64 独立执行同一条完整原生链，覆盖 WebView2 交付策略、无预装 Node/Bun、中文/空格路径、命令停止与服务进程收尾。平台任务可以与 NV01 并行；共用纯逻辑测试若已有同提交结果不重复跑，平台特有测试/构建单独记录。

**最终状态：** 形成 Windows 真实安装证据；Linux、浏览器截图和 macOS 结果不代替此报告。

### 桌面账号后端

#### A01 — 定义桌面 Token 与账号模型

- 类型：实现
- 产物依赖：F02
- 允许修改（2）：`apps/worker/auth/tokens.ts`、`apps/worker/auth/desktop/types.ts`

**做什么：** 增加独立 desktopSession token purpose，沿用现有随机生成/摘要规则；定义 90 天会话、30 天 Key 上限及服务端桌面会话类型。机器错误分类使用现有 ApiError envelope 或本契约明确的业务 reason，不改网页 session 的 7 天默认和 30 天上限。

**最终状态：** 桌面和网页凭据类别分离；普通 HTTP 状态、过期/撤销/网络失败能被客户端区分。

#### A02 — 建立会话与 Key 的持久绑定

- 类型：实现
- 产物依赖：A01
- 允许修改（1）：`migrations/0024_desktop_sessions.sql`

**做什么：** 新增 desktop_sessions，包含 token_hash、user_id、期限/撤销、current_key_id、current_key_ciphertext、key_generation/version；api_keys 增加可空 desktop_session_id 和必要索引，普通 Key/web_chat 保持原样。将当前绑定限定到同用户的桌面 Key。迁移号若已被占用仅顺延新文件，不改已发布迁移。

**最终状态：** 数据层可表示每 Token 独立 Key、原子换取和关联撤销；旧账单/API Key 历史引用仍保留。

#### A03 — 复用账号密码登录逻辑

- 类型：实现
- 产物依赖：无
- 允许修改（2）：`apps/worker/auth/login.ts`、`apps/worker/auth/login-core.ts`

**做什么：** 从现有 login 提取账号密码、现有登录限流、活动状态重读和签发后身份变化处理，允许注入凭据签发/撤销接口；原 login 保留网页 Cookie 返回形状。桌面调用不能先生成无用网页 session，也不能省掉现有失败计数与状态检查。

**最终状态：** 两类登录共享同一账号验证逻辑，网页入口外部行为保持现状。

#### A04 — 实现桌面会话创建与鉴权

- 类型：实现
- 产物依赖：A01、A02
- 允许修改（2）：`apps/worker/auth/desktop/session-repository.ts`、`apps/worker/auth/desktop/authenticate.ts`

**做什么：** 新增服务端生成 Token 的会话创建、按摘要读取和 Bearer 鉴权。检查用户/默认分组与会话期限/撤销，依赖注入 now；不接受客户端 userId 作为身份。不修改 Cookie 中间件让所有管理接口都接受桌面 Token。

**最终状态：** 桌面会话有独立鉴权入口，数据库异常不会被误报为密码错误或会话过期。

#### A05 — 实现桌面登录服务

- 类型：实现
- 产物依赖：A03、A04
- 允许修改（1）：`apps/worker/auth/desktop/login.ts`

**做什么：** 组合 login-core 与桌面 issuer，成功返回 Token、expiresAt 和公开用户信息；复用真实服务端 IP 的既有限流来源。签发失败或身份变化时清理本次新凭据，不影响已有其他登录会话。

**最终状态：** 每次成功登录创建独立 Token，不隐式获取/撤销其他 Token 的 Key。

#### A06 — 复用密文存储能力

- 类型：实现
- 产物依赖：A02
- 允许修改（3）：`apps/worker/catalog/secret-envelope.ts`、`apps/worker/catalog/channel-secrets.ts`、`apps/worker/auth/desktop/key-cipher.ts`

**做什么：** 提取现有 AES-GCM envelope 基础操作，保留渠道密文格式及 AAD 兼容；为桌面 Key 使用独立用途和 session/key 绑定上下文。沿用部署现有 keyring 配置，不新建 KMS 或轮换服务。读取有效 Key 时可还原同一值，密文不可用时报告服务错误，不能重建未过期 Key。

**最终状态：** 同一 Token 可以重复取得原 Key；现有渠道密文仍由兼容包装读取。

#### A07 — 提供可组合的 Key 创建原语

- 类型：实现
- 产物依赖：无
- 允许修改（2）：`apps/worker/auth/key-repository.ts`、`apps/worker/auth/key-creation.ts`

**做什么：** 从既有 createPlatformKey 提取候选 Key 生成及插入准备能力，保留用户/分组访问约束与幂等语义。让桌面仓库可将 Key 插入与 session 绑定放在同一 D1 batch；不要先调用已提交的 createPlatformKey 再单独保存密文。

**最终状态：** 普通 Key API 的返回/重放语义不变，桌面能原子组合创建过程。

#### A08 — 实现只在到期时换 Key

- 类型：实现
- 产物依赖：A04、A06、A07
- 允许修改（2）：`apps/worker/auth/desktop/key-repository.ts`、`apps/worker/auth/desktop/keys.ts`

**做什么：** 实现 getOrCreateCurrentKey：未过期返回当前密文解出的同一 Key；首次或自然过期才创建。绑定默认授权分组，expiresAt=min(now+30天,session.expiresAt)。D1 原子批次用 generation/CAS 条件把候选插入、密文和绑定一同提交；并发输家读取赢家结果，不留下可用孤儿 Key。主动撤销、绑定损坏或组权限失效不当作可自动换新。 到期轮换的同一批次将旧 Key 标为 revoked，保留其账务元数据。

**最终状态：** 相同 Token 的并发/重试只产生一把当前有效 Key；响应丢失后可取回同一值；不同 Token 相互独立。

#### A09 — 实现账号查询与当前会话退出

- 类型：实现
- 产物依赖：A04
- 允许修改（2）：`apps/worker/auth/desktop/logout.ts`、`apps/worker/auth/desktop/account.ts`

**做什么：** 账号查询投影公开用户及 D1 当前余额，不返回凭据。退出使用单一 D1 原子操作撤销当前 Token 和其关联 Key，保留记录供账务引用；重复退出幂等。只处理拥有当前 Token 的会话。

**最终状态：** 一端退出不影响其他桌面或网页会话，余额与现有网页共用账本。

#### A10 — 装配四个桌面 HTTP 接口

- 类型：实现
- 产物依赖：A05、A08、A09
- 允许修改（1）：`apps/worker/auth/desktop/routes.ts`

**做什么：** 实现 POST login、POST key、GET account、POST logout；路径固定为 /api/v1/desktop/*。复用现有有界 JSON 读取方式、错误 envelope 和登录限流；桌面无 Cookie 的入口不伪造浏览器 Origin/CSRF，网页 Cookie 规则不变。Key 返回包含 expiresAt，不通过 query 参数传凭据。

**最终状态：** 四个接口对应契约，客户端无需直接操作 /keys 或浏览器 Cookie。

#### A11 — 挂载桌面路由

- 类型：接线
- 产物依赖：A10
- 允许修改（1）：`apps/worker/routes.ts`

**做什么：** 在根 routes 中显式挂载四条路径，按需解析现有 DB/GATE/keyring 依赖，不在模块加载时读 Secrets。网页登录、web_chat 及 /v1 模型路由沿用原装配。

**最终状态：** 真实 Worker 请求能够到达桌面服务，unsupported path 仍按原规则返回。

#### A12 — 约束桌面管理 Key 与父会话

- 类型：实现
- 产物依赖：A11、A07
- 允许修改（1）：`apps/worker/auth/key-repository.ts`

**做什么：** 在网关内部 Key 查询中，对带 desktop_session_id 的 Key 同时检查父会话有效；普通 Key/web_chat 不受该分支影响。普通用户 Key 列表不混入后台管理的桌面 Key；禁止一般编辑接口延长/改组该类 Key，显式撤销仍有效。不允许一般编辑入口恢复已撤销的桌面 Key；轮换旧 Key 的处理由 A08 拥有。

**最终状态：** Token 失效会阻止其 Key 新请求；桌面 Key 不因通用 Key 编辑破坏一 Token 一 Key 规则。

#### A13 — 接入过期密文清理

- 类型：实现
- 产物依赖：A02
- 允许修改（2）：`apps/worker/auth/desktop/cleanup.ts`、`apps/worker/scheduled/cleanup.ts`

**做什么：** 复用现有定时维护入口，分批清空到期/撤销桌面会话的可回取 Key 密文。保留被 api_keys/request/billing 引用的会话和 Key 元数据，不级联删除账务，不引入新队列或常驻任务。

**最终状态：** 过期敏感材料可清理，历史请求和账本引用完整，维护结果提供独立计数。

#### AT01 — 覆盖 Token/Key 生命周期不变量

- 类型：必要测试编写（不执行）
- 产物依赖：A11、A12、A13
- 允许修改（2）：`tests/auth/desktop-keys.test.ts`、`tests/auth/desktop-sessions.test.ts`

**做什么：** 在完整 A 模块后使用现有 Workers 隔离 D1 fixture 编写：同 Token 重取相同 Key、不同 Token 隔离、并发首次/到期换取、响应丢失重试、revoked 不自动恢复、到期 cap、密文异常不轮换、退出只影响当前会话。注入时钟，不真实等待，不 mock 掉原子 SQL；同数据库 reset 按现有串行规则。

**最终状态：** 测试覆盖重复扣用身份和多端掉线的实际风险，检查持久数据与返回凭据关系；不执行。

**为什么需要这些测试：** 同一 Token 的同 Key 重放、并发原子性及多端隔离是用户明确要求，简单成功路径无法证明；断言业务值而非 SQL 文本。

#### AT02 — 覆盖路由到网关与退出链

- 类型：必要测试编写（不执行）
- 产物依赖：A11、A12、A13
- 允许修改（2）：`tests/auth/desktop-routes.test.ts`、`tests/gateway/desktop-auth-integration.test.ts`

**做什么：** 通过真实路由装配和 mock 上游覆盖登录→取 Key→模型请求→余额/账务→退出→新请求拒绝；再覆盖无权限分组、父会话到期和其他 Token 仍可调用。原有 Cookie/登录/Key/密文回归直接列入 AV01，不复制已有测试。

**最终状态：** 接口 envelope、所属用户、请求数量和账务状态有断言；没有真实外网或 UI 文案比较；不执行。

**为什么需要这些测试：** 仅测仓库函数会遗漏 routes 接线和父会话鉴权，因此需要一条跨层闭环；模型响应使用 mock，避免费用和随机输出。

#### AV01 — 集中执行账号后端模块回归

- 类型：模块/链路集中验证
- 产物依赖：AT01、AT02
- 允许修改（1）：`docs/desktop/evidence/backend-account.md`

**做什么：** 在 A/AT 整体完成后一次执行 Worker 类型/构建以及新增四文件与受影响既有登录、session、tokens、key-repository、api-key-auth、channel-secrets、scheduled cleanup 测试集合。复用现有 node/workers 项目，不为每个 A 任务各跑一次。限本地 D1 与 mock 上游，不部署生产。

**最终状态：** 报告记录命令、迁移版本、通过/失败/未运行，特别列出并发与多端结果；不自动修复失败或扩大为所有协议矩阵。

### 客户端账号闭环

#### L01 — 实现桌面账号 API 客户端

- 类型：实现
- 产物依赖：A10、F02
- 允许修改（2）：`apps/desktop-runtime/src/cheapai/account-client.ts`、`apps/desktop-runtime/src/cheapai/account-state.ts`

**做什么：** 实现 login/getKey/getAccount/logout 的类型化调用、超时/取消及公开状态投影；错误分为未登录/过期、Key 撤销、余额或分组问题、网络故障。网络错误不清空有效 Token；不得把 Worker 原始响应或凭据直接当 UI state。

**最终状态：** 本地服务具备账号调用能力，页面只消费脱敏状态。

#### L02 — 连接 Token 与 Key 的使用周期

- 类型：实现
- 产物依赖：L01、R04
- 允许修改（2）：`apps/desktop-runtime/src/cheapai/session-manager.ts`、`apps/desktop-runtime/src/cheapai/provider.ts`

**做什么：** 恢复 Token 后调用 getKey，服务端返回未过期同一 Key；记录到期时间，后续请求到期才取新 Key。并发取 Key 合并为一个请求，登录会话切换以 generation 使迟到结果失效。将当前 Key 提供给 DSH 请求前凭据解析扩展点，流已开始后不重放请求。

**最终状态：** 重启不轮换有效 Key；到期更新对用户透明；普通 401/403/余额不足不会触发无界重试。

#### L03 — 扩展宿主私有账号消息

- 类型：实现
- 产物依赖：L02、R05、F02
- 允许修改（3）：`apps/desktop-runtime/src/host/control.ts`、`apps/desktop-runtime/src/host/protocol.ts`、`packages/desktop-contracts/src/index.ts`

**做什么：** 加入登录、恢复、获取账号、退出及保存/读取凭据的私有消息；登录密码只在本次命令中使用。将页面可接收的结果与宿主存储消息分开，输出格式可由 Rust 精确解码。扩展点只处理账号接线，不新增远程 Agent API。

**最终状态：** Runtime 能向宿主申请系统凭据存储，账号秘密不会出现在普通前端事件。

#### L04 — 接通原生存储与账号命令

- 类型：实现
- 产物依赖：L03、N06、N04
- 允许修改（3）：`apps/desktop/src-tauri/src/account.rs`、`apps/desktop/src-tauri/src/protocol.rs`、`apps/desktop/src-tauri/src/lib.rs`

**做什么：** 将前端 login/restore/account/logout 调用转给 Runtime；私有凭据消息由宿主保存/读取，公开结果才返回页面。登录成功在持久保存完成后公布，存储失败如实返回，不展示已完成自动登录。

**最终状态：** 跨进程的登录与存储闭环完整，普通前端无需持有 Token 或 Key。

#### L05 — 按账号绑定 DSH 本地数据

- 类型：实现
- 产物依赖：L02、R03
- 允许修改（3）：`apps/desktop-runtime/src/dsh/paths.ts`、`apps/desktop-runtime/src/dsh/lifecycle.ts`、`apps/desktop-runtime/src/cheapai/account-state.ts`

**做什么：** 按后端稳定 userId 选择 DSH home，而不是按 Token 字符串建目录；换账号先停止旧账号执行并断开旧连接，再启动相应 home。退出保留该账号本地历史。验证阶段使用独立 dev home，不把测试 Key 会话合并到正式账号。

**最终状态：** 同账号重新登录保留历史，不同账号的列表、草稿和 Runtime 数据不串用。

#### L06 — 装配启动恢复与退出顺序

- 类型：接线
- 产物依赖：L04、L05
- 允许修改（3）：`apps/desktop-runtime/src/index.ts`、`apps/desktop-runtime/src/host/control.ts`、`apps/desktop/src-tauri/src/runtime.rs`

**做什么：** 启动时先恢复账号，再选择 home 和配置 Provider，之后公布 ready；无账号则显示登录态但不启动可执行的用户会话。退出按服务端撤销→停止当前账号任务→清理本地凭据/页面状态处理；离线撤销失败明确显示未完成并允许重试，不建设持久撤销队列。迟到登录响应不得复活已退出状态。 区分 sidecar 控制通道就绪和 DSH 会话服务就绪，不能等待 DSH 登录后 ready 才开放登录命令。

**最终状态：** 账号生命周期与 Runtime 生命周期有单一顺序所有者；开发测试 Key 模式只能显式启用，发布包默认不走该模式。

#### L07 — 实现前端登录状态适配

- 类型：实现
- 产物依赖：L04、U01
- 允许修改（2）：`apps/desktop/src/adapters/native/account.ts`、`apps/desktop/src/features/auth/auth-store.ts`

**做什么：** 接入 signedOut/restoring/signedIn/unavailable 等公开状态，维护当前用户、余额和错误，不保存凭据。请求取消和会话切换后忽略旧结果；网络错误保留已有账号与草稿。

**最终状态：** 页面通过 account adapter 操作登录，不直接调用模型接口换 Key。

#### L08 — 实现蓝白登录页

- 类型：实现
- 产物依赖：L07、U02、N05
- 允许修改（2）：`apps/desktop/src/features/auth/LoginPage.tsx`、`apps/desktop/src/features/auth/login.css`

**做什么：** 实现邮箱、密码、登录状态与错误提示，提交时禁止重复请求，保留邮箱；注册入口用宿主打开现有注册页。没有 API Key 输入、device-code、二维码或第三方登录。

**最终状态：** 登录页面与对话页面风格统一，使用真实 auth-store。

#### L09 — 接入账号、余额和退出入口

- 类型：实现
- 产物依赖：L07、U12、U09
- 允许修改（3）：`apps/desktop/src/features/settings/AccountPanel.tsx`、`apps/desktop/src/features/settings/SettingsPage.tsx`、`apps/desktop/src/components/layout/Sidebar.tsx`

**做什么：** 显示真实用户和余额，沿用已有金额表示及格式化规则；错误与零余额分开呈现。提供网页控制台和当前会话退出入口，不新增桌面 Key 管理页。

**最终状态：** 侧栏与设置都显示同一账号状态，退出目标清晰为当前客户端登录。

#### L10 — 连接账号路由和会话清理

- 类型：接线
- 产物依赖：L06、L08、L09、N08
- 允许修改（3）：`apps/desktop/src/app/App.tsx`、`apps/desktop/src/features/conversations/session-store.ts`、`apps/desktop/src/features/conversations/message-store.ts`

**做什么：** 根据宿主公开状态切换登录、启动恢复、工作区、服务故障页面；仅在确认账号变化时清空旧界面投影，持久历史仍由 DSH home 保留。登录到期保留当前账号草稿引用，重新登录同账号后恢复。 同时接入侧栏设置导航，使 U12/L09 的页面实际可到达。

**最终状态：** 安装后从登录到对话形成完整客户端链路，不存在旧账号消息闪现或假登录态。

#### L11 — 完成错误与恢复交互

- 类型：实现
- 产物依赖：L10、U08、U06
- 允许修改（3）：`apps/desktop/src/features/conversations/composer-controller.ts`、`apps/desktop/src/features/conversations/ConversationPage.tsx`、`apps/desktop/src/features/settings/SettingsPage.tsx`

**做什么：** 区分余额不足、无可用模型、登录过期、本地服务故障和网络失败；保留输入，给出对应重试或重新登录入口。Key 自然到期由 Runtime 处理，不弹人工换 Key 界面。不把失败中的模型调用自动重放。

**最终状态：** 主要页面具备与实际错误相符的恢复路径，不依赖统一的‘登录失败’兜底。

#### LT01 — 补充异步账号与 Key 更新测试

- 类型：必要测试编写（不执行）
- 产物依赖：L11
- 允许修改（2）：`tests/desktop/account-lifecycle.node.test.ts`、`tests/desktop/helpers/fake-account-api.ts`

**做什么：** 使用注入时钟和可延迟响应覆盖：未过期 Key 不轮换、到期并发合并、logout 后迟到 login/getKey 不复活、不同账号 home 选择、网络失败保留登录。只测本地编排，后端原子性仍由 AT01 负责；不启动真实模型或系统密钥链。

**最终状态：** 测试覆盖会导致跨账号和多端异常的本地竞争，资源在每个用例后释放；不执行。

**为什么需要这些测试：** 后端正确不代表客户端不会缓存旧 Key、重放请求或接受迟到凭据；这些是本地状态机独有风险。

#### LV01 — 集中执行登录到模型的完整链路

- 类型：模块/链路集中验证
- 产物依赖：LT01、AT01、AT02、NT01
- 允许修改（1）：`docs/desktop/evidence/account-e2e.md`

**做什么：** 在 L 模块完整后执行其类型/构建和 LT01，再使用隔离本地 Worker/D1、真实 Runtime 与自有 UI 跑两份独立客户端数据目录：登录→取 Key→调用→重启仍同 Key→模拟到期→换 Key→一端退出→另一端调用。测试期限由隔离 fixture/注入时钟控制，不能修改生产 TTL 或等待真实天数。先用 mock 上游，已有测试环境可补一次真实网关任务。

**最终状态：** 记录 Token/Key 关系的非敏感标识和实际行为，不记录密钥正文；真实双端与仅单进程模拟结果分别标记。

### 产品收口与交付

#### P01 — 完成通用设置和账号偏好归属

- 类型：实现
- 产物依赖：U12
- 允许修改（3）：`apps/desktop/src/features/settings/GeneralPanel.tsx`、`apps/desktop/src/features/settings/SettingsPage.tsx`、`apps/desktop/src/features/settings/preferences.ts`

**做什么：** 接入默认模型、默认目录和版本信息；选项来源真实模型/目录，保存非敏感偏好并按账号区分。只做浅色蓝白主题，暂不扩展主题编辑器、复杂快捷键或跨设备同步。

**最终状态：** 设置项有实际读写和默认生效位置，不保留无效占位按钮。

#### P02 — 固定整包版本与资源清单

- 类型：实现
- 产物依赖：N09、L06
- 允许修改（2）：`scripts/desktop/release-manifest.mjs`、`scripts/desktop/package-runtime.mjs`

**做什么：** 生成绑定应用版本、DSH/Bun版本、平台/架构和资源路径的发行清单；壳、前端与 Runtime 同批更新。安装资源只读，DSH home 与偏好位于用户数据目录；升级不能覆盖用户会话或依赖外部 pnpm 缓存。

**最终状态：** 安装包可识别自己的完整组成，后续报告可指向同一组产物。

#### P03 — 接入标准更新机制

- 类型：实现
- 产物依赖：N09、P02
- 允许修改（3）：`apps/desktop/src-tauri/src/updates.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src-tauri/tauri.conf.json`

**做什么：** 使用 Tauri 标准 updater 接口，更新源和签名材料由环境/发布配置提供，不写入私钥。检查更新和安装分开；只有确认退出运行任务后才安装。未配置更新源时公开 unavailable 状态，不使用占位URL。

**最终状态：** 宿主提供检查/下载/安装状态，不自建更新服务或静默强制升级策略。

#### P04 — 实现关于与更新界面

- 类型：实现
- 产物依赖：P03、P01
- 允许修改（3）：`apps/desktop/src/features/settings/UpdatePanel.tsx`、`apps/desktop/src/adapters/native/updates.ts`、`apps/desktop/src/features/settings/SettingsPage.tsx`

**做什么：** 展示真实应用版本、更新可用/下载/失败状态和手动操作；连接宿主 updater。更新不可用时给出准确状态，不把网络失败显示成最新版本。

**最终状态：** 设置页更新入口有真实行为，文案不暴露 Runtime 内部实现细节。

#### P05 — 配置独立桌面构建任务

- 类型：实现
- 产物依赖：P02、P03
- 允许修改（1）：`.github/workflows/desktop-package.yml`

**做什么：** 建立手动触发或发行批次触发的 macOS/Windows 构建矩阵，使用固定工具链并上传构建产物。构建任务不对每个微任务重复跑全库测试，不隐式部署 Worker；签名/公证能力缺失时保留未签名开发产物标记，不能宣称可正式发布。

**最终状态：** 桌面构建与既有 Cloudflare 预发流程分开，可记录平台产物和精确来源提交。

#### P06 — 记录 Runtime 分发和第三方依赖

- 类型：文档
- 产物依赖：P02
- 允许修改（2）：`THIRD_PARTY_NOTICES.md`、`docs/desktop/runtime-distribution.md`

**做什么：** 按实际随包 DSH/Bun/原生依赖记录版本、来源、许可和资源位置；列出 Git/Python 等哪些工具由用户项目环境提供，哪些确实随包，不作‘所有工具开箱即用’承诺。记录 Bun 备选 Node 的切换位置。

**最终状态：** 分发说明与实际清单一致，保留应随包的第三方声明。

#### P07 — 完成使用与交付文档

- 类型：文档
- 产物依赖：P01、P04、P05、P06、A13
- 允许修改（3）：`docs/desktop/user-guide.md`、`docs/desktop/architecture.md`、`docs/desktop/release.md`

**做什么：** 写明登录/同 Key 重启/过期/退出、会话本地归属、关窗退出、模型与目录选择；记录各层职责与构建命令。发布文档使用现有 PR 独立预发或本地隔离环境，不引用已退役共享 staging；生产部署/公开发布不在本计划自动执行范围。

**最终状态：** 使用说明可解释实际行为，发布准备项和未覆盖平台诚实列出；不把计划状态写成验证完成。

#### PV01 — 集中执行候选版本集成检查

- 类型：模块/链路集中验证
- 产物依赖：P07、RT01、UT01、NT01、AT01、AT02、LT01
- 允许修改（1）：`docs/desktop/evidence/release.md`

**做什么：** 全部实现/测试编写任务合并到同一候选提交后，执行一次既有云端必需类型/测试/构建及桌面完整类型/构建/必要测试；单次任务内按项目归并，不把同一套测试通过根命令和子命令重复执行。随后在目标平台只补自 NV/LV 报告以来受变更影响的整包登录/任务/更新/历史保留链。无新变更且证据对应同提交的项目不重复。 更新源/签名/目标系统缺失时，只记录对应未运行项，不用未签名本地产物宣称公开发行完成。

**最终状态：** 发布候选报告绑定提交和产物，逐项区分通过/失败/未运行；本任务不 push、部署、上传公开安装包或自动关闭未验证项。

## 6. 集中测试与验证安排

### 6.1 只添加六类必要测试

| 编写任务 | 覆盖的真实风险 | 避免产生的问题 |
| --- | --- | --- |
| RT01 | 启动/停止/迟到回调导致残留 Runtime | fake host，不启动真实模型；清理计时器和监听 |
| UT01 | 增量/最终消息重复、重连和会话串线 | 只测试自有投影，复用上游时减少用例；不做文案/快照 |
| NT01 | 原生控制帧和重启状态错位 | 内存输入/fake process，不弹系统对话框、不访问用户凭据 |
| AT01 | 同 Key 重取、到期并发、多端隔离、撤销恢复错误 | 真实隔离 D1、注入时钟、串行 reset；不 mock 原子 SQL |
| AT02 | 路由/网关/父会话/计费接线错误 | mock 上游、固定 usage，断言请求/账务事实，不依赖生成文本 |
| LT01 | 客户端接受迟到凭据、提前换 Key、网络错误清登录 | 延迟 Promise+注入时钟；不使用真实 Key/系统密钥链 |

既有密码、Cookie session、API Key、渠道密文和账务测试不复制。纯组件样式、按钮文案、标题、颜色、CSS 类名、版本字符串排版不增加自动测试。需要比较同一 Key 的测试使用本地临时生成凭据，失败信息也不输出真实外部凭据。

### 6.2 执行边界与命令契约

下列命令是未来 F/N 任务要实现或现有仓库已具备的入口，**本次写计划不执行**。validation agent 只在模块产物齐备后集中调用。已有同一候选提交的 CI 结果可以直接引用，不在本地再执行同一集合。

- RV01：
  - `pnpm --filter @sub2api/desktop-runtime run typecheck`
  - `pnpm --filter @sub2api/desktop-runtime run build`
  - `pnpm exec vitest run --project node tests/desktop/runtime-lifecycle.node.test.ts`
  - 使用 `node scripts/desktop/dev-runtime.mjs --runtime node` 与 `--runtime bun` 顺序运行同一完整任务；独立 home/workspace 由脚本参数提供。
- UV01：
  - `pnpm --filter @sub2api/desktop run typecheck`、`pnpm --filter @sub2api/desktop run build`
  - `pnpm exec vitest run --project node tests/desktop/conversation-events.node.test.ts`
  - 浏览器操作一次完整自有界面链，不为每个控件建立测试任务。
- NV01/NV02：
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` 的共享纯逻辑集合在同提交不重复；平台特有部分按实际平台执行。
  - `pnpm run package:desktop -- --target <目标 triple>`。
  - 各目标系统一次安装→执行→退出→重启链；目标平台不可用记录未运行，不用 Linux 代替。
- AV01：
  - 现有云端 typecheck/build 按新的显式作用域运行一次。
  - 一个 Workers 测试调用选择新增四文件和受影响原有文件：desktop-keys、desktop-sessions、desktop-routes、desktop-auth-integration、login、login-routes、session-routes、tokens、key-repository、api-key-auth、channel-secrets、scheduled cleanup/integration。
  - 不运行所有九种上下游协议矩阵，也不因本次身份适配重测全部前端页面。
- LV01：
  - `pnpm run typecheck:desktop`、`pnpm run build:desktop`；若当前同提交已执行则引用。
  - `pnpm exec vitest run --project node tests/desktop/account-lifecycle.node.test.ts`
  - 一个隔离双客户端端到端链，包含假时钟过期与一端退出；同一轮只记录脱敏凭据 ID，不保存原始响应。
- PV01：
  - 对候选提交执行一次仓库要求的云端集中检查和桌面集中检查；根 `pnpm run test` 已包含的 desktop Node 测试不再次通过 test:desktop 重跑。
  - 标准 package 构建所必需的重复编译不算重复验收，但应尽可能复用同候选提交的前端/Runtime 产物。
  - 原生平台只补受后续账号/更新改动影响的安装和升级链。运行平台新增/构建目标变化属于需要补验的原因。

### 6.3 完整任务场景与模型使用

Runtime 和自有 UI 的真实模型链仅选择一个已知支持工具调用的模型与一个实际使用的协议，不展开供应商/协议全排列。固定场景为：读取临时目录、总结文件、修改一个测试文件、执行一个简单程序、停止一次任务、恢复一次会话。结构化工具状态和文件结果是判断依据，不比较模型自然语言全文。

真实上游需要执行时已经获授权的测试环境、凭据和费用范围；已给过授权不重复询问。缺少时先完成 mock/本地范围，报告真实上游未运行。不要自动调用生产账户、发送注册邮件、修改用户余额或把真实 Key 写入 fixture。

### 6.4 失败后的处理

1. validation agent 一次收集本模块的失败与未运行项，写入自己的报告。
2. 协调者按根因生成补充任务，仍限定 1–3 个文件，不附带测试执行。
3. 同一轮修复合入后恢复对应 validation，限定重跑受影响集合。
4. 不把历史失败删除；追加对应修复提交和新结果。不自动扩大为全库检查。
5. 缺少原生系统、签名材料或上游凭据属于未运行，不属于代码已通过，也不触发反复重试。

## 7. 必要文件互斥

以下表格由任务文件清单生成。它只表示不能同时写同一文件，不要求为每个文件先跑检查。协调者在依赖满足后取得文件写锁；释放锁时只交接产物。

| 文件 | 涉及任务 |
| --- | --- |
| `apps/desktop/src/features/settings/SettingsPage.tsx` | U12 → L09 → L11 → P01 → P04 |
| `apps/desktop/src-tauri/src/lib.rs` | N03 → N04 → N05 → L04 → P03 |
| `apps/desktop/src/app/App.tsx` | U01 → U11 → N08 → L10 |
| `apps/desktop/src-tauri/src/runtime.rs` | N03 → N04 → NT01 → L06 |
| `apps/desktop-runtime/src/host/control.ts` | R05 → L03 → L06 |
| `apps/desktop/src-tauri/tauri.conf.json` | N02 → N10 → P03 |
| `apps/desktop/src-tauri/src/protocol.rs` | N03 → NT01 → L04 |
| `packages/desktop-contracts/src/index.ts` | F02 → L03 |
| `package.json` | F05 → N09 |
| `apps/desktop-runtime/src/dsh/paths.ts` | R02 → L05 |
| `apps/desktop-runtime/src/dsh/lifecycle.ts` | R03 → L05 |
| `apps/desktop-runtime/src/cheapai/provider.ts` | R04 → L02 |
| `apps/desktop-runtime/src/host/protocol.ts` | R05 → L03 |
| `apps/desktop-runtime/src/index.ts` | R06 → L06 |
| `apps/desktop/src/features/conversations/session-store.ts` | U04 → L10 |
| `apps/desktop/src/features/conversations/message-store.ts` | U05 → L10 |
| `apps/desktop/src/features/conversations/composer-controller.ts` | U08 → L11 |
| `apps/desktop/src/components/layout/Sidebar.tsx` | U09 → L09 |
| `apps/desktop/src/adapters/native/directories.ts` | U10 → N08 |
| `apps/desktop/src/features/conversations/ConversationPage.tsx` | U11 → L11 |
| `apps/desktop/src/features/settings/preferences.ts` | U12 → P01 |
| `scripts/desktop/package-runtime.mjs` | N07 → P02 |
| `apps/worker/auth/key-repository.ts` | A07 → A12 |
| `apps/desktop-runtime/src/cheapai/account-state.ts` | L01 → L05 |

表内箭头表示建议串行顺序；最终仍以产物依赖为准。任务 ID 的数字不单独决定执行顺序，例如 N10 图标准备属于 N09 命令收口的输入。

## 8. 计划以外的工作

本计划不自动执行以下操作：网站 React 重构、生产 D1 迁移、生产 Worker 部署、真实余额授额、公开安装包发布、购买证书、创建/删除云资源、加入设备指纹/风控/KMS、另建权限系统。未来确实需要时另列明确范围，已有用户授权可直接复用，不增加重复审批。

不要为“验证方便”删锁文件、全局放宽 allowBuilds、关 TLS 验证、复用已退役 staging、使网页 Cookie 变成桌面长期凭据，或绕过 DSH 已有交互规则。

## 9. 交付与状态管理

- 本文保存完整说明，`task-graph.json` 保存相同任务的机器可读 ID、类型、依赖、文件、工作项、最终状态和测试必要性。
- 全部任务初始化为 pending；`code_complete` 与验证报告中的结果分开记录。
- implementation 等任务即使未运行检查，也可以按明确产物标记 code_complete；不能因此声称功能已通过。
- validation 的结果为 passed / failed / partial / not_run，并绑定提交、平台、命令和报告路径。后续实现不把 passed 当作单任务前置或后置条件。
- 自动派发只按依赖产物和文件互斥选任务。一个 subagent 不自行领取其下游任务，也不修改统一状态。
- 当前首批可独立领取 F01、F02、F06；若确需提前准备后端，可领取无依赖的 A03/A07，但当前优先完成 Runtime 与自有 UI，避免一次铺开全部 79 项。

本次产物只包括详细计划、机器可读任务图和文档索引；没有实现桌面功能、运行测试或发布任何服务。

## 执行中的依赖调整

为满足最大并发，移除了只影响最终装配、并非文件接口前提的依赖：设置页与通用偏好可在对话装配前实现；系统凭据适配只依赖 Cargo 清单；账号查询/退出只依赖会话仓库；密文清理只依赖迁移。测试编写仍等待完整后端装配，所有验证仍集中进行。额外的 U02-wire（仅 main.tsx 样式入口）与 A02-fix（仅迁移的密文清理约束）分别作为单文件接线/修复记录，不扩大原任务文件预算。

恢复时先阅读 [执行检查点](./execution-checkpoint.md)。graph 中 completed 仅代表实现产物交接完成，不代表验证通过；written_unreviewed 表示文件已写入但尚未核对交接。此次暂停未运行产品测试、类型检查、构建或原生安装验证。
