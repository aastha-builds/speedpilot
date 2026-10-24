/** Evaluators for MEAS, NET, DOC, IMG, VID, FONT, CSS, JS, 3P and CLS checks (both platforms). */
import { type Evaluator, type Draft, type EvalContext, failing, lhAudit, mobile, pagesOf, uniquePages, kb, sameOrigin, hostOf, byKey } from './types.js';
import type { PageAudit } from '../audit.js';

const TEXT_TYPES = new Set(['document', 'stylesheet', 'script', 'xhr', 'fetch']);
const isVersioned = (u: string) => /[?&](ver|v|version)=|[.-][0-9a-f]{8,}\.(js|css|woff2?|png|jpe?g|webp|avif|svg)(\?|$)/.test(u);
const maxAge = (cc?: string) => Number(/max-age=(\d+)/.exec(cc ?? '')?.[1] ?? (/(no-store|no-cache)/.test(cc ?? '') ? 0 : NaN));

function vendorScripts(p: PageAudit, re: RegExp) {
  return p.evidence.requests.filter((r) => re.test(r.url));
}

function vendorCheck(re: RegExp, label: string, gainTbt = 50): Evaluator {
  return (ctx) => {
    const hits = uniquePages(ctx).filter((p) => vendorScripts(p, re).length || re.test(p.evidence.requests.map((r) => r.url).join(' ')));
    if (!hits.length) return [];
    const reqs = hits.flatMap((p) => vendorScripts(p, re));
    return [{ urls: hits.map((p) => p.url), evidence: { vendor: label, requests: [...new Set(reqs.map((r) => r.url))].slice(0, 10), kb: kb(reqs.reduce((a, r) => a + r.transferBytes, 0)) / Math.max(1, hits.length) }, gain: { tbtMs: gainTbt }, rootCause: reqs[0]?.owner.id ?? label }];
  };
}

function scriptMainThread(p: PageAudit, re: RegExp): number {
  const bootup = lhAudit(p, 'bootupTime')?.items as Array<{ url: string; total: number }> | undefined;
  return (bootup ?? []).filter((i) => re.test(i.url)).reduce((a, i) => a + (i.total ?? 0), 0);
}

