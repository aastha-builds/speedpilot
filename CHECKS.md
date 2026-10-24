# CHECKS: what slows sites down, and what breaks them

Every check below (MEAS through SAFE, including the REV area for reverse-engineering findings) becomes one rule in `rules/<area>.yaml` with these fields: `id`, `platforms` (wp, shopify, both), `detect` (data source and condition), `evidence` (what to save), `metric` (LCP, INP, TBT, CLS, TTFB, bytes, safety), `tier`, `fix`, `verify`. Do not skip or merge checks when generating rules. Add new checks with new IDs; never reuse an ID.

Tiers: **T1** low risk and reversible. **T2** medium risk: staging plus full verification. **T3** needs written client approval. "Report" means the tool explains it and recommends; it does not change anything.

Lighthouse 13 audit IDs are given where they exist. Where Lighthouse 13 removed an audit, the check says how SpeedPilot detects the problem itself.

---

## MEAS: measurement hygiene (before any conclusion)

- **MEAS-01 Noisy lab numbers.** Detect: fewer than 5 runs, or the 5 runs spread more than 10 points. Fix: rerun on the same machine with the same Chrome and Lighthouse versions and nothing else running; use the median. Verify: spread under 10 points.
- **MEAS-02 Unknown cache state.** Detect: `x-cache`, `cf-cache-status` or `age` headers missing or changing between runs. Fix: record them; measure both as visitors get the page (cached) and bypassed (PHP or Liquid render time). Verify: both numbers in the report.
- **MEAS-03 Consent changes the page.** Detect: a consent tool is present. Fix: baseline and test both states, denied (first visit) and granted.
- **MEAS-04 Market, language or location redirects.** Detect: a 30x on the first request based on IP or language; location popups. Fix: test the client's main market URL directly; report the redirect cost separately.
- **MEAS-05 Logged-in variants.** Detect: WooCommerce customer accounts, memberships, B2B pricing. Fix: test logged-out by default, plus a logged-in sample for stores and memberships, plus admin pages for backend speed.
- **MEAS-06 Protected pages.** Detect: Shopify storefront password, staging basic auth, Shopify preview bar. Fix: pass credentials to Lighthouse and Playwright (for a Shopify password page, log in once with Playwright and pass the session cookie to Lighthouse); block preview-bar requests on Shopify previews and label those numbers indicative.
- **MEAS-07 Lab and field disagree.** Detect: lab good but CrUX poor, or the reverse. Fix: field data decides what real users get; use traces to find the cause (third parties after interaction, slow devices, uncached pages for real users, logged-in traffic).
- **MEAS-08 Tests blocked.** Detect: 403 or 429 responses, challenge pages, captchas in screenshots. Fix: slow down and ask the client to allowlist the test IP. Never bypass a security tool.
- **MEAS-09 Content that changes per load.** Detect: ads, random products, rotating testimonials, countdowns. Fix: mask those regions in visual diffs; take more runs.
- **MEAS-10 Test runs polluting client data.** Detect: analytics or ad beacons (GA4 collect, Meta Pixel, Google Ads, TikTok, Klaviyo) sent during automated runs; add-to-cart events from test flows reaching ad platforms. Fix: record, then abort, every beacon request in every automated run; keep the tag scripts loading so their cost is measured (CLAUDE.md rule 12). Verify: zero beacons leave the test browser.
- **MEAS-11 Tool versions changed between runs.** Detect: the Chrome, Lighthouse or web-vitals version differs from the baseline run. Fix: take a new baseline before comparing; Chrome 147 to 150 refined how INP is measured, so mixed versions give false gains or losses. Verify: before and after numbers come from the same versions.

## NET: server, network and TTFB

- **NET-01 Slow TTFB (over 800 ms).** Detect: `document-latency-insight`, `Server-Timing`, `wp profile stage`, `shopify theme profile`. Fix: find where the time goes (WPB checks for WordPress, SHT-09 for Liquid); hosting limits go in the report. Tier: by cause. Verify: TTFB median down, cached and bypassed.
- **NET-02 Redirect chains.** Detect: more than one redirect on entry URLs (http to https to www to trailing slash); internal links pointing at redirected URLs. Fix: a single 301 at the server or CDN (T2, approval for server config); internal links updated to final URLs (T1). Verify: one hop at most; SEO guard.
- **NET-03 No HTTP/2 or HTTP/3.** Detect: `modern-http-insight`, protocol per request. Fix: host or CDN setting. Report (T3).
- **NET-04 No text compression.** Detect: `document-latency-insight`; no `content-encoding` on HTML, CSS, JS, SVG or JSON. Fix: Brotli (or Zstandard where the server or CDN supports it) with gzip as fallback, at the server or CDN (T2, approval). Verify: header present, no double compression.
- **NET-05 Short cache lifetime for static files.** Detect: `use-cache-insight`; versioned assets cached for less than 30 days. Fix: `Cache-Control: public, max-age=31536000, immutable` for versioned files only, at the server or CDN (T2). Never on HTML. Verify: headers; new versions load after a change.
- **NET-06 Too many origins.** Detect: more than 10 third-party origins on first load; long DNS, connect or TLS times. Fix: remove or self-host what you can; preconnect only to the 2 or 3 critical origins (T2).
- **NET-07 Cookie weight.** Detect: cookie header over 2 KB on asset requests; a plugin setting cookies for every visitor. Fix: cookie-free static host or CDN; fix the setting that sets cookies for everyone (T2/T3).
- **NET-08 No CDN for a far-away audience.** Detect: high connect time and TTFB from the main market compared with the server's location. Fix: report the CDN option (T3).
- **NET-09 Cloudflare settings that break or slow.** Detect: Rocket Loader on, email obfuscation script, Mirage, aggressive bot challenges on assets. Fix: report; Rocket Loader must be off before SpeedPilot defers scripts itself (T3, approval). Verify: console clean.
- **NET-10 Broken asset references.** Detect: 404 or 410 on CSS, JS, fonts, images or source maps. Fix: correct or remove the reference (T1). Verify: no new 404s.
- **NET-11 Mixed content.** Detect: `http://` resources on https pages. Fix: update URLs on staging first, `wp search-replace` dry run before the real run (T2). Verify: no mixed-content warnings.
- **NET-12 Back/forward cache blocked.** Detect: `bf-cache` audit reasons such as `Cache-Control: no-store` on HTML, `unload` handlers, open connections. Fix: replace `unload` with `pagehide`; avoid `no-store` on public pages where safe (T2). Verify: back navigation is instant and cart count and login state are right afterwards (SAFE-14).
- **NET-13 Old service worker.** Detect: a service worker from an old PWA plugin or app serving stale files. Fix: report; unregister with approval (T3).
- **NET-14 Host page cache bypassed for everyone.** Detect: a cache MISS on every anonymous request because some code sets cookies or `no-cache` headers for all visitors. Fix: fix that code or setting (T2). This is the host's cache, not a plugin, so rule 3 allows keeping it working.
- **NET-15 No Early Hints.** Detect: no `103 Early Hints` response for critical CSS, the main font or the LCP image, on a CDN or host that supports it (Shopify manages this itself). Fix: report; enable at the CDN with approval (T3). Verify: the 103 response is seen and LCP is not worse.

