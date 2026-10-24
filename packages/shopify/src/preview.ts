/**
 * Local storefront preview for the Shopify fixture theme (and for X-ray what-if runs on a pulled theme copy).
 *
 * This is NOT Shopify. It renders a theme with liquidjs and mock store data so planted problems can be measured
 * and verified offline. Numbers from it are labelled "local preview"; real numbers come from the published theme.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Liquid, Tag, type TagToken, type Context, type TopLevelToken, type Emitter, type Template } from 'liquidjs';

export interface PreviewOptions {
  themeDir: string;
  port?: number;
  host?: string;
  /** Number of mock products (the planted loop iterates them). */
  products?: number;
  variantsPerProduct?: number;
  /** Optional storefront password page, like a password-protected dev store (MEAS-06). */
  password?: string;
}

export interface RenderProfileEntry {
  file: string;
  ms: number;
  calls: number;
}

export interface PreviewServer {
  url: string;
  server: Server;
  close(): Promise<void>;
  /** Liquid render profile of the last request, like `shopify theme profile` (SHT-09). */
  lastProfile(): RenderProfileEntry[];
  requests: Array<{ method: string; path: string }>;
}

type Dict = Record<string, unknown>;

const MIME: Record<string, string> = { '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp' };

function readJson<T = Dict>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as T;
  } catch {
    return fallback;
  }
}

function money(cents: unknown) {
  const n = Number(cents ?? 0) / 100;
  return `$${n.toFixed(2)}`;
}

function mockData(products: number, variants: number) {
  const list = Array.from({ length: products }, (_, i) => {
    const id = 1000 + i;
    const vs = Array.from({ length: variants }, (_, j) => ({ id: id * 100 + j, title: ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'][j % 8], price: 1000 + ((i * 37 + j * 11) % 9000), available: true }));
    const img = { src: `thumb-${(i % 6) + 1}.jpg`, alt: `Product ${i + 1}`, width: 1200, height: 800 };
    return {
      id,
      handle: `product-${i + 1}`,
      title: `Fixture product ${i + 1}`,
      url: `/products/product-${i + 1}`,
      price: vs[0]!.price,
      variants: vs,
      featured_image: img,
      media: [img, { ...img, src: `thumb-${((i + 1) % 6) + 1}.jpg` }],
      description: '<p>A fixture product used by SpeedPilot tests.</p>',
    };
  });
  return {
    products: list,
    collection: { title: 'All products', handle: 'all', products: list, products_count: list.length, url: '/collections/all' },
  };
}

class SchemaTag extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    while (remain.length) {
      const t = remain.shift()!;
      if ((t as TagToken).name === 'endschema') return;
    }
  }
  render() {
    return '';
  }
}

function rawBlockTag(name: string, wrap: (body: string) => string) {
  return class extends Tag {
    body = '';
    constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
      super(token, remain, liquid);
      while (remain.length) {
        const t = remain.shift()!;
        if ((t as TagToken).name === `end${name}`) return;
        this.body += t.getText();
      }
    }
    render() {
      return wrap(this.body);
    }
  };
}

/** Renders a theme with mock data. */
export class ThemeRenderer {
  readonly liquid: Liquid;
  readonly settings: Dict;
  private profile = new Map<string, { ms: number; calls: number }>();
  private readonly data: ReturnType<typeof mockData>;

  constructor(readonly themeDir: string, opts: { products?: number; variantsPerProduct?: number } = {}) {
    this.data = mockData(opts.products ?? 120, opts.variantsPerProduct ?? 6);
    const sd = readJson<{ current?: Dict }>(join(themeDir, 'config', 'settings_data.json'), {});
    this.settings = typeof sd.current === 'object' && sd.current ? sd.current : {};
    this.liquid = new Liquid({
      root: [join(themeDir, 'snippets'), join(themeDir, 'sections'), join(themeDir, 'blocks')],
      extname: '.liquid',
      cache: false,
      strictFilters: false,
      strictVariables: false,
      dynamicPartials: true,
    });
    this.registerFilters();
    this.registerTags();
  }

