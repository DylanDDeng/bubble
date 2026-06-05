import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, type Dispatcher } from "undici";

export type ChatGptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ChatGptFetchOptions {
  fetch?: ChatGptFetch;
  env?: NodeJS.ProcessEnv;
}

type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

let cachedDefaultFetch: { signature: string; fetch: ChatGptFetch } | undefined;

export function chatGptFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return getChatGptFetch()(input, init);
}

export function getChatGptFetch(env: NodeJS.ProcessEnv = process.env): ChatGptFetch {
  const signature = networkEnvSignature(env);
  if (!cachedDefaultFetch || cachedDefaultFetch.signature !== signature) {
    cachedDefaultFetch = {
      signature,
      fetch: createChatGptFetch({ env }),
    };
  }
  return cachedDefaultFetch.fetch;
}

export function createChatGptFetch(options: ChatGptFetchOptions = {}): ChatGptFetch {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return async (input, init) => {
    const requestInit = withChatGptNetworkOptions(input, init, env);
    try {
      return await fetchImpl(input, requestInit);
    } catch (error) {
      throw normalizeChatGptNetworkError(error, env);
    }
  };
}

export function createChatGptDispatcher(
  env: NodeJS.ProcessEnv = process.env,
  input?: RequestInfo | URL,
): Dispatcher | undefined {
  if (isBunRuntime()) return undefined;
  const ca = loadExtraCaCertificates(env);
  const proxy = input ? nodeProxyForUrl(input, env) : defaultNodeProxy(env);
  if (!proxy && ca.length === 0) return undefined;
  const caOptions = ca.length > 0 ? { ca: [...rootCertificates, ...ca] } : undefined;

  if (proxy) {
    return new ProxyAgent({
      uri: proxy,
      ...(caOptions ? { requestTls: caOptions, proxyTls: caOptions } : {}),
    });
  }

  return caOptions ? new Agent({ connect: caOptions }) : undefined;
}

export function withChatGptNetworkOptions(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dispatcher = createChatGptDispatcher(env, input),
): RequestInitWithDispatcher {
  const next = { ...(init ?? {}) } as RequestInitWithDispatcher & {
    proxy?: string;
    tls?: { ca?: unknown[] };
  };

  if (isBunRuntime()) {
    const proxy = bunProxyForUrl(input, env);
    if (proxy) next.proxy = proxy;
    const ca = bunExtraCaFiles(env);
    if (ca.length > 0) next.tls = { ...(next.tls ?? {}), ca };
    return next;
  }

  if (dispatcher) next.dispatcher = dispatcher;
  return next;
}

export function normalizeChatGptNetworkError(error: unknown, env: NodeJS.ProcessEnv = process.env): Error {
  const text = errorMessageChain(error).join("\n");
  if (!isChatGptNetworkErrorText(text)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const message = [
    "ChatGPT connection failed before Bubble received a response.",
    isCertificateErrorText(text)
      ? "TLS certificate verification failed. If you are on a corporate proxy, VPN, or HTTPS inspection network, start Bubble with NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem or BUBBLE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem."
      : "This looks like a proxy or network transport failure.",
    hasProxyEnv(env)
      ? "Bubble is using proxy environment variables for ChatGPT requests. Make sure NO_PROXY includes localhost,127.0.0.1."
      : hasMacSystemProxy(env)
        ? "Bubble detected the macOS system proxy for ChatGPT requests. If it is stale, restart your proxy client or set BUBBLE_DISABLE_SYSTEM_PROXY=1 and configure HTTPS_PROXY explicitly."
      : "If your network requires a proxy, set HTTPS_PROXY or HTTP_PROXY, and set NO_PROXY=localhost,127.0.0.1.",
    "Do not disable TLS verification with NODE_TLS_REJECT_UNAUTHORIZED=0.",
    `Original error: ${firstMeaningfulErrorMessage(error) || "unknown network error"}`,
  ].join(" ");

  return new Error(message, { cause: error });
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.BUBBLE_CHATGPT_PROXY ||
    env.bubble_chatgpt_proxy ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy
  );
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function bunProxyForUrl(input: RequestInfo | URL, env: NodeJS.ProcessEnv): string | undefined {
  return proxyForUrl(input, env);
}

function nodeProxyForUrl(input: RequestInfo | URL, env: NodeJS.ProcessEnv): string | undefined {
  return proxyForUrl(input, env);
}

function proxyForUrl(input: RequestInfo | URL, env: NodeJS.ProcessEnv): string | undefined {
  const url = urlFromInput(input);
  if (!url || shouldBypassProxy(url, env)) return undefined;
  const explicit = explicitProxyForUrl(url, env);
  return explicit ?? macSystemProxyForUrl(url, env);
}

function defaultNodeProxy(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.BUBBLE_CHATGPT_PROXY ??
    env.bubble_chatgpt_proxy ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    env.ALL_PROXY ??
    env.all_proxy ??
    macSystemProxyForUrl(new URL("https://chatgpt.com/"), env)
  );
}

