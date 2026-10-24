import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, readFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadSite, Store, WpCli, recordBaseline, writeApproval, ApprovalError } from '@speedpilot/core';
import { xrayRun } from '@speedpilot/xray';
import { applyPlan, deployPlan, rollback, executorWp, readFlags, inDeployWindow, closeLivePreview, createPlan, type Plan, type Proposal } from '@speedpilot/engine';
import { ensureFixturePreview, stopFixturePreview } from '@speedpilot/shopify';
import { REPO, tempRoot, wpUp } from './helpers.js';

const proposal = (p: Partial<Proposal> & Pick<Proposal, 'id' | 'module' | 'settings'>): Proposal => ({ title: p.id, checkIds: ['TEST-01'], tier: 'T1', xrayChanges: [], simulate: [], dbSteps: [], files: [], expected: 'test', urls: [], skipped: [], ...p });

function savePlan(root: string, site: string, items: Proposal[], platform: 'wordpress' | 'shopify' = 'wordpress'): Plan {
  const plan: Plan = { id: `plan-${site}-test${Date.now() % 100000}`, site, platform, createdAt: new Date().toISOString(), xrayRun: 'none', notes: [], items: items.map((p) => ({ id: p.id, findingIds: p.checkIds, what: p.title, where: [], tier: p.tier, expectedGain: p.expected, verification: [], rollback: `wp speedpilot disable ${p.module}`, dependencies: [], kind: 'wp-module', proposal: p, xrayChanges: [] })) };
  const store = new Store(root);
  try {
    store.upsertSite(loadSite(root, site));
    store.savePlan(plan.id, site, null, plan);
  } finally {
    store.close();
  }
  return plan;
}

afterAll(async () => {
  await closeLivePreview();
  await stopFixturePreview();
});

