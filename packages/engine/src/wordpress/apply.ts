/**
 * WordPress apply loop for the agent modules (SPEC.md 7.2 and 8.1): for each proposal, in order, prepare its files,
 * pass its gates (X-ray `safe` verdicts, a what-if simulation with no breakage), turn on its one flag (or run its
 * scripted database steps), run the verification, and keep it or roll it back with the reason. Writes go through
 * this executor only: on anything but a local fixture it checks the approval file itself (CLAUDE.md rule 10).
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { WpCli, loadSite, requireApproval, log, verify, AgentClient, FIXTURE_HMAC_SECRET, secret, classify, type Stage, type SiteConfig, type VerificationResult, type AgentDiag } from '@speedpilot/core';
import { isSafe, simulate, loadXray, type SimulationResult, type VerdictContext } from '@speedpilot/xray';
import { buildSelfHostedFonts } from './fonts.js';
import type { Proposal } from './proposals.js';
import type { ProbeResult } from '../probe.js';

export interface FlagsDoc {
  version: number;
  modules: Record<string, { enabled: boolean; rules?: unknown; settings?: Record<string, unknown> }>;
  log?: unknown[];
}

/** WP-CLI for SpeedPilot's executor: writes allowed on local fixtures, elsewhere only with a valid approval file. */
export function executorWp(root: string, cfg: SiteConfig, stage: Stage, approval?: { operation: string; item?: string }): WpCli {
  if (!(cfg.local || stage === 'local')) {
    if (!approval) throw new Error(`Writes on ${stage} need an approved plan item (CLAUDE.md rule 10).`);
    requireApproval(root, { site: cfg.name, operation: approval.operation, stage, item: approval.item });
  }
  return new WpCli(root, cfg, stage, undefined, true);
}

export async function readFlags(wp: WpCli): Promise<FlagsDoc> {
  const t = await wp.text(['speedpilot', 'export']);
  return JSON.parse(t.slice(t.indexOf('{'))) as FlagsDoc;
}

/** Restores one module to a previous state (rollback of one change). */
export async function restoreModule(wp: WpCli, key: string, prev: FlagsDoc['modules'][string] | undefined, reason: string): Promise<void> {
  if (!prev || !prev.enabled) {
    await wp.text(['speedpilot', 'disable', key, `--reason=${reason}`]);
    return;
  }
  await wp.text(['speedpilot', 'enable', key, `--rules=${JSON.stringify(prev.rules ?? {})}`, `--settings=${JSON.stringify(prev.settings ?? {})}`, `--reason=${reason}`]);
}

async function putFile(wp: WpCli, rel: string, data: Buffer): Promise<string> {
  const r = await wp.raw(['speedpilot', 'put-file', rel], { input: data.toString('base64') });
  if (r.code !== 0) throw new Error(`put-file ${rel}: ${r.stderr || r.stdout}`);
  return (JSON.parse(r.stdout.trim().split('\n').pop()!) as { url: string }).url;
}

/** Fills settings that need work on the site first: resized image copies, self-hosted fonts. */
export async function prepareProposal(p: Proposal, wp: WpCli, ctx: { probes: ProbeResult[]; uploadsUrl: string }): Promise<void> {
  if (p.module === 'images' && Array.isArray(p.settings.oversized) && (p.settings.oversized as string[]).length) {
    const out = JSON.parse((await wp.text(['speedpilot', 'images-build', (p.settings.oversized as string[]).join(',')])).split('\n').pop()!) as Record<string, { srcset: string }>;
    const srcset: Record<string, { srcset: string; sizes: string }> = {};
    for (const [url, v] of Object.entries(out)) {
      const rendered = Math.max(...ctx.probes.flatMap((pr) => pr.images.filter((i) => i.src === url).map((i) => i.renderedWidth)), 0);
      if (v.srcset) srcset[url.split('/').pop()!.split('?')[0]!] = { srcset: v.srcset, sizes: rendered ? `(max-width: ${Math.max(...ctx.probes.map((pr) => pr.viewport.width))}px) ${rendered}px, ${rendered}px` : '100vw' };
    }
    p.settings.srcset = srcset;
    delete p.settings.oversized;
  }
  if (p.module === 'lcp') {
    const href = String(p.settings.href);
    const out = JSON.parse((await wp.text(['speedpilot', 'images-build', href])).split('\n').pop()!) as Record<string, { srcset: string }>;
    if (out[href]?.srcset) {
      p.settings.imagesrcset = out[href]!.srcset;
      p.settings.imagesizes = '100vw';
    }
  }
  if (p.module === 'fonts' && Array.isArray(p.settings.googleCss)) {
    const used = ctx.probes.flatMap((pr) => pr.fontsLoaded);
    const critical = ctx.probes.map((pr) => pr.criticalCss).join('\n');
    const built = await buildSelfHostedFonts(p.settings.googleCss as string[], used, `${ctx.uploadsUrl.replace(/\/$/, '')}/speedpilot/fonts/`, critical);
    for (const f of built.files) await putFile(wp, `fonts/${f.name}`, f.data!);
    p.settings = { dequeue: p.settings.dequeue, css: built.css, preload: built.preload, fallbackCss: built.fallbackCss };
  }
}

