import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Capture, UrlCapture } from './capture.js';
import type { SiteConfig } from '../config/site.js';

export interface Check {
  name: 'visual' | 'console' | 'network' | 'flows' | 'tracking' | 'seo' | 'accessibility' | 'backend' | 'performance';
  pass: boolean;
  details: string[];
  evidence: string[];
}

/** Visual difference of two PNGs: share of pixels that differ, ignoring anti-aliasing. Size changes count as a full difference of the extra area. */
export function visualDiff(a: string, b: string, diffOut?: string): { ratio: number; diffPixels: number; total: number; sizeChanged: boolean } {
  const A = PNG.sync.read(readFileSync(a));
  const B = PNG.sync.read(readFileSync(b));
  const w = Math.max(A.width, B.width);
  const h = Math.max(A.height, B.height);
  const pad = (img: PNG) => {
    if (img.width === w && img.height === h) return img.data;
    const out = Buffer.alloc(w * h * 4, 0);
    for (let y = 0; y < img.height; y++) img.data.copy(out, y * w * 4, y * img.width * 4, (y + 1) * img.width * 4);
    return out;
  };
  const diff = new PNG({ width: w, height: h });
  // masked areas (#ff00ff) in either screenshot are left out of the comparison
  const da = pad(A);
  const db = pad(B);
  const isMask = (d: Buffer, i: number) => d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255;
  for (let i = 0; i < da.length; i += 4) {
    if (isMask(da, i) || isMask(db, i)) {
      da[i] = db[i] = 255;
      da[i + 1] = db[i + 1] = 0;
      da[i + 2] = db[i + 2] = 255;
      da[i + 3] = db[i + 3] = 255;
    }
  }
  const n = pixelmatch(da, db, diff.data, w, h, { threshold: 0.1, includeAA: false });
  if (diffOut && n > 0) writeFileSync(diffOut, PNG.sync.write(diff));
  return { ratio: n / (w * h), diffPixels: n, total: w * h, sizeChanged: A.width !== B.width || A.height !== B.height };
}

const key = (u: UrlCapture) => `${new URL(u.url).pathname}${new URL(u.url).search}|${u.viewport}`;

function countEvents(beacons: Array<{ vendor: string; event: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of beacons) out[`${b.vendor}:${b.event}`] = (out[`${b.vendor}:${b.event}`] ?? 0) + 1;
  return out;
}

