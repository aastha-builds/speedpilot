# KICKOFF: build SpeedPilot with Claude Code, step by step

Paste one prompt at a time. Start the next one only when every "Done when" line is true. Ask Claude Code to show its plan before it writes code in each phase.

## One-time setup

1. Install Node.js 22.19 or newer, pnpm, Git, Docker Desktop (for wp-env), Shopify CLI and Claude Code. On Windows, work inside WSL2.
2. Create the project and copy the five files into it:
   ```
   mkdir speedpilot && cd speedpilot && git init
   # copy README.md CLAUDE.md SPEC.md CHECKS.md KICKOFF.md here
   ```
3. Add the MCP servers:
   ```
   claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest
   claude mcp add --transport stdio shopify-dev-mcp -- npx -y @shopify/dev-mcp@latest
   ```
4. Install the official WordPress agent skills into this project:
   ```
   git clone https://github.com/WordPress/agent-skills.git ../agent-skills
   cd ../agent-skills
   node shared/scripts/skillpack-build.mjs --clean
   node shared/scripts/skillpack-install.mjs --dest=../speedpilot --targets=claude
   cd ../speedpilot
   ```
5. Free accounts and keys: a Shopify Partner account with one development store (for the Shopify fixture), and a Google Cloud API key with PageSpeed Insights API and Chrome UX Report API enabled.
6. REA (Reverse Engineer Anything) is not needed: SpeedPilot builds its own X-ray Engine (Prompts 8 and 9). Prompt 9 adds an optional REA cross-check that runs through its CLI. Do not register REA in Claude Code unless you want it for other work; it adds about 170 tools to every session.
7. Start Claude Code in the folder and paste Prompt 0.

---

## Prompt 0: understand before building

```
Read CLAUDE.md, SPEC.md and CHECKS.md completely. Do not write any code yet.
Reply with:
1. The system in your own words, in 10 lines.
2. Every question, gap or contradiction you found in the three files.
3. The risks you see for live client sites that the files do not cover yet.
4. The build order, with the files and packages each phase creates.
Then wait for my answers.
```

Done when: you have answered its questions and agreed the build order.

## Prompt 1: scaffold and safety rails

```
Build phase 1 from SPEC.md sections 1, 10.3, 12 and 14.
- pnpm monorepo with packages core, cli, mcp-server, report, wp-agent, shopify. TypeScript strict, vitest, pino logging that redacts secrets.
- SQLite store with the data model in SPEC 1.3 and migrations.
- site.yaml schema with zod, and `speedpilot init <site>` writing a site.yaml with the intake questions from SPEC 2.1 as TODOs.
- .env.example, .gitignore (including .env, runs/, backups).
- .claude/settings.json with the deny rules and the PreToolUse hook; .claude/hooks/guard.mjs enforcing CLAUDE.md rule 10 with the approval-file exception from SPEC 14.1; .claude/agents/perf-verifier.md exactly as in SPEC 14.2.
- `speedpilot access check <site>` with read-only probes: WordPress over SSH + WP-CLI and over REST with an Application Password; Shopify with `shopify theme list` using a Theme Access password, and an optional Admin GraphQL shop query.
Follow CLAUDE.md. Use the perf-verifier subagent before you say the phase is done.
```

Done when:
- `pnpm test` is green.
- Tests prove the hook is default-deny on remote stages: read-only allowlisted commands pass; writes such as `wp option update`, `wp eval`, `wp db query "DROP TABLE x"`, `wp search-replace a b` without `--dry-run`, an SSH `sed -i` on a server file, `shopify theme publish` and a push without the work theme ID are blocked without an approval file and allowed with a valid one; `shopify theme push --live`, `--allow-live`, printing `.env` and `speedpilot approve` are always blocked; an unknown stage counts as production; Chrome DevTools MCP input tools are blocked unless the state file says local or staging; local wp-env fixture commands pass.
- `speedpilot init demo` writes a site.yaml that validates.
- A test proves secrets never appear in logs.

## Prompt 2: fixtures with planted problems

```
Build the fixtures from SPEC.md section 11.
- fixtures/wp: wp-env with WooCommerce, Elementor, Contact Form 7 and a slider plugin, sample pages, posts and products, plus a setup script that plants every problem listed in SPEC 11 and writes a list of what it planted.
- fixtures/shopify: a copy of a Horizon-family theme (and Dawn if time allows) with every planted problem from SPEC 11, and a README that pushes it to my development store as an unpublished theme with Shopify CLI.
- Scripts: pnpm fixtures:wp up|down|reset and pnpm fixtures:shopify push.
These fixtures are the test bed for every later phase, so each planted problem must map to at least one CHECKS.md ID. Write that mapping in fixtures/PLANTED.md.
```

