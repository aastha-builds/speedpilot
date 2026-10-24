import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Rule, EvalContext, Draft, Evaluator } from './types.js';
import { frontEvaluators } from './evalFront.js';
import { wpEvaluators, shopifyEvaluators, revEvaluators } from './evalPlatform.js';
import { performanceScore } from './scoring.js';
import type { Device } from '../collectors/browser.js';
import type { Tier } from '../store/store.js';

export const EVALUATORS: Record<string, Evaluator> = { ...frontEvaluators, ...wpEvaluators, ...shopifyEvaluators, ...revEvaluators };

export function automatedIds(): string[] {
  return Object.keys(EVALUATORS).sort();
}

export function loadRules(rulesDir: string): Rule[] {
  if (!existsSync(rulesDir)) throw new Error(`No rules directory at ${rulesDir}. Run pnpm rules:generate.`);
  const out: Rule[] = [];
  for (const f of readdirSync(rulesDir).filter((x) => x.endsWith('.yaml')).sort()) {
    const doc = YAML.parse(readFileSync(join(rulesDir, f), 'utf8')) as { rules: Rule[] };
    out.push(...(doc.rules ?? []));
  }
  return out;
}

export interface Finding {
  id: string;
  checkId: string;
  title: string;
  area: string;
  urls: string[];
  evidence: Record<string, unknown>;
  metric: Rule['metric'];
  estimatedGain: NonNullable<Draft['gain']>;
  tier: Tier;
  fix: string;
  verify: string;
  rootCause?: string;
  priority: number;
  note?: string;
  guards: string[];
}

/** Guard rules (SAFE-*) attached to each finding by area and fix (CHECKS.md: "the planner attaches the relevant ones"). */
export function guardsFor(checkId: string, fix: string, platform: 'wordpress' | 'shopify'): string[] {
  const g = new Set<string>(['SAFE-27', 'SAFE-20', 'SAFE-21']);
  const f = fix.toLowerCase();
  if (/defer|async|delay|footer/.test(f) || /^(JS-0[189]|SHT-02|3P-0[245])$/.test(checkId)) ['SAFE-01', 'SAFE-02', 'SAFE-15'].forEach((x) => g.add(x));
  if (/critical css|purg|unused css/.test(f) || /^CSS-0[12]$/.test(checkId)) ['SAFE-03', 'SAFE-04'].forEach((x) => g.add(x));
  if (/load only|dequeue|only where|per template|conditional/.test(f) || /^(WPF-0[67]|WPF-1[13]|CSS-09)$/.test(checkId)) g.add('SAFE-05');
  if (/lazy/.test(f) || /^IMG-0[17]$|^IMG-10$/.test(checkId)) g.add('SAFE-06');
  if (/webp|avif|format|resize|recompress/.test(f) || /^IMG-0[345]$/.test(checkId)) g.add('SAFE-07');
  if (/font|icon/.test(f) || /^FONT-/.test(checkId)) g.add('SAFE-08');
  if (/migrate/.test(f)) g.add('SAFE-09');
  if (/cron/.test(f)) g.add('SAFE-10');
  if (/delete|clean|orphan|transient|revision/.test(f) || /^WPB-0[4-9]$|^WPB-10$/.test(checkId)) g.add('SAFE-11');
  if (/heartbeat/.test(f)) g.add('SAFE-12');
  if (/speculat|prefetch|prerender/.test(f) || /WPF-14|SHT-19/.test(checkId)) g.add('SAFE-13');
  if (/bfcache|back\/forward|unload/.test(f) || checkId === 'NET-12') g.add('SAFE-14');
  if (/minif/.test(f)) g.add('SAFE-15');
  if (/preload|preconnect|fetchpriority/.test(f)) g.add('SAFE-16');
  if (platform === 'shopify') ['SAFE-17', 'SAFE-19'].forEach((x) => g.add(x));
  if (/snippet|app embed|leftover/.test(f) || /^SHA-0[23]$/.test(checkId)) g.add('SAFE-18');
  if (/cache|purge|ver/.test(f)) g.add('SAFE-23');
  if (/regenerat|recompress|bulk/.test(f)) g.add('SAFE-25');
  if (/facade|keyboard|focus/.test(f) || /^VID-02$|^DOC-08$|^3P-15$/.test(checkId)) g.add('SAFE-30');
  if (/child theme/.test(f)) g.add('SAFE-32');
  if (/^REV-05$/.test(checkId)) g.add('SAFE-31');
  return [...g].sort();
}

const TIER_RANK: Record<string, number> = { T1: 0, T2: 1, T3: 2, report: 3 };

function normalizeTier(t: Rule['tier'], override?: Tier): Tier {
  if (override) return override;
  if (t === 'T1/T2') return 'T2';
  if (t === 'T2/T3') return 'T3';
  if (t === 'by-cause') return 'T2';
  return t as Tier;
}

