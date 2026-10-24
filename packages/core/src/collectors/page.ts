import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, CDPSession } from 'playwright';
import { ownerOf, type Owner, type OwnerContext } from './owners.js';
import type { Session, Device } from './browser.js';
import { VIEWPORTS } from './browser.js';
import { redact } from '../log.js';
import { slugUrl } from './lighthouse.js';

export interface RequestRow {
  url: string;
  type: string;
  method: string;
  status: number | null;
  transferBytes: number;
  decodedBytes: number;
  priority?: string;
  protocol?: string;
  renderBlocking?: string;
  initiator?: { type: string; url?: string; stack?: string[] };
  cacheControl?: string;
  contentEncoding?: string;
  cookieBytes: number;
  startMs?: number;
  durationMs?: number;
  owner: Owner;
  failed?: string;
  fromServiceWorker?: boolean;
}

export interface CoverageRow {
  url: string;
  type: 'js' | 'css';
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  owner: Owner;
  inline: boolean;
}

export interface ImageRow {
  src: string;
  currentSrc: string;
  tag: 'img' | 'background';
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  dpr: number;
  loading: string | null;
  fetchpriority: string | null;
  decoding: string | null;
  srcset: string | null;
  sizes: string | null;
  hasWidthAttr: boolean;
  hasHeightAttr: boolean;
  hasAspectRatio: boolean;
  aboveFold: boolean;
  bytes?: number;
  format?: string;
  alt: string | null;
  selector: string;
  lazyClass: boolean;
}

export interface FontRow {
  family: string;
  weight: string;
  style: string;
  display: string | null;
  src: string | null;
  format?: string;
  preloaded: boolean;
  source: 'self' | 'google' | 'shopify' | 'adobe' | 'other';
  unicodeRange?: string;
  bytes?: number;
  loaded: boolean;
}

export interface DocumentStats {
  htmlBytes: number;
  domElements: number;
  domDepth: number;
  maxChildren: number;
  maxChildrenSelector: string | null;
  inlineCssBytes: number;
  inlineJsBytes: number;
  inlineJsonBytes: number;
  largestInlineJson: { id: string | null; bytes: number } | null;
  iframes: number;
  headBlocking: Array<{ tag: string; url: string | null; inline: boolean }>;
  imports: string[];
  preloads: Array<{ href: string; as: string | null; used: boolean; crossorigin: boolean }>;
  preconnects: string[];
  dnsPrefetch: string[];
  viewportMeta: string | null;
  docWrite: Array<{ caller: { url: string; line: number } | null; bytes: number }>;
  nonPassiveListeners: Array<{ type: string; target: string | null; preventsDefault: boolean; caller: { url: string } | null }>;
  animations: Array<{ selector: string | null; properties: string[]; composited: boolean; aboveFold: boolean }>;
  entranceAnimations: Array<{ selector: string; opacity: number; transform: string }>;
  preloader: { selector: string; coversViewport: boolean } | null;
  serviceWorker: boolean;
  forms: number;
  oembedLinks: number;
  speculationRules: { inline: number; header: string | null };
}

export interface MediaRow {
  kind: 'video' | 'iframe';
  src: string | null;
  provider: 'youtube' | 'vimeo' | 'wistia' | 'maps' | 'social' | 'booking' | 'other' | null;
  autoplay: boolean;
  poster: string | null;
  preload: string | null;
  aboveFold: boolean;
  facade: boolean;
  width: number;
  height: number;
}

export interface SeoSnapshot {
  status: number | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  robotsHeader: string | null;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLd: unknown[];
  jsonLdTypes: string[];
  ogImage: string | null;
  h1: string[];
  internalLinks: number;
}

export interface ErrorSnapshot {
  console: Array<{ type: 'error' | 'warning'; text: string; url?: string }>;
  pageErrors: string[];
  failedRequests: Array<{ url: string; status?: number; failure?: string }>;
  mixedContent: string[];
  csp: Array<{ directive: string; blocked: string }>;
  deprecations: string[];
  jqmigrate: string[];
  liquidErrors: string[];
  phpNotices: string[];
}

export interface LcpInfo {
  selector: string | null;
  tag: string | null;
  url: string | null;
  startTime: number;
  phases: { ttfb: number; loadDelay: number; loadDuration: number; renderDelay: number } | null;
  isImage: boolean;
  lazy: boolean | null;
  fetchpriority: string | null;
}

