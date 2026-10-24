/**
 * Static analysis of Shopify Liquid (SPEC.md 15.3) with @shopify/liquid-html-parser: the render tree from layout to
 * templates, sections, blocks and snippets; loops over large collections and all_products; nested loops; asset tags
 * (script_tag, stylesheet_tag, img_url); app blocks and app snippets.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toLiquidHtmlAST, type LiquidHtmlNode } from '@shopify/liquid-html-parser';

export interface LiquidFileFacts {
  file: string;
  parsed: boolean;
  error?: string;
  renders: string[];
  sections: string[];
  sectionGroups: string[];
  contentForBlocks: boolean;
  loops: Array<{ variable: string; collection: string; depth: number; line: number; limit: number | null }>;
  scriptTags: Array<{ asset: string; filter: 'script_tag' | 'script' | 'stylesheet_tag'; parserBlocking: boolean; line: number }>;
  deprecated: string[];
  usesAllProducts: boolean;
  appBlocks: boolean;
  remoteScripts: string[];
  contentForHeader: boolean;
  paginateSizes: number[];
}

export interface RenderTree {
  layout: string;
  templates: Record<string, string[]>;
  edges: Array<{ from: string; to: string; kind: 'section' | 'render' | 'block' | 'group' }>;
  files: Record<string, LiquidFileFacts>;
  hotSpots: Array<{ file: string; reason: string; line: number }>;
}

function lineOf(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
}

/** Analyzes one Liquid file. */
export function analyzeLiquid(src: string, file: string): LiquidFileFacts {
  const f: LiquidFileFacts = { file, parsed: false, renders: [], sections: [], sectionGroups: [], contentForBlocks: false, loops: [], scriptTags: [], deprecated: [], usesAllProducts: false, appBlocks: false, remoteScripts: [], contentForHeader: false, paginateSizes: [] };
  let ast: LiquidHtmlNode;
  try {
    ast = toLiquidHtmlAST(src, { mode: 'tolerant' } as never) as unknown as LiquidHtmlNode;
    f.parsed = true;
  } catch (e) {
    f.error = (e as Error).message.slice(0, 200);
  }
  // Tag-level facts from the AST when available; the token regexes below cover tolerant parses and raw blocks.
  const loopStack: number[] = [];
  const visit = (n: unknown, depth: number) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; name?: string; markup?: unknown; children?: unknown[]; position?: { start: number }; source?: string };
    if (node.type === 'LiquidTag' && (node.name === 'for' || node.name === 'tablerow')) {
      const markup = typeof node.markup === 'string' ? node.markup : JSON.stringify(node.markup);
      const m = /(\w+)\s+in\s+([\w.[\]'"-]+)/.exec(markup) ?? /"name":"(\w+)".*?"collection".*?"(?:name|value)":"?([\w.]+)/.exec(markup);
      const lim = /limit:\s*(\d+)/.exec(markup);
      f.loops.push({ variable: m?.[1] ?? '?', collection: m?.[2] ?? '?', depth: depth + 1, line: lineOf(src, node.position?.start ?? 0), limit: lim ? Number(lim[1]) : null });
      loopStack.push(1);
      for (const c of node.children ?? []) visit(c, depth + 1);
      loopStack.pop();
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((c) => visit(c, depth));
      else if (v && typeof v === 'object' && (v as { type?: string }).type) visit(v, depth);
    }
  };
  if (f.parsed) visit(ast!, 0);
  else {
    // fallback: count loops by tokens
    let depth = 0;
    for (const m of src.matchAll(/\{%-?\s*(for|endfor)\b([^%]*)%\}/g)) {
      if (m[1] === 'for') {
        depth++;
        const mm = /(\w+)\s+in\s+([\w.[\]'"-]+)/.exec(m[2] ?? '');
        f.loops.push({ variable: mm?.[1] ?? '?', collection: mm?.[2] ?? '?', depth, line: lineOf(src, m.index ?? 0), limit: Number(/limit:\s*(\d+)/.exec(m[2] ?? '')?.[1]) || null });
      } else depth--;
    }
  }
  for (const m of src.matchAll(/\{%-?\s*(render|include)\s+['"]([\w-]+)['"]/g)) f.renders.push(m[2]!);
  for (const m of src.matchAll(/\{%-?\s*section\s+['"]([\w-]+)['"]/g)) f.sections.push(m[1]!);
  for (const m of src.matchAll(/\{%-?\s*sections\s+['"]([\w-]+)['"]/g)) f.sectionGroups.push(m[1]!);
  f.contentForBlocks = /\{%-?\s*content_for\s+['"]blocks['"]/.test(src);
  for (const m of src.matchAll(/\{\{-?\s*['"]([^'"]+)['"]\s*\|\s*asset_url\s*\|\s*(script_tag|stylesheet_tag)/g)) f.scriptTags.push({ asset: m[1]!, filter: m[2] as 'script_tag' | 'stylesheet_tag', parserBlocking: m[2] === 'script_tag', line: lineOf(src, m.index ?? 0) });
  for (const m of src.matchAll(/<script\b([^>]*?)\bsrc=(?:"([^"]+)"|'([^']+)')([^>]*)>/g)) {
    const attrs = `${m[1]} ${m[4]}`;
    const raw = m[2] ?? m[3] ?? '';
    const asset = /['"]([^'"]+)['"]\s*\|\s*asset_url/.exec(raw)?.[1] ?? raw;
    const blocking = !/\b(defer|async)\b/.test(attrs) && !/type=["']module/.test(attrs);
    f.scriptTags.push({ asset, filter: 'script', parserBlocking: blocking, line: lineOf(src, m.index ?? 0) });
    if (/^https?:\/\//.test(raw) && !/cdn\.shopify\.com/.test(raw)) f.remoteScripts.push(raw);
  }
  if (/\|\s*img_url\b/.test(src)) f.deprecated.push('img_url');
  if (/\binclude\s+['"]/.test(src)) f.deprecated.push('include');
  f.usesAllProducts = /\ball_products\b/.test(src);
  f.appBlocks = /"type"\s*:\s*"@app"|shopify:\/\/apps\//.test(src);
  f.contentForHeader = /content_for_header/.test(src);
  for (const m of src.matchAll(/\{%-?\s*paginate\s+[\w.]+\s+by\s+(\d+)/g)) f.paginateSizes.push(Number(m[1]));
  return f;
}

function readDir(themeDir: string, d: string, ext: string): Array<{ name: string; path: string }> {
  const dir = join(themeDir, d);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ name: f.slice(0, -ext.length), path: join(dir, f) }));
}

/** Builds the render tree and finds Liquid hot spots. */
export function liquidRenderTree(themeDir: string): RenderTree {
  const files: Record<string, LiquidFileFacts> = {};
  for (const d of ['layout', 'sections', 'blocks', 'snippets', 'templates']) for (const f of readDir(themeDir, d, '.liquid')) files[`${d}/${f.name}.liquid`] = analyzeLiquid(readFileSync(f.path, 'utf8'), `${d}/${f.name}.liquid`);
  const edges: RenderTree['edges'] = [];
  const templates: Record<string, string[]> = {};
  for (const t of readDir(themeDir, 'templates', '.json')) {
    try {
      const j = JSON.parse(readFileSync(t.path, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as { sections?: Record<string, { type: string; blocks?: Record<string, { type: string; blocks?: unknown }> }>; order?: string[] };
      templates[t.name] = (j.order ?? []).map((id) => j.sections?.[id]?.type ?? id);
      for (const id of j.order ?? []) {
        const s = j.sections?.[id];
        if (!s) continue;
        edges.push({ from: `templates/${t.name}.json`, to: `sections/${s.type}.liquid`, kind: 'section' });
        const walkBlocks = (from: string, blocks?: Record<string, { type: string; blocks?: unknown }>) => {
          for (const b of Object.values(blocks ?? {})) {
            const to = b.type.startsWith('shopify://') ? `app:${b.type.split('/')[3]}` : `blocks/${b.type}.liquid`;
            edges.push({ from, to, kind: 'block' });
            walkBlocks(to, b.blocks as Record<string, { type: string; blocks?: unknown }> | undefined);
          }
        };
        walkBlocks(`sections/${s.type}.liquid`, s.blocks);
      }
    } catch {
      /* invalid template JSON */
    }
  }
  for (const [file, f] of Object.entries(files)) {
    for (const r of f.renders) edges.push({ from: file, to: `snippets/${r}.liquid`, kind: 'render' });
    for (const s of f.sections) edges.push({ from: file, to: `sections/${s}.liquid`, kind: 'section' });
    for (const g of f.sectionGroups) {
      edges.push({ from: file, to: `sections/${g}.json`, kind: 'group' });
      const p = join(themeDir, 'sections', `${g}.json`);
      if (existsSync(p)) {
        try {
          const j = JSON.parse(readFileSync(p, 'utf8')) as { sections?: Record<string, { type: string }> };
          for (const s of Object.values(j.sections ?? {})) edges.push({ from: `sections/${g}.json`, to: `sections/${s.type}.liquid`, kind: 'section' });
        } catch {
          /* ignore */
        }
      }
    }
  }
  const hotSpots: RenderTree['hotSpots'] = [];
  for (const [file, f] of Object.entries(files)) {
    for (const l of f.loops) {
      if (/collections\.all\.products|all_products|collection\.products|search\.results/.test(l.collection) && (l.limit === null || l.limit > 50)) hotSpots.push({ file, reason: `loop over ${l.collection}${l.limit ? ` (limit ${l.limit})` : ''}`, line: l.line });
      if (l.depth >= 2) hotSpots.push({ file, reason: `nested loop (depth ${l.depth}) over ${l.collection}`, line: l.line });
    }
    if (f.usesAllProducts) hotSpots.push({ file, reason: 'uses all_products', line: 0 });
    for (const s of f.paginateSizes) if (s > 50) hotSpots.push({ file, reason: `paginate by ${s}`, line: 0 });
  }
  return { layout: 'layout/theme.liquid', templates, edges, files, hotSpots };
}
