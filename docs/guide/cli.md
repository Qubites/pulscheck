# CLI

The PulsCheck CLI runs **static** analysis over your source files to catch race-prone patterns at lint time — before they ever hit the browser. It's designed for CI pipelines and complements the runtime detector you get from `devMode()`.

```bash
npx pulscheck --version
```

## Commands

### `pulscheck scan [dir]`

Scan a directory for race condition patterns. Default output is human-readable text.

```bash
npx pulscheck scan src/
```

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--format <type>` | `text` | `text`, `json`, or `sarif` |
| `--out <file>` | stdout | Write output to a file |
| `--severity <level>` | `warning` | Minimum severity: `info`, `warning`, `critical` |
| `--ignore <glob>` | — | Glob pattern to exclude (repeatable) |
| `--quiet` | — | Suppress progress output |

### `pulscheck ci [dir]`

CI mode — defaults to SARIF output and exits with a non-zero code when findings hit a threshold. Suitable for dropping into a GitHub Actions job.

```bash
npx pulscheck ci src/ --fail-on critical --out pulscheck.sarif
```

Additional flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--fail-on <level>` | `critical` | Exit 1 if findings at or above this severity exist |
| `--format <type>` | `sarif` | Default is SARIF in CI mode |

### `pulscheck help`

Print the usage summary:

```bash
npx pulscheck help
```

## Static rule

The CLI ships a single AST-based rule. It's deliberately narrow — the rules for `setTimeout`, `setInterval`, and `addEventListener` leaks already live in [`@eslint-react/eslint-plugin`](https://www.npmjs.com/package/@eslint-react/eslint-plugin) (`no-leaked-timeout`, `no-leaked-interval`, `no-leaked-event-listener`), and we don't duplicate them.

| Rule | Severity | Maps to | What it catches |
|------|----------|---------|-----------------|
| `fetch-no-abort-in-effect` | critical | after-teardown | `fetch()` inside `useEffect` / `useLayoutEffect` / `useInsertionEffect` without an `AbortController` wired into cleanup |

The rule is cleanup-aware: if the effect's return function calls `ctrl.abort()` on the controller that was passed to `fetch(url, { signal })`, it doesn't flag. It also walks nested closures, so a `fetch` inside a helper called from the effect body is still caught.

Each finding includes the file, line, matched code, severity, and a fix string.

## Use in CI

Drop the binary straight into a GitHub Actions job — no wrapper action is needed:

```yaml
name: PulsCheck

on:
  pull_request:
  push:
    branches: [main]

jobs:
  pulscheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx -y pulscheck ci src/ --fail-on critical --out pulscheck.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: pulscheck.sarif
```

SARIF output uploads cleanly to GitHub code scanning, so findings show up inline on pull requests.

## Static vs runtime — when to use which

The static CLI catches the one pattern it covers **before** code ships. The runtime detector (`devMode()`) catches four patterns **as they happen**, with access to real timing, real call graphs, and real data. Use both — plus an ESLint config with `@eslint-react/eslint-plugin` for the timer/listener rules we don't ship:

| Layer | Strengths | Blind spots |
|-------|-----------|-------------|
| Static (CLI) | Fast, runs in CI, no runtime needed | Only covers `fetch`-in-effect; can't see async timing or dynamic data |
| Runtime (`devMode`) | Real traces, real bugs, structured findings | Only finds what you actually execute |

Treat the CLI as one wall of defence and `devMode()` as the one that catches what the first wall missed.
