import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadSite, secret, type SiteConfig } from './config/site.js';
import { Store, type Stage } from './store/store.js';
import { buildInventory, classify, type Inventory, type InventoryUrl, type Template } from './collectors/inventory.js';
import { runLighthouse, type LighthouseResult, type LabMetrics } from './collectors/lighthouse.js';
import { launchBrowser, releaseBrowser, openSession, setConsent, type Device } from './collectors/browser.js';
import { collectPage, type PageEvidence } from './collectors/page.js';
import { interactionsFor, measureInteractions, INTERACTIONS, type InpResult } from './collectors/interactions.js';
import { cruxRecord, cruxHistory, pageSpeedInsights, isPublicUrl, type FieldResult, type PsiResult } from './collectors/google.js';
import type { OwnerContext } from './collectors/owners.js';
import { log, redact } from './log.js';
import { writeState } from './state.js';
import { RateLimiter } from './util/exec.js';
import { collectWordPressBackend } from './backend/wordpress.js';

const require = createRequire(import.meta.url);

export interface LhAuditLite {
  id: string;
  score: number | null;
  numericValue?: number;
  displayValue?: string;
  items?: unknown[];
}

export interface PageAudit {
  url: string;
  template: Template;
  device: Device;
  lighthouse?: {
    median: LabMetrics;
    range: LighthouseResult['range'];
    accessibility: number | null;
    medianJson: string;
    failing: string[];
    audits: Record<string, LhAuditLite>;
    runs: number;
  };
  evidence: Omit<PageEvidence, 'html'>;
  evidenceGranted?: Omit<PageEvidence, 'html'>;
  inp?: { pageInp: number | null; interactions: InpResult[] };
}

export interface AuditResult {
  runId: string;
  dir: string;
  site: string;
  platform: 'wordpress' | 'shopify';
  stage: Stage;
  versions: Record<string, string>;
  inventory: Pick<Inventory, 'sitemaps' | 'variants'> & { urlCount: number; sample: InventoryUrl[] };
  pages: PageAudit[];
  field: FieldResult[];
  psi: PsiResult[];
  startedAt: string;
  endedAt: string;
  notes: string[];
  backend?: unknown;
}

export interface AuditOptions {
  stage?: Stage;
  lighthouseRuns?: number;
  devices?: Device[];
  skipLighthouse?: boolean;
  skipInteractions?: boolean;
  screenshots?: boolean;
  trace?: boolean;
  urls?: string[];
  ownerRules?: OwnerContext['rules'];
  store?: Store;
  skipBackend?: boolean;
  /** Platform backend collector (the Shopify one lives in @speedpilot/shopify). WordPress defaults to the core one. */
  backend?: (ctx: { root: string; cfg: SiteConfig; stage: Stage; runDir: string; urls: string[]; pages: PageAudit[] }) => Promise<unknown>;
}

export function toolVersions(): Record<string, string> {
  const v = (p: string) => {
    try {
      return (require(`${p}/package.json`) as { version: string }).version;
    } catch {
      return 'missing';
    }
  };
  return { speedpilot: '0.1.0', node: process.version, lighthouse: v('lighthouse'), playwright: v('playwright'), 'web-vitals': v('web-vitals'), 'third-party-web': v('third-party-web') };
}

function lite(lhr: LighthouseResult['medianRun']['lhr']): Record<string, LhAuditLite> {
  const out: Record<string, LhAuditLite> = {};
  for (const a of Object.values(lhr.audits)) {
    const details = a.details as { items?: unknown[] } | undefined;
    out[a.id] = { id: a.id, score: a.score, numericValue: a.numericValue, displayValue: a.displayValue, items: Array.isArray(details?.items) ? details.items.slice(0, 25) : undefined };
  }
  return out;
}

function stripHtml(e: PageEvidence): Omit<PageEvidence, 'html'> {
  const { html: _html, ...rest } = e;
  void _html;
  return rest;
}

