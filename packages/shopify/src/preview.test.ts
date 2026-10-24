import { describe, it, expect, afterAll } from 'vitest';
import { startPreview, type PreviewServer } from './preview.js';
import { fileURLToPath } from 'node:url';

const themeDir = fileURLToPath(new URL('../../../fixtures/shopify/theme', import.meta.url));
let srv: PreviewServer;
afterAll(() => srv?.close());

describe('local fixture preview', () => {
  it('renders the home page with the planted problems', async () => {
    srv = await startPreview({ themeDir });
    const res = await fetch(srv.url + '/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<script src="/assets/vendor-slider.js?v=1" type="text/javascript"></script>');
    expect(html).toContain('family=Poppins:wght@300;400;500;600;700;800');
    expect(html).toMatch(/hero\.jpg\?size=2400x|hero\.jpg\?v=1" alt="Hero" loading="lazy"/);
    expect(html).toContain('oldreviews-widget');
    expect(html).toContain('Fast shop, slow fixture');
    expect(html).toContain('web-pixels-manager');
    expect((html.match(/class="card"/g) ?? []).length).toBe(8);
    const prof = srv.lastProfile();
    expect(prof.find((p) => p.file === 'sections/featured-collection.liquid')).toBeTruthy();
  });
  it('renders product, collection, cart, search and 404', async () => {
    for (const [p, s] of [['/products/product-1', 200], ['/collections/all', 200], ['/cart', 200], ['/search', 200], ['/nope', 404]] as const) {
      const r = await fetch(srv.url + p);
      expect(r.status, p).toBe(s);
      const t = await r.text();
      expect(t).not.toMatch(/Liquid error/);
    }
    const prod = await (await fetch(srv.url + '/products/product-1')).text();
    expect(prod).toContain('srcset="/cdn/img/');
    expect(prod).toContain('"@type": "Product"');
  });
});
