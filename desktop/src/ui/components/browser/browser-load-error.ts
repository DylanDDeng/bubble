// Chrome-style copy for the panel's load-error page, keyed by Chromium net error codes
// (net/base/net_error_list.h).

export type BrowserLoadErrorKind = 'dns' | 'refused' | 'timeout' | 'offline' | 'certificate' | 'crashed' | 'generic';

export interface BrowserLoadErrorView {
  kind: BrowserLoadErrorKind;
  heading: string;
  summary: string;
  /** Chromium's symbolic name, shown small under the summary like Chrome does. */
  codeName: string | null;
  tips: Array<{ title: string; body?: string }>;
}

const CODE_NAMES: Record<number, string> = {
  [-7]: 'ERR_TIMED_OUT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-324]: 'ERR_EMPTY_RESPONSE',
};

export function browserLoadErrorKind(code: number | null | undefined): BrowserLoadErrorKind {
  if (code == null) return 'generic';
  if (code === -105 || code === -137) return 'dns';
  if (code === -102) return 'refused';
  if (code === -7 || code === -118) return 'timeout';
  if (code === -106 || code === -21) return 'offline';
  if (code <= -200 && code > -300) return 'certificate';
  return 'generic';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const CHECK_CONNECTION = { title: 'Checking the connection' };
const CHECK_NETWORK_CONFIG = { title: 'Checking the proxy, firewall, and DNS configuration' };

export function describeBrowserLoadError(
  code: number | null | undefined,
  url: string,
  fallbackMessage: string
): BrowserLoadErrorView {
  const host = hostOf(url);
  const codeName = code == null ? null : CODE_NAMES[code] ?? `Error ${code}`;
  const heading = "This site can't be reached";
  switch (browserLoadErrorKind(code)) {
    case 'dns':
      return {
        kind: 'dns',
        heading,
        summary: `${host}'s server IP address could not be found`,
        codeName,
        tips: [
          CHECK_CONNECTION,
          { title: 'Check your DNS settings', body: 'Contact your network administrator if you are not sure what this means' },
        ],
      };
    case 'refused':
      return {
        kind: 'refused',
        heading,
        summary: `${host} refused to connect`,
        codeName,
        tips: [{ title: 'Make sure the server is running', body: 'Local dev servers stop when their terminal closes' }, CHECK_NETWORK_CONFIG],
      };
    case 'timeout':
      return { kind: 'timeout', heading, summary: `${host} took too long to respond`, codeName, tips: [CHECK_CONNECTION, CHECK_NETWORK_CONFIG] };
    case 'offline':
      return {
        kind: 'offline',
        heading: 'No internet',
        summary: `${host} could not be loaded because the computer is offline`,
        codeName,
        tips: [
          { title: 'Check your Internet connection', body: 'Check any cables and restart any routers, modems, or other network devices you may be using' },
          { title: 'If you use a proxy server', body: 'Open your system network settings and check whether a proxy has been configured' },
        ],
      };
    case 'certificate':
      return {
        kind: 'certificate',
        heading: 'Your connection is not private',
        summary: `${host}'s certificate could not be verified`,
        codeName,
        tips: [{ title: 'Check the address', body: 'The site may be misconfigured, or someone may be intercepting your connection' }],
      };
    default:
      return {
        kind: code == null ? 'crashed' : 'generic',
        heading: code == null ? fallbackMessage : heading,
        summary: code == null ? url : `${host} could not be loaded`,
        codeName,
        tips: code == null ? [] : [CHECK_CONNECTION, CHECK_NETWORK_CONFIG],
      };
  }
}
