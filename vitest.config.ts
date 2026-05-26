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
      // Type-only / IPC-boundary files have no logic worth covering. The terminal
      // renderer backends are DOM/GPU-bound (canvas 2D context, WebGL2) and can't
      // run in the node test env — their pure logic (grid/metrics/input/select/
      // mode) lives in sibling modules that ARE covered; the backends themselves
      // are exercised live in the app (see the verification checklist).
      exclude: [
        "src/lib/types.ts",
        "src/lib/ipc.ts",
        "src/lib/updater.ts",
        "src/lib/notify.ts",
        "src/lib/panel.ts",
        "src/lib/term/atlas.ts",
        "src/lib/term/renderer.ts",
        "src/lib/term/canvas2d.ts",
        "src/lib/term/webgl2.ts",
        "src/vite-env.d.ts",
      ],
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
