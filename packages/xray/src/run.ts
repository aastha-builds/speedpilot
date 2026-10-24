import { writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { slug, loadSite, Store, launchBrowser, releaseBrowser, AgentClient, FIXTURE_HMAC_SECRET, secret, paths, writeState, type Stage, type AgentDiag, type OwnerContext, type Device } from '@speedpilot/core';
import { captureUrl, type XrayCapture } from './capture/cdp.js';
import { buildModel, openCache, type ScriptInfo } from './build.js';
import { analyzePhpDir, type PhpFacts } from './static/php.js';
import { liquidRenderTree, leftoverAppSnippets } from './static/liquid.js';
import { SiteModel } from './model.js';
import { allVerdicts, isSafe, type Verdict, type VerdictContext } from './analysis/verdicts.js';
import { interactionBreakdowns, slowHandlers, type InteractionBreakdown } from './analysis/interactions.js';
import { waterfall, waterfallHtml } from './analysis/waterfall.js';
import { ownerCosts, costsHtml, type OwnerCost } from './analysis/costs.js';
import { backendMap } from './analysis/backend.js';
import { loadRecipes, withLearnedConfidence, matchRecipe, draftRecipe, writeDraft, versionMismatch, type Recipe } from './recipes.js';
import { proposeReplacements } from './replacements.js';
import { graphHtml } from './graph.js';
import { logVerdicts } from './learning.js';
import { runRea, attachRea, type ReaResult } from './rea.js';
import { WpCli } from '@speedpilot/core';

export interface XrayRunOptions {
  stage?: Stage;
  urls?: string[];
  deep?: boolean;
  explore?: boolean;
  devices?: Device[];
  /** Folders with the active theme and plugins (local copies), for PHP static analysis. */
  phpDirs?: Array<{ dir: string; owner: string }>;
  themeDir?: string;
  ownerRules?: OwnerContext['rules'];
  store?: Store;
  /** Installed versions per owner (plugin:x -> 1.2.3) for recipe version checks (REV-04). */
  versions?: Record<string, string>;
  /** Run the optional REA cross-check (SPEC.md 15.11). Off by default; the X-ray never needs it. */
  rea?: boolean | { runner?: import('./rea.js').ReaRunner };
}

export interface XrayRun {
  runId: string;
  dir: string;
  site: string;
  platform: 'wordpress' | 'shopify';
  stage: Stage;
  captures: XrayCapture[];
  model: SiteModel;
  scripts: ScriptInfo[];
  php: PhpFacts[];
  handleMaps: Record<string, AgentDiag>;
  verdicts: Verdict[];
  interactions: InteractionBreakdown[];
  costs: OwnerCost[];
  summary: XraySummary;
  recipes: Recipe[];
  rea?: ReaResult;
}

export type XraySummary = {
  verdicts: Array<{ change: string; target: string; template?: string; verdict: 'safe' | 'unsafe' | 'unknown'; reasons: string[] }>;
  earlyUnused: Array<{ url: string; owner: string; bytes: number; type: string }>;
  lateNeeded: Array<{ url: string; type: string; delayMs: number }>;
  slowHandlers: Array<{ selector: string; event: string; script: string; fn?: string; ms: number; owner: string }>;
  heavyWidgets: Array<{ owner: string; mainThreadMs: number; bytes: number; output: string }>;
  recipeMismatches: Array<{ recipe: string; installed: string; verified: string[] }>;
  simulations: Array<{ change: string; gainMs: number | null; ok: boolean; issues: string[] }>;
  competitors?: Array<{ url: string; lcp?: number; inp?: number; notes: string[] }>;
  unknownScripts: Array<{ owner: string; url: string; draft?: string }>;
};

/** Installed plugin and theme versions on WordPress (read-only WP-CLI). */
async function wpVersions(root: string, cfg: ReturnType<typeof loadSite>, stage: Stage): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const wp = new WpCli(root, cfg, stage);
    for (const p of await wp.json<Array<{ name: string; version: string; status: string }>>(['plugin', 'list', '--fields=name,version,status', '--skip-update-check'])) if (p.status !== 'inactive') out[`plugin:${p.name}`] = p.version;
    for (const t of await wp.json<Array<{ name: string; version: string; status: string }>>(['theme', 'list', '--fields=name,version,status', '--skip-update-check'])) if (t.status !== 'inactive') out[`theme:${t.name}`] = t.version;
  } catch {
    /* versions are optional evidence */
  }
  return out;
}

