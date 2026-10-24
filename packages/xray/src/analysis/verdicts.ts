/**
 * Safe-change verdicts (SPEC.md 15.5): for each script on each template, `safe`, `unsafe` or `unknown` for defer, async,
 * delay until interaction, load only on some templates, and remove. The proof is the inline scripts, other scripts,
 * attached listeners and inline handler attributes that need it. Anything the engine cannot prove is `unknown`, and
 * `unknown` is never touched (CLAUDE.md, REV-01). A wrong `safe` is the one mistake this module must never make.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as acorn from 'acorn';
import * as cheerio from 'cheerio';
import { matchBeacon, classify } from '@speedpilot/core';
import type { SiteModel, ModelEdge } from '../model.js';
import type { ScriptInfo } from '../build.js';
import type { XrayCapture } from '../capture/cdp.js';
import { matchRecipe, type Recipe } from '../recipes.js';

export type ChangeType = 'defer' | 'async' | 'delay' | 'remove' | 'remove-template';
export type VerdictValue = 'safe' | 'unsafe' | 'unknown';

export interface Change {
  type: ChangeType;
  target: string;
  template?: string;
}

export interface VerdictReason {
  severity: 'unsafe' | 'unknown' | 'ok';
  kind: string;
  detail: string;
  evidence: string;
  page?: string;
}

export interface Verdict {
  change: string;
  verdict: VerdictValue;
  target: string;
  owner?: string;
  recipe?: string;
  pages: string[];
  reasons: VerdictReason[];
  confidence: number;
  explanation: string;
}

export interface VerdictContext {
  platform: 'wordpress' | 'shopify';
  model: SiteModel;
  scripts: ScriptInfo[];
  captures: XrayCapture[];
  recipes: Recipe[];
}

const CHANGE_TYPES: ChangeType[] = ['defer', 'async', 'delay', 'remove-template', 'remove'];

/** Parses `defer:jquery-core`, `remove-template:contact-form-7@home` or `remove-template:x` with a template option. */
export function parseChange(s: string, template?: string): Change {
  const i = s.indexOf(':');
  const type = s.slice(0, i) as ChangeType;
  if (i < 0 || !CHANGE_TYPES.includes(type)) throw new Error(`Unknown change "${s}". Use <type>:<target> with type one of ${CHANGE_TYPES.join(', ')}.`);
  let target = s.slice(i + 1);
  let tpl = template;
  if (type === 'remove-template' && target.includes('@')) {
    tpl = target.slice(target.lastIndexOf('@') + 1);
    target = target.slice(0, target.lastIndexOf('@'));
  }
  if (type === 'remove-template' && !tpl) throw new Error('remove-template needs a template: remove-template:<target>@<template> or --template.');
  return { type, target, template: tpl };
}

export function changeKey(c: Change): string {
  return `${c.type}:${c.target}${c.type === 'remove-template' ? `@${c.template}` : ''}`;
}

function matches(s: ScriptInfo, target: string): boolean {
  if (s.handle === target) return true;
  if (s.script.inline) return s.script.elementId === target;
  return s.script.url.includes(target);
}

const BEFORE_DCL = new Set(['blocking', 'inline', 'injected', 'async']);
const GLOBAL_DYNAMIC = ['eval', 'new Function', 'string timer (eval)', 'with statement', 'dynamic global access (window[expr])', 'unparseable'];
const ANALYTICS_URL = /gtag|analytics|googletagmanager|gtm\.js|fbevents|pixel|clarity\.ms|hotjar|segment\.(com|io)|plausible|matomo|tiktok.*events|connect\.facebook/i;
const ANALYTICS_CATEGORIES = ['analytics', 'ad', 'tag-manager', 'consent-provider', 'marketing'];
const GENERIC_SELECTOR = /^(html|body|head|document|window|\*|:root|a|div|span|p|img|form|input|button|script|link|meta|ul|li|\[required\])$/i;

