/**
 * Plans (SPEC.md 7.1): each item has its finding IDs, what changes, where, tier, expected gain, verification set,
 * rollback step and dependencies. T3 always covers plugin or app removal, theme or PHP updates, tracking changes,
 * design changes (preloader, hero slider), server or CDN config, HPOS, database engine or index changes.
 * Plans are stored in SQLite and as JSON under runs/<site>/plans/.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, Store, paths, type Tier } from '@speedpilot/core';
import { loadXray } from '@speedpilot/xray';
import { planWordPress } from './wordpress/run.js';
import type { Proposal } from './wordpress/proposals.js';
import { buildShopifyProposals, probeShopify } from './shopify/engine.js';

export interface PlanItem {
  id: string;
  findingIds: string[];
  what: string;
  where: string[];
  tier: Tier;
  expectedGain: string;
  verification: string[];
  rollback: string;
  dependencies: string[];
  kind: 'wp-module' | 'wp-db' | 'shopify-transform';
  /** WordPress: the full proposal (module settings, gates, database steps). */
  proposal?: Proposal;
  /** X-ray changes behind the item (shown in the plan with their verdicts). */
  xrayChanges: string[];
  skipped?: string[];
}

export interface Plan {
  id: string;
  site: string;
  platform: 'wordpress' | 'shopify';
  createdAt: string;
  xrayRun: string;
  items: PlanItem[];
  notes: string[];
}

const T3_HINT = /preloader|remove .*plugin|remove .*app|theme update|php|tracking|hero slider|cdn|server|hpos|index/i;

export function planId(site: string, now = new Date()): string {
  return `plan-${site}-${now.toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
}

export async function createPlan(root: string, site: string): Promise<Plan> {
  const cfg = loadSite(root, site);
  const x = loadXray(root, site);
  const urls = [...new Set(x.captures.map((c) => c.url))];
  const flows = cfg.flows.map((f) => f.name);
  const items: PlanItem[] = [];
  if (cfg.platform === 'wordpress') {
    const { proposals } = await planWordPress(root, site);
    for (const p of proposals) {
      const tier: Tier = T3_HINT.test(p.title) && p.tier !== 'T3' ? 'T3' : p.tier;
      items.push({
        id: p.id,
        findingIds: p.checkIds,
        what: p.title,
        where: p.urls.length ? p.urls : urls,
        tier,
        expectedGain: p.expected,
        verification: ['visual', 'console', 'network', 'seo', 'tracking', 'backend', 'performance', ...flows.map((f) => `flow: ${f}`)],
        rollback: p.module ? `wp speedpilot disable ${p.module} (or restore its previous settings)` : p.dbSteps.map((d) => (d.undo ? `wp ${d.undo.join(' ')}` : `${d.description}: no undo needed (regenerated on demand)`)).join('; '),
        dependencies: [],
        kind: p.module ? 'wp-module' : 'wp-db',
        proposal: p,
        xrayChanges: p.xrayChanges,
        skipped: p.skipped.length ? p.skipped : undefined,
      });
    }
  } else {
    const themeDir = join(root, 'fixtures/shopify/theme');
    const probes = await probeShopify(urls);
    for (const p of buildShopifyProposals(x.ctx, probes, { themeDir })) {
      items.push({ id: p.id, findingIds: p.checkIds, what: p.title, where: urls, tier: p.tier, expectedGain: p.checkIds.join(', '), verification: ['visual', 'console', 'network', 'seo', 'tracking', 'performance', ...flows.map((f) => `flow: ${f}`)], rollback: 'git revert <commit> on the work theme and push it again (before publish); after publish: publish the previous theme by ID', dependencies: [], kind: 'shopify-transform', xrayChanges: p.xrayChanges });
    }
  }
  // CSS fixes and the preloader item share the css module: the preloader item depends on the CSS item
  const css = items.find((i) => i.id === 'wp-css');
  for (const i of items.filter((y) => y.proposal?.module === 'css' && y.id !== 'wp-css')) if (css) i.dependencies.push(css.id);
  const plan: Plan = {
    id: planId(site),
    site,
    platform: cfg.platform,
    createdAt: new Date().toISOString(),
    xrayRun: x.runId,
    items,
    notes: ['T3 items need the client\'s written approval before `speedpilot approve`.', 'Every defer, delay or dequeue item carries its X-ray verdicts and must pass a simulation before it touches staging (SPEC.md 15.5).'],
  };
  const store = new Store(root);
  try {
    store.upsertSite(cfg);
    store.savePlan(plan.id, site, x.runId, plan);
    for (const i of items) store.upsertChange({ id: `${plan.id}:${i.id}`, planId: plan.id, findingIds: i.findingIds, tier: i.tier, description: i.what, implementation: i.kind, status: 'proposed', rollbackSteps: i.rollback });
  } finally {
    store.close();
  }
  mkdirSync(join(paths.runsDir(root, site), 'plans'), { recursive: true });
  writeFileSync(join(paths.runsDir(root, site), 'plans', `${plan.id}.json`), JSON.stringify(plan, null, 2));
  return plan;
}

export function loadPlan(root: string, id: string): Plan {
  const store = new Store(root);
  try {
    const p = store.getPlan<Plan>(id);
    if (!p) throw new Error(`No plan ${id}. Create one with: speedpilot plan <site>`);
    return p.plan;
  } finally {
    store.close();
  }
}

/** Plain-text plan for the terminal and the report. */
export function planText(plan: Plan): string {
  const lines = [`Plan ${plan.id} for ${plan.site} (${plan.items.length} items, X-ray ${plan.xrayRun})`];
  for (const i of plan.items) lines.push(`  ${i.id} [${i.tier}] ${i.what}\n      fixes ${i.findingIds.join(', ')}; expected: ${i.expectedGain}; rollback: ${i.rollback}${i.dependencies.length ? `; after ${i.dependencies.join(', ')}` : ''}`);
  lines.push('', `Approve in your own terminal: speedpilot approve ${plan.id} --stage staging --items <ids|all> --by "<name>"`);
  return lines.join('\n');
}