export interface ClsCulprit {
  selector: string | null;
  value: number;
  cause: 'web-font' | 'image-without-size' | 'injected-content' | 'animation' | 'unknown';
  startTime: number;
}

export interface LoafRow {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: Array<{ sourceURL: string; sourceFunctionName: string; invoker: string; duration: number; owner: Owner }>;
}

export interface PageEvidence {
  url: string;
  finalUrl: string;
  device: Device;
  consent: 'denied' | 'granted' | 'none';
  status: number | null;
  responseHeaders: Record<string, string>;
  timing: { ttfb: number; fcp: number | null; dcl: number; load: number };
  requests: RequestRow[];
  coverage: CoverageRow[];
  images: ImageRow[];
  fonts: FontRow[];
  media: MediaRow[];
  document: DocumentStats;
  errors: ErrorSnapshot;
  seo: SeoSnapshot;
  beacons: Array<{ vendor: string; event?: string; url: string }>;
  lcp: LcpInfo | null;
  cls: { total: number; culprits: ClsCulprit[] };
  loaf: LoafRow[];
  longTasks: Array<{ startTime: number; duration: number }>;
  screenshots: string[];
  tracePath?: string;
  html: string;
}

export interface CollectOptions {
  outDir: string;
  ownerCtx: OwnerContext;
  /** Interactions to run before taking coverage (template-specific, safe list only). */
  interact?: (page: Page) => Promise<void>;
  screenshots?: boolean;
  masks?: string[];
  trace?: boolean;
  consent?: 'denied' | 'granted' | 'none';
  waitAfterLoadMs?: number;
}

