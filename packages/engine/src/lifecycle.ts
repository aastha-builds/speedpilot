/**
 * Apply, deploy, rollback and monitor (SPEC.md 7.2 to 7.5). The executor checks approvals itself for every item and
 * stage, so calling these functions directly (without the hook) cannot write an unapproved item (CLAUDE.md rule 10).
 */
import { join } from 'node:path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { loadSite, Store, requireApproval, ApprovalError, verify, writeState, readState, paths, hostFor, backupWordPress, wpState, wpDrift, stateFromManifest, readManifest, launchBrowser, releaseBrowser, openSession, log, WpCli, type Stage, type SiteConfig, type VerificationResult } from '@speedpilot/core';
import { startPreview, type PreviewServer } from '@speedpilot/shopify';
import { loadPlan, type Plan } from './plan.js';
import { applyWpProposals, executorWp, readFlags, type ApplyStep, type FlagsDoc } from './wordpress/apply.js';
import { buildShopifyProposals, applyShopify, workingCopy, probeShopify, type ShopifyStep } from './shopify/engine.js';
import { loadXray } from '@speedpilot/xray';
import type { ProbeResult } from './probe.js';

export class ExecutorRefusal extends Error {
  override name = 'ExecutorRefusal';
}

/** Today's backup gate (CLAUDE.md rule 1): verified and same-day for production; a same-day snapshot for staging. */
export function requireTodaysBackup(store: Store, cfg: SiteConfig, stage: Stage, now = new Date()): string | undefined {
  if (cfg.local || stage === 'local') return undefined;
  const today = now.toISOString().slice(0, 10);
  const b = store.backups(cfg.name).find((x) => x.stage === stage && x.createdAt.slice(0, 10) === today && (stage !== 'production' || x.restoreTested));
  if (!b) throw new ExecutorRefusal(stage === 'production' ? `No verified production backup from today for ${cfg.name}: run speedpilot backup ${cfg.name} and speedpilot backup verify first (CLAUDE.md rule 1).` : `No staging snapshot from today for ${cfg.name} (CLAUDE.md rule 1).`);
  return b.id;
}

/** Every item must be named in a fresh approval for this plan and stage; checked before anything is written. */
export function requireItemsApproved(root: string, plan: Plan, stage: Stage, items: string[]): void {
  const cfg = loadSite(root, plan.site);
  if (cfg.local && stage === 'local') return;
  for (const id of items) requireApproval(root, { site: plan.site, operation: plan.id, stage, item: id });
}

export interface ApplyPlanResult {
  planId: string;
  stage: Stage;
  steps: Array<ApplyStep | ShopifyStep>;
  flagsFile?: string;
}

