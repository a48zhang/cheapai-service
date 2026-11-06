# Error boundaries integration review

This branch is based on main `7ca87fe`. All four reviewed feature heads are integrated in this review branch. No GitHub PR was merged, main was not changed, and nothing was deployed. Production inspection was read-only.

## Actual paths and ownership

| Action | Normal path | Failure owner |
| --- | --- | --- |
| Login/register/logout | Form → session controller → auth API → shared HTTP client → auth route → authentication service/repository | Form retains the operation error; AuthErrorNotice selects actionable text; shared ErrorDetails displays/copies the received diagnostics. Worker apiError logs the original cause chain and encodes the existing status/code policy. |
| Chat send | ChatPage → controller → operation executor → chat API/SSE → chat route → ChatService → D1 adapter → conversation repository/message state machine; generation enters gateway dispatch | Controller owns unsent questions; executor owns accepted generation/reconciliation. Shared ErrorDetails handles presentation. SSE remains a distinct wire protocol. |
| Image | ImagesPage → image API → route → persist job/alarm → provider → R2 asset → settlement | Durable task owns execution and first settlement; scheduled maintenance handles interrupted submissions/settlement. Result/history queries only read. |
| Billing/history/API access | Page/query/mutation → domain API → shared client → protected route → billing/key/request repository | Domain mutation adds an action hint only when useful. Shared notice keeps the original HTTP failure, code, ID, details and cause. History returns persisted error code/message instead of replacing unfamiliar codes. |
| Public API | Protocol route → gateway dispatch → execution → finalization/settlement/lease cleanup | Gateway protocol encoders and execution lifecycle retain their existing responsibilities; a management JSON envelope cannot replace SSE/OpenAI/Anthropic errors. |

## Removed or consolidated

- Removed the unused `ChatStorageAdapter`/`createChatStorage` implementation from messages.ts. It duplicated the live adapter and silently converted association errors to false.
- Conversation CRUD now imports directly from repository.ts in the one live D1 adapter, bypassing messages.ts re-exports.
- More than twenty route/middleware error boundaries no longer construct a second ApiError merely to select the existing 503 policy. apiError performs classification and logging once, retaining the original exception chain.
- Removed duplicate failed-email logging immediately before apiError.
- Shared client no longer substitutes a generic translated message for the server's message. Translation/action hints belong to presentation; the original diagnostics remain available.
- Login and chat detail serialization/copy markup converge in shared ErrorDetails. AuthErrorNotice retains only operation-specific wording, not a second formatter or synthetic Error wrapper.
- Chat uses the latest #35 simplification: removed creation-specific ambiguous-state classifier, lock and reset flag. Failed creation retains the question and follows ordinary retry. No new creation ID protocol, operation table, automatic create replay or creation query loop.

## Retained for correctness

Cancellation, generation ownership/version guards, retained questions, accepted-operation reconciliation, settlement idempotency, recovery of committed accounting evidence, bounded background maintenance and resource release remain. Removing these catches would hide a real business transition or leak a lease; they are not duplicate error presentation.

Request IDs are established at the root HTTP boundary and reused by registration/error responses. Shared transport retains X-Request-ID even on malformed/non-JSON failures. Normal successful management envelopes still require their body request ID.

History returns the actual persisted error message/code under the existing owner/admin authorization. It still excludes raw usage sources, prompts and attempt bodies. An absent historical message cannot be reconstructed; the response retains the stored code and a generic message only when no message was recorded.

## Integrated heads and conflict resolutions

The branch includes #33 `2e4543c`, #34 `db9c2f6`, #35 `882733a` and durable images `632e97f`, verified against GitHub and fetched refs before integration. The source PRs remain open; these are local integration commits only.

- #33 applied cleanly: account/key lifecycle and billing/request-detail presentation are included.
- #34: resolved AuthErrorNotice, its test and auth-copy browser test by keeping operation wording with shared ErrorDetails and original-text disclosure/copy. Remaining navigation and home changes are included.
- #35: resolved ChatNotice and operation-executor by retaining its simplified creation/reload flow, the shared details component and cause chains.
- Images: resolved provider.ts with delivery_failed semantics plus manual redirects and causes. Resolved service.ts with durable execution and first settlement owned by the job, removing the old inline settlement catch. Settlement diagnostics now live in repository.ts at its actual recovery boundary. The local browser entry exports the real ImageGenerationJob so tests exercise alarms rather than synchronous substitution.

