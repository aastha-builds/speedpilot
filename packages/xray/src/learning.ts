/**
 * Learning loop and shadow mode (SPEC.md 15.6, 15.10). Every verdict is logged; when verification later passes or fails
 * the change, the outcome is recorded. A `safe` verdict that failed lowers the confidence of the recipe behind it.
 * Precision per verdict type is tracked over time, the planner ranks fixes by measured gain and failure rate, and an
 * anonymized export (no client names, domains or screenshots) feeds recipe updates.
 */
import type { DB, Store } from '@speedpilot/core';
import type { Verdict } from './analysis/verdicts.js';
import { recordRecipeOutcome, type Recipe } from './recipes.js';

export function logVerdicts(db: DB, site: string, runId: string, verdicts: Verdict[]): void {
  const st = db.prepare('INSERT INTO xray_verdicts (site_id, run_id, change, change_type, verdict, confidence, recipe, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const v of verdicts) st.run(site, runId, v.change, v.change.split(':')[0]!, v.verdict, v.confidence, v.recipe ?? null, JSON.stringify(v.reasons.slice(0, 20).map((r) => ({ severity: r.severity, kind: r.kind, evidence: r.evidence }))));
  })();
}

/** Records what verification found for a change; a failed `safe` verdict lowers its recipe's confidence. */
export function recordVerdictOutcome(db: DB, site: string, change: string, passed: boolean, reason: string, recipes: Recipe[] = []): { verdict?: string; recipeConfidence?: number } {
  const row = db.prepare('SELECT id, verdict, recipe FROM xray_verdicts WHERE site_id = ? AND change = ? ORDER BY id DESC LIMIT 1').get(site, change) as { id: number; verdict: string; recipe: string | null } | undefined;
  if (!row) return {};
  db.prepare('UPDATE xray_verdicts SET outcome = ?, outcome_reason = ? WHERE id = ?').run(passed ? 'passed' : 'failed', reason, row.id);
  const recipe = row.recipe ? recipes.find((r) => r.id === row.recipe) : undefined;
  let recipeConfidence: number | undefined;
  if (recipe && row.verdict === 'safe') recipeConfidence = recordRecipeOutcome(db, recipe, passed);
  return { verdict: row.verdict, recipeConfidence };
}

/** Precision of `safe` verdicts per change type: of the safe verdicts that were tried, how many passed verification. */
export function verdictPrecision(db: DB): Array<{ changeType: string; tried: number; passed: number; precision: number | null }> {
  const rows = db.prepare("SELECT change_type, outcome, COUNT(*) AS n FROM xray_verdicts WHERE verdict = 'safe' AND outcome IS NOT NULL GROUP BY change_type, outcome").all() as Array<{ change_type: string; outcome: string; n: number }>;
  const by = new Map<string, { tried: number; passed: number }>();
  for (const r of rows) {
    const e = by.get(r.change_type) ?? { tried: 0, passed: 0 };
    e.tried += r.n;
    if (r.outcome === 'passed') e.passed += r.n;
    by.set(r.change_type, e);
  }
  return [...by.entries()].map(([changeType, e]) => ({ changeType, ...e, precision: e.tried ? e.passed / e.tried : null }));
}

/** Ranks candidate fixes by measured gain and failure rate from past outcomes (falls back to the estimate). */
export function rankFixes<T extends { checkOrRecipeId: string; estimatedGainMs: number }>(store: Store, platform: string, fixes: T[]): Array<T & { score: number; history: { n: number; failureRate: number; meanGainMs: number | null } }> {
  return fixes
    .map((f) => {
      const h = store.outcomeStats(f.checkOrRecipeId, platform);
      const gain = h.meanGainMs ?? f.estimatedGainMs;
      return { ...f, history: { n: h.n, failureRate: h.failureRate, meanGainMs: h.meanGainMs }, score: gain * (1 - h.failureRate) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Anonymized learning export: no site IDs, client names, domains, URLs or screenshots. */
export function anonymizedExport(db: DB): { outcomes: Array<Record<string, unknown>>; verdicts: Array<Record<string, unknown>> } {
  const strip = (s: unknown) => (typeof s === 'string' ? s.replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/\b[\w-]+\.(com|net|org|io|shop|store|co|uk|de|fr|nl|example|local)\b/gi, '<domain>') : s);
  const outcomes = (db.prepare('SELECT check_or_recipe_id, platform, target_version, simulated_gain_json, before_json, after_json, kept, reason FROM outcomes').all() as Array<Record<string, unknown>>).map((r) => ({ check: r.check_or_recipe_id, platform: r.platform, version: r.target_version, simulatedGain: JSON.parse(String(r.simulated_gain_json ?? 'null')), before: JSON.parse(String(r.before_json ?? 'null')), after: JSON.parse(String(r.after_json ?? 'null')), kept: r.kept === 1, reason: strip(r.reason) }));
  const verdicts = (db.prepare('SELECT change_type, verdict, confidence, recipe, outcome FROM xray_verdicts WHERE outcome IS NOT NULL').all() as Array<Record<string, unknown>>).map((r) => ({ changeType: r.change_type, verdict: r.verdict, confidence: r.confidence, recipe: r.recipe, outcome: r.outcome }));
  return { outcomes, verdicts };
}
