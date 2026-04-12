import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const define = { __PULSCHECK_VERSION__: JSON.stringify(pkg.version) };

export default defineConfig([
  // Main entry — works everywhere (Node, browser, edge). No React.
  {
    entry: { index: "src/index.ts" },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: false,
    clean: true,
    target: "es2020",
    outDir: "dist",
    splitting: false,
    treeshake: true,
    external: ["react"],
    define,
  },
  // React hooks — separate subpath so main bundle stays React-free.
  {
    entry: { react: "src/react.ts" },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: false,
    clean: false, // don't nuke dist/ from the first build
    target: "es2020",
    outDir: "dist",
    splitting: false,
    treeshake: true,
    external: ["react"],
    define,
  },
  // Test helper — separate subpath for vitest/jest integration.
  {
    entry: { testing: "src/testing.ts" },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: false,
    clean: false,
    target: "es2020",
    outDir: "dist",
    splitting: false,
    treeshake: true,
    external: ["react"],
    define,
  },
  // CLI — standalone Node executable for CI pipelines.
  {
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    dts: false,
    sourcemap: false,
    clean: false,
    target: "es2020",
    outDir: "dist",
    splitting: false,
    treeshake: true,
    define,
  },
]);
