import { defineConfig } from "vitest/config";

// Frontend unit tests. The store and lib modules are pure TS — no DOM needed,
// so we run in the fast `node` environment and mock the Tauri IPC layer.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/store.ts"],
      // Type-only / IPC-boundary files have no logic worth covering.
      exclude: ["src/lib/types.ts", "src/lib/ipc.ts", "src/vite-env.d.ts"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