/** `speedpilot audit`: read-only collection on one stage (SPEC.md 3). */
export async function auditSite(root: string, siteName: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const cfg: SiteConfig = loadSite(root, siteName);
  const stage: Stage = opts.stage ?? (cfg.local ? 'local' : 'production');
  const store = opts.store ?? new Store(root);
  const ownStore = !opts.store;
  store.upsertSite(cfg);
  const versions = toolVersions();
  const run = store.startRun(siteName, 'audit', stage, versions);
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const base = stage === 'staging' && cfg.stagingUrl ? cfg.stagingUrl : cfg.productionUrl;
  const local = cfg.local || stage === 'local';
  writeState(root, siteName, { currentTarget: { stage: local ? 'local' : stage, url: base } });
  try {
    const flowUrls = cfg.flows.flatMap((f) => f.steps.filter((s): s is { goto: string } => 'goto' in s).map((s) => new URL(s.goto, base).href));
    const rebase = (u: string) => (stage === 'staging' && cfg.stagingUrl ? u.replace(new URL(cfg.productionUrl).origin, new URL(cfg.stagingUrl).origin) : u);
    const inventory = await buildInventory(
      { homeUrl: base, platform: cfg.platform, sampleUrls: (opts.urls ?? cfg.sampleUrls).map(rebase), sampleSize: cfg.sampleSize, flowUrls },
      { limiter: new RateLimiter(local ? 0 : 1000) },
    );
    const ownerCtx: OwnerContext = {
      siteOrigin: new URL(base).origin,
      platform: cfg.platform,
      rules: [...(opts.ownerRules ?? []), ...cfg.keepThirdParties.map((h) => ({ match: h, owner: `third-party:${h}` }))],
    };
    const devices = opts.devices ?? ['mobile', 'desktop'];
    const pages: PageAudit[] = [];
    const browser = await launchBrowser();
    try {
      for (const u of inventory.sample) {
        for (const device of devices) {
          log.info({ url: u.url, device }, 'auditing');
          let lh: PageAudit['lighthouse'];
          if (!opts.skipLighthouse) {
            const r = await runLighthouse(u.url, device, { runs: opts.lighthouseRuns ?? 5, outDir: join(run.dir, 'lighthouse') });
            versions.chrome = r.versions.chrome;
            lh = { median: r.median, range: r.range, accessibility: r.accessibility, medianJson: r.medianRun.jsonPath, failing: r.medianRun.failing, audits: lite(r.medianRun.lhr), runs: r.runs.length };
            for (const [name, value] of Object.entries(r.median)) {
              const k = name as keyof LabMetrics;
              store.addMetric({ runId: run.id, url: u.url, device, source: 'lab', name, median: value, min: r.range[k].min, max: r.range[k].max, samples: r.runs.map((x) => x.metrics[k] ?? NaN).filter(Number.isFinite) });
            }
            store.addMetric({ runId: run.id, url: u.url, device, source: 'lab', name: 'accessibility', median: r.accessibility, min: r.accessibility, max: r.accessibility, samples: [] });
            if (r.runs.length >= 5 && (r.range.score.max ?? 0) - (r.range.score.min ?? 0) > 10) notes.push(`MEAS-01: ${u.url} ${device} scores spread more than 10 points; rerun on a quiet machine.`);
          }
          const session = await openSession(browser, { device, local, mutationAllowlist: local ? [/.*/] : [] });
          try {
            const ev = await collectPage(session, u.url, device, {
              outDir: run.dir,
              ownerCtx,
              screenshots: opts.screenshots ?? true,
              masks: cfg.masks,
              trace: opts.trace ?? device === 'mobile',
              consent: 'denied',
              interact: async (page) => {
                for (const name of ['mobileMenu', 'accordion', 'sliderNext']) await INTERACTIONS[name]!.run(page).catch(() => false);
              },
            });
            let granted: PageEvidence | undefined;
            if (cfg.consent.tool || ev.html.match(/cookiebot|onetrust|cmplz|cky-consent|iubenda|usercentrics/i)) {
              const s2 = await openSession(browser, { device, local, mutationAllowlist: local ? [/.*/] : [] });
              try {
                const p = await s2.newPage();
                await p.goto(u.url, { waitUntil: 'load' });
                await setConsent(p, 'granted');
                await p.close();
                granted = await collectPage(s2, u.url, device, { outDir: run.dir, ownerCtx, consent: 'granted', screenshots: false });
              } finally {
                await s2.close();
              }
            }
            let inp: PageAudit['inp'];
            if (!opts.skipInteractions && device === 'mobile') {
              const s3 = await openSession(browser, { device: 'mobile', local, mutationAllowlist: local ? [/.*/] : [] });
              try {
                inp = await measureInteractions(s3, u.url, interactionsFor(u.template, local ? 'local' : stage), ownerCtx);
              } finally {
                await s3.close();
              }
              for (const i of inp.interactions.filter((x) => x.inp !== null)) store.addMetric({ runId: run.id, url: u.url, device, source: 'lab', name: `inp:${i.name}`, median: i.inp, min: i.inp, max: i.inp, samples: [i.inp!] });
            }
            store.addPage({ runId: run.id, url: u.url, template: u.template, device, runIndex: 0, lighthousePath: lh?.medianJson, tracePath: ev.tracePath, screenshots: ev.screenshots });
            pages.push({ url: u.url, template: u.template ?? classify(u.url, cfg.platform), device, lighthouse: lh, evidence: stripHtml(ev), evidenceGranted: granted ? stripHtml(granted) : undefined, inp });
            writeFileSync(join(run.dir, 'logs', `${u.url.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.${device}.html`), ev.html);
          } finally {
            await session.close();
          }
        }
      }
    } finally {
      await releaseBrowser();
    }

    // Field data and PSI: public URLs only (SPEC.md 12)
    const field: FieldResult[] = [];
    const psi: PsiResult[] = [];
    const key = secret(cfg.access.googleApiKey);
    if (key && isPublicUrl(base) && stage === 'production') {
      const origin = new URL(base).origin;
      for (const ff of ['PHONE', 'DESKTOP'] as const) {
        field.push(await cruxRecord({ origin }, ff, key));
        for (const u of inventory.sample.slice(0, 5)) field.push(await cruxRecord({ url: u.url }, ff, key));
      }
      const hist = await cruxHistory({ origin }, 'PHONE', key);
      if (hist.length) writeFileSync(join(run.dir, 'logs', 'crux-history.json'), JSON.stringify(hist, null, 1));
      for (const u of inventory.sample.slice(0, 3)) psi.push(...(await pageSpeedInsights(u.url, 'mobile', key, 3)));
      for (const f of field) {
        if (f.status !== 'ok') continue;
        for (const [n, v] of Object.entries(f.metrics)) if (typeof v === 'number') store.addMetric({ runId: run.id, url: f.scope === 'origin' ? origin : base, device: f.formFactor === 'PHONE' ? 'mobile' : 'desktop', source: 'field', name: n, median: v, min: v, max: v, samples: [v] });
      }
    } else notes.push(key ? 'Field data (CrUX) and PSI are skipped for non-public or non-production targets.' : 'No Google API key: CrUX field data and PSI are skipped (field data is marked "not enough data").');

    let backend: unknown;
    if (!opts.skipBackend) {
      const urls = [...new Set(pages.map((p) => p.url))];
      try {
        if (opts.backend) backend = await opts.backend({ root, cfg, stage, runDir: run.dir, urls, pages });
        else if (cfg.platform === 'wordpress') backend = await collectWordPressBackend(root, cfg, stage, urls);
      } catch (e) {
        notes.push(`Backend collection failed: ${(e as Error).message}`);
      }
      if (backend) writeFileSync(join(run.dir, 'backend.json'), JSON.stringify(redact(backend), null, 1));
    }

    const result: AuditResult = {
      runId: run.id,
      dir: run.dir,
      site: siteName,
      platform: cfg.platform,
      stage,
      versions,
      inventory: { sitemaps: inventory.sitemaps, variants: inventory.variants, urlCount: inventory.urls.length, sample: inventory.sample },
      pages,
      field,
      psi,
      startedAt,
      endedAt: new Date().toISOString(),
      notes,
      backend,
    };
    store.setToolVersions(run.id, versions);
    writeFileSync(join(run.dir, 'audit.json'), JSON.stringify(redact(result), null, 1));
    store.endRun(run.id, 'ok');
    return result;
  } catch (e) {
    store.endRun(run.id, 'failed');
    throw e;
  } finally {
    if (ownStore) store.close();
  }
}