/** Compares a capture with the baseline (SPEC.md 6 pass rules). */
export function compareCaptures(base: Capture, now: Capture, cfg: SiteConfig, diffDir?: string): Check[] {
  const checks: Check[] = [];
  const baseByKey = new Map(base.urls.map((u) => [key(u), u]));
  const visual: Check = { name: 'visual', pass: true, details: [], evidence: [] };
  const consoleC: Check = { name: 'console', pass: true, details: [], evidence: [] };
  const network: Check = { name: 'network', pass: true, details: [], evidence: [] };
  const seo: Check = { name: 'seo', pass: true, details: [], evidence: [] };
  const a11y: Check = { name: 'accessibility', pass: true, details: [], evidence: [] };
  const backend: Check = { name: 'backend', pass: true, details: [], evidence: [] };
  const tracking: Check = { name: 'tracking', pass: true, details: [], evidence: [] };
  const perf: Check = { name: 'performance', pass: true, details: [], evidence: [] };
  const limit = cfg.thresholds.visualPixelRatio;
  for (const u of now.urls) {
    const b = baseByKey.get(key(u));
    if (!b) continue;
    const label = `${new URL(u.url).pathname} @${u.viewport}`;
    // visual
    if (existsSync(b.screenshot) && existsSync(u.screenshot)) {
      const d = visualDiff(b.screenshot, u.screenshot, diffDir ? u.screenshot.replace(/\.png$/, '.diff.png') : undefined);
      if (d.ratio > limit) {
        visual.pass = false;
        visual.details.push(`${label}: ${(d.ratio * 100).toFixed(2)}% of pixels differ (limit ${(limit * 100).toFixed(2)}%)${d.sizeChanged ? ', page size changed' : ''}`);
        visual.evidence.push(u.screenshot.replace(/\.png$/, '.diff.png'));
      }
    }
    if (u.earlyPaint?.unstyled && !b.earlyPaint?.unstyled) {
      visual.pass = false;
      visual.details.push(`${label}: flash of unstyled content at first contentful paint`);
      visual.evidence.push(u.earlyPaint.screenshot);
    }
    // console: new error or warning signatures
    // errors the test environment causes (site.yaml ignoreErrors: hosts the test machine cannot reach) are not the site's
    const ignored = (t: string) => cfg.ignoreErrors.some((x) => t.includes(x));
    const allNewFailed = u.failed.filter((f) => !b.failed.some((g) => g.url === f.url && g.status === f.status));
    const failedOnlyIgnored = allNewFailed.length > 0 && allNewFailed.every((f) => ignored(f.url));
    const newSigs = u.console.filter((s) => !b.console.includes(s) && !ignored(s) && !(failedOnlyIgnored && s.startsWith('Failed to load resource')));
    if (newSigs.length) {
      consoleC.pass = false;
      consoleC.details.push(`${label}: ${newSigs.slice(0, 3).join(' | ')}`);
    }
    // network: new failures, mixed content, CSP violations, missing fonts or images
    const baseFailed = new Set(b.failed.map((f) => `${f.url}|${f.status ?? 'x'}`));
    const newFailed = u.failed.filter((f) => !baseFailed.has(`${f.url}|${f.status ?? 'x'}`) && !ignored(f.url));
    if (newFailed.length || u.mixed.length > b.mixed.length || u.csp.length > b.csp.length) {
      network.pass = false;
      network.details.push(`${label}: ${newFailed.slice(0, 3).map((f) => `${f.status ?? 'failed'} ${f.type} ${f.url}`).join(', ')}${u.csp.length > b.csp.length ? ' new CSP violations' : ''}`);
    }
    // SEO
    for (const k of ['status', 'title', 'description', 'canonical', 'robots', 'robotsHeader', 'ogImage'] as const) {
      if (b.seo[k] !== u.seo[k]) {
        seo.pass = false;
        seo.details.push(`${label}: ${k} changed from ${JSON.stringify(b.seo[k])} to ${JSON.stringify(u.seo[k])}`);
      }
    }
    if (JSON.stringify(b.seo.hreflang) !== JSON.stringify(u.seo.hreflang)) {
      seo.pass = false;
      seo.details.push(`${label}: hreflang changed`);
    }
    if (JSON.stringify(b.seo.jsonLd) !== JSON.stringify(u.seo.jsonLd)) {
      seo.pass = false;
      seo.details.push(`${label}: JSON-LD changed`);
    }
    // accessibility basics (Lighthouse score compared in the performance step)
    if (u.imgWithoutAlt > b.imgWithoutAlt) {
      a11y.pass = false;
      a11y.details.push(`${label}: ${u.imgWithoutAlt - b.imgWithoutAlt} images lost their alt text`);
    }
    if (u.facadesNotFocusable.length) {
      a11y.pass = false;
      a11y.details.push(`${label}: facades not reachable by keyboard: ${u.facadesNotFocusable.join(', ')}`);
    }
    // layout shift measured in the browser (Lighthouse metrics are compared separately)
    if (u.cls > b.cls + cfg.thresholds.cls) {
      perf.pass = false;
      perf.details.push(`${label}: CLS ${b.cls.toFixed(3)} -> ${u.cls.toFixed(3)}`);
    }
    // backend
    if (u.phpNotices > b.phpNotices || u.liquidErrors > b.liquidErrors) {
      backend.pass = false;
      backend.details.push(`${label}: ${u.phpNotices - b.phpNotices} new PHP notices, ${u.liquidErrors - b.liquidErrors} new Liquid errors`);
    }
    // tracking: same beacon names and counts per URL
    const be = countEvents(b.beacons);
    const ue = countEvents(u.beacons);
    for (const k of new Set([...Object.keys(be), ...Object.keys(ue)])) {
      if ((be[k] ?? 0) !== (ue[k] ?? 0)) {
        tracking.pass = false;
        tracking.details.push(`${label}: ${k} ${be[k] ?? 0} -> ${ue[k] ?? 0}`);
      }
    }
  }
  // flows
  const flows: Check = { name: 'flows', pass: true, details: [], evidence: [] };
  for (const f of now.flows) {
    const b = base.flows.find((x) => x.name === f.name && x.viewport === f.viewport);
    if (!f.pass && !f.skipped) {
      flows.pass = false;
      flows.details.push(`${f.name} @${f.viewport}: ${f.detail}`);
    }
    if (b) {
      const newErrs = f.console.filter((s) => !b.console.includes(s));
      if (newErrs.length) {
        consoleC.pass = false;
        consoleC.details.push(`flow ${f.name}: ${newErrs.slice(0, 2).join(' | ')}`);
      }
      const be = countEvents(b.beacons);
      const fe = countEvents(f.beacons);
      for (const k of new Set([...Object.keys(be), ...Object.keys(fe)])) {
        if ((be[k] ?? 0) !== (fe[k] ?? 0)) {
          tracking.pass = false;
          tracking.details.push(`flow ${f.name} @${f.viewport}: ${k} ${be[k] ?? 0} -> ${fe[k] ?? 0}`);
        }
      }
    }
  }
  checks.push(visual, consoleC, network, flows, tracking, seo, a11y, backend, perf);
  return checks;
}

