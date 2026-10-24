/**
 * SpeedPilot MCP tools (SPEC.md 10.2). Read-only: audit, get_findings, get_metrics, compare_runs, get_report,
 * list_backups. Write: backup, prepare_staging, apply_change, rollback, deploy; each needs `plan_id` and the approval
 * token `speedpilot approve` printed, defaults to a dry run, and returns evidence paths. Local fixtures are exempt from
 * approvals, as everywhere else.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadSite, Store, auditSite, runAnalysis, hostFor, backupWordPress, prepareWordPressStaging, requireApprovalToken, type Stage } from '@speedpilot/core';
import { beforeReport } from '@speedpilot/report';
import { ensureFixturePreview, backupShopify } from '@speedpilot/shopify';
import { loadPlan, applyPlan, rollback as rollbackKit, deployPlan, closeLivePreview } from '@speedpilot/engine';
import type { ToolDef } from './xrayTools.js';

const site = z.string().describe('site name (sites/<site>/site.yaml)');
const writeArgs = { plan_id: z.string().describe('plan ID (or the operation name, for example staging-prep)'), approval_token: z.string().describe('the token `speedpilot approve` printed for this plan and stage'), dry_run: z.boolean().default(true).describe('true (default) only shows what would happen') };

function gate(root: string, a: Record<string, unknown>, stage: Stage, item?: string): void {
  const cfg = loadSite(root, String(a.site));
  if (cfg.local) return;
  requireApprovalToken(root, { site: String(a.site), operation: String(a.plan_id), stage, item, token: String(a.approval_token ?? '') });
}

export function siteTools(root: string): ToolDef[] {
  return [
    {
      name: 'audit',
      description: 'Read-only audit of a site (Lighthouse, traces, coverage, backend) and its analysis. Returns the top findings, grade and evidence folder.',
      input: { site, stage: z.enum(['production', 'staging']).optional(), urls: z.array(z.string()).optional(), runs: z.number().int().min(1).max(5).optional() },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        const preview = await ensureFixturePreview(root, cfg);
        try {
          const audit = await auditSite(root, String(a.site), { stage: a.stage as Stage | undefined, urls: a.urls as string[] | undefined, lighthouseRuns: a.runs as number | undefined });
          const an = runAnalysis(root, String(a.site), { runId: audit.runId });
          return { runId: audit.runId, grade: an.grade.grade, findings: an.findings.length, top10: an.findings.slice(0, 10).map((f) => ({ id: f.checkId, tier: f.tier, priority: f.priority, gain: f.estimatedGain, urls: f.urls.length, rootCause: f.rootCause })), evidence: [audit.dir, join(audit.dir, 'analysis.json')] };
        } finally {
          await preview?.close();
        }
      },
    },
    {
      name: 'get_findings',
      description: 'Findings of the latest (or a given) audit, ordered by priority, with evidence and estimated gain.',
      input: { site, run: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
      async run(a) {
        const an = runAnalysis(root, String(a.site), { runId: a.run as string | undefined });
        return { runId: an.runId, grade: an.grade.grade, findings: an.findings.slice(0, (a.limit as number | undefined) ?? 10).map((f) => ({ id: f.checkId, tier: f.tier, priority: f.priority, metric: f.metric, gain: f.estimatedGain, fix: f.fix, urls: f.urls.slice(0, 5), rootCause: f.rootCause })), evidence: [join(root, 'runs', String(a.site), an.runId, 'analysis.json')] };
      },
    },
    {
      name: 'get_metrics',
      description: 'Lab metrics (median and range of repeated runs) per URL and device for a run; field data separately.',
      input: { site, run: z.string().optional() },
      async run(a) {
        const store = new Store(root);
        try {
          const run = a.run ? store.getRun(String(a.run)) : store.latestRun(String(a.site), 'audit');
          if (!run) return { error: 'no audit run yet' };
          return { runId: run.id, metrics: store.metrics(run.id).slice(0, 200), evidence: [run.dir] };
        } finally {
          store.close();
        }
      },
    },
    {
      name: 'compare_runs',
      description: 'Compare two audit runs: median metric deltas per URL and device.',
      input: { site, run_a: z.string(), run_b: z.string() },
      async run(a) {
        const store = new Store(root);
        try {
          const ma = store.metrics(String(a.run_a));
          const mb = store.metrics(String(a.run_b));
          const rows = mb.map((m) => {
            const b = ma.find((x) => x.url === m.url && x.device === m.device && x.name === m.name && x.source === m.source);
            return { url: m.url, device: m.device, metric: m.name, before: b?.median ?? null, after: m.median, delta: b?.median != null && m.median != null ? m.median - b.median : null };
          });
          return { rows: rows.filter((r) => r.delta !== null).slice(0, 200), evidence: [store.getRun(String(a.run_a))?.dir, store.getRun(String(a.run_b))?.dir].filter(Boolean) };
        } finally {
          store.close();
        }
      },
    },
    {
      name: 'get_report',
      description: 'Writes the before report (HTML, PDF, JSON, Markdown) for the latest audit and returns the paths and the Markdown summary.',
      input: { site, anonymized: z.boolean().optional() },
      async run(a) {
        const r = await beforeReport(root, String(a.site), { pdf: false, anonymized: Boolean(a.anonymized) });
        const w = r.written[0]!;
        return { summary: w.model.after ? 'after report' : `grade ${r.analysis.grade.grade ?? 'n/a'}, ${r.analysis.findings.length} findings`, evidence: r.written.flatMap((x) => [x.html, x.json, x.markdown]) };
      },
    },
    {
      name: 'list_backups',
      description: 'Backups of a site with stage, restore-test status and location.',
      input: { site },
      async run(a) {
        const store = new Store(root);
        try {
          const b = store.backups(String(a.site));
          return { backups: b.slice(0, 20).map((x) => ({ id: x.id, stage: x.stage, verified: x.restoreTested, createdAt: x.createdAt })), evidence: b.slice(0, 20).map((x) => x.location) };
        } finally {
          store.close();
        }
      },
    },
    // ---------------------------------------------------------------- write tools
    {
      name: 'backup',
      description: 'Take a backup (checks free disk space first). Needs plan_id and approval token; dry run by default.',
      input: { site, stage: z.enum(['production', 'staging']).default('production'), ...writeArgs },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        const stage: Stage = cfg.local ? 'local' : (a.stage as Stage);
        gate(root, a, stage);
        if (a.dry_run !== false) return { dryRun: true, wouldDo: `${cfg.platform === 'wordpress' ? 'WordPress database and files backup' : 'Shopify theme pull, backup and work themes'} for ${cfg.name} on ${stage}`, evidence: [join(root, 'backups', cfg.name)] };
        const store = new Store(root);
        try {
          if (cfg.platform === 'wordpress') {
            const r = await backupWordPress(cfg, stage, { host: hostFor(root, cfg, stage), store, backupsDir: join(root, 'backups') });
            return { backupId: r.id, evidence: [r.dir] };
          }
          const r = await backupShopify(root, cfg, store, { backupsDir: join(root, 'backups') });
          return { backupId: r.id, evidence: [r.dir] };
        } finally {
          store.close();
        }
      },
    },
    {
      name: 'prepare_staging',
      description: 'Prepare WordPress staging (clone and neutralize) or the Shopify work theme. Needs plan_id (staging-prep) and approval token; dry run by default.',
      input: { site, ...writeArgs },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        gate(root, a, cfg.local ? 'local' : 'staging');
        if (a.dry_run !== false) return { dryRun: true, wouldDo: 'clone production to staging, search-replace (dry run first), neutralize email, payments, webhooks, cron and indexing', evidence: [] };
        const store = new Store(root);
        try {
          const r = await prepareWordPressStaging(root, cfg, store, {});
          return { staging: r, evidence: [] };
        } finally {
          store.close();
        }
      },
    },
    {
      name: 'apply_change',
      description: 'Apply approved plan items on staging or the work theme, one at a time, with verification and auto-rollback. Needs plan_id and approval token; dry run by default.',
      input: { site, items: z.array(z.string()).optional(), ...writeArgs },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        const plan = loadPlan(root, String(a.plan_id));
        const items = (a.items as string[] | undefined) ?? plan.items.map((i) => i.id);
        const stage: Stage = cfg.local ? 'local' : 'staging';
        for (const it of items) gate(root, a, stage, it);
        if (a.dry_run !== false) return { dryRun: true, wouldApply: plan.items.filter((i) => items.includes(i.id)).map((i) => ({ id: i.id, tier: i.tier, what: i.what, rollback: i.rollback })), evidence: [join(root, 'runs', String(a.site), 'plans', `${plan.id}.json`)] };
        const r = await applyPlan(root, plan.id, { stage, items });
        return { steps: r.steps.map((s) => ({ id: s.proposal, status: s.status, reason: s.reason.slice(0, 300) })), evidence: [join(root, 'runs', String(a.site), 'plans', `${plan.id}-apply-${stage}`)] };
      },
    },
    {
      name: 'rollback',
      description: 'Rollback kit: one item, every change, or the emergency kill switch. Needs plan_id and approval token; dry run by default.',
      input: { site, item: z.string().optional(), all: z.boolean().optional(), emergency: z.boolean().optional(), ...writeArgs },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        gate(root, a, cfg.local ? 'local' : 'production', a.item as string | undefined);
        if (a.dry_run !== false) return { dryRun: true, wouldDo: a.emergency ? 'set SPEEDPILOT_DISABLE / publish the previous theme' : a.all ? 'turn off every flag of the plan and run the undo steps' : `turn off item ${a.item}`, evidence: [] };
        try {
          const r = await rollbackKit(root, String(a.site), { plan: String(a.plan_id), item: a.item as string | undefined, all: Boolean(a.all), emergency: Boolean(a.emergency) });
          return { actions: r.actions, verification: r.verification?.result, evidence: [r.verification?.evidenceDir].filter(Boolean) };
        } finally {
          await closeLivePreview();
        }
      },
    },
    {
      name: 'deploy',
      description: 'Production deploy inside the window (fresh backup, drift check, kept items as one batch, full verification). Needs plan_id and approval token; dry run by default.',
      input: { site, ...writeArgs },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        const plan = loadPlan(root, String(a.plan_id));
        gate(root, a, cfg.local ? 'local' : 'production');
        if (a.dry_run !== false) return { dryRun: true, wouldDeploy: plan.items.map((i) => i.id), evidence: [join(root, 'runs', String(a.site), 'plans', `${plan.id}.json`)] };
        try {
          const r = await deployPlan(root, plan.id, { simulate: !!cfg.local });
          return { verification: r.verification.result, turnedOff: r.turnedOff, backupId: r.backupId, evidence: [r.verification.evidenceDir] };
        } finally {
          await closeLivePreview();
        }
      },
    },
  ];
}

export function reportsOf(root: string, siteName: string): string[] {
  const dir = join(root, 'runs', siteName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'reports'))).map((d) => join(dir, d, 'reports'));
}
