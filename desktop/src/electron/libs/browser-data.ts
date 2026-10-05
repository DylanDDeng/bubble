import { session } from 'electron';
import {
  BROWSER_SESSION_PARTITION,
  type BrowserClearDataType,
  type BrowserDataSummary,
} from '../../shared/browser-types';
import { forgetChromeCookieImport, stripLeadingDot } from './chrome-cookie-import';

const SITE_DATA_TYPES = [
  'cookies',
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch',
] as const;

function browserSession() {
  return session.fromPartition(BROWSER_SESSION_PARTITION);
}

export async function getBrowserDataSummary(): Promise<BrowserDataSummary> {
  const target = browserSession();
  const [cookies, cacheBytes] = await Promise.all([target.cookies.get({}), target.getCacheSize()]);
  const sites = new Set(
    cookies.map((cookie) => stripLeadingDot(cookie.domain ?? '').toLowerCase()).filter(Boolean)
  );
  return { cookieSiteCount: sites.size, cacheBytes };
}

export async function clearBrowserData(types: BrowserClearDataType[]): Promise<BrowserDataSummary> {
  const target = browserSession();
  if (types.includes('siteData')) {
    await target.clearData({ dataTypes: [...SITE_DATA_TYPES] });
    await target.cookies.flushStore();
    forgetChromeCookieImport();
  }
  if (types.includes('cache')) {
    await target.clearCache();
    await target.clearCodeCaches({});
  }
  return getBrowserDataSummary();
}
