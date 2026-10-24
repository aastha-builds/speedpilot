/** Evaluators for WordPress (WPB, WPF), Shopify (SHT, SHA) and reverse-engineering (REV) checks. */
import { type Evaluator, type Draft, type EvalContext, uniquePages, mobile, kb, sameOrigin, hostOf, byKey } from './types.js';
import type { AgentHandle } from '../backend/agent.js';

/** PHP versions with active or security support at run time are checked against this list (php.net/supported-versions). */
export const SUPPORTED_PHP = ['8.2', '8.3', '8.4', '8.5'];

function templateOf(ctx: EvalContext, url: string): string {
  return ctx.audit.pages.find((p) => p.url === url)?.template ?? 'page';
}

/** Per URL: scripts and styles from the agent handle map. */
function handles(ctx: EvalContext): Array<{ url: string; template: string; scripts: AgentHandle[]; styles: AgentHandle[]; html?: string }> {
  return (ctx.wp?.perUrl ?? []).filter((u) => u.diag).map((u) => ({ url: u.url, template: u.diag!.template || templateOf(ctx, u.url), scripts: u.diag!.scripts, styles: u.diag!.styles }));
}

function assetsEverywhere(ctx: EvalContext, handleRe: RegExp, usedOn: (template: string, url: string) => boolean, label: string): Draft[] {
  const rows = handles(ctx);
  if (!rows.length) return [];
  const loadedOn = rows.filter((r) => [...r.scripts, ...r.styles].some((h) => handleRe.test(h.handle)));
  const wasted = loadedOn.filter((r) => !usedOn(r.template, r.url));
  if (!wasted.length) return [];
  const files = [...new Set(wasted.flatMap((r) => [...r.scripts, ...r.styles].filter((h) => handleRe.test(h.handle)).map((h) => `${h.handle}: ${h.src ?? 'inline'}`)))];
  return [{ urls: wasted.map((r) => r.url), evidence: { label, loadedOn: loadedOn.map((r) => r.template), notNeededOn: wasted.map((r) => `${r.template} ${r.url}`), handles: files }, gain: { bytes: 25 * 1024, tbtMs: 20 }, rootCause: label }];
}

function hasForm(ctx: EvalContext, url: string, selectorHint = 'wpcf7'): boolean {
  const p = ctx.audit.pages.find((x) => x.url === url);
  return !!p && p.evidence.document.forms > 0 && p.evidence.coverage.some((c) => c.url.includes(selectorHint) && c.usedBytes / Math.max(1, c.totalBytes) > 0.2);
}

