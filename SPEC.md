# SpeedPilot build spec

Working name: SpeedPilot (rename freely). Platforms: WordPress and Shopify. Built with Claude Code, following CLAUDE.md.

## 0. What it does

Given a WordPress or Shopify site and access details, SpeedPilot:

1. Collects everything that affects speed: pages, styles, scripts, theme, plugins or apps, third-party tags, fonts, images, video, console and server errors, backend timings, and real-user data.
2. X-rays the site (section 15): what every script needs and touches, the ideal load order versus the real one, which plugin or app owns each part of the page, and how competitors compare.
3. Scores it against CHECKS.md and writes a before report.
4. Takes a backup and proves it restores.
5. Prepares a safe staging copy (WordPress) or work theme (Shopify) and records a verification baseline.
6. Proposes a change plan with risk tiers, and waits for approval.
7. Applies approved changes one at a time while a verification harness proves nothing broke.
8. Deploys to production inside the agreed window, verifies again, monitors, writes the after report with a rollback kit, and adds what it learned to its recipe library.

It never installs a cache plugin and never fakes a score.

Out of scope: Shopify checkout changes, hosting migrations, content rewriting, design changes the approved plan does not name, headless front ends (Hydrogen, Next.js and similar: detect and report only), and any paid service.

## 1. Architecture

### 1.1 Repo layout

```
speedpilot/
  CLAUDE.md  SPEC.md  CHECKS.md  KICKOFF.md  README.md  CHANGELOG.md
  .claude/
    settings.json            # permissions + PreToolUse safety hook
    hooks/guard.mjs          # enforces CLAUDE.md rule 10
    agents/perf-verifier.md  # independent verifier, never edits
    skills/                  # WordPress agent skills (installed in setup)
  packages/
    core/          # config, store, collectors, analyzers, rules engine, planner, executor, verifier
    xray/          # X-ray Engine: our own reverse-engineering engine for speed (section 15)
    cli/           # the `speedpilot` command
    mcp-server/    # MCP tools wrapping the CLI, with safety gates
    report/        # HTML, PDF, JSON and Markdown reports
    wp-agent/      # WordPress mu-plugin (PHP)
    shopify/       # Shopify CLI wrapper, Admin GraphQL reads, Liquid AST transforms
  rules/           # YAML rules generated from CHECKS.md, one file per area
  recipes/         # recipe library per platform: plugins, apps, themes, JS libraries (section 15.6)
  sites/<site>/site.yaml       # per-site config, no secrets
  runs/<site>/<run-id>/        # evidence: lighthouse/ traces/ screenshots/ har/ coverage/ logs/ theme/ reports/
  fixtures/wp/                 # wp-env site with planted problems
  fixtures/shopify/            # Horizon-family theme copy with planted problems
  .env.example
```

### 1.2 Components

| Component | Job |
|---|---|
| core/store | SQLite (better-sqlite3) with migrations: sites, runs, pages, metrics, findings, changes, backups, approvals, verifications |
| core/collectors | Read-only data gathering (section 3) |
| xray | Our own reverse-engineering engine: CDP capture, static analysis of JS, CSS, PHP and Liquid, the Site Model graph, safe-change verdicts, what-if simulator, cost attribution, recipes and learning, competitor benchmark (section 15) |
| core/analyzers | Turn raw data into findings using `rules/*.yaml` (section 4) |
| core/planner | Ordered change plan with tiers, expected gain, risk, verification set and rollback |
| core/executor | Applies approved changes with the apply, measure, verify, keep-or-rollback loop (section 7) |
| core/verifier | Visual, console, network, flows, tracking, SEO, accessibility, backend and performance checks (section 6) |
| cli | All commands (section 10.1) |
| mcp-server | Same commands as MCP tools; write tools need a plan ID and approval token and default to dry run |
| wp-agent | mu-plugin: authenticated diagnostics, feature-flag optimizations, Server-Timing, kill switch (section 8.1) |
| shopify | Theme pull, duplicate, push to work theme, check, profile and publish through Shopify CLI; reads through Admin GraphQL; Liquid AST edits (section 8.2) |
| report | Before, plan, after and comparison reports with branding and an anonymized mode (section 9) |

### 1.3 Data model (minimum)

- **Site**: id, platform, production URL, staging URL, access refs (env var names), flows, masks, thresholds, deploy window, timezone, consent tool, branding.
- **Run**: id, site, type (audit, backup, apply, verify, deploy, monitor), stage (staging, production), tool versions, machine info, start, end, status.
- **PageSample**: URL, template type, device, run index, Lighthouse JSON path, trace path, screenshot paths.
- **Finding**: check ID from CHECKS.md, URLs, evidence (bytes, ms, element, file, owner), metric affected, estimated gain, risk tier, fix strategy.
- **Change**: id, finding IDs, tier, description, implementation (flag key or commit hash), status (proposed, approved, applied, kept, rolled_back), before and after metrics, verification ID, rollback steps.
- **Backup**: id, site, stage, type, location, checksums, restore-tested (yes or no, with run ID).
- **Approval**: plan ID, approved items, approver name, time, approval text.
- **Recipe**: id, platform, target (plugin, app or theme), recognition rules, verified versions, safe optimizations, known breakages, confidence.
- **Outcome**: change ID, check or recipe ID, platform, target and version, simulated gain, before and after metrics, kept or rolled back, reason (section 15.6).
- **Site Model**: X-ray nodes and edges with evidence and confidence, per run (section 15.4).

## 2. Access and inputs

### 2.1 Intake questions (`speedpilot init` writes them into site.yaml as TODOs)

- Written permission: which sites and stages SpeedPilot may test and change, and who signs off.
- Which pages and flows make the business money? Peak hours? Any sale or campaign coming up?
- Which third-party tools must stay (chat, reviews, analytics, ads, heatmaps, email popups)? Which consent tool, and are visitors in the EU or UK?
- Is there a staging site? What is the deploy window? Who approves changes?
- Hosting provider and plan, CDN (Cloudflare or other), and who controls DNS.
- Which cache, image or asset optimization plugins or speed apps are already installed, and does the client want to keep them?
- Tell the client that test page loads come from one IP address and may show in chat dashboards or heatmaps; ask them to mark that IP as internal traffic in GA4 if they want (beacons are aborted anyway, see CLAUDE.md rule 12).

### 2.2 WordPress access (least privilege, in this order of preference)

1. SSH with WP-CLI on staging and production.
2. SFTP plus database credentials.
3. A dedicated admin user `speedpilot` with an Application Password (REST API), plus the SpeedPilot agent mu-plugin.

Host panel access is optional (PHP version, OPcache, logs, staging tool, host backups).

Define WP-CLI aliases `@staging` and `@production` in the project's `wp-cli.yml`. SpeedPilot always calls WP-CLI through an alias, so the safety hook can tell which stage a command touches.

### 2.3 Shopify access

- Collaborator account (preferred) or staff account with theme permissions.
- A Theme Access app password for Shopify CLI (theme-only token).
- Optional custom app with read-only scopes (`read_themes` and read access to products and online store content) for inventory.
- All theme writes go through Shopify CLI. Writing theme files through the Admin API (`themeFilesUpsert`) needs `write_themes` plus an exemption from Shopify, so the tool must not depend on it.
- The storefront password, if the store is password protected.

