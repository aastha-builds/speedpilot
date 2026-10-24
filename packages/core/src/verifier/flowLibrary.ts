import type { Flow, SiteConfig } from '../config/site.js';

/**
 * Default flow library (SPEC.md 6). Site flows in site.yaml come first; library flows are added when the platform or
 * plugin is present and the site did not define a flow with the same name. Every step uses `optional` clicks where a
 * theme may not have the element, so a missing optional element never fails a flow, but a broken one does.
 */
export function defaultFlows(cfg: SiteConfig, opts: { woocommerce?: boolean; shopUrl?: string; productUrl?: string; variableProductUrl?: string; cartUrl?: string }): Flow[] {
  const flows: Flow[] = [];
  flows.push({ name: 'library: home loads with navigation', kind: 'navigation', stagingOnly: false, viewport: 'all', steps: [{ goto: '/' }, { expectVisible: 'header a[href], nav a[href]' }, { expectVisible: 'footer' }] });
  if (cfg.platform === 'wordpress' && opts.woocommerce) {
    const shop = opts.shopUrl ?? '/shop/';
    flows.push({ name: 'library: WooCommerce add to cart (simple)', kind: 'cart', stagingOnly: false, viewport: 'desktop', steps: [{ goto: shop }, { click: '.add_to_cart_button.ajax_add_to_cart, .add_to_cart_button' }, { waitFor: '.added_to_cart, .wc-block-mini-cart__badge, a.added', state: 'attached' }] });
    if (opts.variableProductUrl) flows.push({ name: 'library: WooCommerce variable product', kind: 'cart', stagingOnly: false, viewport: 'desktop', steps: [{ goto: opts.variableProductUrl }, { expectVisible: 'form.variations_form select' }] });
    flows.push({ name: 'library: WooCommerce cart page', kind: 'cart', stagingOnly: false, viewport: 'desktop', steps: [{ goto: opts.cartUrl ?? '/cart/' }, { expectVisible: 'main, .woocommerce, .wp-block-woocommerce-cart' }] });
    flows.push({ name: 'library: WooCommerce checkout page loads with payment methods', kind: 'checkout', stagingOnly: false, viewport: 'desktop', steps: [{ goto: shop }, { click: '.add_to_cart_button' }, { wait: 1500 }, { goto: '/checkout/' }, { waitFor: '.wc-block-checkout, form.checkout, .woocommerce-checkout', state: 'attached' }] });
  }
  if (cfg.platform === 'shopify') {
    const product = opts.productUrl ?? '/products/product-1';
    flows.push({ name: 'library: Shopify variant select and add to cart', kind: 'cart', stagingOnly: false, viewport: 'all', steps: [{ goto: product }, { expectVisible: 'form[action*="/cart/add"]' }, { click: 'form[action*="/cart/add"] [type="submit"], form[action*="/cart/add"] button[name="add"]' }, { wait: 1200 }] });
    flows.push({ name: 'library: Shopify cart page', kind: 'cart', stagingOnly: false, viewport: 'desktop', steps: [{ goto: opts.cartUrl ?? '/cart' }, { expectVisible: 'main' }] });
  }
  return flows.filter((f) => !cfg.flows.some((s) => s.name === f.name));
}

export function allFlows(cfg: SiteConfig, opts: Parameters<typeof defaultFlows>[1]): Flow[] {
  return [...cfg.flows, ...defaultFlows(cfg, opts)];
}
