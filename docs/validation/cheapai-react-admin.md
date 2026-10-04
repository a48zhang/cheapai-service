# cheapai React 管理端验证

**状态：本地管理端模块验收通过。** 完整浏览器运行后的余额详情与 UserForm 操作两项定位修正，已通过定点复跑。

## 当前证据

- 2026-10-03 16:52:33 开始的完整 Vitest：198 个测试文件、3847 项通过，记录见 `/tmp/cheapai-final-vitest.log`。该总量覆盖所有项目，不将它拆算为管理端单独结果。
- 全 workspace typecheck 和 build 已通过；Worker Wrangler build 使用 dry-run，未部署。最新整合记录见 `/tmp/cheapai-integrated-final.log`，Worker dry-run 读取了 React `apps/web/dist` 中的静态资源。
- React ESLint 已通过，使用 `@cheapai/web` 的 `lint` 命令检查 `apps/web/src`；结果见整合记录 `/tmp/cheapai-integrated-final.log`。
- 17:12:58 开始的整合记录中，React 项目定点运行有 8 个测试文件、35 项通过；PR preview self-test 也通过，见 `/tmp/cheapai-integrated-final.log`。该定点数量未与全量 Vitest 重复相加。
- 完整浏览器套件 37 项中 35 项通过，见 `/tmp/cheapai-browser-complete.log`。原先失败集中于 `admin.spec.ts` 余额详情读取 locator 和 `product-corrections.spec.ts` 沿用旧 UserForm 分组选择器。
- 两个修复后的管理端用例另行定点运行，2/2 通过（admin 14.4s、operations 12.1s），见 `/tmp/cheapai-browser-operations-pass.log`。因此完整套件的 37 项均已有通过证据，来自 35 项完整运行加 2 项修复后定点运行，不是单次 37/37。

## 管理资源覆盖

最新浏览器运行已覆盖并通过管理资源 picker、认证和完整业务工作流。现有 [管理资源目录阶段性记录](cheapai-react-catalog.md) 提供渠道、模型、访问组和用户详情 API 风险用例细节；余额页与 UserForm 两条用例已在修正 locator 后通过定点复跑。

未进行 PR preview 部署；本地 PR preview self-test 和 Worker dry-run 不构成远程预发部署证明。
