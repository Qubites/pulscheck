#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var fs__namespace = /*#__PURE__*/_interopNamespace(fs);
var path__namespace = /*#__PURE__*/_interopNamespace(path);

// src/version.ts
var VERSION = "0.1.0" ;

// src/cli.ts
var PATTERNS = [
  {
    name: "fetch-no-abort-in-effect",
    regex: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{[^}]*fetch\s*\([^}]*\}/gs,
    risk: "fetch() inside useEffect without AbortController \u2014 response may arrive after unmount",
    severity: "critical",
    detector: "after-teardown",
    fix: "Add AbortController: const ctrl = new AbortController(); fetch(url, {signal: ctrl.signal}); return () => ctrl.abort();"
  },
  {
    name: "setInterval-no-cleanup",
    regex: /setInterval\s*\([^)]*\)/g,
    risk: "setInterval without cleanup \u2014 interval leaks on unmount",
    severity: "warning",
    detector: "after-teardown",
    fix: "Store interval ID and clear in useEffect cleanup: return () => clearInterval(id);"
  },
  {
    name: "setTimeout-in-effect-no-clear",
    regex: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{[^}]*setTimeout\s*\([^}]*\}/gs,
    risk: "setTimeout inside useEffect without clearTimeout \u2014 may fire after unmount",
    severity: "warning",
    detector: "after-teardown",
    fix: "Store timeout ID and clear in useEffect cleanup: return () => clearTimeout(id);"
  },
  {
    name: "concurrent-useQuery-same-table",
    regex: /useQuery\s*\(\s*\{[^}]*queryKey\s*:\s*\[[^\]]*\]/g,
    risk: "useQuery hook \u2014 multiple hooks on same page may cause concurrent fetches to same endpoint",
    severity: "info",
    detector: "double-trigger",
    fix: "Consider combining queries or using select() to derive data from a single query."
  },
  {
    name: "async-onclick-no-guard",
    regex: /onClick\s*=\s*\{?\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[^}]*(?:fetch|await)/gs,
    risk: "Async onClick without loading guard \u2014 rapid clicks trigger concurrent operations",
    severity: "warning",
    detector: "double-trigger",
    fix: "Add loading state guard: if (loading) return; setLoading(true); try { ... } finally { setLoading(false); }"
  },
  {
    name: "websocket-no-reconnect-handler",
    regex: /new\s+WebSocket\s*\(/g,
    risk: "WebSocket connection \u2014 message ordering gaps possible on reconnect",
    severity: "info",
    detector: "sequence-gap",
    fix: "Track last received sequence number and request replay of missed messages on reconnect."
  },
  {
    name: "supabase-concurrent-queries",
    regex: /supabase\s*\.\s*from\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*select/g,
    risk: "Supabase query \u2014 concurrent queries to same table may race",
    severity: "info",
    detector: "double-trigger",
    fix: "Combine multiple queries to same table into a single query with .or() or broader select."
  },
  {
    name: "state-update-in-then",
    regex: /\.then\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$]+)\s*=>\s*\{?\s*set[A-Z]\w*\s*\(/g,
    risk: "setState inside .then() \u2014 may update unmounted component",
    severity: "warning",
    detector: "after-teardown",
    fix: "Use async/await with a mounted ref check, or AbortController to cancel the fetch on unmount."
  },
  {
    name: "promise-race-no-cancel",
    regex: /Promise\.race\s*\(\s*\[/g,
    risk: "Promise.race without cancellation \u2014 losing promises still run and may cause side effects",
    severity: "info",
    detector: "stale-overwrite",
    fix: "Cancel losing promises via AbortController or a boolean flag after the race resolves."
  }
];
function scanFile(filePath, rootDir) {
  const content = fs__namespace.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const matches = [];
  const relPath = path__namespace.relative(rootDir, filePath);
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split("\n").length;
      matches.push({
        rule: pattern.name,
        risk: pattern.risk,
        severity: pattern.severity,
        detector: pattern.detector,
        fix: pattern.fix,
        file: relPath,
        line: lineNum,
        code: (lines[lineNum - 1] ?? "").trim().slice(0, 120)
      });
    }
  }
  return matches;
}
function walkDir(dir) {
  const files = [];
  const skip = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", "__tests__", "__mocks__"]);
  function walk(d) {
    for (const entry of fs__namespace.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && !skip.has(entry.name)) walk(path__namespace.join(d, entry.name));
      else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) files.push(path__namespace.join(d, entry.name));
    }
  }
  walk(dir);
  return files;
}
function formatText(matches, dir, ms) {
  if (matches.length === 0) return `
PulsCheck: No race condition patterns found in ${dir}
`;
  const bySev = { critical: 0, warning: 0, info: 0 };
  for (const m of matches) bySev[m.severity]++;
  const lines = [];
  lines.push("");
  lines.push(`PulsCheck Scan: ${dir}`);
  lines.push(`${"=".repeat(60)}`);
  lines.push(`Found ${matches.length} patterns (${bySev.critical} critical, ${bySev.warning} warning, ${bySev.info} info) in ${ms.toFixed(0)}ms`);
  lines.push("");
  const byFile = /* @__PURE__ */ new Map();
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
function formatJSON(matches, dir, ms) {
  return JSON.stringify({
    tool: "pulscheck",
    version: VERSION,
    scanned: dir,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    scanMs: Math.round(ms),
    summary: {
      total: matches.length,
      critical: matches.filter((m) => m.severity === "critical").length,
      warning: matches.filter((m) => m.severity === "warning").length,
      info: matches.filter((m) => m.severity === "info").length
    },
    findings: matches
  }, null, 2);
}
function formatSARIF(matches, dir) {
  return JSON.stringify({
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "pulscheck",
          version: VERSION,
          informationUri: "https://github.com/Qubites/pulscheck",
          rules: PATTERNS.map((p) => ({
            id: p.name,
            shortDescription: { text: p.risk },
            defaultConfiguration: {
              level: p.severity === "critical" ? "error" : p.severity === "warning" ? "warning" : "note"
            },
            help: { text: p.fix }
          }))
        }
      },
      results: matches.map((m) => ({
        ruleId: m.rule,
        level: m.severity === "critical" ? "error" : m.severity === "warning" ? "warning" : "note",
        message: { text: `${m.risk}
Fix: ${m.fix}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: m.file, uriBaseId: "%SRCROOT%" },
            region: { startLine: m.line }
          }
        }]
      }))
    }]
  }, null, 2);
}
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") opts.format = args[++i];
    else if (args[i] === "--out") opts.out = args[++i];
    else if (args[i] === "--severity") opts.severity = args[++i];
    else if (args[i] === "--fail-on") opts.failOn = args[++i];
    else if (args[i] === "--ignore") {
      const ignores = opts.ignore ?? [];
      ignores.push(args[++i]);
      opts.ignore = ignores;
    } else if (args[i] === "--quiet") opts.quiet = "true";
    else if (args[i] === "--version" || args[i] === "-v") opts.version = "true";
    else if (!args[i].startsWith("--")) positional.push(args[i]);
  }
  return { positional, opts };
}
function main() {
  const { positional, opts } = parseArgs(process.argv);
  const command = positional[0] ?? "scan";
  const dir = path__namespace.resolve(positional[1] ?? ".");
  const quiet = opts.quiet === "true";
  if (opts.version === "true" || command === "--version" || command === "-v") {
    console.log(`pulscheck ${VERSION}`);
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(`
PulsCheck CLI v${VERSION} \u2014 Static race condition scanner

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
  if (!fs__namespace.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const isCi = command === "ci";
  const format = opts.format ?? (isCi ? "sarif" : "text");
  const minSeverity = opts.severity ?? "warning";
  const failOn = opts.failOn ?? "critical";
  const outFile = opts.out;
  if (!quiet) {
    console.error(`PulsCheck v${VERSION} scanning ${dir}...`);
  }
  const start = performance.now();
  const files = walkDir(dir);
  let matches = [];
  for (const file of files) {
    try {
      matches.push(...scanFile(file, dir));
    } catch (_) {
    }
  }
  const ms = performance.now() - start;
  if (opts.ignore) {
    const ignores = Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore];
    matches = matches.filter((m) => !ignores.some((ig) => m.file.includes(ig)));
  }
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  const minOrder = sevOrder[minSeverity] ?? 1;
  matches = matches.filter((m) => sevOrder[m.severity] <= minOrder);
  matches.sort((a, b) => {
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
  let output;
  if (format === "json") output = formatJSON(matches, dir, ms);
  else if (format === "sarif") output = formatSARIF(matches);
  else output = formatText(matches, dir, ms);
  if (outFile) {
    fs__namespace.writeFileSync(outFile, output);
    if (!quiet) console.error(`Output written to ${outFile}`);
  } else {
    console.log(output);
  }
  if (!quiet) {
    console.error(`Scanned ${files.length} files in ${ms.toFixed(0)}ms`);
  }
  const failOrder = sevOrder[failOn] ?? 0;
  const shouldFail = matches.some((m) => sevOrder[m.severity] <= failOrder);
  if (isCi && shouldFail) {
    if (!quiet) console.error(`Failing: found findings at ${failOn} severity or above`);
    process.exit(1);
  }
}
main();
