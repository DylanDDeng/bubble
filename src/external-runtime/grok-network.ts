import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrokRuntimeError } from "./grok-errors.js";

const XAI_OIDC_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const MAX_PROXY_CONFIG_BYTES = 64 * 1024;

export type GrokNetworkRouteSource = "direct" | "clash-verge" | "clashx";
export interface GrokNetworkRoute { source: GrokNetworkRouteSource; proxy?: string }
export type GrokNetworkProbe = (proxy?: string) => Promise<boolean>;
export interface GrokNetworkResolverDependencies {
  platform?: NodeJS.Platform;
  userHome?: string;
  uid?: number;
  probe?: GrokNetworkProbe;
}

export async function probeXaiOidc(proxy?: string, timeoutMs = 5_000): Promise<boolean> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000)).toString();
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--output", "/dev/null",
    "--connect-timeout", timeoutSeconds,
    "--max-time", timeoutSeconds,
    "--proto", "=https",
  ];
  if (proxy) args.push("--proxy", proxy);
  else args.push("--noproxy", "*");
  args.push(XAI_OIDC_DISCOVERY_URL);

  return await new Promise<boolean>((resolve) => {
    execFile(
      "/usr/bin/curl",
      args,
      { timeout: timeoutMs + 1_000, maxBuffer: 4 * 1024 },
      (error) => resolve(error === null),
    );
  });
}

export function parseClashHttpProxyPort(contents: string): number | undefined {
  for (const key of ["mixed-port", "port"]) {
    const match = new RegExp(`^${key}:\\s*([0-9]{1,5})\\s*$`, "m").exec(contents);
    const port = match ? Number(match[1]) : 0;
    if (port >= 1 && port <= 65_535) return port;
  }
  return undefined;
}

async function readOwnedProxyPort(path: string, uid: number): Promise<number | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid
      || (metadata.mode & 0o022) !== 0 || metadata.size > MAX_PROXY_CONFIG_BYTES) return undefined;
    return parseClashHttpProxyPort(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function discoverConfiguredLoopbackProxies(deps: GrokNetworkResolverDependencies) {
  if ((deps.platform ?? process.platform) !== "darwin") return [];
  const uid = deps.uid ?? process.getuid?.();
  if (uid === undefined) return [];
  const home = deps.userHome ?? homedir();
  const configs = [
    { source: "clash-verge" as const, path: join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev", "config.yaml") },
    { source: "clashx" as const, path: join(home, "Library", "Application Support", "com.west2online.ClashX", "config.yaml") },
  ];
  const candidates: Array<{ source: "clash-verge" | "clashx"; proxy: string }> = [];
  for (const config of configs) {
    const port = await readOwnedProxyPort(config.path, uid);
    if (port) candidates.push({ source: config.source, proxy: `http://127.0.0.1:${port}` });
  }
  return candidates;
}

export async function resolveGrokNetworkRoute(deps: GrokNetworkResolverDependencies = {}): Promise<GrokNetworkRoute> {
  const probe = deps.probe ?? probeXaiOidc;
  if (await probe()) return { source: "direct" };
  const seen = new Set<string>();
  for (const candidate of await discoverConfiguredLoopbackProxies(deps)) {
    if (seen.has(candidate.proxy)) continue;
    seen.add(candidate.proxy);
    if (await probe(candidate.proxy)) return candidate;
  }
  throw new GrokRuntimeError("not_authenticated", "Bubble could not reach xAI through this Mac's current network configuration.");
}
