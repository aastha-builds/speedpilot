import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { getAuditMap, type AuditMap } from './auditMap.js';
import { LIGHTHOUSE_BLOCKED_PATTERNS } from './beacons.js';
import { summarize, medianIndex } from '../util/stats.js';

import type { Device } from './browser.js';


export interface LabMetrics {
  score: number | null;
  fcp: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
  si: number | null;
  ttfb: number | null;
}

export interface LighthouseRun {
  index: number;
  metrics: LabMetrics;
  jsonPath: string;
  htmlPath: string;
  /** IDs of insight and diagnostic audits that failed (score < 0.9) in this run. */
  failing: string[];
  lhr: LhrLite;
}

/** The subset of the Lighthouse result SpeedPilot reads. */
export interface LhrLite {
  lighthouseVersion: string;
  finalDisplayedUrl: string;
  userAgent: string;
  environment?: { hostUserAgent?: string };
  categories: { performance?: { score: number | null }; accessibility?: { score: number | null } };
  audits: Record<string, { id: string; score: number | null; numericValue?: number; displayValue?: string; details?: unknown; title?: string; scoreDisplayMode?: string }>;
  runWarnings: string[];
}

export interface LighthouseResult {
  url: string;
  device: Device;
  runs: LighthouseRun[];
  median: LabMetrics;
  range: Record<keyof LabMetrics, { min: number | null; max: number | null }>;
  medianRun: LighthouseRun;
  versions: { lighthouse: string; chrome: string };
  auditMap: AuditMap;
  accessibility: number | null;
}

export interface LighthouseOptions {
  runs?: number;
  outDir: string;
  /** Cookie header for password-protected Shopify stores (MEAS-06). */
  cookie?: string;
  extraHeaders?: Record<string, string>;
  extraBlocked?: string[];
  chromePath?: string;
  /** Throttling override for tests. */
  throttlingMethod?: 'simulate' | 'devtools' | 'provided';
  categories?: string[];
}

const require = createRequire(import.meta.url);

export function chromePath(): string {
  return process.env.CHROME_PATH ?? chromium.executablePath();
}

function metricsFrom(lhr: LhrLite, map: AuditMap): LabMetrics {
  const n = (k: keyof AuditMap) => lhr.audits[map[k]]?.numericValue ?? null;
  const ttfbAudit = lhr.audits[map.documentLatency];
  // document-latency-insight reports server response time in its details; fall back to server-response-time if present.
  let ttfb: number | null = lhr.audits['server-response-time']?.numericValue ?? null;
  const d = ttfbAudit?.details as { debugData?: { serverResponseTime?: number }; checklist?: { serverResponseIsFast?: { value?: number } } } | undefined;
  if (ttfb === null) ttfb = d?.debugData?.serverResponseTime ?? null;
  const score = lhr.categories.performance?.score;
  return { score: typeof score === 'number' ? Math.round(score * 100) : null, fcp: n('fcp'), lcp: n('lcp'), tbt: n('tbt'), cls: n('cls'), si: n('speedIndex'), ttfb };
}

function failingAudits(lhr: LhrLite): string[] {
  return Object.values(lhr.audits)
    .filter((a) => typeof a.score === 'number' && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'manual')
    .map((a) => a.id);
}

/** Runs Lighthouse 13 N times for one URL and device; keeps the median run by performance score (SPEC.md 3.2). */
export async function runLighthouse(url: string, device: Device, opts: LighthouseOptions): Promise<LighthouseResult> {
  const { map, version } = await getAuditMap();
  const lighthouse = (await import('lighthouse')).default as unknown as (url: string, flags: Record<string, unknown>, config?: unknown) => Promise<{ lhr: LhrLite; report: string | string[] } | undefined>;
  const desktopConfig = device === 'desktop' ? (await import('lighthouse/core/config/desktop-config.js')).default : undefined;
  const n = opts.runs ?? 5;
  const runs: LighthouseRun[] = [];
  let chromeVersion = 'unknown';
  for (let i = 0; i < n; i++) {
    // a fresh, clean profile for every run, no extensions
    const chrome = await chromeLauncher.launch({
      chromePath: opts.chromePath ?? chromePath(),
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-dev-shm-usage'],
    });
    try {
      const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
      if (opts.cookie) headers.Cookie = opts.cookie;
      const flags: Record<string, unknown> = {
        port: chrome.port,
        output: ['json', 'html'],
        logLevel: 'error',
        onlyCategories: opts.categories ?? ['performance', 'accessibility'],
        blockedUrlPatterns: [...LIGHTHOUSE_BLOCKED_PATTERNS, ...(opts.extraBlocked ?? [])],
        extraHeaders: Object.keys(headers).length ? headers : undefined,
        throttlingMethod: opts.throttlingMethod,
      };
      const result = await lighthouse(url, flags, desktopConfig);
      if (!result) throw new Error(`Lighthouse returned no result for ${url}`);
      const [json, html] = result.report as string[];
      const base = join(opts.outDir, `${slugUrl(url)}.${device}.${i + 1}`);
      writeFileSync(`${base}.json`, json!);
      writeFileSync(`${base}.html`, html!);
      chromeVersion = result.lhr.environment?.hostUserAgent?.match(/Chrome\/([\d.]+)/)?.[1] ?? chromeVersion;
      runs.push({ index: i + 1, metrics: metricsFrom(result.lhr, map), jsonPath: `${base}.json`, htmlPath: `${base}.html`, failing: failingAudits(result.lhr), lhr: result.lhr });
    } finally {
      await chrome.kill();
    }
  }
  const keys: Array<keyof LabMetrics> = ['score', 'fcp', 'lcp', 'tbt', 'cls', 'si', 'ttfb'];
  const median = {} as LabMetrics;
  const range = {} as LighthouseResult['range'];
  for (const k of keys) {
    const s = summarize(runs.map((r) => r.metrics[k]));
    median[k] = s.median;
    range[k] = { min: s.min, max: s.max };
  }
  const medianRun = runs[medianIndex(runs.map((r) => r.metrics.score ?? 0))]!;
  const a11y = medianRun.lhr.categories.accessibility?.score;
  return { url, device, runs, median, range, medianRun, versions: { lighthouse: version, chrome: chromeVersion }, auditMap: map, accessibility: typeof a11y === 'number' ? Math.round(a11y * 100) : null };
}

export function slugUrl(url: string): string {
  const u = new URL(url);
  const s = (u.host + u.pathname + (u.search ? '-' + u.search.slice(1) : '')).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, 100) || 'root';
}

export function lighthouseVersion(): string {
  return (require('lighthouse/package.json') as { version: string }).version;
}
