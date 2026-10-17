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
The failing Cloudflare Workers Builds branch trigger was removed on 2026-10-17.
Automatic previews are disabled pending maintainer reconfiguration. GitHub Actions
checks and desktop builds remain enabled. Repository workflows do not manage
Cloudflare's Dashboard build triggers. See [PR previews](pr-previews.md).
