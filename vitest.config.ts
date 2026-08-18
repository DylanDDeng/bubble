import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Vendored renderer: tests exercise its TS source directly so vendor
      // changes are picked up without a rebuild.
      "@bubblebrain-ai/pi-tui": path.resolve(__dirname, "packages/pi-tui/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["**/node_modules/**", "dist", "services/**", "packages/**"],
    // Isolates BUBBLE_HOME so no test can write the developer's real ~/.bubble.
    setupFiles: ["./src/__tests__/setup/isolate-bubble-home.ts"],
  },
});
