# SpeedPilot: rules for Claude Code

SpeedPilot is a speed optimizer for WordPress (including WooCommerce, Elementor, Divi, Gutenberg and classic themes) and Shopify (Online Store 2.0 and vintage themes). It audits a site, backs it up, makes it faster one safe change at a time, proves nothing broke, and produces before and after reports.

Before any work in a session, read SPEC.md (what to build) and CHECKS.md (what to detect and fix). If something here conflicts with SPEC.md, this file wins. If anything is unclear and it touches a live site, stop and ask.

## The 16 rules (never break these)

1. **Backup first.** No write to production without a verified backup taken the same day. "Verified" means it was restored once on staging or locally and the smoke flows passed (for Shopify: the backup theme's files match the git snapshot and it previews without Liquid errors). Staging needs a same-day snapshot before writes, because it can always be rebuilt from the verified production backup. Check free disk space before writing any backup on a server: a full disk takes the site down.
2. **Staging first.** Every change runs on staging (WordPress) or an unpublished work theme (Shopify) before production. Production only gets changes that passed verification and were approved in a plan.
3. **No cache plugins.** Never install, enable or configure page-cache, object-cache or all-in-one optimization plugins (WP Rocket, W3 Total Cache, LiteSpeed Cache, WP Super Cache, WP Fastest Cache, Autoptimize, FlyingPress, Perfmatters, NitroPack, Swift Performance and similar), and never install a Shopify "speed booster" app. Do not turn on caching features inside builders either (for example Elementor Element Caching). Speed comes from real fixes. Host-level caching that already exists stays as it is; we measure it and report on it. If the site already has a cache or optimization plugin or app, leave it as it is unless the approved plan says otherwise (T3), and never let SpeedPilot's modules do the same job twice.
4. **One change at a time.** Apply, measure, verify, then keep or roll back. Every change is one feature flag or one git commit that can be reverted on its own.
5. **No fake speed.** Never detect Lighthouse, PageSpeed Insights, GTmetrix or Googlebot user agents to serve different content. Never hide content from test tools. Never remove a feature just to raise a score. Real-user field data is the truth.
6. **Business flows are sacred.** Checkout, cart, payments, forms and their emails, login and accounts, search and filters, tracking and consent, language and currency switchers, subscriptions and cron jobs, integrations and webhooks must pass verification before and after every change.
7. **Do not edit what you do not own.** Never edit WordPress core, plugin files or a parent theme in place: use the SpeedPilot mu-plugin, hooks or a child theme. Never modify, strip or parse-and-rewrite Shopify `content_for_header`. Never touch Shopify checkout.
8. **Never overwrite production data.** Never push a staging database over production. Move only code, config and scripted database steps that each have a written undo step.
9. **No deletions without an approval line.** Plugins, apps, theme files, media, database rows or tables are deleted only when the approved plan names them. Delete means quarantine first (rename, export or move), hard delete later.
10. **Remote sites are default-deny.** On staging and production, and on anything whose stage cannot be identified (which counts as production), only the read-only commands on the allowlist in SPEC.md 14.1 run freely. Every write (WP-CLI or SQL writes, file changes over SSH or SFTP, Shopify theme push, publish, delete or share, cache purges) needs an approval file for that site and stage. The human writes it with `speedpilot approve` in their own terminal; Claude never runs that command. All writes go through SpeedPilot's executor, which checks the approval itself, and Claude never writes or runs ad-hoc scripts that connect to a client site. Always blocked, even with approval: `shopify theme push --live` or `--allow-live`, pushing to any theme other than the recorded work theme, `rm -rf` outside `runs/`, `git push --force`, printing `.env`. Local fixtures (wp-env) are exempt. The PreToolUse hook in `.claude/settings.json` enforces this.
11. **Secrets stay secret.** Credentials live in `.env` (git-ignored) and are referenced by variable name in `sites/<site>/site.yaml`. Never print, log, commit or put them in reports. Ask only for least-privilege access and say when it can be revoked.
12. **Production stays quiet.** On production never turn on WP_DEBUG display, SAVEQUERIES, Query Monitor or Xdebug, and never run load tests. Never purge host or CDN caches without approval. Crawl at no more than 1 request per second. In every automated run, analytics and ad beacons (GA4 collect, Meta Pixel, Google Ads, TikTok and similar endpoints) are recorded and then aborted, so the client's reports and ad conversion data stay clean; the tag scripts themselves still load, so their speed cost is measured. Browser automation on production is read-only: never use Chrome DevTools MCP or Playwright to log in to wp-admin or Shopify admin and change anything, and never submit a form that sends data to the business (contact, quote, newsletter, account, order) except a client-approved TEST entry. Add to cart, search and filters in verification flows are fine. X-ray exploration on production uses only its safe list (SPEC.md 15.2). On small or shared hosting, run full audits outside peak hours.
13. **Deploy window.** Production deploys happen only inside the window in `site.yaml`, never during a sale or campaign the client named, and the client is told before and after.
14. **Auto-rollback.** Roll a change back at once, and log why, if after it there is: a new console error, a new failed request, a failed flow, a visual difference above the threshold, a missing tracking event, a changed SEO tag, a new PHP warning or fatal error, a Liquid error, or any metric worse than baseline beyond noise.
15. **Honest numbers.** Report medians of repeated runs with their range, and keep lab and field data separate. If a target cannot be reached without breaking a business requirement, say exactly what blocks it, what it costs in milliseconds or points, and what the client's options are.
16. **Reverse-engineer only what you may.** Deep analysis (X-ray, REA, deobfuscation) only of the client's own site and the scripts running on it, with their written permission. Competitors: public data (CrUX, PageSpeed Insights) and a normal page visit only. Never copy vendor or competitor code, images or text; lightweight replacements are written from scratch. Never bypass licence checks or protections. A script the X-ray cannot understand is left untouched.

## Targets (every key page template, mobile first)

- Lighthouse performance (Lighthouse 13, median of 5 runs): mobile 90 or higher, desktop 95 or higher, pushing toward 100.
- Lab: LCP 2.5 s or less (aim 1.8 s), TBT 200 ms or less (aim 100 ms), CLS 0.1 or less (aim 0.05).
- Scripted interactions with 4x CPU slowdown: INP 200 ms or less for every tested interaction.
- Field data (CrUX, 75th percentile): LCP 2.5 s, INP 200 ms, CLS 0.1 or better.
- HTML TTFB 800 ms or less as real users get it. For WordPress also report the uncached PHP render time.
- Safety: 0 new console errors, 0 failed flows, 0 SEO or tracking regressions.

Grades are defined in SPEC.md section 9.4.

## Order of work for any site

read-only audit with X-ray → before report → backup and restore test → verification baseline → change plan → approval → apply on staging, one change at a time → full verification → after report (staging) → production deploy inside the window → production verification → 72-hour monitoring → day-28 field-data check.

## Engineering rules

- Node.js 22.19 or newer (Lighthouse 13 needs it), TypeScript strict, pnpm workspaces, vitest, Playwright.
- WordPress agent: PHP that runs on PHP 7.4 through 8.4 (use only syntax valid on 7.4), WordPress Coding Standards, no Composer runtime dependencies, no outgoing calls.
- Edit HTML, CSS, JS and Liquid with parsers (parse5 or cheerio, postcss, acorn, @shopify/liquid-html-parser). Never regex-replace whole files.
- Pin tool versions (Lighthouse 13.x, Chrome, web-vitals, Shopify CLI, WP-CLI, REA) and record them in every run. When the Chrome version changes, take a new baseline before comparing numbers: Chrome 147 to 150 refined how INP is measured. Lighthouse 13 replaced many audits with `*-insight` audits: read audit IDs from the mapping table in SPEC.md 3.2, never hardcode old IDs, and fail loudly if a mapped ID is missing.
- No paid APIs or services inside the tool. Everything it needs is free (Lighthouse, Playwright, PageSpeed Insights API, CrUX API, Shopify CLI, WP-CLI).
- Every module ships with tests. A phase is done only when it runs green on both fixtures (`fixtures/wp`, `fixtures/shopify`).
- Small commits with conventional commit messages. Update CHANGELOG.md in every phase.
- When a fact about WordPress, Shopify or Chrome matters, check current docs (Shopify Dev MCP, make.wordpress.org field guides, developer.chrome.com) instead of relying on memory.

## Tools in this project

- Chrome DevTools MCP: performance traces with LCP breakdown and CLS culprits, console, network, emulation.
- Shopify Dev MCP: Shopify docs, Admin GraphQL schema, Liquid and theme validation.
- WordPress agent skills in `.claude/skills/` (wp-performance, wp-wpcli-and-ops, wp-plugin-development, wp-env and others).
- Subagent `.claude/agents/perf-verifier.md`: checks work it did not write and never edits code. Use it before calling any change or phase done.
- X-ray Engine (`packages/xray`, SPEC.md section 15): our own reverse-engineering engine. Its `safe`, `unsafe` or `unknown` verdicts decide what may be touched; `unknown` is never touched. Use its small MCP tool set rather than raw dumps.
- REA (Reverse Engineer Anything): optional second opinion only, run through its CLI; never decisive and never required (SPEC.md 15.11).
