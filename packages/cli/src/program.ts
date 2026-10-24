import { Command } from 'commander';
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