function header(h: Record<string, string>, name: string): string | undefined {
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

/** Collects everything SPEC.md 3.3 to 3.8, 3.11 and 3.12 need for one URL, device and consent state. Read-only. */
export async function collectPage(session: Session, url: string, device: Device, opts: CollectOptions): Promise<PageEvidence> {
  const page = await session.newPage();
  const beaconStart = session.beacons.length;
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const reqMeta = new Map<string, { priority?: string; initiator?: RequestRow['initiator']; url: string; renderBlocking?: string }>();
  const cdpResp = new Map<string, { protocol?: string; encodedDataLength?: number; fromServiceWorker?: boolean }>();
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string; initialPriority?: string }; initiator: { type: string; url?: string; stack?: { callFrames: Array<{ url: string; functionName: string; lineNumber: number }> } }; renderBlockingBehavior?: string }) => {
    reqMeta.set(e.request.url, {
      url: e.request.url,
      priority: e.request.initialPriority,
      renderBlocking: e.renderBlockingBehavior,
      initiator: { type: e.initiator.type, url: e.initiator.url ?? e.initiator.stack?.callFrames[0]?.url, stack: e.initiator.stack?.callFrames.slice(0, 5).map((f) => `${f.functionName || '(anonymous)'}@${f.url}:${f.lineNumber + 1}`) },
    });
  });
  cdp.on('Network.responseReceived', (e: { requestId: string; response: { url: string; protocol?: string; fromServiceWorker?: boolean } }) => {
    cdpResp.set(e.response.url, { protocol: e.response.protocol, fromServiceWorker: e.response.fromServiceWorker });
  });
  cdp.on('Network.loadingFinished', (e: { requestId: string; encodedDataLength: number }) => {
    // matched later by URL through Playwright sizes
    void e;
  });

  const consoleMsgs: ErrorSnapshot['console'] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') consoleMsgs.push({ type: t === 'error' ? 'error' : 'warning', text: m.text().slice(0, 500), url: m.location()?.url });
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 500)));

  const rows: RequestRow[] = [];
  const failed: ErrorSnapshot['failedRequests'] = [];
  const pending: Array<Promise<void>> = [];
  page.on('requestfinished', (req) => {
    pending.push(
      (async () => {
        const res = await req.response();
        const headers = res ? await res.allHeaders().catch(() => ({}) as Record<string, string>) : {};
        const reqHeaders = await req.allHeaders().catch(() => ({}) as Record<string, string>);
        const sizes = await req.sizes().catch(() => ({ responseBodySize: 0, responseHeadersSize: 0, requestHeadersSize: 0 }));
        const t = req.timing();
        const meta = reqMeta.get(req.url());
        const status = res?.status() ?? null;
        const encoding = header(headers, 'content-encoding');
        const decoded = res ? Number(header(headers, 'content-length') ?? 0) : 0;
        rows.push({
          url: req.url(),
          type: req.resourceType(),
          method: req.method(),
          status,
          transferBytes: sizes.responseBodySize + sizes.responseHeadersSize,
          decodedBytes: decoded && !encoding ? decoded : sizes.responseBodySize,
          priority: meta?.priority,
          protocol: cdpResp.get(req.url())?.protocol,
          renderBlocking: meta?.renderBlocking,
          initiator: meta?.initiator,
          cacheControl: header(headers, 'cache-control'),
          contentEncoding: encoding,
          cookieBytes: (header(reqHeaders, 'cookie') ?? '').length,
          startMs: t.startTime > 0 ? t.startTime : undefined,
          durationMs: t.responseEnd > 0 ? t.responseEnd : undefined,
          owner: ownerOf(req.url(), opts.ownerCtx),
          fromServiceWorker: cdpResp.get(req.url())?.fromServiceWorker,
        });
        if (status && status >= 400) failed.push({ url: req.url(), status });
      })(),
    );
  });
  page.on('requestfailed', (req) => {
    const f = req.failure()?.errorText ?? 'failed';
    if (f.includes('BLOCKED_BY_CLIENT') || f === 'net::ERR_BLOCKED_BY_CLIENT') return; // our own beacon/mutation blocking
    failed.push({ url: req.url(), failure: f });
    rows.push({ url: req.url(), type: req.resourceType(), method: req.method(), status: null, transferBytes: 0, decodedBytes: 0, cookieBytes: 0, owner: ownerOf(req.url(), opts.ownerCtx), failed: f });
  });

  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });

  const traceName = `${slugUrl(url)}.${device}.${opts.consent ?? 'none'}`;
  let tracePath: string | undefined;
  if (opts.trace) {
    tracePath = join(opts.outDir, 'traces', `${traceName}.trace.json`);
    await page.context().browser()!.startTracing(page, { path: tracePath, screenshots: true, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'loading', 'blink.user_timing', 'v8.execute', 'disabled-by-default-devtools.timeline.frame', 'latencyInfo'] });
  }

  const response = await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForTimeout(opts.waitAfterLoadMs ?? 3000);
  if (opts.trace) await page.context().browser()!.stopTracing();

  const html = await page.content();
  const responseHeaders = response ? await response.allHeaders() : {};

  // Page state is read right after load, before interactions can change or navigate the page.
  const inPage = await page.evaluate(gatherInPage, { vh: VIEWPORTS[device].height });

  // Coverage after load and after the scripted interactions.
  if (opts.interact) await opts.interact(page).catch(() => {});
  const jsCov = await page.coverage.stopJSCoverage();
  const cssCov = await page.coverage.stopCSSCoverage();
  const coverage: CoverageRow[] = [];
  for (const c of jsCov) {
    const total = c.source?.length ?? 0;
    if (!total) continue;
    // Function-level ranges: count bytes covered by at least one range with count > 0 in the outermost function.
    const used = usedJsBytes(c.functions, total);
    coverage.push({ url: c.url, type: 'js', totalBytes: total, usedBytes: used, unusedBytes: total - used, owner: ownerOf(c.url, opts.ownerCtx), inline: c.url === url || c.url === response?.url() });
  }
  for (const c of cssCov) {
    const total = c.text?.length ?? 0;
    if (!total) continue;
    const used = c.ranges.reduce((a, r) => a + (r.end - r.start), 0);
    const inline = !c.url || c.url === url;
    coverage.push({ url: c.url || `${url}#inline-css`, type: 'css', totalBytes: total, usedBytes: used, unusedBytes: total - used, owner: ownerOf(c.url || url, opts.ownerCtx), inline });
  }

  await Promise.all(pending);
  // interactions may have navigated away: come back for screenshots
  if (opts.screenshots && page.url() !== (response?.url() ?? url)) await page.goto(url, { waitUntil: 'load' }).catch(() => {});

  const errors: ErrorSnapshot = {
    console: consoleMsgs,
    pageErrors,
    failedRequests: failed,
    mixedContent: new URL(url).protocol === 'https:' ? rows.filter((r) => r.url.startsWith('http://')).map((r) => r.url) : [],
    csp: inPage.csp,
    deprecations: consoleMsgs.filter((m) => /deprecat/i.test(m.text)).map((m) => m.text),
    jqmigrate: consoleMsgs.filter((m) => /JQMIGRATE/.test(m.text)).map((m) => m.text),
    liquidErrors: [...html.matchAll(/Liquid (syntax )?error[^<]{0,200}/g)].map((m) => m[0]),
    phpNotices: [...html.matchAll(/<b>(Notice|Warning|Deprecated|Fatal error)<\/b>:[^<]{0,200}/g)].map((m) => m[0]),
  };

  // image byte sizes from the request log
  for (const img of inPage.images) {
    const r = rows.find((x) => x.url === img.currentSrc || x.url === img.src);
    if (r) {
      img.bytes = r.decodedBytes || r.transferBytes;
      img.format = (r.url.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
    }
  }
  for (const f of inPage.fonts) {
    const r = f.src ? rows.find((x) => x.url === f.src) : undefined;
    if (r) f.bytes = r.decodedBytes || r.transferBytes;
  }

  // LCP phases (SPEC.md 3.3)
  const nav = inPage.nav;
  let lcp: LcpInfo | null = null;
  const last = inPage.lcp[inPage.lcp.length - 1];
  if (last) {
    const res = last.url ? inPage.resources.find((r) => r.name === last.url) : undefined;
    const ttfb = nav.responseStart;
    let phases: LcpInfo['phases'] = null;
    if (res) {
      const reqStart = res.requestStart || res.startTime;
      phases = { ttfb, loadDelay: Math.max(0, reqStart - ttfb), loadDuration: Math.max(0, res.responseEnd - reqStart), renderDelay: Math.max(0, last.startTime - Math.max(res.responseEnd, ttfb)) };
    } else phases = { ttfb, loadDelay: 0, loadDuration: 0, renderDelay: Math.max(0, last.startTime - ttfb) };
    const imgRow = inPage.images.find((i) => last.url && (i.currentSrc === last.url || i.src === last.url));
    lcp = { selector: last.selector, tag: last.tag, url: last.url, startTime: last.startTime, phases, isImage: !!last.url, lazy: imgRow ? imgRow.loading === 'lazy' || imgRow.lazyClass : null, fetchpriority: imgRow?.fetchpriority ?? null };
  }

  // CLS culprits with cause
  const culprits: ClsCulprit[] = [];
  const fontLoads = rows.filter((r) => r.type === 'font' && r.durationMs).map((r) => (r.startMs ?? 0) + (r.durationMs ?? 0));
  for (const s of inPage.shifts) {
    const src = s.sources[0];
    const img = src?.selector ? inPage.images.find((i) => i.selector === src.selector) : undefined;
    let cause: ClsCulprit['cause'] = 'unknown';
    if (img && !img.hasWidthAttr && !img.hasAspectRatio) cause = 'image-without-size';
    else if (src?.tag === 'img') cause = 'image-without-size';
    else if (src && src.previousRect && src.previousRect.h === 0) cause = 'injected-content';
    else if (src && src.previousRect && src.currentRect && src.previousRect.y !== src.currentRect.y && fontLoads.some((t) => Math.abs(t - s.startTime) < 150)) cause = 'web-font';
    else if (src && src.previousRect && src.currentRect && src.previousRect.y !== src.currentRect.y) cause = inPage.document.animations.some((a) => a.selector === src.selector && !a.composited) ? 'animation' : 'injected-content';
    culprits.push({ selector: src?.selector ?? null, value: s.value, cause, startTime: s.startTime });
  }
  const clsTotal = sessionWindowCls(inPage.shifts);

  const loaf: LoafRow[] = inPage.loaf.map((f) => ({ ...f, scripts: f.scripts.map((s) => ({ sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName, invoker: s.invoker, duration: s.duration, owner: ownerOf(s.sourceURL || url, opts.ownerCtx) })) }));

  // Screenshots (SPEC.md 3.12)
  const screenshots: string[] = [];
  if (opts.screenshots) {
    const mask = (opts.masks ?? []).map((m) => page.locator(m));
    for (const w of [390, 768, 1440]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : w === 768 ? 1024 : 900 });
      await page.waitForTimeout(200);
      const p = join(opts.outDir, 'screenshots', `${traceName}.${w}.full.png`);
      await page.screenshot({ path: p, fullPage: true, mask, animations: 'disabled' }).catch(() => {});
      screenshots.push(p);
      const f = join(opts.outDir, 'screenshots', `${traceName}.${w}.fold.png`);
      await page.screenshot({ path: f, fullPage: false, mask, animations: 'disabled' }).catch(() => {});
      screenshots.push(f);
    }
    await page.setViewportSize({ width: VIEWPORTS[device].width, height: VIEWPORTS[device].height });
    for (const [name, selector] of [['header', 'header, .site-header, .header'], ['hero', '.hero, [class*="hero"]'], ['product-form', 'form.cart, form[action*="/cart/add"], .product-form'], ['footer', 'footer, .site-footer, .footer']] as const) {
      const el = page.locator(selector).first();
      if (await el.count().catch(() => 0)) {
        const p = join(opts.outDir, 'screenshots', `${traceName}.el-${name}.png`);
        await el.screenshot({ path: p, mask, animations: 'disabled', timeout: 5000 }).catch(() => {});
        screenshots.push(p);
      }
    }
  }

  await page.close();
  const evidence: PageEvidence = {
    url,
    finalUrl: response?.url() ?? url,
    device,
    consent: opts.consent ?? 'none',
    status: response?.status() ?? null,
    responseHeaders: redact(responseHeaders),
    timing: { ttfb: nav.responseStart, fcp: inPage.fcp, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd },
    requests: rows,
    coverage,
    images: inPage.images,
    fonts: inPage.fonts,
    media: inPage.media,
    document: { ...inPage.document, htmlBytes: Buffer.byteLength(html), docWrite: inPage.docWrite, nonPassiveListeners: inPage.listeners.filter((l) => !l.passive && !l.preventsDefault), speculationRules: { inline: inPage.document.speculationRules.inline, header: header(responseHeaders, 'speculation-rules') ?? null } },
    errors,
    seo: { ...inPage.seo, status: response?.status() ?? null, robotsHeader: header(responseHeaders, 'x-robots-tag') ?? null },
    beacons: session.beacons.slice(beaconStart).map((b) => ({ vendor: b.vendor, event: b.event, url: b.url })),
    lcp,
    cls: { total: clsTotal, culprits },
    loaf,
    longTasks: inPage.longtasks,
    screenshots,
    tracePath,
    html,
  };
  writeFileSync(join(opts.outDir, 'logs', `${traceName}.evidence.json`), JSON.stringify(redact({ ...evidence, html: undefined }), null, 1));
  return evidence;
}

