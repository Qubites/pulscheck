# Pre-commit hooks

PulsCheck's CLI catches one race-prone pattern — `fetch()` inside React effects without an `AbortController` — before it ever hits the browser. This page shows how to wire it into a git pre-commit hook so the check runs on every commit, including those made by AI coding agents like **Claude Code** and **Codex**.

For the full CLI reference (flags, SARIF output, CI job), see the [CLI page](/guide/cli). For runtime race detection in the browser, see [`devMode()`](/guide/getting-started).

## Why git pre-commit, not an agent-specific hook

Git runs `.git/hooks/pre-commit` regardless of who typed `git commit` — Claude Code, Codex, a human on their laptop, or an automation job. One hook, universal coverage:

| Commit source | How the hook fires |
| --- | --- |
| Claude Code (`git commit` via its Bash tool) | Git runs the hook as part of the commit |
| Codex (`git commit` from its shell) | Git runs the hook as part of the commit |
| Human dev (terminal, IDE git UI) | Git runs the hook as part of the commit |
| CI (backstop) | Runs the CLI directly — see [CI setup](/guide/cli#use-in-ci) |

Agent-specific hooks (like Claude Code's `PostToolUse` in `.claude/settings.json`) can layer on top for a tighter feedback loop, but they're not the right *coverage* layer — they don't help Codex or humans. Git hooks are.

## Install

Use [husky](https://typicode.github.io/husky/) — the standard way to keep git hooks in a JS repo. Hooks get versioned with the code and install automatically on `npm install`.

```bash
npm install -D husky pulscheck
npx husky init
```

`husky init` creates `.husky/pre-commit` with a placeholder. Replace it:

```bash
# .husky/pre-commit
npx pulscheck ci src --format text --fail-on critical --quiet
```

::: tip Use `ci`, not `scan`
`pulscheck scan` always exits 0 — it prints findings but never blocks. Only `pulscheck ci` exits non-zero when the `--fail-on` threshold is hit, which is what makes the commit fail.
:::

That's the whole setup. Commit something with an unaborted `fetch()` in a `useEffect` and the commit is blocked:

```
src/Widget.tsx (1 findings)
  !! L12 [critical] fetch-no-abort-in-effect
     fetch() inside useEffect without AbortController — response may arrive after unmount
     Fix: Use AbortController: const ctrl = new AbortController(); fetch(url, { signal: ctrl.signal }); return () => ctrl.abort();

Failing: found findings at critical severity or above
husky - pre-commit hook exited with code 1 (error)
```

Fix the code, re-stage, commit again.

## Scope — what this actually catches

The CLI ships one rule:

| Rule | Severity | Catches |
| --- | --- | --- |
| `fetch-no-abort-in-effect` | critical | `fetch()` inside `useEffect` / `useLayoutEffect` / `useInsertionEffect` without an `AbortController` wired into cleanup |

It does **not** catch runtime races — stale responses, timers firing after unmount, double-triggered handlers, dangling WebSockets. Those live in the runtime event timeline and only surface when your app actually runs. For those, activate [`devMode()`](/guide/getting-started) during development and watch the console during real sessions.

Think of this hook as one thin layer of static defence. The runtime detector is the thicker one.

## Skipping the hook

Any developer or agent can bypass with `git commit --no-verify`. That's by design — sometimes you need to commit work-in-progress that's mid-fix. But it means a pre-commit hook alone isn't a blocker.

The backstop is CI. Add the [GitHub Actions job from the CLI page](/guide/cli#use-in-ci) so findings show up on every PR regardless of local bypasses. With SARIF upload, findings appear inline on the diff — not just as a failed check.

## Optional: a tighter Claude Code loop

If you use Claude Code, you can also run PulsCheck after every file edit — not just on commit. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx pulscheck ci src --format text --fail-on critical --quiet 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

This fires after any Write or Edit, surfaces findings in the transcript, and doesn't block the edit itself (`|| true`). Claude reads the output and decides whether to fix. Per-file-edit feedback on top of the per-commit check.

**Codex doesn't have an equivalent hook system**, and that's fine: the git pre-commit hook already covers Codex via the normal `git commit` flow. No Codex-specific setup is needed.

## Troubleshooting

**Hook doesn't fire.** Husky installs its hook path via a `prepare` script. Re-run `npm install` in the repo to make sure it's registered. Verify with `git config core.hooksPath` — it should print `.husky`.

**False positive on a known-safe fetch.** The rule walks closures looking for a matching `ctrl.abort()` in the effect's cleanup. If your cleanup is behind an `if` or returned by a helper, it's treated as indeterminate and flagged. Either inline the cleanup, or pass `--ignore 'src/some-file.tsx'` in the hook command.

**Want findings printed but not blocking.** Swap `ci` for `scan` in the hook command — same output, exit code always 0. Useful while you're ramping up.
