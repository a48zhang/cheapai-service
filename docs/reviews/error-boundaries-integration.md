# Error boundaries integration review

This branch is based on main `7ca87fe`. It is a local review branch; no PR was merged and no deployment or production data operation was performed.

## Actual paths and ownership

| Action | Normal path | Failure owner |
| --- | --- | --- |
| Login/register/logout | Form → session controller → auth API → shared HTTP client → auth route → authentication service/repository | Form retains the operation error; AuthErrorNotice selects actionable text; shared ErrorDetails displays/copies the received diagnostics. Worker apiError logs the original cause chain and encodes the existing status/code policy. |
| Chat send | ChatPage → controller → operation executor → chat API/SSE → chat route → ChatService → D1 adapter → conversation repository/message state machine; generation enters gateway dispatch | Controller owns unsent questions; executor owns accepted generation/reconciliation. Shared ErrorDetails handles presentation. SSE remains a distinct wire protocol. |
| Image | ImagesPage → useImageWorkspace → image API → image route → image service → provider/storage/settlement | Existing image job state owns delivery and billing transitions. The independent durable-image branch owns its replacement background execution path. |
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

## Parallel branch coordination

- #33 `fix/account-user-paths`: inspected `2e4543c`. Account/key/billing UI changes remain owned by that PR. Backend history diagnostic repair and shared client/notice complement it.
- #34 `fix/user-journey-copy`: inspected `db9c2f6`. Locally incorporated authentication/session changes and tests needed for operation-specific errors and bounded auth waits. Its duplicate AuthErrorNotice formatter is replaced by shared ErrorDetails; the API-access navigation label and query-normalization drawer fix are included because the auth browser flow exercises them; unrelated home copy is not included.
- #35 `fix/chat-user-path`: inspected `882733a`. Locally incorporated the chat recovery simplification and diagnostic tests; its detail formatter is replaced by shared ErrorDetails, with causes preserved. No remote PR merge.
- `feat/durable-image-jobs`: inspected `ab5ac79`. Its normal path is submit → persisted job/alarm → provider → asset → first settlement; queries are read-only and scheduled maintenance owns recovery. It closes undelivered jobs as failed/unbilled without asserting upstream non-execution. This branch does not duplicate or supersede those job changes.

## Explicit limits requiring a decision or the other branch

A lost create-conversation response can leave an empty history entry. No message/model request has been made at that point, so retry cannot duplicate a generated answer or charge. This is the accepted complexity tradeoff of the simplified path; it is not exact-once conversation creation.

Main still uses synchronous image execution and `unknown` job records until the separately reviewed durable-image changes are integrated. Those changes must not be silently represented as already present here.

Chat/API `usage_unknown` is missing billing evidence, not a known zero cost. The current schema permits later complete evidence to settle it; changing it to final `not_chargeable` requires a charging-policy decision and a database guard against later debits. A question proposing final unbilled closure has been raised. Until answered this branch retains the evidence and existing behavior; it does not claim that all unknown billing states have been eliminated.

No live upstream credentials/model responses were used for verification. Local Worker/D1 tests and browser fault injection demonstrate implemented paths, not successful paid production model calls or proof of an upstream outcome after a lost connection.

## Verification and integration evidence

- Full Workers suite: 155 files / 1,946 tests passed. Final affected login/register/middleware/email/history/chat/billing/image regression: 8 files / 87 tests passed.
- Additional final JSON/SSE cause-chain and history-contract regression: 3 files / 49 tests passed, including long/whitespace-preserving diagnostic text.
- Node + React suite: 87 files / 1,723 tests passed before the final navigation regression was incorporated; navigation test then passed 3/3. Final total is recorded in the review result.
- Typecheck passed; cloud build (Web plus Worker dry-run, not deploy) passed; changed frontend/client ESLint and git diff --check passed.
- Chromium local Worker/mock-upstream flows: first run 40/43 passed. The failures exposed one obsolete diagnostic-loss assertion and two #34 navigation changes omitted from the initial local integration. Final auth run passed 15/15, covering those three failures; other chat/image/console flows passed 28/28 in the first run. The mobile login diagnostic screenshot was inspected.
- Local test logs contain Wrangler configuration warnings and local TLS handshake noise. Browser assertions completed successfully after the fixes; no production TLS settings were changed.
- `git merge-tree --write-tree` against the local review commit found no textual conflicts with #33 (`2e4543c`) or durable images (`ab5ac79`). This writes a temporary tree only; it does not merge a branch.
- #34 conflicts: AuthErrorNotice.tsx, AuthErrorNotice.test.tsx, tests/e2e/auth-copy.spec.ts. Resolution intent: keep its operation wording and tests, use the shared ErrorDetails/ApiErrorNotice implementation, and assert that original server text is collapsed then available—not absent.
- #35 conflicts: ChatNotice.tsx and operation-executor.ts. Resolution intent: keep its simplified state/reload behavior and flat diagnostic fields, use shared ErrorDetails, retain cause-chain data.

Detailed JSON/SSE causes stay attached to execution errors, in addition to the existing execution log. Protocol status mapping, upstream-call count, settlement and cleanup semantics are unchanged.
