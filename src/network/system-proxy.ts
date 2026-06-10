import { execFileSync } from "node:child_process";

export interface SystemProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  exceptions: string[];
}

const CACHE_TTL_MS = 30_000;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

let cache: { at: number; settings: SystemProxySettings | undefined } | undefined;

/**
 * Resolves the OS-level proxy for a request URL. Used as a fallback when no
 * proxy environment variables are set, so Bubble follows the same proxy that
 * browsers and other GUI apps use (e.g. Clash/Surge "system proxy" mode).
 * Reads `scutil --proxy` on macOS and the Internet Settings registry key on
 * Windows. Returns undefined on other platforms, when disabled via
 * BUBBLE_SYSTEM_PROXY=0, or when the URL matches the OS proxy bypass list.
 */
export function getSystemProxyForUrl(url: URL | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!url || isSystemProxyDisabled(env)) return undefined;
  const settings = readSystemProxySettings();
  if (!settings) return undefined;
  return systemProxyForUrl(url, settings);
}

export function systemProxyForUrl(url: URL, settings: SystemProxySettings): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const hostname = url.hostname.toLowerCase();
  if (isLoopbackHostname(hostname)) return undefined;
  if (settings.exceptions.some((entry) => systemExceptionMatches(entry, hostname))) return undefined;
  if (url.protocol === "https:") return settings.httpsProxy ?? settings.httpProxy;
  return settings.httpProxy ?? settings.httpsProxy;
}

export function parseScutilProxyOutput(output: string): SystemProxySettings | undefined {
  const settings: SystemProxySettings = {
    httpProxy: proxyUrlFromKeys(output, "HTTP"),
    httpsProxy: proxyUrlFromKeys(output, "HTTPS"),
    exceptions: parseExceptionsList(output),
  };
  if (!settings.httpProxy && !settings.httpsProxy) return undefined;
  return settings;
}

export function parseWindowsProxyOutput(output: string): SystemProxySettings | undefined {
  const enable = readRegistryValue(output, "ProxyEnable", "REG_DWORD");
  if (!enable || Number.parseInt(enable, 16) !== 1) return undefined;
  const server = readRegistryValue(output, "ProxyServer", "REG_SZ");
  if (!server) return undefined;

  const { httpProxy, httpsProxy } = parseWindowsProxyServer(server);
  if (!httpProxy && !httpsProxy) return undefined;

  const override = readRegistryValue(output, "ProxyOverride", "REG_SZ") ?? "";
  const exceptions = override
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return { httpProxy, httpsProxy, exceptions };
}

// ProxyServer is either "host:port" (all protocols) or per-protocol
// "http=host:port;https=host:port;ftp=...;socks=..." — ftp/socks are ignored.
function parseWindowsProxyServer(value: string): { httpProxy?: string; httpsProxy?: string } {
  if (!value.includes("=")) {
    const url = normalizeProxyHostPort(value);
    return { httpProxy: url, httpsProxy: url };
  }

  const result: { httpProxy?: string; httpsProxy?: string } = {};
  for (const part of value.split(";")) {
    const [protocol, hostPort] = part.split("=").map((item) => item.trim());
    if (!protocol || !hostPort) continue;
    const url = normalizeProxyHostPort(hostPort);
    if (!url) continue;
    if (protocol.toLowerCase() === "http") result.httpProxy = url;
    if (protocol.toLowerCase() === "https") result.httpsProxy = url;
  }
  return result;
}

function normalizeProxyHostPort(value: string): string | undefined {
  const trimmed = value.trim().replace(/^https?:\/\//i, "");
  const match = trimmed.match(/^([^\s:]+):(\d+)$/);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return `http://${match[1]}:${port}`;
}

function readRegistryValue(output: string, key: string, type: string): string | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s+${type}\\s+(.+?)\\s*$`, "m"));
  return match?.[1];
}

export function resetSystemProxyCacheForTests(): void {
  cache = undefined;
}

function isSystemProxyDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.BUBBLE_SYSTEM_PROXY?.trim().toLowerCase();
  return !!value && FALSE_VALUES.has(value);
}

function readSystemProxySettings(): SystemProxySettings | undefined {
  if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;

  let settings: SystemProxySettings | undefined;
  try {
    settings = process.platform === "darwin" ? readMacProxySettings() : readWindowsProxySettings();
  } catch {
    settings = undefined;
  }
  cache = { at: now, settings };
  return settings;
}

function readMacProxySettings(): SystemProxySettings | undefined {
  const output = execFileSync("scutil", ["--proxy"], { encoding: "utf-8", timeout: 2000 });
  return parseScutilProxyOutput(output);
}

function readWindowsProxySettings(): SystemProxySettings | undefined {
  const output = execFileSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
    { encoding: "utf-8", timeout: 2000, windowsHide: true },
  );
  return parseWindowsProxyOutput(output);
}

function proxyUrlFromKeys(output: string, prefix: string): string | undefined {
  if (readScalar(output, `${prefix}Enable`) !== "1") return undefined;
  const host = readScalar(output, `${prefix}Proxy`);
  const port = Number(readScalar(output, `${prefix}Port`));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return `http://${host}:${port}`;
}

function readScalar(output: string, key: string): string | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"));
  return match?.[1];
}

function parseExceptionsList(output: string): string[] {
  const match = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/);
  if (!match) return [];
  return [...match[1].matchAll(/^\s*\d+\s*:\s*(\S+)/gm)].map((item) => item[1].toLowerCase());
}

function systemExceptionMatches(entry: string, hostname: string): boolean {
  if (entry === "<local>") return !hostname.includes(".");
  // CIDR entries (e.g. 192.168.0.0/16) would need the resolved IP to match;
  // skip them so we never wrongly bypass the proxy for public hostnames.
  if (entry.includes("/")) return false;
  if (entry.startsWith("*.")) return hostname === entry.slice(2) || hostname.endsWith(entry.slice(1));
  // Windows ProxyOverride allows wildcards anywhere, e.g. 127.* or 192.168.*
  if (entry.includes("*")) return wildcardMatches(entry, hostname);
  if (entry.startsWith(".")) return hostname.endsWith(entry);
  return entry === hostname;
}

function wildcardMatches(pattern: string, hostname: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(hostname);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.startsWith("127.")
    || hostname.endsWith(".localhost");
}
