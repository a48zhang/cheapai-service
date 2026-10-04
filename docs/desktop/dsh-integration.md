# DeepSeek Harness integration pin

## Source and versions

This note is based on the immutable upstream release ref [`dsh-v0.2.1-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc), which resolves directly to commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. The published CLI package at this revision is `@deepseek-ai/dsh@0.2.1-alpha.1`, with the executable mapping `dsh` to `lib/bin.js`. The release is a prerelease, and the README calls the project a developer preview with breaking changes expected. Treat every internal DSH seam below as tied to this commit.

The upstream root `package.json` declares pnpm `11.7.0` and Node `^22.19.0 || >=24.0.0`. This repository's Node `24.19.0` pin satisfies that range and is the comparison baseline. Bun `1.4.2` is pinned as a comparison candidate only. DSH does not declare Bun support, and this task did not launch DSH or measure Bun compatibility. The Tauri, Rust, React, and target pins are recorded in [`runtime-versions.json`](../../scripts/desktop/runtime-versions.json); Tauri is a separate shell choice because upstream Desktop is Electron based.

## Launcher and profile boot

The executable source is [`apps/cli/src/bin.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/src/bin.ts). It exports `runCli(options: RunCliOptions = {}): Promise<void>` and dispatches the `profile` mode to `runProfile`. Argument parsing is in [`apps/cli/src/args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/src/args.ts): `parseDshArgs(argv: readonly string[], version: string, manageDesktopProfile = false): DshInvocation`. `dsh <name>` is shorthand for `dsh --profile <name>`. The launcher owns `--profile`, repeatable `--patch`, and `--from-default-profile`; after its flags, remaining arguments are passed to the profile's app plugins. Thus an app option such as `--no-open` belongs after the profile options.

Profile composition and lifecycle are implemented in [`apps/cli/src/profile-boot.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/src/profile-boot.ts):

```ts
runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }>
```

`RunProfileOptions` carries the environment snapshot, profile name, optional application-owned resolved profile, `patchFiles`, inner `args`, and optional package-manager service. Profiles live under `$DSH_HOME/profiles`; the launcher loads bundle patches, the profile patch, home-level patch, and command-line overlays. The returned context and shutdown controller are a source-level API. The process CLI has no documented machine-readable ready frame; the internal `AppReady` service in `profile-boot.ts` is committed after boot/host setup and should not be mistaken for an external protocol.

For the planned Tauri shell, keep a private DSH home and use a named profile plus source-controlled profile patch. Do not rely on the reserved `desktop` profile: `args.ts` rejects it for the public CLI because the upstream Electron application owns it. Exact profile bundle IDs and configuration schemas are DSH-managed and must be read from the pinned source whenever the profile is authored.

## Sessions, message streams, and tool interaction

The session service is [`packages/api/session-controller/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/index.ts). `SessionController` extends `TypertRemoteService` in namespace `session`. Its relevant typed operations include `create(request)`, `prompt(request, signal): Promise<SessionPromptValue>`, `page(request, signal): Promise<SessionPage>`, `follow(request, signal): AsyncIterable<SessionFollowFrame>`, and `control(signal): AsyncIterable<SessionControlFrame>`, with `cancel(request)` and `updateQueue(request)` for active work. Use these DSH operations rather than making a second agent loop or treating prompts as direct model-gateway calls.

The session client transport lives in [`packages/api/session-controller/src/client/transport.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/client/transport.ts); it defines `SessionEventStream` and `createSessionControlStream`. Assistant stream revisions and durable cursors are accumulated by `SessionAssistantStreamAccumulator.accept(frame, durableCursor)` and exposed by `snapshot()` in [`assistant-stream.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/assistant-stream.ts). Tool progress and user-facing control messages are DSH session/control events. The shell must preserve those interactions and route responses through DSH's control/event services; do not invent a parallel approval policy.

At the gateway layer, [`packages/api/gateway/src/stream-protocol.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/gateway/src/stream-protocol.ts) declares `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`, `REMOTE_EVENT_STREAM_ENDPOINT = '$events'`, and `REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'`. These are DSH transport implementation details, not a standalone stable REST API. Prefer the pinned DSH typed client/service surface over implementing the mux protocol independently.

## Persistence and static resources

Session events and their logical types are defined under [`packages/core/session/src`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src). The JSONL persistence plugin is `packages/session/session-persistence-jsonl`; its README documents per-project session directories and versioned `session.vN.jsonl` files, with compressed Zstandard files as the default. `SESSION_FORMAT_VERSION` and the physical file generation are separate version markers. Event schemas, migrations, encoding, and storage paths are internal DSH formats; let the DSH plugin own them. The persistence implementation uses Node's built-in Zstandard API, so it is one concrete runtime-sensitive area for Bun.

The upstream web client entry is [`apps/web/index.html`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/web/index.html), mounted by `apps/web/src/main.ts`. The static host plugin is `@deepseek-ai/dsh-host-frontend-static`; its `serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex): Promise<void>` function is in [`packages/host/frontend-static/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/host/frontend-static/src/index.ts) and is injected with the DSH `webServer` and `connection` services. This serves DSH's own frontend. The Tauri app should package its own Vite output and consume DSH session services without mounting the DSH page or iframe.

## Stable versus version-maintained seams

| Seam | Evidence and status | Integration rule |
| --- | --- | --- |
| Published package name/version, `dsh` executable, Node engine | `apps/cli/package.json` and root `package.json` at the pinned commit | Pin the package and source revision together. |
| `runCli`, profile flags, profile composition, `RunProfileOptions` | `apps/cli/src/bin.ts`, `args.ts`, and `profile-boot.ts`; profile boot subpath is exported by the CLI package | Publicly exported at this revision, but profile option and bundle semantics follow DSH releases. |
| Session CRUD, prompts, pages, follow/control streams | `SessionController`, client transport, and gateway packages | Typed internal DSH APIs; compile and adapt with the pinned version. They are not generic HTTP endpoints. |
| Event frames, tool/user-control payloads, JSONL layout and migration | `packages/api/session-controller`, `packages/core/session`, and `packages/session/session-persistence-jsonl` | Version-maintained. Keep DSH as owner; do not persist or replay an independently invented format. |
| DSH web static resources and official Desktop packaging | `apps/web`, `packages/host/frontend-static`, `apps/desktop`, and `apps/desktop-host` | DSH's official app is Electron + bundled Node. Reuse service seams, not the official page or Electron host. |

Upstream package metadata includes native modules such as `node-pty`, `koffi`, and `fs-ext`; compatibility of one Node-API addon does not establish compatibility of this complete dependency set. Node remains the reference runtime. Bun remains unverified until the centralized runtime validation task exercises the exact profile, architecture, persistence path, and native dependency closure recorded here. No DSH process, test, build, or compatibility experiment was run for F01.
