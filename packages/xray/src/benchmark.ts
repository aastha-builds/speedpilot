/**
 * Competitor benchmark (SPEC.md 15.7, REV-06), public data only: CrUX field data and PageSpeed Insights lab data when
 * an API key is configured, plus ONE normal page load per competitor URL (robots.txt respected, no crawling) to note
 * the approach at a high level: LCP element type, font approach, third-party count, total JS size. Nothing is copied.
 */
import { chromium } from 'playwright';
import { cruxRecord, openSession, type FieldResult } from '@speedpilot/core';

export interface CompetitorResult {
  url: string;
  visited: boolean;
  skipped?: string;
  field?: { lcp?: number; inp?: number; cls?: number };
  lab?: { lcp: number | null; fcp: number | null };
  lcpElement?: string | null;
  fonts: { approach: string; families: number; preloaded: number; display: string[] };
  thirdParties: number;
  jsBytes: number;
  requests: number;
  notes: string[];
}

export async function robotsAllows(url: string, f: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  try {
    const r = await f(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return true;
    const lines = (await r.text()).split('\n').map((l) => l.replace(/#.*/, '').trim());
    let applies = false;
    const disallow: string[] = [];
    const allow: string[] = [];
    for (const l of lines) {
      const [k, ...v] = l.split(':');
      const key = k?.toLowerCase().trim();
      const val = v.join(':').trim();
      if (key === 'user-agent') applies = val === '*';
      else if (applies && key === 'disallow' && val) disallow.push(val);
      else if (applies && key === 'allow' && val) allow.push(val);
    }
    const path = u.pathname + u.search;
    const longest = (xs: string[]) => Math.max(-1, ...xs.filter((p) => path.startsWith(p)).map((p) => p.length));
    return longest(allow) >= longest(disallow);
  } catch {
    return true;
  }
}

/** One normal visit per URL. */
export async function visitCompetitor(url: string, o: { cruxKey?: string; fetchImpl?: typeof fetch } = {}): Promise<CompetitorResult> {
  const empty: CompetitorResult = { url, visited: false, fonts: { approach: 'unknown', families: 0, preloaded: 0, display: [] }, thirdParties: 0, jsBytes: 0, requests: 0, notes: [] };
  if (!(await robotsAllows(url, o.fetchImpl))) return { ...empty, skipped: 'robots.txt disallows this URL' };
  let field: CompetitorResult['field'];
  if (o.cruxKey) {
    const r: FieldResult | undefined = await cruxRecord({ url }, 'PHONE', o.cruxKey, o.fetchImpl).catch(() => undefined);
    if (r?.status === 'ok') field = { lcp: r.metrics.lcp, inp: r.metrics.inp, cls: r.metrics.cls };
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const session = await openSession(browser, { device: 'mobile' });
    const page = await session.newPage();
    const host = new URL(url).hostname.replace(/^www\./, '');
    const reqs: Array<{ url: string; type: string; bytes: number }> = [];
    page.on('response', async (r) => {
      const len = Number(r.headers()['content-length'] ?? 0);
      reqs.push({ url: r.url(), type: r.request().resourceType(), bytes: len || (await r.body().then((b) => b.length).catch(() => 0)) });
    });
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const sp = (window as unknown as { __sp?: { lcp: Array<{ startTime: number; tag: string | null }> } }).__sp;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const last = sp?.lcp[sp.lcp.length - 1];
      const preloaded = document.querySelectorAll('link[rel="preload"][as="font"]').length;
      const display = new Set<string>();
      const families = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const r of Array.from(sheet.cssRules)) if (r instanceof CSSFontFaceRule) {
            families.add(r.style.getPropertyValue('font-family'));
            display.add(r.style.getPropertyValue('font-display') || 'auto');
          }
        } catch { /* cross-origin sheet */ }
      }
      return { lcp: last?.startTime ?? null, tag: last?.tag ?? null, fcp, preloaded, display: [...display], families: families.size };
    });
    await session.close();
    const third = new Set(reqs.map((r) => { try { return new URL(r.url).hostname; } catch { return ''; } }).filter((h) => h && !h.endsWith(host)));
    const jsBytes = reqs.filter((r) => r.type === 'script').reduce((a, r) => a + r.bytes, 0);
    const google = reqs.some((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.url));
    const fontReqs = reqs.filter((r) => r.type === 'font');
    const approach = !fontReqs.length && !info.families ? 'system fonts' : google ? 'Google Fonts' : 'self-hosted web fonts';
    const notes = [`LCP element: ${info.tag ?? 'unknown'}`, `fonts: ${approach}${info.preloaded ? `, ${info.preloaded} preloaded` : ''}${info.display.length ? `, font-display ${info.display.join('/')}` : ''}`, `${third.size} third-party host(s)`, `${Math.round(jsBytes / 1024)} KB of JavaScript`];
    return { url, visited: true, field, lab: { lcp: info.lcp, fcp: info.fcp }, lcpElement: info.tag, fonts: { approach, families: info.families, preloaded: info.preloaded, display: info.display }, thirdParties: third.size, jsBytes, requests: reqs.length, notes };
  } finally {
    await browser.close();
  }
}

