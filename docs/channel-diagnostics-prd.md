# cheapai 渠道诊断改版 PRD

版本：实现 v2（紧凑 Tabs）· 2026-10-11。范围：管理员「渠道 → 诊断」。按用户反馈保留现有小诊断面板，不做独立页面。本功能沿用现有诊断入口，不需要新增迁移或诊断存储。

## 1. 产品目标

管理员运行诊断后，可以回答四个问题：请求发到了哪里、实际发送了什么、上游具体返回什么、下一步应检查哪里。HTTP 状态码是证据的一部分；错误正文、失败阶段和请求上下文必须同时可见。

例：现状显示「上游返回 HTTP 错误 / 401」；新版显示「上游拒绝了渠道凭据」，保留 `invalid_api_key` 和供应商原始 message，并展示本次 POST 的 URL、模型、请求正文和脱敏鉴权头，提供「编辑渠道凭据」。

## 2. 现状与改动范围

现有 `ChannelDiagnostics.tsx` 使用侧栏和二次确认弹窗；结果仅有 outcome、upstreamStatus、诊断编号及限额。后端 `test-channel-route.ts` 没有返回请求快照、响应正文、响应头或解析失败详情，HTTP 错误时也没有读取错误正文。因此只改前端无法满足目标。

新版保留现有诊断 POST 路径、管理员身份/CSRF/配置版本校验、固定小请求、最多 16 输出 token 和 10 秒上游总时限（包含跳转、等待响应头和读取正文；D1 配置与审计耗时单独记录）。继续使用现有 ChannelDiagnostics / Sheet 入口，只在小面板内部增加 Tabs，并扩展管理员诊断结果契约。

第一版不加入任意 HTTP 调试器、自定义 URL/请求头/正文、全渠道批测、自动重试、定时探测、诊断持久化平台、AI 自动推断根因或自动修改渠道。

## 3. 页面与视觉

沿用 cheapai 的白底、淡灰背景、紫色主按钮和左侧管理导航。错误用克制的浅红提示，成功用浅绿；代码区保持浅色，正文与技术细节采用清晰层级。

沿用当前渠道列表和渠道详情中的「诊断」按钮，打开现有右侧 Sheet，桌面宽度保持 34rem（544px），不新增页面、路由、独立侧导航或第二套渠道详情头部。面板标题「渠道诊断」，下一行只放渠道名。

布局从上到下：

1. **选择区**：模型映射选择器与对应协议。协议来源于选中的真实映射，不允许选无配置的协议。
2. **三个小 Tabs**：结果 / 请求 / 响应，默认「结果」。切换 Tabs 仅切换内容，不发请求。
3. **结果 Tab**：一个紧凑状态卡。标题说明具体失败/成功；保留上游错误 code 与 message，显示「上游 HTTP 401 · 842 ms」等事实。最多一个与证据对应的修复入口。其下是默认折叠的执行过程和运行详情，不放多张指标卡。
4. **请求 Tab**：方法与真实 URL，正文默认展示 JSON。Body / Headers / cURL 使用小型次级切换，只占用一个代码区，支持复制。
5. **响应 Tab**：真实上游 HTTP 状态、Content-Type 和原始错误正文。Body / Headers 使用次级切换；无响应时直接展示失败阶段和原因。
6. **固定底部**：一行「可能产生上游费用，不扣用户余额」，「关闭」与紫色「运行诊断」按钮。代码区和面板正文可滚动，底部按钮不被长正文挤走。

请求与响应不再并排，也不同时堆在结果下。版本号、完整诊断编号和时间线默认收起。下载诊断保留为轻量次要操作，不设置额外工具栏。

不显示「费用提示」大卡片。明确的「运行诊断」按钮发送一次请求；底部费用说明持续可见。无可运行映射时按钮禁用，提供「配置模型映射」。停用渠道时提供「返回渠道配置」。

### 响应式与可访问性

