// Injected at build time by tsup `define`.
// Falls back to "0.0.0-dev" when running unbuilt (e.g., vitest).
declare const __PULSCHECK_VERSION__: string;
export const VERSION: string =
  typeof __PULSCHECK_VERSION__ !== "undefined"
    ? __PULSCHECK_VERSION__
    : "0.0.0-dev";
