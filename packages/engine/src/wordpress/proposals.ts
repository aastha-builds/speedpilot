/**
 * WordPress optimization proposals (SPEC.md 8.1): one agent module per proposal, with its settings, the CHECKS.md IDs
 * it fixes, its tier, the X-ray changes that must be `safe` and the changes the simulator must clear first (SPEC.md
 * 15.5), scripted database steps with their undo, and files to place in uploads/speedpilot/.
 */
import { readFileSync, existsSync } from 'node:fs';
import { classify, matchBeacon, type AgentDiag, type SiteConfig, type Tier } from '@speedpilot/core';
import { isSafe, type VerdictContext, type XraySummary, type SimChange } from '@speedpilot/xray';
import type { ProbeResult } from '../probe.js';

export interface DbStep {
  description: string;
  run: string[];
  undo: string[] | null;
  /** Export taken before the step (quarantine before delete, CLAUDE.md rule 9). */
  exportFirst?: string[];
}

export interface Proposal {
  id: string;
  module: string;
  title: string;
  checkIds: string[];
  tier: Tier;
  settings: Record<string, unknown>;
  /** X-ray changes that must be `safe` before this module may go on. */
  xrayChanges: string[];
  /** Changes the what-if simulator must clear (no breakage signals). */
  simulate: SimChange[];
  dbSteps: DbStep[];
  /** Files to place under uploads/speedpilot/ before the flag goes on (path -> content). */
  files: Array<{ path: string; data: Buffer }>;
  /** Steps that must run on the site first to fill settings (images-build). */
  prepare?: 'images-build' | 'fonts';
  /** Areas the change alters on purpose (masked in the visual check), for example a click-to-load facade. */
  visualMasks?: string[];
  expected: string;
  urls: string[];
  /** Why a candidate was left out (unsafe or unknown verdicts). */
  skipped: string[];
}

export interface ProposalInputs {
  cfg: SiteConfig;
  xray: VerdictContext;
  summary: XraySummary;
  probes: ProbeResult[];
  diag: Record<string, AgentDiag>;
  /** Large autoloaded options with owners (from the audit backend). */
  autoload?: { total: number; options: Array<{ name: string; bytes: number; owner: string; ownerActive?: boolean }> };
  expiredTransients?: number;
  /** SAFE-05 usage scan results per component. */
  usage?: Record<string, { posts: Array<{ url: string }>; builder: Array<{ url: string }>; widgets: unknown[]; menus: unknown[]; templates: Array<{ file: string }> }>;
}

const path = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

/** Scripts and styles on the sample pages, by handle, from the agent's handle maps. */
function handles(diag: Record<string, AgentDiag>): { scripts: Set<string>; styles: Set<string> } {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const d of Object.values(diag)) {
    for (const h of d.scripts) scripts.add(h.handle);
    for (const h of d.styles) styles.add(h.handle);
  }
  return { scripts, styles };
}

