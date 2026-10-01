# 一期实施入口：按微任务拓扑执行

状态：持续实现中，完成480 / 进行中0 / 待实现1 / 后置验收26。

实施依据为 [完整技术方案 v1.0](architecture.md)。原来的 M0–M4 大阶段已细分为 **507 个节点**，每个实现任务最多三个文件，含必要的独立集成/修复节点。

- [完整微任务清单与拓扑层](task-breakdown.md)
- [结构化任务图与合法串行顺序](task-graph.json)
- [一期目标与验收范围](phase-1.md)

## 执行规则

默认一次只执行一个节点。先确认该节点的有效前置和外部输入，只改列出的最多三个版本控制文件；实现、测试、迁移、锁文件和路由挂载都计数。需要第四个文件时先拆新节点，不把多个小任务合并成一次大改动。

任务之间既有功能依赖，也有写同一文件产生的顺序依赖。使用 task-graph.json 的 effective_dependencies 判断是否就绪；同层可并行，但层不是全局屏障，外部输入受阻不妨碍另一分支推进。

不为每次业务变更强制更新计划或 README。需要记录进度时安排独立文档变更，避免隐性增加第四个文件。这里的任务是工作单元，不自动创建应用中的独立任务或启动后台执行。

## 当前进度

已完成 **480** 项，进行中 **0** 项，待实现 **1** 项，用户暂缓验收 **26** 项。总节点 507（新增小型集成/修复任务仍限制每次最多三文件）。

