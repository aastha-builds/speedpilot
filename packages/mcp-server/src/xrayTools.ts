/**
 * The X-ray MCP tool set (SPEC.md 15.9): 9 tools (10 at most), each answer under 20 KB with evidence paths instead of
 * raw dumps.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadSite, slug } from '@speedpilot/core';
import { xrayRun, loadXray, explain, isSafe, simulate, diffModels, updateLatestSummary, type XraySummary } from '@speedpilot/xray';
import { ensureFixturePreview } from '@speedpilot/shopify';

export const MAX_ANSWER_BYTES = 20_000;

/** Shrinks arrays until the JSON answer fits under the limit, and says so. */
export function capAnswer(obj: Record<string, unknown>, limit = MAX_ANSWER_BYTES): Record<string, unknown> {
  let o = structuredClone(obj);
  let size = Buffer.byteLength(JSON.stringify(o));
  let keep = 50;
  while (size > limit && keep >= 1) {
    const shrink = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.slice(0, keep).map(shrink);
      if (typeof v === 'string') return v.length > keep * 40 ? `${v.slice(0, keep * 40)}…` : v;
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
      return v;
    };
    o = shrink(obj) as Record<string, unknown>;
    o.truncated = `Answer shortened to stay under ${limit / 1000} KB; full data in the evidence paths.`;
    size = Buffer.byteLength(JSON.stringify(o));
    keep = Math.floor(keep / 2);
  }
  return o;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function xrayTools(root: string): ToolDef[] {
  const site = z.string().describe('site name (sites/<site>/site.yaml)');
  const run = z.string().optional().describe('X-ray run ID (default: latest)');
  return [
    {
      name: 'xray_run',
      description: 'Run the X-ray on a site (needs written permission for client sites). Returns counts and the evidence folder.',
      input: { site, stage: z.enum(['production', 'staging']).optional(), urls: z.array(z.string()).optional(), deep: z.boolean().optional() },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        const preview = await ensureFixturePreview(root, cfg);
        try {
          const x = await xrayRun(root, String(a.site), { stage: a.stage as never, urls: a.urls as string[] | undefined, deep: Boolean(a.deep) });
          const count = (v: string) => x.verdicts.filter((y) => y.verdict === v).length;
          return { runId: x.runId, captures: x.captures.length, nodes: x.model.nodes.size, edges: x.model.edges.length, verdicts: { safe: count('safe'), unsafe: count('unsafe'), unknown: count('unknown') }, slowHandlers: x.summary.slowHandlers.length, evidence: [`${x.dir}/xray/summary.json`, `${x.dir}/xray/site-model.json`, `${x.dir}/xray/graph.html`] };
        } finally {
          await preview?.close();
        }
      },
    },
    {
      name: 'xray_summary',
      description: 'The latest X-ray summary: safe changes, early and late resources, slow handlers, heavy widgets, recipe gaps.',
      input: { site, run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const s = x.summary as XraySummary;
        return { runId: x.runId, safe: s.verdicts.filter((v) => v.verdict === 'safe').map((v) => v.change), unsafe: s.verdicts.filter((v) => v.verdict === 'unsafe').map((v) => ({ change: v.change, why: v.reasons[0] })), unknownCount: s.verdicts.filter((v) => v.verdict === 'unknown').length, earlyUnused: s.earlyUnused, lateNeeded: s.lateNeeded, slowHandlers: s.slowHandlers, heavyWidgets: s.heavyWidgets, recipeMismatches: s.recipeMismatches, unknownOwners: s.unknownScripts, evidence: [`${x.dir}/xray/summary.json`, `${x.dir}/xray/verdicts.json`] };
      },
    },
    {
      name: 'xray_explain',
      description: 'Explain one script (URL or handle), element (selector) or owner: who needs it, what it needs, its handlers and every verdict in plain words.',
      input: { site, ref: z.string(), run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const e = explain(x.ctx, String(a.ref), x.dir);
        return { kind: e.kind, text: e.text, verdicts: e.verdicts.map((v) => ({ change: v.change, verdict: v.verdict })), evidence: e.evidence };
      },
    },
    {
      name: 'xray_is_safe',
      description: 'Verdict (safe, unsafe, unknown) for one change: defer, async, delay, remove or remove-template, with evidence. Unknown is never touched.',
      input: { site, change: z.string().describe('<type>:<target>, e.g. defer:jquery-core or remove-template:contact-form-7@home'), template: z.string().optional(), run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const v = isSafe(x.ctx, String(a.change), a.template as string | undefined);
        return { change: v.change, verdict: v.verdict, explanation: v.explanation, confidence: v.confidence, reasons: v.reasons.filter((r) => r.severity !== 'ok').map((r) => ({ severity: r.severity, detail: r.detail, evidence: r.evidence, page: r.page })), evidence: [`${x.dir}/xray/verdicts.json`] };
      },
    },
    {
      name: 'xray_simulate',
      description: 'What-if simulation of a change through a local rewriting proxy, 5 runs per arm. Results are labelled "simulated"; real numbers come from staging.',
      input: { site, change: z.string(), url: z.string().optional(), runs: z.number().int().min(1).max(10).optional() },
      async run(a) {
        const cfg = loadSite(root, String(a.site));
        if (!cfg.local && !cfg.permission.reverseEngineering) throw new Error('Needs permission.reverseEngineering: true (CLAUDE.md rule 16).');
        const preview = await ensureFixturePreview(root, cfg);
        try {
          const url = (a.url as string | undefined) ?? cfg.sampleUrls[0] ?? cfg.productionUrl;
          const r = await simulate(url, String(a.change), { outDir: join(root, 'runs', String(a.site), `simulate-${slug(String(a.change))}-${Date.now()}`), runs: (a.runs as number | undefined) ?? 5, platform: cfg.platform, local: cfg.local });
          updateLatestSummary(root, String(a.site), { simulations: [{ change: r.change, gainMs: r.gain.lcpMs.median, ok: r.ok, issues: r.issues }] });
          return { label: r.label, change: r.change, url: r.url, gain: r.gain, ok: r.ok, issues: r.issues, evidence: [`${r.evidenceDir}/simulation.json`] };
        } finally {
          await preview?.close();
        }
      },
    },
    {
      name: 'xray_owner_costs',
      description: 'Main-thread ms, bytes, requests, layout shift and worst handler per owner (plugin, app, theme, third party).',
      input: { site, run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const p = join(x.dir, 'xray', 'costs.json');
        return { costs: existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [], evidence: [p, join(x.dir, 'xray', 'costs.html')] };
      },
    },
    {
      name: 'xray_interactions',
      description: 'Interaction deep dive: for each explored interaction, input delay, processing and presentation, and the handlers that ran (owner, file, line, ms).',
      input: { site, run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const p = join(x.dir, 'xray', 'interactions.json');
        const list = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown[]) : [];
        return { interactions: list.slice(0, 20), evidence: [p] };
      },
    },
    {
      name: 'xray_waterfall',
      description: 'Ideal versus actual waterfall for a page: what the first screen needs against what loads and when (REV-02, REV-03).',
      input: { site, url: z.string().optional(), run },
      async run(a) {
        const x = loadXray(root, String(a.site), a.run as string | undefined);
        const dir = join(x.dir, 'xray', 'waterfalls');
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
        const want = a.url ? slug(String(a.url)) : undefined;
        const f = files.find((x2) => (want ? x2.startsWith(want) : true));
        if (!f) return { error: 'no waterfall for that URL', available: files };
        const w = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { page: string; fcp: number; lcp: number; lcpUrl: string; actual: unknown[]; ideal: unknown[]; earlyUnused: unknown[]; lateNeeded: unknown[] };
        return { page: w.page, fcp: w.fcp, lcp: w.lcp, lcpUrl: w.lcpUrl, actualCount: w.actual.length, idealCount: w.ideal.length, ideal: w.ideal, earlyUnused: w.earlyUnused, lateNeeded: w.lateNeeded, evidence: [join(dir, f), join(dir, f.replace(/\.json$/, '.html'))] };
      },
    },
    {
      name: 'xray_diff',
      description: 'What changed between two X-ray runs: nodes, dependencies, verdicts and bytes per owner.',
      input: { site, runA: z.string(), runB: z.string() },
      async run(a) {
        const xa = loadXray(root, String(a.site), String(a.runA));
        const xb = loadXray(root, String(a.site), String(a.runB));
        return { ...diffModels(xa.ctx.model, xb.ctx.model, xa.summary?.verdicts ?? [], xb.summary?.verdicts ?? []), evidence: [`${xa.dir}/xray`, `${xb.dir}/xray`] };
      },
    },
  ];
}
