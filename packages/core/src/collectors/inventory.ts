import * as cheerio from 'cheerio';
import { RateLimiter } from '../util/exec.js';

export type Template =
  | 'home'
  | 'page'
  | 'post'
  | 'archive'
  | 'product'
  | 'collection'
  | 'cart'
  | 'checkout'
  | 'search'
  | 'account'
  | '404'
  | 'landing'
  | 'contact'
  | 'shop'
  | 'blog';

export interface InventoryUrl {
  url: string;
  template: Template;
  source: 'sitemap' | 'link' | 'config' | 'flow' | 'synthetic';
  traffic?: number;
}

export interface Inventory {
  robots?: string;
  sitemaps: string[];
  urls: InventoryUrl[];
  sample: InventoryUrl[];
  variants: { languages: string[]; currencies: string[]; consentTool?: string };
}

export interface InventoryDeps {
  fetch?: typeof fetch;
  limiter?: RateLimiter;
  maxSitemapUrls?: number;
}

/** Classifies a URL into a template type (SPEC.md 3.1). */
export function classify(url: string, platform: 'wordpress' | 'shopify', homeUrl?: string): Template {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (homeUrl && (new URL(homeUrl).pathname.replace(/\/+$/, '') || '/') === p && !u.search) return 'home';
  if (u.searchParams.has('s') || u.searchParams.has('q') || /\/search\b/.test(p)) return 'search';
  if (p === '/' || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(p)) return 'home';
  if (/\/(cart|basket|warenkorb)\b/.test(p)) return 'cart';
  if (/\/(checkout|checkouts)\b/.test(p)) return 'checkout';
  if (/\/(my-account|account|login|wp-login\.php|register)\b/.test(p)) return 'account';
  if (/\/contact\b/.test(p)) return 'contact';
  if (platform === 'shopify') {
    if (/\/products\/[^/]+$/.test(p)) return 'product';
    if (/\/collections\/[^/]+$/.test(p) || p === '/collections') return 'collection';
    if (/\/blogs\/[^/]+\/[^/]+$/.test(p)) return 'post';
    if (/\/blogs\/[^/]+$/.test(p)) return 'blog';
    if (/\/pages\//.test(p)) return 'page';
    return 'page';
  }
  if (/\/product\/[^/]+$/.test(p)) return 'product';
  if (/\/(product-category|product-tag)\//.test(p)) return 'collection';
  if (p === '/shop') return 'shop';
  if (/\/(category|tag|author|\d{4})\//.test(p) || /\/page\/\d+$/.test(p)) return 'archive';
  if (/\/blog$/.test(p) || /\/news$/.test(p)) return 'blog';
  if (/\/(lp|landing|go)\//.test(p)) return 'landing';
  return p.split('/').filter(Boolean).length >= 1 ? 'page' : 'home';
}

async function get(url: string, d: Required<InventoryDeps>): Promise<{ status: number; text: string } | undefined> {
  await d.limiter.wait();
  try {
    const r = await d.fetch(url, { headers: { 'User-Agent': 'SpeedPilot-Inventory/0.1 (+site owner authorized)' }, redirect: 'follow' });
    return { status: r.status, text: await r.text() };
  } catch {
    return undefined;
  }
}

/** Reads robots.txt and every sitemap (index-aware, bounded). */
export async function readSitemaps(origin: string, deps: InventoryDeps = {}): Promise<{ robots?: string; sitemaps: string[]; urls: string[] }> {
  const d: Required<InventoryDeps> = { fetch: deps.fetch ?? fetch, limiter: deps.limiter ?? new RateLimiter(1000), maxSitemapUrls: deps.maxSitemapUrls ?? 5000 };
  const robots = await get(new URL('/robots.txt', origin).href, d);
  const declared = robots?.status === 200 ? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!) : [];
  const queue = declared.length ? declared : [new URL('/wp-sitemap.xml', origin).href, new URL('/sitemap.xml', origin).href, new URL('/sitemap_index.xml', origin).href];
  const seen = new Set<string>();
  const sitemaps: string[] = [];
  const urls = new Set<string>();
  while (queue.length && urls.size < d.maxSitemapUrls && seen.size < 50) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await get(sm, d);
    if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/.test(r.text)) continue;
    sitemaps.push(sm);
    const $ = cheerio.load(r.text, { xmlMode: true });
    $('sitemap > loc').each((_, el) => {
      queue.push($(el).text().trim());
    });
    $('url > loc').each((_, el) => {
      if (urls.size < d.maxSitemapUrls) urls.add($(el).text().trim());
    });
  }
  return { robots: robots?.status === 200 ? robots.text : undefined, sitemaps, urls: [...urls] };
}

/** Internal links from a page, same origin only, ranked by frequency (traffic proxy when GA4/GSC are absent). */
export function internalLinks(html: string, base: string): Array<{ url: string; count: number }> {
  const $ = cheerio.load(html);
  const origin = new URL(base).origin;
  const counts = new Map<string, number>();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, base);
      if (u.origin !== origin) return;
      u.hash = '';
      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip)$/i.test(u.pathname)) return;
      if (/[?&](add-to-cart|remove_item|_wpnonce|action=logout)/.test(u.search) || /logout/.test(u.pathname)) return;
      counts.set(u.href, (counts.get(u.href) ?? 0) + 1);
    } catch {}
  });
  return [...counts.entries()].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count);
}