## DOC: HTML document and DOM

- **DOC-01 Large DOM.** Detect: `dom-size-insight`; more than about 1,400 elements, depth over 32, or a parent with more than 60 children. Fix: builder container conversion, remove duplicated desktop and mobile menus and hidden sections, paginate long lists (T2; design changes T3). Verify: visual and flows.
- **DOC-02 Big inline data.** Detect: inline JSON or localized script data over 50 KB (WooCommerce variation data, builder config, product JSON, SVG sprites repeated per item). Fix: load lazily or trim; for WooCommerce variable products, tune `woocommerce_ajax_variation_threshold` so large variation sets load by AJAX (T2). Verify: variation selection still works.
- **DOC-03 Page preloader hides content.** Detect: a full-screen overlay removed on `window.load`; LCP render delay close to load time. Fix: remove the preloader (T3 design change; usually a big LCP gain). Verify: visual.
- **DOC-04 Entrance animations above the fold.** Detect: hero or heading at opacity 0 or offset until an animation library runs (Elementor motion effects, AOS, WOW.js, GSAP). Fix: no entrance animation on first-screen elements (T2). Verify: visual; LCP render delay down.
- **DOC-05 Render-blocking resources.** Detect: `render-blocking-insight`. Fix: CSS-01 and JS-01.
- **DOC-06 Wasted hints.** Detect: preloads not used within 3 seconds (console warning), wrong `as` values, preconnects never used, more than one high-priority image. Fix: remove or correct (T1).
- **DOC-07 Viewport problems.** Detect: `viewport-insight`; missing viewport meta or `user-scalable=no`. Fix: standard viewport meta (T1). Verify: mobile visual.
- **DOC-08 Iframes on the first screen.** Detect: maps, video, booking or calendar widgets in iframes above the fold. Fix: facade with a static image and click to load (T2). Verify: works on click and by keyboard.
- **DOC-09 document.write.** Detect: code scan and console warnings (Lighthouse 13 removed this audit). Fix: async loader, or remove the old snippet (T2; T3 if it is a vendor tag).
- **DOC-10 First screen built by JavaScript.** Detect: hero, menu or product info empty in the raw HTML. Fix: render it in HTML through the theme or child theme (T3).

## IMG and VID: images and video

- **IMG-01 LCP image lazy or found late.** Detect: `lcp-discovery-insight`; the LCP image has `loading="lazy"`, is a CSS background, or is injected by a slider script; high resource load delay. Fix: a plain `<img>` in the HTML with `loading="eager"` and `fetchpriority="high"`; preload it with `imagesrcset` and `imagesizes` when it is a background or found late; remove lazy classes from the first slide (T1; T2 inside slider plugins). Verify: load delay near zero; hero looks identical.
- **IMG-02 Priority competition.** Detect: several images with `fetchpriority="high"` or several image preloads. Fix: only the LCP image gets high priority (T1).
- **IMG-03 Oversized images.** Detect: `image-delivery-insight`; intrinsic width more than 1.5x the rendered width at the tested device pixel ratio. Fix: responsive `srcset` with a correct `sizes`; resize originals on staging (T1/T2). Verify: still sharp in high-DPR screenshots.
- **IMG-04 Old formats.** Detect: JPEG or PNG over 50 KB served to browsers that accept WebP or AVIF. Fix: WordPress: WebP or AVIF for new and regenerated sizes, originals kept (T2). Shopify: `image_url` already serves modern formats from the Shopify CDN, so fix sizes instead. Keep JPEG or PNG for og:image and product feeds. Verify: no 404s; social previews and feeds unchanged (SAFE-07).
- **IMG-05 Poor compression.** Detect: high bytes per pixel for the format. Fix: recompress at about quality 75 to 82, originals kept (T1/T2). Verify: visual diff.
- **IMG-06 No dimensions.** Detect: `unsized-images`, `cls-culprits-insight`. Fix: width and height attributes or CSS `aspect-ratio` (T1). Verify: CLS down, layout identical.
- **IMG-07 Offscreen images loaded eagerly.** Detect: images below the first viewport without `loading="lazy"` (Lighthouse 13 removed the offscreen-images audit); JavaScript lazy-load libraries (for example lazysizes) doing what the browser can do natively. Fix: native lazy loading below the fold, first screen stays eager; replace JavaScript lazy loading with native where it is safe (T1/T2). Verify: images appear on scroll and inside tabs, sliders and lightboxes (SAFE-06).
- **IMG-08 Wrong sizes attribute.** Detect: `sizes="100vw"` on images rendered much smaller. Fix: correct `sizes` per layout (T1).
- **IMG-09 Animated GIFs.** Detect: GIFs over 100 KB. Fix: `<video autoplay muted loop playsinline>` with MP4 or WebM and a poster (T2).
- **IMG-10 Sliders loading every slide.** Detect: a carousel that loads all slides eagerly. Fix: lazy-load slides after the first; first slide eager with high priority; recommend a static hero (T3 design). Verify: slider works by touch, click and keyboard.
- **IMG-11 Heavy SVG.** Detect: SVG files over 30 KB, or the same inline SVG repeated many times. Fix: SVGO with a safe preset (keep viewBox and IDs used by CSS or JS), or a sprite (T1/T2).
- **IMG-12 External image hosts.** Detect: images from slow third-party hosts or hotlinked images. Fix: self-host (T2).
- **IMG-13 Avatars.** Detect: many Gravatar requests on posts with comments. Fix: lazy-load or a local default avatar (T1).
- **VID-01 Heavy hero video.** Detect: autoplay video over 2 MB, or loaded on mobile. Fix: poster image, compressed source, `preload="none"` or `"metadata"`, start after load, static image on mobile (T2; T3 if design changes). Verify: visual.
- **VID-02 Video embeds.** Detect: YouTube, Vimeo or Wistia iframes (Lighthouse 13 removed the facade audit). Fix: click-to-load facade (for example lite-youtube-embed) with a local poster (T2). Verify: plays on click, keyboard access, video tracking still works if the client uses it.

## FONT: web fonts

