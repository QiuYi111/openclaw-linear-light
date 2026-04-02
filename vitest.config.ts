import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/._*"],
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "index.ts"],
      exclude: ["src/**/*.test.ts", "src/**/fixtures.ts", "src/**/__test__/**"],
      reporter: ["text", "text-summary", "lcov"],
      thresholds: {
        lines: 90,
        branches: 75,
        functions: 90,
        statements: 87,
      },
    },
  },
})
