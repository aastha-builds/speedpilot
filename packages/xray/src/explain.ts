/**
 * `speedpilot xray explain <site> <script-url | handle | selector>`: everything the Site Model knows about one script or
 * element, with a plain-language explanation of every verdict (SPEC.md 15.9). Answers stay small (under 20 KB) and point
 * to evidence paths instead of dumping raw data.
 */
import type { ModelNode } from './model.js';
import { isSafe, type Verdict, type VerdictContext, type ChangeType } from './analysis/verdicts.js';
import { matchRecipe } from './recipes.js';

export interface Explanation {
  ref: string;
  kind: 'script' | 'element' | 'owner' | 'not-found';
  node?: { id: string; label: string; owner?: string; loading?: unknown; bytes?: unknown; handle?: unknown };
  defines: string[];
  dependsOn: Array<{ target: string; evidence: string }>;
  neededBy: Array<{ user: string; evidence: string }>;
  handlers: Array<{ fn: string; type: string; selector: string; at: string }>;
  initiates: string[];
  recipe?: string;
  verdicts: Verdict[];
  text: string;
  evidence: string[];
}

const label = (n: ModelNode | undefined, id: string) => (n ? (n.data.handle ? `${n.data.handle} (${String(n.data.url).split('?')[0]})` : n.label) : id);

export function explain(ctx: VerdictContext, ref: string, evidenceDir?: string): Explanation {
  const m = ctx.model;
  const script = ctx.scripts.find((s) => s.handle === ref) ?? ctx.scripts.find((s) => !s.script.inline && s.script.url.includes(ref)) ?? ctx.scripts.find((s) => s.script.inline && s.script.elementId === ref);
  const evidence = evidenceDir ? [`${evidenceDir}/xray/site-model.json`, `${evidenceDir}/xray/captures.json`] : [];
  if (script) {
    const n = m.nodes.get(script.id)!;
    const defines = m.out(script.id, 'defines').filter((e) => e.dst.startsWith('global:')).map((e) => e.dst.slice(7));
    const dependsOn = m.out(script.id, 'depends-on').map((e) => ({ target: label(m.nodes.get(e.dst), e.dst), evidence: `${e.evidence}${e.data?.global ? `, reads ${e.data.global}` : ''}${e.data?.via ? `, ${e.data.via}` : ''}` }));
    const neededBy = m.in(script.id, 'depends-on').map((e) => ({ user: label(m.nodes.get(e.src), e.src), evidence: `${e.evidence}${e.data?.immediate ? ', at once' : ''}${e.data?.global ? `, reads ${e.data.global}` : ''}${e.data?.via ? `, ${e.data.via}` : ''}` }));
    const handlers = m.out(script.id, 'defines').filter((e) => e.dst.startsWith('handler:')).map((e) => m.nodes.get(e.dst)!).filter(Boolean).map((h) => ({ fn: String(h.data.function), type: String(h.data.type), selector: String(h.data.selector), at: `${h.data.url}:${h.data.line}` }));
    const initiates = m.out(script.id, 'initiates').map((e) => m.nodes.get(e.dst)?.label ?? e.dst).slice(0, 20);
    const recipe = matchRecipe(ctx.recipes, ctx.platform, { url: script.script.url, handle: script.handle, defines })?.recipe;
    const types: ChangeType[] = script.script.inline ? [] : ['defer', 'async', 'delay', 'remove'];
    const verdicts = types.map((t) => isSafe(ctx, { type: t, target: script.handle ?? script.script.url.split('?')[0]! }));
    const name = label(n, script.id);
    const lines = [
      `${name}`,
      `Owner: ${n.owner ?? 'unknown'}. Loads as: ${script.script.loading ?? 'unknown'}. Size: ${Math.round(Number(n.data.bytes ?? 0) / 1024)} KB.${recipe ? ` Recipe: ${recipe.name} (${recipe.id}, confidence ${recipe.confidence}).` : ' No recipe (REV-01).'}`,
      defines.length ? `Defines: ${defines.slice(0, 12).join(', ')}.` : 'Defines no globals that were seen.',
      neededBy.length ? `Needed by:\n${neededBy.slice(0, 15).map((d) => `  - ${d.user} (${d.evidence})`).join('\n')}` : 'Nothing on the captured pages needs it.',
      dependsOn.length ? `Needs:\n${dependsOn.slice(0, 15).map((d) => `  - ${d.target} (${d.evidence})`).join('\n')}` : '',
      handlers.length ? `Handles interactions:\n${handlers.slice(0, 10).map((h) => `  - ${h.type} on ${h.selector}: ${h.fn} (${h.at})`).join('\n')}` : '',
      'Verdicts:',
      ...verdicts.map((v) => `  - ${v.change}: ${v.verdict.toUpperCase()}. ${v.explanation}`),
    ].filter(Boolean);
    return { ref, kind: 'script', node: { id: n.id, label: n.label, owner: n.owner, loading: script.script.loading, bytes: n.data.bytes, handle: n.data.handle }, defines, dependsOn, neededBy, handlers, initiates, recipe: recipe?.id, verdicts, text: lines.join('\n').slice(0, 18000), evidence };
  }
  // an element: listeners and inline handler attributes on it
  const els = [...m.nodes.values()].filter((x) => x.type === 'element' && (x.label === ref || x.label.includes(ref)));
  if (els.length) {
    const handlers = els.flatMap((el) => m.in(el.id, 'listens').map((e) => m.nodes.get(e.src)!).filter(Boolean)).map((h) => ({ fn: String(h.data.function), type: String(h.data.type), selector: String(h.data.selector), at: `${h.data.url}:${h.data.line}` }));
    const uses = els.flatMap((el) => m.out(el.id, 'uses').map((e) => e.dst.slice(7)));
    const touchedBy = [...new Set(els.flatMap((el) => m.in(el.id, 'touches').map((e) => label(m.nodes.get(e.src), e.src))))];
    const text = [`Element ${ref}`, handlers.length ? `Listeners:\n${handlers.map((h) => `  - ${h.type}: ${h.fn} (${h.at})`).join('\n')}` : 'No attached listeners were seen.', uses.length ? `Inline handler attributes read: ${[...new Set(uses)].join(', ')}.` : '', touchedBy.length ? `Scripts that select it: ${touchedBy.slice(0, 10).join(', ')}.` : ''].filter(Boolean).join('\n');
    return { ref, kind: 'element', defines: [], dependsOn: [], neededBy: [], handlers, initiates: [], verdicts: [], text, evidence };
  }
  const owner = m.nodes.get(ref);
  if (owner && ['plugin', 'theme', 'app', 'third-party', 'platform', 'core'].includes(owner.type)) {
    const own = ctx.scripts.filter((s) => s.script.owner.id === ref && !s.script.inline);
    const text = `Owner ${ref}: ${own.length} script(s): ${[...new Set(own.map((s) => s.handle ?? s.script.url))].slice(0, 15).join(', ')}.`;
    return { ref, kind: 'owner', defines: [], dependsOn: [], neededBy: [], handlers: [], initiates: [], verdicts: [], text, evidence };
  }
  return { ref, kind: 'not-found', defines: [], dependsOn: [], neededBy: [], handlers: [], initiates: [], verdicts: [], text: `"${ref}" was not found in the Site Model (no script, element or owner with that name on the captured pages).`, evidence };
}
