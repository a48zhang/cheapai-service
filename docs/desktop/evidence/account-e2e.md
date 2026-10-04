# 登录到模型链验证

日期：2026-10-04 UTC。Linux x64。状态：**partial**，真实链未运行。

账号客户端、原生持久化后 restore、home 分区、私有 credential bridge、Provider/profile、登录/账号/余额/退出页与错误恢复已接线。Token/Key 留在宿主与 Runtime 私有边界；普通页面投影不含凭据。

最终统一执行四个桌面 Node 文件，21/21 通过。account-lifecycle/account-controller 使用注入时钟、fake HTTP 与真实本地 binding helper 覆盖：有效 Key 重用/自然到期 single-flight、迟到账号/Key、同账号与异账号 home、持久化前不激活、退出网络失败保留账号、过期退出收尾、provider 失败保留安全账号、Key 失效拒绝新解析且保留已开始流的 child/home、shutdown 后迟到激活不可复活。它们没有实际登录 Worker、绑定 socket/pipe、访问系统凭据库或请求模型。

Runtime 独立类型错误已集中修复；完整类型/构建仍因 DSH/ws 新依赖缺失阻塞。Frontend 类型缺 vite/client。Workers 执行器 listen EPERM，D1 和四个桌面 HTTP 接口到真实网关/计费的路径未验。

未运行：真实测试账号登录、OS Keychain/Windows Credential Manager、私有 IPC、真实模型流/工具/取消、退出撤销的完整链、多客户端与自然 30/90 天后端行为、原生重新打开后的历史。会话 TTL 未为测试缩短；没有隐式获取测试 Key、调用模型、授额或访问生产。

具体命令、平台和源码 blob 见 runtime.md / backend-account.md / conversation.md。取得依赖、可用端口与对应测试环境后统一补验；不能用 mock 宣称真实端到端已通过。