/**
 * Priority (SPEC.md 4): failing mobile Core Web Vitals first (LCP, then INP and TBT, then CLS), then score, then bytes.
 * At equal gain, lower risk first. Learning-loop measured gains replace estimates when present.
 */
export function priorityOf(gain: NonNullable<Draft['gain']>, tier: Tier, failingMetrics: Set<string>, learned?: { meanGainMs: number | null; failureRate: number }): number {
  const lcp = learned?.meanGainMs ?? gain.lcpMs ?? 0;
  let p = 0;
  p += (failingMetrics.has('LCP') ? 4 : 1) * Math.min(lcp, 4000) / 10;
  p += (failingMetrics.has('INP') ? 3.5 : 1) * Math.min(gain.inpMs ?? 0, 1000) / 4;
  p += (failingMetrics.has('TBT') ? 3 : 1) * Math.min(gain.tbtMs ?? 0, 2000) / 4;
  p += (failingMetrics.has('CLS') ? 2.5 : 1) * Math.min(gain.cls ?? 0, 0.5) * 1000;
  p += Math.min(gain.ttfbMs ?? 0, 3000) / 15;
  p += Math.min(gain.bytes ?? 0, 5_000_000) / 50_000;
  p += (gain.points ?? 0) * 5;
  p -= TIER_RANK[tier]! * 3;
  if (learned) p *= 1 - Math.min(0.9, learned.failureRate);
  return Math.round(p * 10) / 10;
}

export function failingCwv(ctx: EvalContext): Set<string> {
  const s = new Set<string>();
  for (const p of ctx.audit.pages.filter((x) => x.device === 'mobile')) {
    const m = p.lighthouse?.median;
    if ((m?.lcp ?? p.evidence.lcp?.startTime ?? 0) > 2500) s.add('LCP');
    if ((m?.tbt ?? 0) > 200) s.add('TBT');
    if ((m?.cls ?? p.evidence.cls.total) > 0.1) s.add('CLS');
    if ((p.inp?.interactions ?? []).some((i) => (i.inp ?? 0) > 200)) s.add('INP');
  }
  return s;
}

export interface AnalysisResult {
  findings: Finding[];
  notAutomated: Array<{ id: string; title: string; source: string }>;
  groups: Array<{ rootCause: string; findings: string[]; metrics: string[]; gain: NonNullable<Draft['gain']> }>;
  failing: string[];
  ceiling: Ceiling;
}

export interface Ceiling {
  device: Device;
  current: number | null;
  reachable: number | null;
  blockers: Array<{ name: string; cost: string; costMs?: number; options: string }>;
  note: string;
}

/** Runs every automated rule (SPEC.md 4). */
export function analyze(rules: Rule[], ctx: EvalContext, learned?: (checkId: string) => { meanGainMs: number | null; failureRate: number; n: number } | undefined): AnalysisResult {
  const platform = ctx.cfg.platform === 'wordpress' ? 'wp' : 'shopify';
  const fail = failingCwv(ctx);
  const findings: Finding[] = [];
  const notAutomated: AnalysisResult['notAutomated'] = [];
  for (const rule of rules) {
    if (rule.kind === 'guard') continue;
    if (rule.platforms !== 'both' && rule.platforms !== platform) continue;
    const ev = EVALUATORS[rule.id];
    if (!ev || !rule.detect.automated) {
      notAutomated.push({ id: rule.id, title: rule.title, source: rule.detect.source });
      continue;
    }
    let drafts: Draft[] = [];
    try {
      drafts = ev(ctx);
    } catch (e) {
      notAutomated.push({ id: rule.id, title: rule.title, source: `evaluator error: ${(e as Error).message}` });
      continue;
    }
    drafts.forEach((d, i) => {
      const tier = normalizeTier(rule.tier, d.tier);
      const l = learned?.(rule.id);
      findings.push({
        id: `${rule.id}${drafts.length > 1 ? `-${i + 1}` : ''}`,
        checkId: rule.id,
        title: rule.title,
        area: rule.area,
        urls: d.urls,
        evidence: d.evidence,
        metric: rule.metric,
        estimatedGain: d.gain ?? {},
        tier,
        fix: rule.fix,
        verify: rule.verify,
        rootCause: d.rootCause,
        priority: priorityOf(d.gain ?? {}, tier, fail, l && l.n >= 3 ? l : undefined),
        note: d.note,
        guards: guardsFor(rule.id, rule.fix, ctx.cfg.platform),
      });
    });
  }
  findings.sort((a, b) => b.priority - a.priority || TIER_RANK[a.tier]! - TIER_RANK[b.tier]!);
  const groups = [...new Set(findings.map((f) => f.rootCause).filter((x): x is string => !!x))].map((rc) => {
    const fs = findings.filter((f) => f.rootCause === rc);
    const gain: NonNullable<Draft['gain']> = {};
    for (const f of fs) for (const [k, v] of Object.entries(f.estimatedGain)) gain[k as keyof typeof gain] = Math.max(gain[k as keyof typeof gain] ?? 0, v as number);
    return { rootCause: rc, findings: fs.map((f) => f.id), metrics: [...new Set(fs.map((f) => f.metric))], gain };
  });
  return { findings, notAutomated, groups, failing: [...fail], ceiling: ceiling(ctx, findings) };
}

