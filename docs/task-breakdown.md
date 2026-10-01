# 一期微任务清单与拓扑顺序

日期：2026-09-05。依据 [完整技术方案 v1.0](architecture.md) 与 [一期目标](phase-1.md) 拆分，保持一个 Worker、D1 权威记账、适度 KV、轻量 Gate DO 和九种协议组合的范围。

当前持续执行中，最新完成状态见下方与 JSON。结构化主清单为 [task-graph.json](task-graph.json)，本文件是对应的阅读版；调整任务时同步两份文件并重新验证依赖。

## 当前执行进度

已完成 **480** 项，进行中 **0** 项，待实现 **1** 项，用户暂缓验收 **26** 项。总节点 507（新增小型集成/修复任务仍限制每次最多三文件）。

已完成：`F01`、`P21`、`F02`、`P21-L`、`F03`、`F04`、`F14-D`、`F05`、`F08`、`P01`、`F06`、`F09`、`F04-WEB-LIB`、`X01`、`A16`、`F06-W`、`F07`、`F10`、`F11`、`F12`、`F13`、`L01`、`L04`、`C01`、`C02`、`B01`、`P02`、`P03`、`P04`、`P05`、`P07`、`F07-ISO`、`F14`、`D01`、`L02`、`A13`、`C12`、`B02`、`P06`、`P08`、`P10`、`P11`、`P12`、`P13`、`P14`、`P-CR-Q1`、`P-CR-J1`、`P-CM-Q1`、`P-CM-J1`、`P-RC-Q1`、`P-RC-J1`、`P-RM-Q1`、`P-RM-J1`、`P-MC-Q1`、`P-MC-J1`、`P-MR-Q1`、`P-MR-J1`、`U01`、`F10-FIX`、`G04-BODY`、`P04-OUTPUT-CONFIG`、`F15`、`D02`、`D07`、`D14`、`L03`、`P09`、`P15`、`P16`、`P17`、`P-CR-Q2`、`P-CR-J2`、`P-CM-Q2`、`P-CM-J2`、`P-RC-Q2`、`P-RC-J2`、`P-RM-Q2`、`P-RM-J2`、`P-MC-Q2`、`P-MC-J2`、`P-MR-Q2`、`P-MR-J2`、`G04`、`G05`、`G06`、`AUDIT-CLIENT`、`G04-BODY-HARDEN`、`F16`、`D03`、`D04`、`D05`、`D06`、`D08`、`D11`、`L05`、`A01`、`C15`、`P18`、`P19`、`P20`、`P-CR-Q3`、`P-CR-J3`、`P-CR-S1`、`P-CM-Q3`、`P-CM-J3`、`P-CM-S1`、`P-RC-Q3`、`P-RC-J3`、`P-RC-S1`、`P-RM-Q3`、`P-RM-J3`、`P-RM-S1`、`P-MC-Q3`、`P-MC-J3`、`P-MC-S1`、`P-MR-Q3`、`P-MR-J3`、`P-MR-S1`、`D01-FIX`、`AUDIT-CLIENT-MODEL`、`D09`、`D12`、`O01`、`L06`、`A02`、`A14`、`A25`、`A29`、`B17`、`P-CR-Q4`、`P-CR-J3-E`、`P-CR-S2`、`P-CM-Q4`、`P-CM-J3-E`、`P-CM-S2`、`P-RC-Q4`、`P-RC-J3-E`、`P-RC-S2`、`P-RM-Q4`、`P-RM-J3-E`、`P-RM-S2`、`P-MC-Q4`、`P-MC-J3-E`、`P-MC-S2`、`P-MR-Q4`、`P-MR-J3-E`、`P-MR-S2`、`A11-D`、`A25-D`、`L08-GATE-PEEK`、`P22-EXPORTS`、`D10`、`L07`、`L08`、`A03`、`A09`、`A11`、`A15`、`A21`、`A23`、`C03`、`C06`、`C08`、`P-CR-Q4-O`、`P-CR-J3-T`、`P-CR-S3`、`P-CM-Q4-O`、`P-CM-J3-T`、`P-CM-S3`、`P-RC-Q4-O`、`P-RC-J3-T`、`P-RC-S3`、`P-RM-Q4-O`、`P-RM-J3-T`、`P-RM-S3`、`P-MC-Q4-O`、`P-MC-J3-T`、`P-MC-S3`、`P-MR-Q4-O`、`P-MR-J3-T`、`P-MR-S3`、`A25-IDEM`、`L09-GATE`、`D13`、`L10`、`A04`、`A06`、`A07`、`A11-L`、`A17`、`A25-L`、`C10`、`C14`、`B03`、`P-CR-Q5`、`P-CR-J4`、`P-CR-S4`、`P-CM-Q5`、`P-CM-J4`、`P-CM-S4`、`P-RC-Q5`、`P-RC-J4`、`P-RC-S4`、`P-RM-Q5`、`P-RM-J4`、`P-RM-S4`、`P-MC-Q5`、`P-MC-J4`、`P-MC-S4`、`P-MR-Q5`、`P-MR-J4`、`P-MR-S4`、`L08-REG`、`L09-CLIENT`、`L09`、`A05`、`A08`、`A11-R`、`A18`、`A20`、`A25-U`、`A26`、`A27`、`A30`、`C13`、`B04`、`B09`、`P-CR-Q6`、`P-CR-S5`、`P-CM-Q6`、`P-CM-S5`、`P-RC-Q6`、`P-RC-S5`、`P-RM-Q6`、`P-RM-S5`、`P-MC-Q6`、`P-MC-S5`、`P-MR-Q6`、`P-MR-S5`、`R04`、`CF-D1-CASE`、`A10`、`A12`、`A19`、`A20-O`、`A22`、`A26-C`、`A28`、`C04`、`C07`、`C09`、`C11`、`C16`、`B05`、`B06`、`B10`、`B11`、`P-CR-S6`、`P-CM-S6`、`P-RC-S6`、`P-RM-S6`、`P-MC-S6`、`P-MR-S6`、`G01`、`G15`、`U06`、`O02`、`Q06`、`B09-TIME`、`CM-STREAM-OPTIONS`、`A12-C`、`A22-C`、`A26-U`、`C04-C`、`C07-C`、`C09-C`、`B07`、`B08`、`B10-A`、`B12`、`B13`、`B19`、`P22`、`G02`、`G13`、`U07`、`U18`、`U34`、`A31-EARLY`、`A10-LAZY`、`B11-TIME`、`CR-TERMINAL-GUARD`、`A12-R`、`A24`、`A26-R`、`C05`、`C07-U`、`C09-U`、`B14`、`P23`、`G03`、`G20`、`U09`、`U14`、`U24`、`R05`、`A31-SESSION`、`C17-ENV`、`B10-TIME`、`G01-STRICT`、`P22-REQUEST-BUDGET`、`B15`、`B18`、`G12`、`U02`、`U10`、`U15`、`U17`、`U19`、`U21`、`U25`、`U27`、`U30`、`U33`、`Q05`、`AUDIT-ENTRY`、`AUDIT-LOGIN`、`A12-LAZY`、`A22-LAZY`、`G03-HISTORY`、`B16`、`G07`、`G08`、`U03`、`U08`、`U11`、`U16`、`U20`、`U22`、`U26`、`U28`、`U31`、`AUDIT-BOOTSTRAP`、`A31`、`B21`、`G09`、`U04`、`U12`、`U23`、`U29`、`U32`、`AUDIT-HTTPS`、`C17`、`G10`、`U05`、`U04-REGISTER`、`Q03-HARNESS`、`G11`、`U13`、`U05-LINK`、`B20-EARLY`、`B20`、`G14`、`G21`、`Q03`、`U35-REGISTRATION`、`G11-STREAM`、`G16`、`G17`、`G18`、`U35`、`Q04`、`Q03-EVIDENCE`、`JSON-NOFETCH`、`STREAM-NOFETCH-EXECUTE`、`G19`、`STREAM-NOFETCH-DISPATCH`、`UI-FOUNDATION`、`G22`、`G23`、`Q07`、`Q08`、`HTTP-INTEGRATION-NATIVE-FIX`、`Q-MATRIX-HELPER`、`UI-PUBLIC`、`O03`、`Q-CC`、`Q-CR`、`Q-CM`、`Q-RC`、`Q-RR`、`Q-RM`、`Q-MC`、`Q-MR`、`Q-MM`、`Q09`、`R01`、`UI-WORKSPACE`、`Q10`、`Q11`、`R02`、`R03`、`Q-MC-SSE`、`Q-MR-SSE`、`Q-MM-SSE`、`UI-USAGE`、`Q12`、`Q11-PORT`、`CF-STAGING-BASIC`、`UI-ROUTING`、`LOCAL-COMPLETION-EVIDENCE`、`UI-ADMIN`、`UI-REGISTRATION`、`UI-AUDIT-KEYS`、`UI-FORM-CONTROLS`、`UI-CONFIG-EDITORS`、`UI-USER-EDITORS`、`UI-BROWSER-ASSERTIONS`、`UI-DELIVERY`、`UI-CAPTURES`、`PC-PASSWORD`、`PC-CONCURRENCY`、`PC-GROUP-SCHEMA`、`PC-USER-GRANTS`、`PC-KEY-GROUPS`、`PC-ADMISSION`、`PC-CLIENTS`、`PC-KEY-FORMS`、`PC-ADMIN-FORMS`、`PC-CHANNEL-MODELS`、`PC-HOME`、`PC-FORM-LAYOUT`、`PC-DIALOG-LAYOUT`、`PC-ADMIN-TESTS`、`PC-KEY-TESTS`、`PC-BROWSER-COMPAT`、`PC-BROWSER-FLOW`、`PC-SPEC`、`PC-DELIVERY`、`LIMIT-DEFAULTS`、`LIMIT-ADMISSION`、`LIMIT-USERS`、`LIMIT-UI`、`LIMIT-CHANNELS`、`LIMIT-BROWSER`、`LIMIT-DELIVERY`、`CAT-SEEDS`、`CAT-UI`、`CAT-D1`、`CAT-BROWSER`、`CAT-DELIVERY`、`CHAT-DEPS`、`CHAT-GROUP-SCHEMA`、`CHAT-KEY-SCHEMA`、`CHAT-GROUP-API`、`CHAT-PRICE`、`CHAT-KEY-AUTH`、`CHAT-REQUEST-SCHEMA`、`CHAT-STORE-SCHEMA`、`CHAT-RECOVERY`、`CHAT-KEY-MGMT`、`CHAT-ADMISSION`、`CHAT-STORAGE`、`CHAT-ADMIN`、`CHAT-LOG-API`、`CHAT-GATEWAY`、`CHAT-STREAM`、`CHAT-LOG-ADMIN`、`CHAT-LOG-USER`、`CHAT-HTTP`、`CHAT-MOUNT`、`CHAT-CLIENT`、`CHAT-WEB-PARTS`、`CHAT-WEB`、`CHAT-INTEGRATION`、`CHAT-UI-TEST`、`CHAT-COMPAT-1`、`CHAT-COMPAT-2`、`CHAT-DOCS`、`CHAT-EVIDENCE`

当前派发：

依赖已就绪：`CHAT-RELEASE`

真实云、邮件、模型调用、负载和最终验收按用户指示后置；不将其标为通过。本地类型、构建、原生D1/DO及必要单元测试随实现进行。工具命令见 [工具链说明](toolchain.md)。

## 1. 拆分规则

总计 **507 项**，包含 5 个只读里程碑，其余任务均为 1–3 个文件。新增节点用于必要的入口挂载、依赖与小修，不扩大产品范围。

- 默认每次执行一个节点，只实现该节点描述的一个行为或不可分割的原子操作。不要把一层所有任务当成一次修改。
- 文件预算包含进入版本控制的新增、修改、删除，以及测试、fixture、快照、锁文件、生成类型和路由注册文件。读取文件和未跟踪的构建产物不占源码变更预算。
- 通常采用“实现文件 + 有意义的测试”；页面/纯配置做构建或交互检查，集中端到端测试留在 Q 任务，不为样式或机械配置添加镜像测试。
- 一个节点若需要第四个文件，先拆成新的依赖节点。依赖变更涉及 manifest/lock、共享导出或挂载路由时，显式列入文件清单，不能偷偷增加。
- 不强制一任务一个新文件或一个 PR。协议功能会多次修改同一转换器；不新增服务/包来容纳每个任务。
- 不可把“创建用户/核销凭证”或“账单/扣余额”拆成可单独成功的中间状态；D12、D13 保留完整原子边界，文件仍只有迁移和测试两个。
- 任务的目标路径是实施初稿，不要求现在预建所有文件。发现更合理的现有模块时，先调整路径和共享文件依赖，再实现，避免为守表制造碎片模块。
- 每个任务只宣称自己的验收结果。未接入入口的模块可用测试替身验证契约，但不能把空实现或模拟结果标成整体功能完成。
- 密钥、Cloudflare 账户、发件域名、真实上游/SDK、测试预算是部分任务的外部输入。缺少时标记该节点受阻，继续其他已就绪节点；不把整层当成全局暂停点。
- 任务状态回报包含实际文件、验收结果、剩余问题和下一就绪节点。若要写回进度表，安排独立文档变更；不在每个三文件业务任务中隐性多改一次计划文件。

“极小”同时约束行为和文件数。比如一个方向的请求工具处理、图片、结构化输出、普通响应错误、流中并行工具，都分别交付。若实现时单个主题仍过大，继续用稳定 ID 的后缀拆分，不扩大当前节点范围。

## 2. 两种依赖和执行方式

**功能依赖**：必须先有类型、表、接口或可运行能力，才能完成本任务。JSON 的 depends_on 保存这些边。

**文件顺序依赖**：两个任务要改同一文件，即使业务上独立，也要规定落地先后。JSON 的 file_order_dependencies 记录前一写入者及对应文件；effective_dependencies 是两者去重后的执行依赖。

本清单已验证：ID 唯一、前置均存在、依赖无环、每个交付任务不超过三个文件、同层没有写入同一文件的冲突。共 **83 个拓扑层**。层号表示依赖深度，不是预计工期，也不是要求开 31 个并行执行者。

任务就绪条件：所有 effective_dependencies 已完成，外部输入已具备，目标文件没有其他未收尾写入。可以在依赖满足时提前执行较后层节点，不必等较前层所有独立分支结束。只读里程碑 K0–K4 是汇合验收，不为无关模块增加人工串行等待。

~~~mermaid
flowchart TD
    F["工程与公共契约"] --> X["平台可行性验证"]
    F --> D["D1 表与原子性"]
    F --> L["并发 / 限流"]
    F --> P["协议公共基础"]
    D --> A["注册 / 会话 / Key"]
    L --> A
    D --> C["渠道 / 模型 / KV"]
    P --> C
    D --> B["计费 / 恢复"]
    C --> B
    A --> B
    P --> CV["六方向请求 / JSON / SSE"]
    CV --> G["网关装配"]
    A --> G
    B --> G
    C --> G
    L --> G
    A --> U["页面分批接入"]
    C --> U
    B --> U
    G --> Q["九格集成与真实上游验收"]
    U --> Q
    X --> Q
    Q --> R["部署 / 恢复 / 负载证据"]
    R --> K["一期验收汇总"]
~~~

简图仅展示主干；精确先后以任务 ID 的有效前置为准。协议基础、数据库与界面可以按各自依赖推进；最终实际调用必须等路由、转换、并发、计费均接好。

## 3. 先做哪几个

建议从 F01 开始；P21 是独立的来源/许可证核对，可穿插完成。以下是合法单线程顺序的前十项：

| 顺位 | 任务 | 本次交付 |
| --- | --- | --- |
| 1 | `F01` | 固定包管理器与工作区 |
| 2 | `P21` | 固定 Sub2API 来源与用例对应清单 |
| 3 | `F02` | 声明三个工作区包 |
| 4 | `F03` | 生成并校验依赖锁 |
| 5 | `F04` | 建立后端与协议包类型检查 |
| 6 | `F05` | 建立 Worker 入口与健康路由 |
| 7 | `F08` | 建立 Vue 构建配置 |
| 8 | `P01` | 固定转换器与共享语义契约 |
| 9 | `F06` | 声明资源 binding 与空 Gate 类 |
| 10 | `F09` | 建立最小前端入口 |

后续从下面的拓扑层选择就绪任务。单线程可使用 JSON 的 recommended_serial_order；遇到外部输入阻塞可以跳到另一就绪节点，不能越过自身前置。

## 4. 完整拓扑层

层不是全局屏障；暂缓节点不触发外部操作，其验收证据仍需日后补齐。

