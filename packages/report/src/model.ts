import { existsSync, readFileSync } from 'node:fs';
import type { Analysis, AuditResult, SiteConfig, Finding, LabMetrics } from '@speedpilot/core';
import { plainTitle, costPhrase } from './plain.js';

export interface PageRow {
  url: string;
  template: string;
  device: 'mobile' | 'desktop';
  median: LabMetrics | null;
  range: Record<string, { min: number | null; max: number | null }> | null;
  runs: number;
  accessibility: number | null;
}

export interface ReportModel {
  kind: 'before' | 'after';
  site: string;
  siteName: string;
  domain: string;
  platform: 'wordpress' | 'shopify';
  stage: string;
  runId: string;
  generatedAt: string;
  branding: { name?: string; logo?: string; primary: string; accent: string };
  versions: Record<string, string>;
  grade: Analysis['grade'];
  templates: Analysis['templates'];
  cwv: { lab: Record<'LCP' | 'INP' | 'TBT' | 'CLS', 'pass' | 'fail' | 'n/a'>; field: 'pass' | 'fail' | 'not enough data' };
  top5: Array<{ checkId: string; title: string; cost: string; tier: string; urls: number }>;
  achievable: { current: number | null; reachable: number | null; note: string };
  risks: string[];
  pages: PageRow[];
  lcp: Array<{ url: string; element: string | null; src: string | null; phases: Record<string, number> | null }>;
  cls: Array<{ url: string; total: number; culprits: Array<{ selector: string | null; value: number; cause: string }> }>;
  interactions: Array<{ url: string; name: string; inp: number | null; inputDelay: number | null; processing: number | null; presentation: number | null; script: string | null; owner: string | null }>;
  topScripts: Array<{ owner: string; mainThreadMs: number; kb: number }>;
  thirdParties: Array<{ owner: string; requests: number; kb: number; mainThreadMs: number; pages: number }>;
  unused: Array<{ file: string; type: string; unusedKb: number; owner: string }>;
  images: Array<{ src: string; issue: string }>;
  fonts: Array<{ family: string; weight: string; source: string; display: string | null }>;
  backend: Array<{ label: string; value: string }>;
  errors: Array<{ url: string; kind: string; text: string }>;
  waterfall?: { ideal: Array<{ url: string; type: string }>; actual: Array<{ url: string; type: string; startMs: number; endMs: number }> };
  competitors?: Array<{ url: string; lcp?: number; inp?: number; notes: string[] }>;
  ceiling: Analysis['ceiling'];
  plan: Analysis['draftPlan'];
  findings: Finding[];
  notAutomated: Analysis['notAutomated'];
  groups: Analysis['groups'];
  field: AuditResult['field'];
  fieldNote: string;
  notes: string[];
  screenshot?: string;
  // after report
  after?: AfterSection;
}

export interface AfterSection {
  deltas: Array<{ url: string; device: string; metric: string; before: number | null; after: number | null; delta: number | null }>;
  screenshots: Array<{ url: string; before?: string; after?: string }>;
  filmstrips?: Array<{ url: string; before: string[]; after: string[] }>;
  changeLog: Array<{ id: string; what: string; where: string; why: string; implementation: string; status: string; rollback: string; reason?: string }>;
  verification: { result: 'PASS' | 'FAIL' | 'N/A'; checks: Array<{ name: string; pass: boolean; detail: string }>; evidenceDir?: string };
  blockers: Array<{ name: string; cost: string; options: string }>;
  recheck: { day7: string; day28: string };
  backups: Array<{ id: string; stage: string; verified: boolean; createdAt: string }>;
  rollbackKit: string[];
  safety: 'PASS' | 'FAIL' | 'N/A';
}

