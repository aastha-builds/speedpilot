import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, cpSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSite, WpCli, summarize, Store } from '@speedpilot/core';
import { xrayRun, isSafe, loadXray, explain, simulate, measure, loadRecipes, type Truth, type XrayRun, type VerdictContext } from '@speedpilot/xray';
import { ensureFixturePreview, stopFixturePreview } from '@speedpilot/shopify';
import { buildProgram } from '../packages/cli/src/program.js';
import { REPO, tempRoot, wpUp } from './helpers.js';

const truth = JSON.parse(readFileSync(join(REPO, 'fixtures/truth.json'), 'utf8')) as { wp: Truth; shopify: Truth };

/** CI gates (SPEC.md 15.10): zero false "safe" verdicts; at least 80% of truly safe changes found. */
function gates(ctx: VerdictContext, t: Truth) {
  const rows = t.changes.map((c) => ({ ...c, got: isSafe(ctx, c.change) }));
  const falseSafe = rows.filter((r) => r.got.verdict === 'safe' && r.verdict !== 'safe');
  const trulySafe = rows.filter((r) => r.verdict === 'safe');
  const found = trulySafe.filter((r) => r.got.verdict === 'safe');
  return { rows, falseSafe, recall: trulySafe.length ? found.length / trulySafe.length : 1 };
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    buf += s;
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return buf;
}