| 层 | 节点 |
| --- | --- |
| 1 | `F01`、`P21` |
| 2 | `F02`、`P21-L` |
| 3 | `F03` |
| 4 | `F04`、`F14-D` |
| 5 | `F05`、`F08`、`P01` |
| 6 | `F06`、`F09`、`F04-WEB-LIB` |
| 7 | `X01`、`A16`、`F06-W` |
| 8 | `F07`、`X04`、`X05`、`X06`、`X07` |
| 9 | `F10`、`F11`、`F12`、`F13`、`L01`、`L04`、`C01`、`C02`、`B01`、`P02`、`P03`、`P04`、`P05`、`P07`、`F07-ISO` |
| 10 | `F14`、`X02`、`D01`、`L02`、`A13`、`C12`、`B02`、`P06`、`P08`、`P10`、`P11`、`P12`、`P13`、`P14`、`P-CR-Q1`、`P-CR-J1`、`P-CM-Q1`、`P-CM-J1`、`P-RC-Q1`、`P-RC-J1`、`P-RM-Q1`、`P-RM-J1`、`P-MC-Q1`、`P-MC-J1`、`P-MR-Q1`、`P-MR-J1`、`U01`、`F10-FIX`、`G04-BODY`、`P04-OUTPUT-CONFIG` |
| 11 | `F15`、`D02`、`D07`、`D14`、`L03`、`P09`、`P15`、`P16`、`P17`、`P-CR-Q2`、`P-CR-J2`、`P-CM-Q2`、`P-CM-J2`、`P-RC-Q2`、`P-RC-J2`、`P-RM-Q2`、`P-RM-J2`、`P-MC-Q2`、`P-MC-J2`、`P-MR-Q2`、`P-MR-J2`、`G04`、`G05`、`G06`、`AUDIT-CLIENT`、`G04-BODY-HARDEN` |
| 12 | `F16`、`D03`、`D04`、`D05`、`D06`、`D08`、`D11`、`L05`、`A01`、`C15`、`P18`、`P19`、`P20`、`P-CR-Q3`、`P-CR-J3`、`P-CR-S1`、`P-CM-Q3`、`P-CM-J3`、`P-CM-S1`、`P-RC-Q3`、`P-RC-J3`、`P-RC-S1`、`P-RM-Q3`、`P-RM-J3`、`P-RM-S1`、`P-MC-Q3`、`P-MC-J3`、`P-MC-S1`、`P-MR-Q3`、`P-MR-J3`、`P-MR-S1`、`D01-FIX`、`AUDIT-CLIENT-MODEL` |
| 13 | `X03`、`D09`、`D12`、`O01`、`L06`、`A02`、`A14`、`A25`、`A29`、`B17`、`P-CR-Q4`、`P-CR-J3-E`、`P-CR-S2`、`P-CM-Q4`、`P-CM-J3-E`、`P-CM-S2`、`P-RC-Q4`、`P-RC-J3-E`、`P-RC-S2`、`P-RM-Q4`、`P-RM-J3-E`、`P-RM-S2`、`P-MC-Q4`、`P-MC-J3-E`、`P-MC-S2`、`P-MR-Q4`、`P-MR-J3-E`、`P-MR-S2`、`A11-D`、`A25-D`、`L08-GATE-PEEK`、`P22-EXPORTS` |
| 14 | `K0`、`D10`、`L07`、`L08`、`A03`、`A09`、`A11`、`A15`、`A21`、`A23`、`C03`、`C06`、`C08`、`P-CR-Q4-O`、`P-CR-J3-T`、`P-CR-S3`、`P-CM-Q4-O`、`P-CM-J3-T`、`P-CM-S3`、`P-RC-Q4-O`、`P-RC-J3-T`、`P-RC-S3`、`P-RM-Q4-O`、`P-RM-J3-T`、`P-RM-S3`、`P-MC-Q4-O`、`P-MC-J3-T`、`P-MC-S3`、`P-MR-Q4-O`、`P-MR-J3-T`、`P-MR-S3`、`A25-IDEM`、`L09-GATE` |
| 15 | `D13`、`L10`、`A04`、`A06`、`A07`、`A11-L`、`A17`、`A25-L`、`C10`、`C14`、`B03`、`P-CR-Q5`、`P-CR-J4`、`P-CR-S4`、`P-CM-Q5`、`P-CM-J4`、`P-CM-S4`、`P-RC-Q5`、`P-RC-J4`、`P-RC-S4`、`P-RM-Q5`、`P-RM-J4`、`P-RM-S4`、`P-MC-Q5`、`P-MC-J4`、`P-MC-S4`、`P-MR-Q5`、`P-MR-J4`、`P-MR-S4`、`L08-REG`、`L09-CLIENT` |
| 16 | `L09`、`A05`、`A08`、`A11-R`、`A18`、`A20`、`A25-U`、`A26`、`A27`、`A30`、`C13`、`B04`、`B09`、`P-CR-Q6`、`P-CR-S5`、`P-CM-Q6`、`P-CM-S5`、`P-RC-Q6`、`P-RC-S5`、`P-RM-Q6`、`P-RM-S5`、`P-MC-Q6`、`P-MC-S5`、`P-MR-Q6`、`P-MR-S5`、`R04`、`CF-D1-CASE` |
| 17 | `A10`、`A12`、`A19`、`A20-O`、`A22`、`A26-C`、`A28`、`C04`、`C07`、`C09`、`C11`、`C16`、`B05`、`B06`、`B10`、`B11`、`P-CR-S6`、`P-CM-S6`、`P-RC-S6`、`P-RM-S6`、`P-MC-S6`、`P-MR-S6`、`G01`、`G15`、`U06`、`O02`、`Q06`、`B09-TIME`、`CM-STREAM-OPTIONS` |
| 18 | `A12-C`、`A22-C`、`A26-U`、`C04-C`、`C07-C`、`C09-C`、`B07`、`B08`、`B10-A`、`B12`、`B13`、`B19`、`P22`、`G02`、`G13`、`U07`、`U18`、`U34`、`Q01`、`Q02`、`A31-EARLY`、`A10-LAZY`、`B11-TIME`、`CR-TERMINAL-GUARD` |
| 19 | `A12-R`、`A24`、`A26-R`、`C05`、`C07-U`、`C09-U`、`B14`、`P23`、`G03`、`G20`、`U09`、`U14`、`U24`、`R05`、`A31-SESSION`、`C17-ENV`、`B10-TIME`、`G01-STRICT`、`P22-REQUEST-BUDGET` |
| 20 | `B15`、`B18`、`G12`、`U02`、`U10`、`U15`、`U17`、`U19`、`U21`、`U25`、`U27`、`U30`、`U33`、`Q05`、`AUDIT-ENTRY`、`AUDIT-LOGIN`、`A12-LAZY`、`A22-LAZY`、`G03-HISTORY` |
| 21 | `B16`、`G07`、`G08`、`U03`、`U08`、`U11`、`U16`、`U20`、`U22`、`U26`、`U28`、`U31`、`AUDIT-BOOTSTRAP` |
| 22 | `A31`、`B21`、`G09`、`U04`、`U12`、`U23`、`U29`、`U32`、`AUDIT-HTTPS` |
| 23 | `C17`、`G10`、`U05`、`U04-REGISTER`、`Q03-HARNESS` |
| 24 | `G11`、`U13`、`U05-LINK`、`B20-EARLY` |
| 25 | `B20`、`G14`、`G21`、`Q03`、`U35-REGISTRATION`、`G11-STREAM` |
| 26 | `G16`、`G17`、`G18`、`U35`、`K1`、`Q04`、`Q03-EVIDENCE`、`JSON-NOFETCH`、`STREAM-NOFETCH-EXECUTE` |
| 27 | `G19`、`K2`、`STREAM-NOFETCH-DISPATCH`、`UI-FOUNDATION` |
| 28 | `G22`、`G23`、`Q07`、`Q08`、`HTTP-INTEGRATION-NATIVE-FIX`、`Q-MATRIX-HELPER`、`UI-PUBLIC` |
| 29 | `O03`、`Q-CC`、`Q-CR`、`Q-CM`、`Q-RC`、`Q-RR`、`Q-RM`、`Q-MC`、`Q-MR`、`Q-MM`、`Q09`、`R01`、`UI-WORKSPACE` |
| 30 | `Q10`、`Q11`、`R02`、`R03`、`Q-MC-SSE`、`Q-MR-SSE`、`Q-MM-SSE`、`UI-USAGE` |
| 31 | `LIVE-CC`、`LIVE-CR`、`LIVE-CM`、`LIVE-RC`、`LIVE-RR`、`LIVE-RM`、`LIVE-MC`、`LIVE-MR`、`LIVE-MM`、`Q12`、`R06`、`R07`、`Q11-PORT`、`CF-STAGING-BASIC`、`UI-ROUTING` |
| 32 | `Q13`、`K3`、`LOCAL-COMPLETION-EVIDENCE`、`UI-ADMIN` |
| 33 | `R08`、`UI-REGISTRATION` |
| 34 | `K4`、`UI-AUDIT-KEYS` |
| 35 | `UI-FORM-CONTROLS` |
| 36 | `UI-CONFIG-EDITORS` |
| 37 | `UI-USER-EDITORS` |
| 38 | `UI-BROWSER-ASSERTIONS` |
| 39 | `UI-DELIVERY` |
| 40 | `UI-CAPTURES` |
| 41 | `PC-PASSWORD` |
| 42 | `PC-CONCURRENCY` |
| 43 | `PC-GROUP-SCHEMA` |
| 44 | `PC-USER-GRANTS` |
| 45 | `PC-KEY-GROUPS` |
| 46 | `PC-ADMISSION` |
| 47 | `PC-CLIENTS` |
| 48 | `PC-KEY-FORMS` |
| 49 | `PC-ADMIN-FORMS` |
| 50 | `PC-CHANNEL-MODELS` |
| 51 | `PC-HOME` |
| 52 | `PC-FORM-LAYOUT` |
| 53 | `PC-DIALOG-LAYOUT` |
| 54 | `PC-ADMIN-TESTS` |
| 55 | `PC-KEY-TESTS` |
| 56 | `PC-BROWSER-COMPAT` |
| 57 | `PC-BROWSER-FLOW` |
| 58 | `PC-SPEC` |
| 59 | `PC-DELIVERY` |
| 60 | `LIMIT-DEFAULTS` |
| 61 | `LIMIT-ADMISSION` |
| 62 | `LIMIT-USERS` |
| 63 | `LIMIT-UI` |
| 64 | `LIMIT-CHANNELS` |
| 65 | `LIMIT-BROWSER` |
| 66 | `LIMIT-DELIVERY` |
| 67 | `CAT-SEEDS` |
| 68 | `CAT-UI` |
| 69 | `CAT-D1` |
| 70 | `CAT-BROWSER` |
| 71 | `CAT-DELIVERY` |
| 72 | `CHAT-DEPS`、`CHAT-GROUP-SCHEMA`、`CHAT-KEY-SCHEMA` |
| 73 | `CHAT-GROUP-API`、`CHAT-PRICE`、`CHAT-KEY-AUTH`、`CHAT-REQUEST-SCHEMA`、`CHAT-STORE-SCHEMA` |
| 74 | `CHAT-RECOVERY`、`CHAT-KEY-MGMT`、`CHAT-ADMISSION`、`CHAT-STORAGE`、`CHAT-ADMIN`、`CHAT-LOG-API` |
| 75 | `CHAT-GATEWAY`、`CHAT-STREAM`、`CHAT-LOG-ADMIN`、`CHAT-LOG-USER` |
| 76 | `CHAT-HTTP` |
| 77 | `CHAT-MOUNT`、`CHAT-CLIENT` |
| 78 | `CHAT-WEB-PARTS` |
| 79 | `CHAT-WEB` |
| 80 | `CHAT-INTEGRATION`、`CHAT-UI-TEST`、`CHAT-COMPAT-1`、`CHAT-COMPAT-2` |
| 81 | `CHAT-DOCS` |
| 82 | `CHAT-EVIDENCE` |
| 83 | `CHAT-RELEASE` |

## 5. 任务路径和读表方法

全部文件路径相对工程根目录。下表为缩写；JSON 始终保存完整相对路径。这里列出的未来文件尚未创建。

| 缩写 | 实际目录 |
| --- | --- |
| W/ | apps/worker/ |
| UI/ | apps/web/src/ |
| WEB/ | apps/web/ |
| P/ | packages/apicompat/ |
| T/ | tests/ |
| M/ | migrations/ |
| DOC/ | docs/ |
| S/ | scripts/ |

每行包含稳定 ID、拓扑层、具体主题、最多三个文件、前置与验收。前置中“写序”是额外共享文件顺序，其余为功能前置；完整关联文件见 JSON。分组为了查找，**分组排列不是执行顺序**。

协议 ID 中 C=Chat Completions、R=Responses、M=Messages。Q 表示请求转换，J 表示普通响应转换，S 表示流转换；箭头始终表示该函数实际转换的方向。例如下游 Chat 调上游 Messages，需要 CM-Q 请求函数与 MC-J/MC-S 返回函数，不能把两个方向配反。

### 工程基础

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `F01` / 1 | [已完成] 固定包管理器与工作区 | `package.json`<br>`pnpm-workspace.yaml`<br>`.node-version` | 无 | 只声明三工作区与根脚本；Node/pnpm 版本明确，不安装漂移版本 |
| `F02` / 2 | [已完成] 声明三个工作区包 | `W/package.json`<br>`WEB/package.json`<br>`P/package.json` | `F01` | 依赖与 exports 边界明确，协议包不依赖 Worker 业务模块 |
| `F03` / 3 | [已完成] 生成并校验依赖锁 | `pnpm-lock.yaml`<br>`DOC/toolchain.md` | `F02` | 干净缓存 frozen-lockfile 安装通过；记录工具版本 |
| `F04` / 4 | [已完成] 建立后端与协议包类型检查 | `tsconfig.base.json`<br>`W/tsconfig.json`<br>`P/tsconfig.json` | `F03` | strict 与引用/输出边界静态核对正确；F05/P01 有输入后再做完整类型检查 |
| `F05` / 5 | [已完成] 建立 Worker 入口与健康路由 | `W/index.ts`<br>`W/app.ts`<br>`W/routes.ts` | `F04` | 本地 /healthz 返回健康状态，未知 API 返回 JSON 404 |
| `F06` / 6 | [已完成] 声明资源 binding 与空 Gate 类 | `W/wrangler.jsonc`<br>`W/env.ts`<br>`W/limits/gate.ts` | `F05` | D1/KV/DO/Email/Assets binding 类型一致；Gate 仅骨架，不标功能完成 |
| `F07` / 8 | [已完成] 建立 Worker 测试与数据库隔离 | `vitest.config.ts`<br>`T/helpers/database.ts`<br>`T/runtime.test.ts` | `F06`、`F06-W` | 隔离测试库可创建/清理；两个测试之间无数据串扰 |
| `F08` / 5 | [已完成] 建立 Vue 构建配置 | `WEB/vite.config.ts`<br>`WEB/tsconfig.json`<br>`WEB/env.d.ts` | `F03`、`F04` | Vue/TS 和静态资源目录配置可核对；F09 建入口后完成第一次构建 |
| `F09` / 6 | [已完成] 建立最小前端入口 | `WEB/index.html`<br>`UI/main.ts`<br>`UI/App.vue` | `F08` | 空壳页面可构建，暂不展示未实现功能 |
| `F10` / 9 | [已完成] 建立配置验证器 | `W/config.ts`<br>`T/unit/config.test.ts` | `F07` | 默认值集中；负数限额、非法模式和超时配置被拒 |
| `F11` / 9 | [已完成] 建立管理 API 错误与分页约定 | `W/http.ts`<br>`T/unit/http.test.ts` | `F07` | 错误 envelope/request_id、分页上下限稳定 |
| `F12` / 9 | [已完成] 建立参数化 D1 访问辅助 | `W/db.ts`<br>`T/db/access.test.ts` | `F07` | 参数绑定、迁移加载及零行结果能被业务层显式识别 |
| `F13` / 9 | [已完成] 建立随机凭证与摘要工具 | `W/auth/tokens.ts`<br>`T/auth/tokens.test.ts` | `F07` | 随机令牌足够长；摘要可稳定查找，日志不含原文 |
| `F14` / 10 | [已完成] 密码 Argon2id 散列与验证 | `W/auth/password.ts`<br>`T/auth/password.test.ts` | `F07`、`F10`、`F14-D` | 版本化编码、独立盐、正确/错误密码校验，不混入会话或 HTTP |
| `F15` / 11 | [已完成] 密码输入长度与字节限制 | `W/auth/password.ts`<br>`T/auth/password.test.ts` | `F14` | 12–128 字符和字节上限；不截断，支持密码管理器 |
| `F16` / 12 | [已完成] 密码 KDF 并发保护 | `W/auth/password.ts`<br>`T/auth/password.test.ts` | `F15` | 单实例并发受限，超额快速拒绝；安全参数由 X03 实测 |
| `F06-W` / 7 | [已完成] 导出 Gate Worker 类 | `W/index.ts` | `F06`<br>写序：`F05` | 保持F06三文件预算，独立导出Gate并通过Worker类型检查 |
| `F14-D` / 4 | [已完成] 安装Argon2实现依赖 | `W/package.json`<br>`pnpm-lock.yaml` | `F03`<br>写序：`F02` | 精确@noble/hashes2.4.0、严格peer安装通过，不隐式改其它配置 |
| `F10-FIX` / 10 | [已完成] 拒绝金额配置尾部换行 | `W/config.ts`<br>`T/unit/config.test.ts` | `F10` | 规范整数解析拒绝尾换行与首尾空白，回归通过 |
| `F07-ISO` / 9 | [已完成] 编号迁移与完整集成测试隔离 | `T/helpers/database.ts`<br>`T/runtime.test.ts` | `F07` | 编号迁移只加载对应及之前schema；普通集成保持完整schema，原生D1验证通过 |

### 运行时验证

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `X01` / 7 | [已完成] 建立独立 staging 配置 | `W/wrangler.jsonc`<br>`DOC/staging-resources.md` | `F06` | 核对账号后使用独立测试资源；记录非敏感资源 ID，不碰旧四个 Worker |
| `X02` / 10 | [验收后置] 验证远程 D1 原子语义 | `S/probes/d1-atomicity.ts`<br>`DOC/evidence/d1-atomicity.md` | `X01`、`F12` | 真实 D1 验证失败回滚、唯一冲突、零行更新及触发器语义，保留结果 |
| `X03` / 13 | [验收后置] 验证 Workers 密码运行成本 | `S/probes/password-runtime.ts`<br>`DOC/evidence/password-runtime.md` | `X01`、`F16` | 记录实际 CPU/内存/并发；不满足安全参数则阻止该密码实现上线 |
| `X04` / 8 | [验收后置] 验证 Email Service 真实发送 | `S/probes/email.ts`<br>`DOC/evidence/email.md` | `X01` | 验证允许的发件身份、测试收件箱与发送结果；失败原因明确 |
| `X05` / 8 | [验收后置] 验证 Chat 原生上游 | `S/probes/upstream-chat.ts`<br>`DOC/evidence/upstream-chat.md` | `X01` | 真实普通/SSE 请求能完成，记录认证、usage、模型、版本与错误；不把模拟当实测 |
| `X06` / 8 | [验收后置] 验证 Responses 原生上游 | `S/probes/upstream-responses.ts`<br>`DOC/evidence/upstream-responses.md` | `X01` | 真实普通/SSE 请求能完成，记录认证、usage、模型、版本与错误；不把模拟当实测 |
| `X07` / 8 | [验收后置] 验证 Messages 原生上游 | `S/probes/upstream-messages.ts`<br>`DOC/evidence/upstream-messages.md` | `X01` | 真实普通/SSE 请求能完成，记录认证、usage、模型、版本与错误；不把模拟当实测 |

### 里程碑检查

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `K0` / 14 | [验收后置] M0 可行性基线复核 | 只读，0文件 | `X02`、`X03`、`X04`、`X05`、`X06`、`X07`、`F09` | 只读复核运行证据、默认参数及阻塞项；全部实测通过才能标 M0 完成 |
| `K1` / 26 | [验收后置] M1 身份闭环复核 | 只读，0文件 | `Q01`、`Q03`、`A29`、`X03`、`X04` | 检查身份、页面、单次凭证原子性及密码/邮件实测证据 |
| `K2` / 27 | [验收后置] M2 渠道与计费复核 | 只读，0文件 | `Q02`、`Q04`、`Q05`、`Q06`、`C17` | 配置、负余额、幂等、缓存可关闭和并发机制有证据；尚不把协议路径算完成 |
| `K3` / 32 | [验收后置] M3 协议与真实链路复核 | 只读，0文件 | `LIVE-CC`、`LIVE-CR`、`LIVE-CM`、`LIVE-RC`、`LIVE-RR`、`LIVE-RM`、`LIVE-MC`、`LIVE-MR`、`LIVE-MM`、`Q08`、`Q09`、`P23` | 九格十八基本路径真实验证齐全；字段缺口公开，取消/工具/计费语义有证据 |
| `K4` / 34 | [验收后置] M4 一期交付复核 | 只读，0文件 | `R08` | 只读检查全部一期目标与未决项，达到可交付测试版本，不自动切换旧生产服务 |

