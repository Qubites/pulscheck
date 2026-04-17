#!/usr/bin/env node
/**
 * PulsCheck CLI — Static race condition scanner for CI pipelines.
 *
 * Commands:
 *   pulscheck scan [dir]     — Scan source files for race condition patterns
 *   pulscheck ci [dir]       — CI mode: scan + SARIF output + exit code on findings
 *
 * Options:
 *   --format json|sarif|text   Output format (default: text, ci default: sarif)
 *   --out <file>               Write output to file (default: stdout)
 *   --severity <level>         Minimum severity to report: info|warning|critical (default: warning)
 *   --fail-on <level>          Exit 1 if findings at this severity: info|warning|critical (default: critical)
 *   --ignore <pattern>         Glob pattern to ignore (repeatable)
 *   --quiet                    Suppress progress output
 *
 * What this scans: `fetch()` calls inside React `useEffect`/`useLayoutEffect`/
 * `useInsertionEffect` bodies that aren't wired up to an AbortController. That
 * is the one static rule we still ship here; the timer and event-listener
 * siblings live in `@eslint-react/eslint-plugin` and we don't duplicate them.
 */

import * as fs from "fs";
import * as path from "path";
import { VERSION } from "./version";
import { scanSourceAst } from "./ast-scanner";

// ─── File scanner ───────────────────────────────────────────────────

interface ScanMatch {
  rule: string;
  risk: string;
  severity: "critical" | "warning" | "info";
  detector: string;
  fix: string;
  file: string;
  line: number;
  code: string;
}

/** SARIF rule catalog — one entry per rule the AST scanner can emit.
 *  Kept in sync with ast-scanner.ts's DANGER_RULES by hand; the list is
 *  small enough that a build-time coupling isn't worth it. */
const SARIF_RULES = [
  {
    id: "fetch-no-abort-in-effect",
    risk: "fetch() inside useEffect without AbortController — response may arrive after unmount",
    severity: "critical" as const,
    fix: "Use AbortController: const ctrl = new AbortController(); fetch(url, { signal: ctrl.signal }); return () => ctrl.abort();",
  },
];

function scanFile(filePath: string, rootDir: string): ScanMatch[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const matches: ScanMatch[] = [];
  const relPath = path.relative(rootDir, filePath) || path.basename(filePath);

  // AST pass — authoritative for useEffect cleanup bugs. Handles nested
  // closures and cleanup-awareness, which regex cannot.
  try {
    const astFindings = scanSourceAst(filePath, content);
    for (const f of astFindings) {
      matches.push({
        rule: f.rule,
        risk: f.risk,
        severity: f.severity,
        detector: f.detector,
        fix: f.fix,
        file: relPath,
        line: f.line,
        code: f.code,
      });
    }
  } catch {
    /* AST parse failure — skip this file silently. */
  }

  return matches;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  "cache",
  ".parcel-cache",
  ".turbo",
  ".vercel",
  ".svelte-kit",
  ".astro",
  "coverage",
  "__tests__",
  "__mocks__",
]);

function walkDir(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    // Skip nested git repos — they're separate projects (e.g., submodules
    // or cloned sandboxes) whose findings usually aren't actionable here.
    if (d !== dir && fs.existsSync(path.join(d, ".git"))) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(d, entry.name));
      else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) files.push(path.join(d, entry.name));
    }
  }
  walk(dir);
  return files;
}

// ─── Output formatters ──────────────────────────────────────────────

function formatText(matches: ScanMatch[], dir: string, ms: number): string {
  if (matches.length === 0) return `\nPulsCheck: No race condition patterns found in ${dir}\n`;

  const bySev = { critical: 0, warning: 0, info: 0 };
  for (const m of matches) bySev[m.severity]++;

  const lines: string[] = [];
  lines.push("");
  lines.push(`PulsCheck Scan: ${dir}`);
  lines.push(`${"=".repeat(60)}`);
  lines.push(`Found ${matches.length} patterns (${bySev.critical} critical, ${bySev.warning} warning, ${bySev.info} info) in ${ms.toFixed(0)}ms`);
  lines.push("");

  // Group by file
  const byFile = new Map<string, ScanMatch[]>();
  for (const m of matches) {
    const arr = byFile.get(m.file) ?? [];
    arr.push(m);
    byFile.set(m.file, arr);
  }

  for (const [file, fileMatches] of byFile) {
    lines.push(`${file} (${fileMatches.length} findings)`);
    for (const m of fileMatches) {
      const icon = m.severity === "critical" ? "!!" : m.severity === "warning" ? " !" : "  ";
      lines.push(`  ${icon} L${m.line} [${m.severity}] ${m.rule}`);
      lines.push(`     ${m.risk}`);
      lines.push(`     Fix: ${m.fix}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatJSON(matches: ScanMatch[], dir: string, ms: number): string {
  return JSON.stringify({
    tool: "pulscheck",
    version: VERSION,
    scanned: dir,
    timestamp: new Date().toISOString(),
    scanMs: Math.round(ms),
    summary: {
      total: matches.length,
      critical: matches.filter((m) => m.severity === "critical").length,
      warning: matches.filter((m) => m.severity === "warning").length,
      info: matches.filter((m) => m.severity === "info").length,
    },
    findings: matches,
  }, null, 2);
}

function formatSARIF(matches: ScanMatch[], dir: string): string {
  return JSON.stringify({
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "pulscheck",
          version: VERSION,
          informationUri: "https://github.com/Qubites/pulscheck",
          rules: SARIF_RULES.map((p) => ({
            id: p.id,
            shortDescription: { text: p.risk },
            defaultConfiguration: {
              level: p.severity === "critical" ? "error" : p.severity === "warning" ? "warning" : "note",
            },
            help: { text: p.fix },
          })),
        },
      },
      results: matches.map((m) => ({
        ruleId: m.rule,
        level: m.severity === "critical" ? "error" : m.severity === "warning" ? "warning" : "note",
        message: { text: `${m.risk}\nFix: ${m.fix}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: m.file, uriBaseId: "%SRCROOT%" },
            region: { startLine: m.line },
          },
        }],
      })),
    }],
  }, null, 2);
}

