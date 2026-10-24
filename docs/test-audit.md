# 全库测试清理记录

基线为视觉与 skip-link 修复提交 `19b4b9a`。清理覆盖全部 **246 个独立测试文件**，另查 Rust 内联测试、fixtures、测试脚本和配置，共 **280 条逐文件记录**：[分类清单](test-audit-files.csv)。未设删除比例；逐文件说明删/并/留理由及保留覆盖。

## 数量与结果

| Vitest 范围              | 文件前→后 | 展开用例前→后 |
| ------------------------ | --------: | ------------: |
| 协议转换                 |     39→38 |     1455→1426 |
| 网关/限流/计费/聊天/维护 |     79→76 |       903→855 |
| 管理/认证/迁移/集成      |     78→78 |     1133→1113 |
| React及通用API客户端     |     28→27 |       196→168 |
| Desktop Node             |       6→6 |         24→24 |
| 合计                     |   230→225 |     3711→3586 |

| 其他验证                 | 清理前→后 | 最终结果                                             |
| ------------------------ | --------: | ---------------------------------------------------- |
| Web Chromium             |     70→64 | 64/64 通过；14 文件                                  |
| Desktop Chromium         |       2→2 | 2/2 通过                                             |
| CI差异检测 `node --test` |       8→8 | 8/8 通过                                             |
| Rust 内联测试            |       5→5 | 未运行：环境没有 cargo/rustc，执行 Cargo 命令返回127 |

Vitest 前后全部通过；基线453.95秒，清理后436.61秒。Web浏览器从136.44秒到130.45秒。这是同环境单次观测，包含初始化开销，不是稳定性能基准。用例数按参数表/循环展开，断言或循环迭代不是额外测试；数量不变的测试也有重复步骤删除。逐文件后值来自最终JSON报告，前值由基线总数和逐项已核对删除量还原校验。

## 实际删并及保留依据

- **协议转换**：删除support-matrix重复集成文件、伪造工厂/require.resolve/对象身份和冻结形状断言，缩短同校验分支重复参数。保留九方向真实JSON/SSE、工具流、usage计费、UTF-8/CRLF/BOM与字节上限。
- **网关与计费**：删除三份薄路由测试，将其独有GET/空请求/no-store边界并入`http-integration.test.ts`。上游HTTP错误在适配器之前处理，删六个交叉方向的重复错误例，保留三个原生协议各JSON/SSE错误及九方向转换成功/工具测试。压缩状态×模式×body笛卡尔积，保留每种独立行为。余额、账本、幂等、授权、真实取消与租约并发回归保留。
- **管理/认证/迁移**：删迁移helper自身、重复结构/表名断言、同邮件状态分类和密码边界重复值，移除随机字节统计。分页/清理性能索引、唯一约束实际写入、原子注册、授权及余额触发器保留。
- **前端与API客户端**：删除UUID库行为、虚拟编译器consumer、重复初始分页、私有状态空token断言。`api-error.test.ts`删除，cause断言并入真实API错误路径。保留跨账号隔离、草稿/版本/幂等、诊断取消/付费请求、秘密生命周期及IME输入。
- **浏览器**：关闭注册的邮箱开关重复分支合并；共用候选查询和创建渠道失败的排列保留独立代表。模拟重复发送并入真实HTTP计数测试；删除与既有数据库/主题/模型菜单回归重复的步骤和无比较基准的截图动作。九协议完整计费链路、重生成四态、两个表单各自的迟到响应，以及新修复的四项skip-link首焦点回归均保留。
- **Desktop**：仅删Rust测试中的Tokio BufReader分块fixture，改为直接测试本项目Bootstrapped解码，生产代码不变。React同实例断言查到历史故障后保留，未以“实现细节”误删。
- **脚本/fixtures**：删除无人引用且仅Windows可执行的旧`test-local-integration.py`；其认证、CSRF和端点行为已有现行集成/浏览器覆盖。九份协议fixture、测试Worker、数据库/邮件helpers、Desktop fixtures均有实际消费者而保留；CI门禁和所有测试配置未改。

## 执行命令与边界

完整执行仓库`check`相同三个阶段，给test追加JSON reporter用于逐文件计数，未更改发现/排除/重试配置：

```sh
pnpm run typecheck
pnpm run test --reporter=default --reporter=json --outputFile=/tmp/cheapai-tests-after.json
pnpm run build
pnpm run lint:web
pnpm run lint:shared
pnpm run typecheck:desktop
pnpm exec playwright test
pnpm run test:desktop-ui
node --test scripts/ci/desktop-changes.test.mjs
```

类型、lint、构建、修改文件格式和`git diff --check`通过；Worker构建仅dry-run。完整`format:check:web`仍报告原有9个未修改文件，未顺带重排。Rust命令未运行成功；没有以pnpm结果代替原生验证。真实供应商live矩阵、实际恢复库检查、原生安装打包不属于本次本地回归，未执行。临时配置/浏览器缓存放`/tmp`；未访问生产、修改账号权限、推送、创建PR、合并或部署。