function explicitProxyForUrl(url: URL, env: NodeJS.ProcessEnv): string | undefined {
  const chatGptProxy = env.BUBBLE_CHATGPT_PROXY ?? env.bubble_chatgpt_proxy;
  if (chatGptProxy) return chatGptProxy;
  const allProxy = env.ALL_PROXY ?? env.all_proxy;
  if (url.protocol === "https:") return env.HTTPS_PROXY ?? env.https_proxy ?? allProxy;
  if (url.protocol === "http:") return env.HTTP_PROXY ?? env.http_proxy ?? allProxy;
  return allProxy;
}

function hasMacSystemProxy(env: NodeJS.ProcessEnv): boolean {
  return Boolean(macSystemProxyForUrl(new URL("https://chatgpt.com/"), env));
}

function macSystemProxyForUrl(url: URL, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "darwin" || truthyEnv(env.BUBBLE_DISABLE_SYSTEM_PROXY)) return undefined;
  const output = readMacSystemProxy();
  return output ? parseMacSystemProxyForUrl(output, url) : undefined;
}

export function parseMacSystemProxyForUrl(output: string, url: URL): string | undefined {
  if (macProxyExceptionMatches(output, url.hostname, url.port)) return undefined;
  const values = parseScutilProxyValues(output);
  if (url.protocol === "https:") {
    return formatMacProxy(values.HTTPSEnable, values.HTTPSProxy, values.HTTPSPort);
  }
  if (url.protocol === "http:") {
    return formatMacProxy(values.HTTPEnable, values.HTTPProxy, values.HTTPPort);
  }
  return undefined;
}

function parseScutilProxyValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+(?:Enable|Proxy|Port))\s*:\s*(.+?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function formatMacProxy(enabled: string | undefined, host: string | undefined, port: string | undefined): string | undefined {
  if (enabled !== "1" || !host || !port) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return host;
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

function macProxyExceptionMatches(output: string, hostname: string, port: string): boolean {
  const exceptions = parseMacProxyExceptions(output);
  return exceptions.some((entry) => noProxyEntryMatches(entry.toLowerCase(), hostname.toLowerCase(), port));
}

function parseMacProxyExceptions(output: string): string[] {
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("ExceptionsList")) {
      inExceptions = true;
      continue;
    }
    if (!inExceptions) continue;
    if (/^\s*}\s*$/.test(line)) break;
    const match = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
    if (match) exceptions.push(match[1].trim());
  }
  return exceptions;
}

let cachedMacSystemProxy: { checkedAtMs: number; output: string | undefined } | undefined;

