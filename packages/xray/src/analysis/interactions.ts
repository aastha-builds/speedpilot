/**
 * Interaction deep dive (SPEC.md 15.5, REV-07): for each explored interaction, the handlers that ran (owner, file, line,
 * function), the Long Animation Frames, and how much of the interaction was input delay, processing and presentation.
 */
import type { SiteModel } from '../model.js';
import type { XrayCapture } from '../capture/cdp.js';

export interface HandlerTiming {
  function: string;
  url: string;
  line?: number;
  owner: string;
  ms: number;
  invoker: string;
}

export interface InteractionBreakdown {
  page: string;
  selector: string;
  kind: string;
  label: string;
  /** Longest event duration for the interaction (the INP candidate), ms, at 4x CPU slowdown. */
  durationMs: number;
  inputDelayMs: number;
  processingMs: number;
  presentationMs: number;
  longFrames: number;
  handlers: HandlerTiming[];
  slow: boolean;
}

function ownerFor(model: SiteModel, url: string): string {
  return model.nodes.get(`script:${url.split('#')[0]}`)?.owner ?? model.byType('script').find((n) => n.data.url === url)?.owner ?? 'unknown';
}

export function interactionBreakdowns(model: SiteModel, captures: XrayCapture[]): InteractionBreakdown[] {
  const out: InteractionBreakdown[] = [];
  for (const cap of captures) {
    for (const it of cap.interactions ?? []) {
      const ev = [...it.events].filter((e) => /pointer|mouse|click|key|touch/.test(e.name)).sort((a, b) => b.duration - a.duration)[0];
      const handlers = new Map<string, HandlerTiming>();
      for (const f of it.loaf) {
        for (const s of f.scripts) {
          if (!s.sourceURL) continue;
          const fn = s.sourceFunctionName || '(anonymous)';
          const key = `${s.sourceURL}|${fn}`;
          const node = model.byType('handler').find((h) => h.data.url === s.sourceURL && h.data.function === fn);
          const h = handlers.get(key) ?? { function: fn, url: s.sourceURL, line: node ? Number(node.data.line) : undefined, owner: ownerFor(model, s.sourceURL), ms: 0, invoker: s.invoker };
          h.ms += s.duration;
          handlers.set(key, h);
        }
      }
      const list = [...handlers.values()].map((h) => ({ ...h, ms: Math.round(h.ms) })).sort((a, b) => b.ms - a.ms);
      const durationMs = Math.round(ev?.duration ?? Math.max(0, ...it.loaf.map((f) => f.duration)));
      const inputDelayMs = ev ? Math.round(ev.processingStart - ev.startTime) : 0;
      const processingMs = ev ? Math.round(ev.processingEnd - ev.processingStart) : 0;
      out.push({ page: cap.url, selector: it.selector, kind: it.kind, label: it.label, durationMs, inputDelayMs, processingMs, presentationMs: ev ? Math.max(0, durationMs - inputDelayMs - processingMs) : 0, longFrames: it.loaf.length, handlers: list, slow: durationMs > 200 || list.some((h) => h.ms > 100) });
    }
  }
  return out.sort((a, b) => b.durationMs - a.durationMs);
}

/** REV-07: handlers from one owner that take more than 100 ms during an interaction. */
export function slowHandlers(b: InteractionBreakdown[]): Array<{ selector: string; event: string; script: string; fn?: string; ms: number; owner: string; page: string }> {
  const out = new Map<string, { selector: string; event: string; script: string; fn?: string; ms: number; owner: string; page: string }>();
  for (const x of b) for (const h of x.handlers.filter((y) => y.ms > 100)) {
    const k = `${h.url}|${h.function}|${x.selector}`;
    const prev = out.get(k);
    if (!prev || prev.ms < h.ms) out.set(k, { selector: x.selector, event: h.invoker.split('.').pop()?.replace(/^on/, '') || 'click', script: h.url, fn: h.function, ms: h.ms, owner: h.owner, page: x.page });
  }
  return [...out.values()].sort((a, b) => b.ms - a.ms);
}
