import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    benchmark: {
      include: ["packages/*/bench/**/*.bench.ts"],
      reporters: ["default"],
    },
  },
});
