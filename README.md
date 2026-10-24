# SpeedPilot

A speed optimizer for WordPress (including WooCommerce, Elementor, Divi, Gutenberg and classic themes) and Shopify
(Online Store 2.0 and vintage themes). It audits a site, X-rays how every script, plugin and app really works, backs
the site up, makes it faster one safe change at a time without any cache plugin, proves nothing broke, and writes
before and after reports.

The rules it never breaks are in [CLAUDE.md](CLAUDE.md), the full design in [SPEC.md](SPEC.md), and everything it
detects and fixes in [CHECKS.md](CHECKS.md). [KICKOFF.md](KICKOFF.md) is the prompt pack it was built from.

## What runs by itself, and what needs you

| SpeedPilot does it by itself | You approve, in your own terminal | The client decides (T3) |
|---|---|---|
| Audit, X-ray, findings, before report | Preparing staging | Removing or replacing a plugin or app |
| Backup and restore test | Which fixes go on staging | Design changes (preloader, hero slider) |
| Each approved fix: apply, measure, verify | Deploying to production | Tracking, consent or tag manager changes |
| Rolling back any fix that breaks something | | Hosting, PHP, server or CDN changes |
| After report, monitoring, learning | | A heavy widget replaced by a lightweight build |

## Install

Needs Node.js 22.19 or newer, pnpm 10, Git and Docker (for the local WordPress fixture). For real sites: SSH and
WP-CLI access or an Application Password (WordPress), Shopify CLI with a Theme Access password (Shopify), and
optionally a Google API key with the PageSpeed Insights and Chrome UX Report APIs.

```sh
pnpm install
pnpm build
npx playwright install chromium   # skip if Chromium is already provided
pnpm test                         # unit tests; fixture tests skip when the fixtures are down
```

Run the CLI with `node packages/cli/dist/index.js <command>` (or `pnpm speedpilot <command>`). The examples below
write `speedpilot`.

## Try it on the fixtures

```sh
pnpm fixtures:wp up               # WordPress with WooCommerce and planted problems on http://localhost:8888
pnpm fixtures:shopify preview     # the Shopify fixture theme on http://localhost:9292
speedpilot audit fixture-wp
speedpilot report before fixture-wp
speedpilot xray fixture-wp
speedpilot xray explain fixture-wp jquery-core     # why jQuery may not be deferred
speedpilot plan fixture-wp
```

Local fixtures need no approvals. Everything else does.

## Use it on a client site

1. **Set up the site.** `speedpilot init <site> --platform wordpress|shopify --url https://...` writes
   `sites/<site>/site.yaml` with the intake questions as TODOs. Credentials go in `.env` (never in site.yaml, which only
   names the variables). For deep analysis set `permission.reverseEngineering: true` only with the client's written
   permission (CLAUDE.md rule 16).
2. **Check access, read-only.** `speedpilot access check <site>`.
3. **Audit and report, read-only on production.** `speedpilot audit <site>`, `speedpilot xray <site>`,
   `speedpilot report before <site> [--anonymized]`. Nothing is written to the site.
4. **Backup and staging.** `speedpilot backup <site>` then `speedpilot backup verify <site> --id <backup-id>` (restore
   test). In your own terminal: `speedpilot approve staging-prep --site <site> --stage staging --by "Your Name"`, then
   `speedpilot staging prepare <site>` and `speedpilot baseline <site> --stage staging`.
5. **Plan.** `speedpilot plan <site>` lists every item with its tier, the findings it fixes, the expected gain, the
   verification set and the rollback step. Defer, delay and dequeue items carry their X-ray verdicts; `unknown` is never
   touched.
6. **Approve and apply on staging.** In your own terminal:
   `speedpilot approve <plan-id> --stage staging --items <ids|all> --by "Your Name"` (T3 items only with the client's
   written approval). Then `speedpilot apply <plan-id> --stage staging`: one item at a time, verification after each,
   automatic rollback of anything that breaks.