已完成：`F01`、`P21`、`F02`、`P21-L`、`F03`、`F04`、`F14-D`、`F05`、`F08`、`P01`、`F06`、`F09`、`F04-WEB-LIB`、`X01`、`A16`、`F06-W`、`F07`、`F10`、`F11`、`F12`、`F13`、`L01`、`L04`、`C01`、`C02`、`B01`、`P02`、`P03`、`P04`、`P05`、`P07`、`F07-ISO`、`F14`、`D01`、`L02`、`A13`、`C12`、`B02`、`P06`、`P08`、`P10`、`P11`、`P12`、`P13`、`P14`、`P-CR-Q1`、`P-CR-J1`、`P-CM-Q1`、`P-CM-J1`、`P-RC-Q1`、`P-RC-J1`、`P-RM-Q1`、`P-RM-J1`、`P-MC-Q1`、`P-MC-J1`、`P-MR-Q1`、`P-MR-J1`、`U01`、`F10-FIX`、`G04-BODY`、`P04-OUTPUT-CONFIG`、`F15`、`D02`、`D07`、`D14`、`L03`、`P09`、`P15`、`P16`、`P17`、`P-CR-Q2`、`P-CR-J2`、`P-CM-Q2`、`P-CM-J2`、`P-RC-Q2`、`P-RC-J2`、`P-RM-Q2`、`P-RM-J2`、`P-MC-Q2`、`P-MC-J2`、`P-MR-Q2`、`P-MR-J2`、`G04`、`G05`、`G06`、`AUDIT-CLIENT`、`G04-BODY-HARDEN`、`F16`、`D03`、`D04`、`D05`、`D06`、`D08`、`D11`、`L05`、`A01`、`C15`、`P18`、`P19`、`P20`、`P-CR-Q3`、`P-CR-J3`、`P-CR-S1`、`P-CM-Q3`、`P-CM-J3`、`P-CM-S1`、`P-RC-Q3`、`P-RC-J3`、`P-RC-S1`、`P-RM-Q3`、`P-RM-J3`、`P-RM-S1`、`P-MC-Q3`、`P-MC-J3`、`P-MC-S1`、`P-MR-Q3`、`P-MR-J3`、`P-MR-S1`、`D01-FIX`、`AUDIT-CLIENT-MODEL`、`D09`、`D12`、`O01`、`L06`、`A02`、`A14`、`A25`、`A29`、`B17`、`P-CR-Q4`、`P-CR-J3-E`、`P-CR-S2`、`P-CM-Q4`、`P-CM-J3-E`、`P-CM-S2`、`P-RC-Q4`、`P-RC-J3-E`、`P-RC-S2`、`P-RM-Q4`、`P-RM-J3-E`、`P-RM-S2`、`P-MC-Q4`、`P-MC-J3-E`、`P-MC-S2`、`P-MR-Q4`、`P-MR-J3-E`、`P-MR-S2`、`A11-D`、`A25-D`、`L08-GATE-PEEK`、`P22-EXPORTS`、`D10`、`L07`、`L08`、`A03`、`A09`、`A11`、`A15`、`A21`、`A23`、`C03`、`C06`、`C08`、`P-CR-Q4-O`、`P-CR-J3-T`、`P-CR-S3`、`P-CM-Q4-O`、`P-CM-J3-T`、`P-CM-S3`、`P-RC-Q4-O`、`P-RC-J3-T`、`P-RC-S3`、`P-RM-Q4-O`、`P-RM-J3-T`、`P-RM-S3`、`P-MC-Q4-O`、`P-MC-J3-T`、`P-MC-S3`、`P-MR-Q4-O`、`P-MR-J3-T`、`P-MR-S3`、`A25-IDEM`、`L09-GATE`、`D13`、`L10`、`A04`、`A06`、`A07`、`A11-L`、`A17`、`A25-L`、`C10`、`C14`、`B03`、`P-CR-Q5`、`P-CR-J4`、`P-CR-S4`、`P-CM-Q5`、`P-CM-J4`、`P-CM-S4`、`P-RC-Q5`、`P-RC-J4`、`P-RC-S4`、`P-RM-Q5`、`P-RM-J4`、`P-RM-S4`、`P-MC-Q5`、`P-MC-J4`、`P-MC-S4`、`P-MR-Q5`、`P-MR-J4`、`P-MR-S4`、`L08-REG`、`L09-CLIENT`、`L09`、`A05`、`A08`、`A11-R`、`A18`、`A20`、`A25-U`、`A26`、`A27`、`A30`、`C13`、`B04`、`B09`、`P-CR-Q6`、`P-CR-S5`、`P-CM-Q6`、`P-CM-S5`、`P-RC-Q6`、`P-RC-S5`、`P-RM-Q6`、`P-RM-S5`、`P-MC-Q6`、`P-MC-S5`、`P-MR-Q6`、`P-MR-S5`、`R04`、`CF-D1-CASE`、`A10`、`A12`、`A19`、`A20-O`、`A22`、`A26-C`、`A28`、`C04`、`C07`、`C09`、`C11`、`C16`、`B05`、`B06`、`B10`、`B11`、`P-CR-S6`、`P-CM-S6`、`P-RC-S6`、`P-RM-S6`、`P-MC-S6`、`P-MR-S6`、`G01`、`G15`、`U06`、`O02`、`Q06`、`B09-TIME`、`CM-STREAM-OPTIONS`、`A12-C`、`A22-C`、`A26-U`、`C04-C`、`C07-C`、`C09-C`、`B07`、`B08`、`B10-A`、`B12`、`B13`、`B19`、`P22`、`G02`、`G13`、`U07`、`U18`、`U34`、`A31-EARLY`、`A10-LAZY`、`B11-TIME`、`CR-TERMINAL-GUARD`、`A12-R`、`A24`、`A26-R`、`C05`、`C07-U`、`C09-U`、`B14`、`P23`、`G03`、`G20`、`U09`、`U14`、`U24`、`R05`、`A31-SESSION`、`C17-ENV`、`B10-TIME`、`G01-STRICT`、`P22-REQUEST-BUDGET`、`B15`、`B18`、`G12`、`U02`、`U10`、`U15`、`U17`、`U19`、`U21`、`U25`、`U27`、`U30`、`U33`、`Q05`、`AUDIT-ENTRY`、`AUDIT-LOGIN`、`A12-LAZY`、`A22-LAZY`、`G03-HISTORY`、`B16`、`G07`、`G08`、`U03`、`U08`、`U11`、`U16`、`U20`、`U22`、`U26`、`U28`、`U31`、`AUDIT-BOOTSTRAP`、`A31`、`B21`、`G09`、`U04`、`U12`、`U23`、`U29`、`U32`、`AUDIT-HTTPS`、`C17`、`G10`、`U05`、`U04-REGISTER`、`Q03-HARNESS`、`G11`、`U13`、`U05-LINK`、`B20-EARLY`、`B20`、`G14`、`G21`、`Q03`、`U35-REGISTRATION`、`G11-STREAM`、`G16`、`G17`、`G18`、`U35`、`Q04`、`Q03-EVIDENCE`、`JSON-NOFETCH`、`STREAM-NOFETCH-EXECUTE`、`G19`、`STREAM-NOFETCH-DISPATCH`、`UI-FOUNDATION`、`G22`、`G23`、`Q07`、`Q08`、`HTTP-INTEGRATION-NATIVE-FIX`、`Q-MATRIX-HELPER`、`UI-PUBLIC`、`O03`、`Q-CC`、`Q-CR`、`Q-CM`、`Q-RC`、`Q-RR`、`Q-RM`、`Q-MC`、`Q-MR`、`Q-MM`、`Q09`、`R01`、`UI-WORKSPACE`、`Q10`、`Q11`、`R02`、`R03`、`Q-MC-SSE`、`Q-MR-SSE`、`Q-MM-SSE`、`UI-USAGE`、`Q12`、`Q11-PORT`、`CF-STAGING-BASIC`、`UI-ROUTING`、`LOCAL-COMPLETION-EVIDENCE`、`UI-ADMIN`、`UI-REGISTRATION`、`UI-AUDIT-KEYS`、`UI-FORM-CONTROLS`、`UI-CONFIG-EDITORS`、`UI-USER-EDITORS`、`UI-BROWSER-ASSERTIONS`、`UI-DELIVERY`、`UI-CAPTURES`、`PC-PASSWORD`、`PC-CONCURRENCY`、`PC-GROUP-SCHEMA`、`PC-USER-GRANTS`、`PC-KEY-GROUPS`、`PC-ADMISSION`、`PC-CLIENTS`、`PC-KEY-FORMS`、`PC-ADMIN-FORMS`、`PC-CHANNEL-MODELS`、`PC-HOME`、`PC-FORM-LAYOUT`、`PC-DIALOG-LAYOUT`、`PC-ADMIN-TESTS`、`PC-KEY-TESTS`、`PC-BROWSER-COMPAT`、`PC-BROWSER-FLOW`、`PC-SPEC`、`PC-DELIVERY`、`LIMIT-DEFAULTS`、`LIMIT-ADMISSION`、`LIMIT-USERS`、`LIMIT-UI`、`LIMIT-CHANNELS`、`LIMIT-BROWSER`、`LIMIT-DELIVERY`、`CAT-SEEDS`、`CAT-UI`、`CAT-D1`、`CAT-BROWSER`、`CAT-DELIVERY`、`CHAT-DEPS`、`CHAT-GROUP-SCHEMA`、`CHAT-KEY-SCHEMA`、`CHAT-GROUP-API`、`CHAT-PRICE`、`CHAT-KEY-AUTH`、`CHAT-REQUEST-SCHEMA`、`CHAT-STORE-SCHEMA`、`CHAT-RECOVERY`、`CHAT-KEY-MGMT`、`CHAT-ADMISSION`、`CHAT-STORAGE`、`CHAT-ADMIN`、`CHAT-LOG-API`、`CHAT-GATEWAY`、`CHAT-STREAM`、`CHAT-LOG-ADMIN`、`CHAT-LOG-USER`、`CHAT-HTTP`、`CHAT-MOUNT`、`CHAT-CLIENT`、`CHAT-WEB-PARTS`、`CHAT-WEB`、`CHAT-INTEGRATION`、`CHAT-UI-TEST`、`CHAT-COMPAT-1`、`CHAT-COMPAT-2`、`CHAT-DOCS`、`CHAT-EVIDENCE`

