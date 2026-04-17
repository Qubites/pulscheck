# pulscheck

Runtime race condition detection for frontend apps. Published from `packages/core` as `pulscheck`.

## Repo layout

- `packages/core` — the library (`pulscheck` on npm). Built with `tsup`, tested with `vitest`.
- `docs/` — VitePress site published to pulscheck.qubites.io.
- `temporal-watcher/` — separate nested git repo; not part of this workspace. Ignore unless explicitly asked.

npm workspaces are enabled. `packages/core` is the only workspace; its package name is `pulscheck`, so workspace commands use `-w pulscheck`.

## npm scripts

Always run these from the repo root (`/Users/olivernordsve/Github/pulscheck`).

### Library (`packages/core`)

| Command | What it does |
| --- | --- |
| `npm run test -w pulscheck` | Run the vitest suite (`vitest run`). Fast unit tests, Node only. |
| `npm run typecheck -w pulscheck` | TypeScript typecheck, no emit. |
| `npm run build -w pulscheck` | Build the library with `tsup` into `packages/core/dist`. |

### Docs site (root)

| Command | What it does |
| --- | --- |
| `npm run docs:dev` | VitePress dev server for local docs authoring. |
| `npm run docs:build` | Build the static docs site. |
| `npm run docs:preview` | Preview the built docs site. |

There are currently **no `smoke` or `e2e` scripts**. If you need one, add it to the appropriate `package.json` and update this file in the same change.

## Verification workflow

After editing code in `packages/core`, run in this order and do not report the task complete until all three pass:

1. `npm run typecheck -w pulscheck`
2. `npm run test -w pulscheck`
3. `npm run build -w pulscheck`

For docs-only changes, run `npm run docs:build` instead.

If a script fails, diagnose and fix the root cause — do not skip, comment out, or work around failing checks.

## House rules

- Do not invent scripts. If the command you want doesn't exist in `package.json`, add it there first.
- Do not edit anything inside `temporal-watcher/` — it's a separate project.
- Do not add dependencies without asking.

## Tests must reflect reality, not the implementation

Any code that interacts with a real runtime environment (browser DOM, network, WebSocket, OS primitives, a real framework's internals) must be verified against that real environment — not only against hand-built fakes.

Why: fakes shaped to match what the implementation *expects* the environment to look like are self-referential. They pass by construction and hide bugs where the real environment behaves differently from the assumption. A green suite built entirely on such fakes is not evidence the code works; it's evidence the fakes and the code share the same incorrect model.

Rules:

- If the code touches a real runtime, at least one test case must exercise it against the real thing — a real browser for DOM code, a real network for transport code, a real instance of the framework for integration code. Set up the harness if it doesn't exist.
- Fakes and mocks are fine as cheap regression coverage *alongside* the real-environment test. They are not a substitute.
- If real-environment testing needs new tooling (Playwright, jsdom, a docker container, a test server), name it explicitly and ask before adding deps (see rule above). Do not quietly substitute fakes because the real setup is inconvenient.
- Never build a test whose design is "install a fake that matches what the implementation looks for." That proves the implementation is internally consistent, nothing more.
- When a real test fails and a fake test passes, the real test is the source of truth. Fix the implementation; do not adjust the fake to hide the gap.

Concrete example (historical): the since-removed DOM patcher in `packages/core/src/dom.ts` had vitest fakes AND a Playwright cross-browser test. The fakes initially passed while real Chromium/WebKit failed, because those engines don't expose individual CSS properties as prototype descriptors the way the fakes did. That DOM-patching code path was dropped along with the `layout-thrash` detector in the narrow-scope cleanup, but the lesson stands: any future code that touches a real runtime must be verified against that real runtime, not only against fakes.
