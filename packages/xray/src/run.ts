import { writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { slug, loadSite, Store, launchBrowser, releaseBrowser, AgentClient, FIXTURE_HMAC_SECRET, secret, paths, writeState, type Stage, type AgentDiag, type OwnerContext, type Device } from '@speedpilot/core';
import { captureUrl, type XrayCapture } from './capture/cdp.js';
import { buildModel, openCache, type ScriptInfo } from './build.js';
import { analyzePhpDir, type PhpFacts } from './static/php.js';
import { liquidRenderTree } from './static/liquid.js';
import type { SiteModel } from './model.js';

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
    model.save(store.db, run.id);
    mkdirSync(join(run.dir, 'xray'), { recursive: true });
    writeFileSync(join(run.dir, 'xray', 'site-model.json'), JSON.stringify(model.toJSON()));
    writeFileSync(join(run.dir, 'xray', 'captures.json'), JSON.stringify(captures.map((c) => ({ ...c, scripts: c.scripts.map((s) => ({ ...s })) }))));
    store.endRun(run.id, 'ok');
    return { runId: run.id, dir: run.dir, site, platform: cfg.platform, stage, captures, model, scripts, php, handleMaps };
  } finally {
    if (!o.store) store.close();
  }
}