- **FONT-01 Too many font files.** Detect: more than 4 font files on first load, or weights and styles the CSS never uses. Fix: keep only the weights the rendered pages use (T2, check with the design). Verify: visual diff.
- **FONT-02 Google Fonts from Google servers.** Detect: requests to fonts.googleapis.com or fonts.gstatic.com. Fix: self-host woff2 subsets (also helps EU privacy compliance); Elementor and Divi have options for this (T1/T2). Verify: same glyphs, including accented characters the site uses.
- **FONT-03 No font-display.** Detect: `font-display-insight`. Fix: `font-display: swap`, or `optional` for non-brand body text (T1).
- **FONT-04 Critical font found late.** Detect: the font used by LCP text starts late in the waterfall (Lighthouse 13 removed the preload-fonts audit). Fix: preload at most 2 woff2 files with `crossorigin` (T1). Verify: no "preloaded but not used" warning.
- **FONT-05 Font swap moves layout.** Detect: a web font is a CLS culprit. Fix: fallback font metric overrides (`size-adjust`, `ascent-override`, `descent-override`, `line-gap-override`) (T1/T2). Verify: CLS down; visual.
- **FONT-06 Icon fonts.** Detect: Font Awesome, eicons, dashicons or theme icon fonts loaded for a few icons. Fix: inline SVG or a subset; builder options (Elementor Inline Font Icons, Divi Dynamic Icons) (T2). Verify: every icon renders (SAFE-08).
- **FONT-07 Legacy font formats.** Detect: TTF, EOT or WOFF served. Fix: woff2 only (T1).
- **FONT-08 Same family loaded twice.** Detect: theme, builder and a plugin each load the same family. Fix: one source (T2).
- **FONT-09 Shopify font loading.** Detect: `font_face` without `font_display`; external font links in theme.liquid. Fix: `font_face: font_display: 'swap'`; fonts from the Shopify font library or theme assets (T1/T2).

## CSS: stylesheets

- **CSS-01 Render-blocking CSS.** Detect: `render-blocking-insight`; more than about 50 KB of blocking CSS. Fix: critical CSS inline per template plus the full CSS loaded async (T2). Verify: early-paint screenshot shows no unstyled flash; visual diff on every template.
- **CSS-02 Unused CSS.** Detect: `unused-css-rules`; coverage after the scripted interactions. Fix: drop whole files that a template never uses; selector purging only with a safelist (T2). Verify: all flows and interaction states (SAFE-04).
- **CSS-03 @import chains.** Detect: `@import` inside CSS files. Fix: inline the imported file or use link tags (T1).
- **CSS-04 Duplicate frameworks.** Detect: Bootstrap, Foundation, animate.css or Font Awesome loaded twice or by several plugins. Fix: one copy (T2/T3).
- **CSS-05 Unminified CSS.** Detect: `unminified-css` where present, or a high whitespace ratio. Fix: minify (T1).
- **CSS-06 Big inline CSS on every page.** Detect: builder CSS printed inline in each page. Fix: external file mode so browsers can cache it (Elementor CSS Print Method: External File) (T1). Verify: visual.
- **CSS-07 Non-composited animations.** Detect: `non-composited-animations`. Fix: animate only `transform` and `opacity` (T2).
- **CSS-08 Expensive paint and style work.** Detect: long frames while scrolling; large `box-shadow`, `filter` or `backdrop-filter` on fixed elements; long style recalculations during interactions (very complex selectors on a large DOM). Fix: simplify the effect or the selectors (T2).
- **CSS-09 Plugin CSS everywhere.** Detect: CSS for forms, sliders, galleries, WooCommerce or popups on pages that do not use them. Fix: load only where used, based on a usage scan of all content (SAFE-05) (T2).
- **CSS-10 Long pages render everything.** Detect: very long pages with heavy sections. Fix: `content-visibility: auto` with `contain-intrinsic-size` on below-the-fold sections (T2). Verify: no CLS; anchor links and find-in-page still work.

## JS: JavaScript, main thread and INP

- **JS-01 Parser-blocking scripts.** Detect: `render-blocking-insight`; scripts in head without `defer` or `async`. Fix: `defer` (WordPress strategy data, Shopify `defer` attribute) after checking inline code that depends on them (T1/T2). Verify: console (SAFE-01).
- **JS-02 Unused JavaScript.** Detect: `unused-javascript`; coverage. Fix: load per template, lazy import, remove dead libraries (T2).
- **JS-03 Long tasks during load.** Detect: TBT, `long-tasks`, `bootup-time`, Long Animation Frames. Fix: defer, split, remove or replace the responsible script (T2).
- **JS-04 Slow interactions (INP over 200 ms).** Detect: scripted INP with attribution; `interaction-to-next-paint-insight` in timespan traces. Fix: break up long handlers (`scheduler.yield()` or `setTimeout` chunks), debounce input handlers, avoid layout thrashing, update less DOM, move work off the main thread (T2). Verify: every scripted interaction under 200 ms with 4x CPU slowdown.
- **JS-05 Duplicate libraries.** Detect: `duplicated-javascript-insight`; two jQuery versions, several slider or lightbox libraries, several lodash copies. Fix: one copy (T2).
- **JS-06 Legacy JavaScript.** Detect: `legacy-javascript-insight`. Fix: modern build where we own the code; report vendor code (T2/T3).
- **JS-07 jQuery Migrate (WordPress).** Detect: `jquery-migrate` loaded. Fix: remove only after zero `JQMIGRATE` warnings across all flows on staging (T2).
- **JS-08 jQuery in head (WordPress).** Detect: jQuery loads in the head. Fix: defer or move to the footer only when no inline script or plugin needs it early (T2, high break risk). Verify: console on every template.
- **JS-09 Code for later loaded now.** Detect: slider, gallery, lightbox, map, chat or review code running on load for below-the-fold or on-click features. Fix: initialize on visibility (IntersectionObserver) or on interaction (T2).
- **JS-10 Unminified JavaScript.** Detect: `unminified-javascript` where present. Fix: minify with source maps (T1).
- **JS-11 Polling and timers.** Detect: repeated requests on an interval (Heartbeat, cart refresh, live stats, view counters). Fix: remove, slow down, or switch to events (T2).
- **JS-12 Non-passive scroll and touch listeners.** Detect: code scan and DevTools warnings (Lighthouse 13 removed this audit). Fix: `{ passive: true }` where `preventDefault` is not used; throttle with `requestAnimationFrame` (T2).
- **JS-13 Big JSON parsed on load.** Detect: large inline JSON parsed at startup (variants, configs). Fix: trim or load on demand (T2).
- **JS-14 Errors that stop other scripts.** Detect: uncaught errors on load. Fix: fix the cause in our code, the child theme or settings; report vendor bugs (T2). Verify: the dependent features work.
- **JS-15 Synchronous XHR.** Detect: the console deprecation warning. Fix: replace or remove (T2/T3).

