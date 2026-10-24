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

## Phase 9: X-ray Engine, part 2 (verdicts, simulator, recipes, validation)

- Safe-change verdicts (`safe`, `unsafe`, `unknown`) for defer, async, delay until interaction, per-template removal
  and removal, with evidence per page: dependents (runtime, static and agent edges, document order for deferred
  scripts), inline handler attributes, dynamic code that could read a script's globals (eval, `new Function`, string
  timers, `window[expr]`, `with`), document.write, lifecycle listeners that async or delay would miss, platform and
  tracking scripts, injected loader chains, recipe markers per template, listeners and coverage during interactions.
  Scope-aware tracking of global-object aliases (`var w = window`, UMD and IIFE parameters).
- Mutation suite (19 tricky cases) and controls; CI gates on both fixtures: zero false `safe`, at least 80% of truly
  safe changes found. Verdicts are logged (shadow mode) and failed `safe` verdicts lower the recipe's confidence.
- What-if simulator: a local mockttp rewriting proxy applies one or several changes (defer, async, remove, per-template
  removal, delay, preload, eager LCP image), measures baseline and variant through the same proxy (interleaved runs,
  mobile network, 4x CPU) and runs a quick verification (console, failed requests, visual). Results are labelled
  "simulated"; breakage and "no meaningful gain" are reported separately (REV-08). On the fixture the lazy-hero fix was
  predicted at 36 ms (range -52 to 128 ms) and measured at 56 ms. Under Lighthouse's 1.6 Mbps profile the six eager
  off-screen thumbnails use the bandwidth and the hero fix alone gains nothing; the report says so.
- Ideal versus actual waterfall (REV-02, REV-03), cost per owner with a treemap, interaction deep dive (input delay,
  processing, presentation, handlers with owner, file and line; REV-07), backend map (slow queries with callers, PHP
  patterns, Liquid hot spots, leftover app snippets).
- 47 seed recipes (WordPress plugins and themes, Shopify themes and apps, JS libraries), recipe drafts for unknown
  owners (REV-01), version checks (REV-04), learning loop with ranked fixes and an anonymized export.
- Competitor benchmark from public data and one normal visit per URL, robots.txt respected (REV-06); lightweight
  replacement proposals written from scratch (REV-05); optional REA adapter whose findings never change a verdict.
- `speedpilot xray explain|safe|simulate|graph|diff|benchmark`; nine MCP tools with answers under 20 KB.

## Phase 10: WordPress optimization engine

- Agent modules, each one flag with per-template or per-URL rules: asset-control (defer or async through the 6.3+
  strategy API, dequeue, footer, fetchpriority), lcp, images (dimensions, lazy below the fold, responsive WebP copies
  built by `wp speedpilot images-build`), fonts (self-hosted woff2, swap, two preloads, fallback faces with metrics read
  from the font files), core-extras, third-parties (delay on interaction, video and map facades), css (critical CSS,
  async stylesheets, SpeedPilot CSS fixes for DOC-04 and CLS-03), resource-hints, speculative, plugin-cf7,
  plugin-woocommerce, plugin-elementor, query-cache (bounds and caches a slow WP_Query traced to its caller) and
  interaction-yield (paint first, then run a slow handler that never calls preventDefault).
- One shared HTML pass on WordPress 6.9+'s template enhancement output buffer, tags edited with WP_HTML_Tag_Processor.
- `wp speedpilot usage-scan` (SAFE-05: content, widgets, menus, builder data, templates), `put-file` (uploads/speedpilot
  only), `images-build`, `autoload on|off` (scripted database step with its undo).
- Diagnostics and authentication load lazily; the visitor-facing boot is about 0.5 ms. Tests prove under 2 ms and zero
  added queries with all flags off and on, clean turn-off per flag and through SPEEDPILOT_DISABLE.
- Proposals come from X-ray verdicts, page probes, the agent's handle maps and slow WP_Query calls, autoload stats and
  the usage scan; every defer, delay or dequeue needs a `safe` verdict and a simulation without breakage first.
- The apply loop rolls back an item whose verification or any later step fails, and keeps the visual masks of kept
  items (a video facade, for example) for every later verification against the same baseline.
