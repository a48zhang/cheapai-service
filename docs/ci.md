# CI build scope

`Local checks` runs for pull requests, pushes to `main`, and manual dispatches.
Feature-branch pushes do not create a second copy of the PR checks. Each event
checks the latest revision; a push containing several commits does not build each
commit separately. Superseded runs for the same ref are cancelled.

Cloud typechecks, tests, build, lint and browser flows still run on each PR update.
Formatting differences are reported in a separate step with `continue-on-error`;
they do not fail the job or prevent browser checks from running.
Desktop typechecks, builds and appearance checks run only when the desktop scope
changes. The Windows/macOS installer matrix uses the same detector, with a small
Linux detection job before allocating the three native build runners.

The desktop scope includes desktop apps/contracts, the shared theme, desktop
scripts/tests, build configuration and CI detection/workflow changes. For a
`pnpm-lock.yaml` change, the detector compares workspace importers and the complete
dependency graph reachable from the desktop apps/contracts, including linked
workspaces, peer-qualified snapshots, optional dependencies and package metadata.
A Worker-only importer or an unrelated dependency change skips desktop builds.
Global lockfile policy changes still trigger desktop validation. An unsupported
or incomplete dependency graph conservatively runs desktop checks.

PRs compare the head to the merge base with the PR base SHA, so importing main's
changes does not count as a desktop change introduced by that PR. Pushes compare
the event's before/after SHAs. Manual runs and initial branch pushes run desktop
checks. PR comparisons cover the entire proposed change, so a PR that changes
desktop code continues to validate desktop on subsequent revisions.

Run detector regressions with `node --test scripts/ci/desktop-changes.test.mjs`.
Cloudflare native Preview resource overrides are configured in `wrangler.jsonc`.
Enablement and build commands are managed in Workers Builds; see [PR previews](pr-previews.md).
GitHub PR checks do not deploy. Pushes to main use the production release workflow below.


## Production release entrypoint

`pnpm run deploy:ci` is the production CI release command. It builds the cloud
workspaces, applies pending remote D1 migrations to `DB`, deploys the Worker and
its assets, then checks `https://cheapai.dev/healthz` for a successful JSON health
response. Wrangler runs through `@sub2api/worker` with `--config wrangler.jsonc
--env production`; D1 additionally uses `--remote`. Each command must succeed
before the next runs. A failed migration stops publication, and a failed health
check fails the release without an automatic rollback.

[Production release](../.github/workflows/production-release.yml) runs automatically
on pushes to `main`, including merged PRs. It checks out that merged commit,
installs locked dependencies, then calls `pnpm run deploy:ci`. Releases share one
concurrency group and do not cancel an active migration/publication when a newer
commit arrives. PR branch checks do not run remote SQL or deploy.

Set the repository Actions secret `CLOUDFLARE_API_TOKEN` to a token that can migrate
the configured D1 database and deploy the production Worker and its bindings.
The account and resource IDs come from the checked-in production Wrangler config.
The workflow does not require a new environment approval or enable the removed
Cloudflare Builds trigger. The existing `pnpm run deploy` remains a manual
Worker-only publication command and does not apply migrations.

`pnpm run deploy:ci --dry-run` builds and bundles the production Worker locally;
it skips remote migrations, publication and live health requests. It does not
verify remote authorization or the database migration state. Back up the database
and review the incompatible schema window before a real release, especially
migration 0029. See [deployment and failure recovery](deployment.md).