No extra conversation creation protocol, recovery framework or fee policy was added during integration. Image queries/replays do not settle; the job performs first settlement and scheduled maintenance retries pending settlement. There is no custom alarm retry loop. Valid saved images can complete and settle their original snapshot even after a delivery timeout; delivery failure is not proof that an upstream incurred no cost.

## Evidence limits

A lost create-conversation response can leave an empty history entry. No message/model request has been made at that point, so retry cannot duplicate a generated answer or charge. This is the accepted complexity tradeoff of the simplified path; it is not exact-once conversation creation.

The integrated image migration replaces legacy delivery unknown records with explicit delivery_failed outcomes while preserving ledger facts. It neither invents an upstream image nor creates a billing waiver. Legacy text requests without enough retained final-usage evidence are not retroactively charged or rewritten.

The user explicitly rejected free closure/platform cost absorption. No billing waiver or closure migration is included here. Existing configured prices remain authoritative; actual quantities must come from upstream evidence. The rejected proposal is withdrawn, not pending approval.

No paid upstream model calls were used for verification. A subsequent read-only production D1 check is documented below. Local Worker/D1 tests and browser fault injection demonstrate implemented paths, not successful paid production model calls or proof of an upstream outcome after a lost connection.

## Verification

The final integrated test results are recorded in the PR. Earlier baseline checks passed the full Worker suite (1,946 tests), Node/React suite (1,724 tests), typecheck, cloud build and affected frontend/client ESLint. Final checks rerun after all four heads were integrated supersede those baseline counts.

Detailed JSON/SSE causes stay attached to execution errors. Protocol status mapping, cancellation and lease cleanup retain their responsibilities. Local logs include Wrangler configuration warnings and self-signed TLS noise; production TLS settings were not changed.

## Normal-path metering correction

Read-only production inspection confirmed configured prices and an actually successful Chat request retained with complete input/output counters but `missing_final_usage`. No production row, balance, price or provider setting was changed. Identifying production evidence remains outside this public repository.

The reproducible blocker is in the Chat usage extractor: it required a separate `choices: []` usage packet even when an upstream sent complete counters on its final choice followed by `[DONE]`. The extractor now accepts those same provider counters after the explicit terminal marker. It does not estimate tokens, infer totals from text, add a fee policy, or treat an interrupted/incomplete stream as final. Duplicate cumulative counters no longer hide a later terminal-choice marker.

The existing Worker finalizer test now runs both packet layouts through actual D1/Gate settlement: one ledger entry, the same preconfigured price, and released leases. Historical rows are not automatically rewritten or charged: the retained usage subtree does not preserve every original choice/DONE frame.

A separate local browser workflow supplies a funded account, enabled group/channel and image model through existing admin APIs. Only its external provider is fixed; login, generation routes, R2 result access, history, balance and ledger are the actual local application. Missing production image configuration is not a product defect or a requested production change.

## Funded local primary paths

The real browser image workflow exposed an actual Worker runtime blocker: `redirect: 'error'` is unsupported by workerd, so generation threw before reaching the provider. The provider now uses `manual`; existing non-success handling rejects redirects without following them. Provider transport/JSON failures retain their causes; service transition catches log the original error with the generation ID and stage.

After that fix, both real local image and web-chat workflows passed (2/2), in addition to the full signup/email/API-key/18 JSON-SSE request/billing workflow (1/1). Local image configuration uses a 0.05 price and 0.5 group multiplier: UI quotes and ledger charges 0.025, balance falls from 0.1 to 0.075, the result loads from R2, reload retains history, and there is exactly one upstream call and one ledger entry. The image test does not mock application routes; only the external supplier is a deterministic fixture. The web-chat test also exercises the actual upstream-failure path and confirms retained input/history with unchanged balance. Its mobile assertion now uses the actual “个人导航” drawer title.

