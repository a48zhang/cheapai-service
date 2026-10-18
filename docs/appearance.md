# Web 与 Desktop 外观主题

Web 与 Desktop 共用主题色板、偏好状态和外观选择器。

## 设计与行为

- 保留 CheapAI 蓝色主色。浅色使用中性背景，暗色使用深灰蓝背景；背景、内容、悬浮层分别有独立语义色。首页保留蓝色主视觉，产品示意与正文随主题切换，开发者示意区始终使用自包含深色配色。
- 三种偏好：跟随系统（默认）、浅色、深色。系统变化只影响跟随系统模式；手动选择保持到用户再次修改。
- Web：首页、登录注册、聊天及个人/管理页面的顶部提供紧凑外观选择器。Desktop：初始化、登录、工作区及不可用状态均可切换，通用设置也有完整选择器。
- 使用本机非敏感存储 `cheapai.appearance.v1`。同源 Web 标签页同步；Desktop 使用自己的 WebView 存储。两端共用行为实现，不跨设备/跨来源同步，也不把外观绑定到账户或写入认证、会话数据。
- 存储损坏回退跟随系统；存储受限仍立即切换，并仅在保存失败时显示短提示。
- 选择器使用原生 select，支持键盘、屏幕阅读器和系统菜单；焦点可见。所有页面保留 reduced-motion 行为。

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

自动化测试集中覆盖真实浏览器中的首屏初始化、系统切换、手动选择、持久化、标签页同步和存储失败。

Desktop 保留真实 GeneralPanel 与 DSH Markdown 的主题切换测试，以及原生窗口 IPC 测试。布局、浮层和配色沿用现有交互测试与人工视觉验收。

在 macOS 和 Windows 上检查标题栏、系统下拉菜单、安装后重启持久化和多显示器主题切换。
