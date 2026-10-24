import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite } from './config/site.js';
import { Store } from './store/store.js';
import { paths } from './util/paths.js';
import { loadRules, analyze, type AnalysisResult, type Finding } from './rules/engine.js';
import type { AuditResult } from './audit.js';
import type { WpBackend } from './backend/wordpress.js';
import type { ShopifyBackendLite, XraySummaryLite } from './rules/types.js';
import { gradeSite, type TemplateMetrics, type FieldStatus } from './rules/grades.js';

export interface DraftPlanItem {
  id: string;
  findingIds: string[];
  checkId: string;
  title: string;
  where: string[];
  tier: Finding['tier'];
  expectedGain: Finding['estimatedGain'];
  guards: string[];
  rollback: string;
}

export interface Analysis extends AnalysisResult {
  runId: string;
  site: string;
  platform: 'wordpress' | 'shopify';
  grade: ReturnType<typeof gradeSite>;
  templates: TemplateMetrics[];
  field: FieldStatus;
  draftPlan: DraftPlanItem[];
  createdAt: string;
}

export function loadAudit(root: string, site: string, runId?: string, store?: Store): AuditResult {
  const s = store ?? new Store(root);
  try {
    const run = runId ? s.getRun(runId) : s.latestRun(site, 'audit');
    if (!run) throw new Error(`No audit run for ${site}. Run \`speedpilot audit ${site}\` first.`);
    return JSON.parse(readFileSync(join(run.dir, 'audit.json'), 'utf8')) as AuditResult;
  } finally {
    if (!store) s.close();
  }
}

export function templateMetrics(audit: AuditResult): TemplateMetrics[] {
  const out = new Map<string, TemplateMetrics>();
  for (const p of audit.pages) {
    const t = out.get(p.template) ?? { template: p.template, mobileScore: null, desktopScore: null, lcp: null, tbt: null, cls: null, worstInteraction: null };
    const m = p.lighthouse?.median;
    const worst = (a: number | null, b: number | null | undefined, max = true) => (b === null || b === undefined ? a : a === null ? b : max ? Math.max(a, b) : Math.min(a, b));
    if (p.device === 'mobile') {
      t.mobileScore = worst(t.mobileScore, m?.score, false);
      t.lcp = worst(t.lcp, m?.lcp ?? p.evidence.lcp?.startTime);
      t.tbt = worst(t.tbt, m?.tbt);
      t.cls = worst(t.cls, m?.cls ?? p.evidence.cls.total);
      const inter = (p.inp?.interactions ?? []).map((i) => i.inp).filter((x): x is number => typeof x === 'number');
      if (inter.length) t.worstInteraction = worst(t.worstInteraction, Math.max(...inter));
    } else t.desktopScore = worst(t.desktopScore, m?.score, false);
    out.set(p.template, t);
  }
  return [...out.values()];
}

export function fieldStatus(audit: AuditResult): FieldStatus {
  const o = audit.field.filter((f) => f.scope === 'origin' && f.status === 'ok');
  if (!o.length) return { allGood: null };
  return { allGood: o.every((f) => (f.metrics.lcp ?? 0) <= 2500 && (f.metrics.inp ?? 0) <= 200 && (f.metrics.cls ?? 0) <= 0.1) };
}

/** Draft plan from findings (SPEC.md 4 output; the planner in SPEC 7.1 refines it). */
export function draftPlan(findings: Finding[]): DraftPlanItem[] {
  return findings
    .filter((f) => f.tier !== 'report')
    .map((f, i) => ({
      id: `P${String(i + 1).padStart(2, '0')}`,
      findingIds: [f.id],
      checkId: f.checkId,
      title: f.title,
      where: f.urls.slice(0, 10),
      tier: f.tier,
      expectedGain: f.estimatedGain,
      guards: f.guards,
      rollback: f.checkId.startsWith('SH') ? 'revert the commit on the work theme' : 'turn the flag off (wp speedpilot disable <module>)',
    }));
}

/** Runs the rules on the latest (or given) audit and stores the findings. */
export function runAnalysis(root: string, site: string, opts: { runId?: string; xray?: XraySummaryLite; store?: Store } = {}): Analysis {
  const cfg = loadSite(root, site);
  const store = opts.store ?? new Store(root);
  try {
    const audit = loadAudit(root, site, opts.runId, store);
    const backendPath = join(audit.dir, 'backend.json');
    const backend = existsSync(backendPath) ? JSON.parse(readFileSync(backendPath, 'utf8')) : audit.backend;
    let xray = opts.xray;
    const xrayPath = join(audit.dir, 'xray', 'summary.json');
    if (!xray && existsSync(xrayPath)) xray = JSON.parse(readFileSync(xrayPath, 'utf8')) as XraySummaryLite;
    const prevAudit = store.listRuns(site).filter((r) => r.type === 'audit' && r.status === 'ok' && r.id !== audit.runId)[0];
    const previousVersions = prevAudit ? (JSON.parse(prevAudit.tool_versions_json) as Record<string, string>) : undefined;
    const rules = loadRules(paths.rules(root));
    const ctx = {
      cfg,
      audit,
      wp: cfg.platform === 'wordpress' ? (backend as WpBackend | undefined) : undefined,
      shopify: cfg.platform === 'shopify' ? (backend as ShopifyBackendLite | undefined) : undefined,
      xray,
      previousVersions,
    };
    const result = analyze(rules, ctx, (id) => {
      const s = store.outcomeStats(id, cfg.platform);
      return s.n ? { meanGainMs: s.meanGainMs, failureRate: s.failureRate, n: s.n } : undefined;
    });
    for (const f of result.findings) store.addFinding({ id: `${audit.runId}:${f.id}`, runId: audit.runId, checkId: f.checkId, urls: f.urls, evidence: f.evidence, metric: f.metric, estimatedGain: f.estimatedGain as Record<string, number>, tier: f.tier, fix: f.fix, rootCause: f.rootCause, priority: f.priority });
    const templates = templateMetrics(audit);
    const field = fieldStatus(audit);
    const analysis: Analysis = {
      ...result,
      runId: audit.runId,
      site,
      platform: cfg.platform,
      grade: gradeSite(templates, field, 'N/A'),
      templates,
      field,
      draftPlan: draftPlan(result.findings),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(audit.dir, 'analysis.json'), JSON.stringify(analysis, null, 1));
    return analysis;
  } finally {
    if (!opts.store) store.close();
  }
}
