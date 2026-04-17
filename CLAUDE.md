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
| `npm run test -w pulscheck` | Run the vitest suite (`vitest run`). Fast, Node only. |
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