- Proof on fixture-wp (`scripts/optimize-fixture-wp.mjs`, Lighthouse 13 mobile, median of 5 runs, range in brackets):
  home 71 before, 93 after [64-94]; contact, about, blog 97; shop 96; products 94 and 95; post 96. Kept: fonts, lcp,
  images, asset-control (the parts the X-ray marked safe), cf7, woo-fragments, third-parties delay, video facade,
  core-extras, critical CSS, banner space reservation, no entrance animation, resource hints, speculative loading,
  query-cache, interaction-yield and the autoload fix. Refused by the X-ray and left untouched: deferring jQuery,
  jquery-migrate, the legacy slider, sourcebuster-js (unsafe) and elementor-frontend (unknown). The preloader removal is
  T3 and waits for client approval. Lab LCP stays at 2.4 to 2.9 s under mobile throttling on this fixture (target
  2.5 s): the home hero image and its server are the remaining cost. Earlier rollbacks found real defects (an LCP
  preload whose srcset differed from the image, a site-wide preload, inline `height:auto` on a fixed-height hero, a
  facade overlay placed before late layout, a banner reservation rounded to whole pixels), each fixed and re-verified.

## Phase 11: Shopify optimization engine

- Liquid transforms located on the AST (@shopify/liquid-html-parser) and spliced at the node's exact position; any edit
  that overlaps `content_for_header` or a checkout file is refused (`ProtectedEditError`).
- Transforms: defer a parser-blocking script the X-ray proved safe; defer a library together with its inline dependents
  (run on DOMContentLoaded) when nothing else needs their globals earlier; the LCP image (`image_url` + `image_tag` with
  widths, sizes, eager, fetchpriority high and preload instead of the deprecated `img_url`; resized WebP copies with a
  srcset for theme-asset images); self-hosted fonts in a snippet; the nested variant loop becomes `price_min` with the
  loop limited to what it renders; leftover app snippets stop rendering and their app embed is switched off (the
  snippet file stays, quarantined); third-party scripts load on the first interaction where `delay` is safe; redundant
  nested group blocks are flattened; speculation rules with strict exclusions.
- A git working copy of the work theme with one commit per change, pushed to the recorded work theme only (the CLI
  wrapper refuses the live theme, other themes and `--live`); on the local fixture the work theme runs in its own
  preview. Verification after each commit; a failing commit is reverted.

## Phase 12: plan, approve, apply, deploy, rollback, monitor

- `speedpilot plan` builds a plan from the X-ray and the engines (tier, findings, where, expected gain, verification
  set, rollback step, dependencies; T3 for design, tracking, plugin or app removal), stored in SQLite and JSON.
- `speedpilot apply` checks every item's approval and today's backup before the first write, applies one item at a
  time with verification and automatic rollback, and records each outcome for the learning loop. Production never
  takes `apply`; it gets changes through `speedpilot deploy`.
- `speedpilot deploy`: deploy window and campaigns, fresh backup, drift check, the staging flag set as one batch plus
  scripted database steps, full verification, flags turned off in reverse until production passes. Shopify publishes
  the verified work theme and keeps the previous live theme for the instant rollback.
- `speedpilot rollback --item|--change|--all|--emergency` and `speedpilot monitor` (pages, console errors, failed
  requests, tracking events, orders against the same day last week, PHP errors, day-7 and day-28 reminders).
- `speedpilot approve` prints an approval token for the MCP write tools.

## Phase 13: after report

- `speedpilot report after <site> --before <run> [--plan <id>]`: before and after deltas, side-by-side screenshots,
  filmstrips from the median Lighthouse runs, the change log (flag or commit, rollback), verification results,
  remaining blockers with options, re-check dates, backups and the rollback kit. The grade counts only with safety
  PASS. Anonymized version without domain, client name, logos or screenshots.

## Phase 14: MCP server

- Read-only tools (audit, get_findings, get_metrics, compare_runs, get_report, list_backups) and write tools (backup,
  prepare_staging, apply_change, rollback, deploy) that need the plan ID and the approval token, default to a dry run
  and return evidence paths; the nine X-ray tools. Registered in `.mcp.json`; add it elsewhere with
  `claude mcp add speedpilot -- node packages/mcp-server/dist/index.js`.