const srcCache = new Map<string, string>();
function source(s: ScriptInfo): string {
  const p = s.script.sourcePath;
  if (!srcCache.has(p)) srcCache.set(p, existsSync(p) ? readFileSync(p, 'utf8') : '');
  return srcCache.get(p)!;
}

/** All string literals in a script joined together: catches names built from parts ('jQ' + 'uery') in eval-like code. */
function literalText(src: string): string {
  let out = '';
  try {
    for (const t of acorn.tokenizer(src, { ecmaVersion: 'latest', allowHashBang: true })) if (t.type === acorn.tokTypes.string || t.type === acorn.tokTypes.template) out += String((t as unknown as { value: unknown }).value);
  } catch {
    return src;
  }
  return out.replace(/\s+/g, '');
}

const domCache = new Map<string, cheerio.CheerioAPI | null>();
function dom(cap: XrayCapture): cheerio.CheerioAPI | null {
  const p = cap.domPath;
  if (!p) return null;
  if (!domCache.has(p)) domCache.set(p, existsSync(p) ? cheerio.load(readFileSync(p, 'utf8')) : null);
  return domCache.get(p)!;
}

function selectorPresent($: cheerio.CheerioAPI, sel: string): boolean {
  try {
    return $(sel).length > 0;
  } catch {
    return false;
  }
}

function isAnalytics(ctx: VerdictContext, t: ScriptInfo, recipe?: Recipe): string | undefined {
  if (recipe && (recipe.category === 'analytics' || recipe.neverDelay)) return `recipe ${recipe.id} (${recipe.category})`;
  if (recipe?.trackingHandles?.includes(t.handle ?? '')) return `recipe ${recipe.id} lists ${t.handle} as tracking`;
  if (t.script.owner.category && ANALYTICS_CATEGORIES.includes(t.script.owner.category)) return `owner category ${t.script.owner.category}`;
  if (!t.script.inline && ANALYTICS_URL.test(t.script.url)) return `analytics tag URL ${t.script.url}`;
  const beacon = ctx.model.out(t.id, 'initiates').map((e) => ctx.model.nodes.get(e.dst)?.label ?? '').find((u) => matchBeacon(u));
  if (beacon) return `sends analytics beacons (${beacon.slice(0, 80)})`;
  if (t.facts.endpoints.some((e) => /\/collect\b|\/g\/collect|\/tr\?|\/events?\b/.test(e))) return 'calls a collect endpoint';
  return undefined;
}

function globalsDefinedBy(ctx: VerdictContext, t: ScriptInfo): string[] {
  const g = new Set<string>([...t.facts.definesGlobals, ...t.facts.registersJqPlugins.map((p) => `jQuery.fn.${p}`)]);
  for (const e of ctx.model.out(t.id, 'defines')) if (e.dst.startsWith('global:')) g.add(e.dst.slice(7));
  return [...g];
}

/** Scripts initiated by the target itself (its own loader chain) are part of it, not dependents. */
function childrenOf(ctx: VerdictContext, t: ScriptInfo): Set<string> {
  const out = new Set<string>();
  for (const e of ctx.model.out(t.id, 'initiates')) out.add(e.dst.replace(/^request:/, 'script:'));
  return out;
}

interface Dependent {
  user: ScriptInfo;
  edge: ModelEdge;
}

function dependentsOnPage(ctx: VerdictContext, t: ScriptInfo, pageScripts: ScriptInfo[]): Dependent[] {
  const kids = childrenOf(ctx, t);
  const out: Dependent[] = [];
  for (const u of pageScripts) {
    if (u === t || u.id === t.id || kids.has(u.id)) continue;
    for (const e of ctx.model.out(u.id, 'depends-on')) if (e.dst === t.id && e.evidence !== 'rea') out.push({ user: u, edge: e });
  }
  return out;
}

