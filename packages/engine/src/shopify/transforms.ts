/**
 * Shopify Liquid transforms (SPEC.md 8.2). Every edit is located on the Liquid AST (@shopify/liquid-html-parser) and
 * spliced into the file at the node's exact position, never by a regular expression over the file. One transform is
 * one commit on the work theme. `content_for_header` and checkout are never touched (CLAUDE.md rule 7): any edit that
 * overlaps them is refused.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toLiquidHtmlAST } from '@shopify/liquid-html-parser';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface FileChange {
  file: string;
  before: string;
  after: string;
}

export interface TransformResult {
  id: string;
  description: string;
  checkIds: string[];
  changes: FileChange[];
  /** New files added to the theme (snippets, resized assets). */
  added: Array<{ file: string; data: Buffer | string }>;
}

export class ProtectedEditError extends Error {
  override name = 'ProtectedEditError';
}

interface Node {
  type: string;
  name?: unknown;
  position: { start: number; end: number };
  blockStartPosition?: { start: number; end: number };
  blockEndPosition?: { start: number; end: number };
  children?: Node[];
  attributes?: Node[];
  markup?: unknown;
}

export function allNodes(src: string): Node[] {
  const out: Node[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const x = n as Node;
    if (x.type && x.position) out.push(x);
    for (const k of ['children', 'attributes', 'markup', 'value']) {
      const c = (x as unknown as Record<string, unknown>)[k];
      if (Array.isArray(c)) c.forEach(walk);
    }
  };
  walk(toLiquidHtmlAST(src));
  return out;
}

const text = (src: string, n: Node) => src.slice(n.position.start, n.position.end);

/** Ranges no transform may touch. */
export function protectedRanges(src: string, file: string): Array<{ start: number; end: number; why: string }> {
  const out: Array<{ start: number; end: number; why: string }> = [];
  if (/checkout/i.test(file)) out.push({ start: 0, end: src.length, why: 'checkout is never touched' });
  for (const n of allNodes(src)) if (n.type === 'LiquidVariableOutput' && /\bcontent_for_header\b/.test(text(src, n))) out.push({ start: n.position.start, end: n.position.end, why: 'content_for_header is never modified, stripped or rewritten' });
  return out;
}