export const frontEvaluators: Record<string, Evaluator> = {
  // ---------------- MEAS ----------------
  'MEAS-01': (ctx) => {
    const bad = pagesOf(ctx).filter((p) => p.lighthouse && (p.lighthouse.runs < 5 || (p.lighthouse.range.score.max ?? 0) - (p.lighthouse.range.score.min ?? 0) > 10));
    return bad.length ? [{ urls: bad.map((p) => p.url), evidence: { runs: bad.map((p) => ({ url: p.url, device: p.device, runs: p.lighthouse!.runs, min: p.lighthouse!.range.score.min, max: p.lighthouse!.range.score.max })) } }] : [];
  },
  'MEAS-02': (ctx) => {
    if (ctx.cfg.local) return [];
    const rows = ctx.wp?.perUrl ?? [];
    const missing = rows.filter((r) => !Object.keys(r.cacheHeaders).some((k) => ['x-cache', 'cf-cache-status', 'age', 'x-litespeed-cache', 'x-proxy-cache', 'x-sg-cache', 'x-kinsta-cache'].includes(k)));
    return missing.length ? [{ urls: missing.map((r) => r.url), evidence: { note: 'no cache-status headers; TTFB measured both cached and bypassed', ttfb: missing.map((r) => ({ url: r.url, cached: r.ttfbCachedMs, bypass: r.ttfbBypassMs })) } }] : [];
  },
  'MEAS-03': (ctx) => (ctx.audit.inventory.variants.consentTool || ctx.cfg.consent.tool ? [{ urls: [ctx.cfg.productionUrl], evidence: { consentTool: ctx.audit.inventory.variants.consentTool ?? ctx.cfg.consent.tool, grantedRun: pagesOf(ctx).some((p) => p.evidenceGranted) } }] : []),
  'MEAS-04': (ctx) => {
    const r = uniquePages(ctx).filter((p) => p.evidence.finalUrl.replace(/\/$/, '') !== p.url.replace(/\/$/, ''));
    return r.length ? [{ urls: r.map((p) => p.url), evidence: { redirects: r.map((p) => ({ from: p.url, to: p.evidence.finalUrl })) } }] : [];
  },
  'MEAS-05': (ctx) => (ctx.wp?.plugins.some((p) => p.status === 'active' && /woocommerce|memberpress|paid-memberships|restrict-content|b2bking/.test(p.name)) ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: ctx.wp.plugins.filter((p) => p.status === 'active' && /woocommerce|member|b2b/.test(p.name)).map((p) => p.name), note: 'add a logged-in sample and logged-in flows in site.yaml' } }] : []),
  'MEAS-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.status === 401 || /\/password$/.test(p.evidence.finalUrl) || p.evidence.requests.some((r) => /preview_bar|preview-bar/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { statuses: hits.map((p) => ({ url: p.url, status: p.evidence.status, final: p.evidence.finalUrl })) } }] : [];
  },
  'MEAS-07': (ctx) => {
    const origin = ctx.audit.field.find((f) => f.scope === 'origin' && f.formFactor === 'PHONE' && f.status === 'ok');
    if (!origin) return [];
    const labLcp = mobile(ctx).map((p) => p.lighthouse?.median.lcp ?? 0);
    const lab = labLcp.length ? labLcp.reduce((a, b) => a + b, 0) / labLcp.length : null;
    const field = origin.metrics.lcp;
    if (lab === null || field === undefined) return [];
    const disagree = (lab <= 2500) !== (field <= 2500);
    return disagree ? [{ urls: [ctx.cfg.productionUrl], evidence: { labLcpMs: Math.round(lab), fieldLcpP75: field, note: 'field data decides what real users get' } }] : [];
  },
  'MEAS-08': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.status === 403 || p.evidence.status === 429 || /captcha|cf-chl|challenge-platform|Attention Required/i.test(JSON.stringify(p.evidence.seo.title ?? '')));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { statuses: hits.map((p) => p.evidence.status) }, note: 'slow down and ask the client to allowlist the test IP; never bypass a security tool' }] : [];
  },
  'MEAS-10': (ctx) => {
    const beacons = pagesOf(ctx).flatMap((p) => p.evidence.beacons);
    return beacons.length ? [{ urls: [...new Set(pagesOf(ctx).filter((p) => p.evidence.beacons.length).map((p) => p.url))], evidence: { recordedAndAborted: beacons.length, vendors: [...new Set(beacons.map((b) => b.vendor))], leftTheBrowser: 0 }, note: 'all beacons were recorded then aborted (CLAUDE.md rule 12)' }] : [];
  },
  'MEAS-11': (ctx) => {
    const prev = ctx.previousVersions;
    if (!prev) return [];
    const diffs = ['chrome', 'lighthouse', 'web-vitals'].filter((k) => prev[k] && ctx.audit.versions[k] && prev[k] !== ctx.audit.versions[k]);
    return diffs.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { changed: diffs.map((k) => ({ tool: k, baseline: prev[k], now: ctx.audit.versions[k] })) }, note: 'take a new baseline before comparing numbers' }] : [];
  },

  // ---------------- NET ----------------
  'NET-01': (ctx) => {
    const slow = mobile(ctx).filter((p) => (p.lighthouse?.median.ttfb ?? p.evidence.timing.ttfb) > 800);
    const wpSlow = (ctx.wp?.perUrl ?? []).filter((r) => (r.ttfbBypassMs ?? 0) > 800);
    if (!slow.length && !wpSlow.length) return [];
    return [{ urls: [...new Set([...slow.map((p) => p.url), ...wpSlow.map((r) => r.url)])], evidence: { ttfb: slow.map((p) => ({ url: p.url, ms: Math.round(p.lighthouse?.median.ttfb ?? p.evidence.timing.ttfb) })), uncached: wpSlow.map((r) => ({ url: r.url, ms: r.ttfbBypassMs, serverTiming: r.serverTiming })) }, gain: { ttfbMs: Math.max(0, ...slow.map((p) => (p.lighthouse?.median.ttfb ?? 0) - 800)) } }];
  },
  'NET-02': (ctx) => {
    const r = uniquePages(ctx).filter((p) => p.evidence.requests.filter((q) => q.type === 'document' && q.status !== null && q.status >= 300 && q.status < 400).length > 1);
    return r.length ? [{ urls: r.map((p) => p.url), evidence: { chains: r.map((p) => p.evidence.requests.filter((q) => q.type === 'document').map((q) => `${q.status} ${q.url}`)) }, gain: { lcpMs: 150 } }] : [];
  },
  'NET-03': (ctx) => {
    const h1 = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.protocol === 'http/1.1' && sameOrigin(r.url, p.url)));
    if (!h1.length || ctx.cfg.local) return [];
    return [{ urls: [...new Set(h1.map((r) => new URL(r.url).origin))], evidence: { requests: h1.length, protocol: 'http/1.1' }, tier: 'T3' }];
  },
  'NET-04': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => TEXT_TYPES.has(r.type) && !r.contentEncoding && r.decodedBytes > 1400 && sameOrigin(r.url, p.url) && r.status === 200));
    const uniq = [...new Map(rows.map((r) => [r.url, r])).values()];
    if (!uniq.length) return [];
    const bytes = uniq.reduce((a, r) => a + r.decodedBytes, 0);
    return [{ urls: uniq.slice(0, 20).map((r) => r.url), evidence: { files: uniq.length, kb: kb(bytes) }, gain: { bytes: Math.round(bytes * 0.7), lcpMs: Math.min(800, Math.round(bytes / 2000)) } }];
  },
  'NET-05': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => ['script', 'stylesheet', 'font', 'image'].includes(r.type) && sameOrigin(r.url, p.url) && isVersioned(r.url) && !(maxAge(r.cacheControl) >= 2592000)));
    const uniq = [...new Map(rows.map((r) => [r.url, r])).values()];
    return uniq.length ? [{ urls: uniq.slice(0, 20).map((r) => r.url), evidence: { files: uniq.length, examples: uniq.slice(0, 5).map((r) => ({ url: r.url, cacheControl: r.cacheControl ?? null })) }, gain: { bytes: uniq.reduce((a, r) => a + r.transferBytes, 0) } }] : [];
  },
  'NET-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => new Set(p.evidence.requests.filter((r) => !sameOrigin(r.url, p.url)).map((r) => hostOf(r.url))).size > 10);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { origins: hits.map((p) => ({ url: p.url, n: new Set(p.evidence.requests.filter((r) => !sameOrigin(r.url, p.url)).map((r) => hostOf(r.url))).size })) }, gain: { lcpMs: 200 } }] : [];
  },
  'NET-07': (ctx) => {
    const heavy = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.type !== 'document' && r.cookieBytes > 2048));
    return heavy.length ? [{ urls: [...new Set(heavy.map((r) => r.url))].slice(0, 10), evidence: { requests: heavy.length, maxCookieBytes: Math.max(...heavy.map((r) => r.cookieBytes)) } }] : [];
  },
  'NET-09': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /rocket-loader|email-decode\.min\.js|cloudflare-static\/mirage/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { scripts: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => /rocket-loader|email-decode|mirage/.test(r.url)).map((r) => r.url)))] }, tier: 'T3' }] : [];
  },
  'NET-10': (ctx) => {
    const bad = uniquePages(ctx).flatMap((p) => p.evidence.errors.failedRequests.filter((f) => (f.status === 404 || f.status === 410) && /\.(css|js|woff2?|ttf|png|jpe?g|webp|avif|svg|gif|map)(\?|$)/.test(f.url)));
    const uniq = [...new Map(bad.map((b) => [b.url, b])).values()];
    return uniq.length ? [{ urls: uniq.map((b) => b.url), evidence: { missing: uniq } }] : [];
  },
  'NET-11': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.errors.mixedContent.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { resources: [...new Set(hits.flatMap((p) => p.evidence.errors.mixedContent))].slice(0, 20) } }] : [];
  },
  'NET-12': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => failing(p, 'bfCache'));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { reasons: hits.map((p) => (lhAudit(p, 'bfCache')?.items ?? []).slice(0, 5)) } }] : [];
  },
  'NET-13': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.serviceWorker || p.evidence.requests.some((r) => r.fromServiceWorker));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { serviceWorker: true }, tier: 'T3' }] : [];
  },
  'NET-14': (ctx) => {
    const rows = (ctx.wp?.perUrl ?? []).filter((r) => /miss|bypass|dynamic/i.test(Object.values(r.cacheHeaders).join(' ')) && /no-cache|no-store|private/.test(r.cacheHeaders['cache-control'] ?? ''));
    return rows.length ? [{ urls: rows.map((r) => r.url), evidence: { headers: rows.map((r) => r.cacheHeaders) } }] : [];
  },

  // ---------------- DOC ----------------
  'DOC-01': (ctx) => {
    const big = uniquePages(ctx).filter((p) => p.evidence.document.domElements > 1400 || p.evidence.document.domDepth > 32 || p.evidence.document.maxChildren > 60);
    return big.length ? [{ urls: big.map((p) => p.url), evidence: { dom: big.map((p) => ({ url: p.url, elements: p.evidence.document.domElements, depth: p.evidence.document.domDepth, maxChildren: p.evidence.document.maxChildren, at: p.evidence.document.maxChildrenSelector })) }, gain: { tbtMs: 40 } }] : [];
  },
  'DOC-02': (ctx) => {
    const big = uniquePages(ctx).filter((p) => (p.evidence.document.largestInlineJson?.bytes ?? 0) > 50 * 1024);
    return big.length ? [{ urls: big.map((p) => p.url), evidence: { inline: big.map((p) => ({ url: p.url, ...p.evidence.document.largestInlineJson })) }, gain: { tbtMs: 30, bytes: big[0]!.evidence.document.largestInlineJson!.bytes } }] : [];
  },
  'DOC-03': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.preloader?.coversViewport);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { preloader: hits[0]!.evidence.document.preloader, lcpRenderDelay: hits.map((p) => Math.round(p.evidence.lcp?.phases?.renderDelay ?? 0)) }, gain: { lcpMs: Math.max(0, ...hits.map((p) => Math.round((p.evidence.lcp?.phases?.renderDelay ?? 0) * 0.6))) }, rootCause: 'theme:preloader' }] : [];
  },
  'DOC-04': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.entranceAnimations.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { elements: [...new Set(hits.flatMap((p) => p.evidence.document.entranceAnimations.map((a) => a.selector)))].slice(0, 10) }, gain: { lcpMs: 400 }, rootCause: 'theme:entrance-animation' }] : [];
  },
  'DOC-05': (ctx) => {
    const hits = mobile(ctx).filter((p) => failing(p, 'renderBlocking') || p.evidence.document.headBlocking.length > 0);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { blocking: [...new Set(hits.flatMap((p) => p.evidence.document.headBlocking.map((h) => h.url ?? '(inline)')))].slice(0, 20), savingsMs: lhAudit(hits[0]!, 'renderBlocking')?.numericValue }, gain: { lcpMs: Math.round(lhAudit(hits[0]!, 'renderBlocking')?.numericValue ?? 300) }, note: 'fixed by CSS-01 and JS-01' }] : [];
  },
  'DOC-06': (ctx) => {
    const out: Draft[] = [];
    const unused = uniquePages(ctx).flatMap((p) => p.evidence.document.preloads.filter((l) => !l.used).map((l) => ({ url: p.url, href: l.href })));
    const wrongAs = uniquePages(ctx).flatMap((p) => p.evidence.document.preloads.filter((l) => l.as === 'font' && !l.crossorigin).map((l) => ({ url: p.url, href: l.href })));
    const multiHigh = uniquePages(ctx).filter((p) => p.evidence.images.filter((i) => i.fetchpriority === 'high').length > 1);
    const preconnectUnused = uniquePages(ctx).flatMap((p) => p.evidence.document.preconnects.filter((pc) => !p.evidence.requests.some((r) => r.url.startsWith(pc.replace(/\/$/, '')))).map((pc) => ({ url: p.url, href: pc })));
    if (unused.length || wrongAs.length || multiHigh.length || preconnectUnused.length) out.push({ urls: [...new Set([...unused, ...wrongAs, ...preconnectUnused].map((x) => x.url).concat(multiHigh.map((p) => p.url)))], evidence: { unusedPreloads: unused, fontPreloadWithoutCrossorigin: wrongAs, multipleHighPriorityImages: multiHigh.map((p) => p.url), unusedPreconnects: preconnectUnused } });
    return out;
  },
  'DOC-07': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => !p.evidence.document.viewportMeta || /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(p.evidence.document.viewportMeta));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { viewport: hits.map((p) => p.evidence.document.viewportMeta) } }] : [];
  },
  'DOC-08': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.media.some((m) => m.kind === 'iframe' && m.aboveFold && !m.facade));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { iframes: hits.flatMap((p) => p.evidence.media.filter((m) => m.kind === 'iframe' && m.aboveFold).map((m) => m.src)) }, gain: { lcpMs: 300, tbtMs: 100 } }] : [];
  },
  'DOC-09': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.docWrite.length);
    if (!hits.length) return [];
    const callers = [...new Set(hits.flatMap((p) => p.evidence.document.docWrite.map((d) => d.caller?.url ?? 'inline')))];
    const vendor = callers.some((c) => !sameOrigin(c, ctx.cfg.productionUrl) && c !== 'inline');
    return [{ urls: hits.map((p) => p.url), evidence: { callers }, tier: vendor ? 'T3' : 'T2' }];
  },

  // ---------------- IMG / VID ----------------
  'IMG-01': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.lcp?.isImage && (p.evidence.lcp.lazy || (p.evidence.lcp.phases?.loadDelay ?? 0) > 400 || failing(p, 'lcpDiscovery')));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { lcp: hits.map((p) => ({ url: p.url, element: p.evidence.lcp!.selector, src: p.evidence.lcp!.url, lazy: p.evidence.lcp!.lazy, fetchpriority: p.evidence.lcp!.fetchpriority, phases: p.evidence.lcp!.phases })) }, gain: { lcpMs: Math.max(...hits.map((p) => Math.round((p.evidence.lcp!.phases?.loadDelay ?? 0) * 0.8))) }, rootCause: 'lcp-image' }] : [];
  },
  'IMG-02': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.images.filter((i) => i.fetchpriority === 'high').length > 1 || p.evidence.document.preloads.filter((l) => l.as === 'image').length > 1);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { highPriority: hits.map((p) => p.evidence.images.filter((i) => i.fetchpriority === 'high').map((i) => i.src)) }, gain: { lcpMs: 150 } }] : [];
  },
  'IMG-03': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => i.tag === 'img' && i.renderedWidth > 0 && i.naturalWidth > 1.5 * i.renderedWidth * i.dpr).map((i) => ({ page: p.url, src: i.currentSrc, natural: i.naturalWidth, rendered: i.renderedWidth, dpr: i.dpr, bytes: i.bytes ?? 0 })));
    const uniq = [...new Map(rows.map((r) => [r.src, r])).values()];
    if (!uniq.length) return [];
    const waste = uniq.reduce((a, r) => a + r.bytes * (1 - Math.min(1, ((r.rendered * r.dpr) / r.natural) ** 2)), 0);
    return [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { images: uniq.slice(0, 15) }, gain: { bytes: Math.round(waste), lcpMs: Math.min(1500, Math.round(waste / 3000)) } }];
  },
  'IMG-04': (ctx) => {
    if (ctx.cfg.platform === 'shopify') return [];
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => /^(jpe?g|png)$/.test(i.format ?? '') && (i.bytes ?? 0) > 50 * 1024).map((i) => ({ src: i.currentSrc, bytes: i.bytes })));
    const uniq = [...new Map(rows.map((r) => [r.src, r])).values()];
    return uniq.length ? [{ urls: uniq.map((r) => r.src).slice(0, 20), evidence: { images: uniq.length, kb: kb(uniq.reduce((a, r) => a + (r.bytes ?? 0), 0)) }, gain: { bytes: Math.round(uniq.reduce((a, r) => a + (r.bytes ?? 0), 0) * 0.3) } }] : [];
  },
  'IMG-05': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => i.naturalWidth > 0 && (i.bytes ?? 0) > 30 * 1024 && /^jpe?g$/.test(i.format ?? '') && (i.bytes ?? 0) / (i.naturalWidth * i.naturalHeight) > 0.25).map((i) => ({ src: i.currentSrc, bpp: Math.round(((i.bytes ?? 0) * 8 * 100) / (i.naturalWidth * i.naturalHeight)) / 100 })));
    const uniq = [...new Map(rows.map((r) => [r.src, r])).values()];
    return uniq.length ? [{ urls: uniq.map((r) => r.src).slice(0, 15), evidence: { bitsPerPixel: uniq.slice(0, 10) }, gain: { bytes: 0 } }] : [];
  },
  'IMG-06': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => i.tag === 'img' && (!i.hasWidthAttr || !i.hasHeightAttr) && !i.hasAspectRatio && i.renderedWidth > 0).map((i) => ({ page: p.url, src: i.currentSrc, selector: i.selector })));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { images: [...new Map(rows.map((r) => [r.src, r])).values()].slice(0, 15) }, gain: { cls: Math.min(0.25, Math.max(0, ...mobile(ctx).map((p) => p.evidence.cls.culprits.filter((c) => c.cause === 'image-without-size').reduce((a, c) => a + c.value, 0)))) } }] : [];
  },
  'IMG-07': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => i.tag === 'img' && !i.aboveFold && i.loading !== 'lazy' && i.renderedWidth > 0).map((i) => ({ page: p.url, src: i.currentSrc, bytes: i.bytes ?? 0 })));
    const js = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /lazysizes|lazyload\.min\.js|lozad/.test(r.url)));
    if (!rows.length && !js.length) return [];
    return [{ urls: [...new Set([...rows.map((r) => r.page), ...js.map((p) => p.url)])], evidence: { eagerOffscreen: [...new Map(rows.map((r) => [r.src, r])).values()].slice(0, 15), jsLazyLibraries: js.length }, gain: { bytes: rows.reduce((a, r) => a + r.bytes, 0), lcpMs: 200 } }];
  },
  'IMG-08': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => /^\s*100vw\s*$/.test(i.sizes ?? '') && i.renderedWidth > 0 && i.renderedWidth < 0.6 * (p.device === 'mobile' ? 390 : 1440)).map((i) => ({ page: p.url, src: i.currentSrc, rendered: i.renderedWidth })));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { images: rows.slice(0, 10) } }] : [];
  },
  'IMG-09': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => /\.gif(\?|$)/i.test(r.url) && r.decodedBytes > 100 * 1024));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.url))], evidence: { kb: kb(rows.reduce((a, r) => a + r.decodedBytes, 0)) }, gain: { bytes: Math.round(rows.reduce((a, r) => a + r.decodedBytes, 0) * 0.8) } }] : [];
  },
  'IMG-10': (ctx) => {
    const re = /slide|swiper|slick|carousel|n2-ss|owl-item|flickity/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.images.filter((i) => re.test(i.selector) && i.loading !== 'lazy').length > 1);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { eagerSlides: hits.map((p) => p.evidence.images.filter((i) => re.test(i.selector) && i.loading !== 'lazy').length) }, gain: { bytes: hits[0]!.evidence.images.filter((i) => re.test(i.selector)).slice(1).reduce((a, i) => a + (i.bytes ?? 0), 0) }, rootCause: 'slider' }] : [];
  },
  'IMG-11': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => /\.svg(\?|$)/.test(r.url) && r.decodedBytes > 30 * 1024));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.url))], evidence: { kb: kb(rows.reduce((a, r) => a + r.decodedBytes, 0)) } }] : [];
  },
  'IMG-12': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.images.filter((i) => i.tag === 'img' && !sameOrigin(i.currentSrc, p.url) && !/cdn\.shopify\.com|gravatar|wp\.com|cloudinary|imgix|bunny|cloudfront/.test(i.currentSrc)));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.currentSrc))].slice(0, 10), evidence: { hosts: [...new Set(rows.map((r) => hostOf(r.currentSrc)))] } }] : [];
  },
  'IMG-13': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.filter((r) => /gravatar\.com\/avatar/.test(r.url)).length > 5);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { gravatars: hits.map((p) => p.evidence.requests.filter((r) => /gravatar/.test(r.url)).length) } }] : [];
  },
  'VID-01': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.media.some((m) => m.kind === 'video' && m.autoplay) && p.evidence.requests.some((r) => r.type === 'media' && r.transferBytes > 2 * 1024 * 1024));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { videos: hits.flatMap((p) => p.evidence.media.filter((m) => m.kind === 'video')) }, gain: { bytes: 2 * 1024 * 1024, lcpMs: 500 } }] : [];
  },
  'VID-02': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.media.some((m) => m.kind === 'iframe' && ['youtube', 'vimeo', 'wistia'].includes(m.provider ?? '') && !m.facade));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { embeds: hits.flatMap((p) => p.evidence.media.filter((m) => ['youtube', 'vimeo', 'wistia'].includes(m.provider ?? '')).map((m) => m.src)) }, gain: { tbtMs: 250, bytes: 500 * 1024 }, rootCause: 'video-embed' }] : [];
  },

  // ---------------- FONT ----------------
  'FONT-01': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.filter((r) => r.type === 'font').length > 4 || p.evidence.fonts.filter((f) => !f.loaded && f.family !== '(cross-origin)').length > 0 || /wght@([\d;]+)/.test(p.evidence.requests.map((r) => r.url).join(' ')) && (/wght@[^&"]*/.exec(p.evidence.requests.map((r) => r.url).join(' '))?.[0].split(';').length ?? 0) > 4);
    if (!hits.length) return [];
    const families = [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => /fonts\.googleapis\.com\/css/.test(r.url)).map((r) => decodeURIComponent(r.url))))];
    return [{ urls: hits.map((p) => p.url), evidence: { fontFiles: hits.map((p) => p.evidence.requests.filter((r) => r.type === 'font').length), googleCss: families, unusedFaces: hits[0]!.evidence.fonts.filter((f) => !f.loaded).map((f) => `${f.family} ${f.weight}`).slice(0, 10) }, gain: { bytes: 60 * 1024, lcpMs: 150 }, rootCause: 'fonts' }];
  },
  'FONT-02': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { requests: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.url)).map((r) => r.url)))].slice(0, 10) }, gain: { lcpMs: 200 }, rootCause: 'fonts' }] : [];
  },
  'FONT-03': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => failing(p, 'fontDisplay') || p.evidence.fonts.some((f) => f.family !== '(cross-origin)' && f.loaded && (!f.display || f.display === 'auto' || f.display === 'block')));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { faces: [...new Set(hits.flatMap((p) => p.evidence.fonts.filter((f) => !f.display || f.display === 'auto' || f.display === 'block').map((f) => `${f.family} ${f.weight}`)))].slice(0, 10) }, gain: { lcpMs: 100 } }] : [];
  },
  'FONT-04': (ctx) => {
    const hits = mobile(ctx).filter((p) => !p.evidence.lcp?.isImage && p.evidence.requests.some((r) => r.type === 'font' && (r.startMs ?? 0) > 1000) && !p.evidence.document.preloads.some((l) => l.as === 'font'));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { lateFonts: hits.flatMap((p) => p.evidence.requests.filter((r) => r.type === 'font' && (r.startMs ?? 0) > 1000).map((r) => ({ url: r.url, startMs: Math.round(r.startMs ?? 0) }))).slice(0, 5) }, gain: { lcpMs: 200 } }] : [];
  },
  'FONT-05': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.cls.culprits.some((c) => c.cause === 'web-font'));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { culprits: hits.flatMap((p) => p.evidence.cls.culprits.filter((c) => c.cause === 'web-font')) }, gain: { cls: Math.max(...hits.flatMap((p) => p.evidence.cls.culprits.filter((c) => c.cause === 'web-font').map((c) => c.value))) } }] : [];
  },
  'FONT-06': (ctx) => {
    const re = /font-?awesome|fontawesome|eicons|dashicons|fa-(solid|regular|brands)|icomoon|themify|elementor-icons/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => (r.type === 'font' || r.type === 'stylesheet') && re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { files: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => r.url)))] }, gain: { bytes: 80 * 1024 } }] : [];
  },
  'FONT-07': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.type === 'font' && /\.(ttf|otf|eot|woff)(\?|$)/i.test(r.url) && !/\.woff2/i.test(r.url)));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.url))], evidence: { files: rows.length }, gain: { bytes: Math.round(rows.reduce((a, r) => a + r.transferBytes, 0) * 0.3) } }] : [];
  },
  'FONT-08': (ctx) => {
    const out: Draft[] = [];
    for (const p of uniquePages(ctx)) {
      const fams = byKey(p.evidence.fonts.filter((f) => f.family !== '(cross-origin)' && f.src), (f) => `${f.family}|${f.weight}|${f.style}`);
      const dup = [...fams.entries()].filter(([, v]) => new Set(v.map((f) => hostOf(f.src!) + f.source)).size > 1);
      if (dup.length) out.push({ urls: [p.url], evidence: { families: dup.map(([k]) => k) } });
    }
    return out.slice(0, 1);
  },

  // ---------------- CSS ----------------
  'CSS-01': (ctx) => {
    const hits = mobile(ctx).filter((p) => {
      const blockingCss = p.evidence.requests.filter((r) => r.type === 'stylesheet' && p.evidence.document.headBlocking.some((h) => h.url === r.url));
      return blockingCss.reduce((a, r) => a + r.decodedBytes, 0) > 50 * 1024 || (failing(p, 'renderBlocking') && blockingCss.length > 0);
    });
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { blockingCssKb: hits.map((p) => kb(p.evidence.requests.filter((r) => r.type === 'stylesheet' && p.evidence.document.headBlocking.some((h) => h.url === r.url)).reduce((a, r) => a + r.decodedBytes, 0))) }, gain: { lcpMs: 300 } }] : [];
  },
  'CSS-02': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.coverage.filter((c) => c.type === 'css' && c.totalBytes > 10 * 1024 && c.unusedBytes / c.totalBytes > 0.7).map((c) => ({ page: p.url, file: c.url, unusedKb: kb(c.unusedBytes), owner: c.owner.id })));
    if (!rows.length) return [];
    return [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { files: [...new Map(rows.map((r) => [r.file, r])).values()].slice(0, 15) }, gain: { bytes: Math.round(rows.reduce((a, r) => a + r.unusedKb * 1024, 0) / Math.max(1, new Set(rows.map((r) => r.page)).size)) } }];
  },
  'CSS-03': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.imports.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { imports: [...new Set(hits.flatMap((p) => p.evidence.document.imports))] }, gain: { lcpMs: 150 } }] : [];
  },
  'CSS-04': (ctx) => {
    const libs: Array<[string, RegExp]> = [['bootstrap', /bootstrap(\.min)?\.css/], ['font-awesome', /font-?awesome[^/]*\.css|fontawesome[^/]*\.css/], ['animate.css', /animate(\.min)?\.css/], ['foundation', /foundation(\.min)?\.css/]];
    const out: Draft[] = [];
    for (const p of uniquePages(ctx)) {
      for (const [name, re] of libs) {
        const copies = p.evidence.requests.filter((r) => r.type === 'stylesheet' && re.test(r.url));
        if (copies.length > 1) out.push({ urls: [p.url], evidence: { library: name, copies: copies.map((c) => c.url) }, gain: { bytes: copies.slice(1).reduce((a, c) => a + c.transferBytes, 0) } });
      }
    }
    return out.slice(0, 3);
  },
  'CSS-05': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.type === 'stylesheet' && sameOrigin(r.url, p.url) && r.decodedBytes > 20 * 1024 && !/\.min\.css/.test(r.url)));
    const uniq = [...new Map(rows.map((r) => [r.url, r])).values()];
    return uniq.length ? [{ urls: uniq.map((r) => r.url).slice(0, 10), evidence: { files: uniq.length, note: 'whitespace ratio checked when the source is available' }, gain: { bytes: Math.round(uniq.reduce((a, r) => a + r.decodedBytes, 0) * 0.15) } }] : [];
  },
  'CSS-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.inlineCssBytes > 50 * 1024);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { inlineCssKb: hits.map((p) => kb(p.evidence.document.inlineCssBytes)) }, gain: { bytes: hits[0]!.evidence.document.inlineCssBytes } }] : [];
  },
  'CSS-07': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => failing(p, 'nonCompositedAnimations') || p.evidence.document.animations.some((a) => !a.composited));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { animations: hits.flatMap((p) => p.evidence.document.animations.filter((a) => !a.composited)).slice(0, 10) }, gain: { cls: 0.02, tbtMs: 20 } }] : [];
  },
  'CSS-09': (ctx) => {
    const re = /contact-form-7|wpforms|gravityforms|smart-slider|revslider|layerslider|elementor|woocommerce|popup|gallery|swiper|slick/i;
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.coverage.filter((c) => c.type === 'css' && re.test(c.url) && c.totalBytes > 0 && c.usedBytes / c.totalBytes < 0.05).map((c) => ({ page: p.url, file: c.url, owner: c.owner.id })));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { files: [...new Map(rows.map((r) => [r.file + r.page, r])).values()].slice(0, 20) }, gain: { bytes: 20 * 1024 } }] : [];
  },
  'CSS-10': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.domElements > 2500);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { elements: hits.map((p) => p.evidence.document.domElements) }, gain: { tbtMs: 30 } }] : [];
  },

  // ---------------- JS ----------------
  'JS-01': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.document.headBlocking.some((h) => h.tag === 'script' && h.url));
    if (!hits.length) return [];
    const scripts = [...new Set(hits.flatMap((p) => p.evidence.document.headBlocking.filter((h) => h.tag === 'script' && h.url).map((h) => h.url!)))];
    return [{ urls: hits.map((p) => p.url), evidence: { scripts, note: 'defer only with an X-ray safe verdict (SAFE-01)' }, gain: { lcpMs: Math.round(lhAudit(hits[0]!, 'renderBlocking')?.numericValue ?? 200) } }];
  },
  'JS-02': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.coverage.filter((c) => c.type === 'js' && !c.inline && c.totalBytes > 5 * 1024 && c.unusedBytes / c.totalBytes > 0.6).map((c) => ({ page: p.url, file: c.url, unusedKb: kb(c.unusedBytes), owner: c.owner.id })));
    if (!rows.length) return [];
    return [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { files: [...new Map(rows.map((r) => [r.file, r])).values()].sort((a, b) => b.unusedKb - a.unusedKb).slice(0, 15) }, gain: { bytes: Math.round(rows.reduce((a, r) => a + r.unusedKb * 1024, 0) / Math.max(1, new Set(rows.map((r) => r.page)).size)), tbtMs: 50 } }];
  },
  'JS-03': (ctx) => {
    const hits = mobile(ctx).filter((p) => (p.lighthouse?.median.tbt ?? 0) > 200 || p.evidence.loaf.some((f) => f.blockingDuration > 100));
    if (!hits.length) return [];
    const culprits = byKey(hits.flatMap((p) => p.evidence.loaf.flatMap((f) => f.scripts)), (s) => s.owner.id);
    return [{ urls: hits.map((p) => p.url), evidence: { tbt: hits.map((p) => ({ url: p.url, tbt: p.lighthouse?.median.tbt })), owners: [...culprits.entries()].map(([o, s]) => ({ owner: o, ms: Math.round(s.reduce((a, x) => a + x.duration, 0)) })).sort((a, b) => b.ms - a.ms).slice(0, 8) }, gain: { tbtMs: Math.max(0, ...hits.map((p) => (p.lighthouse?.median.tbt ?? 0) - 100)) } }];
  },
  'JS-04': (ctx) => {
    const slow = mobile(ctx).flatMap((p) => (p.inp?.interactions ?? []).filter((i) => (i.inp ?? 0) > 200).map((i) => ({ page: p.url, ...i })));
    return slow.length ? [{ urls: [...new Set(slow.map((s) => s.page))], evidence: { interactions: slow.map((s) => ({ page: s.page, name: s.name, inp: s.inp, inputDelay: s.inputDelay, processing: s.processing, presentation: s.presentation, scripts: s.scripts.slice(0, 3).map((x) => ({ url: x.sourceURL, fn: x.sourceFunctionName, ms: x.duration, owner: x.owner.id })) })) }, gain: { inpMs: Math.max(...slow.map((s) => (s.inp ?? 0) - 150)) }, rootCause: slow[0]!.scripts[0]?.owner.id }] : [];
  },
  'JS-05': (ctx) => {
    const libs: Array<[string, RegExp]> = [['jquery', /jquery(-\d[\d.]*)?(\.min)?\.js(\?|$)/], ['lodash', /lodash(\.min)?\.js/], ['swiper', /swiper(-bundle)?(\.min)?\.js/], ['slick', /slick(\.min)?\.js/], ['owl', /owl\.carousel(\.min)?\.js/]];
    const out: Draft[] = [];
    for (const p of uniquePages(ctx)) {
      for (const [name, re] of libs) {
        const copies = p.evidence.requests.filter((r) => r.type === 'script' && re.test(r.url) && !/migrate/.test(r.url));
        if (copies.length > 1) out.push({ urls: [p.url], evidence: { library: name, copies: copies.map((c) => c.url) }, gain: { bytes: copies.slice(1).reduce((a, c) => a + c.transferBytes, 0), tbtMs: 30 } });
      }
      if (failing(p, 'duplicatedJavascript')) out.push({ urls: [p.url], evidence: { lighthouse: (lhAudit(p, 'duplicatedJavascript')?.items ?? []).slice(0, 5) } });
    }
    return out.slice(0, 3);
  },
  'JS-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => failing(p, 'legacyJavascript'));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { items: (lhAudit(hits[0]!, 'legacyJavascript')?.items ?? []).slice(0, 5) }, gain: { bytes: 20 * 1024 } }] : [];
  },
  'JS-07': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /jquery-migrate(\.min)?\.js/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { jqmigrateWarnings: [...new Set(hits.flatMap((p) => p.evidence.errors.jqmigrate))].slice(0, 10), note: 'remove only after zero JQMIGRATE warnings across all flows (SAFE-09)' }, gain: { tbtMs: 15, bytes: 13 * 1024 }, rootCause: 'core:wordpress' }] : [];
  },
  'JS-08': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.document.headBlocking.some((h) => h.tag === 'script' && /jquery(\.min)?\.js/.test(h.url ?? '')));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { note: 'high break risk: only with an X-ray safe verdict and no early inline dependents (SAFE-01)' }, gain: { lcpMs: 150 } }] : [];
  },
  'JS-09': (ctx) => {
    const re = /slider|swiper|slick|lightbox|fancybox|photoswipe|maps\.googleapis|chat|widget|reviews|intercom|tidio|zendesk|crisp|tawk|livechat/i;
    const rows = mobile(ctx).flatMap((p) => p.evidence.loaf.flatMap((f) => f.scripts).filter((s) => re.test(s.sourceURL)).map((s) => ({ page: p.url, url: s.sourceURL, ms: s.duration, owner: s.owner.id })));
    const reqs = mobile(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.type === 'script' && re.test(r.url)).map((r) => ({ page: p.url, url: r.url, owner: r.owner.id })));
    if (!rows.length && !reqs.length) return [];
    return [{ urls: [...new Set([...rows, ...reqs].map((r) => r.page))], evidence: { scripts: [...new Map([...rows, ...reqs].map((r) => [r.url, r])).values()].slice(0, 10) }, gain: { tbtMs: Math.round(rows.reduce((a, r) => a + r.ms, 0)) || 50 } }];
  },
  'JS-10': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.type === 'script' && sameOrigin(r.url, p.url) && r.decodedBytes > 20 * 1024 && !/\.min\.js|[.-][0-9a-f]{8,}\.js/.test(r.url)));
    const uniq = [...new Map(rows.map((r) => [r.url, r])).values()];
    return uniq.length ? [{ urls: uniq.map((r) => r.url).slice(0, 10), evidence: { files: uniq.length }, gain: { bytes: Math.round(uniq.reduce((a, r) => a + r.decodedBytes, 0) * 0.3) } }] : [];
  },
  'JS-11': (ctx) => {
    const rows = uniquePages(ctx).flatMap((p) => [...byKey(p.evidence.requests.filter((r) => r.type === 'xhr' || r.type === 'fetch'), (r) => r.url.split('?')[0]!).entries()].filter(([, v]) => v.length >= 2).map(([u, v]) => ({ page: p.url, url: u, n: v.length })));
    const heartbeat = (ctx.wp?.perUrl ?? []).some((u) => u.diag?.scripts.some((s) => s.handle === 'heartbeat'));
    const known = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => /chat\/ping|heartbeat|admin-ajax\.php|\/live-stats|post-views/.test(r.url)).map((r) => ({ page: p.url, url: r.url, n: 1 })));
    const all = [...rows, ...known];
    if (!all.length && !heartbeat) return [];
    return [{ urls: [...new Set(all.map((r) => r.page))], evidence: { repeated: all.slice(0, 10), heartbeatOnFrontEnd: heartbeat }, gain: { tbtMs: 10 } }];
  },
  'JS-12': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.nonPassiveListeners.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { listeners: hits.flatMap((p) => p.evidence.document.nonPassiveListeners).slice(0, 10) }, gain: { inpMs: 20 } }] : [];
  },
  'JS-13': (ctx) => frontEvaluators['DOC-02']!(ctx).map((d) => ({ ...d, gain: { tbtMs: 30 } })),
  'JS-14': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.errors.pageErrors.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { errors: [...new Set(hits.flatMap((p) => p.evidence.errors.pageErrors))].slice(0, 10) } }] : [];
  },
  'JS-15': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.errors.console.some((m) => /Synchronous XMLHttpRequest/i.test(m.text)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { warnings: hits.length } }] : [];
  },

  // ---------------- 3P ----------------
  '3P-01': (ctx) => {
    const rows = mobile(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.owner.kind === 'third-party' || r.owner.kind === 'app').map((r) => ({ page: p.url, ...r })));
    if (!rows.length) return [];
    const table = [...byKey(rows, (r) => r.owner.id).entries()].map(([owner, rs]) => {
      const pages = [...new Set(rs.map((r) => r.page))];
      const ms = mobile(ctx).reduce((a, p) => a + p.evidence.loaf.flatMap((f) => f.scripts).filter((s) => s.owner.id === owner).reduce((x, s) => x + s.duration, 0), 0) / Math.max(1, pages.length);
      return { owner, requests: rs.length, kb: kb(rs.reduce((a, r) => a + r.transferBytes, 0)), mainThreadMs: Math.round(ms), pages: pages.length };
    });
    return [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { table: table.sort((a, b) => b.mainThreadMs - a.mainThreadMs || b.kb - a.kb) }, note: 'report: one row per vendor; changes are made at the injection point' }];
  },
  '3P-02': vendorCheck(/googletagmanager\.com\/gtm\.js/, 'Google Tag Manager', 80),
  '3P-03': (ctx) => {
    const out: Draft[] = [];
    for (const p of uniquePages(ctx)) {
      const gtag = p.evidence.requests.filter((r) => /googletagmanager\.com\/gtag\/js\?id=/.test(r.url)).map((r) => new URL(r.url).searchParams.get('id'));
      const dupIds = gtag.filter((id, i) => id && gtag.indexOf(id) !== i);
      const pv = p.evidence.beacons.filter((b) => b.event === 'page_view' || b.event === 'PageView');
      const pvByVendor = byKey(pv, (b) => b.vendor);
      const doubled = [...pvByVendor.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ vendor: k, pageViews: v.length }));
      if (dupIds.length || doubled.length) out.push({ urls: [p.url], evidence: { duplicateTagIds: dupIds, doubledPageViews: doubled } });
    }
    return out.slice(0, 2);
  },
  '3P-04': vendorCheck(/tidio|intercom|zopim|zendesk|crisp\.chat|livechatinc|tawk\.to|shopify-chat|inbox\.shopify|gorgias|drift\.com|hubspot.*conversations|\/chat\/widget/i, 'chat widget', 150),
  '3P-05': vendorCheck(/hotjar|clarity\.ms|luckyorange|mouseflow|fullstory|smartlook/i, 'heatmap or session replay', 80),
  '3P-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /optimize\.js|async-hide|anti-flicker|vwo|convert\.com|abtasty/.test(r.url)) || p.evidence.document.headBlocking.some((h) => h.inline) && /async-hide|antiflicker/i.test(JSON.stringify(p.evidence.document.headBlocking)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { abTesting: true } }] : [];
  },
  '3P-07': vendorCheck(/cookiebot|onetrust|optanon|cookieyes|iubenda|usercentrics|complianz|borlabs|cookie-law-info|termly|quantcast\.mgr/i, 'consent tool', 40),
  '3P-08': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /recaptcha|hcaptcha|turnstile/.test(r.url)) && !(p.evidence.document.forms > 0));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { note: 'captcha on a page without forms' }, gain: { tbtMs: 150 } }] : [];
  },
  '3P-09': vendorCheck(/instagram\.com\/embed|connect\.facebook\.net|platform\.twitter\.com|tiktok\.com\/embed|elfsight|smashballoon|sbi-/i, 'social embed or feed', 120),
  '3P-10': vendorCheck(/trustpilot|judge\.me|judgeme|yotpo|stamped\.io|reviews\.io|okendo|loox|google.*reviews/i, 'review widget', 80),
  '3P-11': vendorCheck(/accessibe|acsbapp|userway|equalweb|audioeye/i, 'accessibility overlay', 120),
  '3P-12': vendorCheck(/googlesyndication|doubleclick\.net\/(gampad|tag)|adsbygoogle|amazon-adsystem|taboola|outbrain|mediavine|ezoic/i, 'ads', 200),
  '3P-13': (ctx) => {
    const re = /js\.stripe\.com|paypal\.com\/sdk|klarna|afterpay|clearpay|affirm\.com/i;
    const hits = uniquePages(ctx).filter((p) => !/checkout|cart/.test(p.url) && p.evidence.requests.some((r) => re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { sdks: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => hostOf(r.url))))], note: 'Stripe recommends Stripe.js on every page for fraud detection; never removed unless the client decides' }, tier: 'T3' }] : [];
  },
  '3P-14': vendorCheck(/use\.typekit\.net|p\.typekit\.net|fonts\.com|cloud\.typography/i, 'third-party fonts', 30),
  '3P-15': vendorCheck(/maps\.googleapis\.com|google\.com\/maps\/embed|maps\.google\./i, 'maps', 200),

  // ---------------- CLS ----------------
  'CLS-01': (ctx) => clsBy(ctx, (c) => c.cause === 'image-without-size'),
  'CLS-02': (ctx) => clsBy(ctx, (c) => c.cause === 'web-font'),
  'CLS-03': (ctx) => clsBy(ctx, (c) => c.cause === 'injected-content'),
  'CLS-04': (ctx) => clsBy(ctx, (c) => /slide|swiper|slick|carousel|n2-ss|owl|flickity/i.test(c.selector ?? '')),
  'CLS-05': (ctx) => clsBy(ctx, (c) => c.cause === 'injected-content' && c.startTime > 2500),
  'CLS-06': (ctx) => clsBy(ctx, (c) => c.cause === 'animation'),
  'CLS-07': (ctx) => {
    const re = /weglot|gtranslate|translate\.google|langify|conveythis|currency-converter|bucks|mlveda/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { tools: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => hostOf(r.url))))] }, tier: 'T3' }] : [];
  },
  'CLS-08': (ctx) => clsBy(ctx, (c) => /header|sticky|navbar/i.test(c.selector ?? '')),
  'CLS-09': (ctx) => clsBy(ctx, (c) => /shopify-app-block|shopify-block|app-block/i.test(c.selector ?? '')),
};

function clsBy(ctx: EvalContext, pred: (c: PageAudit['evidence']['cls']['culprits'][number]) => boolean): Draft[] {
  const rows = mobile(ctx).flatMap((p) => p.evidence.cls.culprits.filter((c) => pred(c) && c.value >= 0.005).map((c) => ({ page: p.url, ...c })));
  if (!rows.length) return [];
  return [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { culprits: rows.slice(0, 10) }, gain: { cls: Math.round(Math.max(...rows.map((r) => r.value)) * 1000) / 1000 } }];
}