### D1 数据与原子性

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `D01` / 10 | [已完成] 迁移：访问组与设置 | `M/0001_groups_settings.sql`<br>`T/db/0001_groups_settings.test.ts` | `F12` | 组/设置唯一键、版本和默认关闭注册正确 |
| `D02` / 11 | [已完成] 迁移：用户与余额 | `M/0002_users.sql`<br>`T/db/0002_users.test.ts` | `D01` | 规范化邮箱唯一、角色约束、零余额与负余额合法 |
| `D03` / 12 | [已完成] 迁移：会话 | `M/0003_sessions.sql`<br>`T/db/0003_sessions.test.ts` | `D02` | 摘要唯一、到期/撤销字段与用户外键正确 |
| `D04` / 12 | [已完成] 迁移：平台 Key | `M/0004_api_keys.sql`<br>`T/db/0004_api_keys.test.ts` | `D02` | 摘要唯一、用户外键及查询索引正确 |
| `D05` / 12 | [已完成] 迁移：单次注册码 | `M/0005_registration_codes.sql`<br>`T/db/0005_registration_codes.test.ts` | `D02` | 摘要唯一、过期/撤销/使用记录约束正确 |
| `D06` / 12 | [已完成] 迁移：邮箱挑战 | `M/0006_email_challenges.sql`<br>`T/db/0006_email_challenges.test.ts` | `D02` | 活动挑战唯一、generation/attempts/发送状态边界正确 |
| `D07` / 11 | [已完成] 迁移：渠道与组关联 | `M/0007_channels.sql`<br>`T/db/0007_channels.test.ts` | `D01` | 加密字段、配置版本及渠道组唯一关联正确 |
| `D08` / 12 | [已完成] 迁移：公开模型与渠道模型 | `M/0008_models.sql`<br>`T/db/0008_models.test.ts` | `D07` | 明确售卖价与协议映射；复合唯一键正确 |
| `D09` / 13 | [已完成] 迁移：请求记录 | `M/0009_requests.sql`<br>`T/db/0009_requests.test.ts` | `D04`、`D08` | 执行/计费状态分离，历史归属与重试扫描索引可用 |
| `D10` / 14 | [已完成] 迁移：只追加账单 | `M/0010_billing_entries.sql`<br>`T/db/0010_billing_entries.test.ts` | `D09` | operation_id 唯一，消费 request_id 部分唯一，adjustment 不被误阻 |
| `D11` / 12 | [已完成] 迁移：管理审计 | `M/0011_admin_audit.sql`<br>`T/db/0011_admin_audit.test.ts` | `D02` | 操作 ID/时间/主体索引正确，脱敏字段可存 |
| `D12` / 13 | [已完成] 迁移：注册原子触发器 | `M/0012_registration_atomic.sql`<br>`T/db/0012_registration_atomic.test.ts` | `D01`、`D05`、`D06`、`F07`<br>外部验收后置：X02 | 同码同邮箱竞争只成功一次；任一消费失败回滚用户创建 |
| `D13` / 15 | [已完成] 迁移：记账原子触发器 | `M/0013_billing_atomic.sql`<br>`T/db/0013_billing_atomic.test.ts` | `D10`、`F07`<br>外部验收后置：X02 | 账单/余额/请求原子生效；重放、超界、用户不匹配均不误扣 |
| `D14` / 11 | [已完成] 迁移：初始化默认设置 | `M/0014_defaults.sql`<br>`T/db/0014_defaults.test.ts` | `D01`、`F10` | 默认组和关闭注册可重复初始化，无默认密码或自动授额 |
| `O01` / 13 | [已完成] 实现管理审计写入与脱敏 | `W/admin/audit.ts`<br>`T/admin/audit.test.ts` | `D11`、`F11` | 配置事务可带审计；密钥和密码字段被移除 |
| `O02` / 17 | [已完成] 管理员审计查询接口 | `W/admin/audit-routes.ts`<br>`T/admin/audit-routes.test.ts` | `O01`、`A05`、`F11` | 管理员分页查询脱敏审计，其他用户被拒 |
| `O03` / 29 | [已完成] 挂载审计接口 | `W/routes.ts`<br>`T/admin/audit-http.test.ts` | `O02`、`G22` | 真实 HTTP 路径可查询，权限与分页正确 |
| `D01-FIX` / 12 | [已完成] 迁移测试使用自有种子键 | `T/db/0001_groups_settings.test.ts` | `D01`、`D14` | 后续默认种子不污染本测试，29测试通过 |
| `A11-D` / 13 | [已完成] 注册码批次幂等结构 | `M/0015_registration_code_batches.sql`<br>`T/db/0015_registration_code_batches.test.ts` | `D05` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |
| `A25-D` / 13 | [已完成] API Key创建幂等结构 | `M/0016_api_key_creation_idempotency.sql`<br>`T/db/0016_api_key_creation_idempotency.test.ts` | `D04` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |

### 并发与限流

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `L01` / 9 | [已完成] 租约获取/释放纯状态规则 | `W/limits/leases.ts`<br>`T/limits/leases.test.ts` | `F07` | 重复获取不双占位；过期限额与幂等释放正确 |
| `L02` / 10 | [已完成] 租约续期与迟到消息规则 | `W/limits/leases.ts`<br>`T/limits/leases.test.ts` | `L01` | lease_token 匹配；迟到续租不复活已释放租约 |
| `L03` / 11 | [已完成] DO 持久化与恢复 | `W/limits/storage.ts`<br>`T/limits/storage.test.ts` | `L02`、`F06` | 对象重建后租约可恢复；过期项按实际时间清理 |
| `L04` / 9 | [已完成] 固定窗口频率计数 | `W/limits/rate-window.ts`<br>`T/limits/rate-window.test.ts` | `F07` | 窗口切换、同操作重试和限额边界正确 |
| `L05` / 12 | [已完成] Gate RPC 与 alarm 接入 | `W/limits/gate.ts`<br>`T/limits/gate.test.ts` | `L03`、`L04`<br>写序：`F06` | 对象内原子获取/续租/释放；alarm 重入清理幂等 |
| `L06` / 13 | [已完成] 内部租约客户端 | `W/limits/client.ts`<br>`T/limits/client.test.ts` | `L05` | 只经 binding 调用，错误有明确分类 |
| `L07` / 14 | [已完成] 双主体获取与补偿 | `W/limits/dual-lease.ts`<br>`T/limits/dual-lease.test.ts` | `L06` | 渠道失败释放用户租约；同用户多 Key 共享用户限额 |
| `L08` / 14 | [已完成] 登录/发码强一致限流 | `W/limits/auth-rate-limit.ts`<br>`T/limits/auth-rate-limit.test.ts` | `L04`、`L05`、`F13`、`L08-GATE-PEEK` | IP/邮箱独立计数，不信任客户端转发头 |
| `L09` / 16 | [已完成] 渠道短期冷却 | `W/limits/cooldown.ts`<br>`T/limits/cooldown.test.ts` | `L05`、`L09-CLIENT` | 受限 Retry-After、到期恢复、无永久业务停用副本 |
| `L10` / 15 | [已完成] 流期间续租和失联取消 | `W/limits/lease-lifecycle.ts`<br>`T/limits/lease-lifecycle.test.ts` | `L07` | 两个主体持续续租；失联在安全余量内取消，结束只释放一次 |

### 注册与身份

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `A01` / 12 | [已完成] 用户身份查询 | `W/auth/users.ts`<br>`T/auth/users.test.ts` | `D02`、`F12` | 登录查询与个人查询受限，不输出密码摘要 |
| `A02` / 13 | [已完成] 会话创建与撤销存储 | `W/auth/session-repository.ts`<br>`T/auth/session-repository.test.ts` | `D03`、`F13` | 仅存摘要；撤销/到期后不能加载会话 |
| `A03` / 14 | [已完成] Cookie 会话服务 | `W/auth/sessions.ts`<br>`T/auth/sessions.test.ts` | `A02`、`F10` | 七天固定期限和安全 Cookie 属性；登录轮换令牌 |
| `A04` / 15 | [已完成] 会话鉴权中间件 | `W/auth/middleware.ts`<br>`T/auth/middleware.test.ts` | `A01`、`A03` | 每次验证用户状态与会话，停用后拒绝 |
| `A05` / 16 | [已完成] 管理员角色守卫 | `W/auth/roles.ts`<br>`T/auth/roles.test.ts` | `A04` | 普通用户直接调用管理员路由被拒 |
| `A06` / 15 | [已完成] Origin 与 CSRF 校验 | `W/auth/csrf.ts`<br>`T/auth/csrf.test.ts` | `A03`、`F11` | 写接口校验 Origin/CSRF；未登录页可取得预登录凭证，不能要求先登录才能注册或登录 |
| `A07` / 15 | [已完成] 登录验证服务 | `W/auth/login.ts`<br>`T/auth/login.test.ts` | `A01`、`A03`、`F16`、`L08` | 错误统一、失败限流、正确密码创建会话 |
| `A08` / 16 | [已完成] 登录 HTTP 接口 | `W/auth/login-routes.ts`<br>`T/auth/login-routes.test.ts` | `A07`、`A06` | 协议契约、Cookie 与错误码可测 |
| `A09` / 14 | [已完成] 注册设置读取与更新 | `W/auth/registration-settings.ts`<br>`T/auth/registration-settings.test.ts` | `D01`、`O01`、`F10` | 提交查权威设置，版本冲突不覆盖，修改带审计 |
| `A10` / 17 | [已完成] 注册设置管理接口 | `W/admin/registration-settings-routes.ts`<br>`T/admin/registration-settings-routes.test.ts` | `A09`、`A05`、`A06` | 管理员权限、模式/验证开关组合正确 |
| `A11` / 14 | [已完成] 生成注册码并只存摘要 | `W/auth/registration-codes.ts`<br>`T/auth/registration-codes.test.ts` | `D05`、`F13`、`O01`、`A11-D` | 随机秘密只首次返回，批次幂等识别，无自动余额 |
| `A11-L` / 15 | [已完成] 注册码分页和使用记录查询 | `W/auth/registration-codes.ts`<br>`T/auth/registration-codes.test.ts` | `A11` | 列表无明文，使用者/过期/撤销状态和分页稳定 |
| `A11-R` / 16 | [已完成] 撤销未使用注册码 | `W/auth/registration-codes.ts`<br>`T/auth/registration-codes.test.ts` | `A11-L` | 条件修改并审计，已使用码不可改成可用 |
| `A12` / 17 | [已完成] 注册码列表接口 | `W/admin/registration-code-routes.ts`<br>`T/admin/registration-code-routes.test.ts` | `A11-L`、`A05`、`A06` | 仅管理员可分页查看掩码及使用记录 |
| `A12-C` / 18 | [已完成] 注册码生成接口 | `W/admin/registration-code-routes.ts`<br>`T/admin/registration-code-routes.test.ts` | `A12` | 权限/幂等键正确，明文仅首次展示 |
| `A12-R` / 19 | [已完成] 注册码撤销接口 | `W/admin/registration-code-routes.ts`<br>`T/admin/registration-code-routes.test.ts` | `A12-C`、`A11-R` | 未用码可撤销；已使用状态不被覆盖 |
| `A13` / 10 | [已完成] 邮箱规范化与验证码摘要 | `W/auth/email-proof.ts`<br>`T/auth/email-proof.test.ts` | `F13`、`F10` | 邮箱/用途/generation 绑定，不合并点号或加号地址 |
| `A14` / 13 | [已完成] 挑战替换与发送状态存储 | `W/auth/challenge-repository.ts`<br>`T/auth/challenge-repository.test.ts` | `D06`、`A13` | 重发生成新 generation；旧发送回调不能覆盖新状态 |
| `A15` / 14 | [已完成] 验证码错误尝试计数 | `W/auth/challenge-repository.ts`<br>`T/auth/challenge-repository.test.ts` | `A14` | 错误次数独立提交；超限或过期不能通过最终检查 |
| `A16` / 7 | [已完成] Email binding 发送封装 | `W/auth/email-sender.ts`<br>`T/auth/email-sender.test.ts` | `F06` | accepted/failed/unknown 分类正确，日志不含验证码 |
| `A17` / 15 | [已完成] 发码用例与路由 | `W/auth/send-code.ts`<br>`T/auth/send-code.test.ts` | `A09`、`A15`、`A16`、`L08`、`F11` | closed 拒绝、双维限流、先持久化再发送、不泄露已有邮箱 |
| `A18` / 16 | [已完成] 原子注册用例 | `W/auth/register.ts`<br>`T/auth/register.test.ts` | `D12`、`A09`、`A13`、`F16`、`A03`、`L08`、`A15`、`L08-REG` | 设置/邮箱/码同操作验证，普通用户零余额；会话失败不重复注册 |
| `A19` / 17 | [已完成] 注册 HTTP 接口 | `W/auth/register-routes.ts`<br>`T/auth/register-routes.test.ts` | `A18`、`A06`、`F11` | 三模式×验证开关均按提交时设置执行 |
| `A20` / 16 | [已完成] 当前身份 me 接口 | `W/auth/session-routes.ts`<br>`T/auth/session-routes.test.ts` | `A03`、`A04`、`A06` | 过期/停用会话拒绝，只输出当前用户公开身份 |
| `A20-O` / 17 | [已完成] 退出会话接口 | `W/auth/session-routes.ts`<br>`T/auth/session-routes.test.ts` | `A20` | 写请求校验 CSRF，撤销当前令牌并清 Cookie |
| `A21` / 14 | [已完成] 管理员人工创建用户 | `W/admin/create-user.ts`<br>`T/admin/create-user.test.ts` | `A01`、`F16`、`O01` | 只允许受控创建普通用户、零余额，无公开管理员选项 |
| `A22` / 17 | [已完成] 管理员用户列表接口 | `W/admin/user-routes.ts`<br>`T/admin/user-routes.test.ts` | `A01`、`A05`、`A06` | 分页/作用域/掩码正确，不返回密码摘要 |
| `A22-C` / 18 | [已完成] 管理员创建用户接口 | `W/admin/user-routes.ts`<br>`T/admin/user-routes.test.ts` | `A22`、`A21` | 仅管理员创建零余额普通用户，重复邮箱返回稳定错误 |
| `A23` / 14 | [已完成] 用户状态/组/限额修改 | `W/admin/update-user.ts`<br>`T/admin/update-user.test.ts` | `D01`、`A01`、`O01`、`F10` | 配置校验，禁止停用最后管理员，不直接修改余额 |
| `A24` / 19 | [已完成] 接入用户修改接口 | `W/admin/user-routes.ts`<br>`T/admin/user-routes.test.ts` | `A22-C`、`A23` | PATCH 仅允许字段，版本冲突不覆盖 |
| `A25` / 13 | [已完成] 创建平台 Key 存储 | `W/auth/key-repository.ts`<br>`T/auth/key-repository.test.ts` | `D04`、`F13` | 仅存摘要，默认权限不超过用户，明文不持久化 |
| `A25-L` / 15 | [已完成] 平台 Key 列表与鉴权查询 | `W/auth/key-repository.ts`<br>`T/auth/key-repository.test.ts` | `A25`、`A25-IDEM` | 按 user/hash 受限查询，期限/停用/模型权限可判定 |
| `A25-U` / 16 | [已完成] 修改和撤销平台 Key 存储 | `W/auth/key-repository.ts`<br>`T/auth/key-repository.test.ts` | `A25-L` | 只能缩限到用户许可范围，已撤销 Key 不能更新恢复 |
| `A26` / 16 | [已完成] 个人 Key 列表接口 | `W/auth/key-routes.ts`<br>`T/auth/key-routes.test.ts` | `A25-L`、`A04`、`A06` | 只能列自己的 Key，掩码、权限/期限正确 |
| `A26-C` / 17 | [已完成] 个人 Key 创建接口 | `W/auth/key-routes.ts`<br>`T/auth/key-routes.test.ts` | `A26` | 只首次返回明文，权限与幂等重放语义正确 |
| `A26-U` / 18 | [已完成] 个人 Key 修改接口 | `W/auth/key-routes.ts`<br>`T/auth/key-routes.test.ts` | `A26-C`、`A25-U` | 名称/期限/模型限制可改，不越权不扩大用户权限 |
| `A26-R` / 19 | [已完成] 个人 Key 撤销接口 | `W/auth/key-routes.ts`<br>`T/auth/key-routes.test.ts` | `A26-U` | 校验 owner/CSRF，重复撤销幂等 |
| `A27` / 16 | [已完成] 网关平台 Key 鉴权 | `W/auth/api-key-auth.ts`<br>`T/auth/api-key-auth.test.ts` | `A25-L`、`A01` | Bearer/x-api-key 冲突拒绝；过期/撤销/停用拒绝 |
| `A28` / 17 | [已完成] 管理员撤销 Key 接口 | `W/admin/key-routes.ts`<br>`T/admin/key-routes.test.ts` | `A25-U`、`A05`、`A06`、`O01` | 可以撤销指定 Key 且有审计，用户无权限 |
| `A29` / 13 | [已完成] 受控管理员初始化脚本 | `S/bootstrap-admin.ts`<br>`DOC/admin-bootstrap.md` | `D14`、`F16`、`A01` | 本地交互输入，数据库仅存摘要，无公开初始化或默认密码 |
| `A30` / 16 | [已完成] 公开注册设置接口 | `W/auth/public-settings-routes.ts`<br>`T/auth/public-settings-routes.test.ts` | `A09`、`F11`、`A06` | 只输出公开开关并支持预登录 CSRF 初始化，不泄露敏感配置；旧页面不能授权注册 |
| `A31` / 22 | [已完成] 挂载身份和用户管理路由 | `W/routes.ts`<br>`T/auth/routes-integration.test.ts` | `A08`、`A10`、`A12-R`、`A17`、`A19`、`A20-O`、`A24`、`A26-R`、`A28`、`A30`、`F05`、`A31-SESSION`、`AUDIT-BOOTSTRAP`、`A10-LAZY`、`A12-LAZY`、`A22-LAZY` | 所有已实现接口可经 Worker 入口访问；404/权限规则保持 |