  private timed<T>(file: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const e = this.profile.get(file) ?? { ms: 0, calls: 0 };
      e.ms += performance.now() - t0;
      e.calls++;
      this.profile.set(file, e);
    }
  }

  takeProfile(): RenderProfileEntry[] {
    const out = [...this.profile.entries()].map(([file, v]) => ({ file, ms: Math.round(v.ms * 100) / 100, calls: v.calls })).sort((a, b) => b.ms - a.ms);
    this.profile.clear();
    return out;
  }

  private registerFilters() {
    const l = this.liquid;
    l.registerFilter('asset_url', (name: string) => `/assets/${name}?v=1`);
    l.registerFilter('stylesheet_tag', (url: string) => `<link href="${url}" rel="stylesheet" type="text/css" media="all" />`);
    l.registerFilter('script_tag', (url: string) => `<script src="${url}" type="text/javascript"></script>`);
    l.registerFilter('img_url', (img: unknown, size?: string) => {
      const src = typeof img === 'string' ? img : (img as Dict)?.src ?? 'hero.jpg';
      return `/cdn/img/${src}${size ? `?size=${size}` : ''}`;
    });
    l.registerFilter('image_url', (img: unknown, ...args: unknown[]) => {
      const src = typeof img === 'string' ? img : (img as Dict)?.src ?? 'hero.jpg';
      const opts = Object.fromEntries((args as Array<[string, unknown]>).filter(Array.isArray));
      const w = (opts.width as number) ?? '';
      return { __image: true, src: `/cdn/img/${src}`, width: w, img, toString: () => `/cdn/img/${src}${w ? `?width=${w}` : ''}` };
    });
    l.registerFilter('image_tag', (u: unknown, ...args: unknown[]) => {
      const opts = Object.fromEntries((args as Array<[string, unknown]>).filter(Array.isArray)) as Dict;
      const base = u as { src?: string; width?: number; img?: Dict } | string;
      const src = typeof base === 'string' ? base : base.src ?? '';
      const img = (typeof base === 'object' && base.img) || {};
      const widths = String(opts.widths ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const srcset = widths.map((w) => `${src}?width=${w} ${w}w`).join(', ');
      const attrs: string[] = [`src="${src}${typeof base === 'object' && base.width ? `?width=${base.width}` : ''}"`, `alt="${(img.alt as string) ?? ''}"`];
      if (srcset) attrs.push(`srcset="${srcset}"`);
      if (opts.sizes) attrs.push(`sizes="${opts.sizes}"`);
      if (img.width) attrs.push(`width="${img.width}"`, `height="${img.height}"`);
      if (opts.loading) attrs.push(`loading="${opts.loading}"`);
      if (opts.fetchpriority) attrs.push(`fetchpriority="${opts.fetchpriority}"`);
      if (opts.class) attrs.push(`class="${opts.class}"`);
      return `<img ${attrs.join(' ')}>`;
    });
    l.registerFilter('money', money);
    l.registerFilter('json', (v: unknown) => JSON.stringify(v ?? null));
    l.registerFilter('t', (key: string) => key.split('.').pop());
    l.registerFilter('font_face', () => '');
    l.registerFilter('preload_tag', (url: string, ...args: unknown[]) => {
      const opts = Object.fromEntries((args as Array<[string, unknown]>).filter(Array.isArray)) as Dict;
      return `<link rel="preload" href="${url}" as="${opts.as ?? 'style'}">`;
    });
  }

  private registerTags() {
    const self = this;
    const l = this.liquid;
    l.registerTag('schema', SchemaTag);
    l.registerTag('stylesheet', rawBlockTag('stylesheet', (b) => `<style data-block-stylesheet>${b}</style>`));
    l.registerTag('javascript', rawBlockTag('javascript', (b) => `<script>${b}</script>`));
    l.registerTag(
      'section',
      class extends Tag {
        name: string;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          this.name = token.args.trim().replace(/^['"]|['"]$/g, '');
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          emitter.write(yield self.renderSection(this.name, { type: this.name, settings: {} }, ctx));
        }
      },
    );
    l.registerTag(
      'sections',
      class extends Tag {
        group: string;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          this.group = token.args.trim().replace(/^['"]|['"]$/g, '');
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          const g = readJson<{ sections?: Record<string, Dict>; order?: string[] }>(join(self.themeDir, 'sections', `${this.group}.json`), {});
          for (const id of g.order ?? []) {
            const s = g.sections?.[id];
            if (s) emitter.write(yield self.renderSection(String(s.type), { id, ...s }, ctx));
          }
        }
      },
    );
    l.registerTag(
      'content_for',
      class extends Tag {
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          const parent = (ctx.get(['__blocks_parent']) as Dict | undefined) ?? {};
          const blocks = (parent.blocks as Record<string, Dict>) ?? {};
          for (const id of (parent.block_order as string[]) ?? Object.keys(blocks)) {
            const b = blocks[id];
            if (b) emitter.write(yield self.renderBlock(String(b.type), { id, ...b }, ctx));
          }
        }
      },
    );
    l.registerTag(
      'paginate',
      class extends Tag {
        tpls: Template[] = [];
        expr: string;
        by: number;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          const m = /^(.+?)\s+by\s+(\d+)/.exec(token.args.trim());
          this.expr = m?.[1] ?? 'collection.products';
          this.by = Number(m?.[2] ?? 50);
          const stream = this.liquid.parser.parseStream(remain);
          stream
            .on('tag:endpaginate', () => stream.stop())
            .on('template', (t: Template) => this.tpls.push(t))
            .on('end', () => {
              throw new Error('tag paginate not closed');
            });
          stream.start();
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          const parts = this.expr.split('.');
          const owner = ctx.get(parts.slice(0, -1)) as Dict;
          const key = parts[parts.length - 1]!;
          const full = (owner?.[key] as unknown[]) ?? [];
          const original = owner?.[key];
          if (owner) owner[key] = full.slice(0, this.by);
          ctx.push({ paginate: { pages: Math.ceil(full.length / this.by), current_page: 1 } });
          yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
          ctx.pop();
          if (owner) owner[key] = original;
        }
      },
    );
  }

  renderSection(type: string, section: Dict, ctx: Context): Promise<string> {
    const file = join(this.themeDir, 'sections', `${type}.liquid`);
    if (!existsSync(file)) return Promise.resolve(`<!-- missing section ${type} -->`);
    const src = readFileSync(file, 'utf8');
    const t0 = performance.now();
    const scope = { section: { id: section.id ?? type, settings: section.settings ?? {}, blocks: section.blocks ?? {} }, __blocks_parent: section };
    return this.liquid.parseAndRender(src, { ...ctx.getAll(), ...scope }).then((html) => {
      this.addProfile(`sections/${type}.liquid`, performance.now() - t0);
      return `<div id="shopify-section-${section.id ?? type}" class="shopify-section">${html}</div>`;
    });
  }

  renderBlock(type: string, block: Dict, ctx: Context): Promise<string> {
    const file = join(this.themeDir, 'blocks', `${type}.liquid`);
    if (!existsSync(file)) return Promise.resolve(`<!-- missing block ${type} -->`);
    const t0 = performance.now();
    const scope = { block: { id: block.id, type, settings: block.settings ?? {}, shopify_attributes: `data-block-id="${block.id}"` }, __blocks_parent: block };
    return this.liquid.parseAndRender(readFileSync(file, 'utf8'), { ...ctx.getAll(), ...scope }).then((html) => {
      this.addProfile(`blocks/${type}.liquid`, performance.now() - t0);
      return html;
    });
  }

  private addProfile(file: string, ms: number) {
    const e = this.profile.get(file) ?? { ms: 0, calls: 0 };
    e.ms += ms;
    e.calls++;
    this.profile.set(file, e);
  }

  globals(path: string, templateName: string, extra: Dict = {}): Dict {
    return {
      shop: { name: 'SpeedPilot Fixture Store', permanent_domain: 'speedpilot-fixture.myshopify.com', url: '' },
      settings: this.settings,
      request: { locale: { iso_code: 'en' }, path, host: 'localhost' },
      routes: { root_url: '/', cart_url: '/cart', cart_add_url: '/cart/add', search_url: '/search', account_url: '/account' },
      cart: { item_count: 0, items: [], currency: { iso_code: 'USD' } },
      linklists: { 'main-menu': { links: [{ title: 'Home', url: '/' }, { title: 'Shop', url: '/collections/all' }, { title: 'About', url: '/pages/about' }, { title: 'Search', url: '/search' }] } },
      collections: { all: this.data.collection },
      template: { name: templateName },
      canonical_url: `http://localhost${path}`,
      page_title: templateName === 'index' ? 'SpeedPilot Fixture Store' : templateName,
      page_description: 'Fixture storefront for SpeedPilot',
      ...extra,
    };
  }

  /** content_for_header stand-in: platform scripts SpeedPilot must never touch (SHA-09). */
  static contentForHeader() {
    return [
      '<script id="shopify-features" type="application/json">{"accessToken":"fixture","betas":[]}</script>',
      '<script>var Shopify = Shopify || {}; Shopify.shop = "speedpilot-fixture.myshopify.com"; Shopify.theme = {"name":"SpeedPilot Horizon Fixture","id":111,"role":"unpublished"};</script>',
      '<script async src="/cdn/shopifycloud/web-pixels-manager/wpm.js"></script>',
    ].join('\n');
  }

  async renderPage(path: string): Promise<{ status: number; html: string; profile: RenderProfileEntry[] }> {
    const route = this.route(path);
    const tpl = readJson<{ sections?: Record<string, Dict>; order?: string[] }>(join(this.themeDir, 'templates', `${route.template}.json`), {});
    const g = this.globals(path, route.template, route.extra);
    const t0 = performance.now();
    let content = '';
    for (const id of tpl.order ?? []) {
      const s = tpl.sections?.[id];
      if (!s) continue;
      const ctxHtml = await this.renderSectionStandalone(String(s.type), { id, ...s }, g);
      content += ctxHtml;
    }
    const layout = readFileSync(join(this.themeDir, 'layout', 'theme.liquid'), 'utf8');
    const html = await this.liquid.parseAndRender(layout, { ...g, content_for_layout: content, content_for_header: ThemeRenderer.contentForHeader() });
    this.addProfile('layout/theme.liquid', performance.now() - t0);
    return { status: route.status, html, profile: this.takeProfile() };
  }

  private async renderSectionStandalone(type: string, section: Dict, g: Dict): Promise<string> {
    // reuse renderSection with a throwaway context
    const fakeCtx = { getAll: () => g } as unknown as Context;
    return this.renderSection(type, section, fakeCtx);
  }

  route(path: string): { template: string; status: number; extra: Dict } {
    const p = path.split('?')[0]!;
    if (p === '/' || p === '') return { template: 'index', status: 200, extra: {} };
    let m = /^\/products\/([^/]+)/.exec(p);
    if (m) {
      const product = this.data.products.find((x) => x.handle === m![1]);
      if (product) return { template: 'product', status: 200, extra: { product, page_title: product.title } };
    }
    if (/^\/collections\/[^/]+\/?$/.test(p)) return { template: 'collection', status: 200, extra: { collection: { ...this.data.collection, products: [...this.data.collection.products] } } };
    if (p === '/cart') return { template: 'cart', status: 200, extra: {} };
    if (p === '/search') return { template: 'search', status: 200, extra: { search: { performed: false, terms: '' } } };
    m = /^\/pages\/([^/]+)/.exec(p);
    if (m) return { template: 'page', status: 200, extra: { page: { title: m[1], content: '<p>About the fixture store.</p>' } } };
    return { template: '404', status: 404, extra: {} };
  }
}

