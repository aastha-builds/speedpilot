/** `speedpilot xray diff <run-a> <run-b>`: what changed between two Site Models (nodes, dependencies, verdicts, costs). */
import type { SiteModel } from './model.js';

export interface XrayDiff {
  nodesAdded: Array<{ id: string; type: string; owner?: string }>;
  nodesRemoved: Array<{ id: string; type: string; owner?: string }>;
  dependenciesAdded: string[];
  dependenciesRemoved: string[];
  verdictChanges: Array<{ change: string; from: string; to: string }>;
  ownerBytes: Array<{ owner: string; before: number; after: number }>;
}

export function diffModels(a: SiteModel, b: SiteModel, va: Array<{ change: string; verdict: string }> = [], vb: Array<{ change: string; verdict: string }> = []): XrayDiff {
  const interesting = (t: string) => ['script', 'stylesheet', 'handler', 'global', 'query', 'liquid', 'plugin', 'app', 'theme', 'third-party'].includes(t);
  const nodesAdded = [...b.nodes.values()].filter((n) => interesting(n.type) && !a.nodes.has(n.id)).map((n) => ({ id: n.id, type: n.type, owner: n.owner }));
  const nodesRemoved = [...a.nodes.values()].filter((n) => interesting(n.type) && !b.nodes.has(n.id)).map((n) => ({ id: n.id, type: n.type, owner: n.owner }));
  const deps = (m: SiteModel) => new Set(m.edges.filter((e) => e.type === 'depends-on').map((e) => `${e.src} -> ${e.dst}`));
  const da = deps(a);
  const db = deps(b);
  const vmap = new Map(va.map((v) => [v.change, v.verdict]));
  const verdictChanges = vb.filter((v) => vmap.has(v.change) && vmap.get(v.change) !== v.verdict).map((v) => ({ change: v.change, from: vmap.get(v.change)!, to: v.verdict }));
  const bytes = (m: SiteModel) => {
    const out = new Map<string, number>();
    for (const e of m.edges.filter((x) => x.type === 'costs' && x.data?.bytes !== undefined)) out.set(e.src, (out.get(e.src) ?? 0) + Number(e.data!.bytes));
    return out;
  };
  const ba = bytes(a);
  const bb = bytes(b);
  const owners = new Set([...ba.keys(), ...bb.keys()]);
  const ownerBytes = [...owners].map((o) => ({ owner: o, before: ba.get(o) ?? 0, after: bb.get(o) ?? 0 })).filter((x) => x.before !== x.after).sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
  return { nodesAdded, nodesRemoved, dependenciesAdded: [...db].filter((x) => !da.has(x)), dependenciesRemoved: [...da].filter((x) => !db.has(x)), verdictChanges, ownerBytes };
}
