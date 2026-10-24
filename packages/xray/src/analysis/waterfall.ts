/**
 * Ideal versus actual waterfall (SPEC.md 15.5, REV-02, REV-03): the minimum the first screen needs (HTML, used CSS,
 * fonts above the fold, the LCP image, first-screen scripts) against what really loads and when.
 */
import type { XrayCapture, CapturedRequest } from '../capture/cdp.js';

export interface WaterfallRow {
  url: string;
  type: string;
  owner: string;
  startMs: number;
  endMs: number;
  bytes: number;
  renderBlocking?: string;
  ideal: boolean;
  why: string;
}

export interface Waterfall {
  page: string;
  device: string;
  fcp: number | null;
  lcp: number | null;
  lcpUrl: string | null;
  actual: WaterfallRow[];
  ideal: WaterfallRow[];
  /** REV-02: requested before first paint but not needed by the first screen. */
  earlyUnused: Array<{ url: string; owner: string; bytes: number; type: string }>;
  /** REV-03: needed by the first screen but discovered late. */
  lateNeeded: Array<{ url: string; type: string; delayMs: number }>;
}

/**
 * @param neededScripts URLs of scripts that must run before first paint (for example the ones whose defer verdict is
 * not `safe`); when omitted every parser-blocking script counts as needed.
 */
export function waterfall(cap: XrayCapture, neededScripts?: Set<string>): Waterfall {
  const fcp = cap.fcp;
  const lcp = cap.lcp?.startTime ?? null;
  const lcpUrl = cap.lcp?.url ?? null;
  const doc = cap.requests.find((r) => r.type === 'document') ?? cap.requests[0];
  const docEnd = doc?.endMs ?? 0;
  const cssUsed = new Map<string, number>();
  for (const c of cap.coverage.find((x) => x.state === 'load')?.css ?? []) cssUsed.set(c.url, (cssUsed.get(c.url) ?? 0) + c.used);
  const scriptLoading = new Map(cap.scripts.filter((s) => !s.inline).map((s) => [s.url, s.loading]));
  const paintMark = fcp ?? lcp ?? Infinity;
  const row = (r: CapturedRequest): WaterfallRow => {
    let ideal = false;
    let why = 'not needed for the first screen';
    if (r === doc) [ideal, why] = [true, 'the HTML document'];
    else if (r.url === lcpUrl) [ideal, why] = [true, 'the LCP image'];
    else if (r.type === 'stylesheet') [ideal, why] = (cssUsed.get(r.url) ?? 0) > 0 ? [true, 'CSS rules used on load'] : [false, 'no CSS rule used on load'];
    else if (r.type === 'font') [ideal, why] = lcp !== null && r.startMs <= lcp ? [true, 'font used before LCP'] : [false, 'font requested after LCP'];
    else if (r.type === 'script') {
      const loading = scriptLoading.get(r.url);
      const needed = neededScripts ? neededScripts.has(r.url) : loading === 'blocking';
      [ideal, why] = needed ? [true, 'script the first screen needs before first paint'] : [false, `script not needed before first paint (${loading ?? 'unknown'})`];
    }
    return { url: r.url, type: r.type, owner: r.owner.id, startMs: Math.round(r.startMs), endMs: Math.round(r.endMs), bytes: r.bytes, renderBlocking: r.renderBlocking, ideal, why };
  };
  const actual = [...cap.requests].sort((a, b) => a.startMs - b.startMs).map(row);
  const ideal = actual.filter((r) => r.ideal);
  const earlyUnused = actual.filter((r) => !r.ideal && r.startMs < paintMark && ['script', 'stylesheet', 'font', 'image'].includes(r.type) && r.url !== lcpUrl).map((r) => ({ url: r.url, owner: r.owner, bytes: r.bytes, type: r.type }));
  const lateNeeded: Waterfall['lateNeeded'] = [];
  const lcpRow = actual.find((r) => r.url === lcpUrl);
  if (lcpRow && lcpRow.startMs - docEnd > 150) lateNeeded.push({ url: lcpRow.url, type: 'lcp-image', delayMs: Math.round(lcpRow.startMs - docEnd) });
  for (const f of actual.filter((r) => r.type === 'font' && r.ideal && r.startMs - docEnd > 300)) lateNeeded.push({ url: f.url, type: 'font', delayMs: Math.round(f.startMs - docEnd) });
  return { page: cap.url, device: cap.device, fcp, lcp, lcpUrl, actual, ideal, earlyUnused, lateNeeded };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Side-by-side HTML of both waterfalls. */
export function waterfallHtml(w: Waterfall): string {
  const max = Math.max(1, ...w.actual.map((r) => r.endMs));
  const bars = (rows: WaterfallRow[]) => rows.map((r) => `<div class="r ${r.ideal ? 'i' : 'x'}" title="${esc(r.why)}"><span class="u">${esc(r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) || r.url)}</span><span class="t"><b style="left:${(r.startMs / max) * 100}%;width:${Math.max(0.5, ((r.endMs - r.startMs) / max) * 100)}%"></b></span></div>`).join('');
  const mark = (ms: number | null, label: string) => (ms === null ? '' : `<i style="left:calc(40% + ${(ms / max) * 60}%)">${label} ${Math.round(ms)} ms</i>`);
  return `<!doctype html><meta charset="utf-8"><title>Waterfall ${esc(w.page)}</title><style>
body{font:13px system-ui;margin:16px;color:#1f2328;background:#fff}.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.r{display:flex;height:18px;align-items:center}.u{width:40%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.t{position:relative;flex:1;height:10px;background:#f3f4f6}
.t b{position:absolute;top:0;height:10px;background:#0969da}.x .t b{background:#cf222e}.wrap{position:relative}.wrap i{position:absolute;top:-16px;font-size:11px;border-left:1px dashed #555;height:100%}
@media(max-width:800px){.cols{grid-template-columns:1fr}}</style>
<h1>Ideal versus actual: ${esc(w.page)} (${w.device})</h1><p>Blue: needed for the first screen. Red: loaded but not needed for the first screen. REV-02 items: ${w.earlyUnused.length}. REV-03 items: ${w.lateNeeded.length}.</p>
<div class="cols"><section><h2>Actual (${w.actual.length} requests)</h2><div class="wrap">${mark(w.fcp, 'FCP')}${mark(w.lcp, 'LCP')}${bars(w.actual)}</div></section><section><h2>Ideal (${w.ideal.length} requests)</h2><div class="wrap">${bars(w.ideal)}</div></section></div>`;
}