## 3P: third-party scripts and tags

- **3P-01 Third-party cost table.** Detect: `third-parties-insight`, Long Animation Frame attribution, coverage. Fix: one row per vendor: main-thread ms, KB, requests, pages, business purpose, owner, where it is injected (theme code, theme options, a header/footer plugin, GTM, an app embed), and a recommendation (report). Any later change to a tag is made at that injection point.
- **3P-02 Heavy tag manager.** Detect: GTM with many tags firing on all pages, custom HTML tags, dead Universal Analytics tags. Fix: GTM clean-up with the client: remove dead tags, fire tags only where needed (T3). Moving tags off the main thread (Partytown-style) is experimental and only for tags proven compatible; server-side tagging is another option but has hosting costs; both are client decisions (T3). Verify: tracking guard.
- **3P-03 Duplicate tracking.** Detect: the same GA4 measurement ID or Meta Pixel ID loaded twice (plugin plus GTM, theme plus app). Fix: one source (T3). Verify: events neither doubled nor missing.
- **3P-04 Chat widget on load.** Detect: Tidio, Intercom, Zendesk, Crisp, LiveChat, tawk.to, Shopify Inbox and similar. Fix: a light button that loads the widget on click or after idle (T2; T3 if proactive greetings matter to the client). Verify: chat opens and the agent sees the visitor.
- **3P-05 Heatmaps and session replay.** Detect: Hotjar, Microsoft Clarity, Lucky Orange, Mouseflow. Fix: load after idle or only on chosen pages; client decision (T3).
- **3P-06 A/B testing anti-flicker.** Detect: an anti-flicker snippet that hides the page for up to several seconds. Fix: remove it or shorten the timeout; client decision (T3). Verify: experiments still run.
- **3P-07 Consent tool cost.** Detect: a blocking consent script, or a banner that causes CLS. Fix: banner as a fixed overlay (no layout shift); keep the consent script early but small; never delay it in a way that lets tags fire before consent (T3). Verify: tracking guard in both consent states.
- **3P-08 reCAPTCHA everywhere.** Detect: reCAPTCHA on pages without forms. Fix: load only on form pages, or on first focus of a form field (T2). Verify: forms still protected and still submit.
- **3P-09 Social embeds and feeds.** Detect: Instagram, Facebook, X or TikTok embeds and feed widgets. Fix: lazy-load below the fold or use a facade (T2).
- **3P-10 Review widgets.** Detect: Trustpilot, Judge.me, Yotpo, Google review widgets. Fix: lazy-load below the fold; keep review JSON-LD intact (T2). Verify: SEO guard.
- **3P-11 Accessibility overlays.** Detect: accessiBe, UserWay and similar. Fix: report the cost; client decision (T3).
- **3P-12 Ads.** Detect: ad scripts and slots. Fix: reserve slot sizes (CLS); lazy-load slots below the fold (T2/T3, revenue impact).
- **3P-13 Payment SDKs on every page.** Detect: Stripe.js, PayPal SDK, Klarna or Afterpay messaging on non-checkout pages. Fix: report. Stripe recommends loading Stripe.js on every page for fraud detection, so never remove it unless the client decides (T3).
- **3P-14 Third-party fonts and CSS.** Detect: Adobe Fonts (Typekit) or other font CDNs. Fix: self-host if the license allows (T3).
- **3P-15 Maps.** Detect: Google Maps JS API or iframe on load. Fix: static image facade with click to load (T2).

## CLS: layout stability

- **CLS-01 Media without reserved space.** Detect: `cls-culprits-insight`, `unsized-images`. Fix: IMG-06; reserve space for embeds and ad slots (T1/T2).
- **CLS-02 Font swap.** Fix: FONT-05.
- **CLS-03 Late banners and bars.** Detect: announcement bars, top cookie banners, free-shipping bars or app banners inserted after load. Fix: reserve their height in CSS, render them server-side, or use an overlay (T2). Verify: CLS down; the banner still shows when it should.
- **CLS-04 Sliders jumping on init.** Detect: a shift when the slider script starts. Fix: fixed height or aspect ratio before init (T1/T2).
- **CLS-05 Content inserted above content.** Detect: lazy sections or infinite scroll inserting above the viewport, related products pushed in. Fix: reserve space or insert below (T2).
- **CLS-06 Layout-property animations.** Detect: animations on top, left, width, height or margin. Fix: transform-based animation (T2).
- **CLS-07 Client-side text rewriting.** Detect: currency or translation apps changing text after load. Fix: Shopify Markets or server-side multilingual output (T3).
- **CLS-08 Sticky header resizing.** Detect: header height changes on scroll and moves content. Fix: transform-based shrink or fixed reserved space (T2).
- **CLS-09 App blocks rendering late.** Detect: app blocks with no placeholder height. Fix: placeholder `min-height` (T1/T2).

## WPB: WordPress backend and TTFB

