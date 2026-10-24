# Changelog

All notable changes to SpeedPilot. Conventional commits; one section per phase.

## Phase 1: scaffold and safety rails

- pnpm monorepo (core, xray, cli, mcp-server, report, wp-agent, shopify), TypeScript strict, vitest.
- pino logger that redacts secrets by key, by `.env` value and by token shape.
- SQLite store (better-sqlite3) with migrations for the SPEC 1.3 data model.
- `site.yaml` schema (zod) and `speedpilot init <site>` with the SPEC 2.1 intake questions as TODOs.
- `.claude/settings.json` deny rules and PreToolUse hooks; `.claude/hooks/guard.mjs` enforces CLAUDE.md rule 10 (default-deny on remote stages, approval-file exception, always-blocked list, Chrome DevTools MCP input tools).
- `.claude/agents/perf-verifier.md` exactly as in SPEC 14.2.
- `speedpilot access check <site>`: read-only probes for WP-CLI over SSH, REST with an Application Password, Shopify CLI theme list and an optional Admin GraphQL shop query.
- `speedpilot approve` (human only; refuses inside Claude Code and is blocked by the hook).

## Phase 2: fixtures with planted problems

- `fixtures/wp`: wp-env config (WooCommerce, Elementor, Contact Form 7, Smart Slider 3), fixture theme, planter mu-plugin
  (`wp spf plant`) and a Docker Compose fallback with written-from-scratch plugin stand-ins for sandboxes that cannot
  reach wordpress.org. `pnpm fixtures:wp up|down|reset|cli`.
- `fixtures/shopify/theme`: Horizon-style theme written from scratch with every SPEC 11 planted problem;
  `pnpm fixtures:shopify push|preview|check`; local liquidjs storefront preview with mock data, a platform-script
  stand-in, Shopify's Speculation-Rules header and an emulated `theme profile`.
- `fixtures/thirdparty`: a second-origin "third-party CDN" (chat widget, analytics with GA4-style `/g/collect` beacons).
- `fixtures/PLANTED.md` maps every planted problem to CHECKS.md IDs; `fixtures/truth.json` holds the X-ray ground truth.

## Phase 3: page, browser and lab collectors (read-only)

- Page inventory from robots.txt and sitemaps, template classification, SPEC 3.1 sampling, variant detection.
- Lighthouse 13 runner (pinned 13.5.0, Node API, chrome-launcher, clean profile, mobile and desktop, N runs, median by
  score with min and max, JSON and HTML saved). The audit-ID map is built from the installed Lighthouse at startup and
  fails loudly when a mapped ID is missing. Lighthouse 13.5 renamed three SPEC 3.2 insights (`use-cache-insight` ->
  `cache-insight`, `interaction-to-next-paint-insight` -> `inp-breakdown-insight`, `lcp-phases-insight` ->
  `lcp-breakdown-insight`); the map lists both names.
- PageSpeed Insights v5, CrUX and CrUX History clients (public URLs only).
- Playwright collectors: requests with owner attribution (WordPress paths, Shopify app/platform domains,
  third-party-web), JS and CSS coverage after scripted interactions, images, fonts, video and iframes, DOM and document
  stats (including the Lighthouse-13-removed checks: document.write, non-passive listeners, eager offscreen images,
  facades, font preloads), console/network/CSP/Liquid/PHP errors, SEO tags, beacons in both consent states,
  screenshots at 390/768/1440 plus element shots, CDP traces, LCP element and phases, CLS culprits with cause,
  Long Animation Frames.
- Scripted INP interactions with the web-vitals attribution build at 4x CPU slowdown, per-interaction breakdown and
  LoAF script attribution.
- Every run records then aborts analytics and ad beacons and blocks mutating requests on non-local targets; navigation
  is rate-limited to 1 request per second on real sites. `speedpilot audit <site>`.

## Phase 4: platform backends and the agent's read-only half

- WordPress agent mu-plugin: kill switch, flags (one autoloaded option), HMAC and Application Password auth,
  diagnostics REST routes, per-URL handle map, Server-Timing for token requests, staging-only slow queries and outgoing
  HTTP calls with their callers, Abilities on 6.9+, Tools page, `wp speedpilot` flag commands.
- Agent tests (TAP harness, no Composer download) pass inside the fixture on PHP 7.4.33, 8.3 and 8.4 with WordPress
  7.1.3: `pnpm test:php`.
- WordPress backend: WP-CLI wrapper (local compose/wp-env or remote alias, read-only enforced on remote stages),
  plugins, themes, environment, autoload with owners, cron health, database stats (revisions, orphans, Action
  Scheduler, sessions, engines), builder options, per-URL handle maps, cached and bypassed TTFB, wp profile/doctor when
  installed, admin timings on local fixtures.
- Shopify backend: Shopify CLI wrapper (pushes only to the recorded work theme, never live), theme snapshot into git,
  offline Theme Check, theme profile (CLI or local preview), app embeds, sections per template, app cost from the
  storefront, leftover app code, theme count, Speculation-Rules header.