/** Applies non-overlapping edits from the end of the file backwards, refusing edits on protected ranges. */
export function applyEdits(src: string, file: string, edits: TextEdit[]): string {
  const prot = protectedRanges(src, file);
  for (const e of edits) {
    const hit = prot.find((p) => e.start < p.end && e.end > p.start);
    if (hit) throw new ProtectedEditError(`${file}: ${hit.why}`);
  }
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function liquidFiles(themeDir: string): string[] {
  const out: string[] = [];
  for (const d of ['layout', 'sections', 'snippets', 'blocks', 'templates']) {
    if (!existsSync(join(themeDir, d))) continue;
    for (const f of readdirSync(join(themeDir, d))) {
      if (!f.endsWith('.liquid')) continue;
      // a file the parser cannot read gets no edits at all (it is never rewritten blind)
      try {
        toLiquidHtmlAST(readFileSync(join(themeDir, d, f), 'utf8'));
      } catch {
        continue;
      }
      out.push(`${d}/${f}`);
    }
  }
  return out;
}

function change(themeDir: string, file: string, edits: TextEdit[]): FileChange | undefined {
  if (!edits.length) return undefined;
  const before = readFileSync(join(themeDir, file), 'utf8');
  return { file, before, after: applyEdits(before, file, edits) };
}

/** Writes a transform's changes and added files into the theme folder. */
export function writeTransform(themeDir: string, t: TransformResult): string[] {
  const files: string[] = [];
  for (const c of t.changes) {
    writeFileSync(join(themeDir, c.file), c.after);
    files.push(c.file);
  }
  for (const a of t.added) {
    writeFileSync(join(themeDir, a.file), a.data);
    files.push(a.file);
  }
  return files;
}

/** Edits that add `defer` to the script that loads `asset` (script_tag filter or a plain parser-blocking <script src>). */
function deferEdits(src: string, asset: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const n of allNodes(src)) {
    const t = text(src, n);
    if (n.type === 'LiquidVariableOutput' && t.includes(`'${asset}'`) && /\|\s*script_tag/.test(t)) {
      const expr = t.replace(/^\{\{-?\s*/, '').replace(/\s*-?\}\}$/, '').replace(/\|\s*script_tag\s*$/, '').trim();
      edits.push({ start: n.position.start, end: n.position.end, text: `<script src="{{ ${expr} }}" defer></script>` });
    }
    if (n.type === 'HtmlRawNode' && n.name === 'script') {
      const attrs = (n.attributes ?? []).map((a) => text(src, a));
      if (attrs.some((a) => a.startsWith('src=') && a.includes(asset)) && !attrs.some((a) => /^(defer|async)\b/.test(a) || /type=["']module/.test(a))) {
        const end = n.blockStartPosition!.end - 1; // before '>' of the start tag
        edits.push({ start: end, end, text: ' defer' });
      }
    }
  }
  return edits;
}

/** SHT-02, JS-01: defer a parser-blocking script the X-ray proved safe. */
export function deferScript(themeDir: string, asset: string): TransformResult | undefined {
  const changes = liquidFiles(themeDir).map((f) => change(themeDir, f, deferEdits(readFileSync(join(themeDir, f), 'utf8'), asset))).filter((c): c is FileChange => !!c);
  return changes.length ? { id: `defer-${asset}`, description: `Defer ${asset}`, checkIds: ['SHT-02', 'JS-01', 'DOC-05'], changes, added: [] } : undefined;
}

/**
 * SHT-02, SAFE-01: defer a library together with the inline scripts that call it at once, by running those inline
 * scripts on DOMContentLoaded (after deferred scripts). Only used when the X-ray shows nothing else reads what the
 * inline scripts define before DOMContentLoaded.
 */
export function deferWithInlineDependents(themeDir: string, asset: string, inlineContains: string[]): TransformResult | undefined {
  const changes: FileChange[] = [];
  for (const f of liquidFiles(themeDir)) {
    const src = readFileSync(join(themeDir, f), 'utf8');
    const edits = deferEdits(src, asset);
    if (!edits.length) continue;
    for (const n of allNodes(src)) {
      if (n.type !== 'HtmlRawNode' || n.name !== 'script' || (n.attributes ?? []).length) continue;
      const body = src.slice(n.blockStartPosition!.end, n.blockEndPosition!.start);
      if (!inlineContains.some((c) => body.includes(c))) continue;
      edits.push({ start: n.blockStartPosition!.end, end: n.blockEndPosition!.start, text: `\n      document.addEventListener('DOMContentLoaded', function () {${body.replace(/\s+$/, '')}\n      });\n    ` });
    }
    const c = change(themeDir, f, edits);
    if (c) changes.push(c);
  }
  return changes.length ? { id: `defer-${asset}-with-dependents`, description: `Defer ${asset} and run its inline dependents on DOMContentLoaded`, checkIds: ['SHT-02', 'JS-01', 'SAFE-01'], changes, added: [] } : undefined;
}

/**
 * SHT-06, SHT-07, IMG-01, IMG-03, IMG-06: the LCP image. The deprecated `img_url` branch becomes `image_url` plus
 * `image_tag` with widths, sizes, eager loading, fetchpriority high and preload; a theme-asset image gets
 * fetchpriority high, no lazy loading, its dimensions and a srcset of resized copies.
 */
export function lcpImage(themeDir: string, file: string, opts: { assetDims?: { width: number; height: number }; resized?: Array<{ file: string; width: number }>; sizes?: string } = {}): TransformResult | undefined {
  const src = readFileSync(join(themeDir, file), 'utf8');
  const edits: TextEdit[] = [];
  for (const n of allNodes(src)) {
    if (n.type !== 'HtmlVoidElement' || n.name !== 'img') continue;
    const attrs = (n.attributes ?? []).map((a) => ({ node: a, raw: text(src, a) }));
    const srcAttr = attrs.find((a) => a.raw.startsWith('src='));
    if (!srcAttr) continue;
    const m = /\{\{\s*([\w.]+)\s*\|\s*img_url:[^}]*\}\}/.exec(srcAttr.raw);
    const cls = attrs.find((a) => a.raw.startsWith('class='))?.raw.replace(/^class=["']|["']$/g, '') ?? '';
    const alt = attrs.find((a) => a.raw.startsWith('alt='))?.raw.match(/\{\{\s*(.+?)\s*\}\}/)?.[1] ?? "''";
    if (m) {
      edits.push({ start: n.position.start, end: n.position.end, text: `{{ ${m[1]} | image_url: width: 2400 | image_tag: loading: 'eager', fetchpriority: 'high', preload: true, widths: '400, 800, 1200, 1600, 2000, 2400', sizes: '${opts.sizes ?? '100vw'}', alt: ${alt.replace(/\s*\|\s*escape$/, '')}, class: '${cls}' }}` });
      continue;
    }
    if (/asset_url/.test(srcAttr.raw) && attrs.some((a) => /^loading=["']lazy/.test(a.raw))) {
      for (const a of attrs.filter((x) => /^(loading|fetchpriority|width|height|srcset|sizes|decoding)=/.test(x.raw))) edits.push({ start: a.node.position.start - 1, end: a.node.position.end, text: '' });
      const extra = [`fetchpriority="high"`, `decoding="async"`];
      if (opts.assetDims) extra.push(`width="${opts.assetDims.width}"`, `height="${opts.assetDims.height}"`);
      const assetName = /'([^']+)'\s*\|\s*asset_url/.exec(srcAttr.raw)?.[1];
      // copies of another image never go into this image's srcset
      if (opts.resized?.length && assetName && opts.resized.every((r) => r.file.startsWith(`${assetName.replace(/\.\w+$/, '')}-`))) {
        const set = opts.resized.map((r) => `{{ '${r.file}' | asset_url }} ${r.width}w`);
        if (opts.assetDims) set.push(`{{ '${assetName}' | asset_url }} ${opts.assetDims.width}w`);
        extra.push(`srcset="${set.join(', ')}"`, `sizes="${opts.sizes ?? '100vw'}"`);
      }
      edits.push({ start: srcAttr.node.position.end, end: srcAttr.node.position.end, text: ` ${extra.join(' ')}` });
    }
  }
  const c = change(themeDir, file, edits);
  return c ? { id: 'lcp-image', description: `LCP image in ${file}: image_tag with widths and sizes, eager, fetchpriority high, preload`, checkIds: ['SHT-06', 'SHT-07', 'IMG-01', 'IMG-03', 'IMG-06'], changes: [c], added: (opts.resized ?? []).map((r) => ({ file: `assets/${r.file}`, data: '' })) } : undefined;
}

/** FONT-01, FONT-02, FONT-09, SHT-08: replace an external Google Fonts link with self-hosted woff2 assets in a snippet. */
export function selfHostFonts(themeDir: string, fontCss: string, files: Array<{ name: string; data: Buffer }>, preload: string[]): TransformResult | undefined {
  const changes: FileChange[] = [];
  for (const f of liquidFiles(themeDir)) {
    const src = readFileSync(join(themeDir, f), 'utf8');
    const edits: TextEdit[] = [];
    for (const n of allNodes(src)) {
      if (n.type === 'HtmlVoidElement' && n.name === 'link' && /fonts\.googleapis\.com/.test(text(src, n))) edits.push({ start: n.position.start, end: n.position.end, text: `{% render 'speedpilot-fonts' %}` });
      if (n.type === 'HtmlVoidElement' && n.name === 'link' && /rel=["']preconnect["']/.test(text(src, n)) && /fonts\.(googleapis|gstatic)\.com/.test(text(src, n))) edits.push({ start: n.position.start, end: n.position.end, text: '' });
    }
    const c = change(themeDir, f, edits);
    if (c) changes.push(c);
  }
  if (!changes.length) return undefined;
  const css = fontCss.replace(/url\(([^)]+?)\/([^/)]+\.woff2)\)/g, (_m, _base, name: string) => `url({{ '${name}' | asset_url }})`);
  const snippet = `{%- comment -%} SpeedPilot: self-hosted fonts (used weights only, woff2, font-display swap). {%- endcomment -%}\n${preload.map((p) => `{{ '${p}' | asset_url | preload_tag: as: 'font', type: 'font/woff2', crossorigin: 'anonymous' }}`).join('\n')}\n<style>\n${css}\n</style>\n`;
  return { id: 'self-host-fonts', description: 'Self-host the theme fonts as woff2 assets with font-display swap and preloads', checkIds: ['FONT-01', 'FONT-02', 'FONT-03', 'FONT-04', 'FONT-09', 'SHT-08'], changes, added: [{ file: 'snippets/speedpilot-fonts.liquid', data: snippet }, ...files.map((x) => ({ file: `assets/${x.name}`, data: x.data }))] };
}

/**
 * SHT-09: a loop over a large collection that renders a few items, with nested loops over variants to find the lowest
 * price. Becomes a loop limited to what is shown, using `product.price_min` (one value instead of a variants x variants
 * scan).
 */
export function liquidMinPriceLoop(themeDir: string, file: string): TransformResult | undefined {
  const src = readFileSync(join(themeDir, file), 'utf8');
  const nodes = allNodes(src);
  const edits: TextEdit[] = [];
  for (const outer of nodes.filter((n) => n.type === 'LiquidTag' && n.name === 'for')) {
    const head = src.slice(outer.blockStartPosition!.start, outer.blockStartPosition!.end);
    const loopVar = /for\s+(\w+)\s+in\s+([\w.]+)/.exec(head);
    if (!loopVar) continue;
    const [, item] = loopVar;
    const inner = nodes.filter((n) => n.position.start > outer.blockStartPosition!.end && n.position.end < outer.blockEndPosition!.start);
    const assign = inner.find((n) => n.type === 'LiquidTag' && n.name === 'assign' && new RegExp(`=\\s*${item}\\.price\\b`).test(text(src, n)));
    const variantLoops = inner.filter((n) => n.type === 'LiquidTag' && n.name === 'for' && new RegExp(`in\\s+${item}\\.variants`).test(src.slice(n.blockStartPosition!.start, n.blockStartPosition!.end)));
    const top = variantLoops.filter((v) => !variantLoops.some((o) => o !== v && o.position.start < v.position.start && o.position.end > v.position.end));
    if (!assign || !top.length) continue;
    const name = /assign\s+(\w+)/.exec(text(src, assign))![1];
    const last = top[top.length - 1]!;
    edits.push({ start: assign.position.start, end: last.position.end, text: `{%- assign ${name} = ${item}.price_min -%}` });
    // limit the outer loop to the items it renders: {% if forloop.index <= N %} around the output
    const iff = inner.find((n) => n.type === 'LiquidTag' && n.name === 'if' && /forloop\.index\s*<=\s*([\w.]+)/.test(src.slice(n.blockStartPosition!.start, n.blockStartPosition!.end)));
    if (iff) {
      const n = /forloop\.index\s*<=\s*([\w.]+)/.exec(src.slice(iff.blockStartPosition!.start, iff.blockStartPosition!.end))![1];
      const newHead = /\blimit:\s*[\w.]+/.test(head) ? head.replace(/\blimit:\s*[\w.]+/, `limit: ${n}`) : head.replace(/\s*-?%\}$/, (m) => ` limit: ${n}${m}`);
      edits.push({ start: outer.blockStartPosition!.start, end: outer.blockStartPosition!.end, text: newHead });
      edits.push({ start: iff.blockStartPosition!.start, end: iff.blockStartPosition!.end, text: '' });
      edits.push({ start: iff.blockEndPosition!.start, end: iff.blockEndPosition!.end, text: '' });
    }
  }
  const c = change(themeDir, file, edits);
  return c ? { id: 'liquid-min-price-loop', description: `${file}: loop only over the products shown and use price_min instead of nested variant loops`, checkIds: ['SHT-09'], changes: [c], added: [] } : undefined;
}

/** SHA-03, SHA-02: stop rendering a leftover app snippet and switch off its app embed. The snippet file is kept (quarantine; deleted later only with an approval line). */
export function removeLeftoverApp(themeDir: string, snippet: string, embedBlockId?: string): TransformResult | undefined {
  const changes: FileChange[] = [];
  for (const f of liquidFiles(themeDir)) {
    const src = readFileSync(join(themeDir, f), 'utf8');
    const edits = allNodes(src).filter((n) => n.type === 'LiquidTag' && (n.name === 'render' || n.name === 'include') && text(src, n).includes(`'${snippet}'`)).map((n) => ({ start: n.position.start, end: n.position.end, text: '' }));
    const c = change(themeDir, f, edits);
    if (c) changes.push(c);
  }
  const settingsFile = 'config/settings_data.json';
  if (embedBlockId && existsSync(join(themeDir, settingsFile))) {
    const before = readFileSync(join(themeDir, settingsFile), 'utf8');
    const j = JSON.parse(before.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as { current?: { blocks?: Record<string, { disabled?: boolean }> } };
    const block = j.current?.blocks?.[embedBlockId];
    if (block && !block.disabled) {
      block.disabled = true;
      changes.push({ file: settingsFile, before, after: JSON.stringify(j, null, 2) + '\n' });
    }
  }
  return changes.length ? { id: `remove-leftover-${snippet}`, description: `Stop rendering the leftover snippet ${snippet}${embedBlockId ? ` and disable app embed ${embedBlockId}` : ''}`, checkIds: ['SHA-03', 'SHA-02', 'NET-10'], changes, added: [] } : undefined;
}

const DELAY_LOADER = `{%- comment -%} SpeedPilot: loads delayed third-party scripts on the first interaction. {%- endcomment -%}
<script>(function(){var evs=['pointerdown','keydown','touchstart','scroll'];function go(){evs.forEach(function(e){removeEventListener(e,go,{passive:true});});document.querySelectorAll('script[type="text/speedpilot-delayed"]').forEach(function(o){var s=document.createElement('script');for(var i=0;i < o.attributes.length;i++){var a=o.attributes[i];if(a.name!=='type')s.setAttribute(a.name,a.value);}s.async=false;o.parentNode.replaceChild(s,o);});}evs.forEach(function(e){addEventListener(e,go,{passive:true});});})();</script>
`;

/** 3P-01, 3P-04, SHA-01: load a third-party script on the first interaction (needs an X-ray `safe` verdict for delay). */
export function delayThirdParty(themeDir: string, srcContains: string): TransformResult | undefined {
  const changes: FileChange[] = [];
  for (const f of liquidFiles(themeDir)) {
    const src = readFileSync(join(themeDir, f), 'utf8');
    const edits: TextEdit[] = [];
    const nodes = allNodes(src);
    for (const n of nodes) {
      if (n.type !== 'HtmlRawNode' || n.name !== 'script') continue;
      const attrs = (n.attributes ?? []).map((a) => text(src, a));
      if (!attrs.some((a) => a.startsWith('src=') && a.includes(srcContains))) continue;
      if (attrs.some((a) => a.includes('text/speedpilot-delayed'))) continue;
      const at = n.blockStartPosition!.start + '<script'.length;
      edits.push({ start: at, end: at, text: ' type="text/speedpilot-delayed"' });
    }
    if (!edits.length) continue;
    const body = nodes.find((n) => n.type === 'HtmlElement' && n.blockEndPosition && src.slice(n.blockEndPosition.start, n.blockEndPosition.end) === '</body>');
    if (body && !src.includes("render 'speedpilot-delay'")) edits.push({ start: body.blockEndPosition!.start, end: body.blockEndPosition!.start, text: `{% render 'speedpilot-delay' %}\n  ` });
    const c = change(themeDir, f, edits);
    if (c) changes.push(c);
  }
  return changes.length ? { id: `delay-${srcContains.replace(/[^a-z0-9]+/gi, '-')}`, description: `Load ${srcContains} on the first interaction`, checkIds: ['3P-01', '3P-04', 'SHA-01'], changes, added: existsSync(join(themeDir, 'snippets/speedpilot-delay.liquid')) ? [] : [{ file: 'snippets/speedpilot-delay.liquid', data: DELAY_LOADER }] } : undefined;
}

/** SHT speculation rules (SPEC.md 8.2): moderate prefetch for product and collection links with strict exclusions. */
export function speculationRules(themeDir: string, layout = 'layout/theme.liquid', platformHeader?: string | null): TransformResult | undefined {
  const src = readFileSync(join(themeDir, layout), 'utf8');
  if (src.includes("render 'speedpilot-speculation'")) return undefined;
  const head = allNodes(src).find((n) => n.type === 'HtmlElement' && n.blockEndPosition && src.slice(n.blockEndPosition.start, n.blockEndPosition.end) === '</head>');
  if (!head) return undefined;
  const rules = {
    prefetch: [{ source: 'document', where: { and: [{ href_matches: ['/products/*', '/collections/*', '/*/products/*', '/*/collections/*'] }, { not: { href_matches: ['/cart*', '/checkout*', '/account*', '/*/cart*', '/*/checkout*', '/*/account*', '/*\\?*'] } }, { not: { selector_matches: '[rel~=nofollow], .no-prefetch' } }] }, eagerness: 'moderate' }],
  };
  const snippet = `{%- comment -%} SpeedPilot: theme speculation rules on top of Shopify's platform header${platformHeader ? ` (${platformHeader})` : ''}. Prefetch only, strict exclusions. {%- endcomment -%}\n<script type="speculationrules">\n${JSON.stringify(rules, null, 2)}\n</script>\n`;
  const c = change(themeDir, layout, [{ start: head.blockEndPosition!.start, end: head.blockEndPosition!.start, text: `{% render 'speedpilot-speculation' %}\n  ` }]);
  return c ? { id: 'speculation-rules', description: 'Speculation rules: moderate prefetch for product and collection links, cart, checkout, account and query URLs excluded', checkIds: ['SHT-20'], changes: [c], added: [{ file: 'snippets/speedpilot-speculation.liquid', data: snippet }] } : undefined;
}

/** SHT-21: flatten group blocks that wrap a single block and have no settings of their own (template JSON). */
export function flattenGroups(themeDir: string, template: string): TransformResult | undefined {
  const before = readFileSync(join(themeDir, template), 'utf8');
  const j = JSON.parse(before.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as { sections: Record<string, { blocks?: Record<string, Block>; block_order?: string[] }> };
  type Block = { type: string; settings?: Record<string, unknown>; blocks?: Record<string, Block>; block_order?: string[] };
  let changed = 0;
  const flatten = (holder: { blocks?: Record<string, Block>; block_order?: string[] }) => {
    if (!holder.blocks) return;
    for (const id of [...(holder.block_order ?? Object.keys(holder.blocks))]) {
      let b = holder.blocks[id]!;
      // a group with exactly one child group and no settings: lift the child's blocks into it
      while (b.type === 'group' && !Object.keys(b.settings ?? {}).length && b.block_order?.length === 1 && b.blocks?.[b.block_order[0]!]?.type === 'group') {
        const child = b.blocks[b.block_order[0]!]!;
        holder.blocks[id] = { ...child, settings: { ...(child.settings ?? {}) } };
        b = holder.blocks[id]!;
        changed++;
      }
      flatten(b);
    }
  };
  for (const s of Object.values(j.sections)) flatten(s);
  if (!changed) return undefined;
  return { id: 'flatten-groups', description: `${template}: ${changed} redundant group wrapper(s) removed`, checkIds: ['SHT-21'], changes: [{ file: template, before, after: JSON.stringify(j, null, 2) + '\n' }], added: [] };
}
