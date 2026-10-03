import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
const child = spawn(electron, [fileURLToPath(new URL("..", import.meta.url))], {
  stdio: "inherit",
  env: { ...process.env, BUBBLE_DESKTOP_NODE: process.execPath },
});
child.on("exit", (code) => process.exit(code ?? 1));
