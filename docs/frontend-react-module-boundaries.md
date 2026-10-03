# cheapai React module boundaries

The React application lives in `apps/web/src` as the active `@cheapai/web` workspace. The former Vue application is archived outside the workspace at `/workspace/cheapai-legacy-archive/react-cutover/apps-web`. React modules follow one dependency direction: application composition selects pages, pages compose features, features own domain behavior, and shared modules provide stable cross-feature building blocks.

```text
app   ──► pages, features, shared, workspace packages
pages ──► pages, features, shared, workspace packages
features ──► own feature internals, other feature public APIs, shared, workspace packages
shared ──► shared, workspace packages, external dependencies
```

`app` owns routing, providers, navigation, layouts, and identity guards. It may import page modules to construct routes. Features and pages do not import application composition.

`pages` own route-level composition and URL state. They may import the feature modules they need and reuse another page module when route composition calls for it. Common page shells belong in `app/layouts` or `shared/patterns`.

`features/<name>` owns the API adapter, domain state, hooks, and components for one business area. Code inside a feature may use its own modules directly. Cross-feature imports must target the other feature's `public.ts`; feature code must not reach into another feature's private `api/`, `model/`, `hooks/`, or `components/` files.

`shared/ui` contains domain-neutral controls. `shared/patterns` contains reusable page, table, asynchronous-state, and detail layouts. `shared/lib` contains pure helpers. Shared modules cannot import from `app`, `pages`, or `features`, and must not acquire business-specific behavior. The single composition-root exception is `shared/api/runtime.ts`, which constructs the framework-neutral API/session/query runtime and may import the session controller; other shared files stay independent.

Browser code imports service contracts from `@cheapai/contracts/<domain>` and requests from `@cheapai/api-client/<domain>`. It does not import Worker source files, the archived Vue app, or another package's source tree. Query keys and feature APIs remain owned by their feature; React components receive operations and state through the feature's documented entry points.

`apps/web/eslint.config.js` applies the React Hooks recommended rules, TypeScript's recommended rules, and a local import-boundary rule to application source. Relative imports that escape `src` are rejected, so workspace packages must be consumed through their declared exports. The rule rejects imports from `shared` into `app`, `pages`, or `features` except for `shared/api/runtime.ts`; imports from `pages` or `features` into `app`; and private imports across feature boundaries. It does not prohibit pages from importing feature internals or other pages. A separate restricted-import rule blocks Worker source imports and imports from the archived Vue workspace package.
