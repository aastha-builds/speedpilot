import { join } from 'node:path';
import { hostname, cpus, totalmem, platform, release } from 'node:os';
import { openDb, type DB } from './db.js';
import { ensureDir, newRunId, paths, RUN_SUBDIRS } from '../util/paths.js';
import type { SiteConfig } from '../config/site.js';

export type Stage = 'local' | 'staging' | 'production';
export type RunType = 'audit' | 'backup' | 'apply' | 'verify' | 'deploy' | 'monitor' | 'xray' | 'baseline' | 'restore' | 'staging' | 'rollback' | 'simulate';
export type Tier = 'T1' | 'T2' | 'T3' | 'report';
export type ChangeStatus = 'proposed' | 'approved' | 'applied' | 'kept' | 'rolled_back';

export interface RunRecord {
  id: string;
  site_id: string;
  type: RunType;
  stage: Stage;
  started_at: string;
  ended_at: string | null;
  status: 'running' | 'ok' | 'failed' | 'aborted';
  dir: string;
  tool_versions_json: string;
}

export interface FindingRecord {
  id: string;
  runId: string;
  checkId: string;
  urls: string[];
  evidence: Record<string, unknown>;
  metric: string;
  estimatedGain: Record<string, number>;
  tier: Tier;
  fix: string;
  rootCause?: string;
  priority: number;
}

export interface MetricRecord {
  runId: string;
  url: string;
  device: 'mobile' | 'desktop';
  source: 'lab' | 'psi' | 'field' | 'simulated';
  name: string;
  median: number | null;
  min: number | null;
  max: number | null;
  samples: number[];
}

