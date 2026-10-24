import type { AuditResult, PageAudit } from '../audit.js';
import type { WpBackend } from '../backend/wordpress.js';
import type { SiteConfig } from '../config/site.js';
import type { Tier } from '../store/store.js';
import { AUDIT_CANDIDATES, type AuditKey } from '../collectors/auditMap.js';
import type { LhAuditLite } from '../audit.js';

/** One rule in rules/<area>.yaml (CHECKS.md: id, platforms, detect, evidence, metric, tier, fix, verify). */
export interface Rule {
  id: string;
  area: string;
  title: string;
  platforms: 'wp' | 'shopify' | 'both';
  kind: 'check' | 'guard';
  detect: { source: string; condition: string; automated: boolean };
  evidence: string;
  metric: 'LCP' | 'INP' | 'TBT' | 'CLS' | 'TTFB' | 'bytes' | 'safety' | 'measurement';
  tier: Tier | 'T1/T2' | 'T2/T3' | 'by-cause';
  fix: string;
  verify: string;
  guards?: string[];
}

/** Shopify backend shape the rules read (defined in @speedpilot/shopify; duplicated loosely to avoid a cycle). */
export interface ShopifyBackendLite {
  theme: { name: string; version: string; os2: boolean; files: Array<{ path: string; bytes: number }> };
  themeDir: string;
  themeCheck: Array<{ check: string; file: string; message: string }>;
  profile: Array<{ url: string; totalMs: number | null; hotSpots: Array<{ file: string; ms: number; calls?: number }> }>;
  appEmbeds: Array<{ id: string; app: string; block: string; enabled: boolean }>;
  sectionsPerTemplate: Record<string, string[]>;
  apps: Array<{ app: string; requests: number; kb: number }>;
  leftovers: Array<{ file: string; app: string; reason: string; renderedIn: string[] }>;
  speculationRulesHeader: string | null;
}

/** X-ray summary the REV rules read (produced by @speedpilot/xray). */
export interface XraySummaryLite {
  verdicts: Array<{ change: string; target: string; template?: string; verdict: 'safe' | 'unsafe' | 'unknown'; reasons: string[] }>;
  earlyUnused: Array<{ url: string; owner: string; bytes: number; type: string }>;
  lateNeeded: Array<{ url: string; type: string; delayMs: number }>;
  slowHandlers: Array<{ selector: string; event: string; script: string; fn?: string; ms: number; owner: string }>;
  heavyWidgets: Array<{ owner: string; mainThreadMs: number; bytes: number; output: string }>;
  recipeMismatches: Array<{ recipe: string; installed: string; verified: string[] }>;
  simulations: Array<{ change: string; gainMs: number | null; ok: boolean; issues: string[] }>;
  competitors?: Array<{ url: string; lcp?: number; inp?: number; notes: string[] }>;
}

export interface EvalContext {
  cfg: SiteConfig;
  audit: AuditResult;
  wp?: WpBackend;
  shopify?: ShopifyBackendLite;
  xray?: XraySummaryLite;
  previousVersions?: Record<string, string>;
}

export interface Draft {
  urls: string[];
  evidence: Record<string, unknown>;
  /** Estimated gain on the affected metric: lcpMs, tbtMs, inpMs, cls, ttfbMs, bytes. */
  gain?: Partial<Record<'lcpMs' | 'tbtMs' | 'inpMs' | 'cls' | 'ttfbMs' | 'bytes' | 'points', number>>;
  /** Owner or cause that groups findings (SPEC.md 4: one slider plugin can cause LCP, TBT and CLS problems). */
  rootCause?: string;
  /** Overrides the rule tier when the evidence says so (for example T3 when it is a vendor tag). */
  tier?: Tier;
  note?: string;
}

export type Evaluator = (ctx: EvalContext) => Draft[];

// ---------------------------------------------------------------------------
// helpers shared by evaluators
// ---------------------------------------------------------------------------

export function lhAudit(p: PageAudit, key: AuditKey): LhAuditLite | undefined {
  const audits = p.lighthouse?.audits;
  if (!audits) return undefined;
  const id = AUDIT_CANDIDATES[key].find((c) => c in audits);
  return id ? audits[id] : undefined;
}

export function failing(p: PageAudit, key: AuditKey): boolean {
  const a = lhAudit(p, key);
  return !!a && typeof a.score === 'number' && a.score < 0.9;
}

export const mobile = (ctx: EvalContext) => ctx.audit.pages.filter((p) => p.device === 'mobile');
export const pagesOf = (ctx: EvalContext) => ctx.audit.pages;

/** One page per URL, preferring mobile. */
export function uniquePages(ctx: EvalContext): PageAudit[] {
  const m = new Map<string, PageAudit>();
  for (const p of ctx.audit.pages) if (!m.has(p.url) || p.device === 'mobile') m.set(p.url, p);
  return [...m.values()];
}

export function kb(bytes: number): number {
  return Math.round(bytes / 102.4) / 10;
}

export function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** Groups drafts per key and merges URLs. */
export function byKey<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}
