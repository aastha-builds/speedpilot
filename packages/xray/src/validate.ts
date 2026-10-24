/**
 * Validation against fixtures/truth.json (SPEC.md 15.10): every planted dependency, handler, unused asset, slow query
 * and Liquid hot spot must appear in the Site Model with the right owner, and at least 95% of bytes on each sample URL
 * must be attributed to the right owner.
 */
import type { SiteModel, ModelNode } from './model.js';
import type { XrayCapture } from './capture/cdp.js';

export interface TruthOwnerRule {
  match: string;
  owner: string;
}

export interface Truth {
  baseUrl: string;
  owners: TruthOwnerRule[];
  dependencies: Array<{ id: string; script: string; neededBy: string[] }>;
  handlers: Array<{ id: string; selector: string; event: string; script: string; function?: string; slow: boolean }>;
  unusedAssets: Array<{ id: string; asset: string }>;
  slowQueries?: Array<{ id: string; caller: string; owner: string }>;
  liquidHotSpots?: Array<{ id: string; file: string }>;
  leftoverAppCode?: Array<{ id: string; file: string }>;
  changes: Array<{ change: string; verdict: 'safe' | 'unsafe' | 'unknown' }>;
}

export function expectedOwner(url: string, rules: TruthOwnerRule[]): string | undefined {
  return rules.find((r) => url.includes(r.match))?.owner;
}

/** Finds a script node by WordPress handle, URL fragment, inline element id or inline content. */
export function findScript(model: SiteModel, ref: string): ModelNode | undefined {
  const scripts = model.byType('script');
  if (ref.startsWith('inline:contains:')) {
    const t = ref.slice('inline:contains:'.length);
    return scripts.find((s) => s.data.inline && String(s.data.contentHead ?? '').includes(t));
  }
  if (ref.startsWith('inline:')) {
    const id = ref.slice('inline:'.length);
    return scripts.find((s) => s.data.inline && s.data.elementId === id);
  }
  return scripts.find((s) => s.data.handle === ref) ?? scripts.find((s) => !s.data.inline && String(s.data.url ?? '').includes(ref));
}

function dependsOn(model: SiteModel, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return model.out(from, 'depends-on').some((e) => e.dst === to || dependsOn(model, e.dst, to, seen));
}

export interface TruthReport {
  missing: string[];
  wrongOwner: string[];
  found: string[];
}

export function checkTruth(model: SiteModel, truth: Truth): TruthReport {
  const missing: string[] = [];
  const wrongOwner: string[] = [];
  const found: string[] = [];
  const ownerOk = (n: ModelNode | undefined, url: string) => {
    const exp = expectedOwner(url, truth.owners);
    return !exp || n?.owner === exp;
  };
  for (const d of truth.dependencies) {
    const s = findScript(model, d.script);
    if (!s) {
      missing.push(`${d.id}: script ${d.script}`);
      continue;
    }
    if (!ownerOk(s, String(s.data.url))) wrongOwner.push(`${d.id}: ${d.script} owned by ${s.owner}`);
    for (const n of d.neededBy) {
      const u = findScript(model, n);
      if (!u) missing.push(`${d.id}: dependent ${n}`);
      else if (!dependsOn(model, u.id, s.id)) missing.push(`${d.id}: no depends-on edge ${n} -> ${d.script}`);
    }
    found.push(d.id);
  }
  for (const h of truth.handlers) {
    const hit = model.byType('handler').find((n) => String(n.data.url).includes(h.script) && n.data.type === h.event && String(n.data.selector).includes(h.selector) && (!h.function || n.data.function === h.function));
    if (!hit) missing.push(`${h.id}: handler ${h.selector} ${h.event} in ${h.script}`);
    else if (!ownerOk(hit, String(hit.data.url))) wrongOwner.push(`${h.id}: owned by ${hit.owner}`);
    else found.push(h.id);
  }
  for (const a of truth.unusedAssets) {
    const hit = [...model.nodes.values()].find((n) => (n.type === 'script' || n.type === 'stylesheet' || n.type === 'request') && String(n.data.url ?? n.label).includes(a.asset));
    if (!hit) missing.push(`${a.id}: asset ${a.asset}`);
    else if (!ownerOk(hit, a.asset)) wrongOwner.push(`${a.id}: owned by ${hit.owner}`);
    else found.push(a.id);
  }
  for (const q of truth.slowQueries ?? []) {
    const hit = model.byType('query').find((n) => n.data.function === q.caller && !n.data.static);
    if (!hit) missing.push(`${q.id}: slow query in ${q.caller}`);
    else if (hit.owner !== q.owner) wrongOwner.push(`${q.id}: owned by ${hit.owner}`);
    else found.push(q.id);
  }
  for (const l of truth.liquidHotSpots ?? []) {
    const n = model.nodes.get(`liquid:${l.file}`);
    if (!n || !(n.data.hotSpots as unknown[] | undefined)?.length) missing.push(`${l.id}: hot spot ${l.file}`);
    else found.push(l.id);
  }
  for (const l of truth.leftoverAppCode ?? []) {
    const n = model.nodes.get(`liquid:${l.file}`);
    if (!n || !model.in(n.id, 'renders').length) missing.push(`${l.id}: leftover ${l.file} not in the render tree`);
    else found.push(l.id);
  }
  return { missing, wrongOwner, found };
}

/** Share of bytes on each page attributed to the owner the truth file expects. */
export function byteAttribution(captures: XrayCapture[], rules: TruthOwnerRule[]): Array<{ url: string; device: string; share: number; matchedBytes: number; totalBytes: number; wrong: Array<{ url: string; got: string; expected: string; bytes: number }> }> {
  return captures.map((c) => {
    let matched = 0;
    let correct = 0;
    let total = 0;
    const wrong: Array<{ url: string; got: string; expected: string; bytes: number }> = [];
    for (const r of c.requests) {
      if (r.type === 'document' || r.url.startsWith('data:')) continue;
      total += r.bytes;
      const exp = expectedOwner(r.url, rules);
      if (!exp) continue;
      matched += r.bytes;
      if (r.owner.id === exp) correct += r.bytes;
      else wrong.push({ url: r.url, got: r.owner.id, expected: exp, bytes: r.bytes });
    }
    return { url: c.url, device: c.device, share: matched ? correct / matched : 1, matchedBytes: matched, totalBytes: total, wrong };
  });
}