export interface PerfSample {
  url: string;
  device: 'mobile' | 'desktop';
  score: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
  accessibility: number | null;
  /** min and max of the runs, so "beyond noise" also means outside the baseline's own range. */
  range?: { score: [number | null, number | null]; lcp: [number | null, number | null]; tbt: [number | null, number | null]; cls: [number | null, number | null] };
}

/** Performance and Lighthouse accessibility pass rules: no sample URL worse than baseline beyond noise. */
export function comparePerformance(base: PerfSample[], now: PerfSample[], cfg: SiteConfig): Check[] {
  const t = cfg.thresholds;
  const perf: Check = { name: 'performance', pass: true, details: [], evidence: [] };
  const a11y: Check = { name: 'accessibility', pass: true, details: [], evidence: [] };
  for (const n of now) {
    const b = base.find((x) => x.url === n.url && x.device === n.device);
    if (!b) continue;
    const label = `${new URL(n.url).pathname} ${n.device}`;
    const hi = (k: 'lcp' | 'tbt' | 'cls') => b.range?.[k][1] ?? -Infinity;
    const lo = b.range?.score[0] ?? Infinity;
    if (b.lcp !== null && n.lcp !== null && n.lcp > b.lcp * (1 + t.lcpPct / 100) && n.lcp > hi('lcp')) perf.details.push(`${label}: LCP ${Math.round(b.lcp)} -> ${Math.round(n.lcp)} ms`);
    if (b.tbt !== null && n.tbt !== null && n.tbt > b.tbt + t.tbtMs && n.tbt > hi('tbt')) perf.details.push(`${label}: TBT ${Math.round(b.tbt)} -> ${Math.round(n.tbt)} ms`);
    if (b.cls !== null && n.cls !== null && n.cls > b.cls + t.cls && n.cls > hi('cls')) perf.details.push(`${label}: CLS ${b.cls.toFixed(3)} -> ${n.cls.toFixed(3)}`);
    if (b.score !== null && n.score !== null && n.score < b.score - t.score && n.score < lo) perf.details.push(`${label}: score ${b.score} -> ${n.score}`);
    if (b.accessibility !== null && n.accessibility !== null && n.accessibility < b.accessibility) a11y.details.push(`${label}: accessibility ${b.accessibility} -> ${n.accessibility}`);
  }
  perf.pass = perf.details.length === 0;
  a11y.pass = a11y.details.length === 0;
  return [perf, a11y];
}

/** Merges checks with the same name (an extra accessibility check from Lighthouse). */
export function mergeChecks(list: Check[]): Check[] {
  const out = new Map<string, Check>();
  for (const c of list) {
    const e = out.get(c.name);
    if (!e) out.set(c.name, { ...c, details: [...c.details], evidence: [...c.evidence] });
    else {
      e.pass = e.pass && c.pass;
      e.details.push(...c.details);
      e.evidence.push(...c.evidence);
    }
  }
  return [...out.values()];
}
