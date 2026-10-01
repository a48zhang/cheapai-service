# Q07 live compatibility testing

`scripts/verify-upstream-matrix.ts` is the preparation and execution tool for
the post-acceptance Q07 check. It exercises the nine downstream/upstream
protocol combinations through the gateway and records ordinary JSON, SSE and
tool round-trip results in a redacted JSON report.

The command is dry-run by default. It does not read credentials, load an SDK,
open a socket, or contact a provider unless `--live` is present. `--mock` runs
the same case selection and report bookkeeping with synthetic local usage; a
mock pass is not supplier compatibility evidence.

## Fixed test matrix

The matrix is fixed in the script and runs in this order:

| downstream client | expected upstream channel | client used in live mode |
| --- | --- | --- |
| chat | chat, responses, messages | `openai` Chat Completions |
| responses | chat, responses, messages | `openai` Responses |
| messages | chat, responses, messages | `@anthropic-ai/sdk` Messages |

Every row has four cases: one ordinary JSON call, one text SSE call, one JSON
tool round trip and one SSE tool round trip. A tool round trip has at most two
remote calls: the initial tool request and one follow-up carrying the returned
tool call plus the fixed result `q07-result`. The test input is a fixed short
probe; the script never prints it or the model output. The gateway's channel
mapping determines the actual upstream protocol; the expected protocol in the
report is the matrix label and must be checked against the deployed routing
configuration.

The default hard limits are 54 remote calls (nine rows × six calls), 128 output
tokens per call, and a 30-second per-call timeout. `--max-requests` may lower
the call cap and `--max-output-tokens` may lower the output cap; values above
54 and 512 respectively are refused. The runner sets `maxRetries: 0` on both
official SDK clients and does not retry a failed call itself.

## SDK isolation and exact versions

The application does not depend on either provider SDK. For a live run, create
an isolated directory and install the exact versions selected for the evidence
record. Do not install these packages globally and do not add them to the
application workspace just for this check. For example:

```powershell
New-Item -ItemType Directory -Force .q07-sdk | Out-Null
& pnpm --dir .q07-sdk init
& pnpm --dir .q07-sdk add openai@<OPENAI_VERSION> @anthropic-ai/sdk@<ANTHROPIC_VERSION>
```

`<OPENAI_VERSION>` and `<ANTHROPIC_VERSION>` are deliberate placeholders: the
operator must choose and record the published versions actually installed on
the test date. The verifier reads each package's local `package.json`, loads
only from `--sdk-dir`, and refuses a live run unless the installed version is
exactly equal to the corresponding `--openai-sdk-version` or
`--anthropic-sdk-version` argument. The dry-run report says `not_checked`; it
does not imply that an SDK is installed or compatible.

The checked-in toolchain currently has no `openai` or `@anthropic-ai/sdk`
dependency. The isolated directory is therefore a required external input for
live mode. The verifier never runs an installer and never falls back to a
globally resolvable package.

## Credentials and gateway

Live mode reads only these environment variables:

```powershell
$env:Q07_GATEWAY_URL = 'https://gateway.example/v1'
$env:Q07_PLATFORM_API_KEY = '...'
```

The URL must be an absolute credential-free HTTPS URL ending in `/v1`. An HTTP
URL is accepted only for `localhost`, `127.0.0.1`, or `[::1]` local testing.
The platform key is supplied to the SDK client and is never printed, persisted,
included in a failure, or placed in a report. Upstream provider keys remain in
the gateway's channel configuration; this verifier does not read or export
them. The gateway must already have the nine routes and model mappings under
test. The model flags below are public model identifiers used in downstream
requests, not provider credentials.

## Budget and stop policy

Live mode requires an explicit USD budget and two local price inputs:

```powershell
& node scripts/verify-upstream-matrix.ts --live `
  --sdk-dir .q07-sdk `
  --openai-sdk-version <OPENAI_VERSION> `
  --anthropic-sdk-version <ANTHROPIC_VERSION> `
  --chat-model <PUBLIC_CHAT_MODEL> `
  --responses-model <PUBLIC_RESPONSES_MODEL> `
  --messages-model <PUBLIC_MESSAGES_MODEL> `
  --budget-usd 0.25 `
  --input-price-usd-per-1m <INPUT_PRICE> `
  --output-price-usd-per-1m <OUTPUT_PRICE>
```

Prices are local estimation inputs only. They must correspond to the supplier
and model pricing record used for the run; the verifier cannot control supplier
billing, discounts, minimum charges, cache pricing, or other fees that the
provider does not expose in usage. The report estimates cost from observed
input/output token counts and the supplied rates. It never presents that
estimate as an invoice or a guarantee.

After every completed case the runner adds the observed estimate. It stops
before the next call when the hard request cap is reached, when the estimate
exceeds the USD budget, or when either usage or the local cost estimate is
unknown. Missing usage is not converted to zero. Cases after a stop are marked
`skipped` with a safe reason. A provider error records only a safe status/code
and optional HTTP status; provider messages, response bodies, prompts, tool
arguments and headers are discarded.

## Commands and reports

Inspect the interface without reading environment variables:

```powershell
& node scripts/verify-upstream-matrix.ts --help
```

Generate the complete zero-call plan:

```powershell
& node scripts/verify-upstream-matrix.ts
```

Exercise local selection/report logic without a network call or SDK:

```powershell
& node scripts/verify-upstream-matrix.ts --mock --max-requests 12 --max-output-tokens 64
```

Node.js **24.19.0** is required by this repository. When running the TypeScript
script directly, use the repository's Node runtime with type stripping as in
the local checks:

```powershell
& 'C:/Users/a4871/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --experimental-strip-types scripts/verify-upstream-matrix.ts --help
```

The JSON report contains the mode, selected limits, SDK package/version status,
model matrix, per-case status, call counts, observed usage and a local cost
estimate. `mode: mock` includes `syntheticUsage: true`; it must not be copied to
`docs/evidence/live/` as a real-provider result. A live report is only one
input to the `LIVE-*` evidence files and must be accompanied by the exact SDK
versions, model/provider mapping, test date, pricing source, configured
budget, and any skipped or failed cases.

## Acceptance boundary

Q07 prepares and bounds the real-client run. It does not make this repository
claim that a supplier was reached. `LIVE-CC` through `LIVE-MM` remain post-
acceptance tasks requiring the operator's chosen SDK versions, real upstream,
model/channel mapping, usage records and billing evidence. The current local
dry-run/mock checks do not validate supplier behavior, network TLS, provider
pricing, cancellation, email delivery, or Cloudflare deployment state.

