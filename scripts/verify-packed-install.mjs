import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = await mkdtemp(join(tmpdir(), "bubble-packed-install-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

try {
  run("npm", ["pack", "--pack-destination", sandbox], repoRoot);
  const tarballs = (await readdir(sandbox)).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected one packed tarball, found ${tarballs.length}`);
  }

  await writeFile(
    join(sandbox, "package.json"),
    JSON.stringify({ name: "bubble-packed-install-smoke", private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", join(sandbox, tarballs[0])],
    sandbox,
  );

  const packageRoot = join(sandbox, "node_modules", "@bubblebrain-ai", "bubble");
  const smokeScript = `
    const sdk = await import(${JSON.stringify(join(packageRoot, "dist/sdk/index.js"))});
    if (typeof sdk.BubbleSdk !== "function") throw new Error("BubbleSdk export is unavailable");
    if (typeof sdk.AgentRunInputQueue !== "function") throw new Error("AgentRunInputQueue export is unavailable");
    const client = new sdk.BubbleSdk({ mcp: false });
    for (const method of ["steer", "enqueueTurn", "queueTurn", "clearQueue", "getSessionRunState", "stop"]) {
      if (typeof client[method] !== "function") throw new Error(\`BubbleSdk.\${method} is unavailable\`);
    }

    const tui = await import(${JSON.stringify(
      join(packageRoot, "node_modules/@bubblebrain-ai/pi-tui/dist/src/index.js"),
    )});
    if (typeof tui.Marked !== "function") throw new Error("bundled Pi TUI could not load marked");
  `;
  run(process.execPath, ["--input-type=module", "--eval", smokeScript], sandbox);
  process.stdout.write("Packed Bubble install loaded SDK turn control and the bundled Pi TUI successfully.\n");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
