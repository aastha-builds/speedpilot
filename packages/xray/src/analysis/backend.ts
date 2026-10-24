/**
 * Backend mapping (SPEC.md 15.5): WordPress slow queries, outgoing HTTP calls, hooks and heavy PHP patterns tied to the
 * owning plugin or theme function; Shopify Liquid hot spots tied to the section, block or snippet.
 */
import type { SiteModel } from '../model.js';

export interface BackendItem {
  kind: 'query' | 'http' | 'hook' | 'php-pattern' | 'liquid-hot-spot' | 'leftover-app-code';
  owner: string;
  where: string;
  ms?: number;
  detail: string;
}

export function backendMap(model: SiteModel): BackendItem[] {
  const out: BackendItem[] = [];
  for (const n of model.byType('query')) {
    if (n.data.static) out.push({ kind: 'php-pattern', owner: n.owner ?? 'unknown', where: `${n.data.file}:${n.data.line}${n.data.function ? ` (${n.data.function})` : ''}`, detail: String(n.data.pattern) });
    else out.push({ kind: 'query', owner: n.owner ?? 'unknown', where: String(n.data.function), ms: Number(n.data.ms), detail: String(n.data.sql).slice(0, 200) });
  }
  for (const n of model.byType('request').filter((r) => r.data.serverSide)) out.push({ kind: 'http', owner: n.owner ?? 'unknown', where: String(n.data.caller), ms: Number(n.data.ms), detail: n.label });
  for (const n of model.byType('hook')) out.push({ kind: 'hook', owner: n.owner ?? 'unknown', where: `${n.data.file}:${n.data.line}`, detail: n.label });
  for (const n of model.byType('liquid')) {
    for (const h of (n.data.hotSpots as Array<{ pattern?: string; reason?: string; line?: number }> | undefined) ?? []) out.push({ kind: 'liquid-hot-spot', owner: n.owner ?? 'theme', where: `${n.label}${h.line ? `:${h.line}` : ''}`, detail: h.reason ?? h.pattern ?? 'hot spot' });
    for (const e of model.out(n.id, 'renders').filter((x) => x.dst.startsWith('app:'))) out.push({ kind: 'leftover-app-code', owner: e.dst, where: n.label, detail: `renders code of ${e.dst}` });
    if (n.data.leftoverApp) out.push({ kind: 'leftover-app-code', owner: `app:${n.data.leftoverApp}`, where: n.label, detail: `still rendered (by ${model.in(n.id, 'renders').map((e) => model.nodes.get(e.src)?.label ?? e.src).join(', ') || 'nothing'}) but references ${(n.data.leftoverHosts as string[]).join(', ')}, which the storefront no longer loads` });
  }
  return out.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
}