## Integrated validation

After integration, typecheck, full frontend ESLint and cloud build (including Worker dry-run) passed. The local browser run passed 17/18: all real API/chat/background-image flows and authentication cases passed except one mobile navigation attempt whose drawer disappeared during click. That test then passed three consecutive isolated runs without a product-code change; the original timeout is retained as a test limitation rather than assigned an unproven cause.

The account branch's credential test matched both the visible message and shared diagnostic detail. Its assertion now addresses each element explicitly and verifies expanded cause text; all nine credential lifecycle tests passed. Source branch heads were rechecked before publication and remain exactly the hashes listed above.

The integrated full Vitest run completed: 244 files, 3,683 tests; 3,682 passed and only the credential duplicate-text assertion failed. Its corrected file then passed 9/9. No other Worker, Node or React failures were reported. Logs are local verification artifacts, not committed production evidence.

## Independent HTTP supplier acceptance

The earlier fixture intercepted fetch inside the test Worker. The new opt-in acceptance mode starts `scripts/start-mock-provider.mjs` as a separate Node process listening on a real loopback HTTP port. Channels use that actual Base URL. Worker fetch delegates loopback supplier requests to native fetch; it does not fabricate those responses. The supplier parses HTTP requests, sends JSON or delayed SSE frames, returns a visible PNG fixture, and records request paths/models/body/status and credential-presence checks in `upstream-requests.jsonl`. It never records credential values. The existing in-process fixture remains available for faster tests.

Reproduce with:

```sh
XDG_CONFIG_HOME=/workspace/.config CHEAPAI_CHROMIUM_EXECUTABLE=/usr/bin/chromium CHEAPAI_E2E_HTTP_UPSTREAM=1 pnpm exec playwright test tests/e2e/full-workflow.spec.ts tests/e2e/web-chat.spec.ts tests/e2e/image-workflow.spec.ts
```

The command creates fresh local D1/R2/DO storage, starts and stops its own supplier/Worker, and runs desktop (1280×800) and narrow (390×844) projects. Local connection metadata identifies the supplier URL and run directory. Playwright artifacts retain screenshots, ledger/request attachments and failure traces. This is independent HTTP transport acceptance, not a real model or production supplier call; model text, usage counts and PNG pixels are deterministic. No production settings or money were changed.

Actual application paths exercised: browser registration/email/login, API-key creation, group/model configuration, streaming chat, image background submission/alarm/query, authenticated preview and downloaded PNG bytes, refreshed history, quoted price and exact-once ledger charge, and all nine downstream/upstream protocol pairs in JSON and SSE. The image price is 0.05 with multiplier 0.5: quoted/charged 0.025 and balance 0.1 → 0.075. A real supplier HTTP 429 is exercised for chat and images; failed requests retain local and upstream identifiers and provider reasons. Image details can be expanded/copied and survive refresh. No rejected request is assigned invented usage or a new fee policy.

### Repairs found by this acceptance and review

- Image non-2xx responses previously discarded body/status/request ID. The provider now reuses bounded diagnostic capture/redaction; migration 0037 adds one nullable diagnostic column. Owner-only history returns those facts and the card uses the existing shared ErrorDetails display/copy. Known channel credentials are redacted; another user cannot read the job. Delivery/billing rules are unchanged.
- Chat/JSON execution logged supplier facts but request finalization persisted a generic message. The existing request error_message now retains the same bounded, redacted provider reason/code/status/ID. No new request state or storage table is introduced.
- Twenty permanently failing pending settlements could monopolize maintenance's oldest-first LIMIT 20. A failed attempt now advances its existing updated_at ordering timestamp. A native D1 test verifies a later eligible result settles after the blocked batch rotates.
- R2 success followed by a failed D1 completion write previously stranded the asset. That write failure now reaches the platform alarm retry. A retry checks the deterministic R2 key and completes the same record without calling the supplier again; maintenance re-enqueues an interrupted started task before declaring delivery failure. A native D1 trigger reproduces the write failure and verifies result access, one supplier invocation and one ledger entry after recovery. No new task framework or free closure is added.