export const wpEvaluators: Record<string, Evaluator> = {
  'WPB-01': (ctx) => {
    const php = String(ctx.wp?.environment?.php ?? '');
    if (!php) return [];
    const minor = php.split('.').slice(0, 2).join('.');
    return SUPPORTED_PHP.includes(minor) ? [] : [{ urls: [ctx.cfg.productionUrl], evidence: { php, supported: SUPPORTED_PHP }, tier: 'T3' }];
  },
  'WPB-02': (ctx) => {
    const o = ctx.wp?.environment?.opcache as { enabled: boolean; free_mb: number | null; hit_rate: number | null } | null | undefined;
    if (ctx.wp?.environment === undefined) return [];
    if (!o || !o.enabled || (o.free_mb !== null && o.free_mb < 8) || (o.hit_rate !== null && o.hit_rate < 90)) return [{ urls: [ctx.cfg.productionUrl], evidence: { opcache: o ?? 'not available' }, tier: 'T3', gain: { ttfbMs: 100 } }];
    return [];
  },
  'WPB-03': (ctx) => {
    const e = ctx.wp?.environment;
    if (!e || ctx.cfg.local) return [];
    const issues = Object.entries({ xdebug: e.xdebug, wp_debug_display: e.wp_debug && e.wp_debug_display, savequeries: e.savequeries, query_monitor: ctx.wp?.plugins.some((p) => p.name === 'query-monitor' && p.status === 'active') }).filter(([, v]) => v).map(([k]) => k);
    return issues.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { issues } }] : [];
  },
  'WPB-04': (ctx) => {
    const a = ctx.wp?.autoload;
    if (!a) return [];
    const big = a.top.filter((t) => t.bytes > 100 * 1024);
    const leftovers = a.top.filter((t) => t.owner.startsWith('unknown:'));
    if (a.total_bytes <= 800 * 1024 && !big.length) return [];
    return [{ urls: [ctx.cfg.productionUrl], evidence: { totalKb: kb(a.total_bytes), count: a.count, largest: a.top.slice(0, 20).map((t) => ({ name: t.name, kb: kb(t.bytes), owner: t.owner })), leftoversOfRemovedPlugins: leftovers.map((t) => t.name) }, gain: { ttfbMs: Math.round(a.total_bytes / 20000) }, rootCause: 'autoload' }];
  },
  'WPB-05': (ctx) => ((ctx.wp?.autoload?.expired_transients ?? 0) > 20 ? [{ urls: [ctx.cfg.productionUrl], evidence: { expiredTransients: ctx.wp!.autoload!.expired_transients } }] : []),
  'WPB-06': (ctx) => ((ctx.wp?.database.revisions ?? 0) > 500 ? [{ urls: [ctx.cfg.productionUrl], evidence: { revisions: ctx.wp!.database.revisions } }] : []),
  'WPB-07': (ctx) => {
    const d = ctx.wp?.database;
    if (!d) return [];
    const n = (d.orphanPostmeta ?? 0) + (d.orphanTermmeta ?? 0) + (d.orphanCommentmeta ?? 0) + (d.spamComments ?? 0) + (d.trashComments ?? 0) + (d.autoDrafts ?? 0);
    return n > 100 ? [{ urls: [ctx.cfg.productionUrl], evidence: { orphanPostmeta: d.orphanPostmeta, orphanTermmeta: d.orphanTermmeta, orphanCommentmeta: d.orphanCommentmeta, spam: d.spamComments, trash: d.trashComments, autoDrafts: d.autoDrafts } }] : [];
  },
  'WPB-08': (ctx) => {
    const a = ctx.wp?.database.actionScheduler;
    return a && (a.pastDue > 100 || a.failed > 100 || a.complete > 10000 || a.bytes > 50 * 1024 * 1024) ? [{ urls: [ctx.cfg.productionUrl], evidence: a, note: 'investigate failing jobs first: they often mean a broken integration' }] : [];
  },
  'WPB-09': (ctx) => {
    const s = ctx.wp?.database.wcSessions;
    return s && (s.rows > 5000 || s.bytes > 20 * 1024 * 1024) ? [{ urls: [ctx.cfg.productionUrl], evidence: s }] : [];
  },
  'WPB-10': (ctx) => {
    const t = (ctx.wp?.database.tables ?? []).filter((x) => /(log|stats|statistics|redirection_404|wfhits|wflogins|actionscheduler_logs|email_log|visits)/i.test(x.name) && x.bytes > 50 * 1024 * 1024);
    return t.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { tables: t.map((x) => ({ name: x.name, mb: Math.round(x.bytes / 1048576) })) } }] : [];
  },
  'WPB-11': (ctx) => (ctx.wp?.database.myisam.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { myisam: ctx.wp.database.myisam }, tier: 'T3' }] : []),
  'WPB-12': (ctx) => {
    const rows = (ctx.wp?.perUrl ?? []).flatMap((u) => (u.diag?.queries ?? []).filter((q) => q.ms >= 50).map((q) => ({ url: u.url, ...q })));
    if (!rows.length) return [];
    return [{ urls: [...new Set(rows.map((r) => r.url))], evidence: { queries: [...new Map(rows.map((r) => [r.sql + r.caller.function, r])).values()].map((r) => ({ ms: r.ms, caller: r.caller, sql: r.sql })).slice(0, 10) }, gain: { ttfbMs: Math.round(Math.max(...rows.map((r) => r.ms))) }, rootCause: rows[0]!.caller.owner.split(':').slice(0, 2).join(':') }];
  },
  'WPB-13': (ctx) => {
    const rows = (ctx.wp?.perUrl ?? []).flatMap((u) => (u.diag?.queries ?? []).filter((q) => /ORDER BY RAND\(\)|posts_per_page|LIMIT 0, ?18446744073709551615|meta_key|NOT EXISTS/i.test(q.sql) || q.caller.owner.startsWith('theme:')).map((q) => ({ url: u.url, ...q })));
    const theme = rows.filter((r) => r.caller.owner.startsWith('theme:'));
    return theme.length ? [{ urls: [...new Set(theme.map((r) => r.url))], evidence: { queries: theme.slice(0, 10).map((r) => ({ ms: r.ms, caller: r.caller, sql: r.sql })) }, gain: { ttfbMs: Math.round(theme.reduce((a, r) => a + r.ms, 0) / Math.max(1, new Set(theme.map((r) => r.url)).size)) }, rootCause: theme[0]!.caller.owner.split(':').slice(0, 2).join(':') }] : [];
  },
  'WPB-14': (ctx) => {
    const rows = (ctx.wp?.perUrl ?? []).flatMap((u) => (u.diag?.http ?? []).map((h) => ({ page: u.url, ...h })));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.page))], evidence: { calls: rows.slice(0, 10) }, gain: { ttfbMs: Math.round(rows.reduce((a, r) => a + (r.ms ?? 0), 0)) } }] : [];
  },
  'WPB-15': (ctx) => {
    const c = ctx.wp?.cron;
    return c && (c.overdue > 5 || c.tooFrequent.length || c.duplicates.length) ? [{ urls: [ctx.cfg.productionUrl], evidence: { overdue: c.overdue, tooFrequent: c.tooFrequent, duplicates: c.duplicates, disableWpCron: c.disable_wp_cron } }] : [];
  },
  'WPB-16': (ctx) => {
    const ajax = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /admin-ajax\.php|wc-ajax=get_refreshed_fragments|\/wp-json\//.test(r.url) && (r.type === 'xhr' || r.type === 'fetch')));
    const frag = handles(ctx).filter((r) => r.scripts.some((s) => s.handle === 'wc-cart-fragments'));
    if (!ajax.length && !frag.length) return [];
    return [{ urls: [...new Set([...ajax.map((p) => p.url), ...frag.map((r) => r.url)])], evidence: { ajaxOnLoad: ajax.flatMap((p) => p.evidence.requests.filter((r) => /admin-ajax|wc-ajax|wp-json/.test(r.url)).map((r) => r.url)).slice(0, 10), cartFragmentsOn: frag.map((r) => r.template) }, gain: { tbtMs: 30, ttfbMs: 0 }, rootCause: 'plugin:woocommerce' }];
  },
  'WPB-17': (ctx) => {
    const hb = handles(ctx).filter((r) => r.scripts.some((s) => s.handle === 'heartbeat'));
    return hb.length ? [{ urls: hb.map((r) => r.url), evidence: { heartbeatOnFrontEnd: true } }] : [];
  },
  'WPB-18': (ctx) => {
    const active = (ctx.wp?.plugins ?? []).filter((p) => p.status === 'active');
    return active.length > 30 ? [{ urls: [ctx.cfg.productionUrl], evidence: { activePlugins: active.length }, tier: 'T3' }] : [];
  },
  'WPB-19': (ctx) => {
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && /wp-statistics|koko-analytics|independent-analytics|post-views-counter|wp-slimstat|visitors-traffic/.test(x.name));
    return p.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: p.map((x) => x.name) }, tier: 'T3' }] : [];
  },
  'WPB-20': (ctx) => {
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && /wordfence|sucuri|ithemes-security|better-wp-security|all-in-one-wp-security|solid-security|shield/.test(x.name));
    return p.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: p.map((x) => x.name), note: 'never weaken protection on your own' }, tier: 'T3' }] : [];
  },
  'WPB-23': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.maxChildren > 150 && /menu|nav/i.test(p.evidence.document.maxChildrenSelector ?? ''));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { menu: hits[0]!.evidence.document.maxChildrenSelector, items: hits[0]!.evidence.document.maxChildren }, tier: 'T3' }] : [];
  },
  'WPB-24': (ctx) => {
    const woo = ctx.wp?.plugins.some((p) => p.name === 'woocommerce' && p.status === 'active');
    const qc = Math.max(0, ...(ctx.wp?.perUrl ?? []).map((u) => u.diag?.query_count ?? 0));
    return woo && ctx.wp?.environment && !ctx.wp.environment.object_cache && qc > 100 ? [{ urls: [ctx.cfg.productionUrl], evidence: { queriesPerRequest: qc, objectCache: false, note: 'a hosting option; never install a cache plugin (rule 3)' }, tier: 'T3' }] : [];
  },
  'WPB-25': (ctx) => {
    const lines = (ctx.wp?.debugLogTail ?? []).filter((l) => /PHP (Warning|Notice|Deprecated)/.test(l));
    const notices = uniquePages(ctx).flatMap((p) => p.evidence.errors.phpNotices);
    return lines.length > 10 || notices.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { debugLogWarnings: lines.length, inHtml: notices.slice(0, 5), sample: lines.slice(-5) } }] : [];
  },
  'WPB-26': (ctx) => {
    const slow = (ctx.wp?.adminTimings ?? []).filter((a) => a.ms > 2000);
    return slow.length ? [{ urls: slow.map((s) => s.page), evidence: { pages: slow } }] : [];
  },
  'WPB-27': (ctx) => {
    const orders = (ctx.wp?.database.tables ?? []).find((t) => /wc_orders$/.test(t.name));
    const hpos = String(ctx.wp?.builder.woocommerce_custom_orders_table_enabled ?? '').includes('yes');
    const postsOrders = (ctx.wp?.database.tables ?? []).find((t) => /_posts$/.test(t.name));
    return ctx.wp?.plugins.some((p) => p.name === 'woocommerce' && p.status === 'active') && !hpos && (postsOrders?.rows ?? 0) > 50000 && !orders?.rows ? [{ urls: [ctx.cfg.productionUrl], evidence: { hpos: false }, tier: 'T3' }] : [];
  },
  'WPB-29': (ctx) => (ctx.wp?.environment?.multisite ? [{ urls: [ctx.cfg.productionUrl], evidence: { multisite: true } }] : []),
  'WPB-30': (ctx) => {
    const noCache = (ctx.wp?.perUrl ?? []).every((u) => !Object.keys(u.cacheHeaders).some((k) => /cache/.test(k) && k !== 'cache-control'));
    const slow = (ctx.wp?.perUrl ?? []).some((u) => (u.ttfbBypassMs ?? 0) > 500);
    return !ctx.cfg.local && noCache && slow ? [{ urls: [ctx.cfg.productionUrl], evidence: { note: 'without page caching every visit runs PHP; peak traffic risk', uncachedTtfb: (ctx.wp?.perUrl ?? []).map((u) => u.ttfbBypassMs) }, tier: 'T3' }] : [];
  },
  'WPB-31': (ctx) => {
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && /^redirection$|safe-redirect-manager|301-redirects|simple-301-redirects/.test(x.name));
    return p.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: p.map((x) => x.name), note: 'count rules and move permanent ones to the server' } }] : [];
  },

  'WPF-01': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /wp-emoji-release|wp-emoji/.test(r.url)) || handles(ctx).some((h) => h.url === p.url && h.scripts.some((s) => /emoji/.test(s.handle))));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { emoji: true }, gain: { tbtMs: 10, bytes: 5 * 1024 }, rootCause: 'core:wordpress' }] : [];
  },
  'WPF-02': (ctx) => {
    const embed = handles(ctx).filter((h) => h.scripts.some((s) => s.handle === 'wp-embed'));
    const links = uniquePages(ctx).filter((p) => (p.evidence.document.oembedLinks ?? 0) > 0);
    return embed.length || links.length ? [{ urls: [...new Set([...embed.map((h) => h.url), ...links.map((p) => p.url)])], evidence: { wpEmbedScript: embed.length > 0, oembedDiscoveryLinks: links.length }, gain: { bytes: 2 * 1024 }, rootCause: 'core:wordpress' }] : [];
  },
  'WPF-03': (ctx) => {
    const d = handles(ctx).filter((h) => h.styles.some((s) => s.handle === 'dashicons'));
    return d.length ? [{ urls: d.map((h) => h.url), evidence: { dashicons: true }, gain: { bytes: 35 * 1024, lcpMs: 50 } }] : [];
  },
  'WPF-04': (ctx) => {
    const d = handles(ctx).filter((h) => h.styles.some((s) => s.handle === 'wp-block-library'));
    const cov = ctx.audit.pages.flatMap((p) => p.evidence.coverage.filter((c) => /block-library/.test(c.url) && c.usedBytes / Math.max(1, c.totalBytes) < 0.05).map(() => p.url));
    return d.length && cov.length ? [{ urls: [...new Set(cov)], evidence: { handle: 'wp-block-library' }, gain: { bytes: 15 * 1024 } }] : [];
  },
  'WPF-05': (ctx) => {
    const d = handles(ctx).filter((h) => h.styles.some((s) => s.handle === 'global-styles' || s.handle === 'classic-theme-styles'));
    return d.length ? [{ urls: d.map((h) => h.url), evidence: { handles: ['global-styles', 'classic-theme-styles'], note: 'keep unless proven unused on every template (high visual risk)' } }] : [];
  },
  'WPF-06': (ctx) => assetsEverywhere(ctx, /^contact-form-7$|^wpcf7-/, (t, url) => t === 'contact' || hasForm(ctx, url, 'contact-form-7'), 'plugin:contact-form-7'),
  'WPF-07': (ctx) => assetsEverywhere(ctx, /^(woocommerce-(general|layout|smallscreen)|wc-blocks-style|wc-cart-fragments|wc-add-to-cart|woocommerce|wc-order-attribution|sourcebuster-js)$/, (t) => ['shop', 'product', 'collection', 'cart', 'checkout', 'account'].includes(t), 'plugin:woocommerce'),
  'WPF-08': (ctx) => {
    const active = ctx.wp?.plugins.some((p) => p.name === 'elementor' && p.status === 'active');
    if (!active) return [];
    const opts = Object.fromEntries(Object.entries(ctx.wp!.builder).filter(([k]) => k.startsWith('elementor_')));
    return [{ urls: handles(ctx).filter((h) => h.scripts.some((s) => /elementor/.test(s.handle))).map((h) => h.url), evidence: { options: opts, note: 'turn features on one at a time; leave Element Caching as it is (rule 3)' }, rootCause: 'plugin:elementor' }];
  },
  'WPF-09': (ctx) => (ctx.wp?.themes.some((t) => /^divi$/i.test(t.name) && t.status !== 'inactive') ? [{ urls: [ctx.cfg.productionUrl], evidence: { et_divi: ctx.wp.builder.et_divi ? 'read' : 'not readable' } }] : []),
  'WPF-10': (ctx) => {
    const re = /^(js_composer|beaver-builder-lite-version|bb-plugin|bricks|oxygen|fusion-builder|astra-addon|gp-premium|kadence-blocks)$/;
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && re.test(x.name));
    const t = (ctx.wp?.themes ?? []).filter((x) => x.status !== 'inactive' && /^(avada|astra|generatepress|kadence|bricks)$/i.test(x.name));
    return p.length || t.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: p.map((x) => x.name), themes: t.map((x) => x.name), note: 'use their built-in performance options first' } }] : [];
  },
  'WPF-11': (ctx) => assetsEverywhere(ctx, /^(smartslider|smartslider-frontend|n2-ss-|revmin|rs-plugin-settings|tp-tools|revbuilder|layerslider|ls-)/, (t, url) => ctx.audit.pages.some((p) => p.url === url && p.evidence.images.some((i) => /n2-ss|rev_slider|ls-slide|rs-slide/.test(i.selector))), 'slider'),
  'WPF-12': (ctx) => {
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && /essential-addons|elementskit|happy-elementor-addons|ultimate-elementor|premium-addons|jetelements|the-plus-addons/.test(x.name));
    return p.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { addons: p.map((x) => x.name), note: 'switch off unused widgets after a usage scan' } }] : [];
  },
  'WPF-13': (ctx) => {
    const rows = handles(ctx).flatMap((h) => [...h.scripts, ...h.styles].filter((s) => s.owner.startsWith('plugin:') && !/woocommerce|contact-form-7|smart-slider|elementor/.test(s.owner)).map((s) => ({ url: h.url, handle: s.handle, owner: s.owner })));
    const cov = ctx.audit.pages.flatMap((p) => p.evidence.coverage.filter((c) => c.owner.kind === 'plugin' && c.totalBytes > 3000 && c.usedBytes / c.totalBytes < 0.1).map((c) => ({ url: p.url, file: c.url, owner: c.owner.id })));
    const flagged = cov.filter((c) => rows.some((r) => r.owner === c.owner) || true);
    return flagged.length ? [{ urls: [...new Set(flagged.map((f) => f.url))], evidence: { mostlyUnused: [...new Map(flagged.map((f) => [f.file, f])).values()].slice(0, 15), note: 'load only where used, after a usage scan of all content (SAFE-05)' } }] : [];
  },
  'WPF-14': (ctx) => {
    const p = ctx.audit.pages.filter((x) => x.evidence.document.speculationRules.inline > 0 || x.evidence.document.speculationRules.header);
    return [{ urls: [ctx.cfg.productionUrl], evidence: { rulesPresent: p.length > 0, note: 'check exclusions for cart, checkout, account, logout and add-to-cart; stay conservative without page caching (WPB-30)' } }];
  },
  'WPF-15': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.lcp?.isImage && p.evidence.lcp.lazy);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { lcp: hits.map((p) => p.evidence.lcp!.selector) }, gain: { lcpMs: Math.round(Math.max(...hits.map((p) => p.evidence.lcp!.phases?.loadDelay ?? 0)) * 0.8) }, rootCause: 'lcp-image' }] : [];
  },
  'WPF-16': (ctx) => (ctx.wp?.environment?.script_debug ? [{ urls: [ctx.cfg.productionUrl], evidence: { SCRIPT_DEBUG: true } }] : []),
  'WPF-17': (ctx) => {
    const d = handles(ctx).filter((h) => h.styles.filter((s) => /\/themes\/[^/]+\/style\.css/.test(s.src ?? '')).length > 1);
    return d.length ? [{ urls: d.map((h) => h.url), evidence: { styles: d[0]!.styles.filter((s) => /style\.css/.test(s.src ?? '')).map((s) => s.src) } }] : [];
  },
  'WPF-18': (ctx) => {
    const p = (ctx.wp?.plugins ?? []).filter((x) => x.status === 'active' && /sitepress-multilingual-cms|polylang|translatepress|weglot|gtranslate/.test(x.name));
    return p.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: p.map((x) => x.name) } }] : [];
  },
  'WPF-19': (ctx) => {
    const re = /optinmonster|popup-maker|elementor-pro.*popup|convertpro|hustle|sumo/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { tools: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => hostOf(r.url))))] } }] : [];
  },
  'WPF-20': (ctx) => (ctx.wp?.existingOptimizers.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { plugins: ctx.wp.existingOptimizers, note: 'left as they are; overlapping SpeedPilot modules stay off' } }] : []),
  'WPF-21': (ctx) => {
    const byTemplate = byKey(mobile(ctx).filter((p) => p.evidence.lcp), (p) => p.template);
    const desktop = ctx.audit.pages.filter((p) => p.device === 'desktop' && p.evidence.lcp);
    const differs = mobile(ctx).some((m) => {
      const d = desktop.find((x) => x.url === m.url);
      return d && m.evidence.lcp && d.evidence.lcp && m.evidence.lcp.selector !== d.evidence.lcp.selector;
    });
    return differs ? [{ urls: [...byTemplate.values()].flat().map((p) => p.url), evidence: { note: 'LCP element differs between mobile and desktop; Image Prioritizer can tune it from real-visitor data (not a cache plugin)' } }] : [];
  },
};