/** Proposals, plus the candidates left out and why (unsafe or unknown verdicts, missing usage scan). */
export function buildWpProposals(inp: ProposalInputs): Proposal[] & { skipped: string[] } {
  const { cfg, xray, summary, probes, diag } = inp;
  const out: Proposal[] = [];
  const pages = [...new Set(xray.captures.map((c) => c.url))];
  const base = (p: Partial<Proposal> & Pick<Proposal, 'id' | 'module' | 'title' | 'checkIds' | 'tier' | 'settings' | 'expected'>): Proposal => ({ xrayChanges: [], simulate: [], dbSteps: [], files: [], urls: pages, skipped: [], ...p });
  const verdict = (change: string) => isSafe(xray, change);
  const h = handles(diag);

  // LCP image (IMG-01, WPF-15, REV-03)
  const lcpUrls = [...new Set(xray.captures.map((c) => c.lcp?.url).filter((u): u is string => !!u && /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(u)))];
  const lazyLcp = probes.flatMap((p) => p.images.filter((i) => lcpUrls.includes(i.src) && (i.loading === 'lazy' || i.fetchpriority !== 'high')));
  if (lazyLcp.length) {
    const img = lazyLcp[0]!;
    out.push(base({ id: 'wp-lcp', module: 'lcp', title: 'Load the LCP image first: no lazy loading, fetchpriority high, preload', checkIds: ['IMG-01', 'WPF-15', 'REV-03'], tier: 'T1', settings: { match: img.src.split('/').pop()!.split('?')[0], preload: true, href: img.src, rules: { urls: pages.filter((u) => xray.captures.some((c) => c.url === u && c.lcp?.url === img.src)).map(path) } }, simulate: [{ type: 'lcp-eager', target: img.src.split('/').pop()!.split('?')[0]! }], prepare: 'images-build', expected: 'LCP resource load delay down', urls: pages.filter((u) => xray.captures.some((c) => c.url === u && c.lcp?.url === img.src)) }));
  }

  // Images: dimensions, lazy below the fold, responsive copies (IMG-03, IMG-06, IMG-07, IMG-08, CLS-01)
  const dims: Record<string, [number, number]> = {};
  const oversized = new Set<string>();
  let eagerOffscreen = 0;
  for (const p of probes) {
    for (const i of p.images) {
      const file = i.src.split('/').pop()!.split('?')[0]!;
      // only where the height follows the aspect ratio (a fixed CSS height already reserves the space)
      const aspectHeight = i.naturalWidth ? (i.renderedWidth * i.naturalHeight) / i.naturalWidth : 0;
      if (!i.hasDimensions && i.naturalWidth && i.renderedWidth > 0 && Math.abs(i.renderedHeight - aspectHeight) <= 2) dims[file] = [i.naturalWidth, i.naturalHeight];
      if (i.naturalWidth > i.renderedWidth * 2 * 1.5 && i.renderedWidth > 0) oversized.add(i.src);
      if (!i.inFirstViewport && i.loading !== 'lazy') eagerOffscreen++;
    }
  }
  const iframes = probes.flatMap((p) => p.iframes);
  if (Object.keys(dims).length || oversized.size || eagerOffscreen) {
    out.push(base({ id: 'wp-images', module: 'images', title: `Images: dimensions on ${Object.keys(dims).length}, lazy loading below the fold, responsive copies for ${oversized.size} oversized`, checkIds: ['IMG-03', 'IMG-06', 'IMG-07', 'IMG-08', 'CLS-01', 'IMG-10'], tier: 'T1', settings: { dimensions: dims, eagerCount: 1, lazyIframes: iframes.length > 0, skip: lcpUrls.map((u) => u.split('/').pop()!.split('?')[0]), srcset: {}, oversized: [...oversized] }, prepare: oversized.size ? 'images-build' : undefined, expected: 'fewer image bytes before LCP, CLS from images 0' }));
  }

  // Fonts (FONT-01 to FONT-04)
  const googleCss = [...new Set(xray.captures.flatMap((c) => c.stylesheets.map((s) => s.url).concat(c.requests.filter((r) => r.type === 'stylesheet').map((r) => r.url))).filter((u) => /fonts\.googleapis\.com\/css/.test(u)))];
  if (googleCss.length) {
    const fontHandles = [...h.styles].filter((x) => Object.values(diag).some((d) => d.styles.some((s) => s.handle === x && s.src && /fonts\.googleapis\.com/.test(s.src))));
    out.push(base({ id: 'wp-fonts', module: 'fonts', title: 'Self-host Google Fonts (used weights only, woff2, swap, 2 preloads, metric-matched fallback)', checkIds: ['FONT-01', 'FONT-02', 'FONT-03', 'FONT-04'], tier: 'T2', settings: { dequeue: fontHandles, googleCss }, prepare: 'fonts', expected: 'no requests to Google font servers; fewer font files; LCP text paints with the fallback first' }));
  }

  // Asset control: defer where safe, remove unused libraries, per-template removal of plugin assets (JS-01, JS-02, WPF-11, REV-02)
  const strategy: Record<string, string> = {};
  const dequeue: Array<{ handle: string; type: 'script' | 'style'; rules?: { templates: string[] } }> = [];
  const xrayChanges: string[] = [];
  const simulate: SimChange[] = [];
  const skipSet = new Set<string>();
  const skipped = { push: (x: string) => skipSet.add(x) };
  const handled = new Set<string>(['contact-form-7', 'wc-cart-fragments', 'swv']);
  for (const s of xray.scripts.filter((x) => !x.script.inline && x.handle && x.script.loading === 'blocking')) {
    const hdl = s.handle!;
    if (strategy[hdl] || handled.has(hdl)) continue;
    const v = verdict(`defer:${hdl}`);
    if (v.verdict === 'safe' && !['platform', 'core'].includes(s.script.owner.kind)) {
      strategy[hdl] = 'defer';
      xrayChanges.push(v.change);
      simulate.push({ type: 'defer', target: hdl });
    } else if (v.verdict !== 'safe') skipped.push(`defer:${hdl} ${v.verdict}: ${v.explanation}`);
  }
  for (const s of xray.scripts.filter((x) => !x.script.inline && x.handle && x.script.owner.kind !== 'core')) {
    const hdl = s.handle!;
    if (handled.has(hdl) || dequeue.some((d) => d.handle === hdl)) continue;
    const v = verdict(`remove:${hdl}`);
    if (v.verdict === 'safe') {
      dequeue.push({ handle: hdl, type: 'script' });
      delete strategy[hdl];
      xrayChanges.push(v.change);
      simulate.push({ type: 'remove', target: hdl });
      continue;
    }
    // per-template removal where a recipe's markers prove the page does not need it
    const templates = [...new Set(xray.captures.map((c) => classify(c.url, cfg.platform)))];
    const off = templates.filter((t) => verdict(`remove-template:${hdl}@${t}`).verdict === 'safe');
    if (off.length && off.length < templates.length + 1 && v.recipe) {
      dequeue.push({ handle: hdl, type: 'script', rules: { templates: off } });
      const styleHandle = [...h.styles].find((x) => x === hdl || x.startsWith(hdl.replace(/-frontend$/, '')));
      if (styleHandle) dequeue.push({ handle: styleHandle, type: 'style', rules: { templates: off } });
      for (const t of off) xrayChanges.push(`remove-template:${hdl}@${t}`);
      simulate.push({ type: 'remove-template', target: hdl, template: off[0] });
    }
  }
  if (Object.keys(strategy).length || dequeue.length) {
    out.push(base({ id: 'wp-asset-control', module: 'asset-control', title: `Defer ${Object.keys(strategy).length} script(s) the X-ray proved safe, remove ${dequeue.filter((d) => !d.rules).length} unused, load ${dequeue.filter((d) => d.rules).length} only where needed`, checkIds: ['JS-01', 'JS-02', 'DOC-05', 'WPF-11', 'REV-02'], tier: 'T2', settings: { strategy, dequeue }, xrayChanges, simulate, skipped: [...skipSet], expected: 'fewer render-blocking scripts; less JS on load' }));
  }

  // Contact Form 7 only on form pages (WPF-06), from the SAFE-05 usage scan
  if (h.scripts.has('contact-form-7') || h.styles.has('contact-form-7')) {
    const use = inp.usage?.['contact-form-7'];
    const formUrls = [...new Set([...(use?.posts ?? []), ...(use?.builder ?? [])].map((x) => path(x.url)))];
    const homeTpl = xray.captures.map((c) => classify(c.url, cfg.platform)).find((t) => t !== 'contact') ?? 'home';
    const v = verdict(`remove-template:contact-form-7@${homeTpl}`);
    if (!use) skipped.push('plugin-cf7: no SAFE-05 usage scan');
    else if (use.widgets.length || use.templates.length || use.menus.length) skipped.push('plugin-cf7: forms in widgets or templates; per-page loading would miss them (SAFE-05)');
    else if (v.verdict === 'safe') out.push(base({ id: 'wp-cf7', module: 'plugin-cf7', title: `Contact Form 7 assets only on ${formUrls.length} page(s) with a form`, checkIds: ['WPF-06', 'CSS-09', 'SAFE-05'], tier: 'T1', settings: { rules: { urls: formUrls }, detectShortcode: true }, xrayChanges: [v.change], simulate: [{ type: 'remove-template', target: 'contact-form-7', template: homeTpl }], expected: 'no CF7 JS and CSS on pages without a form' }));
    else skipped.push(`plugin-cf7: ${v.verdict}: ${v.explanation}`);
  }

  // WooCommerce cart fragments only where needed (WPF-07)
  if (h.scripts.has('wc-cart-fragments')) {
    const tpls = [...new Set(xray.captures.map((c) => classify(c.url, cfg.platform)))].filter((t) => !['cart', 'checkout'].includes(t));
    const verdicts = tpls.map((t) => verdict(`remove-template:wc-cart-fragments@${t}`));
    if (verdicts.length && verdicts.every((v) => v.verdict === 'safe')) out.push(base({ id: 'wp-woo-fragments', module: 'plugin-woocommerce', title: 'WooCommerce cart fragments only on cart and checkout (no live mini-cart on other pages)', checkIds: ['WPF-07', 'WPB-16', 'WOO-01'], tier: 'T2', settings: { cartFragments: { keep: [] } }, xrayChanges: verdicts.map((v) => v.change), simulate: [{ type: 'remove', target: 'wc-cart-fragments' }], expected: 'no cart-fragments AJAX request on every page' }));
    else skipped.push(`plugin-woocommerce: ${verdicts.filter((v) => v.verdict !== 'safe').map((v) => `${v.change} ${v.verdict}`).join(', ')}`);
  }

  // Third parties: delay where safe, facades for video and maps (3P-01, 3P-04, VID-02, DOC-08)
  const delay: Record<string, string> = {};
  const tpChanges: string[] = [];
  const tpSim: SimChange[] = [];
  for (const s of xray.scripts.filter((x) => !x.script.inline && x.handle && x.script.owner.kind === 'third-party')) {
    const v = verdict(`delay:${s.handle}`);
    if (v.verdict === 'safe') {
      delay[s.handle!] = 'interaction';
      tpChanges.push(v.change);
      tpSim.push({ type: 'delay', target: s.handle! });
    } else skipped.push(`delay:${s.handle} ${v.verdict}`);
  }
  const facades = { youtube: iframes.some((f) => /youtube/.test(f.src)), vimeo: iframes.some((f) => /vimeo/.test(f.src)), maps: iframes.some((f) => /google\.[a-z.]+\/maps/.test(f.src)) };
  if (Object.keys(delay).length) {
    out.push(base({ id: 'wp-third-parties', module: 'third-parties', title: `Load ${Object.keys(delay).length} third-party widget(s) on first interaction`, checkIds: ['3P-01', '3P-04', 'JS-09'], tier: 'T2', settings: { delay }, xrayChanges: tpChanges, simulate: tpSim, expected: 'third-party main-thread time out of the load' }));
  }
  if (facades.youtube || facades.vimeo || facades.maps) {
    // a facade shows a play button where the player was: that area changes on purpose and is masked in the visual check
    out.push(base({ id: 'wp-facades', module: 'third-parties', title: `Click-to-load facades for ${Object.entries(facades).filter(([, v]) => v).map(([k]) => k).join(', ')} embeds`, checkIds: ['VID-02', 'DOC-08'], tier: 'T2', settings: { facades }, visualMasks: ['.speedpilot-facade'], expected: 'no player iframe and its scripts until the visitor clicks play' }));
  }

  // Core extras (WPF-02, JS-07)
  const migrateWarnings = probes.some((p) => p.consoleMessages.some((m) => /JQMIGRATE/i.test(m) && !/Migrate is installed/i.test(m)));
  const ce: Record<string, boolean> = {};
  if (h.scripts.has('wp-emoji') || xray.scripts.some((s) => /wp-emoji-release/.test(s.script.url))) ce.emoji = true;
  if (h.scripts.has('jquery-migrate') && !migrateWarnings) ce.jqueryMigrate = true;
  if (h.styles.has('dashicons')) ce.dashicons = true;
  ce.oembed = true;
  if (h.scripts.has('comment-reply')) ce.commentReply = true;
  if (h.styles.has('wp-block-library')) ce.blockCss = true;
  out.push(base({ id: 'wp-core-extras', module: 'core-extras', title: `Core extras off for visitors: ${Object.keys(ce).join(', ')}`, checkIds: ['WPF-02', 'JS-07'], tier: 'T1', settings: ce, simulate: ce.jqueryMigrate ? [{ type: 'remove', target: 'jquery-migrate' }] : [], skipped: migrateWarnings ? ['jqueryMigrate: JQMIGRATE warnings seen'] : [], expected: 'fewer requests and bytes on every page' }));

  // CSS: critical CSS per template, async full stylesheets, extra CSS fixes for DOC-04 and CLS-03 (and DOC-03 as T3)
  const critical: Record<string, string> = {};
  for (const p of probes) {
    const t = classify(p.url, cfg.platform);
    if (!critical[t] && p.criticalCss) critical[t] = p.criticalCss;
  }
  const asyncHandles = [...h.styles].filter((x) => !/google|fonts|dashicons|admin-bar/.test(x));
  const hidden = [...new Set(probes.flatMap((p) => p.hiddenAtStart.map((x) => x.selector)).filter(Boolean))];
  const late = probes.flatMap((p) => p.lateInserted.filter((x) => x.position === 'top'));
  const extra: string[] = [];
  if (hidden.length) extra.push(`${hidden.join(',')}{opacity:1!important;transform:none!important;transition:none!important;animation:none!important}`);
  const lateTop = late[0];
  // an in-flow block of the banner's height takes its place (same margins as the banner had), and the banner sits on it
  if (lateTop) extra.push(`body{position:relative}body::before{content:"";display:block;height:${lateTop.height}px}${lateTop.selector}{position:absolute;top:0;left:0;width:100%;height:${lateTop.height}px;box-sizing:border-box;margin:0;overflow:hidden}`);
  if (Object.keys(critical).length) {
    out.push(base({ id: 'wp-css', module: 'css', title: `Critical CSS for ${Object.keys(critical).length} template(s), full stylesheets loaded async`, checkIds: ['CSS-01', 'CSS-02'], tier: 'T2', settings: { critical, async: asyncHandles }, expected: 'no render-blocking CSS' }));
  }
  if (lateTop) {
    out.push(base({ id: 'wp-reserve-banner', module: 'css', title: `Reserve ${lateTop.height}px for the banner inserted after load (${lateTop.selector})`, checkIds: ['CLS-03'], tier: 'T2', settings: { extraCss: extra[extra.length - 1] }, expected: 'no layout shift when the banner appears' }));
  }
  if (hidden.length) {
    out.push(base({ id: 'wp-no-entrance-animation', module: 'css', title: `No entrance animation on first-screen elements (${hidden.slice(0, 4).join(', ')})`, checkIds: ['DOC-04'], tier: 'T2', settings: { extraCss: extra[0] }, expected: 'first screen visible without waiting for a script; LCP render delay down' }));
  }
  const preloaders = [...new Set(probes.flatMap((p) => p.preloaders))];
  if (preloaders.length) {
    out.push(base({ id: 'wp-preloader', module: 'css', title: `Remove the page preloader (${preloaders.join(', ')})`, checkIds: ['DOC-03'], tier: 'T3', settings: { extraCss: `${preloaders.join(',')}{display:none!important}` }, expected: 'LCP no longer waits for the load event (design change: written client approval)' }));
  }

  // Resource hints: drop preconnects to origins nothing uses early (NET-04, NET-05)
  const usedOrigins = new Set(xray.captures.flatMap((c) => c.requests.filter((r) => r.startMs < (c.fcp ?? 3000) && !matchBeacon(r.url)).map((r) => new URL(r.url).origin)));
  const thirdOrigins = [...new Set(xray.captures.flatMap((c) => c.requests.map((r) => new URL(r.url).origin)))].filter((o) => o !== new URL(cfg.productionUrl).origin);
  out.push(base({ id: 'wp-resource-hints', module: 'resource-hints', title: 'Resource hints: preconnect only to critical origins, dns-prefetch for the rest', checkIds: ['NET-04', 'NET-05'], tier: 'T1', settings: { preconnect: [...usedOrigins].filter((o) => thirdOrigins.includes(o) && !/fonts\.(googleapis|gstatic)/.test(o)).slice(0, 2), dnsPrefetch: thirdOrigins.filter((o) => !usedOrigins.has(o)).slice(0, 5), remove: googleCss.length ? ['fonts.googleapis.com', 'fonts.gstatic.com'] : [] }, expected: 'no wasted connections' }));

  // Speculative loading with strict exclusions (WPF-18, WPB-30)
  out.push(base({ id: 'wp-speculative', module: 'speculative', title: 'Speculative loading: conservative prefetch, cart, checkout, account, logout, add-to-cart and query URLs excluded', checkIds: ['WPF-18', 'WPB-30'], tier: 'T1', settings: { mode: 'prefetch', eagerness: 'conservative', excludePaths: [] }, expected: 'faster next-page navigations without extra server load' }));

  // Elementor assets only on Elementor pages (WPF-08)
  if ([...h.scripts].some((x) => x.startsWith('elementor'))) {
    const elementorPages = new Set((inp.usage?.elementor?.builder ?? []).map((x) => path(x.url)));
    const tpls = [...new Set(xray.captures.map((c) => classify(c.url, cfg.platform)))];
    const vs = tpls.map((t) => verdict(`remove-template:elementor-frontend@${t}`));
    const pagesNotBuilt = xray.captures.filter((c) => !elementorPages.has(path(c.url)));
    if (pagesNotBuilt.length && vs.every((v) => v.verdict === 'safe')) out.push(base({ id: 'wp-elementor', module: 'plugin-elementor', title: 'Elementor front-end assets only on pages built with Elementor', checkIds: ['WPF-08'], tier: 'T1', settings: {}, xrayChanges: vs.map((v) => v.change), simulate: [{ type: 'remove', target: 'elementor-frontend' }], expected: 'no Elementor JS and CSS on other pages' }));
    else skipped.push(`plugin-elementor: ${vs.filter((v) => v.verdict !== 'safe').map((v) => `${v.change} ${v.verdict}`).join(', ') || 'every captured page is built with Elementor'}`);
  }

  // Slow theme or plugin queries (WPB-12, WPB-13)
  const slowQ = Object.values(diag).flatMap((d) => d.wp_queries ?? []).filter((q) => q.ms >= 50 && q.caller);
  if (slowQ.length) {
    const rules = [...new Map(slowQ.map((q) => [JSON.stringify(q.args), { match: q.args, cap: 12, orderby: 'date', ttl: 600, caller: q.caller, ms: q.ms }])).values()];
    out.push(base({ id: 'wp-query-cache', module: 'query-cache', title: `Bound and cache ${rules.length} slow query(ies): ${rules.map((r) => `${r.caller} (${Math.round(r.ms)} ms)`).join(', ')}`, checkIds: ['WPB-12', 'WPB-13', 'NET-01'], tier: 'T2', settings: { rules: rules.map(({ match, cap, orderby, ttl }) => ({ match, cap, orderby, ttl })) }, expected: 'uncached PHP render time down' }));
  }

  // Slow interaction handlers: yield before the handler so the browser paints first (JS-04, REV-07)
  const yieldable = summary.slowHandlers.filter((s) => s.fn && s.fn !== '(anonymous)');
  if (yieldable.length) {
    const safe = yieldable.filter((s) => {
      const node = xray.model.byType('handler').find((n) => n.data.function === s.fn && String(n.data.url) === s.script);
      const src = xray.scripts.find((x) => x.script.url === s.script);
      const text = src ? readSource(src.script.sourcePath) : '';
      return !!node && !/preventDefault|stopPropagation|stopImmediatePropagation|returnValue/.test(functionBody(text, s.fn!));
    });
    if (safe.length) out.push(base({ id: 'wp-interaction-yield', module: 'interaction-yield', title: `Yield to the browser before ${safe.map((s) => s.fn).join(', ')} so the click paints at once`, checkIds: ['JS-04', 'REV-07'], tier: 'T2', settings: { handlers: safe.map((s) => ({ name: s.fn, type: s.event || 'click' })) }, expected: `INP for those interactions under 200 ms` }));
    for (const s of yieldable.filter((x) => !safe.includes(x))) skipped.push(`interaction-yield: ${s.fn} calls preventDefault or stopPropagation; needs a code change (report)`);
  }

  // Backend: autoload and transients (WPB-04, WPB-05) as scripted database steps with their undo
  const big = (inp.autoload?.options ?? []).filter((o) => o.bytes >= 50_000);
  const steps: DbStep[] = [];
  if (big.length) steps.push({ description: `Autoload off for ${big.length} large option(s): ${big.map((o) => `${o.name} (${Math.round(o.bytes / 1024)} KB, ${o.owner})`).join(', ')}`, run: ['speedpilot', 'autoload', 'off', ...big.map((o) => o.name)], undo: ['speedpilot', 'autoload', 'on', ...big.map((o) => o.name)] });
  if ((inp.expiredTransients ?? 0) > 0) steps.push({ description: `Delete ${inp.expiredTransients} expired transients`, run: ['transient', 'delete', '--expired'], undo: null });
  if (steps.length) out.push(base({ id: 'wp-backend-db', module: '', title: steps.map((s) => s.description).join('; '), checkIds: [...(big.length ? ['WPB-04'] : []), ...((inp.expiredTransients ?? 0) > 0 ? ['WPB-05'] : [])], tier: 'T2', settings: {}, dbSteps: steps, expected: 'smaller alloptions load on every request; TTFB down' }));

  const order = (p: Proposal) => (p.module === 'fonts' ? 0 : 1);
  out.sort((a, b) => order(a) - order(b));
  return Object.assign(out, { skipped: [...skipSet] });
}

function readSource(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** The body of a named function in a script (for the handler guard). */
function functionBody(src: string, name: string): string {
  const i = src.search(new RegExp(`function\\s+${name.replace(/[$]/g, '\\$')}\\s*\\(`));
  if (i < 0) return src;
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}