/**
 * Ceiling estimate (SPEC.md 4): the score reachable within the client's constraints, plus every blocker outside our
 * control with its measured cost.
 */
export function ceiling(ctx: EvalContext, findings: Finding[]): Ceiling {
  const pages = ctx.audit.pages.filter((p) => p.device === 'mobile' && p.lighthouse);
  const blockers: Ceiling['blockers'] = [];
  const ownerMs = (pred: (owner: string) => boolean) => {
    const per = pages.map((p) => p.evidence.loaf.flatMap((f) => f.scripts).filter((s) => pred(s.owner.id)).reduce((a, s) => a + s.duration, 0));
    return per.length ? Math.round(per.reduce((a, b) => a + b, 0) / per.length) : 0;
  };
  if (ctx.cfg.platform === 'shopify') {
    const ms = ownerMs((o) => o === 'platform:shopify');
    blockers.push({ name: 'Shopify platform scripts (content_for_header)', cost: `${ms} ms main thread per page`, costMs: ms, options: 'none: Shopify injects them; they are never edited' });
  }
  for (const keep of ctx.cfg.keepThirdParties) {
    const ms = ownerMs((o) => o.includes(keep));
    if (ms > 0) blockers.push({ name: `Required third party: ${keep}`, cost: `${ms} ms main thread per page`, costMs: ms, options: 'load on interaction or idle where the vendor allows it, or accept the cost' });
  }
  const consent = ctx.audit.inventory.variants.consentTool ?? ctx.cfg.consent.tool;
  if (consent) blockers.push({ name: `Consent tool: ${consent}`, cost: `${ownerMs((o) => /cookiebot|onetrust|cookieyes|iubenda|usercentrics|complianz/.test(o))} ms main thread`, options: 'keep it early and small; never delay it so tags fire before consent' });
  const ttfb = pages.map((p) => p.lighthouse!.median.ttfb ?? 0);
  const avgTtfb = ttfb.length ? ttfb.reduce((a, b) => a + b, 0) / ttfb.length : 0;
  if (avgTtfb > 600 && !ctx.cfg.local) blockers.push({ name: 'Hosting TTFB', cost: `${Math.round(avgTtfb)} ms median TTFB`, costMs: Math.round(avgTtfb), options: 'faster hosting, host-level caching or a CDN (client decisions); PHP render time is shown separately' });

  // reachable: apply the estimated gains of all non-T3 findings (capped) to the median metrics and rescore
  const current = pages.length ? Math.round(pages.reduce((a, p) => a + (p.lighthouse!.median.score ?? 0), 0) / pages.length) : null;
  if (!pages.length) return { device: 'mobile', current, reachable: null, blockers, note: 'no lab data' };
  const fixable = findings.filter((f) => f.tier !== 'T3' && f.tier !== 'report');
  const lcpGain = Math.min(0.75, fixable.reduce((a, f) => a + (f.estimatedGain.lcpMs ?? 0), 0) / 10000);
  const tbtGain = fixable.reduce((a, f) => a + (f.estimatedGain.tbtMs ?? 0), 0);
  const clsGain = fixable.reduce((a, f) => a + (f.estimatedGain.cls ?? 0), 0);
  const scores = pages.map((p) => {
    const m = p.lighthouse!.median;
    const blockMs = blockers.reduce((a, b) => a + (b.name.startsWith('Hosting') ? 0 : b.costMs ?? 0), 0);
    const floorTbt = Math.max(0, blockMs - 50);
    return performanceScore({ fcp: m.fcp ? m.fcp * (1 - lcpGain * 0.6) : null, si: m.si ? m.si * (1 - lcpGain * 0.6) : null, lcp: m.lcp ? Math.max(m.lcp * (1 - lcpGain), (m.ttfb ?? 0) + 600) : null, tbt: m.tbt !== null ? Math.max(floorTbt, m.tbt - tbtGain) : null, cls: m.cls !== null ? Math.max(0, m.cls - clsGain) : null }, 'mobile') ?? 0;
  });
  const reachable = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { device: 'mobile', current, reachable: Math.max(current ?? 0, reachable), blockers, note: 'estimate from rule gains and Lighthouse scoring curves; the what-if simulator and staging runs replace it with measured numbers' };
}