/** Starts a local preview server for a theme directory. */
export async function startPreview(opts: PreviewOptions): Promise<PreviewServer> {
  const r = new ThemeRenderer(opts.themeDir, { products: opts.products, variantsPerProduct: opts.variantsPerProduct });
  let last: RenderProfileEntry[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const cart: Array<{ id: number; quantity: number }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search });
    try {
      if (opts.password && !String(req.headers.cookie ?? '').includes('storefront_digest=ok') && url.pathname !== '/password') {
        res.writeHead(302, { Location: '/password' }).end();
        return;
      }
      if (url.pathname === '/password') {
        if (req.method === 'POST') {
          let body = '';
          for await (const c of req) body += c;
          if (new URLSearchParams(body).get('password') === opts.password) {
            res.writeHead(302, { 'Set-Cookie': 'storefront_digest=ok; Path=/', Location: '/' }).end();
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<form method="post" action="/password"><input type="password" name="password"><button>Enter</button></form>');
        return;
      }
      if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/cdn/img/')) {
        const name = url.pathname.replace(/^\/(assets|cdn\/img)\//, '');
        const file = join(opts.themeDir, 'assets', name.replace(/\.\./g, ''));
        if (existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
          res.end(readFileSync(file));
          return;
        }
        res.writeHead(404).end();
        return;
      }
      if (url.pathname === '/cdn/shopifycloud/web-pixels-manager/wpm.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('/* local stand-in for Shopify platform scripts (SHA-09) */ (function(){var t=Date.now();while(Date.now()-t<40){}window.webPixelsManager={init:function(){}};})();');
        return;
      }
      if (url.pathname === '/cdn/speculation-rules.json') {
        res.writeHead(200, { 'Content-Type': 'application/speculationrules+json' });
        res.end(JSON.stringify({ prefetch: [{ source: 'document', where: { and: [{ href_matches: '/*' }, { not: { href_matches: ['/cart*', '/checkout*', '/account*'] } }] }, eagerness: 'conservative' }] }));
        return;
      }
      if (url.pathname === '/cart.js') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ item_count: cart.reduce((a, b) => a + b.quantity, 0), items: cart }));
        return;
      }
      if (url.pathname === '/cart/add.js' || url.pathname === '/cart/add') {
        cart.push({ id: 1, quantity: 1 });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ item_count: cart.reduce((a, b) => a + b.quantity, 0) }));
        return;
      }
      if (url.pathname === '/__profile') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(last));
        return;
      }
      if (url.pathname.startsWith('/checkout')) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Checkout</title><h1>Checkout (stand-in, never edited)</h1>');
        return;
      }
      const page = await r.renderPage(url.pathname + url.search);
      last = page.profile;
      res.writeHead(page.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Speculation-Rules': '"/cdn/speculation-rules.json"',
        'Server-Timing': `processing;dur=${page.profile.find((p) => p.file === 'layout/theme.liquid')?.ms ?? 0}`,
        'X-SpeedPilot-Preview': 'local',
      });
      res.end(page.html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Liquid error: ${(e as Error).message}`);
    }
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`,
    server,
    requests,
    lastProfile: () => last,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Lists theme files with sizes (SPEC.md 3.10). */
export function themeFiles(themeDir: string): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  for (const d of ['layout', 'sections', 'blocks', 'snippets', 'templates', 'config', 'locales', 'assets']) {
    const dir = join(themeDir, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isFile()) out.push({ path: `${d}/${f}`, bytes: statSync(p).size });
    }
  }
  return out;
}


