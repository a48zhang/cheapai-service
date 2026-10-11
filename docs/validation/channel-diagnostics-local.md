# Channel diagnostics local validation

Checks ran in `/tmp/cheapai-worker-review-main` with `XDG_CONFIG_HOME=/tmp/cheapai-diagnostics-validation/config`, `XDG_CACHE_HOME=/tmp/cheapai-diagnostics-validation/cache`, and `WRANGLER_SEND_METRICS=false`. Normal TLS verification remained enabled. Command logs are under `/tmp/cheapai-diagnostics-validation/`.

## Final scoped results

| Check | Command | Result |
| --- | --- | --- |
| Cloud typecheck | `pnpm run typecheck:cloud` | Passed, exit 0. Contracts, model catalog, theme, API client, web, and worker typechecks completed. Log: `typecheck-cloud-final2.log`. |
| Cloud build | `pnpm run build:cloud` | Passed, exit 0. Web TypeScript and Vite production build succeeded; Worker Wrangler build used `--dry-run` and did not deploy. Log: `build-cloud-rerun.log`. |
| Worker build after the final transport-probe source edit | `pnpm --filter @sub2api/worker run build` | Passed, exit 0; Wrangler `--dry-run`. Log: `worker-build-final.log`. |
| Targeted Node tests | `pnpm exec vitest run --project node tests/unit/api-client.node.test.ts tests/unit/web-admin-contracts.test.ts` | Passed: 2 files, 23 tests. Log: `node-targeted.log`. |
| Targeted Worker tests | `pnpm exec vitest run --project workers tests/gateway/diagnostic-redaction.test.ts tests/gateway/diagnostic-body.test.ts tests/gateway/test-channel-route.test.ts tests/gateway/transport.test.ts tests/gateway/headers.test.ts tests/gateway/upstream-url.test.ts` | Final scoped coverage: 6 files, 69 tests passed, including the later masked-credential and provider-MIME regressions. The initial run passed 63/67; after fixes, the affected route and transport files passed 40/40, while the other four files had passed all 27 tests in the initial run. Logs: `workers-targeted.log`, `workers-route-transport-rerun.log`. |
| Targeted React tests | `pnpm exec vitest run --project react apps/web/src/features/admin-channels/diagnostic-format.test.ts apps/web/src/features/admin-channels/ChannelDiagnostics.test.tsx apps/web/src/shared/lib/api-error.test.ts` | Final scoped coverage: 3 files, 20 tests passed. The initial run passed 19/20; after the jsdom fix, `ChannelDiagnostics.test.tsx` passed all 10 tests. Logs: `react-targeted.log`, `react-channel-diagnostics-rerun.log`. |

The Worker build emitted a Wrangler configuration warning about a top-level `send_email` binding named `undefined` not being inherited by `env.production`; the dry-run still completed successfully.

## Failures found and resolved during validation

The first `typecheck:cloud` run exited 2 with TS5097 for the `.ts` import in `packages/contracts/src/channels.ts`. An intermediate source adjustment then produced TS2835, which required the explicit `.js` extension. The final source uses the NodeNext-compatible import and the final typecheck passed. The same import issue and two new React test type errors initially stopped `build:cloud`; after those source fixes, the web build and Worker dry-run passed.

The first six-file Worker run found four failures: the route test expected a provider code in the message instead of the provider message, a partial-body test expected text that the secret-tail redactor correctly removed, a timeout audit assertion expected `headers_timeout` but received `request_timeout`, and a redirect test expected `body: undefined` to be an own property. The route and transport tests were updated by their owners; the final affected-file rerun passed all 40 tests.

The first React run had one failing `ChannelDiagnostics` selection test because jsdom lacked Radix Select pointer-capture support. The test setup was corrected, and the file then passed all 10 tests.

One Node invocation used `pnpm run test:node -- ...`; PNPM forwarded the separator, so Vitest ignored the two intended file filters and ran the whole Node project. That run exited 1 after 1,666 tests passed; two unrelated desktop suites could not load `@deepseek-ai/dsh-llm/assistant-stream` and `@deepseek-ai/dsh-client-ui-primitives`, which are absent from this local install. The corrected focused Node command passed both requested files. This local desktop dependency limitation did not affect the channel-diagnostics checks.

Root also passed `pnpm run lint:web`, `pnpm run lint:shared`, and `pnpm run format:check:web`. After the jsdom setup change, the affected React test file passed a focused ESLint and Prettier check. Browser results are in [channel-diagnostics-browser.md](channel-diagnostics-browser.md). The full repository suite remains a CI check.

## Preview-driven masked credential correction

Preview verification exposed a provider error message containing a partially masked echo of the known channel key. The redactor now replaces star-masked tokens only when their visible prefix/suffix match the known key, leaving unrelated starred text intact. One necessary synthetic regression covers JSON, plain text and provider errors; no real credential is in the test.

After the complete fix, `pnpm exec vitest run --project workers tests/gateway/diagnostic-redaction.test.ts tests/gateway/test-channel-route.test.ts` passed 24/24 tests (`masked-credential-regression.log`). Worker typecheck passed. A first dry-run invocation lost the temporary XDG environment across a shell `&&`, causing a local config-directory failure; the corrected Worker-only dry-run passed (`masked-credential-worker-build-final.log`). No further frontend checks were needed for this backend-only correction.

## Repository CI

The complete Local checks workflow passed for implementation revision `92ce01f`: [run 38130702006](https://github.com/a48zhang/cheapai-service/actions/runs/38130702006). This includes all workspace typechecks, repository tests/builds, style checks and browser/desktop checks. The later provider-masked credential correction at `16ada17` passed the focused checks above; its complete CI workflow was still running when this record was prepared.

## Provider MIME interpretation

The extra preview assertion assumed every parseable error body must have `format=json`, but presentation classification also uses the upstream MIME. A necessary local route regression verifies that a 401 JSON error delivered as `text/plain` remains classified as text while preserving its provider code/message and redacting a masked known-key echo. The affected route file passed 22/22 tests (`provider-mime-regression.log`). This establishes the supported behavior without inferring the unsaved preview MIME.