### 2.4 Optional data sources (all free)

- Google API key with PageSpeed Insights API v5 and Chrome UX Report API enabled.
- GA4 and Search Console read access: choose top pages, and confirm after deploy that traffic and events did not drop.
- Cloudflare read-only API token: settings that affect speed (Rocket Loader, Polish, Brotli, HTTP/3, cache rules).

## 3. Collect (read-only, safe on production)

These collectors measure the site. The X-ray Engine (section 15) reuses their browser sessions where it can and adds the deeper capture and analysis that explains why each number is what it is.

### 3.1 Page inventory and sampling

- Read robots.txt and every sitemap. Classify URLs by template: home, page, post, archive or category, product, collection, cart, search, account or login, 404, landing page.
- Sample set (default 12, configurable): home, top 5 pages by traffic (GA4 or Search Console, otherwise internal links), one URL for every other template, and every URL that carries a business flow. Test each on mobile and desktop.
- Detect variants that change the page: language, currency or market, logged-in versus logged-out, consent granted versus denied.

### 3.2 Lab metrics

- Lighthouse 13.x (pin the latest 13.x release; 13.4.0 shipped in June 2026) through the Node API with chrome-launcher, a clean profile and no extensions. Mobile (default throttling) and desktop (`--preset=desktop`). 5 runs per URL and device; keep the median run by performance score plus min and max. Save JSON and HTML.
- Record FCP, LCP, TBT, CLS, Speed Index and TTFB, and every insight and diagnostic audit present.
- Block only analytics and ad beacon endpoints in every local run (Lighthouse `blockedUrlPatterns`, Playwright route abort after recording the request), never the tag scripts, so third-party cost stays real and the client's data stays clean.
- Password-protected Shopify stores: log in once with Playwright and pass the storefront session cookie to Lighthouse.
- PageSpeed Insights API v5 for public URLs, 3 runs, as a second opinion from Google's servers.
- Build the audit-ID map from the installed Lighthouse version at startup. Lighthouse 13 replaced these audits:

| Old audit ID(s) | Lighthouse 13 insight |
|---|---|
| layout-shifts | cls-culprits-insight |
| redirects, server-response-time, uses-text-compression | document-latency-insight |
| dom-size | dom-size-insight |
| duplicated-javascript | duplicated-javascript-insight |
| font-display | font-display-insight |
| modern-image-formats, uses-optimized-images, efficient-animated-content, uses-responsive-images | image-delivery-insight |
| work-during-interaction | interaction-to-next-paint-insight |
| prioritize-lcp-image, lcp-lazy-loaded | lcp-discovery-insight |
| largest-contentful-paint-element | lcp-phases-insight |
| legacy-javascript | legacy-javascript-insight |
| uses-http2 | modern-http-insight |
| critical-request-chains, uses-rel-preconnect | network-dependency-tree-insight |
| render-blocking-resources | render-blocking-insight |
| third-party-summary | third-parties-insight |
| uses-long-cache-ttl | use-cache-insight |
| viewport | viewport-insight |

Removed with no replacement: first-meaningful-paint, font-size, no-document-write, offscreen-images, preload-fonts, third-party-facades, uses-passive-event-listeners, uses-rel-preload. SpeedPilot must detect those problems itself (CHECKS.md says how). Still separate in 13: unused-javascript, unused-css-rules, unsized-images, non-composited-animations, bootup-time, mainthread-work-breakdown, long-tasks, total-byte-weight, bf-cache. The performance score weights did not change in 13.

### 3.3 Traces (why a metric is slow)

For each sample URL and device, record a performance trace with Chrome DevTools MCP (`performance_start_trace`, `performance_analyze_insight`) or Puppeteer:

- LCP element and its 4 phases: TTFB, resource load delay, resource load duration, element render delay.
- CLS culprits: the element that moved, shift value, cause (web font, image without size, injected content, animation).
- Long tasks and Long Animation Frames with script attribution (URL, function, owner).

Run Chrome DevTools MCP with `--no-performance-crux` for private staging URLs.

### 3.4 Interactions (INP)

Playwright with the `web-vitals` attribution build, 4x CPU slowdown, mobile viewport. Scripted interactions per template: open the mobile menu, open and close an accordion or tab, select a variant, change quantity, add to cart, open the cart drawer, type in search, apply a filter, open a popup or chat facade, submit a form (staging only). Record INP for each interaction with its attribution: input delay, processing time, presentation delay and the script responsible.

### 3.5 Field data

- CrUX API: URL level and origin level, phone and desktop, 75th percentile LCP, INP, CLS, TTFB and FCP. CrUX History API for the trend. Mark "not enough data" when absent. Also read navigation types (the share of back/forward cache restores and prerendered loads) to see whether bfcache and speculation rules work for real visitors.
- Shopify: the admin Web Performance report (real-user Core Web Vitals), exported or screenshotted when the client gives access.
- Reports must say that field data is a 28-day rolling window, so improvements show fully about 4 weeks after deploy.

### 3.6 Resources (per sample URL)