/** Everything the planner and the report need from one X-ray, written next to the Site Model. */
export function analyzeXray(dir: string, ctx: VerdictContext, o: { versions?: Record<string, string>; captures: XrayCapture[]; platform: 'wordpress' | 'shopify' }) {
  const verdicts = allVerdicts(ctx);
  const interactions = interactionBreakdowns(ctx.model, o.captures);
  const costs = ownerCosts(o.captures, interactions);
  const xdir = join(dir, 'xray');
  mkdirSync(join(xdir, 'waterfalls'), { recursive: true });
  const earlyUnused: XraySummary['earlyUnused'] = [];
  const lateNeeded: XraySummary['lateNeeded'] = [];
  for (const cap of o.captures) {
    const needed = new Set(ctx.scripts.filter((s) => s.page === cap.url && !s.script.inline && s.script.loading === 'blocking' && isSafe(ctx, { type: 'defer', target: s.handle ?? s.script.url.split('?')[0]! }).verdict !== 'safe').map((s) => s.script.url));
    const w = waterfall(cap, needed);
    writeFileSync(join(xdir, 'waterfalls', `${slug(cap.url)}.${cap.device}.json`), JSON.stringify(w));
    writeFileSync(join(xdir, 'waterfalls', `${slug(cap.url)}.${cap.device}.html`), waterfallHtml(w));
    for (const e of w.earlyUnused) if (!earlyUnused.some((x) => x.url === e.url)) earlyUnused.push(e);
    for (const l of w.lateNeeded) if (!lateNeeded.some((x) => x.url === l.url)) lateNeeded.push(l);
  }
  // recipes: owners without one get a draft (REV-01); version mismatches (REV-04)
  const owners = [...new Set(ctx.scripts.filter((s) => !s.script.inline).map((s) => s.script.owner.id))].filter((x) => /^(plugin|theme|app|third-party):/.test(x));
  const unknownScripts: XraySummary['unknownScripts'] = [];
  const recipeMismatches: XraySummary['recipeMismatches'] = [];
  const ownerRecipes: Array<{ owner: string; recipe?: Recipe }> = [];
  for (const owner of owners) {
    const sample = ctx.scripts.find((s) => s.script.owner.id === owner && !s.script.inline)!;
    const recipe = matchRecipe(ctx.recipes, o.platform, { url: sample.script.url, handle: sample.handle })?.recipe;
    ownerRecipes.push({ owner, recipe });
    if (!recipe) {
      const draft = writeDraft(join(xdir, 'recipe-drafts'), draftRecipe(ctx.model, ctx.scripts, owner, o.platform));
      unknownScripts.push({ owner, url: sample.script.url, draft });
    } else {
      const installed = o.versions?.[owner];
      if (installed && versionMismatch(recipe, installed)) recipeMismatches.push({ recipe: recipe.id, installed, verified: recipe.versionsVerified });
    }
  }
  const replacements = proposeReplacements(o.captures, costs, ownerRecipes);
  const summary: XraySummary = {
    verdicts: verdicts.map((v) => ({ change: v.change, target: v.target, template: v.change.startsWith('remove-template:') ? v.change.split('@').pop() : undefined, verdict: v.verdict, reasons: [...new Set(v.reasons.filter((r) => r.severity !== 'ok').map((r) => r.detail))].slice(0, 5) })),
    earlyUnused,
    lateNeeded,
    slowHandlers: slowHandlers(interactions).map(({ page: _p, ...h }) => h),
    heavyWidgets: replacements.map((r) => ({ owner: r.owner, mainThreadMs: r.mainThreadMs, bytes: r.bytes, output: r.output })),
    recipeMismatches,
    simulations: [],
    unknownScripts,
  };
  writeFileSync(join(xdir, 'verdicts.json'), JSON.stringify(verdicts, null, 1));
  writeFileSync(join(xdir, 'interactions.json'), JSON.stringify(interactions, null, 1));
  writeFileSync(join(xdir, 'costs.json'), JSON.stringify(costs, null, 1));
  writeFileSync(join(xdir, 'costs.html'), costsHtml(costs));
  writeFileSync(join(xdir, 'backend.json'), JSON.stringify(backendMap(ctx.model), null, 1));
  writeFileSync(join(xdir, 'replacements.json'), JSON.stringify(replacements, null, 1));
  writeFileSync(join(xdir, 'graph.html'), graphHtml(ctx.model));
  writeFileSync(join(xdir, 'summary.json'), JSON.stringify(summary, null, 1));
  return { verdicts, interactions, costs, summary };
}

