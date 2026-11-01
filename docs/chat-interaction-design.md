# 聊天交互设计与复用基线

核对日期：2026-10-29。范围为网页聊天。参考依据是以下固定版本的源码与文档，
没有把未进行的线上操作或手机真机检查计作体验验证。

## 参考项目与选型

| 参考                                                                                                       | 核对到的实现                                                                                                              | 本项目的采用方式                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [new-api](https://github.com/QuantumNous/new-api/tree/e449cc700eb569cdfc2199cb73e97de46944f43c)            | Playground 先更新用户/回答消息对，再调用发送；回答内部显示 Loader 和 Responding；采用 AI Elements Conversation 与滚动按钮 | 参考网关产品中的聊天组织方式。所查业务文件标注 AGPL-3.0-or-later，本批未移植其源码                                       |
| [NextChat](https://github.com/ChatGPTNextWeb/NextChat/tree/1d3dc331512929a4b1d3e82354e72acce33b5c7a)       | 请求之前加入用户消息和 streaming assistant；控制器以会话和消息标识关联                                                    | 参考本地回答占位与会话级任务归属。MIT；完整页面与其 store、Next.js、存储和请求实现耦合，适合按行为拆分采用               |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui/tree/2b11e9cc44699ccbce1d5d4d2ce21a1d9edce85c) | ExternalStoreRuntime 可桥接现有 store；滚动分别处理 runStart、threadSwitch 和 prepend                                     | MIT。作为未来整套聊天 UI 的候选；需明确映射本项目的请求结果未知、服务器版本选择和草稿归属，接入工作并非替换一个 JSX 标签 |
| [AI Elements](https://github.com/vercel/ai-elements/tree/ca8be600bfd01b3131f9bf6134b51602a71f4374)         | 可移植的 React/shadcn 组件；发送控件区分 submitted/streaming；Conversation 使用 use-stick-to-bottom；Message 提供分支结构 | Apache-2.0。本批直接改编 PromptInputSubmit；其余组件分批评估依赖与行为，保留现有服务端合同                               |

主要源码证据：

- new-api：`web/src/features/playground/hooks/use-playground-conversation.ts`、
  `components/message/playground-message-content.tsx`、
  `lib/message/message-content-utils.ts`（后两者同属 `features/playground/`）。
- NextChat：`app/store/chat.ts` 的 `onUserInput`，以及 `app/components/chat.tsx` 的
  空正文 loading 分支。
- assistant-ui：`apps/docs/content/docs/runtimes/custom/external-store.mdx`、
  `packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts`。
- AI Elements：`packages/elements/src/prompt-input.tsx`、`conversation.tsx`、`message.tsx`。

本项目已经使用 React、Radix、Tailwind 和 shadcn 风格，AI Elements 局部组件的
适配距离较小。完整移植 AI Elements Message 会引入 Streamdown 等渲染依赖；
Conversation 会引入 use-stick-to-bottom；完整 assistant-ui 会增加 runtime 和
adapter。按需要引入时应分别验证 Markdown 安全、历史选择规则和服务端权威状态。

## 一轮回答的呈现合同

`model/presentation.ts` 从现有请求 phase 推导响应文案、动画、输入提示和提交动作。
组件不另存一份可写的生成状态，也不以“有 streamMessageId”判断是否仍在生成。

| 请求阶段              | 回答位置                               | 输入区主动作                             |
| --------------------- | -------------------------------------- | ---------------------------------------- |
| creating / submitting | 立即显示本地回答占位和正在等待回复     | 可停止；允许编辑下一条草稿               |
| streaming，暂无正文   | 保持等待反馈                           | 可停止                                   |
| streaming，已有正文   | 同一位置显示正文和生成中               | 可停止，正文可复制                       |
| stopping              | 保留正文，显示正在停止                 | 禁止重复停止，草稿保留                   |
| finalizing            | 显示正在确认结果                       | 暂停发送，解释原因                       |
| interrupted           | 保留内容，显示结果待确认，停止动效     | 等待既有恢复流程核对结果，草稿可编辑     |
| idle / failed         | 显示服务端已确认内容或原有错误恢复状态 | 按现有模型可用性与恢复约束决定是否可发送 |
| 选择回答版本          | 保留原回答，不制造新的回答占位         | 显示正在切换版本，不能提供无效的停止操作 |

本地回答占位是视图行，不是虚构的服务端 ChatMessage。接受发送后即创建，以本次
operationId 为渲染标识；meta 到达后复用该位置，避免同时出现占位和真实回答。
重新回答在原回答位置等待；被明确拒绝时恢复原来的已保存回答。
恢复或重试时保留先前由同一操作响应确定的回答 ID，防止已保存的回答旁再次出现
空占位；不会从普通历史读取中猜测哪条回答属于本次操作。版本切换结果未知时停止
动效，显示待确认提示。

## 输入、复制与阅读

- 生成中可继续编辑草稿，界面明确解释稍后发送；不暗中排队或自动发送。
- 中文输入法的选词 Enter 不提交；Shift+Enter 换行；点击发送后焦点回到输入框。
- 整条回答与代码块都复制当前可见文本快照。正文变化后清除旧的复制成功反馈；
  成功或失败反馈在两秒后复位。
- 主动发起发送或重新回答时定位到最新一轮。同一次输出中主动上翻后停止跟随；
  回到最新后恢复跟随。此规则参考 assistant-ui 对 runStart 与增量更新的区分，
  当前实现继续使用本项目的滚动 hook。

## 验收与维护

修改任何阶段时，同时更新呈现合同与用户可见行为测试。最小回归包括：

1. 创建会话及提交请求均不返回时，用户消息和左侧回答占位已经存在。
2. meta 和首段正文到达后，同一位置只有一个回答。
3. 停止、确认和中断均保留正文，且不会继续错误显示生成中。
4. 生成中可复制实际正文；新正文不会继续显示已复制。
5. 主动发送显示新回答，随后上翻阅读不会被后续 token 拉回。
6. 输入法保护、显式停止和点击发送后的焦点行为可回归。

本批回归位于 `MessageList.test.tsx`、`Composer.test.tsx` 和
`useScrollAnchor.test.tsx`，控制器测试覆盖恢复同一回答标识。
`tests/e2e/chat-start.spec.ts` 在 1440px 和 375px 验证创建及提交阶段等待提示位于
可视区域、完成后只有一个回答，以及输入框位置稳定。

本批运行前端单测 106 项，以及 chat-start、chat-desktop、web-chat-ui 共 23 项
Chromium 浏览器回归。浏览器通过本机 HTTPS 静态服务读取生产构建，API 使用这些
用例既有的模拟接口，未接入真实上游或计费。后续真机验收仍需覆盖长 Markdown、
手机软键盘、触达和读屏。

## 后续批次的明确边界

本批完成的是反馈、输入操作、复制和主动发送滚动；以下事项继续单独维护：

- 未发送问题按账号/会话保存，并保留在原时间位置。
- 权威快照足以确认同一操作时解除 interrupted；不能把另一操作的新消息当证据。
- 站内导航时的会话级任务管理。刷新或关闭页面后仍继续生成需要服务端任务能力。
- 历史版本的只读浏览与改变上下文分开。
- 可控的慢响应/断网/停止场景预览页，以及真实移动端验收。

每次移植记录固定 commit、路径、具体符号、修改范围和许可证；维护入口为
`THIRD_PARTY_NOTICES.md`。UI 组件升级不改变请求幂等、身份隔离和计费确认合同。