### 渠道与 KV

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `C01` / 9 | [已完成] 加密和解密渠道密钥 | `W/admin/channel-secrets.ts`<br>`T/admin/channel-secrets.test.ts` | `F07` | AES-GCM nonce/AAD/key_version 正确，篡改密文失败 |
| `C02` / 9 | [已完成] 验证和拼接上游 URL | `W/gateway/upstream-url.ts`<br>`T/gateway/upstream-url.test.ts` | `F07` | HTTPS/路径前缀规则正确，拒绝危险目标与重复 /v1 |
| `C03` / 14 | [已完成] 渠道存储和掩码查询 | `W/admin/channel-repository.ts`<br>`T/admin/channel-repository.test.ts` | `D07`、`C01`、`C02`、`O01` | 密钥不原文返回，状态/版本和审计可原子修改 |
| `C04` / 17 | [已完成] 渠道列表接口 | `W/admin/channel-routes.ts`<br>`T/admin/channel-routes.test.ts` | `C03`、`A05`、`A06` | 管理员分页查看掩码，不泄漏密文/秘密 |
| `C04-C` / 18 | [已完成] 渠道创建接口 | `W/admin/channel-routes.ts`<br>`T/admin/channel-routes.test.ts` | `C04` | 目标/密钥/限制校验，创建和审计一致 |
| `C05` / 19 | [已完成] 渠道更新/启停接口 | `W/admin/channel-routes.ts`<br>`T/admin/channel-routes.test.ts` | `C04-C` | 版本冲突拒绝；密钥留空保留/显式更新的语义明确 |
| `C06` / 14 | [已完成] 访问组与成员关系存储 | `W/admin/group-repository.ts`<br>`T/admin/group-repository.test.ts` | `D01`、`D07`、`O01` | 组和渠道关系原子更新，重复关系不产生重复路由 |
| `C07` / 17 | [已完成] 访问组列表接口 | `W/admin/group-routes.ts`<br>`T/admin/group-routes.test.ts` | `C06`、`A05`、`A06` | 权限和组/渠道关系查询正确 |
| `C07-C` / 18 | [已完成] 访问组创建接口 | `W/admin/group-routes.ts`<br>`T/admin/group-routes.test.ts` | `C07` | 仅管理员可创建，重复名称和默认值行为明确 |
| `C07-U` / 19 | [已完成] 访问组更新接口 | `W/admin/group-routes.ts`<br>`T/admin/group-routes.test.ts` | `C07-C` | 修改渠道关系有权限/版本校验和审计 |
| `C08` / 14 | [已完成] 模型与价格配置存储 | `W/admin/model-repository.ts`<br>`T/admin/model-repository.test.ts` | `D08`、`F10`、`O01` | 价格版本、必填输出上限、显式零价格校验 |
| `C09` / 17 | [已完成] 公开模型列表管理接口 | `W/admin/model-routes.ts`<br>`T/admin/model-routes.test.ts` | `C08`、`A05`、`A06` | 返回显式售卖价、价格版本、状态与输出限制 |
| `C09-C` / 18 | [已完成] 公开模型创建接口 | `W/admin/model-routes.ts`<br>`T/admin/model-routes.test.ts` | `C09` | 必填价格/输出上限，不能把缺价当免费 |
| `C09-U` / 19 | [已完成] 公开模型更新/改价接口 | `W/admin/model-routes.ts`<br>`T/admin/model-routes.test.ts` | `C09-C` | 版本冲突不覆盖，启停/改价有审计 |
| `C10` / 15 | [已完成] 渠道模型能力映射存储 | `W/admin/model-mappings.ts`<br>`T/admin/model-mappings.test.ts` | `D08`、`C03`、`C08` | 同模型多协议映射无混淆，能力与供应商模型有显式对应 |
| `C11` / 17 | [已完成] 渠道模型映射接口 | `W/admin/mapping-routes.ts`<br>`T/admin/mapping-routes.test.ts` | `C10`、`A05`、`A06` | 仅允许类型化字段，组/渠道权限一致 |
| `C12` / 10 | [已完成] KV 快照编解码和时效 | `W/cache/snapshot.ts`<br>`T/cache/snapshot.test.ts` | `F07`、`F10` | schema/observed_at 校验，写入不得刷新旧快照年龄 |
| `C13` / 16 | [已完成] 路由配置缓存 | `W/cache/routes.ts`<br>`T/cache/routes.test.ts` | `C12`、`C03`、`C06`、`C10` | 过期/失效/429 回源，无密钥明文缓存 |
| `C14` / 15 | [已完成] 模型价格缓存 | `W/cache/prices.ts`<br>`T/cache/prices.test.ts` | `C12`、`C08` | 版本保留，回填失败不影响正式配置 |
| `C15` / 12 | [已完成] 可选余额缓存 | `W/cache/balance.ts`<br>`T/cache/balance.test.ts` | `C12`、`D02` | 默认关闭；启用后十五秒业务期限、低余额回源、充值不误拒 |
| `C16` / 17 | [已完成] 候选路由筛选与优先级 | `W/gateway/select-channel.ts`<br>`T/gateway/select-channel.test.ts` | `C13`、`A27`、`P10` | 组/模型/能力过滤，优先级内选择，无可映射渠道明确拒绝 |
| `C17` / 23 | [已完成] 挂载渠道/组/模型管理接口 | `W/routes.ts`<br>`W/channel-keyring.ts`<br>`T/admin/config-routes.test.ts` | `C05`、`C07-U`、`C09-U`、`C11`、`A31`、`C17-ENV` | 通过真实 Worker 路径可访问且权限正确，未知子路由不回 SPA |

### 计费与恢复

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `B01` / 9 | [已完成] 固定金额单位与解析 | `W/billing/money.ts`<br>`T/billing/money.test.ts` | `F07` | 1 USD=1e8 units；字符串/BigInt 换算与安全范围正确 |
| `B02` / 10 | [已完成] 互斥计费桶与取整 | `W/billing/pricing.ts`<br>`T/billing/pricing.test.ts` | `B01` | 缓存/reasoning 不双计；合计后 half-up；样例 $0.002=200000 units |
| `B03` / 15 | [已完成] 价格快照和结算指纹 | `W/billing/fingerprint.ts`<br>`T/billing/fingerprint.test.ts` | `B02`、`C08` | 固定字段/顺序/计算版本；同事实同指纹，改价不改历史 |
| `B04` / 16 | [已完成] 原子消费账单存储 | `W/billing/settlement-repository.ts`<br>`T/billing/settlement-repository.test.ts` | `D13`、`B03` | 唯一键冲突查原账单；相同重放无效果，不同指纹冲突 |
| `B05` / 17 | [已完成] 准入余额检查 | `W/billing/admission.ts`<br>`T/billing/admission.test.ts` | `B01`、`C15`、`A27` | balance>0 且 >=模型门槛；D1 不可用拒绝，不冻结余额 |
| `B06` / 17 | [已完成] 管理员余额调整用例 | `W/billing/adjustments.ts`<br>`T/billing/adjustments.test.ts` | `B04`、`O01` | 正负 delta 幂等、原账单不可覆盖、原因必填 |
| `B07` / 18 | [已完成] 余额查询接口 | `W/billing/balance-routes.ts`<br>`T/billing/balance-routes.test.ts` | `B05`、`A04` | 仅返回自己的 D1 当前余额，负数与金额尺度明确 |
| `B08` / 18 | [已完成] 管理员授额接口 | `W/admin/balance-routes.ts`<br>`T/admin/balance-routes.test.ts` | `B06`、`A05`、`A06` | Idempotency-Key 必填，重复操作不重复授额 |
| `B09` / 16 | [已完成] 账单分页查询 | `W/billing/entry-queries.ts`<br>`T/billing/entry-queries.test.ts` | `D10`、`A04`、`F11` | 按用户索引查询，无越权或分页重复 |
| `B10` / 17 | [已完成] 个人账单查询接口 | `W/billing/entry-routes.ts`<br>`T/billing/entry-routes.test.ts` | `B09`、`A05` | 只查本人账单，金额/分页/消费与调整类型正确 |
| `B10-A` / 18 | [已完成] 管理员账单查询接口 | `W/billing/entry-routes.ts`<br>`T/billing/entry-routes.test.ts` | `B10` | 角色守卫，按用户/时间/状态过滤，无修改原账单入口 |
| `B11` / 17 | [已完成] 请求登记和条件状态更新 | `W/gateway/request-repository.ts`<br>`T/gateway/request-repository.test.ts` | `D09`、`A27`、`C10` | 生成内部 ID；发送前落库；终态不能被晚到更新降级 |
| `B12` / 18 | [已完成] 请求/异常查询接口 | `W/gateway/request-query-routes.ts`<br>`T/gateway/request-query-routes.test.ts` | `B11`、`A04`、`A05`、`F11` | 个人隔离，管理筛选、价格/usage/错误可追踪 |
| `B13` / 18 | [已完成] 有限即时结算重试 | `W/billing/settlement.ts`<br>`T/billing/settlement.test.ts` | `B04`、`B11` | 同 operation_id 最多三次/六秒，提交响应丢失不误判未扣 |
| `B14` / 19 | [已完成] 保存可恢复结算证据 | `W/billing/recovery.ts`<br>`T/billing/recovery.test.ts` | `B13` | 仅完整 usage 可待结算；已存在账单时不降级 settled |
| `B15` / 20 | [已完成] Cron 重试已知结算 | `W/scheduled/settlements.ts`<br>`T/scheduled/settlements.test.ts` | `B14` | 五轮有上限；重叠 Cron 和迟到结果不双扣 |
| `B16` / 21 | [已完成] Cron 发现未知用量 | `W/scheduled/abandoned.ts`<br>`T/scheduled/abandoned.test.ts` | `B11`、`B15`、`F10` | 超过调用上限+宽限才处理；已有账单不误报未知 |
| `B17` / 13 | [已完成] 过期身份数据清理 | `W/scheduled/cleanup.ts`<br>`T/scheduled/cleanup.test.ts` | `D03`、`D06`、`D05` | 分页清理，不删除注册码使用记录/未结请求/账单幂等键 |
| `B18` / 20 | [已完成] 人工结算重试接口 | `W/admin/settlement-routes.ts`<br>`T/admin/settlement-routes.test.ts` | `B14`、`A05`、`A06`、`O01` | 只能重试已知完整证据，未知用量不按零费用处理 |
| `B19` / 18 | [已完成] 余额与账单核对查询 | `W/billing/reconciliation.ts`<br>`T/billing/reconciliation.test.ts` | `B04`、`B06` | 余额等于追加 delta 之和；可定位差额与负余额用户 |
| `B20` / 25 | [已完成] 挂载账单/请求/调整接口 | `W/routes.ts`<br>`T/billing/routes-integration.test.ts` | `B07`、`B08`、`B10-A`、`B12`、`B18`、`C17`、`B20-EARLY` | 管理/用户 scope 正确，账单接口可经 Worker 调用 |
| `B21` / 22 | [已完成] 接入同一 Worker 的 Cron | `W/scheduled/index.ts`<br>`W/index.ts`<br>`T/scheduled/integration.test.ts` | `B15`、`B16`、`B17`、`F05`<br>写序：`F06-W` | 一次 scheduled 分批执行；局部失败不丢其他巡检结果，无新 jobs 服务 |

### 协议公共基础

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P01` / 5 | [已完成] 固定转换器与共享语义契约 | `P/types/shared.ts`<br>`P/types/adapter.ts` | `F04` | 请求/JSON/流转换和 usage 接口分离；协议包无 I/O/计费副作用 |
| `P02` / 9 | [已完成] Chat wire 类型与入口校验 | `P/types/chat.ts`<br>`T/apicompat/types/chat.test.ts` | `P01`、`F07` | 文本/消息/工具扩展字段可表示，基本无效结构可识别 |
| `P03` / 9 | [已完成] Responses wire 类型与入口校验 | `P/types/responses.ts`<br>`T/apicompat/types/responses.test.ts` | `P01`、`F07` | items、状态、函数与引用字段可表示 |
| `P04` / 9 | [已完成] Messages wire 类型与入口校验 | `P/types/messages.ts`<br>`T/apicompat/types/messages.test.ts` | `P01`、`F07` | system/content blocks/stop_reason/usage 可表示 |
| `P05` / 9 | [已完成] 稳定响应和工具 ID | `P/ids.ts`<br>`T/apicompat/ids.test.ts` | `P01`、`F07` | 单请求 ID 稳定、并行工具不串号，不用客户端 ID 作为账单键 |
| `P06` / 10 | [已完成] 原生错误结构编码 | `P/errors.ts`<br>`T/apicompat/errors.test.ts` | `P02`、`P03`、`P04` | HTTP/流内错误按目标协议编码，敏感字段不透出 |
| `P07` / 9 | [已完成] SSE 帧基础解析 | `P/streams/parser.ts`<br>`T/apicompat/streams/parser.test.ts` | `P01`、`F07` | 跨 chunk、多行 data、注释/心跳正确 |
| `P08` / 10 | [已完成] SSE UTF-8 与截断处理 | `P/streams/parser.ts`<br>`T/apicompat/streams/parser.test.ts` | `P07` | 任意字节切分不损坏文本，EOF 残帧不伪装正常事件 |
| `P09` / 11 | [已完成] SSE 缓冲与背压辅助 | `P/streams/buffers.ts`<br>`T/apicompat/streams/buffers.test.ts` | `P08` | 不完整帧/工具参数上限明确，慢读不会无界积累 |
| `P10` / 10 | [已完成] 请求能力识别与可映射判断 | `P/capabilities/check.ts`<br>`T/apicompat/capabilities/check.test.ts` | `P02`、`P03`、`P04` | 工具/图片/结构化输出/特殊引用要求可识别，不能静默删约束 |
| `P11` / 10 | [已完成] 停止原因与终态公共映射 | `P/finish-reasons.ts`<br>`T/apicompat/finish-reasons.test.ts` | `P02`、`P03`、`P04` | 正常、长度、工具、过滤、错误分开 |
| `P12` / 10 | [已完成] Chat 上游 usage 归一化 | `P/usage/chat.ts`<br>`T/apicompat/usage/chat.test.ts` | `P02` | 累计/缺失输入输出与缓存/reasoning 子集正确 |
| `P13` / 10 | [已完成] Responses 上游 usage 归一化 | `P/usage/responses.ts`<br>`T/apicompat/usage/responses.test.ts` | `P03` | usage 细分、累计、缺失与质量标记正确 |
| `P14` / 10 | [已完成] Messages 上游 usage 归一化 | `P/usage/messages.ts`<br>`T/apicompat/usage/messages.test.ts` | `P04` | 输入/输出/缓存读写计数语义正确，不重复相加 |
| `P15` / 11 | [已完成] Chat 同协议普通透传 | `P/passthrough/chat.ts`<br>`T/apicompat/passthrough/chat.test.ts` | `P02`、`P06`、`P12` | 映射公开模型、保留允许扩展、认证由 Worker 处理 |
| `P16` / 11 | [已完成] Responses 同协议普通透传 | `P/passthrough/responses.ts`<br>`T/apicompat/passthrough/responses.test.ts` | `P03`、`P06`、`P13` | 保留允许 items/扩展，未知服务端引用不误送 |
| `P17` / 11 | [已完成] Messages 同协议普通透传 | `P/passthrough/messages.ts`<br>`T/apicompat/passthrough/messages.test.ts` | `P04`、`P06`、`P14` | 保留允许 block/thinking/cache 字段且不泄漏上游凭据 |
| `P18` / 12 | [已完成] Chat 同协议流与 usage 提取 | `P/passthrough/chat-stream.ts`<br>`T/apicompat/passthrough/chat-stream.test.ts` | `P15`、`P09`、`P11` | 增量透传、结束标记、缺失 usage 与取消行为明确 |
| `P19` / 12 | [已完成] Responses 同协议流与 usage 提取 | `P/passthrough/responses-stream.ts`<br>`T/apicompat/passthrough/responses-stream.test.ts` | `P16`、`P09`、`P11` | item/response 终态与 usage 只提取一次 |
| `P20` / 12 | [已完成] Messages 同协议流与 usage 提取 | `P/passthrough/messages-stream.ts`<br>`T/apicompat/passthrough/messages-stream.test.ts` | `P17`、`P09`、`P11` | block/message 事件顺序保留且 usage 不双计 |
| `P21` / 1 | [已完成] 固定 Sub2API 来源与用例对应清单 | `DOC/protocol-baseline.md`<br>`THIRD_PARTY_NOTICES.md` | 无 | 记录固定 commit、源文件、适用许可证、fixture 来源；不复制凭据或整个旧项目 |
| `P21-L` / 2 | [已完成] 附带完整GPL/LGPL许可文本 | `LICENSES/GPL-3.0.txt`<br>`LICENSES/LGPL-3.0.txt`<br>`THIRD_PARTY_NOTICES.md` | `P21` | 官方全文/固定来源核对，保留文件级改编义务，不自动改变整体项目许可 |

### 跨协议 CR（chat → responses）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-CR-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P02`、`P03`、`P21`、`P21-L` | 转换 chat → responses；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-CR-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-CR-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-CR-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-CR-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-CR-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-CR-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/chat-to-responses.ts`<br>`T/apicompat/requests/chat-to-responses.test.ts` | `P-CR-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-CR-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P02`、`P03`、`P05`、`P21`、`P21-L` | 把 chat 响应变为 responses；公开模型和稳定响应 ID 正确 |
| `P-CR-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P-CR-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-CR-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P-CR-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-CR-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P-CR-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-CR-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P-CR-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-CR-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/chat-to-responses.ts`<br>`T/apicompat/responses/chat-to-responses.test.ts` | `P-CR-J3-T`、`P12`、`P13` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-CR-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P09`、`P05`、`P02`、`P03`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-CR-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-CR-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-CR-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-CR-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S4`、`P12`、`P13` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-CR-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S5`、`P-CR-Q5`、`P-CR-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 跨协议 CM（chat → messages）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-CM-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P02`、`P04`、`P21`、`P21-L` | 转换 chat → messages；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-CM-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-CM-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-CM-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-CM-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-CM-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-CM-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-CM-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P02`、`P04`、`P05`、`P21`、`P21-L` | 把 chat 响应变为 messages；公开模型和稳定响应 ID 正确 |
| `P-CM-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P-CM-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-CM-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P-CM-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-CM-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P-CM-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-CM-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P-CM-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-CM-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/chat-to-messages.ts`<br>`T/apicompat/responses/chat-to-messages.test.ts` | `P-CM-J3-T`、`P12`、`P14` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-CM-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P09`、`P05`、`P02`、`P04`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-CM-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P-CM-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-CM-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P-CM-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-CM-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P-CM-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-CM-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P-CM-S4`、`P12`、`P14` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-CM-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/chat-to-messages.ts`<br>`T/apicompat/streams/chat-to-messages.test.ts` | `P-CM-S5`、`P-CM-Q5`、`P-CM-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 跨协议 RC（responses → chat）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-RC-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P03`、`P02`、`P21`、`P21-L` | 转换 responses → chat；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-RC-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-RC-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-RC-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-RC-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-RC-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-RC-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/responses-to-chat.ts`<br>`T/apicompat/requests/responses-to-chat.test.ts` | `P-RC-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-RC-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P03`、`P02`、`P05`、`P21`、`P21-L` | 把 responses 响应变为 chat；公开模型和稳定响应 ID 正确 |
| `P-RC-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P-RC-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-RC-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P-RC-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-RC-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P-RC-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-RC-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P-RC-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-RC-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/responses-to-chat.ts`<br>`T/apicompat/responses/responses-to-chat.test.ts` | `P-RC-J3-T`、`P13`、`P12` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-RC-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P09`、`P05`、`P03`、`P02`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-RC-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P-RC-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-RC-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P-RC-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-RC-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P-RC-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-RC-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P-RC-S4`、`P13`、`P12` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-RC-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/responses-to-chat.ts`<br>`T/apicompat/streams/responses-to-chat.test.ts` | `P-RC-S5`、`P-RC-Q5`、`P-RC-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 跨协议 RM（responses → messages）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-RM-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P03`、`P04`、`P21`、`P21-L` | 转换 responses → messages；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-RM-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-RM-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-RM-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-RM-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-RM-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-RM-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/responses-to-messages.ts`<br>`T/apicompat/requests/responses-to-messages.test.ts` | `P-RM-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-RM-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P03`、`P04`、`P05`、`P21`、`P21-L` | 把 responses 响应变为 messages；公开模型和稳定响应 ID 正确 |
| `P-RM-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P-RM-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-RM-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P-RM-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-RM-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P-RM-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-RM-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P-RM-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-RM-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/responses-to-messages.ts`<br>`T/apicompat/responses/responses-to-messages.test.ts` | `P-RM-J3-T`、`P13`、`P14` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-RM-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P09`、`P05`、`P03`、`P04`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-RM-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P-RM-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-RM-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P-RM-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-RM-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P-RM-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-RM-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P-RM-S4`、`P13`、`P14` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-RM-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/responses-to-messages.ts`<br>`T/apicompat/streams/responses-to-messages.test.ts` | `P-RM-S5`、`P-RM-Q5`、`P-RM-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 跨协议 MC（messages → chat）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-MC-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P04`、`P02`、`P21`、`P21-L` | 转换 messages → chat；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-MC-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-MC-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-MC-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-MC-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-MC-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-MC-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/messages-to-chat.ts`<br>`T/apicompat/requests/messages-to-chat.test.ts` | `P-MC-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-MC-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P04`、`P02`、`P05`、`P21`、`P21-L` | 把 messages 响应变为 chat；公开模型和稳定响应 ID 正确 |
| `P-MC-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P-MC-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-MC-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P-MC-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-MC-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P-MC-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-MC-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P-MC-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-MC-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/messages-to-chat.ts`<br>`T/apicompat/responses/messages-to-chat.test.ts` | `P-MC-J3-T`、`P14`、`P12` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-MC-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P09`、`P05`、`P04`、`P02`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-MC-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P-MC-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-MC-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P-MC-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-MC-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P-MC-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-MC-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P-MC-S4`、`P14`、`P12` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-MC-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/messages-to-chat.ts`<br>`T/apicompat/streams/messages-to-chat.test.ts` | `P-MC-S5`、`P-MC-Q5`、`P-MC-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 跨协议 MR（messages → responses）

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P-MR-Q1` / 10 | [已完成] 请求：文本、角色与完整历史 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P04`、`P03`、`P21`、`P21-L` | 转换 messages → responses；system/developer 次序和文本多轮保持，未实现特性明确拒绝 |
| `P-MR-Q2` / 11 | [已完成] 请求：工具定义和工具往返 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q1`、`P05` | 工具 schema、choice、调用 ID、工具结果与并行关联保持 |
| `P-MR-Q3` / 12 | [已完成] 请求：图片内容块 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q2`、`P10` | URL/base64 与媒体类型正确；无图像能力前置拒绝，不代抓任意 URL |
| `P-MR-Q4` / 13 | [已完成] 请求：输出上限、采样与 stop | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q3`、`P10` | 上限/采样/stop 按目标协议映射，冲突或无等价能力明确报错 |
| `P-MR-Q4-O` / 14 | [已完成] 请求：结构化输出约束 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q4` | schema/strict 等支持则映射，不支持明确拒绝，不删除约束 |
| `P-MR-Q5` / 15 | [已完成] 请求：reasoning/thinking 语义 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q4-O` | 可映射思考配置保留；签名/私有内容不伪造或改作正文 |
| `P-MR-Q6` / 16 | [已完成] 请求：缓存和允许扩展 | `P/requests/messages-to-responses.ts`<br>`T/apicompat/requests/messages-to-responses.test.ts` | `P-MR-Q5` | cache_control/system 内容块按能力映射，跨协议未知字段不随意透传 |
| `P-MR-J1` / 10 | [已完成] 普通响应：文本、模型与 ID | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P04`、`P03`、`P05`、`P21`、`P21-L` | 把 messages 响应变为 responses；公开模型和稳定响应 ID 正确 |
| `P-MR-J2` / 11 | [已完成] 普通响应：工具调用和内容项 | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P-MR-J1` | 多工具/空文本/内容项索引及完整参数保持 |
| `P-MR-J3` / 12 | [已完成] 普通响应：结束原因 | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P-MR-J2`、`P06`、`P11` | 正常、长度、工具、过滤、失败状态准确映射 |
| `P-MR-J3-E` / 13 | [已完成] 普通响应：原生错误对象 | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P-MR-J3` | 上游失败转为目标 error 对象，不泄漏内部敏感信息 |
| `P-MR-J3-T` / 14 | [已完成] 普通响应：thinking 内容 | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P-MR-J3-E` | 可映射的思考内容保留；签名和私有内容不伪造或降格 |
| `P-MR-J4` / 15 | [已完成] 普通响应：usage 展示映射 | `P/responses/messages-to-responses.ts`<br>`T/apicompat/responses/messages-to-responses.test.ts` | `P-MR-J3-T`、`P14`、`P13` | 只格式转换已解释 usage，不重复计量；缺失不伪装精确零 |
| `P-MR-S1` / 12 | [已完成] 流：文本与起止生命周期 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P09`、`P05`、`P04`、`P03`、`P21`、`P21-L` | 增量文本及时输出，目标协议起止顺序和 ID 正确 |
| `P-MR-S2` / 13 | [已完成] 流：单工具参数分片 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P-MR-S1` | 参数片段不要求独立 JSON；开始/增量/完成关联正确 |
| `P-MR-S3` / 14 | [已完成] 流：并行工具交错 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P-MR-S2` | 两工具任意交错和空文本不串索引，不重复完成 |
| `P-MR-S4` / 15 | [已完成] 流：截断、错误与取消 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P-MR-S3`、`P06`、`P11` | 错误不转成功终态，EOF/长度/拒绝和取消可区分 |
| `P-MR-S5` / 16 | [已完成] 流：usage 累计与终态 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P-MR-S4`、`P14`、`P13` | 累计和增量不双计，只产生一个供计费读取的最终结果 |
| `P-MR-S6` / 17 | [已完成] 流：thinking 与扩展事件 | `P/streams/messages-to-responses.ts`<br>`T/apicompat/streams/messages-to-responses.test.ts` | `P-MR-S5`、`P-MR-Q5`、`P-MR-Q6` | 可映射思考/缓存事件保留，未知事件策略有 fixture，签名不伪造 |