- **WPB-01 Old PHP.** Detect: a PHP version without active security support (check php.net/supported-versions at run time). Fix: PHPCompatibility scan (`phpcompatibility/phpcompatibility-wp`) on staging, then a host upgrade (T3). Verify: no new PHP errors; all flows.
- **WPB-02 OPcache off or too small.** Detect: `opcache_get_status()` through the agent; memory full or low hit rate. Also database server settings that limit speed, such as an InnoDB buffer pool much smaller than the database. Fix: host setting (T3, report).
- **WPB-03 Debug tools on production.** Detect: Xdebug loaded, WP_DEBUG_LOG writing heavily, SAVEQUERIES on, Query Monitor active for everyone. Fix: turn them off (T2, approval). Verify: no log floods.
- **WPB-04 Autoload bloat.** Detect: autoloaded options above 800 KB (the WordPress Site Health limit), a single autoloaded option over 100 KB, options left by deleted plugins. Fix: autoload off for options not needed on every request (`wp_set_option_autoload()`); export, then delete, leftovers of removed plugins (T2). Verify: TTFB down; the owning plugins still work.
- **WPB-05 Transient pile-up.** Detect: many expired transients in `wp_options`. Fix: `wp transient delete --expired` (T1 on staging, T2 on production); fix code that creates transients without expiry (T2).
- **WPB-06 Revisions bloat.** Detect: revision count; page builders store full page data in every revision. Fix: cap with `WP_POST_REVISIONS`; delete old revisions after backup (T2).
- **WPB-07 Orphans and trash.** Detect: orphaned postmeta, termmeta and commentmeta; spam and trash comments; old auto-drafts. Fix: export, then delete (T2). Verify: no plugin relied on them (SAFE-11).
- **WPB-08 Action Scheduler bloat.** Detect: thousands of past-due, failed or completed actions; large `actionscheduler` tables. Fix: investigate failing jobs first (they often mean a broken integration), then retention (`action_scheduler_retention_period`) and clean-up (T2). Verify: queue healthy, scheduled jobs run.
- **WPB-09 WooCommerce sessions and logs.** Detect: large `woocommerce_sessions`, old logs. Fix: WooCommerce tools for expired sessions, log retention (T2).
- **WPB-10 Plugin log tables.** Detect: security, redirect, email or statistics tables growing without limit. Fix: retention settings (T2).
- **WPB-11 Table engines and indexes.** Detect: MyISAM tables; queries scanning large tables without an index. Fix: InnoDB conversion, targeted indexes (T3, backup, off-peak). Verify: query times.
- **WPB-12 Slow queries.** Detect: queries over 50 ms with their caller. Fix: theme code in the child theme, plugin settings; report plugin bugs (T2/T3).
- **WPB-13 Expensive theme queries.** Detect: `posts_per_page => -1`, `orderby => rand`, `meta_query` on large meta tables, queries inside loops. Fix: rewrite in the child theme (T2). Verify: identical output.
- **WPB-14 Outgoing calls during render.** Detect: the `pre_http_request` log on staging: license checks, API calls, feeds or remote files fetched by PHP during page load. Fix: store the result in a transient with a sensible expiry or move the call to cron; report plugin behaviour (T2). Verify: the feature still shows fresh enough data.
- **WPB-15 WP-Cron problems.** Detect: overdue events, events every minute, duplicate events, cron spawned by visitors on busy sites. Fix: fix schedules; a real system cron with `DISABLE_WP_CRON` only with server access (T2). Verify: event run times advance (SAFE-10).
- **WPB-16 Front-end AJAX on every page.** Detect: admin-ajax.php or REST calls on page load (cart fragments, view counters, live stats, popup rule checks). Fix: remove, limit to the pages that need it, or trigger on events (T2).
- **WPB-17 Heartbeat.** Detect: heartbeat requests every 15 to 60 seconds in admin and on the front end. Fix: off on the front end when unused, 60 seconds in admin, editor untouched (T1). Verify: post locking and autosave work (SAFE-12).
- **WPB-18 Plugin overload.** Detect: cost per plugin from `wp profile hook`; plugins that overlap. Fix: report cost per plugin with options; removal is T3.
- **WPB-19 Statistics plugins writing on every visit.** Detect: insert queries on anonymous front-end requests. Fix: client decision to rely on an analytics tool they already use (T3).
- **WPB-20 Security plugin overhead.** Detect: WAF loaded through auto_prepend_file, live traffic logging, country blocking lookups. Fix: tune with the client (T3). Never weaken protection on your own.
- **WPB-21 Background jobs at peak hours.** Detect: backups, malware scans, broken-link checks or bulk image jobs running in business hours. Fix: reschedule to off-peak (T2).
- **WPB-22 Slow site search.** Detect: LIKE queries on large posts tables. Fix: report options (T3).
- **WPB-23 Huge menus.** Detect: menus with hundreds of items, mega menus built on every request. Fix: simplify; report (T3).
- **WPB-24 No object cache on a heavy dynamic site.** Detect: WooCommerce or membership site with high query counts and no object cache. Fix: report it as a hosting option. Do not install a cache plugin (rule 3).
- **WPB-25 PHP warning floods.** Detect: deprecations and warnings on every request. Fix: child-theme fixes; plugin updates as a separate approved job (T2/T3). Verify: log volume down.
- **WPB-26 Slow wp-admin.** Detect: admin pages over 2 seconds; dashboard widgets calling outside APIs; heavy admin notices; WooCommerce analytics. Fix: disable unused dashboard widgets, tune settings (T2).
- **WPB-27 WooCommerce order storage.** Detect: many orders and HPOS off. Fix: report; migration is T3 after a compatibility check.
- **WPB-28 Too many image sizes.** Detect: themes and plugins registering many sub-sizes. Fix: stop generating unused sizes for future uploads (T2). This helps uploads and storage, not page speed.
- **WPB-29 Multisite.** Detect: a network install. Fix: run per site; handle network-wide options and tables separately.
- **WPB-30 No headroom for traffic peaks.** Detect: PHP worker count for the hosting plan versus peak traffic; 503 or 504 responses in logs at peak hours. Without page caching every visit runs PHP, so a sale or a viral post can take the site down. Fix: report the risk with numbers; the hosting plan or host-level caching is the client's decision (T3).
- **WPB-31 Redirect rules evaluated in PHP.** Detect: thousands of redirect rules (especially regex) in a redirect plugin, checked on every request. Fix: move permanent rules to the server or CDN, remove dead ones (T2/T3). Verify: every redirect still resolves (SEO guard).

## WPF: WordPress front-end specifics

