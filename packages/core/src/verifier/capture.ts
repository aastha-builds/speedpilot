import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Browser, Page, Route } from 'playwright';
import type { SiteConfig, Flow } from '../config/site.js';
import { openSession, setConsent, VIEWPORTS, type Session } from '../collectors/browser.js';
import { runFlow, rebase } from './smoke.js';
import { slugUrl } from '../collectors/lighthouse.js';

/** A response rewrite applied in the browser (used by verification self-tests and the X-ray what-if simulator). */
export type ResponseTransform = (url: string, body: string, contentType: string) => string | undefined;

export interface SeoState {
  status: number | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  robotsHeader: string | null;
  hreflang: string[];
  jsonLd: string[];
  ogImage: string | null;
}

export interface UrlCapture {
  url: string;
  viewport: 'mobile' | 'tablet' | 'desktop';
  screenshot: string;
  earlyPaint?: { screenshot: string; unstyled: boolean; fcp: number | null };
  console: string[];
  failed: Array<{ url: string; status?: number; type: string }>;
  mixed: string[];
  csp: string[];
  seo: SeoState;
  imgWithoutAlt: number;
  facadesNotFocusable: string[];
  phpNotices: number;
  liquidErrors: number;
  cls: number;
  beacons: Array<{ vendor: string; event: string }>;
}

export interface FlowCapture {
  name: string;
  viewport: string;
  pass: boolean;
  detail: string;
  skipped?: boolean;
  beacons: Array<{ vendor: string; event: string }>;
  console: string[];
}

export interface Capture {
  createdAt: string;
  base: string;
  consent: 'denied' | 'granted' | 'none';
  urls: UrlCapture[];
  flows: FlowCapture[];
}

/** Normalizes a console message into a stable signature (URLs, query strings, line numbers, numbers). */
export function consoleSignature(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)'"]+/g, (u) => {
      try {
        return new URL(u).pathname.replace(/\.[0-9a-f]{8,}\./, '.');
      } catch {
        return 'URL';
      }
    })
    .replace(/:\d+(:\d+)?/g, '')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function installTransform(page: Page, transform: ResponseTransform | undefined) {
  if (!transform) return;
  await page.route('**/*', async (route: Route) => {
    const req = route.request();
    if (!['document', 'script', 'stylesheet'].includes(req.resourceType())) return route.fallback();
    const res = await route.fetch().catch(() => undefined);
    if (!res) return route.fallback();
    const ct = res.headers()['content-type'] ?? '';
    const body = await res.text();
    const next = transform(req.url(), body, ct);
    const headers = { ...res.headers() };
    delete headers['content-encoding'];
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    return route.fulfill({ status: res.status(), headers, body: next === undefined ? body : next });
  });
}

/** Early-paint screenshot taken at first contentful paint, plus an unstyled-content check (SPEC.md 6 visual). */
async function earlyPaint(session: Session, url: string, out: string, transform?: ResponseTransform): Promise<UrlCapture['earlyPaint']> {
  const page = await session.newPage();
  await installTransform(page, transform);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
    let fcp: number | null = null;
    for (let i = 0; i < 200 && fcp === null; i++) {
      fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null).catch(() => null);
      if (fcp === null) await page.waitForTimeout(25);
    }
    await page.screenshot({ path: out, animations: 'allow', timeout: 5000 }).catch(() => {});
    const unstyled = await page
      .evaluate(() => {
        const b = document.body;
        if (!b) return false;
        const cs = getComputedStyle(b);
        const sheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).length;
        return sheets > 0 && cs.margin === '8px' && /Times|serif/.test(cs.fontFamily) && !/sans/.test(cs.fontFamily);
      })
      .catch(() => false);
    return { screenshot: out, unstyled, fcp };
  } finally {
    await page.close();
  }
}

