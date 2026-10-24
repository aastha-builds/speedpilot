import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, type SiteConfig } from '../config/site.js';
import { Store, type Stage } from '../store/store.js';
import { launchBrowser, releaseBrowser } from '../collectors/browser.js';
import { runLighthouse } from '../collectors/lighthouse.js';
import { capture, type Capture, type ResponseTransform } from './capture.js';
import { compareCaptures, comparePerformance, mergeChecks, type Check, type PerfSample } from './compare.js';
import { allFlows } from './flowLibrary.js';
import { rebase } from './smoke.js';
import { readState, writeState } from '../state.js';
import { hostFor } from '../backup/host.js';

export interface Baseline {
  site: string;
  stage: Stage;
  base: string;
  runId: string;
  dir: string;
  createdAt: string;
  urls: string[];
  captures: Capture[];
  perf: PerfSample[];
  backend: BackendSnapshot;
  versions: Record<string, string>;
}

export interface BackendSnapshot {
  phpLogLines: number | null;
  overdueCron: number | null;
  adminOk: boolean | null;
}

export interface VerificationResult {
  id: string;
  result: 'PASS' | 'FAIL';
  kind: 'quick' | 'full';
  checks: Check[];
  evidenceDir: string;
  baselineRunId: string;
}

export interface VerifyOptions {
  stage?: Stage;
  full?: boolean;
  urls?: string[];
  /** Lighthouse runs per URL and device (quick 3, full 5). 0 skips performance. */
  lighthouseRuns?: number;
  viewports?: Array<'mobile' | 'tablet' | 'desktop'>;
  transform?: ResponseTransform;
  flows?: boolean;
  store?: Store;
  base?: string;
  only?: Check['name'][];
}

function baseFor(root: string, cfg: SiteConfig, stage: Stage, override?: string): string {
  if (override) return override;
  if (stage === 'staging') {
    const snap = readState(root, cfg.name).snapshot as { stagingUrl?: string } | undefined;
    return cfg.stagingUrl ?? snap?.stagingUrl ?? cfg.productionUrl;
  }
  return cfg.productionUrl;
}

async function backendSnapshot(root: string, cfg: SiteConfig, stage: Stage): Promise<BackendSnapshot> {
  if (cfg.platform !== 'wordpress') return { phpLogLines: null, overdueCron: null, adminOk: null };
  try {
    const host = hostFor(root, cfg, stage);
    const log = await host.shell(`wc -l < ${host.docroot}/wp-content/debug.log 2>/dev/null || echo 0`);
    const cron = await host.wp.json<Array<{ next_run_gmt: string }>>(['cron', 'event', 'list', '--fields=next_run_gmt']).catch(() => []);
    const overdue = cron.filter((e) => Date.parse(e.next_run_gmt + 'Z') < Date.now() - 600_000).length;
    return { phpLogLines: Number(log.stdout.trim()) || 0, overdueCron: overdue, adminOk: null };
  } catch {
    return { phpLogLines: null, overdueCron: null, adminOk: null };
  }
}

async function perfSamples(urls: string[], runs: number, outDir: string): Promise<PerfSample[]> {
  const out: PerfSample[] = [];
  if (!runs) return out;
  for (const url of urls) {
    for (const device of ['mobile', 'desktop'] as const) {
      const r = await runLighthouse(url, device, { runs, outDir });
      out.push({
        url,
        device,
        score: r.median.score,
        lcp: r.median.lcp,
        tbt: r.median.tbt,
        cls: r.median.cls,
        accessibility: r.accessibility,
        range: { score: [r.range.score.min, r.range.score.max], lcp: [r.range.lcp.min, r.range.lcp.max], tbt: [r.range.tbt.min, r.range.tbt.max], cls: [r.range.cls.min, r.range.cls.max] },
      });
    }
  }
  return out;
}