- **WPF-01 Emoji script.** Detect: `wp-emoji` (a blocking inline script in the head before 6.9; a footer script module in 6.9+). Fix: remove when the site does not need the emoji fallback (T1).
- **WPF-02 oEmbed discovery and wp-embed.** Detect: oEmbed links and the wp-embed script. Fix: remove when the site's posts are not embedded elsewhere (T1).
- **WPF-03 Dashicons for visitors.** Detect: dashicons.css for logged-out users. Fix: dequeue for logged-out users when no front-end element uses it (T1/T2). Verify: icons.
- **WPF-04 Block CSS on pages without blocks.** Detect: `wp-block-library` and related CSS on builder or classic pages with no blocks (check `has_blocks()`, widgets, reusable blocks, patterns in templates). Fix: dequeue only where no blocks render (T2). Classic themes on 6.9+ already load block styles on demand; check before adding code.
- **WPF-05 Global styles on classic or builder themes.** Detect: inline global styles and classic-theme-styles. Fix: keep unless proven unused on every template (T2, high visual risk).
- **WPF-06 Contact Form 7 everywhere.** Detect: CF7 JS and CSS on pages without forms. Fix: `wpcf7_load_js` and `wpcf7_load_css` set to false, then `wpcf7_enqueue_scripts()` and `wpcf7_enqueue_styles()` on pages with forms (T2). Verify: forms submit with validation and the email arrives (staging).
- **WPF-07 WooCommerce assets everywhere.** Detect: WooCommerce CSS, wc-blocks, cart fragments and order attribution scripts on non-shop pages. Fix: limit to shop pages, keeping what the header mini-cart needs (T2). Order attribution: report only, because disabling it loses attribution data (T3). Verify: mini-cart, cart count, add to cart from any page.
- **WPF-08 Elementor.** Detect: CSS print method, Font Awesome 4 support, Google Fonts loading, unused widgets from addon packs, and the site's Features list (for example Optimized Markup, Improved Asset Loading, Improved CSS Loading, Inline Font Icons, Lazy Load Background Images, Flexbox and Grid containers). Read the real option names from the installed version. Fix: turn on one at a time with full verification (T2). Leave Element Caching as it is: it is a cache (CLAUDE.md rule 3).
- **WPF-09 Divi.** Detect: Divi Theme Options performance settings (for example dynamic module framework, dynamic CSS, critical CSS, dynamic icons, deferred jQuery, Google Fonts loading). Fix: tune one at a time (T2).
- **WPF-10 Other builders and themes.** Detect: WPBakery, Beaver Builder, Bricks, Oxygen, Avada, Astra, GeneratePress or Kadence performance settings. Fix: use their built-in performance options first (T2).
- **WPF-11 Slider plugins.** Detect: Slider Revolution, Smart Slider or LayerSlider assets on every page; the slider is the LCP element. Fix: load only on pages with sliders; first slide eager with high priority; recommend a static hero (T2/T3).
- **WPF-12 Addon packs.** Detect: Essential Addons, ElementsKit, Happy Addons, Ultimate Addons and similar loading assets for every widget. Fix: switch off unused widgets in their widget manager after a usage scan (T2).
- **WPF-13 Feature plugins loading everywhere.** Detect: galleries, tables, popups, maps, social share or forms loading on all pages. Fix: load only where used, based on a usage scan of all content, widgets, menus, builder data and templates (T2, SAFE-05).
- **WPF-14 Speculative loading.** Detect: core rules on 6.8+, their mode, eagerness and exclusions (WordPress 7.1 also reads the `WP_SPECULATIVE_LOADING_DEFAULT_MODE` and `WP_SPECULATIVE_LOADING_DEFAULT_EAGERNESS` constants). Fix: add exclusions for cart, checkout, account, logout and add-to-cart URLs (`wp_speculation_rules_href_exclude_paths`); tune eagerness (T1/T2). Without page caching every prefetch is a full PHP render, so stay conservative unless the server has headroom (WPB-30). Verify: no side-effect requests in server logs (SAFE-13); server load not up after the change.
- **WPF-15 Lazy-loading threshold.** Detect: the first content image is lazy because the header logo counted as the first image. Fix: `wp_omit_loading_attr_threshold` or explicit attributes on the hero (T1).
- **WPF-16 Debug assets.** Detect: SCRIPT_DEBUG on, unminified theme files, source assets loaded. Fix: production assets (T1).
- **WPF-17 Parent CSS loaded twice.** Detect: the child theme enqueues the parent style.css again. Fix: one enqueue with the right dependency (T1).
- **WPF-18 Multilingual plugins.** Detect: language switcher assets, flag images, string translation overhead. Fix: a lighter switcher (SVG flags or text), hreflang untouched (T2). Verify: SEO guard.
- **WPF-19 Popups and lead capture.** Detect: OptinMonster, Elementor Popups, Popup Maker and similar loading on page load. Fix: load after a delay or interaction while keeping the client's trigger rules (T2, check with the client). Verify: the popup still appears on its trigger and leads still arrive.
- **WPF-20 Optimization plugins already installed.** Detect: cache, image-optimization or asset-manager plugins (WP Rocket, LiteSpeed Cache, W3 Total Cache, Smush, ShortPixel, Imagify, EWWW, Asset CleanUp, Perfmatters and similar) and which of their features are on. Fix: leave them as they are; map overlaps with SpeedPilot modules and keep overlapping modules off; changing or removing them is T3. Measure TTFB with their page cache served and bypassed. Verify: no double lazy loading, double deferral or double minification in the HTML.
- **WPF-21 Real-visitor LCP tuning available.** Detect: LCP image priority or lazy-loading decisions differ across devices and templates, so one static rule cannot fit them all. Fix: offer the WordPress Performance Team's Image Prioritizer plugin (built on Optimization Detective), which sets priority and lazy loading from real-visitor data; it is not a cache plugin. Use it instead of SpeedPilot's LCP and lazy-loading modules, never both (T2). Verify: LCP element gets high priority on mobile and desktop; no lazy image above the fold.

## SHT: Shopify theme

- **SHT-01 Vintage or outdated theme.** Detect: no JSON templates (not Online Store 2.0), or a theme version behind the latest. Fix: report; an upgrade or migration is a separate T3 project.
- **SHT-02 Parser-blocking scripts.** Detect: Theme Check `ParserBlockingScript`; the `script_tag` filter or a plain `<script src>` in the head. Fix: `<script src="{{ 'x.js' | asset_url }}" defer></script>` after checking inline code that uses it (T1/T2). Verify: console.
- **SHT-03 jQuery in the theme.** Detect: jQuery loaded for a few small features. Fix: plain JavaScript for those features (T2/T3). Verify: every feature that used it.
- **SHT-04 Big global JavaScript.** Detect: Theme Check `AssetSizeJavaScript`; one bundle on every template. Fix: split per section or template (T2).
- **SHT-05 Big global CSS.** Detect: Theme Check `AssetSizeCSS`. Fix: section-level CSS, critical CSS for the first screen (T2).
- **SHT-06 Image markup.** Detect: deprecated `img_url`, fixed large sizes, no `srcset` or `sizes`, Theme Check `ImgWidthAndHeight`. Fix: `image_url` plus `image_tag` with `widths`, `sizes`, width and height (T1).
- **SHT-07 LCP hero.** Detect: hero image lazy, no `fetchpriority`, no preload. Fix: `loading: 'eager'`, `fetchpriority: 'high'`, `preload: true`, once per page (T1).
- **SHT-08 Fonts.** Detect: `font_face` without `font_display`, Google Fonts links in theme.liquid. Fix: FONT-09 (T1/T2).
- **SHT-09 Slow Liquid.** Detect: `shopify theme profile` hot spots: loops over collections or `all_products`, nested loops, large `paginate` sizes, heavy filters inside loops, `render` inside large loops. Fix: refactor (T2). Verify: identical output; render time down.
- **SHT-10 Too many homepage sections.** Detect: 15 or more sections, or a very large DOM on the home page. Fix: report; merge or remove sections with the client (T3).
- **SHT-11 Heavy collection grids.** Detect: 48 or more products per page, hover images loaded eagerly, swatches computed per card. Fix: lazy hover images and lighter cards (T2); products per page is the merchant's call (T3).
- **SHT-12 Heavy product page.** Detect: all media eager, large variant JSON, recommendations rendered synchronously, zoom and lightbox code on load. Fix: lazy media after the first, recommendations loaded after the page, code on interaction (T2). Verify: variant switching, media gallery, add to cart.
- **SHT-13 Search and filters.** Detect: predictive search without debounce; filters re-rendering the whole page. Fix: debounce at 250 to 300 ms; re-render only the results section (T1/T2). Verify: INP while typing and filtering.
- **SHT-14 Cart fetched on every page.** Detect: `/cart.js` or cart section requests on load. Fix: fetch when the drawer opens; keep the header count right (T2). Verify: cart count after add and after back navigation.
- **SHT-15 Remote assets.** Detect: Theme Check `RemoteAsset`; libraries from other CDNs. Fix: theme assets on the Shopify CDN (T2).
- **SHT-16 Too many preloads.** Detect: several `preload: true` or `preload_tag` uses competing with the LCP image. Fix: preload only the LCP image and the main font (T1).
- **SHT-17 Heavy below-the-fold sections.** Detect: long home or product pages. Fix: `content-visibility: auto` with `contain-intrinsic-size` (T2).
- **SHT-18 Liquid errors on the storefront.** Detect: "Liquid error" text in rendered HTML. Fix: fix the template (T1). Verify: no Liquid errors on any sample URL.
- **SHT-19 Speculation rules.** Detect: the platform's `Speculation-Rules` response header (Shopify sends one with conservative prefetch since June 2025) and any theme rules. Fix: add theme rules only where they add value, as in SPEC.md 8.2, with strict exclusions (T2). Verify: no cart, checkout or account URLs prefetched; analytics not fired by prefetches.
- **SHT-20 Undocumented customizations.** Detect: diff against the theme's original version. Fix: document every customization in the report so future theme updates are safe (report).
- **SHT-21 Theme blocks (Horizon-family themes).** Detect: deeply nested theme blocks, block CSS or JS loaded on templates where the block is not used, many blocks on one page. Fix: keep block assets with their blocks, flatten needless nesting with the merchant, lazy-initialize below-the-fold blocks (T2; layout changes T3). Verify: theme editor still works and every block renders.

