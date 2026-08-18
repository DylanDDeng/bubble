import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Vendored renderer: tests exercise its TS source directly so vendor
      // changes are picked up without a rebuild. Longest prefix first so the
      // bare package alias does not swallow the /testing subpath.
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
    exclude: ["**/node_modules/**", "dist", "services/**", "packages/**"],
    // Isolates BUBBLE_HOME so no test can write the developer's real ~/.bubble.
    setupFiles: ["./src/__tests__/setup/isolate-bubble-home.ts"],
  },
});