describe.skipIf(!wpUp)('X-ray part 2 on fixture-wp', () => {
  let root: string;
  let x: XrayRun;
  beforeAll(async () => {
    root = tempRoot(['fixture-wp']);
    cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
    x = await xrayRun(root, 'fixture-wp', { urls: ['http://localhost:8888/', 'http://localhost:8888/contact/'] });
  }, 600_000);

  it('has zero false safe verdicts and finds at least 80% of truly safe changes', () => {
    const g = gates({ platform: 'wordpress', model: x.model, scripts: x.scripts, captures: x.captures, recipes: x.recipes }, truth.wp);
    expect(g.falseSafe.map((r) => `${r.change}: ${r.got.explanation}`)).toEqual([]);
    expect(g.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('refuses to defer jQuery because of the planted inline dependency, and xray explain shows why', async () => {
    const v = isSafe({ platform: 'wordpress', model: x.model, scripts: x.scripts, captures: x.captures, recipes: x.recipes }, 'defer:jquery-core');
    expect(v.verdict).toBe('unsafe');
    expect(v.reasons.some((r) => r.kind === 'dependent' && /spf-legacy-slider-js-after/.test(r.detail))).toBe(true);
    const saved = loadXray(root, 'fixture-wp');
    expect(saved.runId).toBe(x.runId);
    expect(explain(saved.ctx, 'jquery-core').text).toMatch(/spf-legacy-slider-js-after/);
    process.env.SPEEDPILOT_ROOT = root;
    try {
      const text = await captureStdout(() => buildProgram().exitOverride().parseAsync(['node', 'speedpilot', 'xray', 'explain', 'fixture-wp', 'jquery-core']));
      expect(text).toMatch(/defer:jquery-core: UNSAFE/);
      expect(text).toMatch(/inline script #spf-legacy-slider-js-after/);
      expect(text).toMatch(/Evidence: .*site-model\.json/);
    } finally {
      delete process.env.SPEEDPILOT_ROOT;
    }
  });

  it('names the planted slow click handler and its script', () => {
    const slow = x.summary.slowHandlers.find((h) => h.fn === 'spfHeavyClickHandler');
    expect(slow, JSON.stringify(x.summary.slowHandlers)).toBeDefined();
    expect(slow!.script).toContain('/assets/js/heavy-click.js');
    expect(slow!.owner).toBe('theme:speedpilot-fixture');
    expect(slow!.ms).toBeGreaterThan(100);
    const it2 = x.interactions.find((i) => i.handlers.some((h) => h.function === 'spfHeavyClickHandler'))!;
    expect(it2.selector).toContain('heavy-button');
    expect(it2.processingMs + it2.inputDelayMs + it2.presentationMs).toBeGreaterThan(0);
  });

  it('writes the waterfall, costs, graph, backend map and recipe drafts', () => {
    for (const f of ['summary.json', 'verdicts.json', 'graph.html', 'costs.html', 'backend.json', 'interactions.json']) expect(existsSync(join(x.dir, 'xray', f)), f).toBe(true);
    expect(x.summary.lateNeeded.some((l) => l.url.includes('hero.jpg')), 'lazy hero discovered late (REV-03)').toBe(true);
    expect(x.summary.earlyUnused.length).toBeGreaterThan(0);
    expect(x.costs.find((c) => c.owner === 'plugin:woocommerce')?.bytes).toBeGreaterThan(0);
    // the fixture chat widget has no recipe, so the X-ray drafts one for review (REV-01)
    expect(x.summary.unknownScripts.some((u) => u.url.includes('/chat/widget.js') && u.owner.startsWith('third-party:') && u.draft && existsSync(u.draft)), JSON.stringify(x.summary.unknownScripts)).toBe(true);
    const backend = JSON.parse(readFileSync(join(x.dir, 'xray', 'backend.json'), 'utf8')) as Array<{ kind: string; owner: string; where: string }>;
    expect(backend.some((b) => b.owner === 'theme:speedpilot-fixture' && /spf_related_posts/.test(b.where))).toBe(true);
    // shadow mode: every verdict logged
    const s = new Store(root);
    try {
      expect((s.db.prepare('SELECT COUNT(*) AS n FROM xray_verdicts WHERE run_id = ?').get(x.runId) as { n: number }).n).toBe(x.verdicts.length);
    } finally {
      s.close();
    }
  });
});

describe('X-ray part 2 on fixture-shopify', () => {
  let x: XrayRun;
  beforeAll(async () => {
    const root = tempRoot(['fixture-shopify']);
    await ensureFixturePreview(REPO, loadSite(root, 'fixture-shopify'));
    x = await xrayRun(root, 'fixture-shopify', { urls: ['http://localhost:9292/', 'http://localhost:9292/products/product-1'], themeDir: join(REPO, 'fixtures/shopify/theme') });
  }, 600_000);
  afterAll(() => stopFixturePreview());

  it('has zero false safe verdicts and finds at least 80% of truly safe changes', () => {
    const g = gates({ platform: 'shopify', model: x.model, scripts: x.scripts, captures: x.captures, recipes: x.recipes }, truth.shopify);
    expect(g.falseSafe.map((r) => `${r.change}: ${r.got.explanation}`)).toEqual([]);
    expect(g.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('never marks a platform script (content_for_header) as changeable', () => {
    for (const v of x.verdicts.filter((y) => y.owner?.startsWith('platform:'))) expect(v.verdict, v.change).not.toBe('safe');
  });

  it('maps the Liquid hot spot and leftover app code in the backend map', () => {
    const backend = JSON.parse(readFileSync(join(x.dir, 'xray', 'backend.json'), 'utf8')) as Array<{ kind: string; where: string }>;
    expect(backend.some((b) => b.kind === 'liquid-hot-spot' && b.where.includes('featured-collection'))).toBe(true);
    expect(backend.some((b) => b.kind === 'leftover-app-code' && b.where.includes('oldreviews'))).toBe(true);
  });

  it('completes normally with REA missing, and REA never changes a verdict', async () => {
    const root = tempRoot(['fixture-shopify']);
    const missing = await xrayRun(root, 'fixture-shopify', { urls: ['http://localhost:9292/'], themeDir: join(REPO, 'fixtures/shopify/theme'), explore: false, rea: { runner: async () => ({ code: null, stdout: '', stderr: 'spawn npx ENOENT' }) } });
    expect(missing.rea?.available).toBe(false);
    expect(missing.verdicts.length).toBeGreaterThan(0);
    const withRea = await xrayRun(root, 'fixture-shopify', { urls: ['http://localhost:9292/'], themeDir: join(REPO, 'fixtures/shopify/theme'), explore: false, rea: { runner: async () => ({ code: 0, stdout: JSON.stringify({ findings: [{ file: 'vendor-slider.js', type: 'global', description: 'defines VendorSlider' }, { file: 'footer-tools.js', type: 'dependency', description: 'claims a dependency' }] }), stderr: '' }) } });
    expect(withRea.rea?.available).toBe(true);
    expect(withRea.model.byType('script').some((s) => Array.isArray(s.data.rea))).toBe(true);
    const by = (r: XrayRun) => Object.fromEntries(r.verdicts.map((v) => [v.change, v.verdict]));
    expect(by(withRea)).toEqual(by(missing));
  }, 600_000);
});

describe.skipIf(!wpUp)('What-if simulator on fixture-wp', () => {
  // A faster network profile than Lighthouse mobile: under 1.6 Mbps the six eager off-screen thumbnails (IMG-07) use up
  // the bandwidth and the lazy-hero fix alone gains nothing either way; both arms use the same profile.
  const net = { latencyMs: 40, downloadKbps: 10_000 };
  it('predicts the gain of fixing the lazy hero, and the real result lands inside the predicted range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-sim-'));
    const wp = new WpCli(REPO, loadSite(REPO, 'fixture-wp'), 'local');
    await wp.raw(['option', 'delete', 'spf_fixture_fix_hero']);
    const sim = await simulate('http://localhost:8888/', 'lcp-eager:hero.jpg', { outDir: join(dir, 'sim'), ...net });
    expect(sim.label).toBe('simulated');
    expect(sim.applied).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'sim', 'simulation.json'))).toBe(true);
    const before = await measure('http://localhost:8888/', { outDir: join(dir, 'before'), tag: 'b', ...net });
    await wp.raw(['option', 'update', 'spf_fixture_fix_hero', '1']);
    try {
      const after = await measure('http://localhost:8888/', { outDir: join(dir, 'after'), tag: 'a', ...net });
      const real = (summarize(before.map((s) => s.lcp)).median ?? 0) - (summarize(after.map((s) => s.lcp)).median ?? 0);
      expect(real, `real ${real} vs predicted ${JSON.stringify(sim.gain.lcpMs)}`).toBeGreaterThanOrEqual(sim.gain.lcpMs.min!);
      expect(real).toBeLessThanOrEqual(sim.gain.lcpMs.max!);
    } finally {
      await wp.raw(['option', 'delete', 'spf_fixture_fix_hero']);
    }
  }, 900_000);

  it('flags a breaking change before it touches staging (REV-08)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-sim-'));
    const sim = await simulate('http://localhost:8888/', 'defer:jquery-core', { outDir: dir, runs: 2, ...net });
    expect(sim.ok).toBe(false);
    expect(sim.issues.join(' ')).toMatch(/new console errors/);
  }, 600_000);
});