// ---------------------------------------------------------------- Shopify
function tc(ctx: EvalContext, check: string) {
  return (ctx.shopify?.themeCheck ?? []).filter((o) => o.check === check);
}

export const shopifyEvaluators: Record<string, Evaluator> = {
  'SHT-01': (ctx) => (ctx.shopify && !ctx.shopify.theme.os2 ? [{ urls: [ctx.cfg.productionUrl], evidence: { theme: ctx.shopify.theme.name, version: ctx.shopify.theme.version, os2: false }, tier: 'T3' }] : []),
  'SHT-02': (ctx) => {
    const o = tc(ctx, 'ParserBlockingScript');
    const blocking = mobile(ctx).flatMap((p) => p.evidence.document.headBlocking.filter((h) => h.tag === 'script' && h.url && sameOrigin(h.url, p.url)).map((h) => h.url!));
    return o.length || blocking.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { themeCheck: o.map((x) => `${x.file}: ${x.message}`), scripts: [...new Set(blocking)] }, gain: { lcpMs: 300 } }] : [];
  },
  'SHT-03': (ctx) => {
    const files = (ctx.shopify?.theme.files ?? []).filter((f) => /jquery/i.test(f.path) && f.path.startsWith('assets/'));
    const reqs = uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => /jquery/i.test(r.url) && r.owner.kind === 'theme'));
    return files.length || reqs.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { files: files.map((f) => f.path), requests: reqs.map((r) => r.url).slice(0, 3) } }] : [];
  },
  'SHT-04': (ctx) => {
    const o = tc(ctx, 'AssetSizeJavaScript');
    const big = (ctx.shopify?.theme.files ?? []).filter((f) => /^assets\/.*\.js$/.test(f.path) && f.bytes > 100 * 1024);
    return o.length || big.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { files: big.map((f) => ({ path: f.path, kb: kb(f.bytes) })), themeCheck: o.length } }] : [];
  },
  'SHT-05': (ctx) => {
    const o = tc(ctx, 'AssetSizeCSS');
    const big = (ctx.shopify?.theme.files ?? []).filter((f) => /^assets\/.*\.css$/.test(f.path) && f.bytes > 100 * 1024);
    return o.length || big.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { files: big.map((f) => ({ path: f.path, kb: kb(f.bytes) })) } }] : [];
  },
  'SHT-06': (ctx) => {
    const o = [...tc(ctx, 'DeprecatedFilter').filter((x) => /img_url/.test(x.message)), ...tc(ctx, 'ImgWidthAndHeight'), ...tc(ctx, 'ImgLazyLoading')];
    return o.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { themeCheck: o.map((x) => `${x.check} ${x.file}: ${x.message}`) }, gain: { cls: 0.05, bytes: 100 * 1024 } }] : [];
  },
  'SHT-07': (ctx) => {
    const hits = mobile(ctx).filter((p) => p.evidence.lcp?.isImage && (p.evidence.lcp.lazy || p.evidence.lcp.fetchpriority !== 'high'));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { lcp: hits.map((p) => ({ url: p.url, src: p.evidence.lcp!.url, lazy: p.evidence.lcp!.lazy, fetchpriority: p.evidence.lcp!.fetchpriority, phases: p.evidence.lcp!.phases })) }, gain: { lcpMs: Math.round(Math.max(...hits.map((p) => p.evidence.lcp!.phases?.loadDelay ?? 0)) * 0.8) }, rootCause: 'lcp-image' }] : [];
  },
  'SHT-08': (ctx) => {
    const ext = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /fonts\.(googleapis|gstatic)\.com|typekit/.test(r.url)));
    return ext.length ? [{ urls: ext.map((p) => p.url), evidence: { external: true, note: 'use font_face with font_display: swap from the Shopify font library or theme assets' }, gain: { lcpMs: 200 }, rootCause: 'fonts' }] : [];
  },
  'SHT-09': (ctx) => {
    const rows = (ctx.shopify?.profile ?? []).flatMap((p) => p.hotSpots.filter((h) => h.ms > 5 && /sections|snippets|blocks/.test(h.file)).map((h) => ({ url: p.url, ...h })));
    return rows.length ? [{ urls: [...new Set(rows.map((r) => r.url))], evidence: { hotSpots: rows.slice(0, 10) }, gain: { ttfbMs: Math.round(Math.max(...rows.map((r) => r.ms))) }, rootCause: rows[0]!.file }] : [];
  },
  'SHT-10': (ctx) => {
    const home = ctx.shopify?.sectionsPerTemplate.index ?? [];
    return home.length >= 15 ? [{ urls: [ctx.cfg.productionUrl], evidence: { sections: home.length }, tier: 'T3' }] : [];
  },
  'SHT-11': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.template === 'collection' && p.evidence.images.filter((i) => !i.aboveFold && i.loading !== 'lazy').length > 8);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { eagerCardImages: hits.map((p) => p.evidence.images.filter((i) => !i.aboveFold && i.loading !== 'lazy').length) } }] : [];
  },
  'SHT-12': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.template === 'product' && (p.evidence.images.filter((i) => i.loading === 'eager' || !i.loading).length > 3 || (p.evidence.document.largestInlineJson?.bytes ?? 0) > 50 * 1024));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { eagerMedia: hits.map((p) => p.evidence.images.filter((i) => i.loading !== 'lazy').length) }, gain: { bytes: 200 * 1024, lcpMs: 200 } }] : [];
  },
  'SHT-14': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /\/cart\.js(\?|$)|section_id=cart|sections=cart/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { cartRequestsOnLoad: true } }] : [];
  },
  'SHT-15': (ctx) => {
    const o = tc(ctx, 'RemoteAsset');
    return o.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { themeCheck: o.map((x) => `${x.file}: ${x.message}`) } }] : [];
  },
  'SHT-16': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.document.preloads.length > 2);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { preloads: hits[0]!.evidence.document.preloads.map((l) => l.href) } }] : [];
  },
  'SHT-17': (ctx) => (ctx.cfg.platform === 'shopify' ? frontEvaluators_css10(ctx) : []),
  'SHT-18': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.errors.liquidErrors.length);
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { errors: hits.flatMap((p) => p.evidence.errors.liquidErrors).slice(0, 10) } }] : [];
  },
  'SHT-19': (ctx) => [{ urls: [ctx.cfg.productionUrl], evidence: { platformHeader: ctx.shopify?.speculationRulesHeader ?? null, themeRules: ctx.audit.pages.some((p) => p.evidence.document.speculationRules.inline > 0), note: 'add theme rules only where they add value, with strict exclusions (SPEC 8.2)' } }],
  'FONT-09': (ctx) => {
    if (!ctx.shopify) return [];
    const files = (ctx.shopify.theme.files ?? []).filter((f) => /^(layout|sections|snippets|blocks)\//.test(f.path));
    const hits: string[] = [];
    for (const f of files) {
      try {
        const t = readFileSync(join(ctx.shopify.themeDir, f.path), 'utf8');
        if (/fonts\.googleapis\.com|use\.typekit\.net/.test(t) || (/\|\s*font_face\b/.test(t) && !/font_display/.test(t))) hits.push(f.path);
      } catch {
        /* unreadable */
      }
    }
    return hits.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { files: hits }, gain: { lcpMs: 150 }, rootCause: 'fonts' }] : [];
  },
  'SHT-21': (ctx) => {
    if (!ctx.shopify) return [];
    const deep = depthOfBlocks(ctx.shopify.themeDir);
    return deep.max > 2 ? [{ urls: [ctx.cfg.productionUrl], evidence: { maxNesting: deep.max, template: deep.template } }] : [];
  },

  'SHA-01': (ctx) => {
    const rows = mobile(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.owner.kind === 'app').map((r) => ({ page: p.url, ...r })));
    if (!rows.length && !(ctx.shopify?.apps.length)) return [];
    const table = [...byKey(rows, (r) => r.owner.id).entries()].map(([app, rs]) => ({ app, requests: rs.length, kb: kb(rs.reduce((a, r) => a + r.transferBytes, 0)), mainThreadMs: Math.round(mobile(ctx).reduce((a, p) => a + p.evidence.loaf.flatMap((f) => f.scripts).filter((s) => s.owner.id === app).reduce((x, s) => x + s.duration, 0), 0)), pages: new Set(rs.map((r) => r.page)).size }));
    return [{ urls: [ctx.cfg.productionUrl], evidence: { table } }];
  },
  'SHA-02': (ctx) => {
    const l = (ctx.shopify?.leftovers ?? []).filter((x) => x.file.startsWith('config/settings_data.json'));
    return l.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { embeds: l }, tier: 'T3' }] : [];
  },
  'SHA-03': (ctx) => {
    const l = (ctx.shopify?.leftovers ?? []).filter((x) => x.file.startsWith('snippets/'));
    return l.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { leftovers: l }, gain: { bytes: 5 * 1024 }, rootCause: `app:${l[0]!.app}` }] : [];
  },
  'SHA-04': (ctx) => {
    const apps = new Set(uniquePages(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.owner.kind === 'app').map((r) => r.owner.id)));
    const reviews = [...apps].filter((a) => /judge|yotpo|loox|stamped|okendo|reviews/.test(a));
    return reviews.length > 1 ? [{ urls: [ctx.cfg.productionUrl], evidence: { overlapping: reviews }, tier: 'T3' }] : [];
  },
  'SHA-05': (ctx) => frontEvaluators_cls07(ctx),
  'SHA-06': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => /pagefly|gempages|shogun|zipify/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { builders: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => /pagefly|gempages|shogun|zipify/.test(r.url)).map((r) => hostOf(r.url))))] }, tier: 'T3' }] : [];
  },
  'SHA-07': (ctx) => frontEvaluators_3p03(ctx),
  'SHA-08': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.template === 'product' && p.evidence.requests.some((r) => /shopify_pay|shop\.app|paypal|applepay|dynamic-checkout/.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { note: 'keep them; report the cost' } }] : [];
  },
  'SHA-09': (ctx) => {
    const rows = mobile(ctx).flatMap((p) => p.evidence.requests.filter((r) => r.owner.id === 'platform:shopify'));
    if (!rows.length) return [];
    const ms = mobile(ctx).reduce((a, p) => a + p.evidence.loaf.flatMap((f) => f.scripts).filter((s) => s.owner.id === 'platform:shopify').reduce((x, s) => x + s.duration, 0), 0) / Math.max(1, mobile(ctx).length);
    return [{ urls: [ctx.cfg.productionUrl], evidence: { requests: rows.length, kb: kb(rows.reduce((a, r) => a + r.transferBytes, 0)), mainThreadMs: Math.round(ms), note: 'injected through content_for_header; never touched; part of the ceiling' } }];
  },
  'SHA-10': (ctx) => {
    const re = /geolocation|geoip|ipinfo|redirect.*country|country-?redirect|shopify-geolocation/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { requests: hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => r.url)).slice(0, 5) }, tier: 'T3' }] : [];
  },
  'SHA-11': (ctx) => {
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => r.owner.kind === 'app' && r.initiator?.type === 'script' && /asyncLoad|shop\.js/.test((r.initiator.stack ?? []).join(' '))));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { scriptTagApps: true }, tier: 'T3' }] : [];
  },
  'SHA-12': (ctx) => frontEvaluators_3p04(ctx),
  'SHA-13': (ctx) => {
    const re = /instant\.page|quicklink|flying-pages|booster|speed-?(boost|optimizer)|lazy-?load.*app|hyperspeed|avada.*speed/i;
    const hits = uniquePages(ctx).filter((p) => p.evidence.requests.some((r) => re.test(r.url)));
    return hits.length ? [{ urls: hits.map((p) => p.url), evidence: { apps: [...new Set(hits.flatMap((p) => p.evidence.requests.filter((r) => re.test(r.url)).map((r) => r.url)))].slice(0, 5), note: 'left as they are; overlapping SpeedPilot changes stay off' } }] : [];
  },
};