- 桌面沿用 544px 小面板，代码区可独立横向滚动，不扩大面板。
- 手机沿用现有 Sheet 的满屏适配，仍是同一个临时诊断面板，结果/请求/响应通过 Tabs 切换；没有独立页面跳转。
- 小屏仍能复制完整脱敏内容，URL 可换行，不能依赖 hover 才显示错误。
- 状态同时使用图标、文字和颜色；代码区支持键盘滚动，按钮和 Tabs 有可见焦点；运行完成后用 aria-live 宣布摘要，不抢走键盘焦点。

## 4. 用户流程与状态

| 状态 | 页面行为 | 发送上游请求 |
| --- | --- | --- |
| 未运行 | 展示「请求预览」，响应区为简洁空态 | 否 |
| 运行中 | 锁定所选映射和运行按钮；保留请求预览，响应区显示等待 | 仅本次明确操作 |
| 完成且有效 | 显示真实响应、协议校验通过和耗时 | 不追加请求 |
| 上游 HTTP 错误 | 展示状态、供应商错误 code/message 和原文 | 不自动重试 |
| HTTP 200 但响应无效 | 显示具体 JSON/协议错误和已有正文，不显示成功 | 不自动重试 |
| 本地配置/版本失败 | 显示阻断原因，并明确「请求未发起」 | 否 |
| 超时/网络失败 | 展示失败阶段、已取得的部分响应；无状态时显示「未收到 HTTP 响应」 | 不自动重试 |
| 浏览器断线/取消 | 显示「结果未确认」；不能断言上游未处理或未计费 | 不自动重试 |

点击「再次运行」才新建一次诊断。切换映射后清除上一结果并展示新预览，防止把旧结果绑定到新选择；运行中禁止切换。页面打开、切 Tab、复制或查看详情不得产生调用。

第一版只在当前页面内存保留当前结果；切换渠道或离开页面后清除，不写 localStorage。复制和下载只操作当前结果，不发送诊断。多次结果对比与历史记录放到后续版本，不为它引入存储或列表。

运行中离开页面时提示尚未取得结果；浏览器中止读取并不能保证 Worker 或上游停止。第一版不设计无法保证生效的「停止上游」按钮。

## 5. 必须展示的证据

### 请求

- 方法、实际目标 URL、公开模型 → 上游模型、协议。
- 准备好且交给 transport 的真实 Body；不能从表单重新拼一份冒充已发送请求。
- 实际请求头的安全快照，包括 Content-Type、协议版本和鉴权头名称，鉴权值固定显示 `[REDACTED]`。
- 明确区分「请求预览」「已尝试发送」「已收到响应」；fetch 发起不能被描述成上游已接收。
- 如有 HTTP 跳转，展开各跳的 URL、方法、状态和已剥离的鉴权头名称。POST 改为 GET、跨域凭据移除等必须反映实际 transport 行为，不能展示为原 URL 的响应。

cURL 使用本次首跳的脱敏快照生成，以 `${CHEAPAI_UPSTREAM_KEY}` 环境变量占位，不返回真实上游 Key。响应/运行详情中注明发生的跳转；不自动添加可能跨域转发凭据的 `--location-trusted`。正常复制不会执行 cURL。cURL 中参数必须正确 shell 引用，不能直接把 URL/Body 拼进命令。

### 响应

- 最终 HTTP 状态、Content-Type、供应商请求 ID、Retry-After 等允许展示的响应头。
- JSON 可格式化；普通文本和 HTML 按纯文本展示，保留原始错误内容，不渲染上游 HTML。
- 没有响应时不伪造 status/body；收到 200 后读取超时仍保留已取得的状态、头和正文片段。
- 正文为空显示「上游返回了空正文」。超过采集限额明确显示截断范围，解析结果为「无法完成校验」，不能误报 JSON 格式错误。
- 对完整 JSON 运行现有协议解析器；将可定位的问题显示为字段路径和实际校验问题。例如 `$.choices: 缺少必需字段`，不能只显示「响应无效」。

### 错误摘要与操作

摘要由有证据的规则生成；供应商 code/message 独立保留，建议与已证实原因分开。