export function machineInfo() {
  return { hostname: hostname(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', memoryGb: Math.round(totalmem() / 1e9), os: `${platform()} ${release()}`, node: process.version };
}

/** Thin typed repository over the SQLite store. */
export class Store {
  readonly db: DB;
  constructor(readonly root: string, file = paths.db(root)) {
    this.db = openDb(file);
  }

  close() {
    this.db.close();
  }

  upsertSite(cfg: SiteConfig) {
    this.db
      .prepare(
        `INSERT INTO sites (id, platform, production_url, staging_url, config_json) VALUES (@id, @platform, @prod, @staging, @cfg)
         ON CONFLICT(id) DO UPDATE SET platform=excluded.platform, production_url=excluded.production_url, staging_url=excluded.staging_url, config_json=excluded.config_json`,
      )
      .run({ id: cfg.name, platform: cfg.platform, prod: cfg.productionUrl, staging: cfg.stagingUrl ?? null, cfg: JSON.stringify(cfg) });
  }

  startRun(site: string, type: RunType, stage: Stage, toolVersions: Record<string, string> = {}): RunRecord {
    const id = newRunId(type);
    const dir = paths.runDir(this.root, site, id);
    for (const sub of RUN_SUBDIRS) ensureDir(join(dir, sub));
    const started = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, site_id, type, stage, tool_versions_json, machine_json, started_at, status, dir) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, site, type, stage, JSON.stringify(toolVersions), JSON.stringify(machineInfo()), started, dir);
    return this.getRun(id)!;
  }

  setToolVersions(runId: string, versions: Record<string, string>) {
    this.db.prepare('UPDATE runs SET tool_versions_json = ? WHERE id = ?').run(JSON.stringify(versions), runId);
  }

  endRun(runId: string, status: 'ok' | 'failed' | 'aborted') {
    this.db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(status, new Date().toISOString(), runId);
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  }

  latestRun(site: string, type?: RunType, stage?: Stage, status: string = 'ok'): RunRecord | undefined {
    const where = ['site_id = @site', 'status = @status'];
    if (type) where.push('type = @type');
    if (stage) where.push('stage = @stage');
    return this.db
      .prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .get({ site, type, stage, status }) as RunRecord | undefined;
  }

  listRuns(site: string): RunRecord[] {
    return this.db.prepare('SELECT * FROM runs WHERE site_id = ? ORDER BY started_at DESC').all(site) as RunRecord[];
  }

  addPage(p: { runId: string; url: string; template: string; device: 'mobile' | 'desktop'; runIndex: number; lighthousePath?: string; tracePath?: string; screenshots?: string[] }) {
    this.db
      .prepare('INSERT INTO pages (run_id, url, template, device, run_index, lighthouse_path, trace_path, screenshots_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.runId, p.url, p.template, p.device, p.runIndex, p.lighthousePath ?? null, p.tracePath ?? null, JSON.stringify(p.screenshots ?? []));
  }

  addMetric(m: MetricRecord) {
    this.db
      .prepare('INSERT INTO metrics (run_id, url, device, source, name, median, min, max, samples_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.runId, m.url, m.device, m.source, m.name, m.median, m.min, m.max, JSON.stringify(m.samples));
  }

  metrics(runId: string): MetricRecord[] {
    return (this.db.prepare('SELECT * FROM metrics WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>).map((r) => ({
      runId: r.run_id as string,
      url: r.url as string,
      device: r.device as 'mobile' | 'desktop',
      source: r.source as MetricRecord['source'],
      name: r.name as string,
      median: r.median as number | null,
      min: r.min as number | null,
      max: r.max as number | null,
      samples: JSON.parse(r.samples_json as string),
    }));
  }

  addFinding(f: FindingRecord) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO findings (id, run_id, check_id, urls_json, evidence_json, metric, estimated_gain_json, tier, fix, root_cause, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.id, f.runId, f.checkId, JSON.stringify(f.urls), JSON.stringify(f.evidence), f.metric, JSON.stringify(f.estimatedGain), f.tier, f.fix, f.rootCause ?? null, f.priority);
  }

  findings(runId: string): FindingRecord[] {
    return (this.db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY priority DESC').all(runId) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      checkId: r.check_id as string,
      urls: JSON.parse(r.urls_json as string),
      evidence: JSON.parse(r.evidence_json as string),
      metric: r.metric as string,
      estimatedGain: JSON.parse(r.estimated_gain_json as string),
      tier: r.tier as Tier,
      fix: r.fix as string,
      rootCause: (r.root_cause as string) ?? undefined,
      priority: r.priority as number,
    }));
  }

  savePlan(id: string, site: string, runId: string | null, plan: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO plans (id, site_id, run_id, created_at, plan_json) VALUES (?, ?, ?, ?, ?)').run(id, site, runId, new Date().toISOString(), JSON.stringify(plan));
  }

  getPlan<T = unknown>(id: string): { id: string; site_id: string; plan: T } | undefined {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { id: string; site_id: string; plan_json: string } | undefined;
    return r ? { id: r.id, site_id: r.site_id, plan: JSON.parse(r.plan_json) as T } : undefined;
  }

  latestPlan<T = unknown>(site: string): { id: string; site_id: string; plan: T } | undefined {
    const r = this.db.prepare('SELECT * FROM plans WHERE site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(site) as { id: string; site_id: string; plan_json: string } | undefined;
    return r ? { id: r.id, site_id: r.site_id, plan: JSON.parse(r.plan_json) as T } : undefined;
  }

  upsertChange(c: { id: string; planId: string; findingIds: string[]; tier: Tier; description: string; implementation?: string; status: ChangeStatus; before?: unknown; after?: unknown; verificationId?: string; rollbackSteps: string; reason?: string }) {
    this.db
      .prepare(
        `INSERT INTO changes (id, plan_id, finding_ids_json, tier, description, implementation, status, before_json, after_json, verification_id, rollback_steps, reason, updated_at)
         VALUES (@id, @planId, @f, @tier, @description, @implementation, @status, @before, @after, @verificationId, @rollbackSteps, @reason, @now)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, implementation=COALESCE(excluded.implementation, changes.implementation),
           before_json=COALESCE(excluded.before_json, changes.before_json), after_json=COALESCE(excluded.after_json, changes.after_json),
           verification_id=COALESCE(excluded.verification_id, changes.verification_id), reason=COALESCE(excluded.reason, changes.reason), updated_at=excluded.updated_at`,
      )
      .run({
        id: c.id,
        planId: c.planId,
        f: JSON.stringify(c.findingIds),
        tier: c.tier,
        description: c.description,
        implementation: c.implementation ?? null,
        status: c.status,
        before: c.before === undefined ? null : JSON.stringify(c.before),
        after: c.after === undefined ? null : JSON.stringify(c.after),
        verificationId: c.verificationId ?? null,
        rollbackSteps: c.rollbackSteps,
        reason: c.reason ?? null,
        now: new Date().toISOString(),
      });
  }

  changes(planId: string) {
    return (this.db.prepare('SELECT * FROM changes WHERE plan_id = ? ORDER BY rowid').all(planId) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      planId: r.plan_id as string,
      findingIds: JSON.parse(r.finding_ids_json as string) as string[],
      tier: r.tier as Tier,
      description: r.description as string,
      implementation: (r.implementation as string) ?? undefined,
      status: r.status as ChangeStatus,
      before: r.before_json ? JSON.parse(r.before_json as string) : undefined,
      after: r.after_json ? JSON.parse(r.after_json as string) : undefined,
      verificationId: (r.verification_id as string) ?? undefined,
      rollbackSteps: r.rollback_steps as string,
      reason: (r.reason as string) ?? undefined,
      updatedAt: r.updated_at as string,
    }));
  }

  addBackup(b: { id: string; site: string; stage: Stage; type: string; location: string; checksums: Record<string, string> }) {
    this.db
      .prepare('INSERT INTO backups (id, site_id, stage, type, location, checksums_json, restore_tested, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(b.id, b.site, b.stage, b.type, b.location, JSON.stringify(b.checksums), new Date().toISOString());
  }

  markBackupVerified(id: string, runId: string) {
    this.db.prepare('UPDATE backups SET restore_tested = 1, restore_run_id = ? WHERE id = ?').run(runId, id);
  }

  backups(site: string) {
    return (this.db.prepare('SELECT * FROM backups WHERE site_id = ? ORDER BY created_at DESC, rowid DESC').all(site) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      site: r.site_id as string,
      stage: r.stage as Stage,
      type: r.type as string,
      location: r.location as string,
      checksums: JSON.parse(r.checksums_json as string) as Record<string, string>,
      restoreTested: r.restore_tested === 1,
      restoreRunId: (r.restore_run_id as string) ?? undefined,
      createdAt: r.created_at as string,
    }));
  }

  addApproval(a: { planId: string; site: string; stage: Stage; items: string[]; approver: string; approvedAt: string; text: string }) {
    this.db
      .prepare('INSERT INTO approvals (plan_id, site_id, stage, items_json, approver, approved_at, approval_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.planId, a.site, a.stage, JSON.stringify(a.items), a.approver, a.approvedAt, a.text);
  }

  addVerification(v: { id: string; runId?: string; site: string; stage: Stage; kind: 'baseline' | 'quick' | 'full'; result: 'PASS' | 'FAIL'; checks: unknown; evidenceDir: string }) {
    this.db
      .prepare('INSERT INTO verifications (id, run_id, site_id, stage, kind, result, checks_json, evidence_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, v.runId ?? null, v.site, v.stage, v.kind, v.result, JSON.stringify(v.checks), v.evidenceDir, new Date().toISOString());
  }

  latestVerification(site: string, stage: Stage, kind?: 'baseline' | 'quick' | 'full') {
    const r = this.db
      .prepare(`SELECT * FROM verifications WHERE site_id = ? AND stage = ? ${kind ? 'AND kind = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(...([site, stage, kind].filter(Boolean) as string[])) as Record<string, unknown> | undefined;
    return r ? { id: r.id as string, result: r.result as 'PASS' | 'FAIL', checks: JSON.parse(r.checks_json as string), evidenceDir: r.evidence_dir as string, kind: r.kind as string } : undefined;
  }

  addOutcome(o: { changeId: string; checkOrRecipeId: string; platform: string; target?: string; targetVersion?: string; simulatedGain?: unknown; before?: unknown; after?: unknown; kept: boolean; reason?: string }) {
    this.db
      .prepare(
        'INSERT INTO outcomes (change_id, check_or_recipe_id, platform, target, target_version, simulated_gain_json, before_json, after_json, kept, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(o.changeId, o.checkOrRecipeId, o.platform, o.target ?? null, o.targetVersion ?? null, JSON.stringify(o.simulatedGain ?? null), JSON.stringify(o.before ?? null), JSON.stringify(o.after ?? null), o.kept ? 1 : 0, o.reason ?? null);
  }

  /** Learning loop stats per check or recipe (SPEC.md 15.6). */
  outcomeStats(checkOrRecipeId: string, platform: string): { n: number; kept: number; failureRate: number; meanGainMs: number | null } {
    const rows = this.db.prepare('SELECT * FROM outcomes WHERE check_or_recipe_id = ? AND platform = ?').all(checkOrRecipeId, platform) as Array<Record<string, unknown>>;
    const n = rows.length;
    const kept = rows.filter((r) => r.kept === 1).length;
    const gains: number[] = [];
    for (const r of rows) {
      if (r.kept !== 1) continue;
      const b = JSON.parse((r.before_json as string) ?? 'null');
      const a = JSON.parse((r.after_json as string) ?? 'null');
      if (b && a && typeof b.lcp === 'number' && typeof a.lcp === 'number') gains.push(b.lcp - a.lcp);
    }
    return { n, kept, failureRate: n ? (n - kept) / n : 0, meanGainMs: gains.length ? gains.reduce((x, y) => x + y, 0) / gains.length : null };
  }
}
