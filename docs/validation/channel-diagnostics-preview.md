# Channel diagnostics preview validation

Validated 2026-10-11 against PR 9 preview `https://sub2api-c45a9034a6-pr-9.alphazhang689.workers.dev`. The Cloudflare settings endpoint returned HTTP 200 with `ENVIRONMENT=staging` and D1 `f9719b76-adb4-4ebe-be98-6e784e2440a1`; `/healthz` returned `{"status":"ok"}`. No production configuration was used.

## Deployment revision

The final verification targeted the PR 9 preview after CI preview run `38131478049` completed successfully for full SHA `16ada17bb7cb1d8226eed52e57a999e376a2d199`. Earlier steps ran while preview runs `38130555283` (`d858e7b`) and `38130701988` (`92ce01f`) were reported successful; the Worker response did not identify its serving revision, so those earlier calls are attributed to the PR preview sequence rather than one exact SHA.

## Diagnostic requests

Each attempt used isolated admin/group/model/channel/mapping resources, `https://api.openai.com/v1`, a generated invalid credential, a fake upstream model name, a zero-priced model, and a 16-token limit. No valid upstream credential or paid model was used. Across the sequence there were exactly three real provider calls, all single attempts with no retry:

| Attempt | Result |
| --- | --- |
| Initial stale-version check | HTTP 409, code `conflict`, `execution=not_started`; rejected before upstream dispatch. The subsequent single invalid-credential call returned HTTP 401. |
| Supplemental pre-fix snapshot check | One invalid-credential call returned HTTP 401. The combined redaction assertion failed; the provider response text was discarded and is not retained. No retry was made. |
| Final check after run `38131478049` | Management API HTTP 200, `outcome=http_error`, upstream/evidence status 401, `execution=response_received`, provider code `invalid_api_key`. No stale-version request was repeated. |

The final response snapshot passed 20 of 21 checks. The 20 passing checks covered POST to `/v1/chat/completions`, the actual mapped model, `max_tokens=16`, `stream=false`, masked Authorization, the complete request snapshot excluding the original credential, a nonempty bounded complete non-truncated response body, redaction, removal of the original credential, HTTP 401, provider code, and matching failure code/message. The provider's masked credential echo was replaced with `[REDACTED]`; neither the provider message nor any credential fragment is recorded here.

Final safe response-body metadata: `body_length=256`, `capturedBytes=305`, `complete=true`, `truncated=false`, `redacted=true`. The sole failed check was the expectation that the evidence `response.format` equal `json`. The body parsed sufficiently to extract the provider error code, but the safe result did not retain `response.format` or the `Content-Type` MIME value, so this report does not infer either value or claim a format assertion pass.

## Audit, balance, and cleanup

At the initial-run checkpoint, read-only D1 checks found 7 relevant admin audit rows, no match for that run's distinctive invalid-key prefix in `redacted_change_json`, balance 0, and no matching `requests` or `billing_entries` rows. Audit bodies were not exported. The audit and finance counts were not re-read after the two later diagnostic attempts, so the 7-row figure is not presented as a post-sequence total.

After the final attempt, the owned-resource cleanup SQL ran. Its local Wrangler JSON verifier did not find the result columns, so a separate read-only D1 query verified cleanup: test admin disabled (1), active sessions 0, remaining channels 0, unsafe channel credentials 0, active models 0, remaining mappings 0, and active groups 0. Cleanup preserved audit records. The private test run-state, including the temporary session and invalid credential, was cleared and deleted. No password, cookie, provider message, or upstream key is recorded here.

This validates stale-version rejection, the provider 401 failure path, request-snapshot redaction, failure evidence matching, and cleanup. It does not validate successful upstream generation, paid-model behavior, or provider-side billing; no valid model credential was available or used. The final `response.format == json` expectation was unmet; the exact wire MIME was not retained, so the reason cannot be established from the safe record.

The implementation classifies `json` only when the upstream MIME indicates JSON and the complete captured text parses. A local route regression separately passed for a JSON error sent under `text/plain`, preserving the provider details and redacting the masked key while reporting `format=text`; see [local validation](channel-diagnostics-local.md). This does not recover the missing preview MIME or turn the extra assertion into a pass. The 20 core request, redaction and failure-evidence checks passed. After all runners stopped, root removed the complete private credential/runner directory, including the Cloudflare token file.