### 协议整合

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `P22` / 18 | [已完成] 注册三种协议的直接转换器 | `P/index.ts`<br>`T/apicompat/registry.test.ts` | `P-CR-Q6`、`P-CR-J4`、`P-CR-S6`、`P-CM-Q6`、`P-CM-J4`、`P-CM-S6`、`P-RC-Q6`、`P-RC-J4`、`P-RC-S6`、`P-RM-Q6`、`P-RM-J4`、`P-RM-S6`、`P-MC-Q6`、`P-MC-J4`、`P-MC-S6`、`P-MR-Q6`、`P-MR-J4`、`P-MR-S6`、`P18`、`P19`、`P20`、`P22-EXPORTS` | 下游 d→上游 u 选请求 d→u、响应/流 u→d；九格正确，无两次 wire 中转 |
| `P23` / 19 | [已完成] 维护可交付字段兼容矩阵 | `DOC/protocol-support.md`<br>`T/apicompat/support-matrix.test.ts` | `P22`、`P10` | 每格标已实现/不支持字段，实际注册能力与表一致，十八路径全覆盖 |

### 网关装配

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `G01` / 17 | [已完成] 生成上游认证头和安全转发头 | `W/gateway/headers.ts`<br>`T/gateway/headers.test.ts` | `A27`、`C01`、`P06` | 不泄漏平台 Key；冲突认证头拒绝，hop-by-hop 头移除 |
| `G02` / 18 | [已完成] 上游 Fetch 与超时/重定向 | `W/gateway/transport.ts`<br>`T/gateway/transport.test.ts` | `G01`、`C02`、`F10` | HTTPS/受控重定向、头超时、取消信号正确 |
| `G03` / 19 | [已完成] 最终 D1 准入与请求登记 | `W/gateway/admit.ts`<br>`T/gateway/admit.test.ts` | `B11`、`B05`、`C16`、`L07`、`C14`、`B11-TIME` | 最后校验 Key/用户/组/渠道/价格版本，登记失败不发上游 |
| `G04` / 11 | [已完成] Chat 入口解析 | `W/gateway/parse-chat.ts`<br>`T/gateway/parse-chat.test.ts` | `P02`、`P10`、`F10`、`G04-BODY` | 正文/输出上限验证；只解析，不调用或计费 |
| `G05` / 11 | [已完成] Responses 入口解析 | `W/gateway/parse-responses.ts`<br>`T/gateway/parse-responses.test.ts` | `P03`、`P10`、`F10`、`G04-BODY` | 完整历史/items/引用字段验证，非法组合拒绝 |
| `G06` / 11 | [已完成] Messages 入口解析 | `W/gateway/parse-messages.ts`<br>`T/gateway/parse-messages.test.ts` | `P04`、`P10`、`F10`、`G04-BODY` | system/content blocks 和版本头验证正确 |
| `G07` / 21 | [已完成] 普通调用协调器 | `W/gateway/execute-json.ts`<br>`T/gateway/execute-json.test.ts` | `G02`、`G03`、`P01`、`B13`、`P12`、`P13`、`P14`、`P21`、`G01-STRICT`、`G03-HISTORY`、`P22-EXPORTS` | 先登记后调用；可注入转换器，先尝试结算再返回，不重复生成 |
| `G08` / 21 | [已完成] 流式读写与转换泵 | `W/gateway/execute-stream.ts`<br>`T/gateway/execute-stream.test.ts` | `G02`、`G03`、`P01`、`P09`、`G01-STRICT`、`G03-HISTORY`、`P22-EXPORTS` | 边读边转换，handler 返回 Response 不等于调用结束 |
| `G09` / 22 | [已完成] 慢客户端背压和缓冲限制 | `W/gateway/execute-stream.ts`<br>`T/gateway/execute-stream.test.ts` | `G08` | 慢读不无限缓冲，不先收集整段输出 |
| `G10` / 23 | [已完成] 流取消与上游中止 | `W/gateway/execute-stream.ts`<br>`T/gateway/execute-stream.test.ts` | `G09` | 取消停止下游写入，AbortSignal 传到上游，缺失 usage 不捏造 |
| `G11` / 24 | [已完成] JSON/流的结算与租约收尾 | `W/gateway/finalize.ts`<br>`T/gateway/finalize.test.ts` | `G07`、`G10`、`B14`、`L10` | 收尾只执行一次；已输出内容不撤回，续租持续到真正结束 |
| `G12` / 20 | [已完成] 安全候选切换与冷却 | `W/gateway/retry-policy.ts`<br>`T/gateway/retry-policy.test.ts` | `G02`、`L09`、`G03` | 只重试可确认未执行的失败；流出首字后不重放，尝试数受限 |
| `G13` / 18 | [已完成] 原生 Responses 历史归属 | `W/gateway/response-history.ts`<br>`T/gateway/response-history.test.ts` | `B11`、`A27`、`P03` | 按用户/Key 校验响应 ID，固定原渠道；跨协议未知引用明确拒绝 |
| `G14` / 25 | [已完成] 装配协议注册表与调用用例 | `W/gateway/dispatch.ts`<br>`T/gateway/dispatch.test.ts` | `P22`、`G04`、`G05`、`G06`、`G11`、`G12`、`G13` | 九格请求 d→u、响应 u→d 正确；按上游 usage 只计一次 |
| `G15` / 17 | [已完成] 公开模型列表接口 | `W/gateway/models-route.ts`<br>`T/gateway/models-route.test.ts` | `C10`、`A27` | 只返回用户/Key 有权访问的公开模型 |
| `G16` / 26 | [已完成] Chat 路由 JSON/SSE 接入 | `W/gateway/chat-route.ts`<br>`T/gateway/chat-route.test.ts` | `G14` | 目标 endpoint 返回原生 Chat 结构，错误不套管理 envelope |
| `G17` / 26 | [已完成] Responses 路由 JSON/SSE 接入 | `W/gateway/responses-route.ts`<br>`T/gateway/responses-route.test.ts` | `G14` | 目标 endpoint 与历史引用边界正确 |
| `G18` / 26 | [已完成] Messages 路由 JSON/SSE 接入 | `W/gateway/messages-route.ts`<br>`T/gateway/messages-route.test.ts` | `G14` | 目标 endpoint、认证方式与流事件符合 Messages 客户端 |
| `G20` / 19 | [已完成] 管理员渠道测试接口 | `W/gateway/test-channel-route.ts`<br>`T/gateway/test-channel-route.test.ts` | `G02`、`C03`、`A05`、`A06`、`O01` | 明确点击才调用上游，限制测试输出并记录诊断/可能费用 |
| `G21` / 25 | [已完成] 脱敏请求观测 | `W/gateway/observability.ts`<br>`T/gateway/observability.test.ts` | `G11`、`B11` | request_id 贯穿阶段，日志无 prompt/Key/密码，费用异常可发现 |
| `G19` / 27 | [已完成] 挂载四个 /v1 入口 | `W/routes.ts`<br>`T/gateway/http-integration.test.ts` | `G15`、`G16`、`G17`、`G18`、`B20` | 四入口经过真实 Worker 路径；未实现路径返回协议错误而非 SPA |
| `G22` / 28 | [已完成] 接入渠道诊断和请求观测 | `W/routes.ts`<br>`W/gateway/dispatch.ts`<br>`T/gateway/observability-integration.test.ts` | `G19`、`G20`、`G21`<br>写序：`STREAM-NOFETCH-DISPATCH` | 观测不改变响应语义，管理诊断受权限保护 |
| `G23` / 28 | [已完成] 静态路由、CORS 与安全响应头 | `W/wrangler.jsonc`<br>`W/app.ts`<br>`T/gateway/routing-security.test.ts` | `F09`、`G19`、`A06`<br>写序：`X01`、`F05` | /api /v1 不回 SPA，前端路由可刷新，CORS/CSP 不绕过认证 |

