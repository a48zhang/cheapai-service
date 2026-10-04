# cheapai PR #5 preview visual check (V-06)

**Result: unauthenticated visual checks passed with one low-priority UI issue; authenticated pages remain blocked on the test account.** Target: `https://sub2api-13556ffb8b-pr-5.alphazhang689.workers.dev`, deployment SHA `a68dc9d30c4c2a343ec62e3590548c9f05e08ccd`, run `qa-pr5-20261004`. Local checkout HEAD matches the deployed SHA. Checked 2026-10-04 UTC.

## Browser and safety

Used `/usr/bin/chromium` with Playwright, the inherited HTTPS proxy, and TLS verification enabled. The first launch under the default filesystem sandbox could not read Chromium's existing NSS trust database (`ERR_CERT_AUTHORITY_INVALID`). The coordinator confirmed this was the sandbox's read-only view (`W_OK EROFS`), not a missing CA. Re-running the browser command with the coordinator-approved filesystem permission could read the existing database and loaded the preview successfully. No certificate database, `HOME`, or TLS settings were changed.

The anonymous script blocks every request method other than `GET`, `HEAD`, and `OPTIONS`. It recorded no blocked writes and no page errors. No login credentials were used, registration was not submitted, no cookies or storage state were saved, and there were no remote writes or model calls. The login button was clicked only with blank fields; client validation displayed errors before any network request.

## Coverage and result

Real preview screenshots were captured at desktop `1440×1000`, tablet `768×1024`, and mobile `390×844`. For every size, screenshots cover the login page, blank-login validation state, registration-closed page, protected-route redirect, and client-side not-found page. Files are in `/tmp/cheapai-preview-run/visual/`, mode `0600`; the directory is mode `0700`. Screenshots contain blank form fields and no passwords, cookies, tokens, or one-time secrets.

- **Login and brand:** The page shows the `cheapai` wordmark and welcome copy at all sizes. Email and password have visible, associated labels and expected autocomplete values. Keyboard order is brand link → email → password → login button → create-account link. Tab focus is visible on each step.
- **Client validation:** Submitting the empty login form shows the linked field alerts `请输入有效邮箱` and `请输入密码`. No login request was sent.
- **Registration:** `GET /api/v1/settings/public` returned `200`; the real preview reports registration closed. The page displays `当前已关闭注册。` at all sizes, so registration fields and registration validation were unavailable and no registration request was sent. The page's footer login link successfully navigates back to `/login`.
- **Protected route:** Anonymous `GET /api/v1/auth/me` returned the expected `401`. Direct navigation to `/admin/channels?case=v06` redirected to `/login` and preserved the exact `returnTo=/admin/channels?case=v06` value.
- **Not found:** A nonexistent client route displays the `cheapai · 404` page with a return-home link.
- **Responsive layout:** No horizontal overflow was found on any captured page. `documentElement` and `body` widths matched their viewport widths: `1440`, `768`, and `390` pixels.

The login and registration shell routes returned `200`; the public registration settings request returned `200`; anonymous session checks returned `401`. No persistent loading state or service error appeared. No artificial delay or mocked response was used.

## Visual issue

The closed-registration screen shows two links to login: an unstyled `返回登录` link inside the closed-state message and a second purple `登录` link in the page footer. This is a minor duplicate-navigation inconsistency, visible on desktop, tablet, and mobile. The closed-state link is in `apps/web/src/features/session/RegisterForm.tsx:23`; the always-rendered footer is in `apps/web/src/pages/auth/RegisterPage.tsx:6`. Suggested fix: keep one login action in the closed state, or make the shared footer conditional so the two prompts do not appear together. No product files were changed during validation.

## Remaining blocker and evidence

Dashboard, keys, requests, billing, chat, and management pages were not visited because the remote test accounts are not ready. The gated script `/tmp/cheapai-preview-run/visual/pending-auth-pages.js` is prepared for later; it refuses to run unless the manifest has `credentialsStatus: ready` and the coordinator authorization flag is set. It reads only the admin record from the protected account file, permits only the login POST, blocks other writes, masks tables and form controls in screenshots, and does not save session state.

The 15 anonymous screenshots are `login-{desktop,tablet,mobile}.png`, `login-validation-{desktop,tablet,mobile}.png`, `register-{desktop,tablet,mobile}.png`, `protected-admin-{desktop,tablet,mobile}.png`, and `not-found-{desktop,tablet,mobile}.png` in `/tmp/cheapai-preview-run/visual/`. The sanitized metrics and route statuses are in `unauthenticated-evidence.json`. The coordinator can select and sanitize these screenshots for attachment.