// late-bound helpers to reuse front evaluators without a circular import at module init
import { frontEvaluators } from './evalFront.js';
const frontEvaluators_css10 = (ctx: EvalContext) => frontEvaluators['CSS-10']!(ctx);
const frontEvaluators_cls07 = (ctx: EvalContext) => frontEvaluators['CLS-07']!(ctx);
const frontEvaluators_3p03 = (ctx: EvalContext) => frontEvaluators['3P-03']!(ctx);
const frontEvaluators_3p04 = (ctx: EvalContext) => frontEvaluators['3P-04']!(ctx);

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
function depthOfBlocks(themeDir: string): { max: number; template: string | null } {
  let max = 0;
  let template: string | null = null;
  const dir = join(themeDir, 'templates');
  if (!existsSync(dir)) return { max, template };
  const walk = (blocks: Record<string, { blocks?: Record<string, unknown> }> | undefined, d: number, t: string) => {
    for (const b of Object.values(blocks ?? {})) {
      if (d > max) {
        max = d;
        template = t;
      }
      walk(b.blocks as Record<string, { blocks?: Record<string, unknown> }> | undefined, d + 1, t);
    }
  };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sections?: Record<string, { blocks?: Record<string, { blocks?: Record<string, unknown> }> }> };
      for (const s of Object.values(j.sections ?? {})) walk(s.blocks, 1, f);
    } catch {
      /* not JSON */
    }
  }
  return { max, template };
}