function describe(s: ScriptInfo): string {
  if (s.script.inline) return `inline script${s.script.elementId ? ` #${s.script.elementId}` : ''} ("${source(s).trim().slice(0, 50).replace(/\s+/g, ' ')}")`;
  return s.handle ? `${s.handle} (${s.script.url.split('?')[0]})` : s.script.url.split('?')[0]!;
}

function edgeEvidence(e: ModelEdge): string {
  const d = e.data ?? {};
  return `${e.evidence} edge, confidence ${e.confidence}${d.global ? `, reads ${d.global}` : ''}${d.via ? `, ${d.via}` : ''}`;
}

/** A dependency must be met before the dependent's own top-level code runs. */
function earlyDependency(d: Dependent): boolean {
  return d.edge.evidence === 'agent' || d.edge.data?.immediate === true || d.user.facts.dynamic || d.edge.evidence === 'runtime';
}

/** Other scripts whose dynamic code could read the target's globals without naming them. */
function dynamicReaders(t: ScriptInfo, pageScripts: ScriptInfo[], globals: string[], onlyAfter: boolean): Array<{ s: ScriptInfo; reason: string }> {
  if (!globals.length) return [];
  const out: Array<{ s: ScriptInfo; reason: string }> = [];
  for (const s of pageScripts) {
    if (s.id === t.id) continue;
    if (onlyAfter && (s.script.order < t.script.order || !BEFORE_DCL.has(s.script.loading ?? 'blocking'))) continue;
    const reasons = s.facts.dynamicReasons.filter((r) => GLOBAL_DYNAMIC.includes(r));
    if (!reasons.length) continue;
    if (reasons.some((r) => r === 'dynamic global access (window[expr])' || r === 'with statement' || r === 'unparseable')) {
      out.push({ s, reason: reasons.join(', ') });
      continue;
    }
    // eval, new Function, string timers: the code strings are in the literals
    const lit = literalText(source(s));
    const hit = globals.find((g) => lit.includes(g.split('.')[0]!));
    if (hit) out.push({ s, reason: `${reasons.join(', ')} with code naming ${hit}` });
  }
  return out;
}

function inlineHandlerUsers(ctx: VerdictContext, globals: string[], page: string): Array<{ el: string; global: string; attr: string }> {
  const out: Array<{ el: string; global: string; attr: string }> = [];
  for (const g of globals) {
    for (const e of ctx.model.in(`global:${g}`, 'uses')) {
      if (!e.src.startsWith(`element:${page}|`)) continue;
      out.push({ el: ctx.model.nodes.get(e.src)?.label ?? e.src, global: g, attr: String(e.data?.inlineHandler ?? 'on*') });
    }
  }
  return out;
}

function interactionCalls(cap: XrayCapture, t: ScriptInfo): number {
  let n = 0;
  for (const st of cap.coverage.filter((c) => c.state.startsWith('interaction:'))) {
    for (const f of st.js.filter((x) => x.scriptId === t.script.scriptId || (!t.script.inline && x.url === t.script.url))) n += f.functions.filter((fn) => fn.name !== '').reduce((a, fn) => a + fn.count, 0);
  }
  return n;
}

