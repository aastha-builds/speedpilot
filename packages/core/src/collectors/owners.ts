import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tpw = require('third-party-web') as {
  getEntity(url: string): { name: string; category: string; categories: string[] } | undefined;
  getProduct(url: string): { name: string } | undefined;
};

export type OwnerKind = 'theme' | 'plugin' | 'mu-plugin' | 'core' | 'app' | 'platform' | 'third-party' | 'first-party' | 'media' | 'unknown';

export interface Owner {
  /** Stable owner ID, for example `plugin:contact-form-7`, `app:judge-me`, `third-party:google-tag-manager`. */
  id: string;
  kind: OwnerKind;
  name: string;
  category?: string;
  /** How the owner was found. */
  via: 'path' | 'handle-map' | 'site-config' | 'recipe' | 'third-party-web' | 'domain' | 'app-domain' | 'fallback';
}

export interface OwnerContext {
  siteOrigin: string;
  platform: 'wordpress' | 'shopify';
  /** From the WordPress agent: script/style src -> handle and owner. */
  handleMap?: Array<{ src: string; owner: string }>;
  /** Extra rules from site.yaml, recipes or truth files: substring -> owner ID. */
  rules?: Array<{ match: string; owner: string }>;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function kindOf(id: string): OwnerKind {
  const k = id.split(':')[0] as OwnerKind;
  return ['theme', 'plugin', 'mu-plugin', 'core', 'app', 'platform', 'third-party', 'first-party', 'media'].includes(k) ? k : 'unknown';
}

function fromId(id: string, via: Owner['via'], category?: string): Owner {
  return { id, kind: kindOf(id), name: id.split(':').slice(1).join(':') || id, via, category };
}

/** Known Shopify app CDN and script domains (SHA-01). Extend through recipes. */
export const SHOPIFY_APP_DOMAINS: Array<[RegExp, string]> = [
  [/judge\.me|judgeme/, 'app:judge-me'],
  [/klaviyo\.com/, 'app:klaviyo'],
  [/yotpo\.com/, 'app:yotpo'],
  [/loox\.io/, 'app:loox'],
  [/pagefly\.io/, 'app:pagefly'],
  [/gempages\.net|gem-page/, 'app:gempages'],
  [/tidio\.co/, 'app:tidio'],
  [/weglot\.com/, 'app:weglot'],
  [/rechargeapps\.com|rechargecdn/, 'app:recharge'],
  [/rebuyengine\.com/, 'app:rebuy'],
  [/vitals\.(app|co)/, 'app:vitals'],
  [/shopify-chat|inbox\.shopify|shopifyinbox/, 'app:shopify-inbox'],
  [/gorgias\.(chat|io)/, 'app:gorgias'],
  [/privy\.com/, 'app:privy'],
  [/omnisnippet|omnisend/, 'app:omnisend'],
];

/** Resolves the owner of a request URL (SPEC.md 3.6, 15.4). */
export function ownerOf(rawUrl: string, ctx: OwnerContext): Owner {
  let u: URL;
  try {
    u = new URL(rawUrl, ctx.siteOrigin);
  } catch {
    return fromId('unknown:unparseable', 'fallback');
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return fromId('first-party:inline', 'fallback');
  const full = u.href;
  for (const r of ctx.rules ?? []) if (full.includes(r.match)) return fromId(r.owner, 'site-config');
  const hm = ctx.handleMap?.find((h) => h.src && full.split('?')[0] === new URL(h.src, ctx.siteOrigin).href.split('?')[0]);
  if (hm) return fromId(hm.owner, 'handle-map');

  const site = new URL(ctx.siteOrigin);
  const sameSite = u.host === site.host;
  const path = u.pathname;

  if (ctx.platform === 'wordpress' && sameSite) {
    let m = /\/wp-content\/plugins\/([^/]+)\//.exec(path);
    if (m) return fromId(`plugin:${m[1]}`, 'path');
    m = /\/wp-content\/themes\/([^/]+)\//.exec(path);
    if (m) return fromId(`theme:${m[1]}`, 'path');
    if (/\/wp-content\/mu-plugins\//.test(path)) return fromId('mu-plugin:mu-plugins', 'path');
    if (/\/wp-content\/uploads\//.test(path)) {
      // builder-generated CSS lives in uploads (elementor/css, et-cache)
      m = /\/wp-content\/uploads\/(elementor|et-cache|oxygen|bricks|generateblocks|kadence|astra)\//.exec(path);
      if (m) return fromId(`plugin:${m[1] === 'et-cache' ? 'divi' : m[1]}`, 'path');
      return fromId('media:uploads', 'path');
    }
    if (/^\/wp-(includes|admin)\//.test(path) || /^\/wp-json\//.test(path) || path === '/wp-cron.php') return fromId('core:wordpress', 'path');
    return fromId('first-party:document', 'path');
  }

  if (ctx.platform === 'shopify') {
    const host = u.host;
    if (host === 'cdn.shopify.com' || sameSite) {
      let m = /\/extensions\/[0-9a-f-]+\/([a-z0-9-]+?)-\d/.exec(path);
      if (m) return fromId(`app:${m[1]}`, 'app-domain');
      if (/\/(shopifycloud|cdn\/shopifycloud|cdn\/wpm|wpm@|checkouts)\//.test(path) || /^\/(cdn\/)?shopifycloud\//.test(path)) return fromId('platform:shopify', 'path');
      if (/\/t\/\d+\/assets\//.test(path) || /^\/assets\//.test(path) || /^\/cdn\/img\//.test(path)) return fromId('theme:theme', 'path');
      if (/\/files\//.test(path)) return fromId('media:shop-files', 'path');
      m = /^\/apps\/([^/]+)/.exec(path);
      if (m) return fromId(`app:${m[1]}`, 'path');
      if (sameSite) return fromId('first-party:document', 'path');
      return fromId('platform:shopify', 'domain');
    }
    if (/(^|\.)shopify(svc|cdn)?\.com$|shop\.app$/.test(host)) return fromId('platform:shopify', 'domain');
    for (const [re, id] of SHOPIFY_APP_DOMAINS) if (re.test(host) || re.test(full)) return fromId(id, 'app-domain');
  }

  if (sameSite) return fromId('first-party:document', 'path');
  const ent = tpw.getEntity(full);
  if (ent) return fromId(`third-party:${slug(ent.name)}`, 'third-party-web', ent.category);
  return fromId(`third-party:${u.hostname}`, 'domain');
}

/** Groups byte totals per owner and reports the share attributed to a non-unknown owner. */
export function attributionCoverage(rows: Array<{ owner: Owner; bytes: number }>): { total: number; attributed: number; share: number } {
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  const attributed = rows.filter((r) => r.owner.kind !== 'unknown').reduce((a, r) => a + r.bytes, 0);
  return { total, attributed, share: total ? attributed / total : 1 };
}
