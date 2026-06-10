import { describe, expect, it } from "vitest";
import {
  getSystemProxyForUrl,
  parseScutilProxyOutput,
  parseWindowsProxyOutput,
  systemProxyForUrl,
  type SystemProxySettings,
} from "../network/system-proxy.js";

const SCUTIL_OUTPUT_WITH_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;

const SCUTIL_OUTPUT_DISABLED = `<dictionary> {
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
}`;

describe("system proxy", () => {
  it("parses scutil --proxy output with HTTP and HTTPS proxies", () => {
    const settings = parseScutilProxyOutput(SCUTIL_OUTPUT_WITH_PROXY);

    expect(settings).toBeDefined();
    expect(settings?.httpProxy).toBe("http://127.0.0.1:7897");
    expect(settings?.httpsProxy).toBe("http://127.0.0.1:7897");
    expect(settings?.exceptions).toContain("localhost");
    expect(settings?.exceptions).toContain("*.local");
    expect(settings?.exceptions).toContain("<local>");
  });

  it("returns undefined when no proxy is enabled", () => {
    expect(parseScutilProxyOutput(SCUTIL_OUTPUT_DISABLED)).toBeUndefined();
    expect(parseScutilProxyOutput("")).toBeUndefined();
  });

  it("ignores proxies with enable flag off or invalid port", () => {
    const httpOnly = parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.corp.test
  HTTPSEnable : 0
  HTTPSPort : 8080
  HTTPSProxy : proxy.corp.test
}`);
    expect(httpOnly?.httpProxy).toBe("http://proxy.corp.test:8080");
    expect(httpOnly?.httpsProxy).toBeUndefined();

    expect(parseScutilProxyOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPPort : 0
  HTTPProxy : proxy.corp.test
}`)).toBeUndefined();
  });

  it("routes https and http requests to the matching proxy", () => {
    const settings = parseScutilProxyOutput(SCUTIL_OUTPUT_WITH_PROXY)!;

    expect(systemProxyForUrl(new URL("https://api.anthropic.com/v1/messages"), settings)).toBe("http://127.0.0.1:7897");
    expect(systemProxyForUrl(new URL("http://example.com/"), settings)).toBe("http://127.0.0.1:7897");
  });

  it("falls back across protocols when only one proxy is configured", () => {
    const httpsOnly: SystemProxySettings = { httpsProxy: "http://proxy.test:8080", exceptions: [] };
    expect(systemProxyForUrl(new URL("http://example.com/"), httpsOnly)).toBe("http://proxy.test:8080");

    const httpOnly: SystemProxySettings = { httpProxy: "http://proxy.test:8080", exceptions: [] };
    expect(systemProxyForUrl(new URL("https://example.com/"), httpOnly)).toBe("http://proxy.test:8080");
  });

  it("bypasses hosts on the system exceptions list", () => {
    const settings = parseScutilProxyOutput(SCUTIL_OUTPUT_WITH_PROXY)!;

    expect(systemProxyForUrl(new URL("https://foo.local/"), settings)).toBeUndefined();
    expect(systemProxyForUrl(new URL("https://reports.crashlytics.com/"), settings)).toBeUndefined();
    // <local> matches dot-less hostnames
    expect(systemProxyForUrl(new URL("https://intranet/"), settings)).toBeUndefined();
    // CIDR entries are skipped, so public hostnames still go through the proxy
    expect(systemProxyForUrl(new URL("https://api.anthropic.com/"), settings)).toBe("http://127.0.0.1:7897");
  });

  it("never proxies loopback hosts", () => {
    const settings: SystemProxySettings = { httpsProxy: "http://proxy.test:8080", exceptions: [] };

    expect(systemProxyForUrl(new URL("http://localhost:11434/"), settings)).toBeUndefined();
    expect(systemProxyForUrl(new URL("http://127.0.0.1:1234/"), settings)).toBeUndefined();
  });

  it("ignores non-http protocols", () => {
    const settings: SystemProxySettings = { httpsProxy: "http://proxy.test:8080", exceptions: [] };
    expect(systemProxyForUrl(new URL("ws://example.com/"), settings)).toBeUndefined();
  });

  it("parses Windows registry output with a single proxy for all protocols", () => {
    const settings = parseWindowsProxyOutput(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;<local>
`);

    expect(settings?.httpProxy).toBe("http://127.0.0.1:7890");
    expect(settings?.httpsProxy).toBe("http://127.0.0.1:7890");
    expect(settings?.exceptions).toEqual(["localhost", "127.*", "192.168.*", "<local>"]);
  });

  it("parses Windows per-protocol proxy lists and ignores ftp/socks", () => {
    const settings = parseWindowsProxyOutput(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=proxy.corp.test:8080;ftp=127.0.0.1:21;socks=127.0.0.1:7891
`);

    expect(settings?.httpProxy).toBe("http://127.0.0.1:7890");
    expect(settings?.httpsProxy).toBe("http://proxy.corp.test:8080");
  });

  it("returns undefined when the Windows proxy is disabled or unset", () => {
    expect(parseWindowsProxyOutput(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
`)).toBeUndefined();

    expect(parseWindowsProxyOutput(`
    ProxyEnable    REG_DWORD    0x1
`)).toBeUndefined();

    expect(parseWindowsProxyOutput("")).toBeUndefined();
  });

  it("bypasses hosts matching Windows wildcard overrides", () => {
    const settings = parseWindowsProxyOutput(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    192.168.*;*.corp.test;<local>
`)!;

    expect(systemProxyForUrl(new URL("http://192.168.1.50/"), settings)).toBeUndefined();
    expect(systemProxyForUrl(new URL("https://git.corp.test/"), settings)).toBeUndefined();
    expect(systemProxyForUrl(new URL("https://intranet/"), settings)).toBeUndefined();
    expect(systemProxyForUrl(new URL("https://api.anthropic.com/"), settings)).toBe("http://127.0.0.1:7890");
  });

  it("can be disabled with BUBBLE_SYSTEM_PROXY=0", () => {
    expect(getSystemProxyForUrl(new URL("https://api.anthropic.com/"), { BUBBLE_SYSTEM_PROXY: "0" })).toBeUndefined();
    expect(getSystemProxyForUrl(new URL("https://api.anthropic.com/"), { BUBBLE_SYSTEM_PROXY: "off" })).toBeUndefined();
  });

  it("returns undefined without a url", () => {
    expect(getSystemProxyForUrl(undefined, {})).toBeUndefined();
  });
});