- Every request: URL, type, transfer and decoded size, priority, protocol, render-blocking or not, initiator, cache headers, compression, cookies sent, timing.
- Owner of every request: theme, plugin (from the `/wp-content/plugins/<slug>/` path and the agent's handle map), Shopify app (by domain, app embed or snippet name), first party, or a named third party (use the `third-party-web` dataset).
- JS and CSS coverage (Playwright coverage API, Chromium) after load and after the scripted interactions: used and unused bytes per file.
- Images: intrinsic versus rendered size, format, bytes, `loading`, `fetchpriority`, `srcset` and `sizes`, width and height attributes, above or below the fold, `<img>` or CSS background.
- Fonts: family, weight, style, format, size, `font-display`, preloaded or not, source (self-hosted, Google, Shopify, Adobe), unicode-range.
- Video and iframes: autoplay, poster, preload attribute, embeds (YouTube, Vimeo, Maps, social).

### 3.7 Document and rendering

- HTML size, DOM element count, depth, largest child count, inline CSS and JS bytes, inline JSON size (product JSON, localized script data), number of iframes.
- Render-blocking resources in `<head>`, `@import` chains, unused preloads and preconnects.
- Animations that are not composited, entrance animations on above-the-fold elements, page preloaders that hide content.
- Back/forward cache eligibility and the reasons it fails.
- Removed-audit replacements: `document.write` use, scroll and touch listeners without `passive`, offscreen images loaded eagerly, missing font preloads, embeds that should be facades.

### 3.8 Errors

- Browser: console errors and warnings, uncaught exceptions, unhandled promise rejections, failed requests (4xx, 5xx), mixed content, CSP violations, deprecation warnings, jQuery Migrate warnings. Capture on load and during every flow.
- WordPress: tail of `debug.log` if it exists (never turn on display), server error log if accessible, Site Health status, PHP notices per request on staging.
- Shopify: `Liquid error` strings in rendered HTML, `shopify theme check` errors, 404s for theme assets.

### 3.9 WordPress backend

- Environment: WordPress, PHP, MySQL or MariaDB and web server versions, PHP SAPI, OPcache status and memory, memory_limit, max_execution_time, HTTP/2 or HTTP/3, Brotli or gzip, presence of `object-cache.php` and `advanced-cache.php` drop-ins, Xdebug loaded, WP_DEBUG state, cron constants, multisite.
- WP-CLI on staging: core version, plugins (status, version, update available), themes and parent theme, mu-plugins, drop-ins. Install and run `wp doctor check --all` (wp-cli/doctor-command), and `wp profile stage --url=<url>` plus `wp profile hook --all --spotlight --url=<url>` (wp-cli/profile-command) for every sample URL.
- Database: table sizes and engines, revision count, autoloaded options total and the 20 largest with their owner (by name prefix), expired transients, orphaned postmeta, termmeta and commentmeta, spam and trash comments, Action Scheduler pending, failed and past-due counts and table size, WooCommerce sessions, plugin log tables.
- Cron: every event, overdue events, events scheduled too often, duplicates, and whether WP-Cron or a system cron runs them.
- Slow queries on staging (SAVEQUERIES or Query Monitor headless through its `x-qm-*` headers), each with the plugin or theme function that made it.
- Outgoing HTTP calls made while rendering a page (log `pre_http_request` and `http_api_debug` on staging) and admin-ajax or REST requests fired by the front end.
- Backend speed: timings for the wp-admin dashboard, posts list, editor load and WooCommerce orders list.
- TTFB two ways: through the host cache as visitors get it, and bypassing it (logged-in cookie or a cache-busting query string) to see real PHP render time. Record `x-cache`, `cf-cache-status` and `age` headers.
- Builder and plugin settings that affect speed (Elementor features and performance settings, Divi performance options, WooCommerce settings, addon packs' widget managers), read from the site's options, never assumed.

### 3.10 Shopify backend

- Theme: name, version, role, Online Store 2.0 or vintage, last updated, latest version available, file list with sizes.
- `shopify theme pull` into `runs/.../theme/` (git) for analysis; `shopify theme check --output json`; `shopify theme profile --url <path> --json` for every sample URL (Liquid render time and hot spots), with `--store-password` on password-protected stores.
- `config/settings_data.json`: app embeds and their on or off state. `templates/*.json`: sections per template and their order.
- App inventory inferred from the storefront (script domains, app blocks, app embeds, snippet names), with cost per app: requests, KB, main-thread ms, pages where it loads.
- Leftover code from uninstalled apps: snippets, assets and includes that reference apps which no longer load anything.
- Theme library count (Shopify allows 20 themes) before any duplicate.
- Markets, redirects, and geolocation popups or apps that redirect.

### 3.11 SEO and tracking baseline

- Per sample URL: status code, title, meta description, canonical, robots meta and header, hreflang set, JSON-LD (parsed), Open Graph image, H1, internal link count.
- Tracking: which tags fire on load and on each flow event (GA4 page_view, add_to_cart, begin_checkout; Meta Pixel PageView and AddToCart; GTM container IDs; Google Ads; TikTok; Klaviyo and others), recorded from network beacons in both consent states.

### 3.12 Visual baseline

Full-page screenshots at 390, 768 and 1440 px wide, above-the-fold screenshots, and element screenshots of the header, hero, product form and footer. Mask dynamic regions listed in site.yaml.

## 4. Analyze

- The rules engine reads `rules/*.yaml`, generated from CHECKS.md with the fields: id, platforms, detect (data source and condition), evidence, metric, tier, fix, verify.
- Every finding carries evidence (URLs, files, bytes, ms, element) and an estimated gain on the metric it affects.
- Recipes matched to the site's plugins, apps and theme (section 15.6) add their known safe optimizations and known breakages. The X-ray safe-change verdicts (section 15.5) decide which scripts and styles are safe to touch. The what-if simulator gives a predicted gain before anything is applied. When the learning loop has history for a fix, its measured gain and failure rate replace the estimate.
- Group findings by root cause: one slider plugin can cause LCP, TBT and CLS problems at once.
- Priority: failing mobile Core Web Vitals first (LCP, then INP and TBT, then CLS), then score, then bytes. At equal gain, lower risk first.
- Ceiling estimate: the score the site can reach inside the client's constraints, plus every blocker outside our control with its measured cost (Shopify platform scripts, required third-party tools, consent tool, hosting TTFB).
- Output: the before report (section 9.1) and a draft change plan.

## 5. Backup, staging and drift

### 5.1 WordPress backup (per stage, before any write)

- Database: `wp db export` with `--single-transaction --quick` for InnoDB tables, plus a per-table row count and checksum list.
- Files: `wp-content` (without cache folders), `wp-config.php`, `.htaccess` or the Nginx site config, `.user.ini` or `php.ini` overrides. SHA-256 for every archive.
- Manifest JSON: WordPress and PHP versions, plugins with versions, active theme and parent, key options (siteurl, home, permalink_structure, active_plugins, builder settings), cron list, mu-plugins, drop-ins.
- Before writing anything on the server, check free disk space. If the backup would leave less than 20% free, stream it straight off the server instead.
- Stored off the server (local disk, plus the client's cloud storage if they want). A host snapshot is an extra layer when the host offers one.
- Verification (required for production backups): restore into local wp-env or the staging site and run the smoke flows. Only then mark the backup `verified`. For very large media libraries, restore the database and code fully and verify uploads against a checksum manifest instead of restoring every file.

### 5.2 WordPress staging

- Use the host's staging tool when there is one; otherwise clone to a staging subdomain or local wp-env.
- `wp search-replace` production URL to staging URL with `--all-tables --precise`, dry run first.
- Neutralize staging so it cannot touch the business:
  - Block outgoing email (`pre_wp_mail` returns false) or route it to Mailpit.
  - Switch payment gateways to test mode.
  - Pause webhooks and integrations (CRM, ERP, Zapier, Klaviyo, Mailchimp, inventory sync).
  - Stop cron events and Action Scheduler jobs that call outside services.
  - noindex plus HTTP basic auth.
  - Block analytics beacons at the network layer during tests so the client's data is not polluted, while still recording that they fired.

### 5.3 Shopify backup and work theme

- Check the theme count first. If the library is full (20), ask the client which theme to remove. Never delete one yourself.
- `shopify theme pull --theme <live-id>` into git, tagged `backup-<date>`.
- Duplicate the live theme (`shopify theme duplicate`, or Admin GraphQL `themeDuplicate` on API 2025-10 or newer) as `SpeedPilot backup <date>`, which is never edited, and again as `SpeedPilot work <date>`, where changes go.
- Save `settings_data.json`, `templates/*.json`, locales, app embed states and the live theme ID in the backup manifest.
- Verified means: the backup theme's files match the git snapshot (checksums) and the backup theme previews without Liquid errors.
- Preview the work theme with `?preview_theme_id=<id>`. The preview bar can no longer be hidden (Shopify removed that option in 2025), so block its requests during lab runs and treat preview numbers as indicative. Final numbers come from the published theme.
- For risky experiments use a free development store with a copy of the theme and sample products.

### 5.4 Drift control (both platforms)

- Before deploying, compare production now with the snapshot the work started from. WordPress: plugin versions, active plugins, theme files, key options. Shopify: live theme files, especially `settings_data.json` and `templates/*.json`.
- If the client changed something in the meantime, merge it into the work copy first and verify again. Never publish a work theme that would erase their edits.

## 6. Verify (the proof that nothing broke)

Runs on the baseline, after every change (quick set on affected URLs) and around every deploy (full set). A change is kept only if every check passes.

| Check | Pass rule |
|---|---|
| Visual | Screenshot difference per URL and viewport within threshold (default 0.1% of pixels outside masked regions, with anti-aliasing tolerance). No flash of unstyled content in an early-paint screenshot taken at first contentful paint. |
| Console | No new error or warning signatures compared with baseline (normalize URLs, query strings and line numbers). |
| Network | No new 4xx or 5xx, no new mixed content, no new CSP violations, no missing fonts or images. |
| Flows | Every flow in site.yaml passes (list below). |
| Tracking | The same beacons are attempted for each event and consent state as in the baseline (names and counts). Beacons are recorded, then aborted. |
| SEO | Status code, title, meta description, canonical, robots, hreflang, JSON-LD and OG image identical. |
| Accessibility | Lighthouse accessibility score not lower; images keep alt text; facades reachable by keyboard. |
| Backend | No new PHP warnings or fatals, no new Liquid errors, cron and Action Scheduler queues healthy, admin pages load. |
| Performance | No sample URL worse than baseline beyond noise. Defaults on the median: LCP +10%, TBT +50 ms, CLS +0.02, score -3. |

Flows (configurable per site):

- Navigation: desktop menu, mobile menu, mega menu, footer links.
- Search: typing, suggestions, results page.
- Forms: contact, quote, newsletter, popup lead form. Submit on staging only; on production only a client-approved test entry marked TEST.
- WooCommerce: add to cart (simple and variable product), update cart, apply coupon, mini-cart, checkout page loads with its payment methods. A full test order only on staging with test gateways.
- Shopify: variant select, add to cart, cart drawer or page, quantity change, go to checkout and stop on the checkout page. Full test orders only on a development store or with client approval.
- Accounts: login, logout, register (staging).
- Switchers: language, currency or market.
- Components: sliders, tabs, accordions, modals, lightboxes, filters, infinite scroll, map and video facades (click to load).

The `perf-verifier` subagent runs verification and writes its own verdict. It never edits code.

## 7. Plan, apply, deploy, rollback, monitor

### 7.1 Plan

- Each item: id, finding IDs, what changes, where (URLs or templates), tier, expected gain, verification set, rollback step, dependencies.
- Tiers: **T1** low risk and reversible; **T2** medium risk, staging plus full verification; **T3** needs written client approval.
- T3 always includes: removing or replacing a plugin or app, theme updates, PHP upgrades, tracking changes, design changes (removing a hero slider or preloader), server or CDN config, WooCommerce HPOS migration, database engine or index changes.
- `speedpilot approve <plan-id> --stage staging|production --items ... --by "<name>"` writes the approval record and the approval file the safety hook checks. The executor refuses any item without one for that stage.
- Operations that write before a plan exists (staging preparation, restore tests on a staging server) get their own one-time approval: `speedpilot approve staging-prep --site <site> --stage staging --by "<name>"`.
- Only the human runs `speedpilot approve`, in their own terminal (SPEC 14.1).

### 7.2 Apply loop (staging or work theme)

For each approved item, in plan order:

1. Confirm today's backup exists for this stage (a verified backup for production, a snapshot for staging).
2. Apply the item (one flag or one commit).
3. Purge only the staging caches needed to see the change.
4. Quick verification on the affected URLs: 3 metric runs, visual, console, network and the affected flows.
5. Keep it if everything passes and the target metric improved; otherwise roll it back and record why.
6. Save the evidence and the flag state or commit hash.

### 7.3 Deploy to production

- Fresh production backup, drift check, deploy window check, client notified.
- WordPress: deploy the agent, its exported flag config, child-theme commits and scripted database steps. Never copy the staging database. Database steps run in small batches inside the window, right after the fresh backup, and never hold long table locks. If a persistent object cache exists, flushing it is an explicit, approved deploy step, because option and autoload changes may not take effect until it is flushed.
- Shopify: merge drift into the work theme, verify again, publish it with `shopify theme publish`, and keep the previous live theme unpublished as the instant rollback. Check app embeds and app widgets right after publishing.
- Purge host or CDN caches only with approval. Run the full verification on production at once.
- WordPress changes go live as one batch of flags. If production verification fails, switch flags off one at a time in reverse order until it passes, then keep the culprit off and log it.

### 7.4 Rollback kit (written into every after report)

- One change: turn its flag off or revert its commit.
- Everything on WordPress: set `define('SPEEDPILOT_DISABLE', true);` in wp-config.php, or rename the mu-plugin file over SFTP if wp-admin is down.
- Everything on Shopify: publish the previous theme by ID.
- Database: run the undo step of the scripted change. A full database restore is the last resort and needs client consent, because it loses orders, users and form entries made since the backup.

### 7.5 Monitor

- First 72 hours: PHP and console error rates, 404s, form and order counts compared with the same days the week before, tracking event counts, and Search Console errors when access exists.
- Day 7 and day 28: CrUX field data compared with the baseline.
- Optional (T3, because it changes tracking): send web-vitals measurements to the client's GA4 as events, for real-user feedback sooner than CrUX's 28-day window.

## 8. Platform engines

### 8.1 WordPress agent (mu-plugin `speedpilot-agent`)

- Loads early and does nothing unless a flag is on. Flags live in one small option (or a JSON file in `uploads/speedpilot/`), versioned, exportable and importable.
- Overhead budget: under 2 ms and zero extra database queries per request, proven by tests. When it must rewrite HTML, it uses the WordPress 6.9+ template enhancement output buffer (`wp_template_enhancement_output_buffer`) instead of its own `ob_start()`, so it does not fight other plugins' buffers; on older versions it uses the smallest possible buffer and is tested against the site's other buffering plugins.
- Prefer the mu-plugin over a child theme. If a child theme is truly needed, switching to it is T3: copy the parent theme's theme_mods (Customizer settings), menu locations and widget areas first, then verify (SAFE-32).
- Kill switch: `SPEEDPILOT_DISABLE` constant. Logged-in admins can compare with `?speedpilot=off`; this never works for the public.
- Diagnostics, authenticated by Application Password plus the `manage_options` capability, or by an HMAC token that expires in minutes:
  - per-URL list of enqueued script and style handles with source, version, dependencies, strategy, position and inline code attached;
  - environment info, autoload stats, cron list;
  - a `Server-Timing` header with stage timings, only for token-authenticated requests.
- WordPress 6.9+: also register the read-only diagnostics as Abilities (Abilities API) so an MCP adapter can call them. Skip on older versions.
- Admin page under Tools: active flags, last run, change log, kill switch. Nothing else.
- Optimization modules (each one a flag with per-template or per-URL rules):
  - **Asset control**: dequeue or deregister handles that are provably unused on a template (see CHECKS SAFE-05); add `defer` or `async` with the WordPress 6.3+ strategy data (`wp_script_add_data( $handle, 'strategy', 'defer' )`) only when the X-ray safe-change verdict (section 15.5) is `safe`; script `fetchpriority` on 6.9+; move to footer.
  - **LCP**: keep the LCP image out of lazy loading, add `fetchpriority="high"`, preload it with `imagesrcset` and `imagesizes` through `wp_preload_resources`.
  - **Alternative LCP engine**: the WordPress Performance Team's Image Prioritizer plugin (built on Optimization Detective) sets LCP priority and lazy loading from real-visitor data. It is not a cache plugin. If the client prefers it, use it instead of SpeedPilot's LCP and image lazy-loading modules, never both (WPF-21, T2).
  - **Images**: add missing width and height from attachment metadata through `wp_content_img_tag`; lazy-load below-the-fold images and iframes; `sizes="auto"` where core supports it (6.7+); modern formats for new sizes through `image_editor_output_format` and a staged `wp media regenerate --skip-delete`, so old files and every URL that points at them keep working.
  - **Existing optimization plugins**: detect cache, image-optimization and asset-manager plugins already installed (WP Rocket, LiteSpeed Cache, Smush, ShortPixel, Imagify, EWWW, Asset CleanUp, Perfmatters and similar). Leave them as they are, map which of their features overlap with SpeedPilot modules, and keep the overlapping SpeedPilot modules off unless the approved plan changes their settings (T3).
  - **Fonts**: self-host Google Fonts (woff2, only used weights and subsets), `font-display: swap`, preload at most 2 critical fonts, fallback metric overrides (`size-adjust`, `ascent-override`, `descent-override`) to cut CLS.
  - **Core extras**: emoji script, oEmbed discovery and wp-embed, dashicons for logged-out visitors, jQuery Migrate (only with zero migrate warnings across all flows), block library CSS on pages without blocks, Heartbeat (front end off when unused, admin interval 60 s, never off in the editor), comment-reply only where comments are open.
  - **Third parties**: load on first interaction or idle for an allowlist only, never before consent where a consent tool exists; click-to-load facades for YouTube, Vimeo and Google Maps.
  - **CSS**: critical CSS per template (generated on staging with `beasties` or `critical`), full stylesheet loaded async (print-media swap plus noscript), regenerated whenever the theme changes; remove whole files that coverage proves unused on a template; selector purging only with a safelist and interaction verification.
  - **Resource hints**: preconnect only to 2 or 3 critical origins, dns-prefetch for the rest, remove unused preloads and preconnects.
  - **Speculative loading**: tune core rules on 6.8+ or add rules on older versions. WordPress 7.1 adds the `WP_SPECULATIVE_LOADING_DEFAULT_MODE` and `WP_SPECULATIVE_LOADING_DEFAULT_EAGERNESS` constants; the `wp_speculation_rules_configuration` filter overrides them; exclusions go through `wp_speculation_rules_href_exclude_paths`. Always exclude cart, checkout, my-account, logout, add-to-cart links and URLs with query strings. Without page caching every prefetch is a full PHP render, so keep eagerness conservative unless the server has headroom (WPB-30), and measure server load after any change. Prefer prefetch; use prerender only after checking analytics and side effects.
  - **Plugin-specific**: Contact Form 7 assets only on form pages (`wpcf7_load_js` and `wpcf7_load_css` filters, then `wpcf7_enqueue_scripts()` where a form exists), WooCommerce assets and cart fragments only where needed, unused widgets in addon packs switched off, builder performance features turned on one at a time after testing.
  - **Backend**: autoload off for large options not needed on every request (`wp_set_option_autoload()`, 6.4+); expired transients cleanup; revision cap and cleanup; Action Scheduler retention (`action_scheduler_retention_period`); a real system cron instead of WP-Cron (only with server access, after confirming scheduled jobs run); slow theme queries fixed in the child theme; front-end admin-ajax polling removed; results of outgoing API calls stored in a transient or moved to cron.
  - **Server snippets** (report, or apply with approval): long `Cache-Control` with `immutable` for versioned static files, Brotli or gzip, HTTP/2 or HTTP/3, no `no-store` on HTML unless required. These are server headers, not a cache plugin.

### 8.2 Shopify engine (work theme only, through Shopify CLI)

- Transforms run on the Liquid AST and are committed one per change.
- Push only to the work theme: `shopify theme push --theme <work-theme-id> --nodelete --only <changed files>`. Never `--live` or `--allow-live`.
- Parser-blocking scripts (`script_tag` filter or a plain `<script src>` in `<head>`) get `defer` only when the X-ray safe-change verdict (section 15.5) is `safe`.
- Images: `image_url` with widths and `image_tag` with `widths` and `sizes`. The LCP image gets `loading: 'eager'`, `fetchpriority: 'high'` and `preload: true` once per page. Everything below the fold is lazy. Replace the deprecated `img_url`.
- Fonts: `font_face` with `font_display: 'swap'`, preload the main font (`<link rel="preload" as="font" type="font/woff2" crossorigin>`), fewer weights, remove external font files the theme does not need.
- CSS: section CSS loaded with its section, smaller global CSS, non-critical CSS loaded async.
- JS: dedupe libraries, lazy-init sliders and below-the-fold components with IntersectionObserver, idle-load non-critical code, debounce predictive search and filters, fetch the cart only when the drawer opens.
- Liquid: fix the hot spots `theme profile` shows (loops over large collections, `all_products`, nested loops, oversized `paginate`, `render` inside large loops).
- Apps: cost table per app; switch off app embeds for apps that are no longer used (client approval); remove leftover snippets of uninstalled apps (after confirming); move tracking to Customer Events pixels (client approval). Never edit or strip anything inside `content_for_header`.
- Media: hero video becomes a poster image plus lazy video; YouTube and Vimeo get facades.
- Heavy below-the-fold sections: `content-visibility: auto` with `contain-intrinsic-size`, verified for CLS and anchor links.
- Horizon-family themes (Shopify's current free themes) build pages from nested theme blocks: check nesting depth and per-block CSS and JS, and keep block assets loading only where the block is used (SHT-21).
- Speculation rules: since June 2025 Shopify sends a platform-wide `Speculation-Rules` header (prefetch, conservative eagerness) for Liquid storefronts. Read that header first. Add theme rules only where they add value: moderate-eagerness prefetch for product and collection links, with strict exclusions, and prerender only for a few high-confidence links after checking analytics behaviour. Example:

```html
<script type="speculationrules">
{
  "prefetch": [{
    "source": "document",
    "where": { "and": [
      { "href_matches": ["/products/*", "/collections/*", "/*/products/*", "/*/collections/*"] },
      { "not": { "href_matches": ["/cart*", "/checkout*", "/account*", "/*/cart*", "/*/checkout*", "/*/account*", "/*\\?*"] } },
      { "not": { "selector_matches": "[rel~=nofollow], .no-prefetch" } }
    ] },
    "eagerness": "moderate"
  }]
}
</script>
```

## 9. Reports and grades

### 9.1 Before report

- Page 1 in plain words: grade, Core Web Vitals pass or fail (field and lab), the 5 biggest problems with what each costs, what fixing them should achieve, and the risks.
- Details: per-page metrics (median and range), LCP element and phases, CLS culprits, slowest interactions, top scripts by main-thread time, third-party and app cost table, unused CSS and JS, image and font findings, backend findings (TTFB, PHP render time, slow queries, autoload, cron), every error found, the ideal versus actual waterfall, the competitor table, the ceiling estimate with blockers, and the draft plan.

### 9.2 After report

The same structure, plus: before and after tables with deltas, side-by-side screenshots and filmstrips, the change log (what, where, why, flag or commit, rollback), verification results, remaining blockers with the client's options, the field-data note with re-check dates, backup IDs and the rollback kit.

### 9.3 Formats

- Self-contained HTML, PDF (Playwright print), JSON, and a short Markdown summary that can be pasted into a client message.
- Branding from site.yaml (name, logo, colours).
- Anonymized mode removes client name, domain and logos for portfolio use.
- No paid API calls: plain-language text comes from templates. When SpeedPilot runs through Claude Code, Claude can write extra narrative from the JSON.

### 9.4 Grades (every key template, median of 5 runs)

The grade is the highest row whose every condition is met.

| Grade | Rule |
|---|---|
| AAA+++ | Mobile 95+ and desktop 98+; lab LCP 1.8 s or less, TBT 100 ms or less, CLS 0.05 or less; every tested interaction 200 ms or less; field Core Web Vitals all good (or not enough data yet) |
| AA | Mobile 90+ and desktop 95+; lab LCP 2.5 s or less, TBT 200 ms or less, CLS 0.1 or less; interactions 200 ms or less |
| A | Mobile 75+ |
| B | Mobile 50+ |
| C | Mobile below 50 |

A grade counts only when the safety result is PASS: 0 broken flows, 0 new errors, 0 SEO or tracking regressions. A safety failure means the change is rolled back and the report says so.

## 10. Interfaces

### 10.1 CLI

```
speedpilot init <site>                       # site.yaml with intake TODOs
speedpilot access check <site>               # read-only probe of every credential
speedpilot audit <site> [--stage production|staging]
speedpilot report before <site>
speedpilot backup <site> --stage <stage>
speedpilot backup verify <site> --id <backup-id>
speedpilot staging prepare <site>            # WP clone + neutralize, or Shopify work theme
speedpilot baseline <site> --stage <stage>   # verification baseline
speedpilot plan <site>
speedpilot approve <plan-id> --stage <stage> --items <ids> --by "<name>"   # human only
speedpilot apply <plan-id> --stage staging
speedpilot verify <site> --stage <stage> [--full]
speedpilot deploy <plan-id>                  # production: window, drift and backup checks first
speedpilot report after <site>
speedpilot rollback <site> --change <id> | --all
speedpilot monitor <site> --days 3
```

### 10.2 MCP server

- Read-only tools: audit, get_findings, get_metrics, compare_runs, get_report, list_backups.
- Write tools: backup, prepare_staging, apply_change, rollback, deploy. They need `plan_id` and an approval token, default to dry run, and return evidence paths.
- Register with `claude mcp add speedpilot -- node packages/mcp-server/dist/index.js`.

### 10.3 site.yaml (validated with zod)

platform; production and staging URLs; access (env var names only); sample URL overrides; flows (Playwright steps); masks (CSS selectors); never-delay allowlist (scripts that must load normally); thresholds; deploy window and timezone; campaigns and peak hours; consent tool and regions; branding; report language.

## 11. Stack, tests, fixtures

- Node 22.19+, TypeScript strict, pnpm, vitest, Playwright, lighthouse (pinned 13.x), chrome-launcher, web-vitals (attribution build), third-party-web, beasties or critical, postcss, parse5 or cheerio, acorn, @shopify/liquid-html-parser, better-sqlite3, yaml, zod, pino, @modelcontextprotocol/sdk. For the X-ray Engine also: source-map, php-parser, Retire.js signatures, mockttp and cytoscape.
- Licences: only MIT, Apache-2.0, BSD or ISC dependencies, checked in CI, so the tool can be sold later.
- PHP mu-plugin: PHP 7.4+ syntax, WPCS, PHPUnit inside wp-env.
- `fixtures/wp`: wp-env site with WooCommerce, Elementor, Contact Form 7, a slider plugin, sample content and products, and planted problems: lazy-loaded hero image, unsized images, Google Fonts with 6 weights, render-blocking scripts in head, CF7 assets on every page, cart fragments on every page, a slow query in the theme, about 2 MB of autoloaded options, a YouTube embed, a chat-widget-like script, an entrance animation on the hero, a page preloader, an inline script that depends on jQuery, and a click handler that blocks the main thread for about 300 ms.
- `fixtures/shopify`: copy of a current Shopify theme (Horizon family; add Dawn as a second fixture if time allows) for a free development store with planted problems: parser-blocking `script_tag` in theme.liquid, oversized hero image without fetchpriority, a leftover app snippet, an external font with 6 weights, a loop over a large collection, an app-like script injected in theme.liquid, and an inline script that depends on a global defined by the parser-blocking script.
- A phase is done only when it runs green on both fixtures and its before and after numbers are saved.

## 12. Security and privacy

- `.env` is git-ignored; site.yaml holds env var names only; logs and reports redact tokens, passwords, cookies and customer data.
- Least privilege: read-only access first, write access only for the apply and deploy phases, revoked after the job.
- Agent endpoints are authenticated and capability-checked; there are no public toggles; HMAC tokens expire in minutes.
- PageSpeed Insights and CrUX only ever receive public URLs.
- No customer personal data in `runs/`: mask account pages in screenshots and never store order data.
- Backups contain customer data: encrypt them at rest, keep them only as long as agreed with the client (default 30 days), and never upload them to third-party storage without the client's consent.
- HAR files and network logs: strip cookies, Authorization headers and tokens before saving.
- Credentials by stage: read-only access (including a read-only database user where possible) for audits; write credentials are loaded only inside `speedpilot apply` and `speedpilot deploy`, after the approval check.

## 13. What the tool must say honestly

- Lighthouse scores move by about 5 points between runs, which is why every number is a median of 5 with its range.
- 100 is the aim, not a promise. Shopify's own platform scripts, third-party tools the client requires, consent tools and slow hosting can set a ceiling. The report names each one, with its measured cost and the options.
- Field data needs up to 28 days to show the change.
- Without page caching, WordPress TTFB depends heavily on hosting, so the report shows PHP render time separately and says where the time goes.

## 14. Claude Code setup inside the repo

### 14.1 Safety hook

`.claude/settings.json` registers PreToolUse hooks for Bash commands and for the Chrome DevTools MCP input tools. Both run `node .claude/hooks/guard.mjs`, which reads the tool input JSON from stdin and exits with code 2 and a reason on stderr when the call is blocked (CLAUDE.md rule 10).

- Stage detection: WP-CLI alias (`@staging`, `@production`), SSH host, database host, Shopify store and theme ID (work theme versus live theme, recorded in the site state), or SpeedPilot's `--stage` argument. Local fixtures (wp-env, `fixtures/`) are exempt. Anything it cannot place counts as production.
- Remote stages are default-deny. Allowed without approval: read-only WP-CLI (`core version`, `plugin list`, `theme list`, `option get` and `option list`, `cron event list`, `db size`, `db tables`, `doctor`, `profile`), `wp db export` only through SpeedPilot's backup command (which checks disk space first), read-only SQL (SELECT, SHOW, EXPLAIN), `shopify theme list`, `pull`, `check`, `profile` and `info`, and read-only shell commands on an allowlist (for example `df`, `du`, `ls`, `tail` of log files, `php -v`). `wp eval` and `wp eval-file` are never on the allowlist, because they can run any code. Everything else needs an approval file.
- An approval file is `runs/<site>/approvals/<plan-id or operation>.<stage>.json`. It must match the command's site and stage and be less than 24 hours old.
- Always blocked: `shopify theme push` with `--live` or `--allow-live`, a push to any theme other than the recorded work theme, `rm -rf` outside `runs/`, `git push --force`, and any command that prints `.env` or its keys.
- `speedpilot approve` is always blocked inside Claude Code. Approvals are typed by the human in their own terminal, so Claude can never approve its own work.
- Chrome DevTools MCP input tools (click, click_at, fill, fill_form, type_text, press_key, drag, upload_file, handle_dialog) are blocked unless `runs/<site>/state.json` says the current target is local or staging.
- Defense in depth: SpeedPilot's executor checks the approval file itself before every write, and write credentials are loaded only inside `speedpilot apply` and `speedpilot deploy`, so a script that slips past the hook still cannot write.

Also add permission deny rules for reading `.env`. Confirm the hook format against the current Claude Code hooks documentation, and test both blocked and allowed examples.

```json
{
  "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node .claude/hooks/guard.mjs" } ] },
      { "matcher": "mcp__chrome-devtools__.*", "hooks": [ { "type": "command", "command": "node .claude/hooks/guard.mjs" } ] }
    ]
  }
}
```

### 14.2 Verifier subagent

`.claude/agents/perf-verifier.md`:

```markdown
---
name: perf-verifier
description: Independently verifies a SpeedPilot change, phase or deploy. Use after every change and before saying a phase is done. Never edits code or sites.
tools: Read, Grep, Glob, Bash
---
You verify work you did not write. Read CLAUDE.md, SPEC.md section 6 and the change's evidence.
Run the verification commands and tests yourself; do not trust earlier output.
Check every pass rule in SPEC.md section 6 and every CLAUDE.md rule that applies.
Never edit files, never run write commands against any site.
Reply with PASS or FAIL, then each failed check with its evidence path and the smallest fix.
```

## 15. X-ray Engine (our own reverse-engineering engine for speed)

Purpose: SpeedPilot's own reverse-engineering engine, built only for website speed work on WordPress and Shopify. It works out how every script, style, font, image, plugin, app, theme part, hook and query on a site really behaves, so the planner can apply more fixes safely, predict their gain before touching any site, and never guess. It lives in `packages/xray`, has its own CLI and a small MCP tool set, and runs locally with free tools. CLAUDE.md rule 16 sets its limits.

### 15.1 Goal and quality bar

- Never a false "safe". Every verdict is `safe`, `unsafe` or `unknown`, with evidence. `unknown` means SpeedPilot does not touch it. On the fixture suite the number of false "safe" verdicts must be zero (a CI gate, see 15.10).
- Runtime evidence first, static analysis second; both are stored per graph edge with a confidence.
- Small, light interface: at most 10 MCP tools, each answer under 20 KB with paths to evidence files, so Claude's context stays free (REA exposes about 170 tools).
- Fast: static results cached by file hash; a deep X-ray of 12 URLs on mobile and desktop finishes in under 45 minutes on a normal laptop.
- Free, with clean licences: only MIT, Apache-2.0, BSD or ISC dependencies, so SpeedPilot can be sold later.

### 15.2 Capture (runtime, through the Chrome DevTools Protocol)

For every sample URL, device and state (logged-out and logged-in, consent denied and granted, each language or market):

- **Scripts**: every parsed script, including inline, injected and eval'd ones (`Debugger.scriptParsed`), with its source and source map when available.
- **Network**: every request with its initiator stack (`Network.requestWillBeSent`), so each request is tied to the script or stylesheet that caused it.
- **Main thread**: a performance trace plus a CPU profile (`Profiler`), Long Animation Frames with script attribution, and layout shifts with their source elements.
- **Code use**: function-level JS coverage with call counts (`Profiler.startPreciseCoverage`) and rule-level CSS usage (`CSS.startRuleUsageTracking`), after load and after each interaction state.
- **Behaviour**, through an init script that runs before any page script: globals each script defines and reads, `addEventListener` registrations with handler timings, jQuery ready and delegated handlers, timers and polling, `fetch` and XHR, `document.write`, synchronous XHR, MutationObserver use, and the first DOM changes each script makes. After load, read the listeners actually attached to interactive elements (`DOMDebugger.getEventListeners`) with their script and line.
- **Exploration**: find interactive elements from the accessibility tree (menu toggles, tabs, accordions, carousel controls, `details`, elements with `aria-expanded`) and exercise them, so coverage reflects real use. On staging every safe-listed interaction runs. On production only the safe list runs, and never anything that submits a form, logs out, buys, pays, deletes or subscribes.
- **HAR export**, with cookies, Authorization headers and tokens stripped.

### 15.3 Static analysis

- **JavaScript** (acorn or @babel/parser, with source maps): globals defined and used, DOM selectors queried, event types, network endpoints, timers, `document.write`, jQuery plugin registrations, and dependencies on `wp.*`, `jQuery`, `Shopify.*` and theme globals. Detect bundles (webpack, Rollup and Vite chunk patterns) and known libraries with versions from the recipe fingerprints plus Retire.js signatures, which also flag vulnerable library versions.
- **CSS** (postcss): selectors per file, `@font-face`, `@import` chains, rules that no template uses.
- **PHP for WordPress** (`php-parser`, on the active theme and active plugins only): enqueue calls with handles, dependencies and conditions; callbacks on `wp_head`, `wp_footer`, `init` and `template_redirect`; heavy patterns (`posts_per_page => -1`, `orderby => rand`, large `meta_query`, queries inside loops, `wp_remote_get` on front-end hooks, `session_start()`, cookies set for every visitor, `no-cache` headers, extra output buffering).
- **Liquid for Shopify** (`@shopify/liquid-html-parser`): the render tree from layout to templates, sections, blocks and snippets; loops over large collections and `all_products`; nested loops; asset tags (`script_tag`, `stylesheet_tag`, `img_url`); app blocks and app snippets.

### 15.4 Site Model (one graph per run)

- SQLite tables for nodes and edges. Node types: page, template, element, script, stylesheet, CSS rule group, font, image, request, handler, hook, query, Liquid file, plugin, app, theme, third party. Edge types: loads, initiates, defines, uses, depends-on, listens, touches, styles, renders, owned-by, costs.
- **Ownership**: every request, file, handler, hook and query is resolved to an owner (theme, a named plugin, a named app, a named third party, or first party) from WordPress paths and the agent's handle map, Shopify app domains, app blocks and snippets, and the third-party dataset.
- Every edge stores its evidence (runtime, static, recipe, optional REA) and a confidence.

### 15.5 Analyses the planner uses

- **Safe-change verdicts**: for each script and stylesheet on each template, is it needed before first paint, before DOMContentLoaded, only after an interaction, or never? From that comes `safe`, `unsafe` or `unknown` for: defer, async, delay until interaction, load only on some templates, or remove from a template. The proof is the inline scripts, other scripts and attached listeners that need it.
- **Ideal versus actual waterfall**: the minimum the first screen needs (HTML, used CSS rules, fonts above the fold, the LCP image, first-screen scripts), compared with what really loads and when (REV-02, REV-03). The report shows both waterfalls side by side.
- **What-if simulator**: before a change touches any site, run the page through a local rewriting proxy (for example `mockttp`) that applies the change to the responses: add `defer`, add a preload, drop a script for that template, serve a resized image. Measure baseline and variant through the same proxy (5 runs each) and run the quick verification on the variant. Output: predicted gain with a range, plus early breakage signals (REV-08). This is for measurement only, never served to visitors, and always labelled "simulated"; real numbers come from staging.
- **Cost attribution**: main-thread ms, bytes, requests, layout shift and interaction delay per owner, as a table and a treemap.
- **Interaction deep dive**: for each slow interaction, the handlers that ran (owner, file, line), the long tasks and Long Animation Frames, and how much was input delay, processing and presentation (REV-07).
- **Backend mapping**: WordPress hook timings (agent Server-Timing and `wp profile` on staging), slow queries and outgoing HTTP calls tied to the owning plugin or theme function; Shopify `theme profile` hot spots tied to the section, block or snippet.

### 15.6 Recipes, fingerprints and learning

- `recipes/<platform>/<name>.yaml` for each plugin, app, theme and common JS library: how to recognize it (handles, file paths, domains, class names, globals, signatures), versions verified, which assets it needs on which page types, inline dependencies, safe optimizations with tiers, known breakages, verification steps.
- Seed recipes for the most common items. WordPress: WooCommerce, Elementor and Elementor Pro, the main Elementor addon packs, Contact Form 7, WPForms, Gravity Forms, Yoast, Rank Math, Slider Revolution, Smart Slider, WPML, Polylang, Jetpack, Site Kit, MonsterInsights, and the themes Astra, GeneratePress, Kadence, Hello Elementor, Divi, Avada. Shopify: Horizon-family themes and Dawn, Judge.me, Klaviyo, Yotpo, Loox, PageFly, GemPages, Shopify Inbox, Tidio, Weglot, Recharge, Rebuy, Vitals. Libraries: jQuery and jQuery Migrate, Swiper, Slick, Owl Carousel, GSAP, AOS, lodash, Font Awesome.
- When the X-ray meets an unknown plugin, app or library, it drafts a new recipe from what it observed, for human review (REV-01).
- A recipe's confidence rises only after it is verified on a fixture or a real job; a recipe used on an unverified version is re-verified first (REV-04). Recipes hold identifiers and behaviour notes only, never vendor code.
- **Learning loop**: every applied change stores check or recipe ID, platform, target and version, simulated gain, real before and after metrics, kept or rolled back, and why. The planner ranks fixes by measured gain and failure rate. A verdict that later failed verification lowers the confidence of the evidence that produced it. An anonymized export (no client names, domains or screenshots) feeds recipe updates.

### 15.7 Competitor benchmark (public data only)

- The client names 3 to 5 competitors, or SpeedPilot proposes them and the human confirms.
- Field data from the CrUX API, lab data from PageSpeed Insights, and one normal page load per competitor URL (no crawling, robots.txt respected) to note their approach at a high level: LCP element type, font approach, third-party count, total JS size.
- The before report gets a comparison table and, in plain words, what the fastest competitor does differently (REV-06). Never copy competitor code, images or text, and never probe beyond a normal visit.

### 15.8 Lightweight replacements (T3)

- When a heavy widget (slider, review carousel, Instagram feed, popup, tabs plugin) costs a lot, the X-ray records what it actually outputs and does: DOM, interactions, data source.
- SpeedPilot proposes a replacement written from scratch with native HTML and CSS and minimal JS, for example a CSS scroll-snap carousel, `<details>` accordions, or review stars rendered from the vendor's official API or existing JSON-LD (REV-05).
- Never copy vendor code, never bypass licence checks, and respect the vendor's display terms. Client approval is required, and flows must prove the same features still work.

### 15.9 Interfaces and outputs

```
speedpilot xray <site> [--stage <stage>] [--deep] [--explore]
speedpilot xray explain <site> <script-url | handle | selector>
speedpilot xray safe <site> --change "<type>:<target>" [--template <template>]
speedpilot xray simulate <site> --change "<type>:<target>" [--urls <list>]
speedpilot xray graph <site> --out graph.html
speedpilot xray diff <run-a> <run-b>
```

- MCP tools (10 at most): `xray_run`, `xray_summary`, `xray_explain`, `xray_is_safe`, `xray_simulate`, `xray_owner_costs`, `xray_interactions`, `xray_waterfall`, `xray_diff`.
- Outputs: the Site Model (SQLite and JSON), an interactive dependency graph (HTML with Cytoscape.js), the ideal-versus-actual waterfall, the owner cost treemap, interaction breakdowns, and a plain-language explanation for every verdict.

### 15.10 Validation (how we know it can be trusted)

- Ground truth: `fixtures/truth.json` lists every planted dependency, handler, unused asset, slow query and Liquid hot spot.
- CI gates: zero false "safe" verdicts on the fixtures; at least 80% of truly safe changes found; at least 95% of bytes attributed to the right owner; every planted slow interaction traced to the right handler.
- Mutation suite: generated tricky cases (dynamic global access such as `window['jQ' + 'uery']`, `eval`, string timers, inline `onclick` attributes, scripts injected late, `document.write`, `wp.hooks` callbacks, `jQuery(window).on('load')`, Shopify theme globals). Each must come out `unsafe` or `unknown`, never `safe`.
- Shadow mode on real jobs: every verdict is logged and later compared with what verification found; precision per verdict type is tracked over time.
- Optional cross-check: REA output on the same bundles (15.11).

### 15.11 REA (optional cross-check only)

- The X-ray Engine does not depend on REA. REA (Reverse Engineer Anything, github.com/morluto/rea, MIT licence, npm package `rea-agents`; 6.3.0 was the latest in October 2026) can be run on downloaded bundles and HAR files as a second opinion, through its CLI with a pinned version, for example `npx -y rea-agents@<pinned-version> analyze-javascript-application <dir> --json`.
- Never load REA's full MCP tool list into every Claude session; it is heavy on context.
- REA findings are stored as extra evidence and never override the runtime X-ray.
- Use it only on code the client owns or has authorized for analysis, never on competitor sites.
