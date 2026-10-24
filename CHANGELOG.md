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

## Phase 5: rules, analysis and the before report

- `rules/<area>.yaml` generated from CHECKS.md (`pnpm rules:generate`): 237 rules, one per ID, with id, platforms,
  detect (source, condition, automated), evidence, metric, tier, fix and verify. 193 checks are detected automatically;
  10 need client or vendor information (listed in every report); the 34 SAFE items are guards attached to findings.
  A test fails if any CHECKS.md ID has no rule.
- Rules engine with evaluators per check, SAFE guard attachment, root-cause grouping, SPEC 4 prioritization (failing
  mobile CWV first, lower risk first at equal gain, learning-loop gains when available) and a ceiling estimate with
  measured blockers (Lighthouse log-normal scoring).
- Grades exactly as SPEC 9.4, capped by the safety result.
- Before report (SPEC 9.1, 9.3): self-contained HTML with a plain-language first page, PDF (Playwright print), JSON
  and a Markdown summary; branding from site.yaml; anonymized mode. `speedpilot report before <site>`.

## Phase 6: backup, restore test, staging and drift

- WordPress backup: free-disk check first (`df`), written on the server only when 20% stays free, otherwise streamed
  straight off it; database export with `--single-transaction --quick`, per-table row counts and checksums, files
  without cache folders, SHA-256 per archive, manifest (versions, plugins, themes, key options, cron, mu-plugins,
  drop-ins), AES-256-GCM encryption at rest (required for real sites), 30-day retention pruning.
- Restore test into a fresh local Docker WordPress (checksums verified, URLs search-replaced with a dry run first) with
  the smoke flows; only then is a backup marked verified. `speedpilot backup` and `speedpilot backup verify`.
- Staging: SpeedPilot Staging Guard mu-plugin (no email, outgoing HTTP blocked except allowlisted hosts, only test-mode
  or offline gateways, WooCommerce webhooks, WP-Cron and Action Scheduler paused, noindex, optional basic auth);
  local staging clone from a verified backup or remote host staging; neutralization proven by checks.
  `speedpilot staging prepare` (needs the staging-prep approval).
- Shopify: theme library check (never deletes a theme), live theme pulled into git and tagged, backup and work theme
  duplicates, manifest, verification (checksums plus Liquid-error-free preview), drift check, preview-bar blocking
  with "indicative" labels. A fake store test double drives the same Shopify CLI commands.
- Drift control for WordPress (plugins, themes, key options, theme file hash).

## Phase 7: verification harness

- `speedpilot baseline` and `speedpilot verify [--full]` (SPEC 6): visual diff per URL and viewport (pixelmatch,
  anti-aliasing tolerant, masks) plus an early-paint unstyled-content check at FCP; console and network signature
  comparison (normalized URLs, query strings, line numbers); flows from site.yaml plus a default flow library for
  WooCommerce and Shopify; tracking guard (same beacon names and counts per URL and flow, both consent states);
  SEO guard; accessibility guard (Lighthouse score, alt text, keyboard-reachable facades); backend guard (new PHP
  warnings and fatals in debug.log, Liquid errors, overdue cron); performance thresholds from site.yaml on medians,
  where "beyond noise" also requires falling outside the baseline's own range.
- Self-tests: a baseline passes against itself on both fixtures; deferring jQuery with an inline dependent (console),
  purging the menu-open class (flows), removing the canonical (SEO), blocking the GA4 beacon (tracking) and adding an
  unsized banner (visual and CLS) are each caught.
- Fixture fixes found by the harness: the planted late banner is now deterministic, the Shopify hero no longer covers
  the mobile menu button, and the local preview keeps one cart per visitor.

## Phase 8: X-ray Engine, part 1 (capture, static analysis, Site Model)

- CDP capture per URL, device and consent state: parsed scripts with sources and source maps (inline scripts matched
  to their elements by content), requests with initiator stacks, CPU profile, Long Animation Frames, layout shifts,
  function-level coverage with call counts and rule-level CSS usage per interaction state, behaviour hooks (globals
  timeline, listener registrations, timers, MutationObservers, document.write, sync XHR), attached listeners
  through DOMDebugger (handler names), safe-list exploration (full on staging, safe list only on production) and a
  HAR with cookies, Authorization headers and tokens stripped.
- Static analysis: scope-aware JavaScript (globals defined and read, immediate reads, jQuery plugins, selectors,
  events, endpoints, timers, everything dynamic flagged), CSS (selectors, @font-face, @import, state classes), PHP on
  the theme and plugins (enqueues, hooks, heavy patterns), the Liquid render tree with hot spots, and library
  fingerprints with vulnerable-version signatures.
- Site Model in SQLite (`xray_nodes`, `xray_edges`) and JSON, with evidence and confidence per edge and an owner for
  every request, file, handler, hook and query. `speedpilot xray <site>`.
- `fixtures/truth.json` validation: every planted dependency, handler, unused asset, slow query, Liquid hot spot and
  leftover app snippet appears with the right owner; at least 95% of bytes per sample URL are attributed correctly.
- Production exploration never clicks outside the safe list (trap-button test).
- Licence check (`pnpm licenses:check`) in CI; GPL fails the build (test). One exception is recorded and needs the
  owner's sign-off: axe-core (MPL-2.0), a transitive dependency of Lighthouse.