// ---------------------------------------------------------------- REV (X-ray)
export const revEvaluators: Record<string, Evaluator> = {
  'REV-01': (ctx) => {
    const u = (ctx.xray?.verdicts ?? []).filter((v) => v.verdict === 'unknown');
    const targets = [...new Set(u.map((v) => v.target))];
    return targets.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { unknownScripts: targets.slice(0, 20), note: 'left untouched; recipe drafts written for human review' } }] : [];
  },
  'REV-02': (ctx) => {
    const rows = ctx.xray?.earlyUnused ?? [];
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { resources: rows.slice(0, 15) }, gain: { bytes: rows.reduce((a, r) => a + r.bytes, 0), lcpMs: 200 } }] : [];
  },
  'REV-03': (ctx) => {
    const rows = ctx.xray?.lateNeeded ?? [];
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { resources: rows.slice(0, 10) }, gain: { lcpMs: Math.max(...rows.map((r) => r.delayMs)) } }] : [];
  },
  'REV-04': (ctx) => {
    const rows = ctx.xray?.recipeMismatches ?? [];
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { mismatches: rows } }] : [];
  },
  'REV-05': (ctx) => {
    const rows = (ctx.xray?.heavyWidgets ?? []).filter((w) => w.mainThreadMs > 100 || w.bytes > 100 * 1024);
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { widgets: rows }, tier: 'T3' }] : [];
  },
  'REV-06': (ctx) => {
    const comp = ctx.xray?.competitors ?? [];
    const origin = ctx.audit.field.find((f) => f.scope === 'origin' && f.formFactor === 'PHONE' && f.status === 'ok');
    const mine = origin?.metrics.lcp;
    if (!comp.length || mine === undefined) return [];
    const better = comp.filter((c) => c.lcp !== undefined && c.lcp < mine * 0.8);
    return better.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { clientLcp: mine, fasterCompetitors: better } }] : [];
  },
  'REV-07': (ctx) => {
    const rows = (ctx.xray?.slowHandlers ?? []).filter((h) => h.ms > 100);
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { handlers: rows }, gain: { inpMs: Math.max(...rows.map((r) => r.ms)) - 100 }, rootCause: rows[0]!.owner }] : [];
  },
  'REV-08': (ctx) => {
    const rows = (ctx.xray?.simulations ?? []).filter((s) => !s.ok || (s.gainMs !== null && s.gainMs < 20));
    return rows.length ? [{ urls: [ctx.cfg.productionUrl], evidence: { simulations: rows } }] : [];
  },
};