async function readUrl(session: Session, url: string, viewport: UrlCapture['viewport'], dir: string, masks: string[], transform?: ResponseTransform, consent: Capture['consent'] = 'none'): Promise<UrlCapture> {
  const page = await session.newPage();
  await installTransform(page, transform);
  const consoleMsgs: string[] = [];
  const failed: UrlCapture['failed'] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(consoleSignature(m.text()));
  });
  page.on('pageerror', (e) => consoleMsgs.push(consoleSignature(`uncaught ${e.message}`)));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push({ url: r.url().split('?')[0]!, status: r.status(), type: r.request().resourceType() });
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (!/BLOCKED_BY_CLIENT|ERR_ABORTED/.test(f)) failed.push({ url: r.url().split('?')[0]!, type: r.resourceType() });
  });
  const beaconStart = session.beacons.length;
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  if (consent === 'granted') await setConsent(page, 'granted');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  // let late content settle (banners inserted after load), then bring lazy images in
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const shot = join(dir, `${slugUrl(url)}.${viewport}.png`);
  await page.screenshot({ path: shot, fullPage: true, animations: 'disabled', mask: masks.map((m) => page.locator(m)), maskColor: '#ff00ff', caret: 'hide' });
  const st = await page.evaluate(() => {
    const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? null;
    const sp = (window as unknown as { __sp?: { shifts: Array<{ value: number }>; csp: Array<{ directive: string; blocked: string }> } }).__sp;
    const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => {
      try {
        return JSON.stringify(JSON.parse(s.textContent ?? 'null'));
      } catch {
        return 'invalid';
      }
    });
    const facades = Array.from(document.querySelectorAll('lite-youtube, lite-vimeo, [data-facade], .sp-facade')).filter((el) => (el as HTMLElement).tabIndex < 0 && !el.querySelector('button, a[href]')).map((el) => el.tagName.toLowerCase());
    return {
      title: document.title || null,
      description: meta('description'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      robots: meta('robots'),
      hreflang: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => `${l.getAttribute('hreflang')} ${l.getAttribute('href')}`).sort(),
      jsonLd: ld.sort(),
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null,
      imgWithoutAlt: Array.from(document.images).filter((i) => !i.hasAttribute('alt')).length,
      facades,
      cls: (sp?.shifts ?? []).reduce((a, s) => a + s.value, 0),
      csp: (sp?.csp ?? []).map((c) => `${c.directive} ${c.blocked}`),
    };
  });
  const html = await page.content();
  await page.close();
  return {
    url,
    viewport,
    screenshot: shot,
    console: [...new Set(consoleMsgs)],
    failed,
    mixed: url.startsWith('https:') ? failed.filter((f) => f.url.startsWith('http:')).map((f) => f.url) : [],
    csp: st.csp,
    seo: { status: resp?.status() ?? null, title: st.title, description: st.description, canonical: st.canonical, robots: st.robots, robotsHeader: resp?.headers()['x-robots-tag'] ?? null, hreflang: st.hreflang, jsonLd: st.jsonLd, ogImage: st.ogImage },
    imgWithoutAlt: st.imgWithoutAlt,
    facadesNotFocusable: st.facades,
    phpNotices: (html.match(/<b>(Notice|Warning|Deprecated|Fatal error)<\/b>:/g) ?? []).length,
    liquidErrors: (html.match(/Liquid (syntax )?error/g) ?? []).length,
    cls: Math.round(st.cls * 10000) / 10000,
    beacons: session.beacons.slice(beaconStart).map((b) => ({ vendor: b.vendor, event: b.event ?? '(none)' })),
  };
}

export interface CaptureOptions {
  base: string;
  urls: string[];
  flows: Flow[];
  outDir: string;
  stage: 'local' | 'staging' | 'production';
  viewports?: Array<'mobile' | 'tablet' | 'desktop'>;
  masks?: string[];
  consent?: Capture['consent'];
  transform?: ResponseTransform;
  earlyPaint?: boolean;
  httpCredentials?: { username: string; password: string };
}

/** Captures everything the verification compares (SPEC.md 6). */
export async function capture(browser: Browser, cfg: SiteConfig, o: CaptureOptions): Promise<Capture> {
  mkdirSync(o.outDir, { recursive: true });
  const viewports = o.viewports ?? ['mobile', 'tablet', 'desktop'];
  const local = o.stage !== 'production';
  const allow = local ? [/.*/] : [/\/cart\/add|add-to-cart|wc-ajax=add_to_cart|\/cart\/change|wc\/store\/v1\/cart/];
  const urls: UrlCapture[] = [];
  for (const vp of viewports) {
    const session = await openSession(browser, { device: vp, local, mutationAllowlist: allow, httpCredentials: o.httpCredentials });
    try {
      for (const u of o.urls) {
        const url = rebase(u, o.base);
        const c = await readUrl(session, url, vp, o.outDir, o.masks ?? cfg.masks, o.transform, o.consent);
        if (o.earlyPaint !== false && vp === 'mobile') c.earlyPaint = await earlyPaint(session, url, join(o.outDir, `${slugUrl(url)}.${vp}.early.png`), o.transform);
        urls.push(c);
      }
    } finally {
      await session.close();
    }
  }
  const flows: FlowCapture[] = [];
  for (const flow of o.flows) {
    const vps = flow.viewport === 'all' ? (['mobile', 'desktop'] as const) : ([flow.viewport] as const);
    for (const vp of vps) {
      const session = await openSession(browser, { device: vp, local, mutationAllowlist: allow, httpCredentials: o.httpCredentials });
      const page = await session.newPage();
      await installTransform(page, o.transform);
      const msgs: string[] = [];
      page.on('pageerror', (e) => msgs.push(consoleSignature(`uncaught ${e.message}`)));
      page.on('console', (m) => m.type() === 'error' && msgs.push(consoleSignature(m.text())));
      const start = session.beacons.length;
      const r = await runFlow(page, flow, o.base, o.stage);
      flows.push({ name: flow.name, viewport: vp, ...r, beacons: session.beacons.slice(start).map((b) => ({ vendor: b.vendor, event: b.event ?? '(none)' })), console: [...new Set(msgs)] });
      await session.close();
    }
  }
  const cap: Capture = { createdAt: new Date().toISOString(), base: o.base, consent: o.consent ?? 'none', urls, flows };
  writeFileSync(join(o.outDir, `capture.${cap.consent}.json`), JSON.stringify(cap, null, 1));
  return cap;
}

export { VIEWPORTS };
