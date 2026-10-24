/**
 * The Site Model (SPEC.md 15.4): one graph per run. Nodes: page, template, element, script, stylesheet, CSS rule group,
 * font, image, request, handler, hook, query, Liquid file, plugin, app, theme, third party, global. Edges: loads,
 * initiates, defines, uses, depends-on, listens, touches, styles, renders, owned-by, costs. Every edge stores its
 * evidence (runtime, static, recipe, rea) and a confidence; every request, file, handler, hook and query has an owner.
 */
import type { DB } from '@speedpilot/core';

export type NodeType = 'page' | 'template' | 'element' | 'script' | 'stylesheet' | 'css-rule-group' | 'font' | 'image' | 'request' | 'handler' | 'hook' | 'query' | 'liquid' | 'plugin' | 'app' | 'theme' | 'third-party' | 'platform' | 'core' | 'first-party' | 'media' | 'mu-plugin' | 'global' | 'unknown';
export type EdgeType = 'loads' | 'initiates' | 'defines' | 'uses' | 'depends-on' | 'listens' | 'touches' | 'styles' | 'renders' | 'owned-by' | 'costs';
export type Evidence = 'runtime' | 'static' | 'recipe' | 'rea' | 'agent' | 'backend';

export interface ModelNode {
  id: string;
  type: NodeType;
  label: string;
  owner?: string;
  data: Record<string, unknown>;
}

export interface ModelEdge {
  src: string;
  dst: string;
  type: EdgeType;
  evidence: Evidence;
  confidence: number;
  data?: Record<string, unknown>;
}

export class SiteModel {
  nodes = new Map<string, ModelNode>();
  edges: ModelEdge[] = [];
  private edgeKeys = new Set<string>();

  node(id: string, type: NodeType, label: string, data: Record<string, unknown> = {}, owner?: string): ModelNode {
    const existing = this.nodes.get(id);
    if (existing) {
      Object.assign(existing.data, data);
      if (owner && !existing.owner) existing.owner = owner;
      return existing;
    }
    const n: ModelNode = { id, type, label, owner, data };
    this.nodes.set(id, n);
    if (owner) this.ownerNode(owner);
    if (owner && owner !== id) this.edge(id, owner, 'owned-by', 'runtime', 1);
    return n;
  }

  ownerNode(owner: string): ModelNode {
    const kind = owner.split(':')[0] as NodeType;
    const type: NodeType = ['plugin', 'app', 'theme', 'third-party', 'platform', 'core', 'first-party', 'media', 'mu-plugin'].includes(kind) ? kind : 'unknown';
    if (!this.nodes.has(owner)) this.nodes.set(owner, { id: owner, type, label: owner.split(':').slice(1).join(':') || owner, data: {} });
    return this.nodes.get(owner)!;
  }

  edge(src: string, dst: string, type: EdgeType, evidence: Evidence, confidence: number, data?: Record<string, unknown>): void {
    const k = `${src}|${dst}|${type}|${evidence}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push({ src, dst, type, evidence, confidence, data });
  }

  out(id: string, type?: EdgeType): ModelEdge[] {
    return this.edges.filter((e) => e.src === id && (!type || e.type === type));
  }

  in(id: string, type?: EdgeType): ModelEdge[] {
    return this.edges.filter((e) => e.dst === id && (!type || e.type === type));
  }

  ownerOf(id: string): string | undefined {
    return this.nodes.get(id)?.owner;
  }

  byType(type: NodeType): ModelNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  toJSON() {
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }

  static fromJSON(j: { nodes: ModelNode[]; edges: ModelEdge[] }): SiteModel {
    const m = new SiteModel();
    for (const n of j.nodes) m.nodes.set(n.id, n);
    for (const e of j.edges) m.edge(e.src, e.dst, e.type, e.evidence, e.confidence, e.data);
    return m;
  }

  /** Persists to the store's xray_nodes and xray_edges tables. */
  save(db: DB, runId: string): void {
    const n = db.prepare('INSERT OR REPLACE INTO xray_nodes (run_id, id, type, label, owner, data_json) VALUES (?, ?, ?, ?, ?, ?)');
    const e = db.prepare('INSERT INTO xray_edges (run_id, src, dst, type, evidence, confidence, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM xray_nodes WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM xray_edges WHERE run_id = ?').run(runId);
      for (const x of this.nodes.values()) n.run(runId, x.id, x.type, x.label, x.owner ?? null, JSON.stringify(x.data));
      for (const x of this.edges) e.run(runId, x.src, x.dst, x.type, x.evidence, x.confidence, JSON.stringify(x.data ?? {}));
    })();
  }

  static load(db: DB, runId: string): SiteModel {
    const m = new SiteModel();
    for (const r of db.prepare('SELECT * FROM xray_nodes WHERE run_id = ?').all(runId) as Array<{ id: string; type: NodeType; label: string; owner: string | null; data_json: string }>) m.nodes.set(r.id, { id: r.id, type: r.type, label: r.label, owner: r.owner ?? undefined, data: JSON.parse(r.data_json) });
    for (const r of db.prepare('SELECT * FROM xray_edges WHERE run_id = ?').all(runId) as Array<{ src: string; dst: string; type: EdgeType; evidence: Evidence; confidence: number; data_json: string }>) m.edge(r.src, r.dst, r.type, r.evidence, r.confidence, JSON.parse(r.data_json));
    return m;
  }
}

/** Stable node IDs. */
export const ids = {
  page: (url: string) => `page:${url}`,
  script: (url: string, inlineIndex?: number) => (inlineIndex !== undefined ? `script:inline:${url}#${inlineIndex}` : `script:${url.split('#')[0]}`),
  stylesheet: (url: string) => `stylesheet:${url}`,
  request: (url: string) => `request:${url}`,
  global: (name: string) => `global:${name}`,
  handler: (url: string, line: number, type: string) => `handler:${url}:${line}:${type}`,
  element: (page: string, selector: string) => `element:${page}|${selector}`,
  query: (fn: string, sql: string) => `query:${fn}:${sql.slice(0, 60)}`,
  liquid: (file: string) => `liquid:${file}`,
  hook: (hook: string, cb: string) => `hook:${hook}:${cb}`,
};
