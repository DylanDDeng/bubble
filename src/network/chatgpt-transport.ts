import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, type Dispatcher } from "undici";

export type ChatGptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ChatGptFetchOptions {
  fetch?: ChatGptFetch;
  env?: NodeJS.ProcessEnv;
}

export type ChatGptNetworkFailureKind =
  | "tls_certificate"
  | "timeout"
  | "socket_closed"
  | "connection_refused"
  | "proxy_or_network"
  | "abort";

export interface ChatGptNetworkDiagnostics {
  runtime: "bun" | "node" | "browser" | "unknown";
  endpointHost?: string;
  endpointProtocol?: string;
  proxyEnv: {
    http: boolean;
    https: boolean;
    all: boolean;
    any: boolean;
  };
  noProxyConfigured: boolean;
  noProxyMatched?: boolean;
  extraCa: {
    bubbleEnv: boolean;
    nodeEnv: boolean;
    count: number;
    existing: number;
    missing: number;
  };
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
  if (!hasProxyEnv(env) && ca.length === 0) return undefined;
  const proxy = input ? nodeProxyForUrl(input, env) : defaultNodeProxy(env);
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
      : "If your network requires a proxy, set HTTPS_PROXY or HTTP_PROXY, and set NO_PROXY=localhost,127.0.0.1.",
    "Do not disable TLS verification with NODE_TLS_REJECT_UNAUTHORIZED=0.",
    `Original error: ${firstMeaningfulErrorMessage(error) || "unknown network error"}`,
  ].join(" ");

  return new Error(message, { cause: error });
}

export function classifyChatGptNetworkError(error: unknown): ChatGptNetworkFailureKind | undefined {
  const text = errorMessageChain(error).join("\n");
  if (/\bAbortError\b|Request was aborted|Login cancelled/i.test(text)) return "abort";
  if (isCertificateErrorText(text)) return "tls_certificate";
  if (/\bETIMEDOUT\b|timed? out|timeout/i.test(text)) return "timeout";
  if (/socket connection was closed unexpectedly|\bConnectionClosed\b|\bECONNRESET\b|\bUND_ERR_SOCKET\b|\bEPIPE\b|socket hang up|other side closed|stream ended before|WebSocket closed|WebSocket error/i.test(text)) {
    return "socket_closed";
  }
  if (/\bECONNREFUSED\b|connection refused/i.test(text)) return "connection_refused";
  if (isChatGptNetworkErrorText(text)) return "proxy_or_network";
  return undefined;
}

export function isChatGptCertificateError(error: unknown): boolean {
  return classifyChatGptNetworkError(error) === "tls_certificate";
}

export function isChatGptNetworkError(error: unknown): boolean {
  return classifyChatGptNetworkError(error) !== undefined;
}

export function getChatGptNetworkDiagnostics(
  input?: RequestInfo | URL,
  env: NodeJS.ProcessEnv = process.env,
): ChatGptNetworkDiagnostics {
  const url = input ? urlFromInput(input) : undefined;
  const caPaths = extraCaCertificatePaths(env);
  const existing = caPaths.filter((path) => existsSync(path)).length;
  const proxyEnv = {
    http: Boolean(env.HTTP_PROXY || env.http_proxy),
    https: Boolean(env.HTTPS_PROXY || env.https_proxy),
    all: Boolean(env.ALL_PROXY || env.all_proxy),
    any: hasProxyEnv(env),
  };
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").trim();
  return {
    runtime: currentRuntime(),
    endpointHost: url?.host,
    endpointProtocol: url?.protocol.replace(/:$/, ""),
    proxyEnv,
    noProxyConfigured: noProxy.length > 0,
    noProxyMatched: url ? shouldBypassProxy(url, env) : undefined,
    extraCa: {
      bubbleEnv: Boolean(env.BUBBLE_EXTRA_CA_CERTS?.trim()),
      nodeEnv: Boolean(env.NODE_EXTRA_CA_CERTS?.trim()),
      count: caPaths.length,
      existing,
      missing: caPaths.length - existing,
    },
  };
}

export function hasChatGptProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProxyEnv(env);
}

export function getChatGptProxyForUrl(
  input: RequestInfo | URL,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const url = urlFromInput(input);
  if (!url || shouldBypassProxy(url, env)) return undefined;
  if (url.protocol === "https:") return env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (url.protocol === "http:") return env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  return undefined;
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function currentRuntime(): ChatGptNetworkDiagnostics["runtime"] {
  if (isBunRuntime()) return "bun";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  if (typeof fetch === "function") return "browser";
  return "unknown";
}

function bunProxyForUrl(input: RequestInfo | URL, env: NodeJS.ProcessEnv): string | undefined {
  return getChatGptProxyForUrl(input, env);
}

function nodeProxyForUrl(input: RequestInfo | URL, env: NodeJS.ProcessEnv): string | undefined {
  const url = urlFromInput(input);
  if (url && shouldBypassProxy(url, env)) return undefined;
  return getChatGptProxyForUrl(input, env) ?? defaultNodeProxy(env);
}

function defaultNodeProxy(env: NodeJS.ProcessEnv): string | undefined {
  return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
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
