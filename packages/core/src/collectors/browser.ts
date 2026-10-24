import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { matchBeacon, beaconEvent, type BeaconRecord } from './beacons.js';
import { COLLECTOR_INIT_SCRIPT } from './initScript.js';
import { RateLimiter } from '../util/exec.js';

export type Device = 'mobile' | 'desktop';

export const VIEWPORTS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
} as const;

export const USER_AGENTS = {
  // A normal browser UA. SpeedPilot never asks sites to treat it differently (CLAUDE.md rule 5).
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
};

export interface SessionOptions {
  device: Device | 'tablet';
  /** Local or staging targets may skip the 1 request/second navigation limit. */
  local?: boolean;
  cookies?: Array<{ name: string; value: string; url: string }>;
  httpCredentials?: { username: string; password: string };
  /** Extra request URL substrings to block (for example Shopify preview bar, MEAS-06). */
  block?: string[];
  /** Mutating requests to the site are blocked unless explicitly allowed (CLAUDE.md rule 12). */
  allowMutations?: boolean;
  /** Origins whose mutating requests are allowed (local fixtures, staging flows that add to cart). */
  mutationAllowlist?: RegExp[];
  initScripts?: string[];
}

export interface Session {
  context: BrowserContext;
  beacons: BeaconRecord[];
  /** Requests SpeedPilot blocked because they would change data on a real site. */
  blockedMutations: Array<{ url: string; method: string }>;
  /** All non-GET requests that left the browser (for the "no POST/PUT/PATCH/DELETE" proof). */
  mutationsSent: Array<{ url: string; method: string }>;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

let shared: Browser | undefined;
let refs = 0;

export async function launchBrowser(): Promise<Browser> {
  if (!shared) shared = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  refs++;
  return shared;
}

export async function releaseBrowser(): Promise<void> {
  refs--;
  if (refs <= 0 && shared) {
    const b = shared;
    shared = undefined;
    refs = 0;
    await b.close();
  }
}

const navLimiter = new RateLimiter(1000);

/** Opens a browser context that records then aborts every analytics and ad beacon (MEAS-10). */
export async function openSession(browser: Browser, opts: SessionOptions): Promise<Session> {
  const vp = VIEWPORTS[opts.device];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    userAgent: opts.device === 'desktop' ? USER_AGENTS.desktop : USER_AGENTS.mobile,
    httpCredentials: opts.httpCredentials,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: false,
  });
  if (opts.cookies?.length) await context.addCookies(opts.cookies);
  await context.addInitScript(COLLECTOR_INIT_SCRIPT);
  for (const s of opts.initScripts ?? []) await context.addInitScript(s);
  const beacons: BeaconRecord[] = [];
  const blockedMutations: Session['blockedMutations'] = [];
  const mutationsSent: Session['mutationsSent'] = [];
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const rule = matchBeacon(url);
    if (rule) {
      beacons.push({ vendor: rule.vendor, url, method: req.method(), event: beaconEvent(url, req.postData()), at: Date.now() });
      return route.abort('blockedbyclient');
    }
    if (opts.block?.some((b) => url.includes(b))) return route.abort('blockedbyclient');
    const method = req.method();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const allowed = opts.allowMutations || opts.mutationAllowlist?.some((re) => re.test(url));
      if (!allowed) {
        blockedMutations.push({ url, method });
        return route.abort('blockedbyclient');
      }
      mutationsSent.push({ url, method });
    }
    if (!opts.local && req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) await navLimiter.wait();
    return route.continue();
  });
  return {
    context,
    beacons,
    blockedMutations,
    mutationsSent,
    newPage: () => context.newPage(),
    close: () => context.close(),
  };
}

/** Accepts or denies consent on common consent tools (MEAS-03). Returns whether a banner was handled. */
export async function setConsent(page: Page, state: 'granted' | 'denied'): Promise<boolean> {
  const accept = ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#onetrust-accept-btn-handler', '.cmplz-accept', '.cky-btn-accept', '#cookie_action_close_header', '.iubenda-cs-accept-btn', '[data-testid="uc-accept-all-button"]', '#BorlabsCookieBox a._brlbs-btn-accept-all', 'button[data-consent="accept"]'];
  const deny = ['#CybotCookiebotDialogBodyButtonDecline', '#onetrust-reject-all-handler', '.cmplz-deny', '.cky-btn-reject', '.iubenda-cs-reject-btn', '[data-testid="uc-deny-all-button"]', 'button[data-consent="deny"]'];
  for (const s of state === 'granted' ? accept : deny) {
    const el = page.locator(s).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  return false;
}