当前派发：

依赖已就绪：`CHAT-RELEASE`

真实云、邮件、模型调用、负载和最终验收按用户指示后置；不将其标为通过。本地类型、构建、原生D1/DO及必要单元测试随实现进行。工具命令见 [工具链说明](toolchain.md)。

## 起步顺序

从 F01 固定工作区开始，随后 F02 声明包、F03 固定锁文件、F04 类型配置。P21 来源/许可证核对可独立穿插。具体前十步和后续全部任务见微任务清单。

基础工程之后，数据库、协议公共类型、租约限流和前端骨架按各自依赖展开。注册、渠道、计费和转换分别完成后，再接网关与端到端验证。没有功能依赖时，不强制等整个 M1 完成才能写协议转换。

## 里程碑

| 原阶段 | 只读收口节点 | 达成条件 |
| --- | --- | --- |
| M0 最小工程与可行性 | K0 | 工具/版本固定；真实 D1、KDF、邮件、三种上游通过 |
| M1 注册与身份 | K1 | 三模式×验证开关、会话/Key、权限与原子核销、页面闭环 |
| M2 渠道与简单计费 | K2 | 模型/组/渠道、租约、KV 回源、允许负余额和幂等结算正确 |
| M3 三协议端到端 | K3 | 九格普通/SSE、真实客户端、工具多轮、usage、取消和引用隔离 |
| M4 控制台与交付 | K4 | P1-01 至 P1-13 有证据，含安全、负载、备份/恢复与部署说明 |

## 范围保持

一个 Worker + D1 + KV + 轻量 Gate DO + Email Service；无用户/渠道业务 DO 账本、Outbox、Queues、异步查询投影或独立 jobs 服务。余额缓存初始关闭、可配置启用；正式账单始终在 D1 原子提交，允许少量透支。

持续推进全部可实现节点；本地检查随代码进行。用户已要求暂缓真实上游、邮件、云环境、负载及最终验收，相应节点保留待验证状态。