export interface GateResult {
  ok: boolean;
  verdicts: Array<{ change: string; verdict: string; explanation: string }>;
  simulation?: SimulationResult;
  reasons: string[];
}

/** SPEC.md 15.5: every defer, delay or dequeue needs an X-ray `safe` verdict and a passing simulation first. */
export async function gateProposal(p: Proposal, xray: VerdictContext, o: { outDir: string; runs?: number; local: boolean; platform: 'wordpress' | 'shopify'; net?: { latencyMs: number; downloadKbps: number } }): Promise<GateResult> {
  const reasons: string[] = [];
  const verdicts = p.xrayChanges.map((c) => {
    const v = isSafe(xray, c);
    if (v.verdict !== 'safe') reasons.push(`${c} is ${v.verdict}: ${v.explanation}`);
    return { change: c, verdict: v.verdict, explanation: v.explanation };
  });
  if (reasons.length || !p.simulate.length) return { ok: reasons.length === 0, verdicts, reasons };
  // simulate on a page where every change applies (per-template removal only on its template)
  const tpl = p.simulate.find((c) => c.type === 'remove-template')?.template;
  const url = xray.captures.map((c) => c.url).find((u) => !tpl || classify(u, o.platform) === tpl) ?? xray.captures[0]!.url;
  const simulation = await simulate(url, p.simulate, { outDir: o.outDir, runs: o.runs ?? 5, local: o.local, platform: o.platform, ...(o.net ?? {}) });
  if (simulation.breakage.length) reasons.push(`simulation (REV-08): ${simulation.breakage.join('; ')}`);
  return { ok: reasons.length === 0, verdicts, simulation, reasons };
}

export interface ApplyStep {
  proposal: string;
  module: string;
  tier: string;
  status: 'kept' | 'rolled_back' | 'skipped';
  reason: string;
  gate?: GateResult;
  verification?: { result: string; failed: string[]; evidence: string };
  flagsVersion?: number;
}

export interface ApplyOptions {
  stage?: Stage;
  tiers?: string[];
  only?: string[];
  simulationRuns?: number;
  verifyLighthouseRuns?: number;
  fullVerify?: boolean;
  approval?: { operation: string };
  outDir: string;
  probes: ProbeResult[];
  net?: { latencyMs: number; downloadKbps: number };
  onStep?: (s: ApplyStep) => void;
}