## SHA: Shopify apps and platform

- **SHA-01 App cost table.** Detect: requests, KB, main-thread ms and pages per app. Fix: report with recommendations.
- **SHA-02 App embeds left on.** Detect: an app embed enabled in settings_data.json for an app that is unused or uninstalled. Fix: turn it off with client approval (T3).
- **SHA-03 Leftover app code.** Detect: snippets, assets and includes from uninstalled apps still rendered. Fix: quarantine, then remove after confirming the app is gone (T2/T3, SAFE-18). Verify: no missing widget, no Liquid error.
- **SHA-04 Overlapping apps.** Detect: two review apps, several popup or upsell apps. Fix: the client chooses one (T3).
- **SHA-05 Client-side translation or currency apps.** Detect: text and prices rewritten after load. Fix: Shopify Markets native features (T3).
- **SHA-06 Page builder apps.** Detect: PageFly, GemPages or Shogun output on key pages. Fix: optimize inside the app (lazy images, fewer elements) or report (T3).
- **SHA-07 Duplicate tracking.** Detect: the same pixel from theme code, an app and Customer Events. Fix: one source, preferably Customer Events or the official channel app (T3). Verify: tracking guard.
- **SHA-08 Dynamic checkout buttons.** Detect: Shop Pay, PayPal or Apple Pay buttons and their SDKs on product pages. Fix: keep them; conversion matters more than a few points. Report the cost.
- **SHA-09 Platform scripts.** Detect: scripts Shopify injects through `content_for_header` (analytics, web pixels manager). Fix: none possible; they set part of the ceiling. Report their measured cost.
- **SHA-10 Redirecting location apps.** Detect: redirects or popups based on visitor location. Fix: Shopify Markets redirection or a non-blocking banner (T3).
- **SHA-11 Legacy ScriptTag apps.** Detect: synchronous scripts injected through ScriptTags. Fix: app settings or vendor support; report (T3).
- **SHA-12 Chat apps.** Detect: Shopify Inbox, Tidio, Gorgias and others loading on page load. Fix: load on interaction if the app allows it, otherwise report (T2/T3).
- **SHA-13 Speed apps already installed.** Detect: "speed booster", lazy-load or instant-page apps injecting their own scripts. Fix: leave them as they are, map overlaps, and keep overlapping SpeedPilot changes off; removal is T3. Verify: no double lazy loading or double prefetching.

## REV: reverse-engineering findings (SPEC.md section 15)

- **REV-01 Script role unknown.** Detect: an X-ray verdict of `unknown` for a script, usually with no matching recipe. Fix: do not defer, delay or remove it; the X-ray drafts a recipe from what it observed, for human review (report). Verify: it is untouched in every change.
- **REV-02 Loads earlier than needed.** Detect: the ideal-versus-actual waterfall shows a resource requested before first paint that the first screen does not use. Fix: defer, async, lazy-load or load per template, by resource type (T1/T2). Verify: visual, console and flows.
- **REV-03 Loads later than needed.** Detect: a resource the first screen needs (LCP image, critical font, critical CSS) is discovered late. Fix: preload or raise its priority (T1). Verify: LCP load delay down; no new "preloaded but not used" warnings.
- **REV-04 Recipe version mismatch.** Detect: the installed plugin, app or theme version is not among the recipe's verified versions. Fix: re-verify the recipe on staging before applying it (T2). Verify: recipe confidence updated.
- **REV-05 Heavy widget with a lightweight alternative.** Detect: a widget costs more than 100 ms of main-thread time or 100 KB, and the X-ray shows simple output (slides, stars, images, tabs). Fix: propose a lightweight replacement written from scratch (SPEC.md 15.8) (T3). Verify: feature parity through flows; visual diff.
- **REV-06 Competitor gap.** Detect: competitors' field LCP or INP is more than 20% better than the client's. Fix: report the gap and what the fastest competitor does differently, in plain words (report).
- **REV-07 Handler-level interaction culprit.** Detect: X-ray handler timing shows one plugin's or app's event handler taking more than 100 ms during an interaction. Fix: debounce, yield, lazy-initialize, or report to the vendor (T2). Verify: INP for that interaction under 200 ms.
- **REV-08 Change fails the what-if simulation.** Detect: the simulator (SPEC.md 15.5) shows no meaningful gain, or shows new console errors, a visual difference or a failed flow for a proposed change. Fix: drop the change from the plan or rework it before it touches staging (report). Verify: the plan shows the simulated gain and the simulation result for every item.

## SAFE: what breaks sites after speed work (check before every change)

Each SAFE item is a guard: the planner attaches the relevant ones to every change, and the verifier checks them.