Done when:
- `pnpm fixtures:wp up` gives a running local site where every planted problem can be seen.
- The Shopify fixture theme is in the development store, unpublished, and `shopify theme check` reports the planted offences.
- fixtures/PLANTED.md maps every planted problem to CHECKS.md IDs.

## Prompt 3: page, browser and lab collectors (read-only)

```
Build the collectors in SPEC.md sections 3.1 to 3.8, 3.11 and 3.12 (everything except the platform backends).
- Page inventory and sampling from sitemaps and templates.
- Lighthouse 13 runner (pinned, Node API, chrome-launcher, mobile and desktop, 5 runs, median plus min and max), with the audit-ID map from SPEC 3.2 built at startup and a loud failure if a mapped ID is missing.
- PageSpeed Insights API v5 and CrUX API plus CrUX History API clients.
- Traces with LCP phases, CLS culprits and Long Animation Frames (Chrome DevTools MCP or Puppeteer).
- Playwright collectors: requests with owner attribution (third-party-web dataset), JS and CSS coverage after scripted interactions, images, fonts, video and iframes, document and DOM stats, console and network errors, SEO tags, tracking beacons in both consent states, screenshots at 390, 768 and 1440.
- Scripted INP interactions with the web-vitals attribution build at 4x CPU slowdown.
Everything is read-only and rate-limited to 1 request per second against real sites. Analytics and ad beacons are recorded and then aborted in every run (CLAUDE.md rule 12). Save all evidence under runs/<site>/<run-id>/.
```

Done when:
- `speedpilot audit fixture-wp` saves Lighthouse JSON and HTML, traces, coverage, screenshots and console logs for every sample URL.
- The LCP element, its phases and the CLS culprits are found correctly for the planted lazy hero and unsized images.
- A test runs the audit against a public site with no credentials and proves SpeedPilot itself sends no POST, PUT, PATCH or DELETE requests and that no analytics beacon leaves the test browser.

## Prompt 4: platform backends and the agent's read-only half

```
Build SPEC.md sections 3.9 (WordPress backend) and 3.10 (Shopify backend), and the read-only parts of the WordPress agent from SPEC 8.1: kill switch, authenticated diagnostics (handle map per URL, environment, autoload stats, cron list), Server-Timing for token requests, Abilities registration on WordPress 6.9+, and the Tools admin page.
- WordPress: WP-CLI over SSH and locally in wp-env, wp doctor and wp profile packages, database stats, cron, slow queries and outgoing HTTP calls on staging only, admin page timings, cached and bypassed TTFB, builder settings read from options.
- Shopify: theme pull into git, theme check JSON, theme profile JSON per sample URL, settings_data.json app embeds, sections per template, app inventory from the storefront, leftover app code, theme count.
The agent must do nothing when SPEEDPILOT_DISABLE is true, and its diagnostics must refuse unauthenticated requests (write tests for both).
```

Done when:
- The fixture WordPress report shows the planted slow query with its caller, the 2 MB of autoloaded options with owners, and CF7 and cart fragments loading on every page.
- The fixture Shopify report shows the parser-blocking script, the slow Liquid loop with its render time, and the leftover app snippet.
- Agent PHPUnit tests pass inside wp-env on the oldest and the newest PHP versions wp-env offers (aim for 7.4 and 8.4).

## Prompt 5: rules, analysis and the before report

```
Convert every check in CHECKS.md into rules/<area>.yaml with the fields CHECKS.md defines. Do not skip, merge or rename any check; write a test that fails if a CHECKS.md ID has no rule.
Build the rules engine, root-cause grouping, prioritization and ceiling estimate from SPEC.md section 4, and the before report from SPEC 9.1 and 9.3 (HTML, PDF, JSON and Markdown summary, with branding and anonymized mode).
```

Done when:
- Every CHECKS.md ID has a rule (the test proves it).
- The before report for each fixture lists every planted problem (compare against fixtures/PLANTED.md) with evidence, estimated gain and tier.
- The report's first page reads clearly to a non-technical client.

## Prompt 6: backup, restore test, staging and drift

```
Build SPEC.md section 5.
- WordPress backup with manifest and checksums, off-server copy, and a restore test into wp-env that runs the smoke flows before marking the backup verified.
- WordPress staging preparation with search-replace (dry run first) and every neutralization step in SPEC 5.2, each with a test that proves it works (for example, an email sent on staging never leaves).
- Shopify backup: theme count check, pull into git with a tag, duplicate as backup and as work theme, manifest with settings_data.json, templates, locales, app embeds and live theme ID. Preview runs block the preview bar's requests and label results indicative.
- Drift check for both platforms.
```

Done when:
- A fixture backup restores into a fresh wp-env and passes the smoke flows.
- A test proves the backup checks free disk space first and streams off the server when space is tight.
- Tests prove staging cannot send email, take live payments or call webhooks.
- The Shopify backup and work themes exist in the development store and a drift test catches a change made to the live theme after the snapshot.

