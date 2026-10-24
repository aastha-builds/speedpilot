/**
 * Shopify optimization engine (SPEC.md 8.2). Works on a git working copy of the WORK theme: each transform is one
 * commit, pushed with Shopify CLI to the work theme only (`--theme <work id> --nodelete --only <files>`, never `--live`).
 * Script changes need an X-ray `safe` verdict and a simulation with no breakage first (SPEC.md 15.5). On the local
 * fixture the "push" restarts the work-theme preview instead.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSite, paths, readState, verify, log, requireApproval, type SiteConfig, type Stage, type VerificationResult } from '@speedpilot/core';
import { isSafe, loadXray, simulate, type VerdictContext, type SimChange } from '@speedpilot/xray';
import { ShopifyCli, startPreview, type PreviewServer } from '@speedpilot/shopify';
import { buildSelfHostedFonts } from '../wordpress/fonts.js';
import { probePage, type ProbeResult } from '../probe.js';
import { resizeImage, imageSize } from '../images.js';
import * as T from './transforms.js';

export interface ShopifyProposal {
  id: string;
  title: string;
  checkIds: string[];
  tier: 'T1' | 'T2' | 'T3';
  xrayChanges: string[];
  simulate: SimChange[];
  /** Builds the transform on the working copy (may produce files such as fonts and resized images). */
  build(themeDir: string): Promise<T.TransformResult | undefined>;
  skipped?: string;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=SpeedPilot', '-c', 'user.email=speedpilot@localhost', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}

/** A git working copy of the work theme (created from the theme snapshot the backup took, or the fixture theme). */
export function workingCopy(root: string, site: string, sourceThemeDir: string): string {
  const dir = join(paths.runsDir(root, site), 'work-theme');
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(sourceThemeDir, dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'snapshot: work theme before SpeedPilot changes');
  }
  return dir;
}

