# cheapai PR #5 preview visual check (V-06)

**Result: the public and authenticated visual matrices completed against the current preview.** No horizontal overflow, legacy `sub2api` branding, or browser page errors appeared. The closed-registration page now shows a single login link. The registration-settings page displays the expected preview mail-service guard described below.

Target: `https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev`; deployment and local checkout SHA `a3f7bdaab508253d10099c15f2215699ab3b3344`; run `qa-pr5-20261004`; checked 2026-10-04 01:50 UTC.

## Browser and safety

Playwright was loaded through the repository `package.json`; Chromium ran from `/usr/bin/chromium` with `--no-sandbox`, the inherited HTTPS proxy, the existing CA/NSS trust, and TLS verification enabled. The coordinator-authorized browser command could read Chromium's existing NSS database. No `HOME`, trust database, CA, proxy, or TLS settings were changed.

The full matrix used one ephemeral admin session. The coordinator-requested screenshot review used a second ephemeral session. Each session sent one same-origin `POST /api/v1/auth/login`, returned `200`, and destroyed its browser context afterward. The browser route blocked every other non-read request; no blocked writes occurred and no logout was needed. No storage state, cookies, credentials, table values, or one-time secrets were saved to the repository. The credential reader selected only the admin record from the `0600` file.

The 42 full-matrix screenshots mask whole tables and form controls. The six review screenshots mask emails, sensitive-marked/code elements, and table body cells while leaving the empty chat composer and the empty channels table headers visible. Screenshot folders are mode `0700`; evidence and PNG files are mode `0600`. Raw artifacts remain under `/tmp/cheapai-preview-run/visual/`.

## Coverage and results

The browser captured 14 routes at desktop `1440×1000`, tablet `768×1024`, and mobile `390×844`: chat (`/`), dashboard, keys, personal requests, personal billing, and admin channels, models, groups, users, requests, billing, audit, registration settings, and registration codes. Before capture, each route rendered its main heading without a pending loading status; the browser waited for network idle where available. All 42 document navigations returned `200`, matched their requested route, and had no horizontal overflow. Authenticated session and page API reads returned `200`; the pre-login session probe returned the expected `401`, and the login POST returned `200`. There were no browser page errors or blocked writes.

The authenticated state summary was 30 rendered pages, 9 expected empty states, and 3 registration-settings guard states. The guard appeared on desktop, tablet, and mobile: the settings read returned `200`, while the preview reports mail service unavailable and explains that an email-verification policy cannot be saved. This is an existing preview configuration restriction; no global registration settings were changed. The registration-codes page loaded normally.

The logged-in chat page rendered its empty state with no available model group or model. The composer remained visible with its explanatory prompt, and sending was disabled without a model selection; the separate V-03 check confirmed draft editing remains available. No chat was sent and no inference call was made. The dashboard showed no recent requests, and the channels list showed its empty state. These are visual states only; this check does not validate CRUD, billing transactions, or chat inference.

Across the captured controls, the browser recorded accessible names and form labels; the keyboard tab sequence showed visible focus on actionable controls. The mobile console header hides the wordmark in its compact layout, while the app document title remains `cheapai`; the chat mobile view shows the wordmark. No `sub2api` text was visible on the checked product pages.

The public matrix was also rerun against this deployment at all three sizes. The login page exposed labeled email and password fields with the expected autocomplete values; Tab moved through the brand link, email, password, login button, and create-account link with visible focus. Submitting blank fields showed `请输入有效邮箱` and `请输入密码` without sending a login request. Registration settings returned `200`, and the closed-registration page showed one “登录” link that returned to `/login`, confirming the duplicate link from the earlier deployment is gone. Anonymous `GET /api/v1/auth/me` returned the expected `401`; direct navigation to `/admin/channels?case=v06` redirected to login and preserved that exact `returnTo` value. The not-found route rendered the `cheapai` page. These screenshots and sanitized metrics are in `/tmp/cheapai-preview-run/visual/`; the summary is `unauthenticated-evidence.json`.

## Review screenshots

The coordinator copied the six reviewed screenshots to repository assets:

| Page | Desktop | Mobile |
| --- | --- | --- |
| Chat | [desktop](assets/cheapai-preview-chat-desktop.png) | [mobile](assets/cheapai-preview-chat-mobile.png) |
| Dashboard | [desktop](assets/cheapai-preview-dashboard-desktop.png) | [mobile](assets/cheapai-preview-dashboard-mobile.png) |
| Admin channels | [desktop](assets/cheapai-preview-admin-channels-desktop.png) | [mobile](assets/cheapai-preview-admin-channels-mobile.png) |

The complete authenticated matrix, including tablet screenshots and sanitized route/API metrics, is in `/tmp/cheapai-preview-run/visual/auth/`. The six pre-copy review screenshots and their evidence are in `/tmp/cheapai-preview-run/visual/auth-review/`. Screenshots document the visual state only; passing this module does not establish that business writes or end-to-end workflows passed.