function dataUri(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

function status(v: number | null | undefined, limit: number): 'pass' | 'fail' | 'n/a' {
  if (v === null || v === undefined) return 'n/a';
  return v <= limit ? 'pass' : 'fail';
}

export function buildModel(kind: 'before' | 'after', cfg: SiteConfig, audit: AuditResult, analysis: Analysis): ReportModel {
  const mobile = audit.pages.filter((p) => p.device === 'mobile');
  const worst = (k: keyof LabMetrics) => {
    const v = mobile.map((p) => p.lighthouse?.median[k]).filter((x): x is number => typeof x === 'number');
    return v.length ? Math.max(...v) : null;
  };
  const worstInp = Math.max(0, ...mobile.flatMap((p) => (p.inp?.interactions ?? []).map((i) => i.inp ?? 0)));
  const findingsVisible = analysis.findings.filter((f) => f.tier !== 'report' && !f.checkId.startsWith('MEAS'));
  const seenCause = new Set<string>();
  const top5 = findingsVisible
    .filter((f) => {
      if (!f.rootCause) return true;
      if (seenCause.has(f.rootCause)) return false;
      seenCause.add(f.rootCause);
      return true;
    })
    .slice(0, 5).map((f) => ({ checkId: f.checkId, title: plainTitle(f), cost: costPhrase(f.estimatedGain), tier: f.tier, urls: f.urls.length }));
  const risks: string[] = [];
  if (analysis.findings.some((f) => ['JS-01', 'JS-08', 'SHT-02'].includes(f.checkId))) risks.push('Deferring scripts can break code that needs them early. SpeedPilot only defers scripts its X-ray proves safe, and tests every page after each change.');
  if (analysis.findings.some((f) => f.tier === 'T3')) risks.push('Some fixes change design, tracking, plugins or apps. Those need your written approval and are never applied without it.');
  if (cfg.platform === 'shopify') risks.push('Shopify’s own scripts and required apps set a limit on the best possible score; the report names each with its measured cost.');
  risks.push('Every change is applied one at a time on staging, measured, verified and rolled back automatically if anything breaks.');

  const loafByOwner = new Map<string, number>();
  const bytesByOwner = new Map<string, number>();
  for (const p of mobile) {
    for (const f of p.evidence.loaf) for (const s of f.scripts) loafByOwner.set(s.owner.id, (loafByOwner.get(s.owner.id) ?? 0) + s.duration / mobile.length);
    for (const r of p.evidence.requests) bytesByOwner.set(r.owner.id, (bytesByOwner.get(r.owner.id) ?? 0) + r.transferBytes / mobile.length);
  }
  const topScripts = [...loafByOwner.entries()].map(([owner, msv]) => ({ owner, mainThreadMs: Math.round(msv), kb: Math.round((bytesByOwner.get(owner) ?? 0) / 1024) })).sort((a, b) => b.mainThreadMs - a.mainThreadMs).slice(0, 10);
  const tpTable = (analysis.findings.find((f) => f.checkId === '3P-01')?.evidence.table as ReportModel['thirdParties'] | undefined) ?? [];

  const unused = new Map<string, ReportModel['unused'][number]>();
  for (const p of audit.pages) for (const c of p.evidence.coverage) if (c.unusedBytes > 10 * 1024 && !c.inline) unused.set(c.url, { file: c.url, type: c.type, unusedKb: Math.round(c.unusedBytes / 1024), owner: c.owner.id });
  const images: ReportModel['images'] = [];
  for (const p of mobile) {
    for (const i of p.evidence.images) {
      const issues: string[] = [];
      if (i.tag === 'img' && i.renderedWidth > 0 && i.naturalWidth > 1.5 * i.renderedWidth * i.dpr) issues.push(`oversized (${i.naturalWidth}px for ${i.renderedWidth}px)`);
      if (i.tag === 'img' && !i.hasWidthAttr && !i.hasAspectRatio) issues.push('no width/height');
      if (i.aboveFold && i.loading === 'lazy') issues.push('lazy above the fold');
      if (!i.aboveFold && i.loading !== 'lazy' && i.tag === 'img') issues.push('eager below the fold');
      if (issues.length && !images.some((x) => x.src === i.currentSrc)) images.push({ src: i.currentSrc, issue: issues.join(', ') });
    }
  }
  const fonts = [...new Map(audit.pages.flatMap((p) => p.evidence.fonts).map((f) => [`${f.family}|${f.weight}|${f.src}`, { family: f.family, weight: f.weight, source: f.source, display: f.display }])).values()].slice(0, 20);
  const backend: ReportModel['backend'] = [];
  const b = audit.backend as Record<string, unknown> | undefined;
  if (cfg.platform === 'wordpress' && b) {
    const wp = b as unknown as { core?: string; environment?: { php?: string }; autoload?: { total_bytes: number }; perUrl?: Array<{ url: string; ttfbCachedMs?: number; ttfbBypassMs?: number; serverTiming: Record<string, number>; diag?: { queries: Array<{ ms: number; caller: { function: string } }> } }>; cron?: { overdue: number }; plugins?: unknown[] };
    backend.push({ label: 'WordPress / PHP', value: `${wp.core ?? '?'} / ${wp.environment?.php ?? '?'}` });
    if (wp.autoload) backend.push({ label: 'Autoloaded options', value: `${Math.round(wp.autoload.total_bytes / 1024)} KB (Site Health limit 800 KB)` });
    for (const u of wp.perUrl ?? []) backend.push({ label: `TTFB ${new URL(u.url).pathname}`, value: `cached ${u.ttfbCachedMs ?? '–'} ms, bypassed ${u.ttfbBypassMs ?? '–'} ms, PHP total ${u.serverTiming['sp-total'] ?? '–'} ms` });
    const slow = (wp.perUrl ?? []).flatMap((u) => u.diag?.queries ?? []).filter((q) => q.ms >= 50);
    if (slow.length) backend.push({ label: 'Slow queries', value: slow.map((q) => `${q.ms} ms in ${q.caller.function}`).join('; ') });
    if (wp.cron) backend.push({ label: 'Overdue cron events', value: String(wp.cron.overdue) });
    backend.push({ label: 'Active plugins', value: String((wp.plugins as Array<{ status: string }> | undefined)?.filter((p) => p.status === 'active').length ?? '?') });
  }
  if (cfg.platform === 'shopify' && b) {
    const sh = b as unknown as { theme: { name: string; version: string; os2: boolean }; profile: Array<{ url: string; totalMs: number | null; hotSpots: Array<{ file: string; ms: number }> }>; themeCheck: unknown[]; leftovers: Array<{ file: string }> };
    backend.push({ label: 'Theme', value: `${sh.theme.name} ${sh.theme.version} (${sh.theme.os2 ? 'Online Store 2.0' : 'vintage'})` });
    for (const p of sh.profile) backend.push({ label: `Liquid render ${new URL(p.url).pathname}`, value: `${p.totalMs ?? '–'} ms; slowest: ${p.hotSpots.slice(0, 2).map((h) => `${h.file} ${h.ms} ms`).join(', ')}` });
    backend.push({ label: 'Theme Check offences', value: String(sh.themeCheck.length) });
    if (sh.leftovers.length) backend.push({ label: 'Leftover app code', value: sh.leftovers.map((l) => l.file).join(', ') });
  }
  const errors: ReportModel['errors'] = [];
  for (const p of audit.pages) {
    for (const e of p.evidence.errors.pageErrors) errors.push({ url: p.url, kind: 'uncaught error', text: e });
    for (const c of p.evidence.errors.console.filter((x) => x.type === 'error')) errors.push({ url: p.url, kind: 'console error', text: c.text });
    for (const f of p.evidence.errors.failedRequests) errors.push({ url: p.url, kind: 'failed request', text: `${f.status ?? f.failure} ${f.url}` });
    for (const l of p.evidence.errors.liquidErrors) errors.push({ url: p.url, kind: 'Liquid error', text: l });
    for (const n of p.evidence.errors.phpNotices) errors.push({ url: p.url, kind: 'PHP notice', text: n });
  }
  const dedupErrors = [...new Map(errors.map((e) => [e.kind + e.text, e])).values()].slice(0, 40);
  const home = mobile.find((p) => p.template === 'home') ?? mobile[0];
  const shot = home?.evidence.screenshots.find((s) => s.endsWith('.390.fold.png'));
  const fieldOk = analysis.field.allGood;
  return {
    kind,
    site: cfg.name,
    siteName: cfg.branding.name ?? cfg.name,
    domain: new URL(cfg.productionUrl).host,
    platform: cfg.platform,
    stage: audit.stage,
    runId: audit.runId,
    generatedAt: new Date().toISOString(),
    branding: cfg.branding,
    versions: audit.versions,
    grade: analysis.grade,
    templates: analysis.templates,
    cwv: { lab: { LCP: status(worst('lcp'), 2500), INP: worstInp ? (worstInp <= 200 ? 'pass' : 'fail') : 'n/a', TBT: status(worst('tbt'), 200), CLS: status(worst('cls'), 0.1) }, field: fieldOk === null ? 'not enough data' : fieldOk ? 'pass' : 'fail' },
    top5,
    achievable: { current: analysis.ceiling.current, reachable: analysis.ceiling.reachable, note: analysis.ceiling.note },
    risks,
    pages: audit.pages.map((p) => ({ url: p.url, template: p.template, device: p.device, median: p.lighthouse?.median ?? null, range: p.lighthouse?.range ?? null, runs: p.lighthouse?.runs ?? 0, accessibility: p.lighthouse?.accessibility ?? null })),
    lcp: mobile.map((p) => ({ url: p.url, element: p.evidence.lcp?.selector ?? null, src: p.evidence.lcp?.url ?? null, phases: p.evidence.lcp?.phases ?? null })),
    cls: mobile.map((p) => ({ url: p.url, total: p.evidence.cls.total, culprits: p.evidence.cls.culprits })),
    interactions: mobile.flatMap((p) => (p.inp?.interactions ?? []).filter((i) => i.ran).map((i) => ({ url: p.url, name: i.name, inp: i.inp, inputDelay: i.inputDelay, processing: i.processing, presentation: i.presentation, script: i.scripts[0]?.sourceURL ?? null, owner: i.scripts[0]?.owner.id ?? null }))).sort((a, b) => (b.inp ?? 0) - (a.inp ?? 0)).slice(0, 10),
    topScripts,
    thirdParties: tpTable,
    unused: [...unused.values()].sort((a, b) => b.unusedKb - a.unusedKb).slice(0, 15),
    images: images.slice(0, 20),
    fonts,
    backend,
    errors: dedupErrors,
    ceiling: analysis.ceiling,
    plan: analysis.draftPlan,
    findings: analysis.findings,
    notAutomated: analysis.notAutomated,
    groups: analysis.groups,
    field: audit.field,
    fieldNote: 'Field data (CrUX) is a 28-day rolling window of real Chrome users. Improvements show fully about 4 weeks after deploy. Lab and field numbers are reported separately.',
    notes: audit.notes,
    screenshot: dataUri(shot),
  };
}