### 最小控制台

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `U01` / 10 | [已完成] 前端 API 客户端和错误模型 | `UI/api/client.ts`<br>`UI/api/types.ts` | `F09`、`F11` | 金额字符串不转浮点，错误码/request_id 可显示 |
| `U02` / 20 | [已完成] 会话状态与 CSRF 接入 | `UI/stores/session.ts`<br>`UI/api/auth.ts` | `U01`、`A31-SESSION`、`AUDIT-CLIENT` | Cookie/CSRF 正确，退出清理状态，me 失败退回登录 |
| `U03` / 21 | [已完成] 用户/管理员布局 | `UI/components/AppLayout.vue`<br>`UI/App.vue` | `U02`、`F04-WEB-LIB`<br>写序：`F09` | 导航按角色显示，提供明确加载/错误状态 |
| `U04` / 22 | [已完成] 前端路由与登录守卫 | `UI/router.ts`<br>`UI/main.ts` | `U03`<br>写序：`F09` | 未登录重定向、管理员路由守卫，不代替后端授权 |
| `U05` / 23 | [已完成] 登录页 | `UI/views/LoginView.vue` | `U02`、`U04`、`A08` | 成功/失败/限流交互可用，支持密码管理器 |
| `U06` / 17 | [已完成] 注册页模式与表单 | `UI/views/RegisterView.vue`<br>`UI/api/registration.ts` | `U01`、`A30` | closed/open/invite 与验证开关决定输入项 |
| `U07` / 18 | [已完成] 注册验证码发送与重发 | `UI/views/RegisterView.vue` | `U06`、`A17` | 冷却倒计时、发送失败与 unknown 状态明确 |
| `U08` / 21 | [已完成] 提交注册和成功跳转 | `UI/views/RegisterView.vue` | `U07`、`A19`、`U02` | 提交携带所需凭证；错误不泄露已有账户，成功进入用户区 |
| `U09` / 19 | [已完成] 用户余额概览 | `UI/views/DashboardView.vue`<br>`UI/api/account.ts` | `U01`、`B07` | 真实余额/负余额正确，初期无支付按钮 |
| `U10` / 20 | [已完成] 个人 Key API 与列表 | `UI/api/keys.ts`<br>`UI/views/KeysView.vue` | `U01`、`A26-R` | 列表掩码、期限、模型权限可见 |
| `U11` / 21 | [已完成] 创建 Key 一次展示 | `UI/components/CreateKeyDialog.vue`<br>`UI/views/KeysView.vue` | `U10` | 仅首次展示秘密；丢失响应后的再生成语义明确 |
| `U12` / 22 | [已完成] 编辑与撤销 Key | `UI/components/EditKeyDialog.vue`<br>`UI/views/KeysView.vue` | `U11` | 可改名字/限制/期限；撤销后列表状态更新 |
| `U13` / 24 | [已完成] 挂载注册和个人入口 | `UI/router.ts`<br>`UI/components/AppLayout.vue` | `U05`、`U08`、`U09`、`U12`、`U04-REGISTER`<br>写序：`U03` | 注册→登录→余额→Key 页面可经路由访问 |
| `U14` / 19 | [已完成] 个人用量查询客户端 | `UI/api/requests.ts`<br>`UI/api/billing.ts` | `U01`、`B10-A`、`B12` | 游标/时间筛选与权限错误可处理 |
| `U15` / 20 | [已完成] 个人请求列表 | `UI/views/RequestsView.vue`<br>`UI/components/RequestFilters.vue` | `U14` | 状态/模型/时间筛选，未知 usage 不显示为零费 |
| `U16` / 21 | [已完成] 个人请求详情 | `UI/views/RequestDetailView.vue` | `U15` | 展示协议、价格快照、usage、计费状态及 request_id |
| `U17` / 20 | [已完成] 个人账单明细 | `UI/views/BillingView.vue` | `U14` | 消费/授额/调整分开，金额和分页正确 |
| `U18` / 18 | [已完成] 管理注册设置 | `UI/views/admin/RegistrationSettingsView.vue`<br>`UI/api/admin-registration.ts` | `U01`、`A10` | 两维开关、邮件就绪提示、版本冲突可见 |
| `U19` / 20 | [已完成] 注册码列表和撤销 | `UI/views/admin/RegistrationCodesView.vue`<br>`UI/api/admin-registration.ts` | `U18`、`A12-R` | 使用者/过期/撤销可查，列表无明文 |
| `U20` / 21 | [已完成] 生成注册码一次展示 | `UI/components/admin/CreateCodesDialog.vue`<br>`UI/views/admin/RegistrationCodesView.vue` | `U19` | 单次明文、重复操作与响应丢失处理明确 |
| `U21` / 20 | [已完成] 管理员用户列表 | `UI/views/admin/UsersView.vue`<br>`UI/api/admin-users.ts` | `U01`、`A24` | 分页、状态/组/限额可见 |
| `U22` / 21 | [已完成] 管理员创建用户 | `UI/components/admin/CreateUserDialog.vue`<br>`UI/views/admin/UsersView.vue` | `U21` | 只建零余额普通用户，密码不在列表回显 |
| `U23` / 22 | [已完成] 修改用户状态/组/限额 | `UI/components/admin/EditUserDialog.vue`<br>`UI/views/admin/UsersView.vue` | `U22` | 版本冲突处理，最后管理员保护不被 UI 绕过 |
| `U24` / 19 | [已完成] 管理员余额调整表单 | `UI/components/admin/BalanceAdjustmentDialog.vue`<br>`UI/api/admin-billing.ts` | `U01`、`B08` | 原因与幂等键必填，负值/授额金额不浮点转换 |
| `U25` / 20 | [已完成] 渠道列表和诊断状态 | `UI/views/admin/ChannelsView.vue`<br>`UI/api/admin-channels.ts` | `U01`、`C05`、`G20` | 密钥掩码、测试只有显式操作触发 |
| `U26` / 21 | [已完成] 渠道编辑表单 | `UI/components/admin/ChannelEditor.vue`<br>`UI/views/admin/ChannelsView.vue` | `U25` | URL 预览、启停/限额和密钥更新语义明确 |
| `U27` / 20 | [已完成] 模型和映射客户端 | `UI/api/admin-models.ts` | `U01`、`C09-U`、`C11` | 价格/能力字段类型化，版本冲突可处理 |
| `U28` / 21 | [已完成] 公开模型/价格编辑 | `UI/views/admin/ModelsView.vue`<br>`UI/components/admin/ModelEditor.vue` | `U27` | 显式单价、输出上限和版本显示正确 |
| `U29` / 22 | [已完成] 渠道模型映射编辑 | `UI/components/admin/ModelMappingEditor.vue`<br>`UI/views/admin/ModelsView.vue` | `U28` | 三协议能力与上游模型映射可操作 |
| `U30` / 20 | [已完成] 访问组管理 | `UI/views/admin/GroupsView.vue`<br>`UI/api/admin-groups.ts` | `U01`、`C07-U` | 组/渠道关系操作可用，不引入组继承/折扣 |
| `U31` / 21 | [已完成] 全局请求和异常列表 | `UI/views/admin/RequestsView.vue`<br>`UI/api/admin-requests.ts` | `U01`、`B12`、`B18` | 负余额关联、未知 usage、待结算筛选清楚 |
| `U32` / 22 | [已完成] 异常详情和安全重试 | `UI/views/admin/RequestDetailView.vue` | `U31` | 只有完整证据可点击结算重试，调整与原账单分开 |
| `U33` / 20 | [已完成] 管理账单和负余额展示 | `UI/views/admin/BillingView.vue`<br>`UI/api/admin-billing.ts` | `U24`、`B10-A`、`B19` | 负余额/调整/消费可查，无直接覆盖余额操作 |
| `U34` / 18 | [已完成] 管理审计查询页 | `UI/views/admin/AuditView.vue`<br>`UI/api/admin-audit.ts` | `U01`、`O02` | 操作者/目标/原因可查，不显示 Secret |
| `U35` / 26 | [已完成] 挂载剩余用户/管理页面 | `UI/router.ts`<br>`UI/components/AppLayout.vue`<br>`UI/views/admin/UsersView.vue` | `U13`、`U16`、`U17`、`U20`、`U23`、`U24`、`U26`、`U29`、`U30`、`U32`、`U33`、`U34`、`U35-REGISTRATION` | 所有已实现页面可达，管理员用户页接入余额调整对话框，普通用户不能进管理区 |

### 联合验收

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `Q01` / 18 | [验收后置] 注册竞争与回滚远程验证 | `T/remote/registration-atomic.test.ts`<br>`DOC/evidence/registration-atomic.md` | `A19`、`X02`、`D12` | 同邮箱/单次码争抢、重发和错误次数竞态在真实 D1 验证 |
| `Q02` / 18 | [验收后置] 账单并发与提交不确定性验证 | `T/remote/billing-atomic.test.ts`<br>`DOC/evidence/billing-atomic.md` | `B04`、`B06`、`X02` | 负余额、重放、不同指纹、响应丢失后查询，在真实 D1 可重现 |
| `Q03` / 25 | [已完成] 注册登录和 Key 的浏览器闭环 | `T/e2e/auth.spec.ts`<br>`playwright.config.ts` | `A31`、`U13`、`F09`、`Q03-HARNESS` | 三模式×验证开关、验证码重发、登录/退出、创建 Key 可用；本地邮件替身不冒充真投递 |
| `Q04` / 26 | [已完成] 模拟消费的计费闭环 | `T/billing/workflow.test.ts`<br>`DOC/evidence/billing-workflow.md` | `B20`、`B21`、`B19`、`L07` | 经 API 授额→准入→模拟 usage→扣负→拒绝→充值恢复，无真实生成费用 |
| `Q05` / 20 | [已完成] KV 故障与陈旧快照 | `T/cache/failure-matrix.test.ts`<br>`DOC/evidence/cache-failures.md` | `C13`、`C14`、`C15`、`B05`、`B14` | 负缓存、乱序回填、429、不可用、开关关闭不破坏账单/权限 |
| `Q06` / 17 | [已完成] DO 重启/续租/补偿验证 | `T/limits/lifecycle-integration.test.ts`<br>`DOC/evidence/lease-lifecycle.md` | `L10`、`L09`<br>外部验收后置：X01 | 多 Key 共享限额、重启恢复、二次获取失败、失联取消和过期回收 |
| `Q07` / 28 | [已完成] 真实上下游测试执行器 | `S/verify-upstream-matrix.ts`<br>`DOC/live-compatibility-testing.md` | `G19`<br>外部验收后置：X05、X06、X07 | 固定 SDK/模型/测试预算；输出脱敏结果，分别报告普通/SSE 和工具往返 |
| `Q08` / 28 | [已完成] Responses 状态引用隔离 | `T/gateway/response-history-integration.test.ts`<br>`DOC/evidence/response-history.md` | `G13`、`G19` | 跨用户/Key/渠道不可引用；原生固定路由成功，跨协议未知引用明确报错 |
| `Q09` / 29 | [已完成] 流生命周期故障注入 | `T/gateway/stream-failures.test.ts`<br>`DOC/evidence/stream-failures.md` | `G22`、`B21`、`Q06` | 慢读、取消、上游断流、D1 故障、Worker 终止窗口有确定状态 |
| `Q10` / 30 | [已完成] HTTP 权限和安全边界 | `T/security/http-boundaries.test.ts`<br>`DOC/evidence/security-boundaries.md` | `G23`、`O03` | Key 撤销、用户停用、ID 越权、CSRF、CORS、URL/头注入均覆盖 |
| `Q11` / 30 | [已完成] 管理操作浏览器闭环 | `T/e2e/admin.spec.ts`<br>`DOC/evidence/admin-workflow.md` | `U35`、`O03`、`Q03` | 配置注册/用户/渠道/价格/组、授额、异常查看与审计能完成 |
| `Q12` / 31 | [已完成] 注册到调用及账单的全链路 | `T/e2e/full-workflow.spec.ts`<br>`DOC/evidence/full-workflow.md` | `Q11`、`G19`、`B20`、`CM-STREAM-OPTIONS`、`P22-REQUEST-BUDGET` | 注册验证→登录→Key→授额→三入口调用→余额/账单查询；负余额可恢复 |
| `Q13` / 32 | [验收后置] 逐级负载与透支观察 | `S/load-gateway.ts`<br>`DOC/evidence/load-and-overdraft.md` | `Q09`、`Q12`、`R03` | 记录实际用户/并发/模型、p95、D1/DO/KV 调用量及透支；结论仅限测量规模 |

### 九格集成验收

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `Q-CC` / 29 | [已完成] chat 下游 → chat 上游 | `T/gateway/matrix/chat-chat.test.ts`<br>`T/fixtures/matrix/chat-chat.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-CR` / 29 | [已完成] chat 下游 → responses 上游 | `T/gateway/matrix/chat-responses.test.ts`<br>`T/fixtures/matrix/chat-responses.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-CM` / 29 | [已完成] chat 下游 → messages 上游 | `T/gateway/matrix/chat-messages.test.ts`<br>`T/fixtures/matrix/chat-messages.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-RC` / 29 | [已完成] responses 下游 → chat 上游 | `T/gateway/matrix/responses-chat.test.ts`<br>`T/fixtures/matrix/responses-chat.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-RR` / 29 | [已完成] responses 下游 → responses 上游 | `T/gateway/matrix/responses-responses.test.ts`<br>`T/fixtures/matrix/responses-responses.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-RM` / 29 | [已完成] responses 下游 → messages 上游 | `T/gateway/matrix/responses-messages.test.ts`<br>`T/fixtures/matrix/responses-messages.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-MC` / 29 | [已完成] messages 下游 → chat 上游 | `T/gateway/matrix/messages-chat.test.ts`<br>`T/fixtures/matrix/messages-chat.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-MR` / 29 | [已完成] messages 下游 → responses 上游 | `T/gateway/matrix/messages-responses.test.ts`<br>`T/fixtures/matrix/messages-responses.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |
| `Q-MM` / 29 | [已完成] messages 下游 → messages 上游 | `T/gateway/matrix/messages-messages.test.ts`<br>`T/fixtures/matrix/messages-messages.json` | `G19`、`P23`、`Q-MATRIX-HELPER` | 普通/SSE、文本多轮、单/并行工具、错误与 usage 按完整 HTTP 链路验证；账单只结算一次 |

### 九格真实上游验收

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `LIVE-CC` / 31 | [验收后置] chat → chat 真实客户端测试 | `DOC/evidence/live/chat-chat.md` | `Q07`、`Q-CC`、`X05`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-CR` / 31 | [验收后置] chat → responses 真实客户端测试 | `DOC/evidence/live/chat-responses.md` | `Q07`、`Q-CR`、`X06`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-CM` / 31 | [验收后置] chat → messages 真实客户端测试 | `DOC/evidence/live/chat-messages.md` | `Q07`、`Q-CM`、`X07`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-RC` / 31 | [验收后置] responses → chat 真实客户端测试 | `DOC/evidence/live/responses-chat.md` | `Q07`、`Q-RC`、`X05`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-RR` / 31 | [验收后置] responses → responses 真实客户端测试 | `DOC/evidence/live/responses-responses.md` | `Q07`、`Q-RR`、`X06`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-RM` / 31 | [验收后置] responses → messages 真实客户端测试 | `DOC/evidence/live/responses-messages.md` | `Q07`、`Q-RM`、`X07`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-MC` / 31 | [验收后置] messages → chat 真实客户端测试 | `DOC/evidence/live/messages-chat.md` | `Q07`、`Q-MC`、`X05`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-MR` / 31 | [验收后置] messages → responses 真实客户端测试 | `DOC/evidence/live/messages-responses.md` | `Q07`、`Q-MR`、`X06`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |
| `LIVE-MM` / 31 | [验收后置] messages → messages 真实客户端测试 | `DOC/evidence/live/messages-messages.md` | `Q07`、`Q-MM`、`X07`、`R03` | 使用真实下游 SDK 与上游，记录普通/SSE/多轮工具/usage、版本、费用和缺口 |

### 交付与运维

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `R01` / 29 | [已完成] 补齐构建/检查统一命令 | `package.json`<br>`DOC/development.md` | `G23`、`U35`、`Q03`、`P23`<br>写序：`F01` | 文档列出的安装/类型/测试/构建命令可在干净环境执行 |
| `R02` / 30 | [已完成] 自动化本地检查工作流 | `.github/workflows/check.yml`<br>`DOC/development.md` | `R01` | 锁文件安装、类型/单测/构建不依赖生产 Secret；不自动发布 |
| `R03` / 30 | [已完成] 部署完整 staging 验证环境 | `W/wrangler.jsonc`<br>`DOC/evidence/staging-deploy.md` | `G23`、`B21`、`U35`、`O03`、`X01`、`CF-D1-CASE` | 部署可复现的完整测试版本，迁移/Secret 引用/静态资源一致 |
| `R04` / 16 | [已完成] 编写部署和兼容回滚步骤 | `DOC/deployment.md`<br>`DOC/rollback.md` | `D13`、`C01`<br>外部验收后置：R03 | 说明代码/数据库/DO/加密版本兼容，回滚不回退已发生账单 |
| `R05` / 19 | [已完成] 编写备份和隔离恢复步骤 | `DOC/backup-restore.md`<br>`S/verify-restored-database.ts` | `B19`、`D13`、`C01` | 验证余额/账单/幂等键/密钥恢复，不把 Secret 导出到仓库 |
| `R06` / 31 | [验收后置] 执行隔离恢复演练 | `DOC/evidence/restore-drill.md` | `R05`、`R03` | 在隔离库恢复并核对，不切换生产 binding；记录真实限制 |
| `R07` / 31 | [验收后置] 记录密钥轮换验证 | `S/verify-key-rotation.ts`<br>`DOC/evidence/key-rotation.md` | `C01`、`C03`、`R03` | 新旧 key_version 可共存，测试渠道轮换后可解密；不动生产 Key |
| `R08` / 33 | [验收后置] 汇总一期目标证据 | `DOC/acceptance-report.md`<br>`DOC/protocol-support.md` | `K0`、`K1`、`K2`、`K3`、`Q10`、`Q11`、`Q12`、`Q13`、`R02`、`R04`、`R06`、`R07`、`F10-FIX`<br>写序：`P23` | P1-01 至 P1-13 每项链接真实证据，未通过不标完成 |

### 身份与注册

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `A25-IDEM` / 14 | [已完成] API Key创建幂等实现 | `W/auth/key-repository.ts`<br>`T/auth/key-repository.test.ts` | `A25`、`A25-D` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |
| `A31-EARLY` / 18 | [已完成] 提前挂载注册登录邮件公共设置 | `W/routes.ts`<br>`W/env.ts`<br>`T/integration/auth-entry.test.ts` | `A08`、`A19`、`A17`、`A30`、`F06-W`<br>写序：`F05`、`F06` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |
| `A31-SESSION` / 19 | [已完成] 挂载身份恢复和注销闭环 | `W/routes.ts`<br>`T/integration/auth-entry.test.ts` | `A31-EARLY`、`A20`、`A20-O` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |

### 限流与租约

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `L08-GATE-PEEK` / 13 | [已完成] Gate只读频率检查 | `W/limits/gate.ts`<br>`T/limits/gate.test.ts` | `L05` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |
| `L08-REG` / 15 | [已完成] 注册独立IP限流 | `W/config.ts`<br>`W/limits/auth-rate-limit.ts`<br>`T/limits/auth-rate-limit.test.ts` | `L08`、`F10-FIX` | 使用本地真实D1/DO或相应模块测试核对行为；无真实外部调用。 |

### 本地集成审计与修复

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `AUDIT-ENTRY` / 20 | [已完成] 补充真实入口注册原子性集成测试 | `T/integration/auth-admin-entry.test.ts` | `A31-SESSION`、`A11-R`、`A15` | 3项真实D1/DO/CSRF/HMAC主入口测试通过；新文件邮件及KDF明确mock，另有真实KDF闭环覆盖 |
| `AUDIT-CLIENT` / 11 | [已完成] 修复前端幂等键与分页契约 | `UI/api/client.ts`<br>`UI/api/types.ts`<br>`T/unit/api-client.node.test.ts` | `U01` | 先复现4项失败，修复后6/6测试及Web类型检查通过；保持同源/CSRF、无自动重试 |
| `AUDIT-LOGIN` / 20 | [已完成] 登录解耦邮件配置 | `W/routes.ts`<br>`T/integration/auth-entry.test.ts` | `A31-SESSION` | 5项旧代码失败回归；修复后22项生产入口测试和Worker类型检查通过 |
| `AUDIT-BOOTSTRAP` / 21 | [已完成] 邮件故障时保留匿名登录引导 | `W/routes.ts`<br>`T/integration/auth-entry.test.ts` | `AUDIT-LOGIN` | 无cookie获取nonce后登录回归先失败再通过；27项入口测试通过，坏邮件配置公开关闭注册，DB/CSRF错误不掩盖 |
| `AUDIT-HTTPS` / 22 | [已完成] 保存可重复的本地HTTPS契约检查 | `S/test-local-integration.py` | `AUDIT-BOOTSTRAP`、`AUDIT-ENTRY`、`AUDIT-CLIENT` | 真实Wrangler HTTPS及新建本地D1/DO；34项中23通过，11缺失业务入口明确失败并退出1；测试服务已关闭 |

### 必要集成修复

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `A10-LAZY` / 18 | [已完成] 注册设置接口延迟解析写入Origin | `W/admin/registration-settings-routes.ts`<br>`T/admin/registration-settings-routes.test.ts` | `A10` | 对应子代理已完成针对性验证与工作区类型检查；保持每节点最多三个文件。 |
| `A12-LAZY` / 20 | [已完成] 注册码接口延迟解析写入Origin | `W/admin/registration-code-routes.ts`<br>`T/admin/registration-code-routes.test.ts` | `A12-R` | 对应子代理已完成针对性验证与工作区类型检查；保持每节点最多三个文件。 |
| `A22-LAZY` / 20 | [已完成] 用户接口延迟解析写入Origin | `W/admin/user-routes.ts`<br>`T/admin/user-routes.test.ts` | `A24` | 对应子代理已完成针对性验证与工作区类型检查；保持每节点最多三个文件。 |
| `F04-WEB-LIB` / 6 | [已完成] 隔离vue-router依赖声明类型冲突 | `WEB/tsconfig.json` | `F04`<br>写序：`F08` | 对应子代理已完成针对性验证与工作区类型检查；保持每节点最多三个文件。 |