export interface BenchmarkTable {
  rows: CompetitorResult[];
  markdown: string;
  /** REV-06: competitors whose field (or, without field data, lab) LCP or INP is more than 20% better than the client's. */
  gaps: Array<{ url: string; metric: 'lcp' | 'inp'; theirs: number; ours: number; source: 'field' | 'lab' }>;
  plainWords: string;
}

export async function competitorBenchmark(client: string, competitors: string[], o: { cruxKey?: string; fetchImpl?: typeof fetch } = {}): Promise<BenchmarkTable> {
  const rows: CompetitorResult[] = [];
  for (const u of [client, ...competitors]) rows.push(await visitCompetitor(u, o));
  const ours = rows[0]!;
  const val = (r: CompetitorResult, m: 'lcp' | 'inp'): [number | undefined, 'field' | 'lab'] => (r.field?.[m] !== undefined ? [r.field[m], 'field'] : m === 'lcp' ? [r.lab?.lcp ?? undefined, 'lab'] : [undefined, 'lab']);
  const gaps: BenchmarkTable['gaps'] = [];
  for (const r of rows.slice(1)) {
    for (const m of ['lcp', 'inp'] as const) {
      const [t, src] = val(r, m);
      const [c] = val(ours, m);
      if (t !== undefined && c !== undefined && t < c * 0.8) gaps.push({ url: r.url, metric: m, theirs: Math.round(t), ours: Math.round(c), source: src });
    }
  }
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)}`);
  const markdown = ['| Site | Field LCP (ms) | Field INP (ms) | Lab LCP (ms) | LCP element | Fonts | Third parties | JS (KB) |', '|---|---|---|---|---|---|---|---|', ...rows.map((r, i) => `| ${i === 0 ? '**You** ' : ''}${r.url} | ${fmt(r.field?.lcp)} | ${fmt(r.field?.inp)} | ${r.visited ? fmt(r.lab?.lcp) : r.skipped ?? 'n/a'} | ${r.lcpElement ?? 'n/a'} | ${r.fonts.approach} | ${r.thirdParties} | ${Math.round(r.jsBytes / 1024)} |`)].join('\n');
  const fastest = [...rows.slice(1)].filter((r) => r.visited).sort((a, b) => (val(a, 'lcp')[0] ?? Infinity) - (val(b, 'lcp')[0] ?? Infinity))[0];
  let plainWords = 'No competitor was measurably faster.';
  if (fastest && (val(fastest, 'lcp')[0] ?? Infinity) < (val(ours, 'lcp')[0] ?? Infinity)) {
    const diffs: string[] = [];
    if (fastest.jsBytes < ours.jsBytes * 0.7) diffs.push(`it ships ${Math.round(fastest.jsBytes / 1024)} KB of JavaScript against your ${Math.round(ours.jsBytes / 1024)} KB`);
    if (fastest.thirdParties < ours.thirdParties) diffs.push(`it loads ${fastest.thirdParties} third-party services against your ${ours.thirdParties}`);
    if (fastest.fonts.approach !== ours.fonts.approach) diffs.push(`it uses ${fastest.fonts.approach} where you use ${ours.fonts.approach}`);
    if (fastest.lcpElement !== ours.lcpElement) diffs.push(`its largest element is a ${fastest.lcpElement ?? 'n/a'} where yours is a ${ours.lcpElement ?? 'n/a'}`);
    plainWords = `The fastest competitor (${fastest.url}) shows its main content sooner. ${diffs.length ? `The visible differences: ${diffs.join('; ')}.` : 'No single difference stands out from one visit.'} This comes from public data and one normal visit; nothing was copied.`;
  }
  return { rows, markdown, gaps, plainWords };
}