// ─── CLI parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts: Record<string, string | string[]> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") opts.format = args[++i];
    else if (args[i] === "--out") opts.out = args[++i];
    else if (args[i] === "--severity") opts.severity = args[++i];
    else if (args[i] === "--fail-on") opts.failOn = args[++i];
    else if (args[i] === "--ignore") {
      const ignores = (opts.ignore as string[] | undefined) ?? [];
      ignores.push(args[++i]);
      opts.ignore = ignores;
    }
    else if (args[i] === "--quiet") opts.quiet = "true";
    else if (args[i] === "--version" || args[i] === "-v") opts.version = "true";
    else if (!args[i].startsWith("--")) positional.push(args[i]);
  }

  return { positional, opts };
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  const { positional, opts } = parseArgs(process.argv);
  const command = positional[0] ?? "scan";
  const dir = path.resolve(positional[1] ?? ".");
  const quiet = opts.quiet === "true";

  if (opts.version === "true" || command === "--version" || command === "-v") {
    console.log(`pulscheck ${VERSION}`);
    return;
  }

  if (command === "help" || command === "--help") {
    console.log(`
PulsCheck CLI v${VERSION} — Static race condition scanner

Usage:
  pulscheck scan [dir]       Scan for race condition patterns
  pulscheck ci [dir]         CI mode: scan + SARIF + exit code
  pulscheck help             Show this help

Options:
  --format json|sarif|text   Output format
  --out <file>               Write to file
  --severity info|warning|critical   Min severity (default: warning)
  --fail-on info|warning|critical    Fail threshold (default: critical)
  --quiet                    No progress output
`);
    return;
  }

  if (!fs.existsSync(dir)) {
    console.error(`Path not found: ${dir}`);
    process.exit(1);
  }

  // Defaults per command
  const isCi = command === "ci";
  const format = (opts.format as string) ?? (isCi ? "sarif" : "text");
  const minSeverity = (opts.severity as string) ?? "warning";
  const failOn = (opts.failOn as string) ?? "critical";
  const outFile = opts.out as string | undefined;

  if (!quiet) {
    console.error(`PulsCheck v${VERSION} scanning ${dir}...`);
  }

  const start = performance.now();

  // Support both file and directory targets. Single-file mode is cheap
  // and lets editor/hook integrations scan just the edited file.
  const stat = fs.statSync(dir);
  let files: string[];
  let rootDir: string;
  if (stat.isFile()) {
    files = /\.(tsx?|jsx?)$/.test(dir) ? [dir] : [];
    rootDir = path.dirname(dir);
  } else {
    files = walkDir(dir);
    rootDir = dir;
  }

  let matches: ScanMatch[] = [];
  for (const file of files) {
    try {
      matches.push(...scanFile(file, rootDir));
    } catch (_) {}
  }

  const ms = performance.now() - start;

  // Apply ignore patterns
  if (opts.ignore) {
    const ignores = Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore];
    matches = matches.filter((m) => !ignores.some((ig) => m.file.includes(ig)));
  }

  // Apply severity filter
  const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const minOrder = sevOrder[minSeverity] ?? 1;
  matches = matches.filter((m) => sevOrder[m.severity] <= minOrder);

  // Sort: critical first, then by file
  matches.sort((a, b) => {
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  // Format output
  let output: string;
  if (format === "json") output = formatJSON(matches, dir, ms);
  else if (format === "sarif") output = formatSARIF(matches, dir);
  else output = formatText(matches, dir, ms);

  // Write output
  if (outFile) {
    fs.writeFileSync(outFile, output);
    if (!quiet) console.error(`Output written to ${outFile}`);
  } else {
    console.log(output);
  }

  if (!quiet) {
    console.error(`Scanned ${files.length} files in ${ms.toFixed(0)}ms`);
  }

  // Exit code for CI
  const failOrder = sevOrder[failOn] ?? 0;
  const shouldFail = matches.some((m) => sevOrder[m.severity] <= failOrder);
  if (isCi && shouldFail) {
    if (!quiet) console.error(`Failing: found findings at ${failOn} severity or above`);
    process.exit(1);
  }
}

main();