describe('executor approvals (no hook involved)', () => {
  it('refuses an unapproved item on a remote stage before writing anything', async () => {
    const root = tempRoot(['fixture-wp']);
    // the same fixture, declared as a remote site: every write now needs an approval
    const f = join(root, 'sites/fixture-wp/site.yaml');
    const y = YAML.parse(readFileSync(f, 'utf8'));
    y.local = false;
    y.stagingUrl = 'http://localhost:8888/';
    writeFileSync(f, YAML.stringify(y));
    const plan = savePlan(root, 'fixture-wp', [proposal({ id: 'item-a', module: 'speculative', settings: {} }), proposal({ id: 'item-b', module: 'core-extras', settings: { emoji: true } })]);
    await expect(applyPlan(root, plan.id, { stage: 'staging' })).rejects.toThrow(ApprovalError);
    expect(() => executorWp(root, loadSite(root, 'fixture-wp'), 'staging')).toThrow(/approved plan item/);
    // an approval for another item does not cover item-b
    writeApproval(root, { site: 'fixture-wp', stage: 'staging', operation: plan.id, items: ['item-a'], approvedBy: 'Test Human' });
    await expect(applyPlan(root, plan.id, { stage: 'staging', items: ['item-b'] })).rejects.toThrow(/item-b is not approved/);
    // a stale approval is refused too
    writeApproval(root, { site: 'fixture-wp', stage: 'staging', operation: plan.id, items: ['item-a', 'item-b'], approvedBy: 'Test Human', approvedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    await expect(applyPlan(root, plan.id, { stage: 'staging' })).rejects.toThrow(/older than 24 hours/);
    // production never takes apply directly
    await expect(applyPlan(root, plan.id, { stage: 'production' })).rejects.toThrow(/staging or the work theme first/);
  });

  it('knows the deploy window and campaigns', () => {
    const cfg = { ...loadSite(REPO, 'fixture-wp'), timezone: 'UTC', deployWindow: { days: ['tue' as const], start: '06:00', end: '09:00' }, campaigns: [] };
    expect(inDeployWindow(cfg, new Date('2026-10-27T07:00:00Z')).ok).toBe(true);
    expect(inDeployWindow(cfg, new Date('2026-10-27T10:00:00Z')).ok).toBe(false);
    expect(inDeployWindow(cfg, new Date('2026-10-28T07:00:00Z')).ok).toBe(false);
    expect(inDeployWindow({ ...cfg, campaigns: [{ name: 'Black Friday', start: '2026-10-26', end: '2026-10-30' }] }, new Date('2026-10-27T07:00:00Z')).why).toMatch(/Black Friday/);
  });
});

describe.skipIf(!wpUp)('apply, deploy and rollback on fixture-wp', () => {
  const root = tempRoot(['fixture-wp']);
  cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
  const wp = new WpCli(REPO, loadSite(REPO, 'fixture-wp'), 'local', undefined, true);

  it('rolls back a change that fails verification and logs why', async () => {
    await wp.text(['speedpilot', 'disable-all']);
    await recordBaseline(root, 'fixture-wp', { urls: ['http://localhost:8888/', 'http://localhost:8888/contact/'] });
    // a deliberately breaking item that skips the X-ray gate: dequeue jQuery, which inline code needs
    const plan = savePlan(root, 'fixture-wp', [proposal({ id: 'break-jquery', module: 'asset-control', settings: { dequeue: [{ handle: 'jquery-core', type: 'script' }, { handle: 'jquery', type: 'script' }] } })]);
    const r = await applyPlan(root, plan.id, { stage: 'local' });
    expect(r.steps[0]!.status).toBe('rolled_back');
    expect(r.steps[0]!.reason).toMatch(/verification failed/);
    expect((await readFlags(wp)).modules['asset-control']?.enabled ?? false).toBe(false);
    const store = new Store(root);
    try {
      const c = store.changes(plan.id)[0]!;
      expect(c.status).toBe('rolled_back');
      expect(c.reason).toMatch(/console|flows|visual/);
    } finally {
      store.close();
    }
  }, 900_000);

  it('deploys the kept items and rollback --all returns the fixture to its backup state', async () => {
    await wp.text(['speedpilot', 'disable-all']);
    const plan = savePlan(root, 'fixture-wp', [
      proposal({ id: 'speculative', module: 'speculative', settings: { mode: 'prefetch', eagerness: 'conservative' } }),
      proposal({ id: 'core-extras', module: 'core-extras', settings: { emoji: true, oembed: true } }),
    ]);
    const applied = await applyPlan(root, plan.id, { stage: 'local' });
    expect(applied.steps.map((s) => s.status)).toEqual(['kept', 'kept']);
    await wp.text(['speedpilot', 'disable-all']); // production starts from the backup state
    const d = await deployPlan(root, plan.id, { simulate: true });
    expect(d.verification.result).toBe('PASS');
    expect(d.backupId).toBeTruthy();
    const flags = await readFlags(wp);
    expect(flags.modules.speculative?.enabled && flags.modules['core-extras']?.enabled).toBe(true);
    const rb = await rollback(root, 'fixture-wp', { plan: plan.id, all: true });
    expect(rb.verification!.result).toBe('PASS');
    const after = await readFlags(wp);
    expect(Object.values(after.modules).every((m) => !m.enabled)).toBe(true);
  }, 1_800_000);
});

describe('apply, deploy and rollback on fixture-shopify', () => {
  it('commits a transform on the work theme, publishes it, and rollback --all publishes the previous theme', async () => {
    const root = tempRoot(['fixture-shopify']);
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    cpSync(join(REPO, 'fixtures/shopify'), join(root, 'fixtures/shopify'), { recursive: true });
    cpSync(join(REPO, 'fixtures/thirdparty'), join(root, 'fixtures/thirdparty'), { recursive: true });
    const cfg = loadSite(root, 'fixture-shopify');
    await ensureFixturePreview(root, cfg);
    const urls = ['http://localhost:9292/', 'http://localhost:9292/products/product-1'];
    await xrayRun(root, 'fixture-shopify', { urls, themeDir: join(root, 'fixtures/shopify/theme') });
    await recordBaseline(root, 'fixture-shopify', { urls });
    const plan = await createPlan(root, 'fixture-shopify');
    expect(plan.items.some((i) => i.id === 'sh-defer-footer-tools.js')).toBe(true);
    const r = await applyPlan(root, plan.id, { stage: 'local', items: ['sh-defer-footer-tools.js', 'sh-speculation'], simulationRuns: 2 });
    expect(r.steps.map((s) => `${s.proposal}:${s.status}`)).toEqual(['sh-defer-footer-tools.js:kept', 'sh-speculation:kept']);
    expect(existsSync(join(root, 'runs/fixture-shopify/work-theme/.git'))).toBe(true);
    const d = await deployPlan(root, plan.id, { simulate: true });
    expect(d.verification.result).toBe('PASS');
    expect(await (await fetch('http://localhost:9292/')).text()).toMatch(/footer-tools\.js[^>]*defer/);
    const rb = await rollback(root, 'fixture-shopify', { plan: plan.id, all: true });
    expect(rb.verification!.result).toBe('PASS');
    expect(await (await fetch('http://localhost:9292/')).text()).not.toMatch(/footer-tools\.js[^>]*defer/);
  }, 1_800_000);
});
