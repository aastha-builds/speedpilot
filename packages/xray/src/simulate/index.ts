/**
 * What-if simulator (SPEC.md 15.5, REV-08). A local rewriting proxy (mockttp) applies a proposed change to the HTML on
 * the way to a test browser: add defer or async, drop a script, delay a script until interaction, add a preload, make the
 * LCP image eager. Baseline and variant both go through the same proxy (5 runs each, interleaved, mobile network and 4x
 * CPU), then the quick verification runs on the variant. Measurement only: never served to visitors, always labelled
 * "simulated". Real numbers come from staging.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { getLocal, generateCACertificate, type Mockttp } from 'mockttp';
import { openSession, summarize, classify, type Device } from '@speedpilot/core';
import { visualDiff } from '@speedpilot/core';

export type SimChangeType = 'defer' | 'async' | 'remove' | 'remove-template' | 'delay' | 'preload' | 'lcp-eager';

export interface SimChange {
  type: SimChangeType;
  /** Script handle id, URL fragment, or for lcp-eager an image URL fragment; for preload the URL. */
  target: string;
  template?: string;
  /** For preload: the `as` value (image, font, style, script). */
  as?: string;
}

export function parseSimChange(s: string, template?: string): SimChange {
  const i = s.indexOf(':');
  const type = s.slice(0, i) as SimChangeType;
  const known: SimChangeType[] = ['defer', 'async', 'remove', 'remove-template', 'delay', 'preload', 'lcp-eager'];
  if (i < 0 || !known.includes(type)) throw new Error(`Unknown simulated change "${s}". Types: ${known.join(', ')}.`);
  let target = s.slice(i + 1);
  let tpl = template;
  let as: string | undefined;
  if (type === 'remove-template' && target.includes('@')) [target, tpl] = [target.slice(0, target.lastIndexOf('@')), target.slice(target.lastIndexOf('@') + 1)];
  if (type === 'preload' && target.includes('|')) [target, as] = [target.slice(0, target.lastIndexOf('|')), target.slice(target.lastIndexOf('|') + 1)];
  return { type, target, template: tpl, as };
}

const DELAY_LOADER = `<script data-speedpilot-sim="delay-loader">(function(){var done=false;function go(){if(done)return;done=true;document.querySelectorAll('script[type="text/speedpilot-delayed"]').forEach(function(o){var s=document.createElement('script');for(var i=0;i<o.attributes.length;i++){var a=o.attributes[i];if(a.name!=='type')s.setAttribute(a.name,a.value);}if(!o.src)s.text=o.text;o.replaceWith(s);});}['pointerdown','keydown','touchstart','scroll'].forEach(function(e){addEventListener(e,go,{once:true,passive:true});});})();</script>`;

function scriptMatches($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0], target: string): boolean {
  const e = $(el as never);
  const src = e.attr('src') ?? '';
  const id = e.attr('id') ?? '';
  // WordPress prints handle IDs as <handle>-js
  return (src !== '' && src.includes(target)) || id === `${target}-js` || id === target;
}

/** Applies one change to an HTML document with a parser (never a regex over the file). Returns the HTML and what changed. */
export function applyToHtml(html: string, change: SimChange, pageUrl: string, platform: 'wordpress' | 'shopify' = 'wordpress'): { html: string; applied: number } {
  if (change.type === 'remove-template' && change.template && classify(pageUrl, platform) !== change.template) return { html, applied: 0 };
  const $ = cheerio.load(html);
  let applied = 0;
  if (['defer', 'async', 'remove', 'remove-template', 'delay'].includes(change.type)) {
    $('script').each((_, el) => {
      if (!scriptMatches($, el, change.target)) return;
      const e = $(el);
      applied++;
      if (change.type === 'defer') e.attr('defer', '').removeAttr('async');
      else if (change.type === 'async') e.attr('async', '').removeAttr('defer');
      else if (change.type === 'remove' || change.type === 'remove-template') e.remove();
      else if (change.type === 'delay') e.attr('type', 'text/speedpilot-delayed');
    });
    if (change.type === 'delay' && applied) $('body').append(DELAY_LOADER);
  } else if (change.type === 'preload') {
    $('head').prepend(`<link rel="preload" href="${change.target}" as="${change.as ?? 'image'}"${change.as === 'font' ? ' crossorigin' : ''} data-speedpilot-sim="preload">`);
    applied = 1;
  } else if (change.type === 'lcp-eager') {
    $('img').each((_, el) => {
      const e = $(el);
      if (!(e.attr('src') ?? '').includes(change.target)) return;
      e.removeAttr('loading').attr('fetchpriority', 'high').attr('decoding', 'async');
      applied++;
    });
  }
  return { html: applied ? $.html() : html, applied };
}

export interface SimSample {
  lcp: number | null;
  fcp: number | null;
  cls: number;
  tbt: number;
  consoleErrors: string[];
  failedRequests: string[];
  screenshot: string;
}