Validation after these repairs: typecheck passed; Node/React 88 files / 1,731 tests passed; JSON/SSE execution tests passed (43 tests), and final image/request repository/history checks passed (50 tests). The first independent HTTP run revealed generic persisted chat diagnostics; the corrected desktop/narrow run passed all six flows. Final visual/error-detail acceptance and build/lint results are recorded with the PR update.

The browser picker exposed one additional real normal-path block: ChatService rejected an authorized group/model differing from the conversation's remembered selection unless an extra PATCH had happened first. The UI selects locally and sends that selection with the next message; the existing message transaction already validates the conversation version and stores the selection atomically. The redundant equality gate is removed. Authorization, ownership, operation deduplication, version checks and the price snapshot remain. Browser acceptance selects the 0.2 group, sends and verifies that group is persisted and exactly 300 units are charged; the chat/auth regression passes 21 tests.

Acceptance infrastructure fixes: each local run copies its built assets before Wrangler starts, so a concurrent build cannot invalidate its asset manifest. Billing assertions recognize the mobile list as well as the desktop table. The expanded model-selection check verifies persistence after sending, matching the product's single-write design. These fixes do not change product behavior.

Final verification: desktop/narrow API and image cases passed (4 cases); the final desktop/narrow chat run, including picker → discounted send → history and supplier-error page, passed 2/2. HTTP request logs across these two retained runs contain 60 requests (56 HTTP 200 and four deliberate HTTP 429); every supplier call carried authorization and none carried a platform API-key value. Provider processes stop with the test run. The final typecheck, full frontend lint, cloud build and final Worker dry-run passed. Screenshots of the visible PNG and both error-detail pages were inspected.

Known accounting boundary: the existing text-request accounting state remains usage_unknown when a rejected supplier response contains no usage. The history page exposes the original rejection and both request identifiers with a manual-check exit. This acceptance does not silently turn that state into a zero-cost settlement, waive a charge, or invent token counts.

## Follow-up flow simplification

Reviewed `review/pr36-user-flow-simplify` commit `f14e4d1` and incorporated it as `93ea473`. The replay response is already matched to its operation and marked accepted at the call site; the identical second confirmation/rememberPending block and isReplay flag were redundant. Final version/snapshot reconciliation remains. Billing pagination now uses ApiErrorNotice while retaining already loaded rows and retrying the same failed cursor. The new pagination regression uses the shared client and verifies original text, HTTP 503, request ID, copy control and recovery.

Focused controller/billing regression: 18 tests passed. No source PR merge or deployment was performed.

After this follow-up, typecheck and affected ESLint passed. The independent HTTP supplier desktop/narrow chat acceptance passed 2/2, covering replay/deduplication, selected-group pricing, streamed answers, history, failures and mobile navigation. Subsequent desktop/narrow review findings are covered below.

## Legacy-dashboard navigation and recovery acceptance

Reviewed and incorporated `review/auth-mobile-pr36` commit `29974d1` as `a0305d9`. `/dashboard` now resolves to `/billing` inside the authentication boundary but before the interactive personal navigation shell mounts. This removes the intermediate route that could dismiss a drawer the user had just opened. The shared route list no longer owns that redirect; the desktop hash router has the corresponding authenticated redirect, preserving its existing destination and access control.

Reviewed `review/chat-pr36` commit `a2d1f6a` and incorporated it as `7a7219b`: the creation-failure browser test now follows the simplified direct-retry behavior, and race tests use the run's actual supplier Base URL. No product behavior is changed by those test revisions.

Typecheck, affected ESLint and the three navigation component tests passed. Browser validation includes login redirect/mobile navigation, registration, direct creation retry and actual HTTP supplier chat races; final counts are recorded in the PR.

Integrated browser run: 24/26 passed; the two failures were stale homepage test expectations (38px vs the shared size-9/36px icon button, and an old navigation role instead of the current menu). Tests now exercise the real menu and Escape dismissal without changing UI design. Corrected 320/375/1440px layout/login/draft checks passed 3/3. The narrow dashboard redirect/navigation case passed three consecutive runs (3/3); actual HTTP chat race cases passed in the integrated run.
