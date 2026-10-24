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
