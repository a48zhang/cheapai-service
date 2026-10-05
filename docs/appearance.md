# Web 与 Desktop 外观主题

日期：2026-10-04。范围：React 19 Web 全站和 Tauri Desktop 的 React 界面。

## 设计与行为

- 保留 CheapAI 蓝色主色。浅色使用中性背景，暗色使用深灰蓝背景；背景、内容、悬浮层分别有独立语义色。首页保留蓝色主视觉，产品示意与正文随主题切换，开发者示意区始终使用自包含深色配色。
- 三种偏好：跟随系统（默认）、浅色、深色。系统变化只影响跟随系统模式；手动选择保持到用户再次修改。
- Web：首页、登录注册、聊天及个人/管理页面的顶部提供紧凑外观选择器。Desktop：初始化、登录、工作区及不可用状态均可切换，通用设置也有完整选择器。
- 使用本机非敏感存储 `cheapai.appearance.v1`。同源 Web 标签页同步；Desktop 使用自己的 WebView 存储。两端共用行为实现，不跨设备/跨来源同步，也不把外观绑定到账户或写入认证、会话数据。
- 存储损坏回退跟随系统；存储受限仍立即切换，并仅在保存失败时显示短提示。
- 选择器使用原生 select，支持键盘、屏幕阅读器和系统菜单；焦点可见。所有页面保留 reduced-motion 行为。

## 实施顺序与落点

| 阶段 | 实现 | 验收 |
| --- | --- | --- |
| 1. 盘点 | Web 固定色、聊天局部变量、首页展示色、Desktop 颜色变量及 DSH 代码块 | 页面、浮层、状态提示均纳入范围 |
| 2. 共享基础 | `packages/theme`：色板、偏好状态和 React 选择器 | 两端使用同一语义颜色和状态实现；配色由视觉验收确认 |
| 3. 首屏初始化 | 共用 Vite 插件输出带内容哈希的外部阻塞脚本 | 主应用脚本未加载时，已应用保存的主题、背景和 color-scheme；不放宽 Worker CSP |
| 4. Web 覆盖 | 首页、认证、聊天及模型选择器、个人页面、管理表单/表格/错误和状态标签 | 浅/深截图、窄屏、模型浮层与账户菜单、原有浏览器流程 |
| 5. Desktop 覆盖 | 应用框架、认证、会话/工具详情、设置、Markdown 表格/代码、Shiki 色彩变量 | 使用真实组件的浏览器夹具；切换不卸载消息；原生主题调用保持顺序 |
| 6. 回归 | 类型检查、构建、相关单元测试、Web 与 Desktop 浏览器测试、lint/format | 本地结果与原生实机验证分别记录 |

## 维护约定

颜色定义位于 `packages/theme/src/tokens.css`；两端原有样式文件只保留字号、间距、圆角等布局变量。新组件应使用 `--color-surface`、`--color-ink`、`--color-line` 等语义变量，不使用固定白底、Tailwind 的固定色阶，也不要单独维护暗色覆盖表。

`bootstrap.js` 是首屏脚本与 React 模块回退共同使用的实现，通过 `window.__cheapaiTheme` 单例保持状态。Vite 插件生成内容哈希资源，防止更新后缓存旧引导代码；不使用内联脚本。窗口级监听器与页面共存，React 组件只订阅并在卸载时取消订阅。

Desktop 原生适配单独放在 `adapters/native/theme.ts`：Tauri 环境调用窗口 `setTheme`，跟随系统传 `null`。对应最小权限为 `core:window:allow-set-theme`。普通浏览器不调用原生 API。原生外观调用失败不阻断 WebView 使用。

DSH 使用公开 `--dsw-*` 和 `--shiki-*` 变量；代码高亮随 CSS 变化，不重新解析历史、不修改依赖包。测试夹具位于 `apps/desktop/tests`，不属于生产构建入口。

## 验证命令与边界

```sh
pnpm run typecheck
pnpm run typecheck:desktop
pnpm run lint:web
pnpm run lint:shared
pnpm run format:check:web
pnpm exec vitest run --project node --project react
pnpm run build
pnpm run build:desktop
pnpm exec playwright test
pnpm run test:desktop-ui
```

自动化测试集中覆盖真实浏览器中的首屏初始化、系统切换、手动选择、持久化、标签页同步和存储失败，不再维护重复模拟浏览器的 VM 测试或绑定具体色值的断言。

Desktop 保留真实 GeneralPanel 与 DSH Markdown 的主题切换测试，以及原生窗口 IPC 测试。布局、浮层和配色沿用现有交互测试与人工视觉验收，测试不再自动生成无比较基准的截图。

当前 Linux 环境不能代表 macOS/Windows 原生实机：标题栏视觉、系统原生下拉菜单、安装后重启持久化及多显示器系统切换仍需在对应平台验收。浏览器与原生 IPC 夹具通过不等于原生安装包发布验收。

## 初次实现验收记录（清理前）

2026-10-04，Linux 工作区：

- 严格锁文件安装、Web/共享包/后端与 Desktop 类型检查、两端生产构建、Web/共享主题 lint 和格式检查通过。
- Node + React：70 个测试文件、1,865 项测试通过，包含主题行为和色板对比度测试。
- Web：原有 51 项浏览器回归通过；新增 6 项主题测试通过。补齐后台原生 select 的颜色后，再次通过管理员全流程与全部主题测试。
- Desktop：4 项 Chromium 测试通过，包括真实 Markdown 高亮颜色切换与原生 `setTheme` IPC 参数验证。
- 人工检查：首页、聊天/模型浮层、后台、Desktop 设置/登录/Markdown 的浅色与暗色截图。
- 未执行 macOS/Windows 原生安装包的实机验证；未进行线上部署。

## 冗余清理（2026-10-05）

主题专项测试由 16 项收敛为 5 项：Web 3 项、Desktop 2 项。删除 VM 浏览器模拟、固定 RGB 断言、配色笛卡尔积检查、无基准截图，以及重复的浅/深渲染流程；Desktop 夹具只挂载设置与 Markdown。React 依赖回归保留实例一致性检查，删除固定小版本断言和虚构 Zustand 示例。

主题模块直接导出已初始化的 store，去掉重复 getter/hook 层及内部已知枚举的再次解析；Desktop 偏好移除重复规范化包装；聊天重新生成只在输入边界执行一次 schema 校验。存储读取校验、异常处理和异步原生调用顺序继续保留。

清理后验收：Node + React 共 69 个文件、1,858 项测试通过；Web 3 项及 Desktop 2 项主题浏览器测试通过。Web/共享包/后端与 Desktop 类型检查、两端生产构建、Web/共享包 lint、Web/共享主题格式检查通过。本轮未重复执行完整 Web 浏览器回归或原生实机验证。
