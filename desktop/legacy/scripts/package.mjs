import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..");
const stagingRoot = join(desktop, ".package-staging");
mkdirSync(stagingRoot, { recursive: true });
const staging = mkdtempSync(join(stagingRoot, "build-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", staging],
      { cwd: root, encoding: "utf8" },
    ),
  )[0];
  const install = join(staging, "install");
  mkdirSync(install);
  writeFileSync(
    join(install, "package.json"),
    JSON.stringify({
      name: "bubble-desktop-runtime",
      version: "1.0.0",
      private: true,
    }),
  );
  // Install with the same Node that is bundled, so native modules have the right ABI.
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(staging, packed.filename),
    ],
    { cwd: install, stdio: "inherit" },
  );
  const runtime = join(staging, "runtime");
  mkdirSync(runtime);
  cpSync(
    join(install, "node_modules/@bubblebrain-ai/bubble/dist"),
    join(runtime, "dist"),
    { recursive: true },
  );
  cpSync(join(install, "node_modules"), join(runtime, "node_modules"), {
    recursive: true,
  });
  cpSync(process.execPath, join(runtime, "node"));
  chmodSync(join(runtime, "node"), 0o755);
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  // A plain Node child cannot read Electron's ASAR virtual filesystem.
  const agentHost = join(staging, "agent-host");
  mkdirSync(agentHost);
  for (const file of ["worker.mjs", "service.mjs"])
    cpSync(join(desktop, "electron", file), join(agentHost, file));
  const paths = await packager({
    dir: desktop,
    name: "Bubble",
    appBundleId: "ai.bubblebrain.desktop",
    out: join(desktop, "out"),
    overwrite: true,
    asar: true,
    platform: process.platform,
    arch: process.arch,
    extraResource: [runtime, agentHost],
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/(?:out|\.package-staging|\.qa|src|tests|scripts)(?:\/|$)/,
      /^\/package-lock\.json$/,
    ],
    prune: false,
    osxSign: false,
    osxNotarize: false,
  });
  console.log(`Desktop application: ${paths.join(", ")}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