### 必要集成扩展

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `L09-GATE` / 14 | [已完成] Gate持久化短期冷却 | `W/limits/gate.ts`<br>`T/limits/gate.test.ts` | `L08-GATE-PEEK` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `L09-CLIENT` / 15 | [已完成] 租约客户端识别冷却拒绝 | `W/limits/client.ts`<br>`T/limits/client.test.ts` | `L06`、`L09-GATE` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `U04-REGISTER` / 23 | [已完成] 挂载已实现注册页面 | `UI/router.ts` | `U04`、`U08` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `U05-LINK` / 24 | [已完成] 更新登录页注册链接 | `UI/views/LoginView.vue` | `U05`、`U08` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `U35-REGISTRATION` / 25 | [已完成] 挂载注册管理页面 | `UI/router.ts`<br>`UI/components/AppLayout.vue` | `U13`、`U20` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `AUDIT-CLIENT-MODEL` / 12 | [已完成] 兼容安全编码的模型标识 | `UI/api/client.ts`<br>`T/unit/api-client.node.test.ts` | `AUDIT-CLIENT` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `C17-ENV` / 19 | [已完成] 声明版本化渠道加密Secret绑定 | `W/env.ts` | `A31-EARLY` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `B11-TIME` / 18 | [已完成] 申请租约后刷新同请求登记时钟 | `W/gateway/request-repository.ts`<br>`T/gateway/request-repository.test.ts` | `B11` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `G03-HISTORY` / 20 | [已完成] 最终准入应用历史绑定和候选排除 | `W/gateway/admit.ts`<br>`T/gateway/admit.test.ts` | `G03`、`G13` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `B09-TIME` / 17 | [已完成] 账单查询绑定时间范围 | `W/billing/entry-queries.ts`<br>`T/billing/entry-queries.test.ts` | `B09` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `B10-TIME` / 19 | [已完成] 账单HTTP解析时间筛选 | `W/billing/entry-routes.ts`<br>`T/billing/entry-routes.test.ts` | `B10-A`、`B09-TIME` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `G01-STRICT` / 19 | [已完成] 上游头严格空白与hop-by-hop校验 | `W/gateway/headers.ts`<br>`T/gateway/headers.test.ts` | `G01`、`G02` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `G04-BODY` / 10 | [已完成] 三个生成入口共享有界JSON读取 | `W/gateway/read-json.ts`<br>`T/gateway/read-json.test.ts` | `F10`、`F11` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `B20-EARLY` / 24 | [已完成] 接入已实现余额调整和账单接口 | `W/routes.ts`<br>`T/billing/entry-integration.test.ts` | `C17`、`B07`、`B08`、`B10-TIME` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `P22-EXPORTS` / 13 | [已完成] 导出现有协议公共模块子路径 | `P/package.json` | `P18`、`P19`、`P20`<br>写序：`F02` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `P04-OUTPUT-CONFIG` / 10 | [已完成] Messages原生output_config结构 | `P/types/messages.ts`<br>`T/apicompat/types/messages.test.ts` | `P04` | 对应实现及有意义的本地回归、类型检查通过；不将后续功能或真实外部验证推定完成。 |
| `Q03-HARNESS` / 23 | [已完成] 隔离本地HTTPS浏览器测试服务器与外部替身 | `S/start-local-test-server.mjs`<br>`T/helpers/http-test-worker.ts` | `F07`、`F09`、`A31` | 真实本地HTTPS、一次性D1/DO/KV、邮件及上游外呼guard；注册/管理/完整链路浏览器统一9/9。 |
| `Q-MATRIX-HELPER` / 28 | [已完成] 九方向共享真实Worker入口与账务测试设施 | `T/gateway/matrix/helper.ts` | `G19`、`P23` | app.fetch完整HTTP入口、D1/DO及仅上游fetch替身；九方向合跑81/81。 |
| `G11-STREAM` / 25 | [已完成] 流式结算完成后再释放租约 | `W/gateway/execute-stream.ts`<br>`T/gateway/execute-stream.test.ts` | `G08`、`G11`<br>写序：`G10` | 流式finalizer顺序集成已完成；最终网关415/415，包括stream执行23例。 |
| `G04-BODY-HARDEN` / 11 | [已完成] 有界JSON读取限制碎片对象开销 | `W/gateway/read-json.ts`<br>`T/gateway/read-json.test.ts` | `G04-BODY` | 单个几何增长缓冲区避免保留大量微小chunk；11个有界读取回归及Worker类型通过。 |
| `CM-STREAM-OPTIONS` / 17 | [已完成] Chat到Messages识别下游usage显示选项 | `P/requests/chat-to-messages.ts`<br>`T/apicompat/requests/chat-to-messages.test.ts` | `P-CM-Q6` | 接受已校验include_usage而不传给Messages上游，未知nested选项拒绝；网关40及registry15通过，Q12九格JSON/SSE闭环通过。 |
| `P22-REQUEST-BUDGET` / 19 | [已完成] 注册器使用逐请求已解析输出预算 | `P/index.ts`<br>`T/apicompat/registry.test.ts` | `P22` | 请求8低于渠道默认16保持有效且不突破max；registry15及Q12回归通过。 |
| `CR-TERMINAL-GUARD` / 18 | [已完成] 工具终态缺少工具调用时明确失败 | `P/streams/chat-to-responses.ts`<br>`T/apicompat/streams/chat-to-responses.test.ts` | `P-CR-S6` | tool_calls/function_call无工具对象时missing_tool_call失败；CR/CM47项回归通过。 |
| `LOCAL-COMPLETION-EVIDENCE` / 32 | [已完成] 记录本地实现最终回归及证据口径 | `DOC/integration-audit-2026-09-08.md`<br>`DOC/integration-audit-2026-09-08.json` | `Q12`、`R01`、`R02`、`Q-CC`、`Q-CR`、`Q-CM`、`Q-RC`、`Q-RR`、`Q-RM`、`Q-MC`、`Q-MR`、`Q-MM` | 逐文件最新回归178文件3788项均通过，矩阵81/81，浏览器9/9，类型构建通过；保留28项后置外部验收。 |

### 联合验收扩展

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `Q03-EVIDENCE` / 26 | [已完成] 记录注册登录 Key 浏览器证据 | `DOC/evidence/auth-workflow.md` | `Q03` | 脱敏记录 Q03 本地浏览器 7/7 结果及真实邮件/远程资源边界。 |
| `Q11-PORT` / 31 | [已完成] 按端口读取隔离浏览器连接材料 | `T/e2e/admin.spec.ts` | `Q11` | 管理员浏览器 spec 使用 SUB2API_E2E_PORT 对应 connection-${port}.json，避免并行 harness 串用连接。 |

### 九向完整矩阵扩展

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `Q-MC-SSE` / 30 | [已完成] Q-MC SSE/tool 第二轮扩展 | `T/gateway/matrix/messages-chat.test.ts` | `Q-MC` | 独立 SSE 扩展 9/9；single/parallel SSE、第二轮 tool result 转发与单次计费通过。 |
| `Q-MR-SSE` / 30 | [已完成] Q-MR SSE/tool 第二轮扩展 | `T/gateway/matrix/messages-responses.test.ts` | `Q-MR` | 独立 SSE 扩展 9/9；single/parallel SSE、第二轮 tool result 转发与单次计费通过。 |
| `Q-MM-SSE` / 30 | [已完成] Q-MM SSE/tool 第二轮扩展 | `T/gateway/matrix/messages-messages.test.ts` | `Q-MM` | 独立 SSE 扩展 9/9；single/parallel SSE、第二轮 tool result 转发与单次计费通过。 |

### gateway 集成扩展

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `JSON-NOFETCH` / 26 | [已完成] JSON 执行链 no-fetch 消费边界 | `W/gateway/execute-json.ts`<br>`W/gateway/dispatch.ts`<br>`T/gateway/dispatch.test.ts` | `G07`、`G14` | 三文件节点 30/30 本地测试与 typecheck 通过；下游未消费前不预取上游。 |
| `STREAM-NOFETCH-EXECUTE` / 26 | [已完成] Stream execute no-fetch 消费边界 | `W/gateway/execute-stream.ts`<br>`T/gateway/execute-stream.test.ts` | `G10`、`G11-STREAM` | stream no-fetch 四文件验证的 execute 节点；与 dispatch 节点合计 53/53 通过。 |
| `STREAM-NOFETCH-DISPATCH` / 27 | [已完成] Stream dispatch no-fetch 消费边界 | `W/gateway/dispatch.ts`<br>`T/gateway/dispatch.test.ts` | `G14`、`STREAM-NOFETCH-EXECUTE`<br>写序：`JSON-NOFETCH` | stream no-fetch 四文件验证的 dispatch 节点；与 execute 节点合计 53/53 通过。 |
| `HTTP-INTEGRATION-NATIVE-FIX` / 28 | [已完成] Native HTTP 集成协议专属 fixture 修复 | `T/gateway/http-integration.test.ts` | `G19` | 协议专属模型/渠道 fixture 修复后 HTTP 集成 3/3 通过；不改生产 source。 |

### 部署必要修复与验证

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `CF-D1-CASE` / 16 | [已完成] 兼容远程D1触发器CASE分句 | `M/0013_billing_atomic.sql` | `D13` | 等价括号修复；原子账务11/11回归，远程标准迁移16项全部成功，外键检查为空、六个账务触发器存在。 |
| `CF-STAGING-BASIC` / 31 | [已完成] 记录真实Cloudflare基本测试结果 | `DOC/evidence/staging-basic.json` | `R03` | 公网浏览器/API33检查通过，合成账户停用、注册恢复closed、测试账务归零；不调用真实上游或邮件。 |

### 前端重设计

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `UI-FOUNDATION` / 27 | [已完成] 统一排版与响应式侧栏 | `UI/App.vue`<br>`UI/components/AppLayout.vue`<br>`UI/styles/console.css` | `U35`<br>写序：`U03` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-PUBLIC` / 28 | [已完成] 公开首页和分栏身份页面 | `UI/views/HomeView.vue`<br>`UI/views/LoginView.vue`<br>`UI/views/RegisterView.vue` | `UI-FOUNDATION`<br>写序：`U05-LINK`、`U08` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-WORKSPACE` / 29 | [已完成] 实际余额、接入地址与请求概览 | `UI/router.ts`<br>`UI/views/DashboardView.vue`<br>`UI/views/KeysView.vue` | `UI-PUBLIC`<br>写序：`U35`、`U09`、`U12` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-USAGE` / 30 | [已完成] 个人请求与账单排版 | `UI/views/RequestsView.vue`<br>`UI/views/BillingView.vue`<br>`UI/views/RequestDetailView.vue` | `UI-WORKSPACE`<br>写序：`U15`、`U17`、`U16` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-ROUTING` / 31 | [已完成] 渠道、模型与分组界面 | `UI/views/admin/ChannelsView.vue`<br>`UI/views/admin/ModelsView.vue`<br>`UI/views/admin/GroupsView.vue` | `UI-USAGE`<br>写序：`U26`、`U29`、`U30` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-ADMIN` / 32 | [已完成] 用户与全局请求界面 | `UI/views/admin/UsersView.vue`<br>`UI/views/admin/RequestsView.vue`<br>`UI/views/admin/RequestDetailView.vue` | `UI-ROUTING`<br>写序：`U35`、`U31`、`U32` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-REGISTRATION` / 33 | [已完成] 注册管理和管理员账单 | `UI/views/admin/RegistrationSettingsView.vue`<br>`UI/views/admin/RegistrationCodesView.vue`<br>`UI/views/admin/BillingView.vue` | `UI-ADMIN`<br>写序：`U18`、`U20`、`U33` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-AUDIT-KEYS` / 34 | [已完成] 审计与Key弹窗 | `UI/views/admin/AuditView.vue`<br>`UI/components/CreateKeyDialog.vue`<br>`UI/components/EditKeyDialog.vue` | `UI-REGISTRATION`<br>写序：`U34`、`U11`、`U12` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-FORM-CONTROLS` / 35 | [已完成] 请求筛选与金额和邀请码表单 | `UI/components/RequestFilters.vue`<br>`UI/components/admin/BalanceAdjustmentDialog.vue`<br>`UI/components/admin/CreateCodesDialog.vue` | `UI-AUDIT-KEYS`<br>写序：`U15`、`U24`、`U20` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-CONFIG-EDITORS` / 36 | [已完成] 模型和渠道配置表单 | `UI/components/admin/ModelMappingEditor.vue`<br>`UI/components/admin/ModelEditor.vue`<br>`UI/components/admin/ChannelEditor.vue` | `UI-FORM-CONTROLS`<br>写序：`U29`、`U28`、`U26` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-USER-EDITORS` / 37 | [已完成] 用户表单精简 | `UI/components/admin/CreateUserDialog.vue`<br>`UI/components/admin/EditUserDialog.vue` | `UI-CONFIG-EDITORS`<br>写序：`U22`、`U23` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-BROWSER-ASSERTIONS` / 38 | [已完成] 以API身份和美元展示更新浏览器断言 | `T/e2e/admin.spec.ts` | `UI-USER-EDITORS`<br>写序：`Q11-PORT` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-DELIVERY` / 39 | [已完成] 保存前端发布和实际检查证据 | `DOC/ui-redesign-2026-09-09.md`<br>`DOC/evidence/ui-redesign-cloud.json` | `UI-BROWSER-ASSERTIONS` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |
| `UI-CAPTURES` / 40 | [已完成] 保存实际部署页面截图 | `DOC/evidence/ui-home.png`<br>`DOC/evidence/ui-dashboard.png` | `UI-DELIVERY` | 类型/构建通过，9项本地浏览器回归、12组响应式检查、4项交互检查及11项公网检查通过；没有虚构统计数据。 |

### 产品修订

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `PC-PASSWORD` / 41 | [已完成] 六位密码边界 | `W/auth/password.ts`<br>`T/auth/password.test.ts`<br>`S/bootstrap-admin.ts` | `UI-CAPTURES`<br>写序：`F16`、`A29` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-CONCURRENCY` / 42 | [已完成] 并发不限与渠道模型元数据 | `W/config.ts`<br>`W/admin/channel-repository.ts`<br>`T/unit/config.test.ts` | `PC-PASSWORD`<br>写序：`L08-REG`、`C03`、`F10-FIX` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-GROUP-SCHEMA` / 43 | [已完成] 用户多分组授权与Key绑定迁移 | `M/0017_key_groups.sql`<br>`W/auth/key-groups.ts`<br>`T/auth/key-groups.test.ts` | `PC-CONCURRENCY` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-USER-GRANTS` / 44 | [已完成] 管理员原子更新开放分组 | `W/admin/update-user.ts`<br>`W/admin/user-routes.ts`<br>`W/admin/audit.ts` | `PC-GROUP-SCHEMA`<br>写序：`A23`、`A22-LAZY`、`O01` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-KEY-GROUPS` / 45 | [已完成] 分组Key创建编辑和查询入口 | `W/auth/key-repository.ts`<br>`W/auth/key-routes.ts`<br>`W/routes.ts` | `PC-USER-GRANTS`<br>写序：`A25-U`、`A26-R`、`O03` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-ADMISSION` / 46 | [已完成] 按Key授权组执行模型与最终准入 | `W/gateway/request-repository.ts`<br>`W/billing/admission.ts`<br>`W/gateway/models-route.ts` | `PC-KEY-GROUPS`<br>写序：`B11-TIME`、`B05`、`G15` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-CLIENTS` / 47 | [已完成] 分组与渠道元数据客户端 | `UI/api/keys.ts`<br>`UI/api/admin-users.ts`<br>`UI/api/admin-channels.ts` | `PC-ADMISSION`<br>写序：`U10`、`U21`、`U25` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-KEY-FORMS` / 48 | [已完成] Key分组选择与同行操作 | `UI/components/CreateKeyDialog.vue`<br>`UI/components/EditKeyDialog.vue`<br>`UI/views/KeysView.vue` | `PC-CLIENTS`<br>写序：`UI-AUDIT-KEYS`、`UI-WORKSPACE` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-ADMIN-FORMS` / 49 | [已完成] 开放分组和无限并发配置界面 | `UI/components/admin/ChannelEditor.vue`<br>`UI/components/admin/EditUserDialog.vue`<br>`UI/views/admin/UsersView.vue` | `PC-KEY-FORMS`<br>写序：`UI-CONFIG-EDITORS`、`UI-USER-EDITORS`、`UI-ADMIN` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-CHANNEL-MODELS` / 50 | [已完成] 渠道内模型维护与自动诊断版本 | `UI/components/admin/ChannelModelsDialog.vue`<br>`UI/views/admin/ChannelsView.vue` | `PC-ADMIN-FORMS`<br>写序：`UI-ROUTING` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-HOME` / 51 | [已完成] 移除首页与面板的协议宣传 | `UI/views/HomeView.vue`<br>`UI/views/DashboardView.vue`<br>`UI/views/LoginView.vue` | `PC-CHANNEL-MODELS`<br>写序：`UI-PUBLIC`、`UI-WORKSPACE` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-FORM-LAYOUT` / 52 | [已完成] 注册门槛和表单行对齐 | `UI/views/RegisterView.vue`<br>`UI/components/admin/CreateUserDialog.vue`<br>`UI/styles/console.css` | `PC-HOME`<br>写序：`UI-PUBLIC`、`UI-USER-EDITORS`、`UI-FOUNDATION` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-DIALOG-LAYOUT` / 53 | [已完成] 统一模型账务与邀请码操作栏 | `UI/components/admin/ModelEditor.vue`<br>`UI/components/admin/BalanceAdjustmentDialog.vue`<br>`UI/components/admin/CreateCodesDialog.vue` | `PC-FORM-LAYOUT`<br>写序：`UI-CONFIG-EDITORS`、`UI-FORM-CONTROLS` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-ADMIN-TESTS` / 54 | [已完成] 更新管理员响应和并发语义断言 | `T/admin/user-routes.test.ts`<br>`T/admin/update-user.test.ts`<br>`T/admin/channel-repository.test.ts` | `PC-DIALOG-LAYOUT`<br>写序：`A22-LAZY`、`A23`、`C03` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-KEY-TESTS` / 55 | [已完成] 验证分组Key默认语义与HTTP限额 | `T/auth/key-repository.test.ts`<br>`T/admin/channel-routes.test.ts` | `PC-ADMIN-TESTS`<br>写序：`A25-U`、`C05` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-BROWSER-COMPAT` / 56 | [已完成] 更新已有浏览器流程的分组选择 | `T/e2e/admin.spec.ts`<br>`T/e2e/auth.spec.ts`<br>`T/e2e/full-workflow.spec.ts` | `PC-KEY-TESTS`<br>写序：`UI-BROWSER-ASSERTIONS`、`Q03`、`Q12` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-BROWSER-FLOW` / 57 | [已完成] 六项调整的完整浏览器流程 | `T/e2e/product-corrections.spec.ts` | `PC-BROWSER-COMPAT` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-SPEC` / 58 | [已完成] 更新技术方案及核心目标 | `DOC/architecture.md`<br>`DOC/phase-1.md`<br>`DOC/deployment.md` | `PC-BROWSER-FLOW`<br>写序：`R04` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |
| `PC-DELIVERY` / 59 | [已完成] 记录实际部署与验证结果 | `DOC/product-adjustments-2026-09-09.md`<br>`DOC/registration-auth.md`<br>`DOC/evidence/product-adjustments-cloud.json` | `PC-SPEC` | 2026-09-09 六项用户修订：类型/构建通过；相关85文件1334用例按最新文件结果全部通过；原有9项及新增1项浏览器闭环通过；公网11项检查通过。已部署b1ee855e-980f-4a91-a125-bc49dd25fc96，迁移0017已远程应用。 |

### 限额修正

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `LIMIT-DEFAULTS` / 60 | [已完成] LIMIT-DEFAULTS 并发与RPM默认不限 | `W/config.ts`<br>`W/admin/channel-repository.ts`<br>`S/bootstrap-admin.ts` | `PC-DELIVERY`<br>写序：`PC-CONCURRENCY`、`PC-PASSWORD` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-ADMISSION` / 61 | [已完成] LIMIT-ADMISSION 并发与RPM默认不限 | `W/gateway/admit.ts`<br>`T/gateway/admit.test.ts` | `LIMIT-DEFAULTS`<br>写序：`G03-HISTORY` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-USERS` / 62 | [已完成] LIMIT-USERS 并发与RPM默认不限 | `W/admin/update-user.ts`<br>`T/admin/update-user.test.ts` | `LIMIT-ADMISSION`<br>写序：`PC-USER-GRANTS`、`PC-ADMIN-TESTS` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-UI` / 63 | [已完成] LIMIT-UI 并发与RPM默认不限 | `UI/components/admin/ChannelEditor.vue`<br>`UI/components/admin/EditUserDialog.vue`<br>`UI/views/admin/UsersView.vue` | `LIMIT-USERS`<br>写序：`PC-ADMIN-FORMS` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-CHANNELS` / 64 | [已完成] LIMIT-CHANNELS 并发与RPM默认不限 | `UI/views/admin/ChannelsView.vue`<br>`T/unit/config.test.ts` | `LIMIT-UI`<br>写序：`PC-CHANNEL-MODELS`、`PC-CONCURRENCY` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-BROWSER` / 65 | [已完成] LIMIT-BROWSER 并发与RPM默认不限 | `T/e2e/admin.spec.ts`<br>`T/e2e/product-corrections.spec.ts` | `LIMIT-CHANNELS`<br>写序：`PC-BROWSER-COMPAT`、`PC-BROWSER-FLOW` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |
| `LIMIT-DELIVERY` / 66 | [已完成] LIMIT-DELIVERY 并发与RPM默认不限 | `DOC/unlimited-limits-2026-09-10.md`<br>`DOC/evidence/unlimited-limits.json`<br>`DOC/architecture.md` | `LIMIT-BROWSER`<br>写序：`PC-SPEC` | 用户明确授权取消默认RPM：同分钟65个在途请求准入并全部释放；相关回归及2项浏览器流程通过。云端3用户及1渠道旧RPM60已改不限，先前2用户旧并发2已修正，界面分列显示。部署7f75a6d1-7395-43f0-866f-77911006085a。 |