- **SAFE-01 Deferred library with inline dependents.** "jQuery is not defined" and similar. Guard: use the X-ray safe-change verdict (SPEC.md 15.5), which covers WordPress `before` and `after` inline data and theme inline code; never defer a handle whose dependents run early; a verdict of `unknown` means do not defer. Verify: console on every template.
- **SAFE-02 Delay-until-interaction side effects.** Menus, sliders, add to cart and popups dead until a tap; page_view missing; consent banner late (legal risk); chat not opening. Guard: delay only allowlisted non-critical third parties; never delay first-party UI code, the consent tool, or analytics base tags without the tracking guard.
- **SAFE-03 Critical CSS gaps.** Unstyled flash, layout jumps, missing styles on templates that were not sampled. Guard: generate per template, take an early-paint screenshot, cover every template type.
- **SAFE-04 CSS purging removes state classes.** Open menus, modals, error and validation states, other breakpoints, logged-in views, WooCommerce notices, RTL. Guard: avoid purging; if used, safelist plus interaction flows.
- **SAFE-05 Conditional loading misses pages.** A shortcode, block, widget or builder element used on a page that was not sampled. Guard: scan all published content, widgets, menus, builder data (for example `_elementor_data`) and templates before dequeuing, and check the ownership in the Site Model (SPEC.md 15.4); rules are based on usage, not on the sample.
- **SAFE-06 Lazy loading breaks hidden images.** Images in tabs, sliders, mega menus, lightboxes and print views. Guard: exclusion classes; verify by interaction.
- **SAFE-07 Image URL or format changes break references.** Builder-stored absolute URLs, emails, product feeds (Google Merchant Center), og:image. Guard: keep original files and URLs; add formats instead of replacing; JPEG or PNG for og:image and feeds; check for 404s.
- **SAFE-08 Font changes break icons or brand type.** Empty squares instead of icons; wrong typeface. Guard: visual diff with icon regions unmasked; glyph check.
- **SAFE-09 jQuery Migrate removal breaks old plugins.** Guard: zero `JQMIGRATE` warnings across all flows first.
- **SAFE-10 WP-Cron off without a real cron.** Scheduled posts, emails, subscription renewals and backups stop. Guard: system cron set up and proven (event run times advance) before `DISABLE_WP_CRON`.
- **SAFE-11 Database clean-up deletes needed data.** Transients used as storage, meta used by custom code, revisions the client wanted. Guard: backup, export of deleted rows, only expired or clearly orphaned data, staging first.
- **SAFE-12 Heartbeat off breaks editing.** Post locking, autosave, live admin notifications. Guard: never off in the editor; only slower elsewhere.
- **SAFE-13 Speculative loading with side effects.** Prefetching logout or add-to-cart links logs users out or adds items. Guard: strict exclusions; prefetch rather than prerender for dynamic pages; check server logs.
- **SAFE-14 Back/forward cache shows stale state.** Old cart count or login state after the back button. Guard: refresh the cart count on `pageshow` when `persisted` is true; verify.
- **SAFE-15 Minify or combine breaks scripts.** Syntax errors from automatic semicolon insertion; wrong order. Guard: no file combining (HTTP/2 makes it pointless); minify with source maps; console check.
- **SAFE-16 Too many hints compete with LCP.** Guard: at most 2 or 3 preconnects and one high-priority image.
- **SAFE-17 Shopify drift.** Publishing the work theme erases the merchant's recent edits. Guard: drift check and merge before publish (SPEC.md 5.4).
- **SAFE-18 Shopify snippet still in use.** Removing a snippet an active app needs makes reviews or upsells disappear, which loses revenue. Guard: confirm against the app list and with the client.
- **SAFE-19 Shopify theme switch side effects.** Some apps store the theme ID or need re-activation after a publish. Guard: check every app widget right after publishing; keep the old theme for rollback.
- **SAFE-20 Tracking and consent regressions.** Tags firing before consent (legal risk) or not firing at all (lost data). Guard: tracking guard in both consent states.
- **SAFE-21 SEO regressions.** Head clean-up removes canonical, hreflang, JSON-LD or meta tags; a staging noindex leaks to production. Guard: SEO guard; never copy staging robots settings or configs to production.
- **SAFE-22 Staging side effects.** Emails to real customers, live payments, webhooks, duplicate orders sent to an ERP. Guard: staging neutralization (SPEC.md 5.2) before any test.
- **SAFE-23 Stale caches after a change.** Old CSS with new HTML. Guard: versioned asset URLs (bump `ver`), purge host or CDN cache with approval.
- **SAFE-24 Security tools block automation.** WAF or rate limits ban the test IP, or serve challenge pages that skew results. Guard: slow crawl, allowlisting through the client.
- **SAFE-25 Heavy jobs on production.** Regenerating thumbnails or bulk recompression overloads the server. Guard: staging first, small batches, off-peak.
- **SAFE-26 "While we're here" updates.** Plugin, theme or core updates break things. Guard: no updates unless the approved plan names them; updates are a separate job.
- **SAFE-27 Untested viewports.** Mobile-only menus or elements. Guard: 390, 768 and 1440 px in every verification.
- **SAFE-28 Logged-in views.** My Account, membership content, B2B prices. Guard: logged-in flows in site.yaml.
- **SAFE-29 Untested languages or markets.** Guard: sample each language and market.
- **SAFE-30 Accessibility regressions.** Focus styles or skip links lost in CSS clean-up; facades that keyboards cannot reach. Guard: accessibility score not lower; keyboard check on every facade.
- **SAFE-31 Reverse-engineering limits.** Analysing code the client does not own or has not authorized, copying vendor code into a replacement, or bypassing licence checks creates legal risk for you and the client. Guard: CLAUDE.md rule 16; deep analysis only of the client's own site and the scripts running on it; competitors only through public data and a normal visit; replacements written from scratch.
- **SAFE-32 Switching to a child theme resets settings.** WordPress stores Customizer settings (theme_mods), menu locations and widget areas per theme, so activating a new child theme can make the site look broken. Guard: prefer the mu-plugin; if a child theme is needed, copy theme_mods, menu locations and widgets first (T3); full visual verification.
- **SAFE-33 Backup fills the server disk.** A database export or archive written on a nearly full server can take the site down. Guard: check free space first; stream off the server when space is tight (SPEC.md 5.1).
- **SAFE-34 Writes that slip past the guards.** An ad-hoc script that connects to the site, or a browser automation click in wp-admin or Shopify admin, can change production without any approval. Guard: default-deny hook on Bash and Chrome DevTools MCP input tools, the executor's own approval check, write credentials loaded only for approved runs (SPEC.md 14.1, CLAUDE.md rules 10 and 12).