export async function applyPlan(root: string, id: string, o: { stage?: Stage; items?: string[]; outDir?: string; simulationRuns?: number; fullVerify?: boolean; probes?: ProbeResult[]; net?: { latencyMs: number; downloadKbps: number } } = {}): Promise<ApplyPlanResult> {
  const plan = loadPlan(root, id);
  const cfg = loadSite(root, plan.site);
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'staging');
  if (stage === 'production') throw new ExecutorRefusal('Changes are applied on staging or the work theme first; production gets them through speedpilot deploy (CLAUDE.md rule 2).');
  const items = o.items ?? plan.items.map((i) => i.id);
  // approvals and today's backup are checked before the first write, for every item
  requireItemsApproved(root, plan, stage, items);
  const store = new Store(root);
  try {
    requireTodaysBackup(store, cfg, stage);
  } finally {
    store.close();
  }
  const outDir = o.outDir ?? join(paths.runsDir(root, plan.site), 'plans', `${plan.id}-apply-${stage}`);
  mkdirSync(outDir, { recursive: true });
  const record = (itemId: string, status: 'kept' | 'rolled_back' | 'skipped', reason: string, after?: unknown) => {
    const s = new Store(root);
    try {
      const it = plan.items.find((i) => i.id === itemId)!;
      s.upsertChange({ id: `${plan.id}:${itemId}`, planId: plan.id, findingIds: it.findingIds, tier: it.tier, description: it.what, status: status === 'skipped' ? 'proposed' : status, rollbackSteps: it.rollback, reason, after });
      s.addOutcome({ changeId: `${plan.id}:${itemId}`, checkOrRecipeId: it.findingIds[0] ?? itemId, platform: cfg.platform, target: it.id, kept: status === 'kept', reason, after });
    } finally {
      s.close();
    }
  };
  if (plan.platform === 'wordpress') {
    const proposals = plan.items.filter((i) => items.includes(i.id) && i.proposal).map((i) => structuredClone(i.proposal!));
    const probes = o.probes ?? [];
    const steps = await applyWpProposals(root, plan.site, proposals, { stage, outDir, simulationRuns: o.simulationRuns, fullVerify: o.fullVerify, probes, net: o.net, approval: cfg.local && stage === 'local' ? undefined : { operation: plan.id }, onStep: (s) => record(s.proposal, s.status, s.reason, s.verification) });
    // the flag set that passed on staging is what deploy moves to production (never the database)
    const wp = new WpCli(root, cfg, stage);
    const flags = await readFlags(wp);
    const flagsFile = join(paths.runsDir(root, plan.site), 'plans', `${plan.id}.flags.json`);
    writeFileSync(flagsFile, JSON.stringify(flags, null, 2));
    writeFileSync(join(outDir, 'steps.json'), JSON.stringify(steps, null, 2));
    return { planId: plan.id, stage, steps, flagsFile };
  }
  const x = loadXray(root, plan.site).ctx;
  const themeDir = join(root, 'fixtures/shopify/theme');
  const workDir = workingCopy(root, plan.site, themeDir);
  const probes = o.probes ?? (await probeShopify([...new Set(x.captures.map((c) => c.url))]));
  const proposals = buildShopifyProposals(x, probes, { themeDir: workDir }).filter((p) => items.includes(p.id));
  const steps = await applyShopify(root, plan.site, { proposals, workDir, stage, simulationRuns: o.simulationRuns, approval: { operation: plan.id }, onStep: (s) => record(s.proposal, s.status, s.reason, s.commit) });
  writeFileSync(join(outDir, 'steps.json'), JSON.stringify(steps, null, 2));
  return { planId: plan.id, stage, steps };
}

/** Deploy window (CLAUDE.md rule 13): inside the days and hours of site.yaml, never during a named campaign. */
export function inDeployWindow(cfg: SiteConfig, now = new Date()): { ok: boolean; why: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3);
  const hm = `${get('hour')}:${get('minute')}`;
  const w = cfg.deployWindow;
  const campaign = cfg.campaigns.find((c) => now >= new Date(c.start) && now <= new Date(c.end));
  if (campaign) return { ok: false, why: `campaign "${campaign.name}" is running` };
  if (!w.days.includes(day as never)) return { ok: false, why: `${day} is outside the deploy days ${w.days.join(', ')}` };
  if (hm < w.start || hm > w.end) return { ok: false, why: `${hm} is outside ${w.start}-${w.end} (${cfg.timezone})` };
  return { ok: true, why: `inside ${w.days.join(', ')} ${w.start}-${w.end} ${cfg.timezone}` };
}

export interface DeployResult {
  planId: string;
  backupId?: string;
  drift: string[];
  verification: VerificationResult;
  turnedOff: string[];
  previousTheme?: string;
}

/**
 * Production deploy (SPEC.md 7.3). WordPress: fresh backup, drift check, the staging flag set as one batch plus the
 * scripted database steps; on a failed verification flags go off one at a time in reverse until it passes. Shopify:
 * publish the verified work theme and keep the previous live theme as the instant rollback. On local fixtures the
 * deploy is simulated against the fixture itself and the window can be ignored with `simulate`.
 */