/** Applies proposals one at a time with keep-or-rollback (CLAUDE.md rule 4 and 14). */
export async function applyWpProposals(root: string, site: string, proposals: Proposal[], o: ApplyOptions): Promise<ApplyStep[]> {
  const cfg = loadSite(root, site);
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'staging');
  const xray = loadXray(root, site).ctx;
  const steps: ApplyStep[] = [];
  const uploadsUrl = `${new URL(cfg.local ? cfg.productionUrl : (stage === 'staging' ? cfg.stagingUrl ?? cfg.productionUrl : cfg.productionUrl)).origin}/wp-content/uploads`;
  mkdirSync(o.outDir, { recursive: true });
  // areas a kept change alters on purpose stay masked for every later verification against the same baseline,
  // including changes kept by an earlier run (their settings are already in the module's flags)
  const keptMasks = new Set<string>();
  const start = await readFlags(executorWp(root, cfg, stage, o.approval ? { operation: o.approval.operation, item: 'read-flags' } : undefined)).catch(() => undefined);
  for (const p of proposals) {
    const m = p.module ? start?.modules[p.module] : undefined;
    if (p.visualMasks && m?.enabled && Object.keys(p.settings).every((k) => m.settings && k in m.settings)) p.visualMasks.forEach((x) => keptMasks.add(x));
  }
  for (const p of proposals) {
    if (o.tiers && !o.tiers.includes(p.tier)) continue;
    if (o.only && !o.only.includes(p.id)) continue;
    const wp = executorWp(root, cfg, stage, o.approval ? { operation: o.approval.operation, item: p.id } : undefined);
    const step: ApplyStep = { proposal: p.id, module: p.module, tier: p.tier, status: 'skipped', reason: '' };
    // what this item wrote, so an error after the write is rolled back too (CLAUDE.md rule 14)
    let written: { module: string; prev: FlagsDoc['modules'][string] | undefined; undo: string[][] } | undefined;
    try {
      const gate = await gateProposal(p, xray, { outDir: join(o.outDir, `sim-${p.id}`), runs: o.simulationRuns, local: !!cfg.local, platform: cfg.platform, net: o.net });
      step.gate = gate;
      if (!gate.ok) {
        step.reason = `gate: ${gate.reasons.join(' | ')}`;
        steps.push(step);
        o.onStep?.(step);
        continue;
      }
      await prepareProposal(p, wp, { probes: o.probes, uploadsUrl });
      const before = await readFlags(wp);
      const prev = p.module ? before.modules[p.module] : undefined;
      const undo: string[][] = [];
      written = { module: p.module, prev, undo };
      for (const d of p.dbSteps) {
        if (d.exportFirst) await wp.text(d.exportFirst);
        await wp.text(d.run);
        if (d.undo) undo.unshift(d.undo);
      }
      if (p.module) {
        // proposals that share a module (css fixes and the T3 preloader item) add to it
        const settings = prev?.enabled ? mergeSettings(prev.settings ?? {}, p.settings) : p.settings;
        await wp.text(['speedpilot', 'enable', p.module, `--settings=${JSON.stringify(settings)}`, `--reason=${p.id}: ${p.title}`]);
      }
      const v: VerificationResult = await verify(root, site, { stage, full: o.fullVerify, lighthouseRuns: o.verifyLighthouseRuns ?? 0, masks: [...keptMasks, ...(p.visualMasks ?? [])] });
      const failed = v.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.details.slice(0, 3).join('; ')}`);
      step.verification = { result: v.result, failed, evidence: v.evidenceDir };
      if (v.result === 'PASS') {
        step.status = 'kept';
        step.reason = p.expected;
        step.flagsVersion = (await readFlags(wp)).version;
        p.visualMasks?.forEach((x) => keptMasks.add(x));
      } else {
        if (p.module) await restoreModule(wp, p.module, prev, `rollback ${p.id}: verification failed`);
        for (const u of undo) await wp.text(u);
        step.status = 'rolled_back';
        written = undefined;
        step.reason = `verification failed: ${failed.join(' | ')}`;
        log.warn({ proposal: p.id, failed }, 'change rolled back');
      }
    } catch (e) {
      step.reason = `error: ${(e as Error).message.slice(0, 500)}`;
      if (written && step.status !== 'kept') {
        try {
          if (written.module) await restoreModule(wp, written.module, written.prev, `rollback ${p.id}: ${step.reason.slice(0, 100)}`);
          for (const u of written.undo) await wp.text(u);
          step.status = 'rolled_back';
        } catch (e2) {
          step.reason += `; rollback failed: ${(e2 as Error).message}`;
        }
      }
    }
    steps.push(step);
    o.onStep?.(step);
    writeFileSync(join(o.outDir, 'apply-log.json'), JSON.stringify(steps, null, 1));
  }
  return steps;
}

function mergeSettings(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'extraCss' && typeof a[k] === 'string' && typeof v === 'string' && !a[k].includes(v)) out[k] = `${a[k]}\n${v}`;
    else if (Array.isArray(a[k]) && Array.isArray(v)) out[k] = [...new Set([...(a[k] as unknown[]), ...v])];
    else if (a[k] && v && typeof a[k] === 'object' && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(a[k] as object), ...(v as object) };
    else out[k] = v;
  }
  return out;
}

/** Agent handle maps (and staging slow queries) for the sample URLs. */
export async function fetchDiag(cfg: SiteConfig, urls: string[], base: string): Promise<Record<string, AgentDiag>> {
  const hmac = secret(cfg.access.wordpress?.agentHmacSecret) ?? (cfg.local ? FIXTURE_HMAC_SECRET : undefined);
  const agent = new AgentClient(base, hmac);
  const out: Record<string, AgentDiag> = {};
  for (const u of urls) {
    const d = await agent.diag(u).catch(() => undefined);
    if (d?.diag) out[u] = d.diag;
  }
  return out;
}