function flowsFor(cfg: SiteConfig, baselineUrls: string[]) {
  const woo = cfg.platform === 'wordpress' && baselineUrls.some((u) => /\/(shop|product)\//.test(u));
  return allFlows(cfg, { woocommerce: woo, variableProductUrl: baselineUrls.find((u) => /variable/.test(u)), productUrl: baselineUrls.find((u) => /\/products\//.test(u)) });
}

/** `speedpilot baseline`: records the verification baseline (SPEC.md 6). */
export async function recordBaseline(root: string, site: string, opts: VerifyOptions = {}): Promise<Baseline> {
  const cfg = loadSite(root, site);
  const stage: Stage = opts.stage ?? (cfg.local ? 'local' : 'staging');
  const store = opts.store ?? new Store(root);
  try {
    store.upsertSite(cfg);
    const run = store.startRun(site, 'baseline', stage);
    const base = baseFor(root, cfg, stage, opts.base);
    const urls = (opts.urls ?? (cfg.sampleUrls.length ? cfg.sampleUrls : [cfg.productionUrl])).map((u) => rebase(u, base));
    const flows = opts.flows === false ? [] : flowsFor(cfg, urls);
    const browser = await launchBrowser();
    const captures: Capture[] = [];
    try {
      captures.push(await capture(browser, cfg, { base, urls, flows, outDir: join(run.dir, 'screenshots'), stage, viewports: opts.viewports }));
      if (cfg.consent.tool) captures.push(await capture(browser, cfg, { base, urls, flows: [], outDir: join(run.dir, 'screenshots', 'granted'), stage, viewports: ['mobile'], consent: 'granted' }));
    } finally {
      await releaseBrowser();
    }
    const perf = await perfSamples(urls, opts.lighthouseRuns ?? (opts.full ? 5 : 3), join(run.dir, 'lighthouse'));
    const b: Baseline = { site, stage, base, runId: run.id, dir: run.dir, createdAt: new Date().toISOString(), urls, captures, perf, backend: await backendSnapshot(root, cfg, stage), versions: JSON.parse(run.tool_versions_json) };
    writeFileSync(join(run.dir, 'baseline.json'), JSON.stringify(b, null, 1));
    store.addVerification({ id: `ver-${run.id}`, runId: run.id, site, stage, kind: 'baseline', result: 'PASS', checks: [], evidenceDir: run.dir });
    writeState(root, site, { lastBaseline: { ...(readState(root, site).lastBaseline ?? {}), [stage]: run.id } });
    store.endRun(run.id, 'ok');
    return b;
  } finally {
    if (!opts.store) store.close();
  }
}

export function loadBaseline(root: string, site: string, stage: Stage, store: Store): Baseline {
  const id = readState(root, site).lastBaseline?.[stage];
  const run = id ? store.getRun(id) : store.latestRun(site, 'baseline', stage);
  if (!run || !existsSync(join(run.dir, 'baseline.json'))) throw new Error(`No baseline for ${site} on ${stage}. Run \`speedpilot baseline ${site} --stage ${stage}\`.`);
  return JSON.parse(readFileSync(join(run.dir, 'baseline.json'), 'utf8')) as Baseline;
}

/** `speedpilot verify`: compares the current state with the baseline. PASS only if every check passes. */
export async function verify(root: string, site: string, opts: VerifyOptions = {}): Promise<VerificationResult> {
  const cfg = loadSite(root, site);
  const stage: Stage = opts.stage ?? (cfg.local ? 'local' : 'staging');
  const store = opts.store ?? new Store(root);
  try {
    const baseline = loadBaseline(root, site, stage, store);
    const run = store.startRun(site, 'verify', stage);
    const urls = opts.urls ? opts.urls.map((u) => rebase(u, baseline.base)) : baseline.urls;
    const kind = opts.full ? 'full' : 'quick';
    const viewports = opts.viewports ?? (opts.full ? undefined : (['mobile', 'desktop'] as Array<'mobile' | 'desktop'>));
    const browser = await launchBrowser();
    const checks: Check[] = [];
    try {
      const flows = opts.flows === false ? [] : flowsFor(cfg, baseline.urls);
      const now = await capture(browser, cfg, { base: baseline.base, urls, flows, outDir: join(run.dir, 'screenshots'), stage, viewports, transform: opts.transform });
      const baseCap = baseline.captures.find((c) => c.consent !== 'granted')!;
      checks.push(...compareCaptures({ ...baseCap, urls: baseCap.urls.filter((u) => urls.includes(u.url)) }, now, cfg, run.dir));
      const granted = baseline.captures.find((c) => c.consent === 'granted');
      if (granted) {
        const g = await capture(browser, cfg, { base: baseline.base, urls, flows: [], outDir: join(run.dir, 'screenshots', 'granted'), stage, viewports: ['mobile'], consent: 'granted', transform: opts.transform, earlyPaint: false });
        checks.push(...compareCaptures(granted, g, cfg).filter((c) => c.name === 'tracking').map((c) => ({ ...c, details: c.details.map((d) => `consent granted: ${d}`) })));
      }
    } finally {
      await releaseBrowser();
    }
    if (!opts.only || opts.only.includes('performance')) {
      const runs = opts.lighthouseRuns ?? (opts.full ? 5 : 3);
      if (runs > 0 && !opts.transform) checks.push(...comparePerformance(baseline.perf.filter((p) => urls.includes(p.url)), await perfSamples(urls, runs, join(run.dir, 'lighthouse')), cfg));
    }
    const be = await backendSnapshot(root, cfg, stage);
    const backendCheck: Check = { name: 'backend', pass: true, details: [], evidence: [] };
    if (be.phpLogLines !== null && baseline.backend.phpLogLines !== null && be.phpLogLines > baseline.backend.phpLogLines) {
      const host = hostFor(root, cfg, stage);
      const tail = await host.shell(`tail -n ${be.phpLogLines - baseline.backend.phpLogLines} ${host.docroot}/wp-content/debug.log 2>/dev/null`);
      const bad = tail.stdout.split('\n').filter((l) => /PHP (Warning|Fatal|Parse)/.test(l));
      if (bad.length) {
        backendCheck.pass = false;
        backendCheck.details.push(`${bad.length} new PHP warnings or fatals: ${bad[0]?.slice(0, 200)}`);
      }
    }
    if (be.overdueCron !== null && baseline.backend.overdueCron !== null && be.overdueCron > baseline.backend.overdueCron + 2) {
      backendCheck.pass = false;
      backendCheck.details.push(`overdue cron events ${baseline.backend.overdueCron} -> ${be.overdueCron}`);
    }
    checks.push(backendCheck);
    let merged = mergeChecks(checks);
    if (opts.only) merged = merged.filter((c) => opts.only!.includes(c.name));
    const result: VerificationResult = { id: `ver-${run.id}`, result: merged.every((c) => c.pass) ? 'PASS' : 'FAIL', kind, checks: merged, evidenceDir: run.dir, baselineRunId: baseline.runId };
    writeFileSync(join(run.dir, 'verification.json'), JSON.stringify(result, null, 1));
    store.addVerification({ id: result.id, runId: run.id, site, stage, kind, result: result.result, checks: merged, evidenceDir: run.dir });
    store.endRun(run.id, 'ok');
    return result;
  } finally {
    if (!opts.store) store.close();
  }
}

export * from './capture.js';
export * from './compare.js';
export * from './flowLibrary.js';
