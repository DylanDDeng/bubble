#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));

if (process.versions.bun) {
  await import("./main.js");
} else {
  const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });

  if (bunCheck.error) {
    console.error(
      [
        "Bubble requires Bun to run.",
        "",
        "Install Bun, then run bubble again:",
        "  curl -fsSL https://bun.sh/install | bash",
        "",
        "After installation, restart your terminal if the bun command is not found.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const child = spawn("bun", [mainPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Failed to start Bubble with Bun: ${error.message}`);
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.code ?? 1);
  }
}