function pageChecks(ctx: VerdictContext, c: Change, t: ScriptInfo, cap: XrayCapture, pageScripts: ScriptInfo[], recipe: Recipe | undefined): VerdictReason[] {
  const r: VerdictReason[] = [];
  const page = cap.url;
  const add = (severity: VerdictReason['severity'], kind: string, detail: string, evidence: string) => r.push({ severity, kind, detail, evidence, page });
  const owner = t.script.owner;
  if (owner.kind === 'platform' || owner.id.startsWith('platform:')) add('unsafe', 'platform', `${describe(t)} belongs to the platform (${owner.id}); Shopify content_for_header and platform scripts are never touched (CLAUDE.md rule 7)`, `owner ${owner.id} via ${owner.via}`);
  const globals = globalsDefinedBy(ctx, t);
  const deps = dependentsOnPage(ctx, t, pageScripts);
  if (globals.length) {
    for (const w of pageScripts.filter((x) => x.id !== t.id && x.facts.documentWrite && BEFORE_DCL.has(x.script.loading ?? 'blocking'))) add('unknown', 'document-write', `${describe(w)} writes markup with document.write; what it writes can use ${globals.slice(0, 3).join(', ')}`, 'static: document.write call');
  }
  const handlers = inlineHandlerUsers(ctx, globals, page);
  const loading = t.script.loading ?? 'blocking';
  const injector = t.script.inline ? undefined : ctx.model.in(`request:${t.script.url}`, 'initiates').find((e) => e.src.startsWith('script:') && e.src !== t.id);
  if ((injector || t.script.injectedBy?.length) && loading !== 'blocking' && loading !== 'defer') add('unknown', 'injected', `${describe(t)} is loaded at run time by ${injector ? ctx.model.nodes.get(injector.src)?.label ?? injector.src : 'other code'}; changing it means changing its loader`, injector ? 'runtime: request initiator' : 'runtime: injection stack');

  if (c.type === 'defer' || c.type === 'async') {
    if (t.script.inline) add('unknown', 'inline', `${describe(t)} is inline; ${c.type} only applies to external scripts`, 'script element has no src');
    if (loading === 'injected' && !injector) add('unknown', 'injected', `${describe(t)} is injected by other code at run time, so ${c.type} cannot be applied to it`, `injected by ${t.script.injectedBy?.[0] ?? 'script'}`);
    if (t.facts.documentWrite) add('unsafe', 'document-write', `${describe(t)} calls document.write, which is ignored in ${c.type} scripts`, 'static: document.write call');
    if (c.type === 'async' && t.facts.waitsForDomReady && !t.facts.readsReadyState && loading !== 'async') add('unsafe', 'missed-event', `${describe(t)} waits for DOMContentLoaded; an async script can run after it fired and never start`, 'static: DOMContentLoaded listener without a readyState check');
    if (loading === (c.type === 'defer' ? 'defer' : 'async')) add('ok', 'already', `${describe(t)} already loads with ${c.type}`, `loading ${loading}`);
    for (const d of deps) {
      const ul = d.user.script.loading ?? 'blocking';
      if (c.type === 'async') {
        add('unsafe', 'dependent', `${describe(d.user)} needs ${describe(t)}; async does not keep execution order`, edgeEvidence(d.edge));
        continue;
      }
      if ((ul === 'defer' || ul === 'module') && docIndex(cap, d.user) > docIndex(cap, t)) {
        add('ok', 'dependent-deferred', `${describe(d.user)} is deferred after it, so order is kept`, edgeEvidence(d.edge));
      } else if (ul === 'async') {
        add('unknown', 'dependent-async', `${describe(d.user)} is async and already races ${describe(t)}`, edgeEvidence(d.edge));
      } else if (earlyDependency(d)) {
        add('unsafe', 'dependent', `${describe(d.user)} uses ${describe(t)} as soon as it runs, before DOMContentLoaded`, edgeEvidence(d.edge));
      } else if ((d.user.facts.waitsForDomReady || d.user.facts.waitsForLoad) && d.user.facts.timers.setTimeout + d.user.facts.timers.setInterval === 0) {
        add('ok', 'dependent-later', `${describe(d.user)} only uses it after DOMContentLoaded`, edgeEvidence(d.edge));
      } else {
        add('unknown', 'dependent-timing', `${describe(d.user)} uses it and the engine cannot prove when`, edgeEvidence(d.edge));
      }
    }
    if (c.type === 'async') {
      const kids = childrenOf(ctx, t);
      for (const e of ctx.model.out(t.id, 'depends-on')) {
        const d = pageScripts.find((s) => s.id === e.dst);
        if (!d || kids.has(d.id)) continue;
        if (!((d.script.loading ?? 'blocking') === 'blocking' && d.script.order < t.script.order)) add('unknown', 'needs-other', `${describe(t)} needs ${describe(d)}, which async would no longer wait for`, edgeEvidence(e));
      }
    }
    for (const h of handlers) add(c.type === 'async' ? 'unsafe' : 'unknown', 'inline-handler', `${h.el} has an ${h.attr} attribute that calls ${h.global}; a click before the script runs would fail`, 'static: inline handler attribute');
    for (const x of dynamicReaders(t, pageScripts, globals, true)) add('unknown', 'dynamic', `${describe(x.s)} runs code the engine cannot read (${x.reason}) and may use ${globals.slice(0, 3).join(', ')}`, 'static: dynamic code');
    if (recipe?.knownBreakages.some((b) => new RegExp(`\\b${c.type}`, 'i').test(b)) && !r.some((x) => x.severity === 'unsafe')) add('unknown', 'recipe', `recipe ${recipe.id} lists a known breakage: ${recipe.knownBreakages.find((b) => new RegExp(`\\b${c.type}`, 'i').test(b))}`, `recipe ${recipe.id}`);
  }

  if (c.type === 'delay' || c.type === 'remove' || c.type === 'remove-template') {
    const analytics = isAnalytics(ctx, t, recipe);
    if (analytics) add('unsafe', 'analytics', `${describe(t)} is a tracking tag (${analytics}); ${c.type === 'delay' ? 'delaying it loses page_view and conversion events (SAFE-02)' : 'removing it breaks tracking (rule 6)'}`, analytics);
    if (c.type === 'delay' && recipe?.neverDelay && !analytics) add('unsafe', 'recipe', `recipe ${recipe.id} says never delay: ${recipe.knownBreakages[0] ?? ''}`, `recipe ${recipe.id}`);
    if (t.facts.documentWrite) add('unsafe', 'document-write', `${describe(t)} calls document.write`, 'static: document.write call');
    for (const d of deps) add('unsafe', 'dependent', `${describe(d.user)} needs ${describe(t)}`, edgeEvidence(d.edge));
    for (const h of handlers) add('unsafe', 'inline-handler', `${h.el} has an ${h.attr} attribute that calls ${h.global}`, 'static: inline handler attribute');
    const lcpReq = cap.lcp?.url ? `request:${cap.lcp.url}` : undefined;
    if (lcpReq && ctx.model.out(t.id, 'initiates').some((e) => e.dst === lcpReq)) add('unsafe', 'lcp', `${describe(t)} loads the LCP element (${cap.lcp!.url})`, 'runtime: request initiator');
    for (const x of dynamicReaders(t, pageScripts, globals, false)) add('unknown', 'dynamic', `${describe(x.s)} runs code the engine cannot read (${x.reason})`, 'static: dynamic code');
  }

  if (c.type === 'delay') {
    if ((t.facts.waitsForDomReady || t.facts.waitsForLoad) && !t.facts.readsReadyState) add('unsafe', 'missed-event', `${describe(t)} waits for DOMContentLoaded or load, which will have fired before a delayed script runs`, 'static: lifecycle listener without a readyState check');
    const thirdParty = owner.kind === 'third-party' || (owner.kind === 'app' && recipe?.delayable);
    if (!thirdParty && !recipe?.delayable) add('unknown', 'first-party', `${describe(t)} is first-party code (${owner.id}); delaying it until interaction needs a recipe that marks it delayable`, `owner ${owner.id}`);
  }

  if (c.type === 'remove' || c.type === 'remove-template') {
    const $ = dom(cap);
    const ownListeners = ctx.model.out(t.id, 'defines').filter((e) => e.dst.startsWith('handler:')).map((e) => ctx.model.nodes.get(e.dst)!).filter(Boolean);
    const markers = recipe?.needs.markers ?? [];
    const markersHere = $ ? markers.filter((m) => selectorPresent($, m)) : [];
    if (c.type === 'remove-template' && markers.length) {
      if (!$) add('unknown', 'dom', 'the rendered page was not captured', 'no DOM snapshot');
      else if (markersHere.length) add('unsafe', 'marker', `this page has ${markersHere.join(', ')}, which ${recipe!.name} needs`, `recipe ${recipe!.id} markers, DOM snapshot`);
      else add('ok', 'marker', `no ${markers.join(' or ')} on this page`, `recipe ${recipe!.id} markers, DOM snapshot`);
      for (const l of ownListeners) {
        const sel = String(l.data.selector);
        if (sel !== 'window' && sel !== 'document') add('unsafe', 'listener', `it handles ${l.data.type} on ${sel} (${l.data.function})`, `runtime listener ${l.data.url}:${l.data.line}`);
      }
    } else {
      for (const l of ownListeners) add('unsafe', 'listener', `it handles ${l.data.type} on ${l.data.selector} (${l.data.function})`, `runtime listener ${l.data.url}:${l.data.line}`);
      const touched = $ ? t.facts.selectors.filter((s) => !GENERIC_SELECTOR.test(s.trim()) && selectorPresent($, s)) : [];
      if (!$ && t.facts.selectors.length) add('unknown', 'dom', 'the rendered page was not captured', 'no DOM snapshot');
      if (touched.length) add('unknown', 'dom', `it works on elements present on this page (${touched.slice(0, 3).join(', ')})`, 'static selectors matched in the DOM snapshot');
      if (c.type === 'remove' && markers.length && recipe!.kind !== 'library') add('unknown', 'per-template', `${recipe!.name} is needed on pages with ${markers.join(' or ')}; the captured pages are only a sample, so remove it per template instead`, `recipe ${recipe!.id}`);
      if (c.type === 'remove-template' && !t.facts.selectors.length && !ownListeners.length && !markers.length) add('unknown', 'no-recipe', `no recipe and no selectors tell which pages need ${describe(t)}`, 'no recipe');
    }
    const calls = interactionCalls(cap, t);
    if (calls > 0) add('unsafe', 'coverage', `${calls} of its functions ran during interactions`, 'runtime: function coverage per interaction state');
    const kids = ctx.model.out(t.id, 'initiates').filter((e) => !matchBeacon(ctx.model.nodes.get(e.dst)?.label ?? ''));
    if (kids.length && c.type === 'remove') add('unknown', 'initiates', `it loads ${kids.length} more resource(s), for example ${ctx.model.nodes.get(kids[0]!.dst)?.label}`, 'runtime: request initiator');
    if (t.facts.dynamic && !globals.length && c.type === 'remove') add('unknown', 'dynamic-self', `${describe(t)} runs code the engine cannot read (${t.facts.dynamicReasons.join(', ')}) and no global it defines was seen`, 'static: dynamic code');
  }
  return r;
}