| 证据 | 摘要/操作 |
| --- | --- |
| 401 且 error.code = invalid_api_key | 「上游拒绝了渠道凭据」；编辑渠道凭据 |
| 401 无结构化原因 | 「上游返回 401」；提示核对凭据，不断言 Key 已失效 |
| 403 + 供应商权限信息 | 保留原文；检查凭据权限或上游项目 |
| 404 + model_not_found | 「上游找不到指定模型」；编辑该模型映射 |
| 404，无模型错误证据 | 保留路径和正文，建议核对 Base URL/路径 |
| 429 + Retry-After | 「上游限制了本次请求」；显示重试等待时间，不自动倒计时发请求 |
| 429 + 明确额度不足 code | 展示额度不足原因，不能一律写成 RPM 限流 |
| 5xx | 保留供应商错误原文与请求 ID，不能只归为网络错误 |
| 等待响应头/正文超时 | 明确阶段及实际时限，显示已有证据 |
| 200 + HTML/非预期 JSON | 明确响应类型或校验路径，提示核对上游路径/协议 |
| D1/内部异常 | 标记发生在 CheapAI 侧，保留安全的失败原因与 requestId，不伪装成上游错误 |

HTTP 状态不等于根因。未知错误直接展示可安全呈现的实际信息，不生成猜测性诊断。

## 6. 数据契约提案

保留 `POST /api/v1/admin/channels/:id/test` 和现有请求字段；结果保留旧字段并增加 evidence。管理 API 的 200 表示诊断结果已经取得，即使上游是 401/429；页面必须用 upstreamStatus 和 outcome 展示上游结果。

```ts
type ProbeEvidence = {
  requestId: string;                 // CheapAI 管理请求标识
  startedAt: number;
  durationMs: number;
  execution: 'not_started' | 'attempted' | 'response_received';
  request: null | {
    method: string;
    url: string;                     // 已脱敏的实际首跳 URL
    headers: Record<string, string>;
    body: string | null;             // 已脱敏，保留可复制文本
    publicModelId: string;
    upstreamModel: string;
  };
  redirects: Array<{
    url: string; method: string; status: number;
    strippedHeaders: string[];
    nextUrl?: string;                // 已脱敏跳转目标，末跳失败时仍可定位
  }>;
  response: null | {
    status: number;
    url: string;                     // 实际最终目标
    headers: Record<string, string>;
    body: string;                    // JSON/文本/片段，由前端安全显示
    format: 'json' | 'text' | 'empty' | 'fragment';
    capturedBytes: number;
    complete: boolean;
    truncated: boolean;
    redacted: boolean;
  };
  failure: null | {
    source: 'cheapai' | 'upstream' | 'transport' | 'protocol';
    phase: 'configuration' | 'dispatch' | 'headers' | 'body' | 'validation' | 'audit';
    code: string | null;
    message: string;
    issues: Array<{ path: string; message: string }>;
  };
  phases: Array<{ name: string; durationMs: number | null; state: 'completed' | 'failed' | 'skipped' }>;
};
```

耗时仅包含 Worker 能观测的配置检查、上游等待/读取、解析等；不伪造 DNS、TCP、TLS 单项耗时，也不暴露 Worker 栈、文件路径或整份 env。

认证/权限错误仍是 401/403 且不带敏感诊断。合法管理员的版本冲突保留 409，在受控的 error.details.diagnostic 中给出 `execution:not_started` 和安全原因；内部 5xx 可返回已采集的部分诊断，不将调用后审计失败改写成「上游没被调用」。因此前端的结果与 API 错误不是简单互斥，详情查看器应支持部分 evidence。

若旧后端返回不含 evidence 的结果，前端明确显示「当前后端未提供请求与响应详情」，不根据状态码虚构内容。

## 7. 内容边界与采集方式

这是诊断详情的功能要求，不增加用户审批流程：所有采集和返回必须限定在此管理员请求，普通调用的外部错误契约保持现有边界。