/** Loads a saved X-ray (the latest, or one run ID) for explain, safe, graph and diff without capturing again. */
export function loadXray(root: string, site: string, runId?: string): { runId: string; dir: string; ctx: VerdictContext; captures: XrayCapture[]; summary?: XraySummary } {
  const cfg = loadSite(root, site);
  const latestPath = join(paths.runsDir(root, site), 'xray-latest.json');
  let dir: string;
  let id: string;
  if (runId) {
    id = runId;
    dir = join(paths.runsDir(root, site), runId);
  } else {
    if (!existsSync(latestPath)) throw new Error(`No X-ray for ${site} yet. Run: speedpilot xray ${site}`);
    const l = JSON.parse(readFileSync(latestPath, 'utf8')) as { runId: string; dir: string };
    [id, dir] = [l.runId, l.dir];
  }
  const x = join(dir, 'xray');
  if (!existsSync(join(x, 'site-model.json'))) throw new Error(`No Site Model in ${x}`);
  const model = SiteModel.fromJSON(JSON.parse(readFileSync(join(x, 'site-model.json'), 'utf8')));
  const scripts = JSON.parse(readFileSync(join(x, 'scripts.json'), 'utf8')) as ScriptInfo[];
  const captures = JSON.parse(readFileSync(join(x, 'captures.json'), 'utf8')) as XrayCapture[];
  const summary = existsSync(join(x, 'summary.json')) ? (JSON.parse(readFileSync(join(x, 'summary.json'), 'utf8')) as XraySummary) : undefined;
  return { runId: id, dir, ctx: { platform: cfg.platform, model, scripts, captures, recipes: loadRecipes(root) }, captures, summary };
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Theme name from config/settings_schema.json (theme_info). */
export function themeName(themeDir: string): string {
  try {
    const j = JSON.parse(readFileSync(join(themeDir, 'config', 'settings_schema.json'), 'utf8')) as Array<{ name: string; theme_name?: string }>;
    return j.find((x) => x.name === 'theme_info')?.theme_name ?? 'theme';
  } catch {
    return 'theme';
  }
}

/** Local fixture folders for PHP analysis: the theme, the stand-ins and WooCommerce when present. */
export function fixturePhpDirs(root: string): Array<{ dir: string; owner: string }> {
  const base = existsSync(join(root, 'fixtures', 'wp')) ? join(root, 'fixtures', 'wp') : join(REPO, 'fixtures', 'wp');
  const out = [{ dir: join(base, 'theme', 'speedpilot-fixture'), owner: 'theme:speedpilot-fixture' }];
  const st = join(base, 'standins');
  if (existsSync(st)) for (const d of readdirSync(st)) if (!d.includes('.')) out.push({ dir: join(st, d), owner: `plugin:${d}` });
  const woo = join(base, '.cache', 'plugins', 'woocommerce');
  if (existsSync(join(woo, 'woocommerce.php'))) out.push({ dir: woo, owner: 'plugin:woocommerce' });
  return out;
}

/** `speedpilot xray <site>` (SPEC.md 15.9): capture, static analysis, Site Model. Needs reverse-engineering permission (rule 16). */
export async function xrayRun(root: string, site: string, o: XrayRunOptions = {}): Promise<XrayRun> {
  const cfg = loadSite(root, site);
  if (!cfg.local && !cfg.permission.reverseEngineering) throw new Error('X-ray deep analysis needs the client\'s written permission: set permission.reverseEngineering: true in site.yaml (CLAUDE.md rule 16).');
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'production');
  const store = o.store ?? new Store(root);
  try {
    store.upsertSite(cfg);
    const run = store.startRun(site, 'xray', stage);
    const base = stage === 'staging' && cfg.stagingUrl ? cfg.stagingUrl : cfg.productionUrl;
    const urls = o.urls ?? (cfg.sampleUrls.length ? cfg.sampleUrls : [cfg.productionUrl]);
    const themeDirEarly = o.themeDir ?? (cfg.platform === 'shopify' && cfg.local ? (existsSync(join(root, 'fixtures/shopify/theme')) ? join(root, 'fixtures/shopify/theme') : join(REPO, 'fixtures/shopify/theme')) : undefined);
    const themeOwner = themeDirEarly ? `theme:${slug(themeName(themeDirEarly))}` : undefined;
    const themeRules = themeOwner ? [{ match: '/cdn/shop/t/', owner: themeOwner }, ...(cfg.local ? [{ match: `${new URL(base).origin}/assets/`, owner: themeOwner }, { match: `${new URL(base).origin}/cdn/img/`, owner: themeOwner }] : [])] : [];
    const ownerCtx: OwnerContext = { siteOrigin: new URL(base).origin, platform: cfg.platform, rules: [...(o.ownerRules ?? []), ...themeRules, ...cfg.keepThirdParties.map((h) => ({ match: h, owner: `third-party:${h}` }))] };
    const devices = o.devices ?? (o.deep ? ['mobile', 'desktop'] : ['mobile']);
    const captures: XrayCapture[] = [];
    const browser = await launchBrowser();
    writeState(root, site, { currentTarget: { stage: cfg.local ? 'local' : stage, url: base } });
    try {
      for (const url of urls) {
        for (const device of devices) {
          captures.push(await captureUrl(browser, { url, device, stage: cfg.local ? 'local' : stage, outDir: join(run.dir, 'xray'), ownerCtx, explore: o.explore ?? true, har: true }));
          if (o.deep && cfg.consent.tool) captures.push(await captureUrl(browser, { url, device, stage: cfg.local ? 'local' : stage, outDir: join(run.dir, 'xray'), ownerCtx, explore: false, consent: 'granted' }));
        }
      }
    } finally {
      await releaseBrowser();
    }
    // WordPress: agent handle maps per URL (and slow queries on non-production stages)
    const handleMaps: Record<string, AgentDiag> = {};
    if (cfg.platform === 'wordpress') {
      const hmac = secret(cfg.access.wordpress?.agentHmacSecret) ?? (cfg.local ? FIXTURE_HMAC_SECRET : undefined);
      const agent = new AgentClient(base, hmac);
      for (const url of urls) {
        const d = await agent.diag(url).catch(() => undefined);
        if (d?.diag) handleMaps[url] = d.diag;
      }
    }
    const php = cfg.platform === 'wordpress' ? (o.phpDirs ?? (cfg.local ? fixturePhpDirs(root) : [])).map((p) => analyzePhpDir(p.dir, p.owner, { maxFiles: p.owner === 'plugin:woocommerce' ? 120 : 400 })) : [];
    const themeDir = themeDirEarly;
    const liquid = themeDir ? liquidRenderTree(themeDir) : undefined;
    const cache = openCache(join(paths.runsDir(root, site), 'xray-cache'));
    const { model, scripts } = buildModel({ platform: cfg.platform, captures, cache, handleMaps, php, liquid, liquidOwner: themeOwner });
    if (themeDir) {
      for (const l of leftoverAppSnippets(themeDir, captures.flatMap((c) => c.requests))) {
        const n = model.nodes.get(`liquid:${l.file}`);
        if (n) Object.assign(n.data, { leftoverApp: l.app, leftoverHosts: l.hosts });
      }
    }
    mkdirSync(join(run.dir, 'xray'), { recursive: true });
    let rea: ReaResult | undefined;
    if (o.rea) {
      // optional second opinion on the client's own bundles; never decisive, never required
      rea = await runRea(join(run.dir, 'xray', 'sources'), join(run.dir, 'xray'), typeof o.rea === 'object' ? { runner: o.rea.runner } : {}).catch((e: Error) => ({ available: false, version: 'n/a', reason: e.message, findings: [] }));
      attachRea(model, rea);
    }
    model.save(store.db, run.id);
    writeFileSync(join(run.dir, 'xray', 'site-model.json'), JSON.stringify(model.toJSON()));
    writeFileSync(join(run.dir, 'xray', 'captures.json'), JSON.stringify(captures.map((c) => ({ ...c, scripts: c.scripts.map((s) => ({ ...s })) }))));
    writeFileSync(join(run.dir, 'xray', 'scripts.json'), JSON.stringify(scripts));
    const recipes = withLearnedConfidence(loadRecipes(root), store.db);
    const versions = o.versions ?? (cfg.platform === 'wordpress' ? await wpVersions(root, cfg, cfg.local ? 'local' : stage) : {});
    const ctx: VerdictContext = { platform: cfg.platform, model, scripts, captures, recipes };
    const a = analyzeXray(run.dir, ctx, { versions, captures, platform: cfg.platform });
    logVerdicts(store.db, site, run.id, a.verdicts);
    writeFileSync(join(paths.runsDir(root, site), 'xray-latest.json'), JSON.stringify({ runId: run.id, dir: run.dir }));
    store.endRun(run.id, 'ok');
    return { runId: run.id, dir: run.dir, site, platform: cfg.platform, stage, captures, model, scripts, php, handleMaps, verdicts: a.verdicts, interactions: a.interactions, costs: a.costs, summary: a.summary, recipes, rea };
  } finally {
    if (!o.store) store.close();
  }
}

/** Adds simulation results (REV-08) and competitor rows (REV-06) to the latest X-ray summary the rules engine reads. */
export function updateLatestSummary(root: string, site: string, add: { simulations?: XraySummary['simulations']; competitors?: XraySummary['competitors'] }): string | undefined {
  const latest = join(paths.runsDir(root, site), 'xray-latest.json');
  if (!existsSync(latest)) return undefined;
  const p = join((JSON.parse(readFileSync(latest, 'utf8')) as { dir: string }).dir, 'xray', 'summary.json');
  if (!existsSync(p)) return undefined;
  const s = JSON.parse(readFileSync(p, 'utf8')) as XraySummary;
  if (add.simulations) s.simulations = [...s.simulations.filter((x) => !add.simulations!.some((y) => y.change === x.change)), ...add.simulations];
  if (add.competitors) s.competitors = add.competitors;
  writeFileSync(p, JSON.stringify(s, null, 1));
  return p;
}
