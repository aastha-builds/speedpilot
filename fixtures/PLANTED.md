# Planted problems and their CHECKS.md IDs

Every planted problem maps to at least one CHECKS.md ID. The machine-readable ground truth for the X-ray Engine
(dependencies, handlers, unused assets, slow queries, Liquid hot spots, owners, safe and unsafe changes) is in
`truth.json`. Tests compare reports against both files.

## WordPress (`fixtures/wp`, http://localhost:8888)

| # | Planted problem (SPEC.md 11) | Where | CHECKS.md IDs |
|---|---|---|---|
| W1 | Lazy-loaded hero image (LCP), found late, no fetchpriority | `theme/.../functions.php` `spf_hero()`, `wp_omit_loading_attr_threshold` = 0 | IMG-01, WPF-15, REV-03 |
| W2 | Unsized images (gallery, slider slides, hero) | `spf_gallery()`, Smart Slider shortcode | IMG-06, CLS-01 |
| W3 | Google Fonts with 6 weights from Google servers | `wp_enqueue_style( 'spf-google-fonts' )` | FONT-01, FONT-02, FONT-04 |
| W4 | Render-blocking scripts in head (jQuery, jQuery Migrate, legacy slider, slider plugin, footer-year) | `functions.php`, Smart Slider | JS-01, DOC-05, JS-08, JS-07, REV-02 |
| W5 | Contact Form 7 assets on every page | Contact Form 7 defaults | WPF-06, CSS-09 |
| W6 | WooCommerce cart fragments on every page | theme enqueues `wc-cart-fragments` everywhere | WPF-07, WPB-16 |
| W7 | Slow query in the theme (`posts_per_page => -1`, `orderby => rand`, `meta_query`, query in a loop, ~80 ms) | `inc/slow-query.php` `spf_related_posts()` | WPB-12, WPB-13, NET-01 |
| W8 | About 2 MB of autoloaded options (one leftover from a deleted plugin, one single option over 100 KB) | `wp spf plant` | WPB-04 |
| W9 | YouTube embed without a facade | `spf_youtube()` | VID-02, DOC-08 |
| W10 | Chat-widget-like third-party script on load, polling every 15 s | `http://127.0.0.1:8890/chat/widget.js` | 3P-04, 3P-01, JS-11, JS-09 |
| W11 | Entrance animation on the hero and first heading | `.animate-in`, `assets/js/animate.js` | DOC-04 |
| W12 | Full-screen page preloader removed on `window.load` | `#preloader` | DOC-03 |
| W13 | Inline script that depends on jQuery right after it in the head | `wp_add_inline_script( 'spf-legacy-slider', ... )` | SAFE-01, JS-08, REV-01 |
| W14 | Click handler that blocks the main thread for about 300 ms | `assets/js/heavy-click.js` `spfHeavyClickHandler` | JS-04, REV-07 |
| W15 | Slider plugin assets on every page, every slide eager | Smart Slider 3 | WPF-11, IMG-10, IMG-07 |
| W16 | Eager offscreen gallery images, oversized (1200 px shown at ~150 px) | `spf_gallery()` | IMG-07, IMG-03, IMG-08 |
| W17 | Unused library loaded on every page | `assets/js/unused-lib.js` | JS-02, REV-02 |
| W18 | Promo banner inserted after load without reserved space | `wp_footer` inline script | CLS-03 |
| W19 | Expired transients | `wp spf plant` | WPB-05 |
| W20 | Long main-thread task during load from the slider library and the chat widget | `legacy-slider.js`, `widget.js` | JS-03, 3P-01 |
| W21 | Elementor frontend assets on every page, Elementor performance features left at defaults | Elementor | WPF-08 |
| W22 | oEmbed discovery links and jQuery Migrate for visitors | core defaults | WPF-02, JS-07 |

## Shopify (`fixtures/shopify/theme`, local preview http://localhost:9292)

| # | Planted problem (SPEC.md 11) | Where | CHECKS.md IDs |
|---|---|---|---|
| S1 | Parser-blocking `script_tag` in theme.liquid | `{{ 'vendor-slider.js' \| asset_url \| script_tag }}` | SHT-02, JS-01, DOC-05 |
| S2 | Oversized hero image without fetchpriority, lazy, deprecated `img_url`, no srcset, no dimensions | `sections/hero.liquid` | SHT-07, SHT-06, IMG-01, IMG-03, IMG-06 |
| S3 | Leftover app snippet from an uninstalled app (and its app embed still enabled) | `snippets/oldreviews-app-widget.liquid`, `settings_data.json` block 13579 | SHA-03, SHA-02, NET-10 |
| S4 | External font with 6 weights linked in theme.liquid | Poppins 300 to 800 from Google Fonts | FONT-01, FONT-02, FONT-09, SHT-08 |
| S5 | Loop over a large collection with a nested loop over variants | `sections/featured-collection.liquid` | SHT-09 |
| S6 | App-like scripts injected directly in theme.liquid (chat widget, analytics) | `layout/theme.liquid` | 3P-04, 3P-01, SHA-01 |
| S7 | Inline script that depends on a global (`window.VendorSlider`) defined by the parser-blocking script | `layout/theme.liquid` | SAFE-01, REV-01 |
| S8 | Deeply nested theme blocks (group > group > group) in the hero | `templates/index.json` | SHT-21 |
| S9 | A second parser-blocking script that is safe to defer | `assets/footer-tools.js` | SHT-02, JS-01 (a true `safe` case for the X-ray) |

Shopify platform scripts (`content_for_header`, the local stand-in `web-pixels-manager`) are part of the ceiling (SHA-09)
and must never be touched.