- **后端先脱敏再返回**：Authorization、x-api-key、Cookie、Set-Cookie、proxy-authorization 的值不回传；响应头使用白名单（Content-Type、request-id/x-request-id、供应商请求 ID、Retry-After、必要限流信息）。
- **正文保留有用信息**：错误 code/type/message、可定位的 JSON 字段和供应商解释保留。去除已知渠道 Key、凭据字段和 URL 中的敏感参数。未知正文不能因为包含 error 字样而整段隐藏。对于无法安全清除的片段，只隐藏相关片段并注明。
- **采集有界**：请求固定模板，响应保留最多 32 KiB；读取最多限额加少量探测字节，超限即取消后续读取。不能先 response.text() 全量读入再 slice，也不能 clone 出未受限的旁路。仅对完整采集的正文进行协议校验；脱敏和现有校验复用同一份有界数据，不读取第二份响应流。
- **截断与脱敏顺序**：采集截断时，若尾部位于凭据字符串/字段内部，隐藏该区域，不能露出半截 Key。记录 complete/truncated 状态，不将片段当成完整 JSON 校验。
- **复制/下载一致**：复制 Body、Headers、cURL 和下载 JSON 均使用服务端脱敏版本。Demo 与正式页面都只使用 textContent/React 文本渲染，不能使用供应商正文作为 HTML。
- **存储简单**：v1 不新增 D1/R2/KV 诊断存储。管理审计仅记录现有意图/结果与受控元数据；不把请求/响应正文塞进审计。Worker 错误日志关联 requestId/diagnosticId，并采用相同凭据清除规则。

## 8. 工程边界

实现时按职责划分，不创建通用插件式诊断引擎：

- 后端 route 负责权限、版本、审计和结果编排。
- 一个诊断采集模块负责有界正文、脱敏和 evidence 整理；直接复用现有协议解析器。
- transport 提供可选的、当前调用专属的请求/跳转观测入口。未传入时普通网关行为保持一致，观测不得增加 fetch、读取第二份流或改变错误分类。
- contracts 定义新增类型和解码；api-client 保留必要的受控 partial diagnostic 错误详情。
- 前端 `ChannelDiagnostics` 继续负责现有 Sheet 状态；结果、请求与响应作为面板内三个 Tabs 组合。复制、下载不需要独立事件总线、页面路由或状态管理库。

源码主要涉及当前诊断 route/transport、channels contract、api-client 错误详情和 admin-channels feature。正式实现再拆小粒度任务，不在本设计阶段改生产。

## 9. 必要验收

完成诊断模块后集中验证一次完整链路，避免每个小任务反复跑测试。

- 401 JSON、429 额度不足、5xx 文本和 HTTP 200 非法响应：能看到真实请求、具体报错、正确来源/阶段；校验结构化事实和字段定位，不严格比较 UI 文案。
- 非 2xx 响应正文确实被有界读取；超限、读取中断、空正文和非 JSON 不造成无界内存或假成功。
- chat/responses/messages 的实际路径、Body、协议头与 transport 一致；跳转改方法和跨域凭据清除反映真实行为。
- 已知 Key、Cookie、敏感字段和截断中的凭据不会出现在返回值、复制、导出及审计；反射凭据用真实测试哨兵校验，不能只判断是否出现某个固定标签。
- 缺少权限/CSRF、版本冲突不调用上游；读取详情、页面切换和复制不产生 fetch；一次明确操作只运行一次诊断，不自动重试。
- 超时和浏览器断线保留不确定状态；不能因为前端 abort 宣称上游没有处理。
- 成功/失败/空态/运行中和窄屏可操作；HTML 作为文本显示，键盘可切 Tabs 和复制。

## 10. 实现入口与模块

`ChannelDiagnostics` 在渠道列表和详情中复用同一 Sheet，使用结果/请求/响应三个 Tabs。Worker 的 `test-channel-route` 保留权限、版本和审计流程；`channel-probe` 组合 transport 观测、有界读取、脱敏和现有协议解析器。`channel-diagnostics` 契约通过管理 API 返回安全证据，409/5xx 使用受控 partial diagnostic details。

视觉 Demo 属于设计素材，不发布到应用静态资源中。源码中的协议模板以 `packages/contracts/src/channel-probe.ts` 为准。