export function buildShopifyProposals(x: VerdictContext, probes: ProbeResult[], o: { themeDir: string }): ShopifyProposal[] {
  const out: ShopifyProposal[] = [];
  const v = (c: string) => isSafe(x, c);
  const layout = readFileSync(join(o.themeDir, 'layout/theme.liquid'), 'utf8');

  // parser-blocking scripts: defer when safe; a library whose only dependents are inline scripts can move with them
  for (const s of x.scripts.filter((s0) => !s0.script.inline && s0.script.loading === 'blocking' && s0.script.owner.kind === 'theme')) {
    const asset = s.script.url.split('?')[0]!.split('/').pop()!;
    const d = v(`defer:${asset}`);
    if (d.verdict === 'safe') {
      out.push({ id: `sh-defer-${asset}`, title: `Defer ${asset}`, checkIds: ['SHT-02', 'JS-01'], tier: 'T1', xrayChanges: [d.change], simulate: [{ type: 'defer', target: asset }], build: async (dir) => T.deferScript(dir, asset) });
      continue;
    }
    // every blocker is an inline dependent, and nothing else needs what those inline scripts define before DOMContentLoaded
    const blockers = d.reasons.filter((r) => r.severity !== 'ok');
    const inlineOnly = blockers.length > 0 && blockers.every((r) => r.kind === 'dependent' && r.detail.startsWith('inline script'));
    const deps = x.scripts.filter((u) => u.page === s.page && u.script.inline && x.model.out(u.id, 'depends-on').some((e) => e.dst === s.id));
    const definedByDeps = deps.flatMap((u) => x.model.out(u.id, 'defines').filter((e) => e.dst.startsWith('global:')).map((e) => e.dst));
    const earlyReaders = definedByDeps.flatMap((g) => x.model.in(g, 'uses').filter((e) => e.data?.immediate && !deps.some((u) => u.id === e.src)));
    if (inlineOnly && !earlyReaders.length) {
      const needles = deps.map((u) => String(x.model.nodes.get(u.id)?.data.contentHead ?? '').slice(0, 40)).filter(Boolean);
      out.push({ id: `sh-defer-${asset}-with-inline`, title: `Defer ${asset} and run its ${deps.length} inline dependent(s) on DOMContentLoaded`, checkIds: ['SHT-02', 'JS-01', 'SAFE-01'], tier: 'T2', xrayChanges: [], simulate: [], build: async (dir) => T.deferWithInlineDependents(dir, asset, needles.map((n) => n.trim().slice(0, 30))) });
    }
  }

  // LCP image
  const lcpUrl = x.captures.find((c) => c.lcp?.url)?.lcp?.url;
  if (lcpUrl && probes.some((p) => p.images.some((i) => i.src === lcpUrl && (i.loading === 'lazy' || i.fetchpriority !== 'high')))) {
    const asset = lcpUrl.split('?')[0]!.split('/').pop()!;
    out.push({
      id: 'sh-lcp-image',
      title: 'LCP image: image_tag with widths and sizes, eager, fetchpriority high, preload; resized copies for the theme asset',
      checkIds: ['SHT-06', 'SHT-07', 'IMG-01', 'IMG-03', 'IMG-06'],
      tier: 'T1',
      xrayChanges: [],
      simulate: [{ type: 'lcp-eager', target: asset }],
      build: async (dir) => {
        const file = ['sections/hero.liquid', ...['sections', 'snippets'].flatMap((d) => (existsSync(join(dir, d)) ? (execFileSync('ls', [join(dir, d)], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => `${d}/${f}`)) : []))].find((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f), 'utf8').includes(asset)) ?? 'sections/hero.liquid';
        const assetPath = join(dir, 'assets', asset);
        let dims: { width: number; height: number } | undefined;
        let resized: Array<{ file: string; width: number; data: Buffer }> = [];
        if (existsSync(assetPath)) {
          const buf = readFileSync(assetPath);
          dims = imageSize(buf);
          const r = await resizeImage(buf, asset.endsWith('.png') ? 'image/png' : 'image/jpeg', [480, 800, 1200, 1600]);
          resized = r.map((y) => ({ file: `${asset.replace(/\.\w+$/, '')}-${y.width}.webp`, width: y.width, data: y.data }));
        }
        const t = T.lcpImage(dir, file, { assetDims: dims, resized, sizes: '100vw' });
        if (t) t.added = resized.map((y) => ({ file: `assets/${y.file}`, data: y.data }));
        return t;
      },
    });
  }

  // fonts from Google servers
  const googleCss = [...new Set(x.captures.flatMap((c) => c.requests.filter((r) => /fonts\.googleapis\.com\/css/.test(r.url)).map((r) => r.url)))];
  if (googleCss.length) {
    out.push({
      id: 'sh-fonts',
      title: 'Self-host the theme fonts (used weights only, woff2, swap, preload 2)',
      checkIds: ['FONT-01', 'FONT-02', 'FONT-09', 'SHT-08'],
      tier: 'T2',
      xrayChanges: [],
      simulate: [],
      build: async (dir) => {
        const used = probes.flatMap((p) => p.fontsLoaded);
        const built = await buildSelfHostedFonts(googleCss, used, 'ASSET/', probes.map((p) => p.criticalCss).join('\n'));
        return T.selfHostFonts(dir, `${built.fallbackCss}\n${built.css}`.replace(/url\(ASSET\/([^)]+)\)/g, 'url(x/$1)'), built.files.map((f) => ({ name: f.name, data: f.data! })), built.preload.map((p) => p.replace('ASSET/', '')));
      },
    });
  }

  // Liquid hot spots with nested variant loops (SHT-09)
  for (const n of x.model.byType('liquid').filter((l) => ((l.data.hotSpots as unknown[]) ?? []).length)) {
    const file = n.label;
    if (!existsSync(join(o.themeDir, file))) continue;
    out.push({ id: `sh-liquid-${file.replace(/[^a-z0-9]+/gi, '-')}`, title: `Fix the Liquid hot spot in ${file}`, checkIds: ['SHT-09'], tier: 'T2', xrayChanges: [], simulate: [], build: async (dir) => T.liquidMinPriceLoop(dir, file) });
  }

  // leftover app snippets (SHA-03) and their enabled embed (SHA-02)
  for (const n of x.model.byType('liquid').filter((l) => l.data.leftoverApp)) {
    const snippet = n.label.replace(/^snippets\//, '').replace(/\.liquid$/, '');
    const sd = JSON.parse(readFileSync(join(o.themeDir, 'config/settings_data.json'), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as { current?: { blocks?: Record<string, { type: string; disabled?: boolean }> } };
    const embed = Object.entries(sd.current?.blocks ?? {}).find(([, b]) => b.type.includes(`/apps/${n.data.leftoverApp}/`) && !b.disabled)?.[0];
    out.push({ id: `sh-leftover-${snippet}`, title: `Stop rendering the leftover ${n.data.leftoverApp} snippet${embed ? ' and disable its app embed' : ''} (the snippet file stays, quarantined)`, checkIds: ['SHA-03', 'SHA-02', 'NET-10'], tier: 'T2', xrayChanges: [], simulate: [], build: async (dir) => T.removeLeftoverApp(dir, snippet, embed) });
  }

  // third-party scripts injected in the layout: delay when safe (3P-04)
  for (const s of x.scripts.filter((s0) => !s0.script.inline && s0.script.owner.kind === 'third-party' && s0.script.loading !== 'injected')) {
    const path = new URL(s.script.url).pathname;
    if (!layout.includes(path)) continue;
    const d = v(`delay:${path}`);
    if (d.verdict === 'safe') out.push({ id: `sh-delay-${path.replace(/[^a-z0-9]+/gi, '-')}`, title: `Load ${path} on the first interaction`, checkIds: ['3P-01', '3P-04', 'SHA-01'], tier: 'T2', xrayChanges: [d.change], simulate: [{ type: 'delay', target: path }], build: async (dir) => T.delayThirdParty(dir, path) });
  }

  // nested theme blocks (SHT-21) and speculation rules
  out.push({ id: 'sh-flatten-groups', title: 'Remove redundant nested group blocks in the home template', checkIds: ['SHT-21'], tier: 'T2', xrayChanges: [], simulate: [], build: async (dir) => (existsSync(join(dir, 'templates/index.json')) ? T.flattenGroups(dir, 'templates/index.json') : undefined) });
  out.push({ id: 'sh-speculation', title: 'Speculation rules: moderate prefetch for product and collection links with strict exclusions', checkIds: ['SHT-20'], tier: 'T1', xrayChanges: [], simulate: [], build: async (dir) => T.speculationRules(dir) });
  return out;
}

export interface ShopifyStep {
  proposal: string;
  status: 'kept' | 'rolled_back' | 'skipped';
  reason: string;
  commit?: string;
  files?: string[];
  verification?: { result: string; failed: string[]; evidence: string };
}

/** Pushes changed files to the recorded work theme (never live); on the local fixture restarts the work preview. */
async function pushWork(cfg: SiteConfig, root: string, dir: string, files: string[], local: { preview?: PreviewServer; port: number }): Promise<PreviewServer | undefined> {
  if (cfg.local) {
    await local.preview?.close();
    return startPreview({ themeDir: dir, port: local.port, host: '127.0.0.1' });
  }
  const st = readState(root, cfg.name) as { workThemeId?: string };
  const cli = new ShopifyCli(cfg);
  // the work theme recorded by the backup; ShopifyCli refuses any other theme and the live one
  await cli.pushToWorkTheme(String(st.workThemeId ?? ''), st.workThemeId, dir, files);
  return undefined;
}

export async function applyShopify(root: string, site: string, o: { proposals: ShopifyProposal[]; workDir: string; stage?: Stage; workPort?: number; simulationRuns?: number; approval?: { operation: string }; onStep?: (s: ShopifyStep) => void }): Promise<ShopifyStep[]> {
  const cfg = loadSite(root, site);
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'staging');
  const x = loadXray(root, site).ctx;
  const steps: ShopifyStep[] = [];
  const port = o.workPort ?? 9293;
  let preview: PreviewServer | undefined = cfg.local ? await startPreview({ themeDir: o.workDir, port, host: '127.0.0.1' }) : undefined;
  const base = cfg.local ? `http://127.0.0.1:${port}` : undefined;
  try {
    for (const p of o.proposals) {
      const step: ShopifyStep = { proposal: p.id, status: 'skipped', reason: '' };
      try {
        if (!cfg.local) requireApproval(root, { site, operation: o.approval?.operation ?? 'none', stage, item: p.id });
        const bad = p.xrayChanges.map((c) => isSafe(x, c)).filter((r) => r.verdict !== 'safe');
        if (bad.length) throw new Error(`gate: ${bad.map((b) => `${b.change} ${b.verdict}`).join(', ')}`);
        if (p.simulate.length) {
          const sim = await simulate(x.captures[0]!.url, p.simulate, { outDir: join(o.workDir, '..', `sim-${p.id}`), runs: o.simulationRuns ?? 3, platform: 'shopify', local: !!cfg.local });
          if (sim.breakage.length) throw new Error(`gate: simulation (REV-08): ${sim.breakage.join('; ')}`);
        }
        const t = await p.build(o.workDir);
        if (!t) {
          step.reason = 'nothing to change';
          steps.push(step);
          o.onStep?.(step);
          continue;
        }
        const files = T.writeTransform(o.workDir, t);
        git(o.workDir, 'add', '-A');
        git(o.workDir, 'commit', '-qm', `${t.id}: ${t.description} (${t.checkIds.join(', ')})`);
        step.commit = git(o.workDir, 'rev-parse', '--short', 'HEAD');
        step.files = files;
        preview = await pushWork(cfg, root, o.workDir, files, { preview, port });
        const v: VerificationResult = await verify(root, site, { stage, base, lighthouseRuns: 0 });
        const failed = v.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.details.slice(0, 3).join('; ')}`);
        step.verification = { result: v.result, failed, evidence: v.evidenceDir };
        if (v.result === 'PASS') {
          step.status = 'kept';
          step.reason = t.description;
        } else {
          git(o.workDir, 'revert', '--no-edit', 'HEAD');
          preview = await pushWork(cfg, root, o.workDir, files, { preview, port });
          step.status = 'rolled_back';
          step.reason = `verification failed: ${failed.join(' | ')}`;
          log.warn({ proposal: p.id, failed }, 'Shopify change reverted');
        }
      } catch (e) {
        step.reason = (e as Error).message;
      }
      steps.push(step);
      o.onStep?.(step);
    }
  } finally {
    await preview?.close();
  }
  return steps;
}

/** Probes for the Shopify proposals (fonts in use, LCP image state). */
export async function probeShopify(urls: string[]): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const u of urls) out.push(await probePage(u, { local: true }));
  return out;
}