## Prompt 7: verification harness

```
Build SPEC.md section 6: visual diff with masks and the early-paint check, console and network signature comparison, flows from site.yaml (write the default flow library for WooCommerce and Shopify), tracking guard in both consent states, SEO guard, accessibility guard, backend guard, and performance regression thresholds. Add `speedpilot baseline` and `speedpilot verify`.
The perf-verifier subagent must be able to run the whole harness and produce PASS or FAIL with evidence paths.
```

Done when:
- A baseline on each fixture passes against itself.
- Deliberately broken changes are caught, with a test for each: defer jQuery with an inline dependent (console), purge a menu-open class (flow), remove the canonical (SEO), block the GA4 beacon (tracking), add an unsized banner (visual and CLS).

## Prompt 8: X-ray Engine, part 1 (capture, static analysis, Site Model)

```
Build the first half of our own reverse-engineering engine in packages/xray, from SPEC.md 15.1 to 15.4. Follow CLAUDE.md rule 16.
- Capture through the Chrome DevTools Protocol (SPEC 15.2): parsed scripts with sources and source maps, requests with initiator stacks, trace and CPU profile, Long Animation Frames, layout shift sources, function-level JS coverage and rule-level CSS usage per interaction state, the behaviour init script, attached listeners through DOMDebugger, safe-list exploration (full on staging, safe list only on production), HAR with secrets stripped.
- Static analysis (SPEC 15.3): JavaScript, CSS, PHP for the active theme and plugins, the Liquid render tree, library fingerprints with Retire.js signatures.
- The Site Model (SPEC 15.4): SQLite nodes and edges with evidence and confidence, and an owner for every request, file, handler, hook and query.
- fixtures/truth.json listing every planted dependency, handler, unused asset, slow query and Liquid hot spot.
Dependencies must be MIT, Apache-2.0, BSD or ISC licensed; add a licence check to CI.
```

Done when:
- An X-ray of fixtures/wp and fixtures/shopify builds a Site Model in which every item in fixtures/truth.json appears with the right owner.
- At least 95% of bytes on each sample URL are attributed to the right owner (test against truth.json).
- In production mode, exploration never clicks anything outside the safe list (test with a page full of trap buttons: delete, logout, buy, subscribe, submit).
- The licence check fails the build when a GPL dependency is added (test).

## Prompt 9: X-ray Engine, part 2 (verdicts, simulator, recipes, validation)

```
Build the second half of the X-ray Engine, from SPEC.md 15.5 to 15.11, plus the REV checks in CHECKS.md.
- Safe-change verdicts (safe, unsafe, unknown) for defer, async, delay until interaction, per-template loading and removal, each with its evidence.
- Ideal versus actual waterfall, cost attribution per owner, interaction deep dive, backend mapping.
- The what-if simulator: a local rewriting proxy (for example mockttp) that applies a proposed change, measures baseline and variant through the same proxy, and runs the quick verification on the variant. Results are labelled "simulated".
- Recipe library, fingerprints, recipe drafts for unknown items, and the learning loop.
- Competitor benchmark (public data only) and lightweight replacement proposals.
- The CLI commands and MCP tool set from SPEC 15.9 (10 tools at most, answers under 20 KB with evidence paths).
- Validation from SPEC 15.10: the CI gates and the mutation suite.
- The optional REA cross-check adapter (SPEC 15.11); the engine must work fully without it.
```

Done when:
- CI shows zero false "safe" verdicts on the fixtures and on the mutation suite, and at least 80% of truly safe changes are found.
- The planner refuses to defer jQuery on fixtures/wp because of the planted inline dependency, and `speedpilot xray explain` shows why.
- The simulator predicts the gain of fixing the planted lazy hero, and the real result on the local fixture lands inside the predicted range.
- Handler timing names the planted slow click handler and its script.
- A competitor benchmark of two public sites runs with one visit each and produces the comparison table.
- With REA missing, the X-ray completes normally (test).

## Prompt 10: WordPress optimization engine

```
Build every optimization module of the WordPress agent from SPEC.md 8.1, each behind its own flag with per-template or per-URL rules, export and import of the flag config, and the SAFE guards from CHECKS.md attached to each module. Include the usage scan for SAFE-05 (all content, widgets, menus, builder data, templates) before any asset is dequeued.
Every defer, delay or dequeue decision needs an X-ray `safe` verdict (SPEC 15.5) and a passing simulation first.
No module may write outside its flag scope, and none may install or emulate a cache plugin.
```

Done when:
- On fixtures/wp, applying the T1 and T2 modules one by one through the apply loop fixes every planted WordPress problem, and the full verification passes after each step.
- Each module turns off cleanly by its flag and by SPEEDPILOT_DISABLE, proven by tests.
- A test proves the agent adds under 2 ms and zero database queries per request, with all flags off and with all flags on.
- Mobile Lighthouse median on the fixture's sample URLs reaches 90 or higher, with the before and after numbers saved.

