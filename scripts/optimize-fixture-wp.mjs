#!/usr/bin/env node
// Phase 10 proof on the local WordPress fixture: X-ray, baseline, proposals, then the T1 and T2 modules one by one
// through the apply loop with verification after each, and mobile Lighthouse before and after (5 runs per URL).
// Usage: node scripts/optimize-fixture-wp.mjs [--skip-before] [--tiers T1,T2]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, recordBaseline, runLighthouse, projectRoot } from '../packages/core/dist/index.js';
import { xrayRun } from '../packages/xray/dist/index.js';
import { planWordPress, applyWpProposals } from '../packages/engine/dist/index.js';

const root = projectRoot();
const site = 'fixture-wp';
const args = process.argv.slice(2);
const tiers = (args.includes('--tiers') ? args[args.indexOf('--tiers') + 1] : 'T1,T2').split(',');
const cfg = loadSite(root, site);
const out = join(root, 'runs', site, `phase10-${Date.now()}`);
mkdirSync(out, { recursive: true });
const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function lighthouse(tag) {
  const rows = [];
  mkdirSync(join(out, `lh-${tag}`), { recursive: true });
  for (const url of cfg.sampleUrls) {
    const r = await runLighthouse(url, 'mobile', { outDir: join(out, `lh-${tag}`), runs: 5, categories: ['performance'] });
    rows.push({ url, score: r.median.score, range: r.range.score, lcp: r.median.lcp, tbt: r.median.tbt, cls: r.median.cls });
    say(`${tag} ${url} score ${r.median.score} (${r.range.score.min}-${r.range.score.max}) LCP ${Math.round(r.median.lcp)} TBT ${Math.round(r.median.tbt)} CLS ${r.median.cls?.toFixed(3)}`);
  }
  writeFileSync(join(out, `lighthouse-${tag}.json`), JSON.stringify(rows, null, 2));
  return rows;
}

if (!args.includes('--skip-before')) await lighthouse('before');
say('X-ray');
await xrayRun(root, site, { urls: cfg.sampleUrls.slice(0, 4) });
say('baseline');
await recordBaseline(root, site, {});
say('plan');
const { proposals, probes, dir } = await planWordPress(root, site);
say(`${proposals.length} proposals (${dir}): ${proposals.map((p) => `${p.id}[${p.tier}]`).join(', ')}`);
for (const p of proposals) for (const s of p.skipped) say(`  skipped in ${p.id}: ${s.slice(0, 160)}`);
const steps = await applyWpProposals(root, site, proposals, { tiers, outDir: join(out, 'apply'), probes, simulationRuns: 3, net: { latencyMs: 40, downloadKbps: 10000 }, onStep: (s) => say(`${s.proposal}: ${s.status} - ${s.reason.slice(0, 300)}`) });
writeFileSync(join(out, 'apply.json'), JSON.stringify(steps, null, 2));
await lighthouse('after');
say(`done: ${out}`);