7. **Deploy.** In your own terminal: `speedpilot approve <plan-id> --stage production --items <ids> --by "Your Name"`.
   Then `speedpilot deploy <plan-id>` inside the deploy window: fresh backup, drift check, the kept items as one batch,
   full production verification.
8. **After report and monitoring.** `speedpilot report after <site> --before <run-id> --plan <plan-id>`,
   `speedpilot monitor <site>` (run it from cron for 72 hours), and the day-7 and day-28 field-data checks.

Rollback at any time: `speedpilot rollback <site> --plan <plan-id> --item <id> | --all | --emergency`. On WordPress the
emergency switch is `define('SPEEDPILOT_DISABLE', true);` in wp-config.php; on Shopify it publishes the previous theme.

`speedpilot approve` refuses to run inside Claude Code, and the PreToolUse hook in `.claude/settings.json` blocks every
write to a remote site that has no approval file.

## Commands

```
speedpilot init <site>                       speedpilot plan <site>
speedpilot access check <site>               speedpilot approve <plan-id> --stage <stage> --items <ids> --by "<name>"
speedpilot audit <site> [--stage]            speedpilot apply <plan-id> --stage staging
speedpilot report before|after <site>        speedpilot verify <site> --stage <stage> [--full]
speedpilot backup <site> --stage <stage>     speedpilot deploy <plan-id>
speedpilot backup verify <site> --id <id>    speedpilot rollback <site> --change <id> | --all | --emergency
speedpilot staging prepare <site>            speedpilot monitor <site> --days 3
speedpilot baseline <site> --stage <stage>
speedpilot xray <site> [--stage] [--deep] [--no-explore] [--rea]
speedpilot xray explain <site> <script-url | handle | selector>
speedpilot xray safe <site> --change "<type>:<target>" [--template <t>]
speedpilot xray simulate <site> --change "<type>:<target>" [--urls <list>]
speedpilot xray graph <site> --out graph.html
speedpilot xray diff <site> <run-a> <run-b>
speedpilot xray benchmark <site> --competitors <url,url>
```

## MCP server (Claude Code and Claude Desktop)

The project registers it in `.mcp.json`. To add it to another Claude Code project or to Claude Desktop:

```sh
claude mcp add speedpilot -- node /path/to/speedpilot/packages/mcp-server/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "speedpilot": { "command": "node", "args": ["/path/to/speedpilot/packages/mcp-server/dist/index.js"], "env": { "SPEEDPILOT_ROOT": "/path/to/speedpilot" } } } }
```

Read-only tools (audit, get_findings, get_metrics, compare_runs, get_report, list_backups and the X-ray tools) run
freely. Write tools (backup, prepare_staging, apply_change, rollback, deploy) need the plan ID and the approval token
`speedpilot approve` prints, and default to a dry run.

## Packages

| Package | What it does |
|---|---|
| `packages/core` | site.yaml, SQLite store, collectors (Lighthouse 13, traces, coverage, beacons), WordPress backend, rules engine, backup, restore, staging, drift, verification harness |
| `packages/xray` | the X-ray Engine: CDP capture, static analysis (JS, CSS, PHP, Liquid), Site Model, safe-change verdicts, what-if simulator, recipes, benchmark, MCP X-ray tools |
| `packages/engine` | WordPress proposals and apply loop, Shopify Liquid transforms, plan, deploy, rollback, monitor |
| `packages/wp-agent` | the WordPress mu-plugin: flags, diagnostics, optimization modules, WP-CLI commands (PHP 7.4 to 8.4) |
| `packages/shopify` | Shopify CLI wrapper (work theme only), local theme preview, backend audit, backup |
| `packages/report` | before and after reports (HTML, PDF, JSON, Markdown, anonymized) |
| `packages/cli`, `packages/mcp-server` | the interfaces |

## Development

`pnpm typecheck`, `pnpm test`, `pnpm test:php` (agent tests on PHP 7.4, 8.3 and 8.4), `pnpm rules:generate`
(rules from CHECKS.md), `pnpm licenses:check` (MIT, Apache-2.0, BSD or ISC only; GPL fails the build). See
[CHANGELOG.md](CHANGELOG.md) for what each phase added.