## Prompt 11: Shopify optimization engine

```
Build SPEC.md 8.2: Liquid AST transforms for every Shopify fix, one commit per change on the work theme, pushed with Shopify CLI to the work theme only, plus the speculation rules snippet with strict exclusions. Every script change needs an X-ray `safe` verdict (SPEC 15.5) and a passing simulation first. Respect every SAFE guard, never touch content_for_header, never push to the live theme.
```

Done when:
- On the fixture theme every planted Shopify problem is fixed, one commit each, with verification passing after each.
- Liquid render time for the planted loop drops in `shopify theme profile`.
- A test proves the engine refuses to push to the live theme and refuses to edit content_for_header.

## Prompt 12: plan, approve, apply, deploy, rollback, monitor

```
Build SPEC.md section 7: plan generation with tiers, expected gain, verification set and rollback per item; `speedpilot approve` writing the approval record and the approval file the hook checks; the apply loop with keep-or-rollback; production deploy with fresh backup, drift check and deploy window; the rollback kit (per change, all, emergency); and `speedpilot monitor` for the 72-hour check plus day-7 and day-28 field-data reminders.
```

Done when:
- An unapproved item cannot be applied, even when the executor is called directly without the hook (test).
- A change that fails verification is rolled back automatically and logged (test).
- A full simulated deploy on each fixture works end to end, and `speedpilot rollback --all` returns each fixture to its backup state, proven by verification against the original baseline.

## Prompt 13: after report and grades

```
Build SPEC.md 9.2 to 9.4: the after report with before and after deltas, side-by-side screenshots and filmstrips, change log, verification results, remaining blockers with client options, field-data note with re-check dates, backup IDs and rollback kit. Grades exactly as in SPEC 9.4, capped by the safety result. Also the Markdown summary for client messages and the anonymized portfolio version.
```

Done when: each fixture has a before and an after report, and the anonymized version contains no domain, client name or logo (test).

## Prompt 14: MCP server

```
Build SPEC.md 10.2: an MCP server exposing the read-only tools freely and the write tools only with plan_id plus approval token, dry run by default, returning evidence paths. Register it in this project and show me the exact command to add it to Claude Code and Claude Desktop.
```

Done when: from a fresh Claude Code session you can ask "audit fixture-wp and show the top 10 findings" and get them through the MCP tools, and a write tool without approval is refused.

## Prompt 15: end-to-end proof and hardening

```
Run the full workflow on both fixtures from a clean state: init, access check, audit, before report, backup and restore test, staging, baseline, plan, approve, apply, verify, after report, deploy simulation, monitor, rollback. When an approval is needed, stop and tell me the exact `speedpilot approve` command to run in my own terminal.
Then review the whole repo against CLAUDE.md (all 16 rules), SPEC.md and every CHECKS.md ID, and update the recipes the run verified. Use the perf-verifier subagent for an independent review. List every gap, fix it, and update CHANGELOG.md and README.md with real usage instructions.
```

Done when: both fixtures finish the whole flow with safety PASS, the X-ray validation gates stay green, and no gaps remain open in the review; the WordPress fixture reaches grade AA or better; the Shopify fixture reaches A or better, and its report explains the remaining ceiling (platform scripts, password page) with measured numbers.

---

## Using SpeedPilot on a real client site

Run these one at a time. Each step waits for your approval before the next.

**Step 1: audit only (safe on production)**
```
Use SpeedPilot on <site>. Run access check and a read-only audit on production, then the before report.
Do not write anything to the site. Show me the report path, the grade, the top 10 findings with evidence, the ceiling estimate with blockers, and the draft plan with tiers.
```

**Step 2: backup, staging, baseline**

First, in your own terminal (not through Claude): `speedpilot approve staging-prep --site <site> --stage staging --by "Your Name"`
```
For <site>: take the production backup and run the restore test, prepare staging (or the Shopify work theme), and record the verification baseline. Show me the backup ID, what was neutralized on staging, and the baseline result.
```

**Step 3: apply approved items on staging**

First, in your own terminal, approve the items you want: `speedpilot approve <plan-id> --stage staging --items <ids> --by "Your Name"`. Approve T3 items only after the client agrees in writing.
```
Apply the approved items of plan <plan-id> on staging, one at a time, with full verification after each. Roll back anything that fails. Then show me the staging after report.
```

**Step 4: deploy**

First, in your own terminal: `speedpilot approve <plan-id> --stage production --items <ids> --by "Your Name"`
```
Deploy plan <plan-id> to production inside the window: fresh backup, drift check, deploy, full production verification. Then start monitoring and show me the final after report and the rollback kit.
```
