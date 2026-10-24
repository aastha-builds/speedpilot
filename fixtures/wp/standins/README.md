# Plugin stand-ins (sandbox only)

The real fixture uses WooCommerce, Elementor, Contact Form 7 and Smart Slider 3 from wordpress.org (see `.wp-env.json`).
When wordpress.org cannot be reached (for example in a locked-down CI or cloud sandbox), `pnpm fixtures:wp up --engine compose`
mounts these small stand-ins instead. They reproduce only what SpeedPilot measures: the same plugin folder slugs and script/style
handles, assets enqueued on every page, the `wpcf7_load_js` / `wpcf7_load_css` filters and `wpcf7_enqueue_scripts()` /
`wpcf7_enqueue_styles()` functions, a `[smartslider3]` shortcode whose slides all load eagerly, and Elementor's
`elementor-frontend` assets with motion effects. They contain no vendor code. Never use them on a real site.