/**
 * Picks the sample set (SPEC.md 3.1): home, top pages by traffic (or internal links), one URL for every other
 * template, and every URL that carries a business flow. Default 12.
 */
export function pickSample(all: InventoryUrl[], size: number, flowUrls: string[] = []): InventoryUrl[] {
  const out: InventoryUrl[] = [];
  const add = (u: InventoryUrl | undefined) => {
    if (u && !out.some((o) => o.url === u.url) && u.template !== 'checkout') out.push(u);
  };
  add(all.find((u) => u.template === 'home'));
  for (const f of flowUrls) add(all.find((u) => u.url === f) ?? { url: f, template: 'page', source: 'flow' });
  const ranked = [...all].sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0));
  for (const u of ranked.filter((x) => x.template !== 'home').slice(0, 5)) add(u);
  const templates = [...new Set(all.map((u) => u.template))];
  for (const t of templates) if (!out.some((o) => o.template === t)) add(all.find((u) => u.template === t));
  return out.slice(0, Math.max(size, out.filter((o) => o.source === 'flow').length + 1));
}

/** Detects page variants: languages (hreflang), currencies, consent tool (SPEC.md 3.1). */
export function detectVariants(html: string): Inventory['variants'] {
  const $ = cheerio.load(html);
  const languages = [...new Set($('link[rel="alternate"][hreflang]').map((_, el) => $(el).attr('hreflang')!).get())];
  const currencies = [...new Set($('select[name="currency"] option, [data-currency]').map((_, el) => $(el).attr('value') ?? $(el).attr('data-currency') ?? '').get().filter(Boolean))];
  const text = $.html();
  const tools: Array<[RegExp, string]> = [
    [/cookiebot/i, 'Cookiebot'],
    [/onetrust|optanon/i, 'OneTrust'],
    [/complianz/i, 'Complianz'],
    [/cookieyes|cky-consent/i, 'CookieYes'],
    [/iubenda/i, 'iubenda'],
    [/usercentrics/i, 'Usercentrics'],
    [/borlabs/i, 'Borlabs Cookie'],
    [/cookie-law-info|cookielawinfo/i, 'CookieYes (GDPR Cookie Consent)'],
    [/shopify.*customerPrivacy|privacy-banner/i, 'Shopify Customer Privacy'],
  ];
  const consentTool = tools.find(([re]) => re.test(text))?.[1];
  return { languages, currencies, consentTool };
}

/** Builds the inventory and the sample. */
export async function buildInventory(opts: { homeUrl: string; platform: 'wordpress' | 'shopify'; sampleUrls?: string[]; sampleSize?: number; flowUrls?: string[]; traffic?: Record<string, number> }, deps: InventoryDeps = {}): Promise<Inventory> {
  const d: Required<InventoryDeps> = { fetch: deps.fetch ?? fetch, limiter: deps.limiter ?? new RateLimiter(1000), maxSitemapUrls: deps.maxSitemapUrls ?? 5000 };
  const origin = new URL(opts.homeUrl).origin;
  const { robots, sitemaps, urls } = await readSitemaps(origin, d);
  const home = await get(opts.homeUrl, d);
  const linkRanks = home ? internalLinks(home.text, opts.homeUrl) : [];
  const all = new Map<string, InventoryUrl>();
  const put = (url: string, source: InventoryUrl['source']) => {
    if (!all.has(url)) all.set(url, { url, template: classify(url, opts.platform, opts.homeUrl), source, traffic: opts.traffic?.[url] ?? linkRanks.find((l) => l.url === url)?.count ?? 0 });
  };
  put(opts.homeUrl, 'config');
  for (const u of urls) put(u, 'sitemap');
  for (const l of linkRanks) put(l.url, 'link');
  let sample: InventoryUrl[];
  if (opts.sampleUrls?.length) {
    for (const u of opts.sampleUrls) put(u, 'config');
    sample = opts.sampleUrls.map((u) => all.get(u)!);
  } else sample = pickSample([...all.values()], opts.sampleSize ?? 12, opts.flowUrls);
  return { robots, sitemaps, urls: [...all.values()], sample, variants: home ? detectVariants(home.text) : { languages: [], currencies: [] } };
}
