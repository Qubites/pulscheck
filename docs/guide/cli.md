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

### `pulscheck report <file>`

Pretty-print a saved JSON or SARIF report:

```bash
npx pulscheck report pulscheck.sarif
```

## Static patterns

The CLI runs 9 source-level detectors. Each one is a regex-based rule mapped to one of the runtime detection patterns, with a concrete fix suggestion.

| Rule | Severity | Maps to | What it catches |
|------|----------|---------|-----------------|
| `fetch-no-abort-in-effect` | critical | after-teardown | `fetch()` inside `useEffect` without `AbortController` |
| `setInterval-no-cleanup` | warning | after-teardown | `setInterval` with no `clearInterval` in cleanup |
| `setTimeout-in-effect-no-clear` | warning | after-teardown | `setTimeout` inside `useEffect` with no `clearTimeout` |
| `state-update-in-then` | warning | after-teardown | `setState` inside `.then()` — may update unmounted component |
| `async-onclick-no-guard` | warning | double-trigger | Async `onClick` without a loading guard — rapid clicks race |
| `concurrent-useQuery-same-table` | info | double-trigger | Multiple `useQuery` hooks on the same key |
| `supabase-concurrent-queries` | info | double-trigger | Concurrent Supabase queries to the same table |
| `websocket-no-reconnect-handler` | info | sequence-gap | `new WebSocket()` — ordering gaps possible on reconnect |
| `promise-race-no-cancel` | info | stale-overwrite | `Promise.race` without cancelling losing promises |

Each finding includes the file, line, matched code, severity, and a fix string.

## GitHub Action

A prebuilt Action is available in the `action/` directory of this repo. Wire it into your workflow:

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
      - uses: Qubites/pulscheck/action@main
        with:
          path: src/
          severity: warning
          fail-on: critical
```

Inputs:

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `src/` | Directory to scan |
| `severity` | `warning` | Minimum severity to report |
| `fail-on` | `critical` | Severity threshold for non-zero exit |
| `format` | `sarif` | Output format |

SARIF uploads to GitHub code scanning automatically via `github/codeql-action/upload-sarif`:

```yaml
      - uses: Qubites/pulscheck/action@main
        with:
          path: src/
          out: pulscheck.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: pulscheck.sarif
```

## Static vs runtime — when to use which

The static CLI catches patterns **before** they ship. The runtime detector (`devMode()`) catches bugs **as they happen** and has access to real timing, real call graphs, and real data. Use both:

| Layer | Strengths | Blind spots |
|-------|-----------|-------------|
| Static (CLI) | Fast, runs in CI, no runtime needed | Can't see async timing, can't see dynamic data |
| Runtime (`devMode`) | Real traces, real bugs, structured findings | Only finds what you actually execute |

Treat the CLI as the first wall of defense and `devMode()` as the one that catches everything the first wall missed.