function readMacSystemProxy(): string | undefined {
  const now = Date.now();
  if (cachedMacSystemProxy && now - cachedMacSystemProxy.checkedAtMs < 5_000) {
    return cachedMacSystemProxy.output;
  }

  let output: string | undefined;
  try {
    output = execFileSync("scutil", ["--proxy"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
  } catch {
    output = undefined;
  }
  cachedMacSystemProxy = { checkedAtMs: now, output };
  return output;
}

function truthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function bunExtraCaFiles(env: NodeJS.ProcessEnv): unknown[] {
  const bun = (globalThis as { Bun?: { file?: (path: string) => unknown } }).Bun;
  if (!bun?.file) return [];
  return extraCaCertificatePaths(env).map((path) => bun.file!(path));
}

function urlFromInput(input: RequestInfo | URL): URL | undefined {
  if (input instanceof URL) return input;
  if (typeof input === "string") return URL.canParse(input) ? new URL(input) : undefined;
  const url = (input as Request).url;
  return URL.canParse(url) ? new URL(url) : undefined;
}

function shouldBypassProxy(url: URL, env: NodeJS.ProcessEnv): boolean {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").trim();
  if (!noProxy) return false;
  if (noProxy === "*") return true;
  const hostname = url.hostname.toLowerCase();
  const port = url.port;
  return noProxy
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((entry) => noProxyEntryMatches(entry.toLowerCase(), hostname, port));
}

function noProxyEntryMatches(entry: string, hostname: string, port: string): boolean {
  const [entryHost, entryPort] = entry.includes(":") ? entry.split(":") : [entry, ""];
  if (entryPort && entryPort !== port) return false;
  if (entryHost === hostname) return true;
  if (entryHost.startsWith("*.")) return hostname.endsWith(entryHost.slice(1));
  if (entryHost.startsWith(".")) return hostname.endsWith(entryHost);
  return false;
}

function loadExtraCaCertificates(env: NodeJS.ProcessEnv): string[] {
  const paths = extraCaCertificatePaths(env);
  return paths.map((path) => {
    try {
      return readFileSync(path, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read ChatGPT custom CA certificate at ${path}. Check NODE_EXTRA_CA_CERTS or BUBBLE_EXTRA_CA_CERTS.`, {
        cause: error,
      });
    }
  });
}

function extraCaCertificatePaths(env: NodeJS.ProcessEnv): string[] {
  const bubbleValue = env.BUBBLE_EXTRA_CA_CERTS?.trim();
  if (bubbleValue) {
    return bubbleValue.split(delimiter).map((item) => item.trim()).filter(Boolean);
  }

  const nodeValue = env.NODE_EXTRA_CA_CERTS?.trim();
  return nodeValue ? [nodeValue] : [];
}

function networkEnvSignature(env: NodeJS.ProcessEnv): string {
  return [
    env.HTTP_PROXY,
    env.http_proxy,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.ALL_PROXY,
    env.all_proxy,
    env.BUBBLE_CHATGPT_PROXY,
    env.bubble_chatgpt_proxy,
    env.BUBBLE_DISABLE_SYSTEM_PROXY,
    env.NO_PROXY,
    env.no_proxy,
    env.NODE_EXTRA_CA_CERTS,
    env.BUBBLE_EXTRA_CA_CERTS,
  ].join("\0");
}

function isChatGptNetworkErrorText(text: string): boolean {
  return [
    /fetch failed/i,
    /network.*failed/i,
    /socket connection was closed unexpectedly/i,
    /\bConnectionClosed\b/i,
    /\bECONNRESET\b/i,
    /\bECONNREFUSED\b/i,
    /\bETIMEDOUT\b/i,
    /\bEPIPE\b/i,
    /\bUND_ERR_/i,
    /socket hang up/i,
    /Unable to connect\. Is the computer able to access the url\?/i,
    /certificate/i,
    /unable to verify/i,
    /self[- ]signed/i,
  ].some((pattern) => pattern.test(text));
}

function isCertificateErrorText(text: string): boolean {
  return [
    /unknown certificate verification error/i,
    /certificate (?:verify|verification) (?:failed|error)/i,
    /unable to verify (?:the )?(?:first )?certificate/i,
    /UNABLE_TO_(?:VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT_LOCALLY)/i,
    /SELF_SIGNED_CERT_IN_CHAIN/i,
    /DEPTH_ZERO_SELF_SIGNED_CERT/i,
    /CERT_(?:HAS_EXPIRED|UNTRUSTED|INVALID)/i,
    /self[- ]signed certificate/i,
  ].some((pattern) => pattern.test(text));
}

function firstMeaningfulErrorMessage(error: unknown): string | undefined {
  return errorMessageChain(error).find((item) => item && item !== "Error");
}

function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof Error) {
      messages.push(current.name, current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["name", "code", "message"]) {
        if (typeof record[key] === "string") messages.push(record[key]);
      }
      current = record.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages;
}