/** Bytes of a script that ran: union of ranges with count > 0, minus nested ranges with count 0. */
export function usedJsBytes(functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>, total: number): number {
  const mark = new Uint8Array(total);
  // apply ranges in order: Chrome reports nested ranges after their parents
  const ranges = functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) mark.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(total, r.endOffset));
  let used = 0;
  for (let i = 0; i < total; i++) used += mark[i]!;
  return used;
}

/** CLS with session windows (1 s gap, 5 s max), the web-vitals definition. */
export function sessionWindowCls(shifts: Array<{ value: number; startTime: number }>): number {
  let max = 0;
  let cur = 0;
  let first = 0;
  let prev = 0;
  for (const s of [...shifts].sort((a, b) => a.startTime - b.startTime)) {
    if (cur && (s.startTime - prev > 1000 || s.startTime - first > 5000)) {
      max = Math.max(max, cur);
      cur = 0;
    }
    if (!cur) first = s.startTime;
    cur += s.value;
    prev = s.startTime;
  }
  return Math.round(Math.max(max, cur) * 10000) / 10000;
}

/** Runs inside the page. Must be self-contained. */
function gatherInPage({ vh }: { vh: number }) {
  const w = window as unknown as {
    __sp: {
      lcp: Array<{ startTime: number; url: string | null; selector: string | null; tag: string | null }>;
      shifts: Array<{ value: number; startTime: number; sources: Array<{ selector: string | null; tag: string | null; previousRect?: { y: number; h: number }; currentRect?: { y: number; h: number } }> }>;
      loaf: Array<{ startTime: number; duration: number; blockingDuration: number; scripts: Array<{ sourceURL: string; sourceFunctionName: string; invoker: string; duration: number }> }>;
      longtasks: Array<{ startTime: number; duration: number }>;
      docWrite: Array<{ caller: { url: string; line: number } | null; bytes: number }>;
      listeners: Array<{ type: string; passive: boolean; preventsDefault: boolean; target: string | null; caller: { url: string } | null }>;
      csp: Array<{ directive: string; blocked: string }>;
      sel(n: Element | null): string | null;
    };
  };
  const sp = w.__sp ?? { lcp: [], shifts: [], loaf: [], longtasks: [], docWrite: [], listeners: [], csp: [], sel: () => null };
  const sel = (n: Element | null) => (sp.sel ? sp.sel(n) : null) ?? '';
  const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined) ?? ({ responseStart: 0, domContentLoadedEventEnd: 0, loadEventEnd: 0 } as PerformanceNavigationTiming);
  const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
  const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({ name: r.name, startTime: r.startTime, requestStart: r.requestStart, responseEnd: r.responseEnd, renderBlockingStatus: (r as unknown as { renderBlockingStatus?: string }).renderBlockingStatus ?? null, initiatorType: r.initiatorType, transferSize: r.transferSize, decodedBodySize: r.decodedBodySize }));

  const images: ImageRow[] = [];
  document.querySelectorAll('img').forEach((img) => {
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    images.push({
      src: img.src,
      currentSrc: img.currentSrc || img.src,
      tag: 'img',
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      dpr: window.devicePixelRatio,
      loading: img.getAttribute('loading'),
      fetchpriority: img.getAttribute('fetchpriority'),
      decoding: img.getAttribute('decoding'),
      srcset: img.getAttribute('srcset'),
      sizes: img.getAttribute('sizes'),
      hasWidthAttr: img.hasAttribute('width'),
      hasHeightAttr: img.hasAttribute('height'),
      hasAspectRatio: cs.aspectRatio !== 'auto' && cs.aspectRatio !== '',
      aboveFold: r.top < vh && r.bottom > 0 && r.width > 0,
      alt: img.getAttribute('alt'),
      selector: sel(img),
      lazyClass: /\blazy(load)?\b|lazyload|data-src/.test(img.className + ' ' + (img.getAttribute('data-src') ? 'data-src' : '')),
    });
  });
  // CSS background images on large elements
  document.querySelectorAll('body *').forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) return;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 20000) return;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
    if (!m) return;
    images.push({ src: new URL(m[1]!, location.href).href, currentSrc: new URL(m[1]!, location.href).href, tag: 'background', naturalWidth: 0, naturalHeight: 0, renderedWidth: Math.round(r.width), renderedHeight: Math.round(r.height), dpr: window.devicePixelRatio, loading: null, fetchpriority: null, decoding: null, srcset: null, sizes: null, hasWidthAttr: true, hasHeightAttr: true, hasAspectRatio: true, aboveFold: r.top < vh && r.bottom > 0, alt: null, selector: sel(el), lazyClass: false });
  });

  // Fonts: @font-face rules from accessible stylesheets + document.fonts state + resource entries
  const fonts: FontRow[] = [];
  const preloads = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"]'));
  const fontSource = (u: string | null): FontRow['source'] => (!u ? 'other' : /fonts\.(gstatic|googleapis)\.com/.test(u) ? 'google' : /cdn\.shopify\.com|\/cdn\/fonts\//.test(u) ? 'shopify' : /use\.typekit|typekit\.net/.test(u) ? 'adobe' : new URL(u, location.href).host === location.host ? 'self' : 'other');
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules ?? [])) {
      if (rule.constructor.name !== 'CSSFontFaceRule') continue;
      const st = (rule as CSSFontFaceRule).style;
      const srcM = /url\(["']?([^"')]+)["']?\)(\s*format\(["']?([^"')]+)["']?\))?/.exec(st.getPropertyValue('src'));
      const src = srcM ? new URL(srcM[1]!, sheet.href ?? location.href).href : null;
      const family = st.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const weight = st.getPropertyValue('font-weight') || '400';
      const used = Array.from(document.fonts).some((f) => f.family.replace(/["']/g, '') === family && f.weight === weight && f.status === 'loaded');
      fonts.push({ family, weight, style: st.getPropertyValue('font-style') || 'normal', display: st.getPropertyValue('font-display') || null, src, format: srcM?.[3], preloaded: !!src && preloads.some((p) => p.as === 'font' && p.href === src), source: fontSource(src), unicodeRange: st.getPropertyValue('unicode-range') || undefined, loaded: used });
    }
  }
  // cross-origin stylesheets (Google Fonts) cannot be read: fall back to loaded font resources
  for (const r of resources.filter((x) => /\.(woff2?|ttf|otf|eot)(\?|$)/.test(x.name) || /fonts\.gstatic\.com/.test(x.name))) {
    if (fonts.some((f) => f.src === r.name)) continue;
    fonts.push({ family: '(cross-origin)', weight: '?', style: '?', display: null, src: r.name, format: r.name.split('?')[0]!.split('.').pop(), preloaded: preloads.some((p) => p.href === r.name), source: fontSource(r.name), loaded: true });
  }

  const media: MediaRow[] = [];
  document.querySelectorAll('video, iframe').forEach((el) => {
    const r = el.getBoundingClientRect();
    const src = (el as HTMLIFrameElement).src || (el as HTMLVideoElement).currentSrc || el.getAttribute('src');
    const provider = !src ? null : /youtube|youtu\.be/.test(src) ? 'youtube' : /vimeo/.test(src) ? 'vimeo' : /wistia/.test(src) ? 'wistia' : /google\.[a-z.]+\/maps|maps\.google/.test(src) ? 'maps' : /facebook|instagram|twitter|x\.com|tiktok/.test(src) ? 'social' : /calendly|booking|acuity/.test(src) ? 'booking' : 'other';
    media.push({ kind: el.tagName === 'VIDEO' ? 'video' : 'iframe', src, provider: el.tagName === 'VIDEO' ? null : provider, autoplay: el.hasAttribute('autoplay') || /autoplay=1/.test(src ?? ''), poster: el.getAttribute('poster'), preload: el.getAttribute('preload'), aboveFold: r.top < vh && r.bottom > 0, facade: false, width: Math.round(r.width), height: Math.round(r.height) });
  });
  document.querySelectorAll('lite-youtube, lite-vimeo, [data-facade], .youtube-facade').forEach(() => media.push({ kind: 'iframe', src: null, provider: 'youtube', autoplay: false, poster: null, preload: null, aboveFold: false, facade: true, width: 0, height: 0 }));

  // DOM stats
  let depth = 0;
  let maxChildren = 0;
  let maxChildrenSel: string | null = null;
  const all = document.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.children.length > maxChildren) {
      maxChildren = el.children.length;
      maxChildrenSel = sel(el);
    }
    if (i % 25 === 0) {
      let d = 0;
      for (let p: Element | null = el; p; p = p.parentElement) d++;
      depth = Math.max(depth, d);
    }
  }
  let inlineCss = 0;
  document.querySelectorAll('style').forEach((s) => (inlineCss += (s.textContent ?? '').length));
  let inlineJs = 0;
  let inlineJson = 0;
  let largest: { id: string | null; bytes: number } | null = null;
  document.querySelectorAll('script:not([src])').forEach((s) => {
    const len = (s.textContent ?? '').length;
    const type = s.getAttribute('type') ?? '';
    if (/json/.test(type)) {
      inlineJson += len;
      if (!largest || len > largest.bytes) largest = { id: s.id || type, bytes: len };
    } else {
      inlineJs += len;
      // localized data (var x = {...}) counts as inline data too
      const m = /^\s*var\s+[\w$]+\s*=\s*\{/.test(s.textContent ?? '');
      if (m && (!largest || len > largest.bytes)) largest = { id: s.id || 'localized-data', bytes: len };
    }
  });
  const headBlocking: DocumentStats['headBlocking'] = [];
  document.head.querySelectorAll('script, link[rel="stylesheet"]').forEach((el) => {
    if (el.tagName === 'SCRIPT') {
      const s = el as HTMLScriptElement;
      const type = s.type;
      if (s.async || s.defer || type === 'module' || (type && !/javascript|^$/.test(type))) return;
      headBlocking.push({ tag: 'script', url: s.src || null, inline: !s.src });
    } else {
      const l = el as HTMLLinkElement;
      if (l.media && l.media !== 'all' && !matchMedia(l.media).matches) return;
      if (l.disabled) return;
      headBlocking.push({ tag: 'link', url: l.href, inline: false });
    }
  });
  const imports: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) if (rule.constructor.name === 'CSSImportRule') imports.push((rule as CSSImportRule).href);
    } catch {}
  }
  const resNames = new Set(resources.map((r) => r.name));
  const animations: DocumentStats['animations'] = [];
  for (const a of document.getAnimations()) {
    const eff = a.effect as KeyframeEffect | null;
    const target = eff?.target as Element | null;
    const props = new Set<string>();
    for (const kf of eff?.getKeyframes() ?? []) for (const k of Object.keys(kf)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(k)) props.add(k);
    const list = [...props];
    const composited = list.every((p) => ['transform', 'opacity', 'translate', 'scale', 'rotate', 'filter'].includes(p));
    const r = target?.getBoundingClientRect();
    animations.push({ selector: target ? sel(target) : null, properties: list, composited, aboveFold: !!r && r.top < vh });
  }
  const entrance: DocumentStats['entranceAnimations'] = [];
  document.querySelectorAll('[class*="animate"], [class*="elementor-invisible"], [data-aos], .wow, [class*="fade"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top > vh) return;
    const cs = getComputedStyle(el);
    entrance.push({ selector: sel(el), opacity: Number(cs.opacity), transform: cs.transform });
  });
  const atDcl = (w.__sp as unknown as { overlayAtDcl?: { selector: string } }).overlayAtDcl;
  let preloader: DocumentStats['preloader'] = atDcl ? { selector: atDcl.selector, coversViewport: true } : null;
  document.querySelectorAll('[id*="preload"], [class*="preload"], [id*="loader"], [class*="page-loader"], [class*="loading-screen"]').forEach((el) => {
    if (el.tagName === 'LINK' || el.tagName === 'SCRIPT') return;
    const cs = getComputedStyle(el);
    if (!preloader && (cs.position === 'fixed' || cs.position === 'absolute')) {
      const r = el.getBoundingClientRect();
      preloader = { selector: sel(el), coversViewport: r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 };
    }
  });

  const seoJsonLd: unknown[] = [];
  const types: string[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const j = JSON.parse(s.textContent ?? 'null');
      seoJsonLd.push(j);
      const collect = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(collect);
        else if (x && typeof x === 'object') {
          const t = (x as Record<string, unknown>)['@type'];
          if (t) types.push(...(Array.isArray(t) ? t.map(String) : [String(t)]));
          const g = (x as Record<string, unknown>)['@graph'];
          if (g) collect(g);
        }
      };
      collect(j);
    } catch {
      seoJsonLd.push({ invalid: true });
    }
  });
  const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? null;

  return {
    nav: { responseStart: nav.responseStart, domContentLoadedEventEnd: nav.domContentLoadedEventEnd, loadEventEnd: nav.loadEventEnd },
    fcp: fcpEntry ? fcpEntry.startTime : null,
    resources,
    images,
    fonts,
    media,
    lcp: sp.lcp,
    shifts: sp.shifts,
    loaf: sp.loaf,
    longtasks: sp.longtasks,
    docWrite: sp.docWrite,
    listeners: sp.listeners,
    csp: sp.csp,
    document: {
      domElements: all.length,
      domDepth: depth,
      maxChildren,
      maxChildrenSelector: maxChildrenSel,
      inlineCssBytes: inlineCss,
      inlineJsBytes: inlineJs,
      inlineJsonBytes: inlineJson,
      largestInlineJson: largest,
      iframes: document.querySelectorAll('iframe').length,
      headBlocking,
      imports,
      preloads: preloads.map((p) => ({ href: p.href, as: p.getAttribute('as'), used: resNames.has(p.href), crossorigin: p.hasAttribute('crossorigin') })),
      preconnects: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preconnect"]')).map((l) => l.href),
      dnsPrefetch: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="dns-prefetch"]')).map((l) => l.href),
      viewportMeta: meta('viewport'),
      animations,
      entranceAnimations: entrance,
      preloader,
      serviceWorker: !!navigator.serviceWorker?.controller,
      forms: document.querySelectorAll('form').length,
      oembedLinks: document.querySelectorAll('link[type*="oembed"]').length,
      speculationRules: { inline: document.querySelectorAll('script[type="speculationrules"]').length, header: null as string | null },
    },
    seo: {
      title: document.title || null,
      description: meta('description'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      robotsMeta: meta('robots'),
      hreflang: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => ({ lang: l.getAttribute('hreflang')!, href: l.getAttribute('href')! })),
      jsonLd: seoJsonLd,
      jsonLdTypes: types,
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null,
      h1: Array.from(document.querySelectorAll('h1')).map((h) => (h.textContent ?? '').trim().slice(0, 200)),
      internalLinks: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) => a.host === location.host).length,
    },
  };
}
