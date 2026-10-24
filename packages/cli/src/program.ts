import { Command } from 'commander';
import { ensureFixturePreview, shopifyAuditBackend, backupShopify, verifyShopifyBackup } from '@speedpilot/shopify';
import { join } from 'node:path';
import { beforeReport } from '@speedpilot/report';
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