describe('recipes', () => {
  it('ships the seed recipes from SPEC.md 15.6 with identifiers only', () => {
    const r = loadRecipes(REPO);
    const names = r.map((x) => x.id);
    for (const id of ['wp-plugin-woocommerce', 'wp-plugin-elementor', 'wp-plugin-elementor-pro', 'wp-plugin-contact-form-7', 'wp-plugin-wpforms', 'wp-plugin-gravity-forms', 'wp-plugin-yoast-seo', 'wp-plugin-rank-math', 'wp-plugin-slider-revolution', 'wp-plugin-smart-slider-3', 'wp-plugin-wpml', 'wp-plugin-polylang', 'wp-plugin-jetpack', 'wp-plugin-site-kit', 'wp-plugin-monsterinsights', 'wp-theme-astra', 'wp-theme-generatepress', 'wp-theme-kadence', 'wp-theme-hello-elementor', 'wp-theme-divi', 'wp-theme-avada', 'shopify-theme-horizon', 'shopify-theme-dawn', 'shopify-app-judge-me', 'shopify-app-klaviyo', 'shopify-app-yotpo', 'shopify-app-loox', 'shopify-app-pagefly', 'shopify-app-gempages', 'shopify-app-shopify-inbox', 'shopify-app-tidio', 'shopify-app-weglot', 'shopify-app-recharge', 'shopify-app-rebuy', 'shopify-app-vitals', 'lib-library-jquery', 'lib-library-jquery-migrate', 'lib-library-swiper', 'lib-library-slick', 'lib-library-owl-carousel', 'lib-library-gsap', 'lib-library-aos', 'lib-library-lodash', 'lib-library-font-awesome']) expect(names, id).toContain(id);
    expect(names.filter((n) => n.includes('addons')).length + names.filter((n) => n.includes('happy')).length).toBeGreaterThanOrEqual(2);
    for (const x of r) expect(JSON.stringify(x)).not.toMatch(/function\s*\(|=>\s*\{/);
  });
});
