import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["**/node_modules/**", "dist", "services/**"],
    // Isolates BUBBLE_HOME so no test can write the developer's real ~/.bubble.
    setupFiles: ["./src/__tests__/setup/isolate-bubble-home.ts"],
  },
});