### 内置模型

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `CAT-SEEDS` / 67 | [已完成] 内置正式模型目录及保留配置的迁移 | `packages/model-catalog/index.ts`<br>`S/generate-model-seeds.mjs`<br>`M/0018_builtin_models.sql` | `LIMIT-DELIVERY` | 2026-09-10：23 个模型；D1/管理/分组 5 文件 47 用例通过，2 个浏览器流程通过，Vue 类型与迁移一致性检查通过。迁移0018已应用，版本6c855a4b-54fe-437c-9b25-ef4e9c1c5ed4已发布，线上目录和元信息页面通过只读检查，无真实上游调用。 |
| `CAT-UI` / 68 | [已完成] 渠道自动填充与折叠模型元信息 | `UI/components/admin/ChannelModelsDialog.vue`<br>`UI/components/admin/ModelEditor.vue` | `CAT-SEEDS`<br>写序：`PC-CHANNEL-MODELS`、`PC-DIALOG-LAYOUT` | 2026-09-10：23 个模型；D1/管理/分组 5 文件 47 用例通过，2 个浏览器流程通过，Vue 类型与迁移一致性检查通过。迁移0018已应用，版本6c855a4b-54fe-437c-9b25-ef4e9c1c5ed4已发布，线上目录和元信息页面通过只读检查，无真实上游调用。 |
| `CAT-D1` / 69 | [已完成] 验证内置模型安装与原有模型管理 | `T/db/0018_builtin_models.test.ts`<br>`T/admin/model-repository.test.ts`<br>`T/admin/model-routes.test.ts` | `CAT-UI`<br>写序：`C08`、`C09-U` | 2026-09-10：23 个模型；D1/管理/分组 5 文件 47 用例通过，2 个浏览器流程通过，Vue 类型与迁移一致性检查通过。迁移0018已应用，版本6c855a4b-54fe-437c-9b25-ef4e9c1c5ed4已发布，线上目录和元信息页面通过只读检查，无真实上游调用。 |
| `CAT-BROWSER` / 70 | [已完成] 验证内置模型选择和原生接口填充 | `T/e2e/builtin-models.spec.ts` | `CAT-D1` | 2026-09-10：23 个模型；D1/管理/分组 5 文件 47 用例通过，2 个浏览器流程通过，Vue 类型与迁移一致性检查通过。迁移0018已应用，版本6c855a4b-54fe-437c-9b25-ef4e9c1c5ed4已发布，线上目录和元信息页面通过只读检查，无真实上游调用。 |
| `CAT-DELIVERY` / 71 | [已完成] 部署模型目录并记录线上验证 | `DOC/builtin-models.md`<br>`DOC/evidence/builtin-models.json` | `CAT-BROWSER` | 2026-09-10：23 个模型；D1/管理/分组 5 文件 47 用例通过，2 个浏览器流程通过，Vue 类型与迁移一致性检查通过。迁移0018已应用，版本6c855a4b-54fe-437c-9b25-ef4e9c1c5ed4已发布，线上目录和元信息页面通过只读检查，无真实上游调用。 |

### 聊天首页

| 任务 / 层 | 本次只完成 | 文件 | 前置 | 验收标准 |
| --- | --- | --- | --- | --- |
| `CHAT-DEPS` / 72 | [已完成] Markdown 渲染依赖 | `WEB/package.json`<br>`pnpm-lock.yaml` | `CAT-DELIVERY`<br>写序：`F02`、`F14-D` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-GROUP-SCHEMA` / 72 | [已完成] 分组倍率迁移 | `M/0020_group_billing_multiplier.sql`<br>`T/db/0020_group_billing_multiplier.test.ts` | `CAT-DELIVERY` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-GROUP-API` / 73 | [已完成] 分组倍率管理与审计 | `W/admin/group-repository.ts`<br>`W/admin/group-routes.ts`<br>`W/admin/audit.ts` | `CHAT-GROUP-SCHEMA`<br>写序：`C06`、`C07-U`、`PC-USER-GRANTS` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-PRICE` / 73 | [已完成] 快照与精确倍率计费 | `W/billing/pricing.ts`<br>`W/billing/fingerprint.ts`<br>`W/billing/settlement.ts` | `CHAT-GROUP-SCHEMA`<br>写序：`B02`、`B03`、`B13` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-RECOVERY` / 74 | [已完成] 历史快照恢复兼容 | `W/billing/recovery.ts`<br>`T/billing/recovery.test.ts` | `CHAT-PRICE`<br>写序：`B14` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-KEY-SCHEMA` / 72 | [已完成] 无凭据虚拟 Key 迁移 | `M/0021_web_chat_keys.sql`<br>`T/db/0021_web_chat_keys.test.ts` | `CAT-DELIVERY` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-KEY-AUTH` / 73 | [已完成] Key 隔离及会话内部身份 | `W/auth/key-repository.ts`<br>`W/auth/api-key-auth.ts`<br>`W/auth/web-chat-auth.ts` | `CHAT-KEY-SCHEMA`<br>写序：`PC-KEY-GROUPS`、`A27` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-KEY-MGMT` / 74 | [已完成] 虚拟 Key 管理隔离验证 | `W/admin/key-routes.ts`<br>`T/auth/web-chat-auth.test.ts` | `CHAT-KEY-AUTH`<br>写序：`A28` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-REQUEST-SCHEMA` / 73 | [已完成] 请求组与来源持久化 | `M/0023_request_source_group.sql` | `CHAT-KEY-SCHEMA` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-ADMISSION` / 74 | [已完成] 请求级分组与原子注册 | `W/billing/admission.ts`<br>`W/gateway/admit.ts`<br>`W/gateway/request-repository.ts` | `CHAT-REQUEST-SCHEMA`、`CHAT-KEY-AUTH`、`CHAT-GROUP-API`、`CHAT-PRICE`<br>写序：`PC-ADMISSION`、`LIMIT-ADMISSION` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-GATEWAY` / 75 | [已完成] 可信聊天分发与组内历史 | `W/gateway/dispatch.ts`<br>`W/gateway/response-history.ts` | `CHAT-ADMISSION`<br>写序：`G22`、`G13` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-STORE-SCHEMA` / 73 | [已完成] 会话与消息表及类型 | `M/0022_chat.sql`<br>`W/chat/types.ts`<br>`T/db/0022_chat.test.ts` | `CHAT-KEY-SCHEMA` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-STORAGE` / 74 | [已完成] 会话消息幂等与状态恢复 | `W/chat/repository.ts`<br>`W/chat/messages.ts` | `CHAT-STORE-SCHEMA`、`CHAT-REQUEST-SCHEMA` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-STREAM` / 75 | [已完成] 流式保存与有界故障收尾 | `W/chat/stream.ts`<br>`T/chat/stream.node.test.ts` | `CHAT-STORAGE` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-HTTP` / 76 | [已完成] 聊天接口及实际网关桥接 | `W/chat/routes.ts`<br>`W/chat/service.ts`<br>`W/chat/models.ts` | `CHAT-STREAM`、`CHAT-GATEWAY` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-MOUNT` / 77 | [已完成] 全局路由装配 | `W/routes.ts` | `CHAT-HTTP`<br>写序：`PC-KEY-GROUPS` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-CLIENT` / 77 | [已完成] 客户端协议与分帧 | `UI/api/chat.ts`<br>`T/unit/web-chat-client.test.ts` | `CHAT-HTTP` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-WEB-PARTS` / 78 | [已完成] 聊天交互组件 | `UI/components/chat/ChatSidebar.vue`<br>`UI/components/chat/ChatComposer.vue`<br>`UI/components/chat/ChatMessage.vue` | `CHAT-CLIENT`、`CHAT-DEPS` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-WEB` / 79 | [已完成] 聊天首页与独立布局 | `UI/views/ChatView.vue`<br>`UI/router.ts`<br>`UI/components/AppLayout.vue` | `CHAT-WEB-PARTS`<br>写序：`UI-WORKSPACE`、`UI-FOUNDATION` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-ADMIN` / 74 | [已完成] 分组倍率界面 | `UI/api/admin-groups.ts`<br>`UI/views/admin/GroupsView.vue`<br>`T/unit/web-admin-contracts.test.ts` | `CHAT-GROUP-API`<br>写序：`U30`、`UI-ROUTING` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-LOG-API` / 74 | [已完成] 日志来源和快照读取 | `W/gateway/request-query-routes.ts`<br>`T/gateway/request-query-routes.test.ts`<br>`UI/api/requests.ts` | `CHAT-REQUEST-SCHEMA`、`CHAT-PRICE`<br>写序：`B12`、`U14` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-LOG-ADMIN` / 75 | [已完成] 管理员聊天日志展示 | `UI/views/admin/RequestsView.vue`<br>`UI/views/admin/RequestDetailView.vue` | `CHAT-LOG-API`<br>写序：`UI-ADMIN` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-LOG-USER` / 75 | [已完成] 用户聊天日志展示 | `UI/views/RequestsView.vue`<br>`UI/views/RequestDetailView.vue` | `CHAT-LOG-API`<br>写序：`UI-USAGE` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-INTEGRATION` / 80 | [已完成] 聊天集成与防重复扣费浏览器测试 | `T/chat/integration.test.ts`<br>`T/e2e/web-chat.spec.ts`<br>`T/e2e/web-chat-races.spec.ts` | `CHAT-MOUNT`、`CHAT-WEB`、`CHAT-RECOVERY` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-UI-TEST` / 80 | [已完成] 浏览器聊天客户端验证 | `T/e2e/web-chat-ui.spec.ts` | `CHAT-WEB` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-COMPAT-1` / 80 | [已完成] 旧控制台登录与注册路径回归 | `T/e2e/admin.spec.ts`<br>`T/e2e/auth.spec.ts`<br>`T/e2e/full-workflow.spec.ts` | `CHAT-WEB`<br>写序：`LIMIT-BROWSER`、`PC-BROWSER-COMPAT` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-COMPAT-2` / 80 | [已完成] 旧模型与分组产品回归 | `T/e2e/builtin-models.spec.ts`<br>`T/e2e/product-corrections.spec.ts` | `CHAT-WEB`<br>写序：`CAT-BROWSER`、`LIMIT-BROWSER` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-DOCS` / 81 | [已完成] 实施与交付说明 | `DOC/web-chat-plan.md`<br>`DOC/web-chat-execution.md`<br>`DOC/web-chat-delivery.md` | `CHAT-INTEGRATION`、`CHAT-UI-TEST`、`CHAT-ADMIN`、`CHAT-LOG-ADMIN`、`CHAT-LOG-USER`、`CHAT-KEY-MGMT`、`CHAT-COMPAT-1`、`CHAT-COMPAT-2` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-EVIDENCE` / 82 | [已完成] 验证证据与桌面手机预览 | `DOC/evidence/web-chat.json`<br>`DOC/evidence/chat-desktop.png`<br>`DOC/evidence/chat-mobile.png` | `CHAT-DOCS` | 2026-09-12：137文件1910回归用例通过，最终局部14用例通过，15浏览器用例最新结果全部通过，类型/构建/发布dry-run通过。未真实模型或邮件调用；线上因CF OAuth过期待发布。 |
| `CHAT-RELEASE` / 83 | [待执行] 发布聊天首页（待 Cloudflare 重新授权） | `DOC/web-chat-delivery.md`<br>`DOC/evidence/web-chat.json` | `CHAT-EVIDENCE`<br>写序：`CHAT-DOCS` | 恢复CF授权，远程应用0019–0023、发布并验证后才能完成。 |

## 6. 九种协议组合的验收对应

下表的集成测试可以使用可控 fixture 注入故障，LIVE 节点必须使用固定版本的真实 SDK/上游。每格都验普通和 SSE，不能只测九条普通响应就宣称十八条基本路径完成。

| 下游 | 上游 | 请求函数 | JSON / SSE 返回函数 | 集成节点 | 真实节点 |
| --- | --- | --- | --- | --- | --- |
| chat | chat | `P15` 及其前置 | JSON `P15`；SSE `P18` | `Q-CC` | `LIVE-CC` |
| chat | responses | `P-CR-Q6` 及其前置 | JSON `P-RC-J4`；SSE `P-RC-S6` | `Q-CR` | `LIVE-CR` |
| chat | messages | `P-CM-Q6` 及其前置 | JSON `P-MC-J4`；SSE `P-MC-S6` | `Q-CM` | `LIVE-CM` |
| responses | chat | `P-RC-Q6` 及其前置 | JSON `P-CR-J4`；SSE `P-CR-S6` | `Q-RC` | `LIVE-RC` |
| responses | responses | `P16` 及其前置 | JSON `P16`；SSE `P19` | `Q-RR` | `LIVE-RR` |
| responses | messages | `P-RM-Q6` 及其前置 | JSON `P-MR-J4`；SSE `P-MR-S6` | `Q-RM` | `LIVE-RM` |
| messages | chat | `P-MC-Q6` 及其前置 | JSON `P-CM-J4`；SSE `P-CM-S6` | `Q-MC` | `LIVE-MC` |
| messages | responses | `P-MR-Q6` 及其前置 | JSON `P-RM-J4`；SSE `P-RM-S6` | `Q-MR` | `LIVE-MR` |
| messages | messages | `P17` 及其前置 | JSON `P17`；SSE `P20` | `Q-MM` | `LIVE-MM` |

## 7. 里程碑如何收口

| 检查点 | 代表完成什么 | 主要证据 |
| --- | --- | --- |
| K0 / M0 | 平台、密码、邮件与三上游原生调用具备可行性 | X02–X07 真实记录、基础工程 |
| K1 / M1 | 注册/验证/登录/Key 身份闭环 | Q01、Q03、管理员初始化、X03/X04 |
| K2 / M2 | 配置、并发、允许透支的原子记账和恢复 | Q02、Q04–Q06、C17 |
| K3 / M3 | 九格十八基本路径和真实上下游兼容 | 九个 LIVE、Q08/Q09、P23 |
| K4 / M4 | 一期全部目标有证据的可交付测试版本 | R08 汇总 P1-01 至 P1-13，含负载/恢复/安全/界面 |

所有节点的“测试通过”都只对其声明范围有效。K4 不自动包含替换旧四个 Worker、迁移旧生产库、开通开放注册或 GitHub 推送；这些动作按之后实际执行任务的范围另行处理。

## 8. 调整任务时保持拓扑正确

1. 在 JSON 中补充节点 ID、目标文件、功能前置和验收；保留旧 ID，拆分时用后缀。
2. 先对功能依赖做拓扑排序；按该合法顺序，为相同文件建立前后写入边。
3. 合并两类依赖，重新排序；检查不存在未知 ID、自环、环、超过三文件或同层文件冲突。
4. 更新 Markdown 的任务表、层号、九格映射及里程碑引用。状态维护属于独立文档任务，不强制每次业务变更同时修改计划。
5. 新的关键行为必须有对应验收；修改共用类型不得让下游静默失配。初期配置任务尚无源码输入时做静态核对，等入口到位再执行完整构建检查，不伪造通过记录。

不需要为这份计划增加运行时任务调度器或数据库。JSON 和 Markdown 足以用于逐项执行、审阅与续接。