/** Position in the document (defer order follows the document, not parse order). */
function docIndex(cap: XrayCapture, s: ScriptInfo): number {
  if (s.script.inline) return cap.htmlInlineScripts[s.script.inlineIndex ?? -1]?.index ?? 1e6 + s.script.order;
  return cap.documentScripts.find((d) => d.src === s.script.url)?.index ?? 1e6 + s.script.order;
}

function worst(reasons: VerdictReason[]): VerdictValue {
  if (reasons.some((x) => x.severity === 'unsafe')) return 'unsafe';
  if (reasons.some((x) => x.severity === 'unknown')) return 'unknown';
  return 'safe';
}

const VERB: Record<ChangeType, string> = { defer: 'defer', async: 'load async', delay: 'delay until interaction', remove: 'remove', 'remove-template': 'remove from this template' };

/** The verdict for one change, across every captured page (or the pages of one template). */
export function isSafe(ctx: VerdictContext, change: Change | string, template?: string): Verdict {
  const c = typeof change === 'string' ? parseChange(change, template) : change;
  const key = changeKey(c);
  const caps = ctx.captures.filter((cap) => c.type !== 'remove-template' || classify(cap.url, ctx.platform) === c.template);
  const reasons: VerdictReason[] = [];
  const pages: string[] = [];
  let target: ScriptInfo | undefined;
  for (const cap of caps) {
    const pageScripts = ctx.scripts.filter((s) => s.page === cap.url);
    const t = pageScripts.find((s) => matches(s, c.target));
    if (!t) continue;
    target ??= t;
    pages.push(cap.url);
    const recipe = matchRecipe(ctx.recipes, ctx.platform, { url: t.script.url, handle: t.handle, defines: globalsDefinedBy(ctx, t) })?.recipe;
    reasons.push(...pageChecks(ctx, c, t, cap, pageScripts, recipe));
  }
  if (!target) {
    const why = c.type === 'remove-template' && !caps.length ? `no page of template "${c.template}" was captured` : `"${c.target}" was not seen on any captured page`;
    return { change: key, verdict: 'unknown', target: c.target, pages: [], reasons: [{ severity: 'unknown', kind: 'not-found', detail: why, evidence: `${caps.length} capture(s)` }], confidence: 0, explanation: `Unknown: ${why}, so it stays untouched.` };
  }
  const recipe = matchRecipe(ctx.recipes, ctx.platform, { url: target.script.url, handle: target.handle, defines: globalsDefinedBy(ctx, target) })?.recipe;
  const verdict = worst(reasons);
  const blockers = reasons.filter((x) => x.severity === verdict);
  const uniq = [...new Set(blockers.map((b) => b.detail))];
  const name = target.handle ?? (target.script.inline ? describe(target) : target.script.url.split('?')[0]!.split('/').slice(-2).join('/'));
  const explanation = verdict === 'safe'
    ? `Safe to ${VERB[c.type]} ${name}: ${[...new Set(reasons.filter((x) => x.severity === 'ok').map((x) => x.detail))].slice(0, 3).join('; ') || 'nothing on the captured pages needs it earlier, it handles no interaction and no dynamic code can reach it'} (checked on ${pages.length} page(s)).`
    : `${verdict === 'unsafe' ? 'Not safe' : 'Unknown, so it stays untouched'}: ${VERB[c.type]} ${name}. ${uniq.slice(0, 4).join('. ')}${uniq.length > 4 ? ` (and ${uniq.length - 4} more)` : ''}.`;
  const confidence = verdict === 'safe' ? (recipe && recipe.confidence >= 0.5 ? 0.9 : 0.8) : verdict === 'unsafe' ? 0.95 : 0.5;
  return { change: key, verdict, target: c.target, owner: target.script.owner.id, recipe: recipe?.id, pages, reasons, confidence, explanation };
}

/** Candidate changes for every external script on the captured pages (what the planner asks the X-ray about). */
export function candidateChanges(ctx: VerdictContext): Change[] {
  const out = new Map<string, Change>();
  for (const s of ctx.scripts.filter((x) => !x.script.inline && x.script.loading !== 'injected')) {
    const target = s.handle ?? s.script.url.split('?')[0]!.replace(/^https?:\/\/[^/]+/, '');
    const tpl = classify(s.page, ctx.platform);
    const list: Change[] = [];
    if (s.script.loading === 'blocking') list.push({ type: 'defer', target }, { type: 'async', target });
    if (s.script.owner.kind === 'third-party' || s.script.owner.kind === 'app') list.push({ type: 'delay', target });
    list.push({ type: 'remove', target }, { type: 'remove-template', target, template: tpl });
    for (const c of list) out.set(changeKey(c), c);
  }
  return [...out.values()];
}

export function allVerdicts(ctx: VerdictContext): Verdict[] {
  return candidateChanges(ctx).map((c) => isSafe(ctx, c));
}
