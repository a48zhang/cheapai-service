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
