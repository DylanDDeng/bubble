import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@bubblebrain-ai/pi-tui/testing",
        replacement: path.resolve(root, "packages/pi-tui/src/testing.ts"),
      },
      {
        find: "@bubblebrain-ai/pi-tui",
        replacement: path.resolve(root, "packages/pi-tui/src/index.ts"),
      },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/tui-e2e/*.e2e.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ["./src/__tests__/setup/isolate-bubble-home.ts"],
  },
});