export interface MetricRange {
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface SimulationResult {
  label: 'simulated';
  change: string;
  url: string;
  device: Device;
  runs: number;
  applied: number;
  baseline: Record<'lcp' | 'fcp' | 'cls' | 'tbt', MetricRange>;
  variant: Record<'lcp' | 'fcp' | 'cls' | 'tbt', MetricRange>;
  /** Predicted gain (baseline minus variant): median and the range over all baseline/variant pairs. */
  gain: Record<'lcpMs' | 'fcpMs' | 'tbtMs' | 'cls', MetricRange>;
  issues: string[];
  /** Breakage signals only (new console errors, failed requests, visual difference, nothing matched). */
  breakage: string[];
  /** REV-08: the change brings no meaningful gain on its own. */
  noGain: boolean;
  /** REV-08: false when the change brings no meaningful gain or shows breakage signals. */
  ok: boolean;
  evidenceDir: string;
}

export interface MeasureOptions {
  device?: Device;
  runs?: number;
  /** Mobile network emulation (Lighthouse mobile values) and CPU slowdown. */
  latencyMs?: number;
  downloadKbps?: number;
  cpuSlowdown?: number;
  outDir: string;
  local?: boolean;
  visualThreshold?: number;
}

const range = (xs: Array<number | null>): MetricRange => {
  const s = summarize(xs);
  return { median: s.median, min: s.min, max: s.max };
};

/** Starts the rewriting proxy. With no change it passes everything through untouched (the baseline arm). */
export async function startProxy(platform: 'wordpress' | 'shopify' = 'wordpress'): Promise<{ server: Mockttp; port: number; setChange(c: SimChange | SimChange[] | null): void; applied(): number; close(): Promise<void> }> {
  const https = await generateCACertificate();
  const server = getLocal({ https });
  await server.start();
  let change: SimChange[] | null = null;
  let applied = 0;
  await server.forAnyRequest().thenPassThrough({
    ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
    beforeResponse: async (res, req) => {
      const type = String(res.headers['content-type'] ?? '');
      if (!change || !type.includes('text/html') || res.statusCode !== 200) return;
      const text = await res.body.getText();
      if (text === undefined) return;
      let html = text;
      let n = 0;
      for (const c of change) {
        const r = applyToHtml(html, c, req.url, platform);
        html = r.html;
        n += r.applied;
      }
      const out = { html, applied: n };
      applied += out.applied;
      if (!out.applied) return;
      const headers = { ...res.headers };
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      headers['x-speedpilot'] = 'simulated';
      return { statusCode: res.statusCode, headers, body: out.html };
    },
  });
  return {
    server,
    port: server.port,
    setChange: (c) => {
      change = c === null ? null : Array.isArray(c) ? c : [c];
      applied = 0;
    },
    applied: () => applied,
    close: () => server.stop(),
  };
}

/** One measured page load in a fresh context: LCP, FCP, CLS, TBT (long tasks over 50 ms after FCP), console errors and failed requests. */
export async function measureOnce(browser: Browser, url: string, o: MeasureOptions, tag: string): Promise<SimSample> {
  const session = await openSession(browser, { device: o.device ?? 'mobile', local: o.local ?? true });
  try {
    const page = await session.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
    page.on('requestfailed', (r) => {
      const f = r.failure()?.errorText ?? '';
      if (!/blockedbyclient/i.test(f)) failedRequests.push(`${r.url()} ${f}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.url()} ${r.status()}`);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: o.latencyMs ?? 150, downloadThroughput: ((o.downloadKbps ?? 1638) * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpuSlowdown ?? 4 });
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const sp = (window as unknown as { __sp?: { lcp: Array<{ startTime: number }>; shifts: Array<{ value: number }>; longtasks: Array<{ startTime: number; duration: number }> } }).__sp;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const lcp = sp?.lcp.length ? sp.lcp[sp.lcp.length - 1]!.startTime : null;
      const cls = (sp?.shifts ?? []).reduce((a, s) => a + s.value, 0);
      const tbt = (sp?.longtasks ?? []).filter((t) => fcp === null || t.startTime >= fcp).reduce((a, t) => a + Math.max(0, t.duration - 50), 0);
      return { fcp, lcp, cls, tbt };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const screenshot = join(o.outDir, `${tag}.png`);
    await page.screenshot({ path: screenshot });
    return { ...m, consoleErrors, failedRequests, screenshot };
  } finally {
    await session.close();
  }
}

/** Measures N runs of a URL, optionally through a proxy (the simulator arms). */
export async function measure(url: string, o: MeasureOptions & { proxyPort?: number; tag: string }): Promise<SimSample[]> {
  mkdirSync(o.outDir, { recursive: true });
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (o.proxyPort) args.push(`--proxy-server=http://127.0.0.1:${o.proxyPort}`, '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors');
  const browser = await chromium.launch({ args });
  try {
    const out: SimSample[] = [];
    for (let i = 0; i < (o.runs ?? 5); i++) out.push(await measureOnce(browser, url, o, `${o.tag}.${i + 1}`));
    return out;
  } finally {
    await browser.close();
  }
}

function pairwise(base: Array<number | null>, variant: Array<number | null>): MetricRange {
  const b = base.filter((x): x is number => x !== null);
  const v = variant.filter((x): x is number => x !== null);
  if (!b.length || !v.length) return { median: null, min: null, max: null };
  const diffs: number[] = [];
  for (const x of b) for (const y of v) diffs.push(x - y);
  const med = (summarize(b).median ?? 0) - (summarize(v).median ?? 0);
  return { median: Math.round(med * 1000) / 1000, min: Math.round(Math.min(...diffs) * 1000) / 1000, max: Math.round(Math.max(...diffs) * 1000) / 1000 };
}

/** Runs the what-if simulation for one change on one URL. */
export async function simulate(url: string, changeStr: string | SimChange | SimChange[], o: MeasureOptions & { platform?: 'wordpress' | 'shopify' }): Promise<SimulationResult> {
  const list = Array.isArray(changeStr) ? changeStr : [typeof changeStr === 'string' ? parseSimChange(changeStr) : changeStr];
  const change = list;
  const key = typeof changeStr === 'string' ? changeStr : list.map((c) => `${c.type}:${c.target}${c.template ? `@${c.template}` : ''}`).join(' + ');
  const runs = o.runs ?? 5;
  const proxy = await startProxy(o.platform ?? 'wordpress');
  mkdirSync(o.outDir, { recursive: true });
  const base: SimSample[] = [];
  const variant: SimSample[] = [];
  let applied = 0;
  const args = ['--no-sandbox', '--disable-dev-shm-usage', `--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors'];
  const browser = await chromium.launch({ args });
  try {
    // interleave baseline and variant so drift on the machine hits both arms alike
    for (let i = 0; i < runs; i++) {
      proxy.setChange(null);
      base.push(await measureOnce(browser, url, o, `baseline.${i + 1}`));
      proxy.setChange(change);
      variant.push(await measureOnce(browser, url, o, `variant.${i + 1}`));
      applied = Math.max(applied, proxy.applied());
    }
  } finally {
    await browser.close();
    await proxy.close();
  }
  // quick verification on the variant against the baseline
  const issues: string[] = [];
  if (!applied) issues.push(`the change matched nothing on ${url}`);
  const baseErrors = new Set(base.flatMap((s) => s.consoleErrors));
  const newErrors = [...new Set(variant.flatMap((s) => s.consoleErrors))].filter((e) => !baseErrors.has(e));
  if (newErrors.length) issues.push(`new console errors: ${newErrors.slice(0, 3).join(' | ')}`);
  const baseFailed = new Set(base.flatMap((s) => s.failedRequests.map((f) => f.split(' ')[0])));
  const newFailed = [...new Set(variant.flatMap((s) => s.failedRequests))].filter((f) => !baseFailed.has(f.split(' ')[0]));
  if (newFailed.length) issues.push(`new failed requests: ${newFailed.slice(0, 3).join(' | ')}`);
  const baseNoise = visualDiff(base[0]!.screenshot, base[base.length - 1]!.screenshot).ratio;
  const vis = visualDiff(base[base.length - 1]!.screenshot, variant[variant.length - 1]!.screenshot, join(o.outDir, 'visual-diff.png'));
  if (vis.sizeChanged || vis.ratio > Math.max(o.visualThreshold ?? 0.01, baseNoise * 2)) issues.push(`visual difference ${(vis.ratio * 100).toFixed(2)}% (baseline noise ${(baseNoise * 100).toFixed(2)}%)`);
  const pick = (xs: SimSample[], k: keyof Pick<SimSample, 'lcp' | 'fcp' | 'cls' | 'tbt'>) => xs.map((x) => x[k] as number | null);
  const gain = { lcpMs: pairwise(pick(base, 'lcp'), pick(variant, 'lcp')), fcpMs: pairwise(pick(base, 'fcp'), pick(variant, 'fcp')), tbtMs: pairwise(pick(base, 'tbt'), pick(variant, 'tbt')), cls: pairwise(pick(base, 'cls'), pick(variant, 'cls')) };
  const breakage = [...issues];
  const meaningful = (gain.lcpMs.median ?? 0) >= 50 || (gain.fcpMs.median ?? 0) >= 50 || (gain.tbtMs.median ?? 0) >= 25 || (gain.cls.median ?? 0) >= 0.01;
  if (!meaningful) issues.push('no meaningful gain (LCP or FCP under 50 ms, TBT under 25 ms, CLS under 0.01)');
  const result: SimulationResult = {
    label: 'simulated',
    change: key,
    url,
    device: o.device ?? 'mobile',
    runs,
    applied,
    baseline: { lcp: range(pick(base, 'lcp')), fcp: range(pick(base, 'fcp')), cls: range(pick(base, 'cls')), tbt: range(pick(base, 'tbt')) },
    variant: { lcp: range(pick(variant, 'lcp')), fcp: range(pick(variant, 'fcp')), cls: range(pick(variant, 'cls')), tbt: range(pick(variant, 'tbt')) },
    gain,
    issues,
    breakage,
    noGain: !meaningful,
    ok: issues.length === 0,
    evidenceDir: o.outDir,
  };
  writeFileSync(join(o.outDir, 'simulation.json'), JSON.stringify({ ...result, samples: { baseline: base, variant } }, null, 2));
  return result;
}
