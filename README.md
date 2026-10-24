# SpeedPilot prompt pack (v4)

A set of files that makes Claude Code build SpeedPilot: a speed optimizer for WordPress and Shopify that audits a site, X-rays how every script and plugin or app really works, backs the site up, fixes speed one safe change at a time without any cache plugin, proves nothing broke, and produces before and after reports.

What gets built: a command-line tool, an MCP server (so Claude can run it as tools), a WordPress agent plugin (mu-plugin with an on/off switch for every fix), Shopify theme tooling through Shopify CLI, our own reverse-engineering engine (the X-ray Engine: deep capture, static analysis of JS, CSS, PHP and Liquid, safe-change verdicts, a what-if simulator, a recipe library and a competitor benchmark; REA is only an optional cross-check), and a report builder.

## What runs by itself, and what needs you

| SpeedPilot does it by itself | You approve (in your own terminal) | The client decides (T3) |
|---|---|---|
| Collecting all data, X-ray, finding problems, before report | Preparing staging | Removing or replacing a plugin or app |
| Backup and restore test | Which fixes to apply on staging | Design changes (hero slider, preloader, sections) |
| Applying each approved fix, measuring, verifying | Deploying to production | Tracking, consent or GTM changes |
| Rolling back any fix that breaks something | | Hosting, PHP, server or CDN changes |
| After report, monitoring, learning for next time | | Heavy widget replaced by a lightweight build |

## Files

| File | What it is |
|---|---|
| CLAUDE.md | The 16 safety rules and targets. Claude Code reads it automatically in every session. |
| SPEC.md | The full build spec: architecture, data collection, backup, verification, fixes, reports, grades, and the X-ray Engine, our own reverse-engineering engine (section 15). |
| CHECKS.md | Everything that slows a WordPress or Shopify site and everything that breaks one, with how to detect, fix and verify each. |
| KICKOFF.md | One-time setup, then the prompts to paste into Claude Code in order, each with its "Done when" list. |

## Start

1. Do the one-time setup at the top of KICKOFF.md.
2. Open Claude Code in the project folder.
3. Paste Prompt 0, answer its questions, then go prompt by prompt.

## Needs (all free)

Node.js 22.19+, pnpm, Git, Docker Desktop, Shopify CLI, a Shopify Partner development store, and a Google Cloud API key with PageSpeed Insights API and Chrome UX Report API enabled.
