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
