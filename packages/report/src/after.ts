/**
 * After report (SPEC.md 9.2): the before report's structure plus before and after tables with deltas, side-by-side
 * screenshots and filmstrips, the change log (what, where, why, flag or commit, rollback), verification results,
 * remaining blockers with the client's options, the field-data note with re-check dates, backup IDs and the rollback
 * kit. The grade counts only when the safety result is PASS (SPEC.md 9.4).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, loadAudit, runAnalysis, Store, gradeSite, type AuditResult } from '@speedpilot/core';
import { buildModel, type AfterSection } from './model.js';
import { writeReport, type WrittenReport } from './index.js';

function dataUri(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

/** Five frames of the median Lighthouse run's filmstrip (screenshot-thumbnails audit). */
function filmstrip(page: AuditResult['pages'][number] | undefined): string[] {
  const json = page?.lighthouse?.medianJson;
  if (!json || !existsSync(json)) return [];
  const lhr = JSON.parse(readFileSync(json, 'utf8')) as { audits?: Record<string, { details?: { items?: Array<{ data: string }> } }> };
  const items = lhr.audits?.['screenshot-thumbnails']?.details?.items ?? [];
  if (!items.length) return [];
  const step = Math.max(1, Math.floor(items.length / 5));
  return items.filter((_, i) => i % step === 0).slice(0, 5).map((x) => x.data);
}

export interface AfterReportOptions {
  beforeRunId: string;
  afterRunId?: string;
  planId?: string;
  pdf?: boolean;
  anonymized?: boolean;
}

export async function afterReport(root: string, site: string, o: AfterReportOptions): Promise<{ written: WrittenReport[]; after: AfterSection }> {
  const cfg = loadSite(root, site);
  const before = loadAudit(root, site, o.beforeRunId);
  const audit = loadAudit(root, site, o.afterRunId);
  const analysis = runAnalysis(root, site, { runId: audit.runId });
  const store = new Store(root);
  let after: AfterSection;
  try {
    const deltas: AfterSection['deltas'] = [];
    for (const p of audit.pages) {
      const b = before.pages.find((x) => x.url === p.url && x.device === p.device);
      if (!b?.lighthouse || !p.lighthouse) continue;
      for (const [metric, key] of [['Score', 'score'], ['LCP', 'lcp'], ['TBT', 'tbt'], ['CLS', 'cls'], ['FCP', 'fcp']] as const) {
        const bv = b.lighthouse.median[key];
        const av = p.lighthouse.median[key];
        deltas.push({ url: p.url, device: p.device, metric, before: bv, after: av, delta: bv !== null && av !== null ? av - bv : null });
      }
    }
    const fold = (pg: AuditResult['pages'][number] | undefined) => pg?.evidence.screenshots.find((s) => s.endsWith('.390.fold.png'));
    const screenshots = audit.pages.filter((p) => p.device === 'mobile').map((p) => ({ url: p.url, before: dataUri(fold(before.pages.find((x) => x.url === p.url && x.device === 'mobile'))), after: dataUri(fold(p)) }));
    const filmstrips = audit.pages.filter((p) => p.device === 'mobile').slice(0, 3).map((p) => ({ url: p.url, before: filmstrip(before.pages.find((x) => x.url === p.url && x.device === 'mobile')), after: filmstrip(p) })).filter((f) => f.before.length && f.after.length);
    const plan = o.planId ? store.getPlan<{ items: Array<{ id: string; what: string; where: string[]; findingIds: string[]; kind: string; proposal?: { module?: string }; rollback: string }> }>(o.planId) : undefined;
    const changes = o.planId ? store.changes(o.planId) : [];
    const changeLog: AfterSection['changeLog'] = changes.map((c) => {
      const it = plan?.plan.items.find((i) => `${plan.id}:${i.id}` === c.id);
      const impl = it?.proposal?.module ? `flag ${it.proposal.module}` : typeof c.after === 'string' ? `commit ${c.after}` : (c.implementation ?? '');
      return { id: c.id.split(':').pop()!, what: c.description, where: (it?.where ?? []).map((u) => { try { return new URL(u).pathname; } catch { return u; } }).join(', ') || 'site-wide', why: c.findingIds.join(', '), implementation: impl, status: c.status, rollback: c.rollbackSteps, reason: c.status === 'rolled_back' ? c.reason : undefined };
    });
    const v = store.latestVerification(site, cfg.local ? 'local' : 'production', 'full') ?? store.latestVerification(site, cfg.local ? 'local' : 'staging');
    const safety: AfterSection['safety'] = v ? v.result : 'N/A';
    const checks = (v?.checks as Array<{ name: string; pass: boolean; details: string[] }> | undefined) ?? [];
    const blockers: AfterSection['blockers'] = analysis.ceiling.blockers.map((b) => ({ name: b.name, cost: b.cost, options: b.options }));
    const deployedAt = new Date();
    const day = (n: number) => new Date(deployedAt.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const backups = store.backups(site).slice(0, 5).map((b) => ({ id: b.id, stage: b.stage, verified: b.restoreTested, createdAt: b.createdAt }));
    const rollbackKit = cfg.platform === 'wordpress'
      ? ['One change: wp speedpilot disable <module> (or speedpilot rollback <site> --plan <id> --item <id>).', "Everything: define('SPEEDPILOT_DISABLE', true); in wp-config.php, or rename wp-content/mu-plugins/speedpilot-agent.php over SFTP if wp-admin is down.", 'Database steps: run each item\'s undo step (for example wp speedpilot autoload on <options>). A full database restore is the last resort and needs your consent: it loses orders, users and form entries made since the backup.']
      : ['One change: git revert <commit> on the work theme and push it to the work theme again.', 'Everything: publish the previous live theme by ID (speedpilot rollback <site> --all).', 'App embeds switched off in this plan can be switched back on in the theme editor.'];
    after = { deltas, screenshots, filmstrips, changeLog, verification: { result: safety, checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.details.slice(0, 2).join('; ') })), evidenceDir: v?.evidenceDir }, blockers, recheck: { day7: day(7), day28: day(28) }, backups, rollbackKit, safety };
  } finally {
    store.close();
  }
  const model = buildModel('after', cfg, audit, analysis);
  model.grade = gradeSite(analysis.templates, analysis.field, after.safety === 'N/A' ? 'N/A' : after.safety);
  model.after = after;
  const out = join(audit.dir, 'reports');
  const written = [await writeReport(model, out, { pdf: o.pdf })];
  if (o.anonymized) written.push(await writeReport(model, out, { pdf: o.pdf, anonymized: true }));
  return { written, after };
}
