/** Cost attribution per owner (SPEC.md 15.5): main-thread ms, bytes, requests, layout shift and interaction delay, as a table and a treemap. */
import type { XrayCapture } from '../capture/cdp.js';
import type { InteractionBreakdown } from './interactions.js';

export interface OwnerCost {
  owner: string;
  mainThreadMs: number;
  bytes: number;
  requests: number;
  layoutShift: number;
  interactionMs: number;
}

export function ownerCosts(captures: XrayCapture[], interactions: InteractionBreakdown[] = []): OwnerCost[] {
  const m = new Map<string, OwnerCost>();
  const get = (o: string) => {
    let c = m.get(o);
    if (!c) m.set(o, (c = { owner: o, mainThreadMs: 0, bytes: 0, requests: 0, layoutShift: 0, interactionMs: 0 }));
    return c;
  };
  const n = Math.max(1, new Set(captures.map((c) => c.url)).size);
  for (const cap of captures) {
    for (const c of cap.cpu) get(c.owner.id).mainThreadMs += c.selfMs / n;
    for (const r of cap.requests) {
      const c = get(r.owner.id);
      c.bytes += r.bytes / n;
      c.requests += 1 / n;
    }
    // layout shifts go to the owner of the script that last inserted or styled the shifted node; without that proof
    // they stay "unattributed"
    for (const s of cap.shifts) get('unattributed').layoutShift += s.value / n;
  }
  for (const i of interactions) for (const h of i.handlers) get(h.owner).interactionMs = Math.max(get(h.owner).interactionMs, h.ms);
  return [...m.values()].map((c) => ({ ...c, mainThreadMs: Math.round(c.mainThreadMs), bytes: Math.round(c.bytes), requests: Math.round(c.requests * 10) / 10, layoutShift: Math.round(c.layoutShift * 1000) / 1000 })).sort((a, b) => b.mainThreadMs + b.bytes / 1000 - (a.mainThreadMs + a.bytes / 1000));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Treemap (slice and dice by main-thread ms, falling back to bytes) plus the table. */
export function costsHtml(costs: OwnerCost[], title = 'Cost per owner'): string {
  const items = costs.filter((c) => c.mainThreadMs > 0 || c.bytes > 0).map((c) => ({ c, v: c.mainThreadMs + c.bytes / 10000 }));
  const total = items.reduce((a, b) => a + b.v, 0) || 1;
  const W = 1000;
  const H = 420;
  let x = 0;
  const rects = items.map(({ c, v }, i) => {
    const w = (v / total) * W;
    const r = `<g><rect x="${x}" y="0" width="${w}" height="${H}" fill="hsl(${(i * 47) % 360} 60% ${55 + (i % 3) * 8}%)" stroke="#fff"><title>${esc(c.owner)}: ${c.mainThreadMs} ms, ${Math.round(c.bytes / 1024)} KB</title></rect>${w > 60 ? `<text x="${x + 4}" y="16" font-size="12">${esc(c.owner.slice(0, Math.floor(w / 7)))}</text>` : ''}</g>`;
    x += w;
    return r;
  });
  const rows = costs.map((c) => `<tr><td>${esc(c.owner)}</td><td>${c.mainThreadMs}</td><td>${Math.round(c.bytes / 1024)}</td><td>${c.requests}</td><td>${c.layoutShift}</td><td>${c.interactionMs}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:13px system-ui;margin:16px;background:#fff;color:#1f2328}svg{width:100%;height:auto}table{border-collapse:collapse;margin-top:16px}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:right}td:first-child,th:first-child{text-align:left}</style>
<h1>${esc(title)}</h1><svg viewBox="0 0 ${W} ${H}">${rects.join('')}</svg>
<table><tr><th>Owner</th><th>Main thread (ms)</th><th>Bytes (KB)</th><th>Requests</th><th>Layout shift</th><th>Worst handler (ms)</th></tr>${rows}</table>`;
}
