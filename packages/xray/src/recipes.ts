/**
 * Recipe library (SPEC.md 15.6): how to recognize a plugin, app, theme or library, which assets it needs on which page
 * types, inline dependencies, safe optimizations, known breakages and verification steps. Identifiers and behaviour
 * notes only, never vendor code. Unknown items get a drafted recipe for human review (REV-01); a recipe used on a
 * version it was not verified on is re-verified first (REV-04).
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { slug, type DB } from '@speedpilot/core';
import type { SiteModel } from './model.js';
import type { ScriptInfo } from './build.js';

export interface Recipe {
  id: string;
  platform: 'wordpress' | 'shopify' | 'both';
  kind: 'plugin' | 'theme' | 'app' | 'library';
  name: string;
  category: string;
  recognize: { handles: string[]; paths: string[]; domains: string[]; globals: string[]; classes: string[] };
  versionsVerified: string[];
  needs: { pageTypes: string[]; markers: string[] };
  inlineDependencies: string[];
  safeOptimizations: Array<{ change: string; tier: string; when?: string }>;
  neverDelay?: boolean;
  /** Handles that carry tracking or attribution data: never delayed or removed (SAFE-02). */
  trackingHandles?: string[];
  delayable?: boolean;
  knownBreakages: string[];
  verify: string[];
  confidence: number;
  status?: 'seed' | 'draft' | 'verified';
  notes?: string;
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

export function loadRecipes(root?: string): Recipe[] {
  const base = root && existsSync(join(root, 'recipes')) ? join(root, 'recipes') : join(REPO, 'recipes');
  const out: Recipe[] = [];
  for (const dir of ['wordpress', 'shopify', 'libraries']) {
    const d = join(base, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.yaml'))) out.push(YAML.parse(readFileSync(join(d, f), 'utf8')) as Recipe);
  }
  return out;
}

/** Applies confidence learned on fixtures and real jobs (store `recipes` table) over the seed value. */
export function withLearnedConfidence(recipes: Recipe[], db?: DB): Recipe[] {
  if (!db) return recipes;
  const rows = db.prepare('SELECT id, confidence FROM recipes').all() as Array<{ id: string; confidence: number }>;
  const by = new Map(rows.map((r) => [r.id, r.confidence]));
  return recipes.map((r) => (by.has(r.id) ? { ...r, confidence: by.get(r.id)! } : r));
}

export interface RecipeMatch {
  recipe: Recipe;
  via: string;
}

/** Finds the recipe for a script by handle, path, domain or the globals it defines. Platform-specific recipes win over libraries. */
export function matchRecipe(recipes: Recipe[], platform: 'wordpress' | 'shopify', s: { url?: string; handle?: string; owner?: string; defines?: string[] }): RecipeMatch | undefined {
  const pool = recipes.filter((r) => r.platform === platform || r.platform === 'both');
  const ordered = [...pool.filter((r) => r.platform === platform), ...pool.filter((r) => r.platform === 'both')];
  for (const r of ordered) if (s.handle && r.recognize.handles.includes(s.handle)) return { recipe: r, via: `handle ${s.handle}` };
  for (const r of ordered) {
    const p = r.recognize.paths.find((x) => s.url?.includes(x) && x !== '/cdn/shop/t/');
    if (p) return { recipe: r, via: `path ${p}` };
  }
  for (const r of ordered) {
    const d = r.recognize.domains.find((x) => s.url?.includes(x));
    if (d) return { recipe: r, via: `domain ${d}` };
  }
  for (const r of ordered) {
    const g = r.recognize.globals.find((x) => s.defines?.includes(x));
    if (g) return { recipe: r, via: `defines ${g}` };
  }
  return undefined;
}

/** REV-04: true when the installed version is not among the versions the recipe was verified on. */
export function versionMismatch(r: Recipe, installed: string | undefined): boolean {
  if (!installed) return r.versionsVerified.length > 0;
  return !r.versionsVerified.some((v) => installed === v || (v.endsWith('.x') && installed.startsWith(v.slice(0, -1))));
}

/** REV-01: drafts a recipe from what the X-ray observed for an owner without a recipe. Written for human review. */
export function draftRecipe(model: SiteModel, scripts: ScriptInfo[], owner: string, platform: 'wordpress' | 'shopify'): Recipe {
  const own = scripts.filter((s) => s.script.owner.id === owner);
  const urls = [...new Set(own.filter((s) => !s.script.inline).map((s) => s.script.url))];
  const paths = [...new Set(urls.map((u) => { try { const x = new URL(u); return x.pathname.split('/').slice(0, 4).join('/') + '/'; } catch { return u; } }))];
  const domains = [...new Set(urls.map((u) => { try { return new URL(u).host; } catch { return ''; } }).filter(Boolean))];
  const globals = [...new Set(own.flatMap((s) => model.out(s.id, 'defines').filter((e) => e.dst.startsWith('global:')).map((e) => e.dst.slice(7))))];
  const pages = [...new Set(own.map((s) => s.page))];
  const listeners = [...new Set(own.flatMap((s) => model.out(s.id, 'defines').filter((e) => e.dst.startsWith('handler:')).map((e) => model.nodes.get(e.dst)?.label ?? e.dst)))];
  const kind = owner.split(':')[0] as Recipe['kind'];
  return {
    id: `draft-${slug(owner)}`,
    platform,
    kind: ['plugin', 'theme', 'app'].includes(kind) ? kind : 'library',
    name: owner.split(':').slice(1).join(':') || owner,
    category: 'unknown',
    recognize: { handles: own.map((s) => s.handle).filter((h): h is string => !!h), paths: paths.filter((p) => p.startsWith('/')), domains, globals, classes: [] },
    versionsVerified: [],
    needs: { pageTypes: [`seen on ${pages.length} captured page(s)`], markers: [] },
    inlineDependencies: [],
    safeOptimizations: [],
    knownBreakages: [],
    verify: listeners.length ? [`interactions handled by: ${listeners.slice(0, 10).join(', ')}`] : [],
    confidence: 0,
    status: 'draft',
    notes: 'Drafted by the X-ray from observed behaviour (REV-01). Review before use; until then every change to these scripts is `unknown`.',
  };
}

export function writeDraft(dir: string, r: Recipe): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${r.id}.yaml`);
  writeFileSync(p, YAML.stringify(r));
  return p;
}

/** Learning loop: verification on a fixture or real job raises confidence; a failure lowers it (SPEC.md 15.6). */
export function recordRecipeOutcome(db: DB, r: Recipe, passed: boolean, version?: string): number {
  const row = db.prepare('SELECT confidence, recipe_json FROM recipes WHERE id = ?').get(r.id) as { confidence: number; recipe_json: string } | undefined;
  const cur = row?.confidence ?? r.confidence;
  const next = passed ? Math.min(0.99, cur + (1 - cur) * 0.2) : Math.max(0, cur * 0.5);
  const json = row ? (JSON.parse(row.recipe_json) as Recipe) : r;
  if (passed && version && !json.versionsVerified.includes(version)) json.versionsVerified.push(version);
  db.prepare('INSERT INTO recipes (id, platform, target, recipe_json, confidence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET recipe_json = excluded.recipe_json, confidence = excluded.confidence').run(r.id, r.platform, r.name, JSON.stringify(json), next);
  return next;
}