export async function deployPlan(root: string, id: string, o: { now?: Date; simulate?: boolean; livePort?: number } = {}): Promise<DeployResult> {
  const plan = loadPlan(root, id);
  const cfg = loadSite(root, plan.site);
  const stage: Stage = cfg.local ? 'local' : 'production';
  const store = new Store(root);
  const kept = store.changes(plan.id).filter((c) => c.status === 'kept').map((c) => c.id.split(':').pop()!);
  store.close();
  if (!kept.length) throw new ExecutorRefusal(`Plan ${plan.id} has no item that passed on staging.`);
  if (!cfg.local) requireItemsApproved(root, plan, 'production', kept);
  const win = inDeployWindow(cfg, o.now);
  if (!win.ok && !(cfg.local && o.simulate)) throw new ExecutorRefusal(`Not deploying: ${win.why} (CLAUDE.md rule 13).`);
  log.info({ plan: plan.id, items: kept, window: win.why }, 'deploy: notify the client before and after');
  if (plan.platform === 'wordpress') {
    const host = hostFor(root, cfg, stage);
    const s2 = new Store(root);
    let backupId: string | undefined;
    const drift: string[] = [];
    try {
      const previous = s2.backups(cfg.name).find((b) => b.restoreTested);
      const fresh = await backupWordPress(cfg, stage, { host, store: s2, backupsDir: join(root, 'backups') });
      backupId = fresh.id;
      if (previous && existsSync(join(previous.location, 'manifest.json'))) for (const d of wpDrift(stateFromManifest(readManifest(previous.location)), await wpState(host))) drift.push(`${d.kind} ${d.name}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    } finally {
      s2.close();
    }
    const wp = executorWp(root, cfg, stage, cfg.local ? undefined : { operation: plan.id, item: kept[0] });
    const flagsFile = join(paths.runsDir(root, plan.site), 'plans', `${plan.id}.flags.json`);
    const doc = JSON.parse(readFileSync(flagsFile, 'utf8')) as FlagsDoc;
    for (const k of Object.keys(doc.modules)) if (!kept.some((i) => plan.items.find((p) => p.id === i)?.proposal?.module === k)) doc.modules[k]!.enabled = false;
    const tmp = join(paths.runsDir(root, plan.site), 'plans', `${plan.id}.deploy-flags.json`);
    writeFileSync(tmp, JSON.stringify(doc));
    await importFlags(root, cfg, wp, tmp, `deploy ${plan.id}`);
    for (const it of plan.items.filter((i) => kept.includes(i.id) && i.proposal?.dbSteps.length)) for (const d of it.proposal!.dbSteps) await wp.text(d.run);
    let verification = await verify(root, plan.site, { stage, full: true, lighthouseRuns: 0 });
    const turnedOff: string[] = [];
    const order = kept.map((k) => plan.items.find((i) => i.id === k)?.proposal?.module).filter((m): m is string => !!m).reverse();
    for (const m of order) {
      if (verification.result === 'PASS') break;
      await wp.text(['speedpilot', 'disable', m, `--reason=deploy ${plan.id}: production verification failed`]);
      turnedOff.push(m);
      verification = await verify(root, plan.site, { stage, full: true, lighthouseRuns: 0 });
    }
    writeState(root, plan.site, { lastDeploy: { plan: plan.id, at: new Date().toISOString(), backupId, turnedOff } } as never);
    return { planId: plan.id, backupId, drift, verification, turnedOff };
  }
  // Shopify: publish the work theme (local fixture: serve it as the live preview), keep the previous one
  const workDir = join(paths.runsDir(root, plan.site), 'work-theme');
  const previous = (readState(root, plan.site) as { liveThemeDir?: string }).liveThemeDir ?? join(root, 'fixtures/shopify/theme');
  let preview: PreviewServer | undefined;
  if (cfg.local) {
    preview = await swapLivePreview(root, plan.site, workDir, o.livePort);
  } else {
    const { ShopifyCli } = await import('@speedpilot/shopify');
    const st = readState(root, plan.site) as { workThemeId?: string; liveThemeId?: string };
    if (!st.workThemeId) throw new ExecutorRefusal('No recorded work theme.');
    await new ShopifyCli(cfg).publish(st.workThemeId);
    writeState(root, plan.site, { previousLiveThemeId: st.liveThemeId, liveThemeId: st.workThemeId } as never);
  }
  const verification = await verify(root, plan.site, { stage, full: true, lighthouseRuns: 0 });
  writeState(root, plan.site, { lastDeploy: { plan: plan.id, at: new Date().toISOString() }, previousThemeDir: previous } as never);
  void preview;
  return { planId: plan.id, drift: [], verification, turnedOff: [], previousTheme: previous };
}

async function importFlags(root: string, cfg: SiteConfig, wp: WpCli, file: string, reason: string) {
  const fx = join(root, 'packages/wp-agent/tests');
  if (cfg.local) {
    // the fixture mounts packages/wp-agent/tests at /var/www/agent-tests
    const name = `.deploy-${Date.now()}.json`;
    writeFileSync(join(fx, name), readFileSync(file));
    try {
      await wp.text(['speedpilot', 'import', `/var/www/agent-tests/${name}`, `--reason=${reason}`]);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(join(fx, name), { force: true });
    }
    return;
  }
  throw new ExecutorRefusal('Remote flag import goes through the SFTP upload step of the executor, which is not configured for this site.');
}

let livePreview: PreviewServer | undefined;

/** Local fixture "publish": the live preview port serves another theme folder. */
export async function swapLivePreview(root: string, site: string, themeDir: string, port?: number): Promise<PreviewServer> {
  const cfg = loadSite(root, site);
  const p = port ?? Number(new URL(cfg.productionUrl).port || 80);
  const { stopFixturePreview } = await import('@speedpilot/shopify');
  await stopFixturePreview();
  await livePreview?.close();
  livePreview = await startPreview({ themeDir, port: p, host: '127.0.0.1' });
  writeState(root, site, { liveThemeDir: themeDir } as never);
  return livePreview;
}

export async function closeLivePreview(): Promise<void> {
  await livePreview?.close();
  livePreview = undefined;
}

export interface RollbackResult {
  scope: 'item' | 'all' | 'emergency';
  actions: string[];
  verification?: VerificationResult;
}

/** Rollback kit (SPEC.md 7.4): one change, everything, or the emergency kill switch. */
export async function rollback(root: string, site: string, o: { plan?: string; item?: string; all?: boolean; emergency?: boolean; stage?: Stage; verifyAfter?: boolean }): Promise<RollbackResult> {
  const cfg = loadSite(root, site);
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'production');
  const actions: string[] = [];
  const scope: RollbackResult['scope'] = o.emergency ? 'emergency' : o.all ? 'all' : 'item';
  if (!cfg.local) requireApproval(root, { site, operation: o.plan ?? 'rollback', stage, item: o.item });
  if (cfg.platform === 'wordpress') {
    const wp = executorWp(root, cfg, stage, cfg.local ? undefined : { operation: o.plan ?? 'rollback', item: o.item });
    const plan = o.plan ? loadPlan(root, o.plan) : undefined;
    if (scope === 'emergency') {
      await wp.text(['config', 'set', 'SPEEDPILOT_DISABLE', 'true', '--raw', '--type=constant']);
      actions.push("define('SPEEDPILOT_DISABLE', true) in wp-config.php");
    } else if (scope === 'all') {
      await wp.text(['speedpilot', 'disable-all']);
      actions.push('wp speedpilot disable-all');
      for (const it of plan?.items ?? []) for (const d of it.proposal?.dbSteps ?? []) if (d.undo) {
        await wp.text(d.undo);
        actions.push(`wp ${d.undo.join(' ')}`);
      }
    } else {
      const it = plan?.items.find((i) => i.id === o.item);
      if (!it) throw new Error(`Unknown item ${o.item}`);
      if (it.proposal?.module) {
        await wp.text(['speedpilot', 'disable', it.proposal.module, `--reason=rollback ${it.id}`]);
        actions.push(`wp speedpilot disable ${it.proposal.module}`);
      }
      for (const d of it.proposal?.dbSteps ?? []) if (d.undo) {
        await wp.text(d.undo);
        actions.push(`wp ${d.undo.join(' ')}`);
      }
    }
  } else {
    const previous = (readState(root, site) as { previousThemeDir?: string }).previousThemeDir ?? join(root, 'fixtures/shopify/theme');
    if (cfg.local) {
      await swapLivePreview(root, site, previous);
      actions.push(`published the previous theme (${previous})`);
    } else {
      const st = readState(root, site) as { previousLiveThemeId?: string };
      const { ShopifyCli } = await import('@speedpilot/shopify');
      if (!st.previousLiveThemeId) throw new Error('No previous live theme recorded.');
      await new ShopifyCli(cfg).publish(st.previousLiveThemeId);
      actions.push(`published theme ${st.previousLiveThemeId}`);
    }
  }
  const verification = o.verifyAfter === false ? undefined : await verify(root, site, { stage, full: true, lighthouseRuns: 0 });
  return { scope, actions, verification };
}

export interface MonitorResult {
  at: string;
  sinceDeploy?: string;
  pages: Array<{ url: string; status: number | null; consoleErrors: number; failedRequests: number; trackingEvents: number }>;
  phpErrors: number | null;
  orders?: { last24h: number; sameDayLastWeek: number };
  alerts: string[];
  reminders: Array<{ day: number; date: string; what: string }>;
}

/** 72-hour monitoring check plus day-7 and day-28 field-data reminders (SPEC.md 7.5). Read-only. */
export async function monitorSite(root: string, site: string, o: { now?: Date } = {}): Promise<MonitorResult> {
  const cfg = loadSite(root, site);
  const now = o.now ?? new Date();
  const st = readState(root, site) as { lastDeploy?: { at: string } };
  const browser = await launchBrowser();
  const pages: MonitorResult['pages'] = [];
  try {
    for (const url of cfg.sampleUrls.slice(0, 6)) {
      const s = await openSession(browser, { device: 'mobile', local: !!cfg.local });
      const page = await s.newPage();
      let consoleErrors = 0;
      let failed = 0;
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors++;
      });
      page.on('pageerror', () => consoleErrors++);
      page.on('requestfailed', (r) => {
        if (!/blockedbyclient/i.test(r.failure()?.errorText ?? '')) failed++;
      });
      const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 }).catch(() => null);
      await page.waitForTimeout(1500);
      pages.push({ url, status: res?.status() ?? null, consoleErrors, failedRequests: failed, trackingEvents: s.beacons.length });
      await s.close();
    }
  } finally {
    await releaseBrowser();
  }
  let phpErrors: number | null = null;
  let orders: MonitorResult['orders'];
  if (cfg.platform === 'wordpress') {
    const wp = new WpCli(root, cfg, cfg.local ? 'local' : 'production');
    const count = async (from: string, to: string) => Number((await wp.sql(`SELECT COUNT(*) FROM wp_posts WHERE post_type IN ('shop_order','shop_order_placehold') AND post_date >= '${from}' AND post_date < '${to}'`))[0]?.[0] ?? 0);
    const d = (ms: number) => new Date(now.getTime() - ms).toISOString().slice(0, 19).replace('T', ' ');
    orders = await Promise.all([count(d(86_400_000), d(0)), count(d(8 * 86_400_000), d(7 * 86_400_000))]).then(([a, b]) => ({ last24h: a, sameDayLastWeek: b })).catch(() => undefined);
    const host = hostFor(root, cfg, cfg.local ? 'local' : 'production');
    const log2 = await host.shell('tail -n 2000 /var/www/html/wp-content/debug.log 2>/dev/null | grep -c "PHP \\(Fatal\\|Warning\\)" || true').catch(() => undefined);
    phpErrors = log2 ? Number(log2.stdout.trim() || 0) : null;
  }
  const alerts: string[] = [];
  for (const p of pages) {
    if (p.status === null || p.status >= 400) alerts.push(`${p.url} returned ${p.status ?? 'no response'}`);
    if (p.consoleErrors) alerts.push(`${p.url}: ${p.consoleErrors} console error(s)`);
    if (p.failedRequests) alerts.push(`${p.url}: ${p.failedRequests} failed request(s)`);
  }
  if (orders && orders.sameDayLastWeek > 3 && orders.last24h < orders.sameDayLastWeek * 0.5) alerts.push(`orders down: ${orders.last24h} in 24 h against ${orders.sameDayLastWeek} the same day last week`);
  const base = st.lastDeploy ? new Date(st.lastDeploy.at) : now;
  const reminders = [7, 28].map((day) => ({ day, date: new Date(base.getTime() + day * 86_400_000).toISOString().slice(0, 10), what: `CrUX field data check against the baseline (speedpilot audit ${site})` }));
  const result: MonitorResult = { at: now.toISOString(), sinceDeploy: st.lastDeploy?.at, pages, phpErrors, orders, alerts, reminders };
  mkdirSync(join(paths.runsDir(root, site), 'monitor'), { recursive: true });
  writeFileSync(join(paths.runsDir(root, site), 'monitor', `${now.toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 2));
  writeState(root, site, { reminders } as never);
  return result;
}

export { ApprovalError };
