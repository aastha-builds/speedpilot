/**
 * PageSpeed Insights API v5 and Chrome UX Report API clients (SPEC.md 3.2, 3.5). Public URLs only (SPEC.md 12).
 */
import { redactString } from '../log.js';

export interface FieldMetrics {
  lcp?: number;
  inp?: number;
  cls?: number;
  ttfb?: number;
  fcp?: number;
  /** Share of navigation types (bfcache restores, prerenders) when CrUX reports them. */
  navigationTypes?: Record<string, number>;
  collectionPeriod?: { first: string; last: string };
}

export interface FieldResult {
  scope: 'url' | 'origin';
  formFactor: 'PHONE' | 'DESKTOP';
  status: 'ok' | 'not-enough-data' | 'error';
  metrics: FieldMetrics;
  note?: string;
}

export function isPublicUrl(url: string): boolean {
  const h = new URL(url).hostname;
  return !(/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/.test(h) || h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.internal'));
}

function p75(m: { percentiles?: { p75?: number | string } } | undefined): number | undefined {
  const v = m?.percentiles?.p75;
  return v === undefined ? undefined : Number(v);
}

export async function cruxRecord(target: { url?: string; origin?: string }, formFactor: 'PHONE' | 'DESKTOP', key: string, f: typeof fetch = fetch): Promise<FieldResult> {
  const scope = target.url ? 'url' : 'origin';
  const subject = target.url ?? target.origin!;
  if (!isPublicUrl(subject)) return { scope, formFactor, status: 'not-enough-data', metrics: {}, note: 'not a public URL; CrUX is skipped' };
  try {
    const res = await f(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, formFactor, metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift', 'experimental_time_to_first_byte', 'first_contentful_paint', 'navigation_types'] }),
    });
    if (res.status === 404) return { scope, formFactor, status: 'not-enough-data', metrics: {} };
    if (!res.ok) return { scope, formFactor, status: 'error', metrics: {}, note: `HTTP ${res.status}` };
    const j = (await res.json()) as { record: { metrics: Record<string, { percentiles?: { p75?: number | string }; fractions?: Record<string, number> }>; collectionPeriod?: { firstDate: { year: number; month: number; day: number }; lastDate: { year: number; month: number; day: number } } } };
    const m = j.record.metrics;
    const d = (x?: { year: number; month: number; day: number }) => (x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : '');
    return {
      scope,
      formFactor,
      status: 'ok',
      metrics: {
        lcp: p75(m.largest_contentful_paint),
        inp: p75(m.interaction_to_next_paint),
        cls: p75(m.cumulative_layout_shift),
        ttfb: p75(m.experimental_time_to_first_byte),
        fcp: p75(m.first_contentful_paint),
        navigationTypes: m.navigation_types?.fractions,
        collectionPeriod: j.record.collectionPeriod ? { first: d(j.record.collectionPeriod.firstDate), last: d(j.record.collectionPeriod.lastDate) } : undefined,
      },
      note: 'Field data is a 28-day rolling window; improvements show fully about 4 weeks after deploy.',
    };
  } catch (e) {
    return { scope, formFactor, status: 'error', metrics: {}, note: redactString(String((e as Error).message)) };
  }
}

export async function cruxHistory(target: { url?: string; origin?: string }, formFactor: 'PHONE' | 'DESKTOP', key: string, f: typeof fetch = fetch): Promise<Array<{ period: string; lcp?: number; inp?: number; cls?: number }>> {
  const subject = target.url ?? target.origin!;
  if (!isPublicUrl(subject)) return [];
  const res = await f(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, formFactor, metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] }),
  }).catch(() => undefined);
  if (!res?.ok) return [];
  const j = (await res.json()) as { record: { metrics: Record<string, { percentilesTimeseries?: { p75s: Array<number | string | null> } }>; collectionPeriods: Array<{ lastDate: { year: number; month: number; day: number } }> } };
  return j.record.collectionPeriods.map((p, i) => ({
    period: `${p.lastDate.year}-${String(p.lastDate.month).padStart(2, '0')}-${String(p.lastDate.day).padStart(2, '0')}`,
    lcp: num(j.record.metrics.largest_contentful_paint?.percentilesTimeseries?.p75s[i]),
    inp: num(j.record.metrics.interaction_to_next_paint?.percentilesTimeseries?.p75s[i]),
    cls: num(j.record.metrics.cumulative_layout_shift?.percentilesTimeseries?.p75s[i]),
  }));
}

function num(v: number | string | null | undefined) {
  return v === null || v === undefined ? undefined : Number(v);
}

export interface PsiResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  score: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
  fcp: number | null;
  lighthouseVersion?: string;
  error?: string;
}

/** PSI v5: a second opinion from Google's servers (3 runs by default). */
export async function pageSpeedInsights(url: string, strategy: 'mobile' | 'desktop', key: string, runs = 3, f: typeof fetch = fetch): Promise<PsiResult[]> {
  if (!isPublicUrl(url)) return [{ url, strategy, score: null, lcp: null, tbt: null, cls: null, fcp: null, error: 'not a public URL; PSI is skipped' }];
  const out: PsiResult[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      const res = await f(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=PERFORMANCE&key=${encodeURIComponent(key)}`);
      if (!res.ok) {
        out.push({ url, strategy, score: null, lcp: null, tbt: null, cls: null, fcp: null, error: `HTTP ${res.status}` });
        continue;
      }
      const j = (await res.json()) as { lighthouseResult: { lighthouseVersion: string; categories: { performance: { score: number } }; audits: Record<string, { numericValue?: number }> } };
      const a = j.lighthouseResult.audits;
      out.push({
        url,
        strategy,
        score: Math.round(j.lighthouseResult.categories.performance.score * 100),
        lcp: a['largest-contentful-paint']?.numericValue ?? null,
        tbt: a['total-blocking-time']?.numericValue ?? null,
        cls: a['cumulative-layout-shift']?.numericValue ?? null,
        fcp: a['first-contentful-paint']?.numericValue ?? null,
        lighthouseVersion: j.lighthouseResult.lighthouseVersion,
      });
    } catch (e) {
      out.push({ url, strategy, score: null, lcp: null, tbt: null, cls: null, fcp: null, error: redactString(String((e as Error).message)) });
    }
  }
  return out;
}
