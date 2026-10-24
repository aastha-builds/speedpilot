/** Grades exactly as SPEC.md 9.4: the highest row whose every condition is met, capped by the safety result. */
export type Grade = 'AAA+++' | 'AA' | 'A' | 'B' | 'C';

export interface TemplateMetrics {
  template: string;
  mobileScore: number | null;
  desktopScore: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
  /** Worst scripted interaction (ms), mobile 4x CPU. */
  worstInteraction: number | null;
}

export interface FieldStatus {
  /** true = all Core Web Vitals good, false = at least one not good, null = not enough data. */
  allGood: boolean | null;
}

export type SafetyResult = 'PASS' | 'FAIL' | 'N/A';

export function gradeTemplate(m: TemplateMetrics, field: FieldStatus): Grade {
  const ms = m.mobileScore ?? 0;
  const ds = m.desktopScore ?? 0;
  const lcp = m.lcp ?? Infinity;
  const tbt = m.tbt ?? Infinity;
  const cls = m.cls ?? Infinity;
  const inter = m.worstInteraction ?? 0;
  if (ms >= 95 && ds >= 98 && lcp <= 1800 && tbt <= 100 && cls <= 0.05 && inter <= 200 && field.allGood !== false) return 'AAA+++';
  if (ms >= 90 && ds >= 95 && lcp <= 2500 && tbt <= 200 && cls <= 0.1 && inter <= 200) return 'AA';
  if (ms >= 75) return 'A';
  if (ms >= 50) return 'B';
  return 'C';
}

const ORDER: Grade[] = ['C', 'B', 'A', 'AA', 'AAA+++'];

/** Site grade: the worst key template. */
export function gradeSite(templates: TemplateMetrics[], field: FieldStatus, safety: SafetyResult): { grade: Grade | null; perTemplate: Array<{ template: string; grade: Grade }>; counts: boolean; reason?: string } {
  const perTemplate = templates.map((t) => ({ template: t.template, grade: gradeTemplate(t, field) }));
  const worst = perTemplate.reduce<Grade | null>((acc, t) => (acc === null || ORDER.indexOf(t.grade) < ORDER.indexOf(acc) ? t.grade : acc), null);
  if (safety === 'FAIL') return { grade: worst, perTemplate, counts: false, reason: 'Safety FAIL: the change was rolled back; this grade does not count.' };
  return { grade: worst, perTemplate, counts: true };
}
