import { Command } from 'commander';
import { ensureFixturePreview, shopifyAuditBackend, backupShopify, verifyShopifyBackup } from '@speedpilot/shopify';
import { join } from 'node:path';
import { beforeReport } from '@speedpilot/report';
import { xrayRun, loadXray, explain, isSafe, simulate, graphHtml, diffModels, competitorBenchmark, updateLatestSummary } from '@speedpilot/xray';
import { writeFileSync } from 'node:fs';
import {
  projectRoot,
  writeSiteYaml,
  loadSite,
  accessCheck,
  writeApproval,
  insideClaudeCode,
  Store,
  setActiveSite,
  type Stage,
  auditSite,
  hostFor,
  backupWordPress,
  restoreTest,
  prepareWordPressStaging,
  recordBaseline,
  verify,
} from '@speedpilot/core';

function out(obj: unknown, json?: boolean) {
  if (json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else if (typeof obj === 'string') process.stdout.write(obj + '\n');
  else process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function buildProgram(): Command {
  const program = new Command('speedpilot').description('Speed optimizer for WordPress and Shopify').version('0.1.0');
  const root = () => projectRoot();

  program
    .command('init <site>')
    .description('write sites/<site>/site.yaml with the intake questions as TODOs')
    .option('--platform <platform>', 'wordpress or shopify', 'wordpress')
    .option('--url <url>', 'production URL', 'https://example.com/')
    .option('--force', 'overwrite an existing site.yaml')
    .action((site: string, o: { platform: 'wordpress' | 'shopify'; url: string; force?: boolean }) => {
      const p = writeSiteYaml(root(), site, o.platform, o.url, o.force);
      setActiveSite(root(), site);
      out(`Wrote ${p}. Answer the TODO intake questions, then run: speedpilot access check ${site}`);
    });

  const access = program.command('access').description('credential checks');
  access
    .command('check <site>')
    .description('read-only probe of every credential')
    .option('--json', 'JSON output')
    .action(async (site: string, o: { json?: boolean }) => {
      const cfg = loadSite(root(), site);
      const results = await accessCheck(cfg);
      if (o.json) return out(results, true);
      for (const r of results) out(`${r.skipped ? 'SKIP' : r.ok ? 'OK  ' : 'FAIL'}  ${r.probe}: ${r.detail}${r.revoke ? `  [${r.revoke}]` : ''}`);
      if (results.some((r) => !r.ok && !r.skipped)) process.exitCode = 1;
    });

  program
    .command('audit <site>')
    .description('read-only audit (safe on production): Lighthouse x5, traces, Playwright collectors, INP, field data')
    .option('--stage <stage>', 'production or staging (local sites are always local)')
    .option('--runs <n>', 'Lighthouse runs per URL and device', '5')
    .option('--devices <list>', 'mobile,desktop', 'mobile,desktop')
    .option('--urls <list>', 'override the sample URLs (comma-separated)')
    .option('--json', 'print the JSON summary')
    .action(async (site: string, o: { stage?: Stage; runs: string; devices: string; urls?: string; json?: boolean }) => {
      const cfg = loadSite(root(), site);
      const preview = await ensureFixturePreview(root(), cfg);
      const r = await auditSite(root(), site, {
        backend: cfg.platform === 'shopify' ? shopifyAuditBackend : undefined,
        stage: o.stage,
        lighthouseRuns: Number(o.runs),
        devices: o.devices.split(',') as Array<'mobile' | 'desktop'>,
        urls: o.urls?.split(','),
      });
      await preview?.close();
      if (o.json) return out(r, true);
      out(`Audit ${r.runId} (${r.stage}) saved in ${r.dir}`);
      for (const p of r.pages) {
        const m = p.lighthouse?.median;
        out(`  ${p.device.padEnd(7)} ${p.url}  score ${m?.score ?? '-'}  LCP ${m?.lcp ? Math.round(m.lcp) + ' ms' : '-'}  TBT ${m?.tbt ?? '-'}  CLS ${m?.cls?.toFixed(3) ?? '-'}`);
      }
      for (const n of r.notes) out(`  note: ${n}`);
    });

  const report = program.command('report').description('reports (HTML, PDF, JSON, Markdown)');
  report
    .command('before <site>')
    .description('analyze the latest audit with every CHECKS.md rule and write the before report')
    .option('--run <id>', 'audit run ID (default: latest)')
    .option('--anonymized', 'also write the anonymized portfolio version')
    .option('--no-pdf', 'skip the PDF')
    .action(async (site: string, o: { run?: string; anonymized?: boolean; pdf?: boolean }) => {
      const { written, analysis } = await beforeReport(root(), site, { runId: o.run, anonymized: o.anonymized, pdf: o.pdf });
      out(`Grade ${analysis.grade.grade ?? '-'}; ${analysis.findings.length} findings; phone score ${analysis.ceiling.current ?? '-'} -> reachable ${analysis.ceiling.reachable ?? '-'}`);
      for (const f of analysis.findings.slice(0, 10)) out(`  ${f.priority.toFixed(1).padStart(6)}  ${f.checkId.padEnd(8)} ${f.tier.padEnd(6)} ${f.title}`);
      for (const w of written) out(`Report: ${w.html}${w.pdf ? `, ${w.pdf}` : ''}, ${w.json}, ${w.markdown}`);
    });

  const backup = program.command('backup').description('backups (SPEC 5)');
  backup
    .argument('[site]')
    .option('--stage <stage>', 'production or staging', 'production')
    .option('--skip-uploads', 'large media: checksum manifest for uploads instead of archiving them')
    .action(async (site: string | undefined, o: { stage: Stage; skipUploads?: boolean }) => {
      if (!site) return backup.help();
      const cfg = loadSite(root(), site);
      const store = new Store(root());
      try {
        store.upsertSite(cfg);
        const stage: Stage = cfg.local ? 'local' : o.stage;
        if (cfg.platform === 'wordpress') {
          const r = await backupWordPress(cfg, stage, { host: hostFor(root(), cfg, stage), store, backupsDir: join(root(), 'backups'), skipUploads: o.skipUploads });
          out(`Backup ${r.id} (${r.manifest.disk.mode}, ${r.manifest.artifacts.map((a) => a.name).join(', ')}) in ${r.dir}. Next: speedpilot backup verify ${site} --id ${r.id}`);
        } else {
          const r = await backupShopify(root(), cfg, store, { backupsDir: join(root(), 'backups') });
          out(`Backup ${r.id}: live ${r.manifest.liveThemeId}, backup theme ${r.manifest.backupThemeId}, work theme ${r.manifest.workThemeId}, git tag ${r.manifest.gitTag}.`);
        }
      } finally {
        store.close();
      }
    });
  backup
    .command('verify <site>')
    .description('restore test: restore into a fresh local WordPress and run the smoke flows (Shopify: checksums and preview)')
    .requiredOption('--id <backup-id>')
    .option('--keep', 'keep the restored copy running')
    .action(async (site: string, o: { id: string; keep?: boolean }) => {
      const cfg = loadSite(root(), site);
      const store = new Store(root());
      try {
        if (cfg.platform === 'wordpress') {
          const r = await restoreTest(root(), cfg, store, o.id, { keep: o.keep });
          out(`${r.verified ? 'VERIFIED' : 'NOT VERIFIED'}: ${o.id} restored at ${r.url}; pages ${r.smoke.pages.filter((p) => p.pass).length}/${r.smoke.pages.length}, flows ${r.smoke.flows.filter((f) => f.pass).length}/${r.smoke.flows.length}`);
          if (!r.verified) process.exitCode = 1;
        } else {
          const r = await verifyShopifyBackup(cfg, store, o.id);
          out(`${r.verified ? 'VERIFIED' : 'NOT VERIFIED'}: ${r.mismatches.length} file mismatches, ${r.liquidErrors.length} Liquid errors`);
          if (!r.verified) process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });

  program
    .command('staging')
    .description('staging (SPEC 5.2, 5.3)')
    .argument('<action>', 'prepare')
    .argument('<site>')
    .option('--port <port>', 'local staging port', '8897')
    .action(async (action: string, site: string, o: { port: string }) => {
      if (action !== 'prepare') throw new Error('usage: speedpilot staging prepare <site>');
      const cfg = loadSite(root(), site);
      const store = new Store(root());
      try {
        if (cfg.platform === 'wordpress') {
          const r = await prepareWordPressStaging(root(), cfg, store, { port: Number(o.port) });
          out(`Staging (${r.mode}) at ${r.url}: ${r.pass ? 'neutralized' : 'NEUTRALIZATION FAILED'}`);
          for (const c of r.checks) out(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : ` (${c.detail})`}`);
          if (!r.pass) process.exitCode = 1;
        } else {
          const r = await backupShopify(root(), cfg, store, { backupsDir: join(root(), 'backups') });
          out(`Work theme ${r.manifest.workThemeId} ready (backup theme ${r.manifest.backupThemeId}). Preview: https://${r.manifest.store}/?preview_theme_id=${r.manifest.workThemeId}`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command('baseline <site>')
    .description('record the verification baseline (screenshots, console, network, flows, tracking, SEO, accessibility, backend, performance)')
    .option('--stage <stage>', 'local, staging or production')
    .option('--urls <list>', 'comma-separated URLs (default: sample URLs)')
    .option('--runs <n>', 'Lighthouse runs per URL and device', '3')
    .action(async (site: string, o: { stage?: Stage; urls?: string; runs: string }) => {
      const b = await recordBaseline(root(), site, { stage: o.stage, urls: o.urls?.split(','), lighthouseRuns: Number(o.runs) });
      out(`Baseline ${b.runId} on ${b.stage} (${b.urls.length} URLs, ${b.captures[0]?.flows.length ?? 0} flow runs) in ${b.dir}`);
    });

  program
    .command('verify <site>')
    .description('compare the current state with the baseline; PASS only if every check passes (SPEC 6)')
    .option('--stage <stage>', 'local, staging or production')
    .option('--full', 'full set: every viewport, 5 Lighthouse runs')
    .option('--urls <list>', 'only these URLs (quick verification of affected URLs)')
    .option('--json', 'JSON output')
    .action(async (site: string, o: { stage?: Stage; full?: boolean; urls?: string; json?: boolean }) => {
      const r = await verify(root(), site, { stage: o.stage, full: o.full, urls: o.urls?.split(',') });
      if (o.json) return out(r, true);
      out(`${r.result} (${r.kind}) evidence: ${r.evidenceDir}`);
      for (const c of r.checks) {
        out(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
        if (!c.pass) for (const d of c.details.slice(0, 8)) out(`       ${d}`);
        if (!c.pass) for (const e of c.evidence.slice(0, 4)) out(`       evidence: ${e}`);
      }
      if (r.result === 'FAIL') process.exitCode = 1;
    });

  const xray = program.command('xray').description('X-ray Engine (SPEC.md 15): our own reverse-engineering engine. Deep analysis only with the client\'s written permission (CLAUDE.md rule 16).');
  xray
    .command('run <site>', { isDefault: true })
    .description('capture, static analysis, Site Model, verdicts, waterfalls, costs and graph')
    .option('--stage <stage>', 'production or staging')
    .option('--deep', 'mobile and desktop, consent states')
    .option('--no-explore', 'skip safe-list exploration')
    .option('--urls <list>', 'comma-separated URLs')
    .option('--rea', 'also run the optional REA cross-check (needs network; never decisive)')
    .action(async (site: string, o: { stage?: Stage; deep?: boolean; explore?: boolean; urls?: string; rea?: boolean }) => {
      const cfg = loadSite(root(), site);
      const preview = await ensureFixturePreview(root(), cfg);
      try {
        const x = await xrayRun(root(), site, { stage: o.stage, deep: o.deep, explore: o.explore, urls: o.urls?.split(','), rea: o.rea });
        const types = new Map<string, number>();
        for (const n of x.model.nodes.values()) types.set(n.type, (types.get(n.type) ?? 0) + 1);
        const count = (v: string) => x.verdicts.filter((y) => y.verdict === v).length;
        out(`X-ray ${x.runId}: ${x.captures.length} captures, ${x.model.nodes.size} nodes, ${x.model.edges.length} edges (${[...types.entries()].map(([k, v]) => `${v} ${k}`).join(', ')}).
Verdicts: ${count('safe')} safe, ${count('unsafe')} unsafe, ${count('unknown')} unknown. Slow handlers: ${x.summary.slowHandlers.length}. Unknown owners (recipe drafts): ${x.summary.unknownScripts.length}.
Evidence: ${x.dir}/xray (site-model.json, verdicts.json, summary.json, graph.html, costs.html, waterfalls/)${x.rea ? `\nREA: ${x.rea.available ? `${x.rea.findings.length} findings (extra evidence only)` : x.rea.reason}` : ''}`);
      } finally {
        await preview?.close();
      }
    });
  xray
    .command('explain <site> <ref>')
    .description('what the Site Model knows about a script URL, handle or selector, with the reason for every verdict')
    .option('--run <id>', 'X-ray run ID (default: latest)')
    .option('--json', 'JSON output')
    .action((site: string, ref: string, o: { run?: string; json?: boolean }) => {
      const x = loadXray(root(), site, o.run);
      const e = explain(x.ctx, ref, x.dir);
      out(o.json ? e : `${e.text}\n\nEvidence: ${e.evidence.join(', ')}`, o.json);
    });
  xray
    .command('safe <site>')
    .description('verdict for one change: defer, async, delay, remove or remove-template')
    .requiredOption('--change <change>', '"<type>:<target>", for example defer:jquery-core')
    .option('--template <template>', 'template for remove-template')
    .option('--run <id>', 'X-ray run ID (default: latest)')
    .option('--json', 'JSON output')
    .action((site: string, o: { change: string; template?: string; run?: string; json?: boolean }) => {
      const x = loadXray(root(), site, o.run);
      const v = isSafe(x.ctx, o.change, o.template);
      out(o.json ? v : `${v.verdict.toUpperCase()}: ${v.explanation}\nEvidence: ${x.dir}/xray/verdicts.json`, o.json);
      if (v.verdict !== 'safe') process.exitCode = 2;
    });
  xray
    .command('simulate <site>')
    .description('what-if simulation through a local rewriting proxy (results are labelled "simulated")')
    .requiredOption('--change <change>', '"<type>:<target>": defer, async, remove, remove-template, delay, preload (url|as), lcp-eager')
    .option('--urls <list>', 'comma-separated URLs (default: the first sample URL)')
    .option('--runs <n>', 'runs per arm', '5')
    .option('--json', 'JSON output')
    .action(async (site: string, o: { change: string; urls?: string; runs: string; json?: boolean }) => {
      const cfg = loadSite(root(), site);
      if (!cfg.local && !cfg.permission.reverseEngineering) throw new Error('Simulation of a client site needs permission.reverseEngineering: true (CLAUDE.md rule 16).');
      const preview = await ensureFixturePreview(root(), cfg);
      try {
        const urls = o.urls?.split(',') ?? [cfg.sampleUrls[0] ?? cfg.productionUrl];
        const results = [];
        for (const url of urls) results.push(await simulate(url, o.change, { outDir: join(root(), 'runs', site, `simulate-${Date.now()}`), runs: Number(o.runs), platform: cfg.platform, local: cfg.local }));
        updateLatestSummary(root(), site, { simulations: results.map((r) => ({ change: r.change, gainMs: r.gain.lcpMs.median, ok: r.ok, issues: r.issues })) });
        out(o.json ? results : results.map((r) => `SIMULATED ${r.change} on ${r.url}: LCP gain ${r.gain.lcpMs.median} ms (range ${r.gain.lcpMs.min} to ${r.gain.lcpMs.max}), TBT gain ${r.gain.tbtMs.median} ms, CLS gain ${r.gain.cls.median}. ${r.ok ? 'No breakage signals.' : `REV-08: ${r.issues.join('; ')}`}\nEvidence: ${r.evidenceDir}`).join('\n'), o.json);
      } finally {
        await preview?.close();
      }
    });
  xray
    .command('graph <site>')
    .description('interactive dependency graph (HTML, Cytoscape.js)')
    .requiredOption('--out <file>', 'output HTML file')
    .option('--run <id>', 'X-ray run ID (default: latest)')
    .action((site: string, o: { out: string; run?: string }) => {
      const x = loadXray(root(), site, o.run);
      writeFileSync(o.out, graphHtml(x.ctx.model, `X-ray ${site} ${x.runId}`));
      out(`Graph written to ${o.out}`);
    });
  xray
    .command('diff <site> <run-a> <run-b>')
    .description('what changed between two X-ray runs')
    .option('--json', 'JSON output')
    .action((site: string, a: string, b: string, o: { json?: boolean }) => {
      const xa = loadXray(root(), site, a);
      const xb = loadXray(root(), site, b);
      const d = diffModels(xa.ctx.model, xb.ctx.model, xa.summary?.verdicts ?? [], xb.summary?.verdicts ?? []);
      out(o.json ? d : `Added: ${d.nodesAdded.length} nodes, removed: ${d.nodesRemoved.length}. Dependencies +${d.dependenciesAdded.length}/-${d.dependenciesRemoved.length}. Verdict changes: ${d.verdictChanges.map((v) => `${v.change} ${v.from}->${v.to}`).join(', ') || 'none'}.`, o.json);
    });
  xray
    .command('benchmark <site>')
    .description('competitor benchmark from public data and one normal visit per URL (REV-06)')
    .requiredOption('--competitors <list>', 'comma-separated competitor URLs (3 to 5, confirmed by the client)')
    .option('--json', 'JSON output')
    .action(async (site: string, o: { competitors: string; json?: boolean }) => {
      const cfg = loadSite(root(), site);
      const t = await competitorBenchmark(cfg.productionUrl, o.competitors.split(','), { cruxKey: process.env.CRUX_API_KEY });
      updateLatestSummary(root(), site, { competitors: t.rows.slice(1).map((r) => ({ url: r.url, lcp: r.field?.lcp, inp: r.field?.inp, notes: r.notes })) });
      out(o.json ? t : `${t.markdown}\n\n${t.plainWords}`, o.json);
    });

  program
    .command('approve <plan-id>')
    .description('HUMAN ONLY: record an approval for a plan or operation (typed in your own terminal)')
    .requiredOption('--stage <stage>', 'staging or production')
    .option('--site <site>', 'site (defaults to the plan\'s site)')
    .option('--items <ids>', 'comma-separated item IDs, or "all"', 'all')
    .requiredOption('--by <name>', 'approver name')
    .action((planId: string, o: { stage: Stage; site?: string; items: string; by: string }) => {
      if (insideClaudeCode()) {
        throw new Error('speedpilot approve must be typed by a human in their own terminal, not run by Claude Code (SPEC.md 14.1).');
      }
      if (o.stage !== 'staging' && o.stage !== 'production') throw new Error('--stage must be staging or production');
      const store = new Store(root());
      try {
        let site = o.site;
        let items = o.items === 'all' ? ['all'] : o.items.split(',').map((s) => s.trim()).filter(Boolean);
        const plan = store.getPlan<{ items: Array<{ id: string; tier: string }> }>(planId);
        if (!site) site = plan?.site_id;
        if (!site) throw new Error('--site is required for operations without a stored plan (for example staging-prep).');
        if (plan && items[0] === 'all') items = plan.plan.items.map((i) => i.id);
        if (plan) {
          const known = new Set(plan.plan.items.map((i) => i.id));
          const unknown = items.filter((i) => !known.has(i));
          if (unknown.length) throw new Error(`Unknown plan items: ${unknown.join(', ')}`);
          const t3 = plan.plan.items.filter((i) => items.includes(i.id) && i.tier === 'T3');
          if (t3.length) process.stderr.write(`Note: ${t3.map((i) => i.id).join(', ')} are T3 and need the client's written approval.\n`);
        }
        const { file, approval } = writeApproval(root(), { site, stage: o.stage as 'staging' | 'production', operation: planId, items, approvedBy: o.by });
        store.addApproval({ planId, site, stage: o.stage, items, approver: o.by, approvedAt: approval.approvedAt, text: approval.text });
        out(`Approved ${items.join(', ')} for ${o.stage}. Approval file: ${file} (valid 24 hours).`);
      } finally {
        store.close();
      }
    });

  return program;
}
