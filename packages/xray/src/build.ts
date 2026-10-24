import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { classify, type AgentDiag } from '@speedpilot/core';
import { SiteModel, ids } from './model.js';
import { analyzeJs, analyzeInlineHandler, type JsFacts } from './static/js.js';
import { analyzeCss, type CssFacts } from './static/css.js';
import { fingerprint, type LibraryHit } from './static/libraries.js';
import type { PhpFacts } from './static/php.js';
import type { RenderTree } from './static/liquid.js';
import type { XrayCapture, CapturedScript } from './capture/cdp.js';

export interface StaticCache {
  dir: string;
  js: Map<string, JsFacts>;
  css: Map<string, CssFacts>;
}

export function openCache(dir: string): StaticCache {
  mkdirSync(dir, { recursive: true });
  return { dir, js: new Map(), css: new Map() };
}

/** Static results are cached by file hash (SPEC.md 15.1). */
export function jsFacts(cache: StaticCache, hash: string, source: string): JsFacts {
  const mem = cache.js.get(hash);
  if (mem) return mem;
  const p = join(cache.dir, `${hash}.js.json`);
  if (existsSync(p)) {
    const f = JSON.parse(readFileSync(p, 'utf8')) as JsFacts;
    cache.js.set(hash, f);
    return f;
  }
  const f = analyzeJs(source);
  writeFileSync(p, JSON.stringify(f));
  cache.js.set(hash, f);
  return f;
}

export function cssFacts(cache: StaticCache, key: string, source: string): CssFacts {
  const mem = cache.css.get(key);
  if (mem) return mem;
  const f = analyzeCss(source);
  cache.css.set(key, f);
  return f;
}

export interface BuildInputs {
  platform: 'wordpress' | 'shopify';
  captures: XrayCapture[];
  cache: StaticCache;
  /** WordPress agent handle maps per URL. */
  handleMaps?: Record<string, AgentDiag>;
  php?: PhpFacts[];
  liquid?: RenderTree;
  liquidOwner?: string;
}

export interface ScriptInfo {
  id: string;
  script: CapturedScript;
  facts: JsFacts;
  libraries: LibraryHit[];
  handle?: string;
  page: string;
}

/** Builds the Site Model from runtime captures, static analysis and backend data. */
export function buildModel(inp: BuildInputs): { model: SiteModel; scripts: ScriptInfo[] } {
  const m = new SiteModel();
  const scripts: ScriptInfo[] = [];
  for (const cap of inp.captures) {
    const page = ids.page(cap.url);
    const template = classify(cap.url, inp.platform);
    m.node(page, 'page', cap.url, { template, device: cap.device, dcl: cap.dcl, load: cap.load, fcp: cap.fcp, lcp: cap.lcp });
    m.node(`template:${template}`, 'template', template);
    m.edge(page, `template:${template}`, 'renders', 'runtime', 1);
    const diag = inp.handleMaps?.[cap.url];
    const handleBySrc = new Map<string, string>();
    for (const h of diag?.scripts ?? []) if (h.src) handleBySrc.set(h.src.split('?')[0]!, h.handle);

    // scripts
    const byScriptId = new Map<string, string>();
    for (const s of cap.scripts) {
      const id = s.inline ? ids.script(cap.url, s.inlineIndex) : ids.script(s.url);
      byScriptId.set(s.scriptId, id);
      const src = existsSync(s.sourcePath) ? readFileSync(s.sourcePath, 'utf8') : '';
      const facts = jsFacts(inp.cache, s.hash || 'empty', src);
      const libraries = s.inline ? [] : fingerprint(s.url, src);
      const handle = s.inline ? undefined : handleBySrc.get(s.url.split('?')[0]!);
      const label = s.inline ? `inline${s.elementId ? `#${s.elementId}` : `[${s.inlineIndex}]`} ${src.trim().slice(0, 40)}` : s.url;
      m.node(id, 'script', label, { url: s.url, inline: s.inline, elementId: s.elementId, inlineIndex: s.inlineIndex, loading: s.loading, bytes: s.bytes, hash: s.hash, handle, order: s.order, libraries, dynamic: facts.dynamic, dynamicReasons: facts.dynamicReasons, injectedBy: s.injectedBy, contentHead: src.trim().slice(0, 200) }, s.owner.id);
      m.edge(page, id, 'loads', 'runtime', 1, { order: s.order, loading: s.loading });
      scripts.push({ id, script: s, facts, libraries, handle, page: cap.url });
      for (const g of facts.definesGlobals) {
        m.node(ids.global(g), 'global', g);
        m.edge(id, ids.global(g), 'defines', 'static', 0.8);
      }
      for (const p of facts.registersJqPlugins) {
        m.node(ids.global(`jQuery.fn.${p}`), 'global', `jQuery.fn.${p}`);
        m.edge(id, ids.global(`jQuery.fn.${p}`), 'defines', 'static', 0.85);
      }
      for (const g of facts.readsGlobals) {
        m.node(ids.global(g), 'global', g);
        m.edge(id, ids.global(g), 'uses', 'static', 0.8, { immediate: facts.readsGlobalsImmediately.includes(g) });
      }
      for (const p of facts.usesJqMembers) {
        m.node(ids.global(`jQuery.fn.${p}`), 'global', `jQuery.fn.${p}`);
        m.edge(id, ids.global(`jQuery.fn.${p}`), 'uses', 'static', 0.6);
      }
      for (const sel of facts.selectors.slice(0, 30)) {
        const el = ids.element(cap.url, sel);
        m.node(el, 'element', sel);
        m.edge(id, el, 'touches', 'static', 0.5);
      }
    }
    // runtime confirmation of globals: globals that appear before script N+1 runs were defined by script N
    const labelToScript = (label: string): string | undefined => {
      if (label.startsWith('inline#')) {
        const key = label.slice('inline#'.length);
        const docEntry = cap.htmlInlineScripts.find((x) => x.id === key) ?? cap.htmlInlineScripts.find((x) => String(x.index) === key);
        const k = docEntry ? cap.htmlInlineScripts.indexOf(docEntry) : -1;
        const s = cap.scripts.find((x) => x.inline && x.inlineIndex === k);
        return s ? byScriptId.get(s.scriptId) : undefined;
      }
      const s = cap.scripts.find((x) => !x.inline && x.url === label);
      return s ? byScriptId.get(s.scriptId) : undefined;
    };
    let prevLabel: string | undefined;
    for (const t of cap.behaviour.globalsTimeline) {
      const prev = prevLabel ? labelToScript(prevLabel) : undefined;
      if (prev) {
        for (const g of t.added) {
          if (g.startsWith('__sp') || /^\d+$/.test(g)) continue;
          m.node(ids.global(g), 'global', g);
          m.edge(prev, ids.global(g), 'defines', 'runtime', t.before === 'load' ? 0.6 : 0.9);
        }
      }
      if (t.before !== 'load') prevLabel = t.before;
    }
    // WordPress handle dependencies and inline before/after code (agent evidence)
    const nodeBySrc = new Map<string, string>();
    for (const sc of scripts.filter((x) => x.page === cap.url && !x.script.inline)) nodeBySrc.set(sc.script.url.split('?')[0]!, sc.id);
    const nodeFor = (src: string | null | undefined) => (src ? nodeBySrc.get(src.split('?')[0]!) : undefined);
    for (const h of diag?.scripts ?? []) {
      const hid = nodeFor(h.src);
      if (!hid) continue;
      for (const dep of h.deps) {
        const d = diag?.scripts.find((x) => x.handle === dep);
        const did = nodeFor(d?.src);
        if (did) m.edge(hid, did, 'depends-on', 'agent', 0.95, { via: 'wp deps' });
        else if (d && !d.src) {
          // alias handles like `jquery` -> jquery-core, jquery-migrate
          for (const sub of d.deps) {
            const xid = nodeFor(diag?.scripts.find((y) => y.handle === sub)?.src);
            if (xid) m.edge(hid, xid, 'depends-on', 'agent', 0.95, { via: `wp deps (${dep})` });
          }
        }
      }
      for (const kind of ['before', 'after'] as const) {
        for (const code of h.inline?.[kind] ?? []) {
          if (!code.trim()) continue;
          const inl = scripts.find((s) => s.page === cap.url && s.script.inline && (existsSync(s.script.sourcePath) ? readFileSync(s.script.sourcePath, 'utf8') : '').includes(code.trim().slice(0, 60)));
          if (inl) {
            m.node(inl.id, 'script', m.nodes.get(inl.id)!.label, { attachedTo: h.handle, position: kind });
            if (kind === 'after') m.edge(inl.id, hid, 'depends-on', 'agent', 1, { via: `inline ${kind} ${h.handle}` });
          }
        }
      }
    }
    // static dependencies: a script that reads a global another script defines depends on it
    const pageScripts = scripts.filter((s) => s.page === cap.url);
    for (const user of pageScripts) {
      for (const g of [...user.facts.readsGlobals, ...user.facts.usesJqMembers.map((p) => `jQuery.fn.${p}`)]) {
        const definers = pageScripts.filter((d) => d !== user && (d.facts.definesGlobals.includes(g) || d.facts.registersJqPlugins.map((p) => `jQuery.fn.${p}`).includes(g) || m.edges.some((e) => e.src === d.id && e.dst === ids.global(g) && e.type === 'defines' && e.evidence === 'runtime')));
        for (const d of definers) m.edge(user.id, d.id, 'depends-on', 'static', 0.8, { global: g, immediate: user.facts.readsGlobalsImmediately.includes(g) });
      }
    }
    // inline event handler attributes read globals at interaction time
    for (const h of cap.inlineHandlers) {
      const r = analyzeInlineHandler(h.code);
      const el = ids.element(cap.url, h.selector);
      m.node(el, 'element', h.selector, { inlineHandler: h.attr });
      for (const g of r.reads) {
        m.node(ids.global(g), 'global', g);
        m.edge(el, ids.global(g), 'uses', 'static', 0.9, { inlineHandler: h.attr, dynamic: r.dynamic });
      }
    }
    // stylesheets
    for (const st of cap.stylesheets) {
      const id = st.inline ? `stylesheet:inline:${cap.url}#${st.styleSheetId}` : ids.stylesheet(st.url);
      const facts = st.sourcePath && existsSync(st.sourcePath) ? cssFacts(inp.cache, st.sourcePath, readFileSync(st.sourcePath, 'utf8')) : undefined;
      m.node(id, 'stylesheet', st.inline ? `inline style ${st.styleSheetId}` : st.url, { bytes: st.bytes, inline: st.inline, fontFaces: facts?.fontFaces.length, imports: facts?.imports, stateSelectors: facts?.stateSelectors.length }, st.owner.id);
      m.edge(page, id, 'loads', 'runtime', 1);
    }
    // requests and what initiated them
    for (const r of cap.requests) {
      const type = r.type === 'font' ? 'font' : r.type === 'image' ? 'image' : 'request';
      const id = ids.request(r.url);
      m.node(id, type, r.url, { type: r.type, bytes: r.bytes, status: r.status, startMs: r.startMs, endMs: r.endMs, priority: r.priority, renderBlocking: r.renderBlocking }, r.owner.id);
      m.edge(page, id, 'loads', 'runtime', 1, { bytes: r.bytes });
      const init = (r.initiator.scriptId && byScriptId.get(r.initiator.scriptId)) || (r.initiator.url && m.nodes.has(ids.script(r.initiator.url)) ? ids.script(r.initiator.url) : undefined);
      if (init && init !== id) m.edge(init, id, 'initiates', 'runtime', 0.95, { frames: r.initiator.frames });
    }
    // attached listeners -> handlers
    for (const l of cap.listeners) {
      const hid = ids.handler(l.url, l.line, l.type);
      m.node(hid, 'handler', `${l.handler} (${l.type})`, { function: l.handler, type: l.type, url: l.url, line: l.line, selector: l.selector }, l.owner.id);
      const el = ids.element(cap.url, l.selector);
      m.node(el, 'element', l.selector);
      m.edge(hid, el, 'listens', 'runtime', 1, { type: l.type });
      const sid = byScriptId.get(l.scriptId);
      if (sid) m.edge(sid, hid, 'defines', 'runtime', 1);
    }
    // cost per owner: main-thread self time and bytes
    const costs = new Map<string, { ms: number; bytes: number }>();
    for (const c of cap.cpu) {
      const e = costs.get(c.owner.id) ?? { ms: 0, bytes: 0 };
      e.ms += c.selfMs;
      costs.set(c.owner.id, e);
    }
    for (const r of cap.requests) {
      const e = costs.get(r.owner.id) ?? { ms: 0, bytes: 0 };
      e.bytes += r.bytes;
      costs.set(r.owner.id, e);
    }
    for (const [owner, c] of costs) {
      m.ownerNode(owner);
      m.edge(owner, page, 'costs', 'runtime', 1, { ms: Math.round(c.ms), bytes: c.bytes, device: cap.device });
    }
  }
  // WordPress backend: slow queries and outgoing calls (agent), enqueues, hooks and heavy patterns (static PHP)
  for (const [url, diag] of Object.entries(inp.handleMaps ?? {})) {
    for (const q of diag.queries ?? []) {
      const owner = q.caller.owner.split(':').slice(0, 2).join(':');
      const id = ids.query(q.caller.function, q.sql);
      m.node(id, 'query', `${q.caller.function}: ${q.sql.slice(0, 60)}`, { ms: q.ms, sql: q.sql, function: q.caller.function, url }, owner.startsWith('unknown') ? undefined : owner);
      m.edge(id, ids.page(url), 'costs', 'agent', 1, { ms: q.ms });
    }
    for (const h of diag.http ?? []) {
      const id = `request:server:${h.url}`;
      m.node(id, 'request', h.url, { serverSide: true, ms: h.ms, caller: h.caller }, h.caller.split(':').slice(0, 2).join(':'));
    }
  }
  for (const p of inp.php ?? []) {
    for (const h of p.hooks.filter((x) => ['wp_head', 'wp_footer', 'init', 'template_redirect', 'wp_enqueue_scripts', 'wp'].includes(x.hook))) {
      m.node(ids.hook(h.hook, h.callback), 'hook', `${h.hook} → ${h.callback}`, { file: h.file, line: h.line, priority: h.priority }, p.owner);
    }
    for (const x of p.heavy) {
      const id = `php:${p.owner}:${x.file}:${x.line}:${x.pattern}`;
      m.node(id, 'query', `${x.pattern} in ${x.function ?? x.file}`, { static: true, pattern: x.pattern, file: x.file, line: x.line, function: x.function }, p.owner);
    }
    for (const e of p.enqueues.filter((x) => x.handle)) {
      const s = [...m.nodes.values()].find((n) => n.type === 'script' && n.data.handle === e.handle);
      if (s) Object.assign(s.data, { enqueuedIn: `${p.owner} ${e.file}:${e.line}`, staticDeps: e.deps, staticInFooter: e.inFooter });
    }
  }
  // Shopify Liquid render tree
  if (inp.liquid) {
    const owner = inp.liquidOwner ?? 'theme:theme';
    for (const [file, f] of Object.entries(inp.liquid.files)) m.node(ids.liquid(file), 'liquid', file, { loops: f.loops.length, scriptTags: f.scriptTags, deprecated: f.deprecated, renders: f.renders }, owner);
    for (const e of inp.liquid.edges) {
      const to = e.to.startsWith('app:') ? e.to : ids.liquid(e.to);
      if (e.to.startsWith('app:')) m.ownerNode(e.to);
      else m.node(to, 'liquid', e.to, {}, owner);
      m.node(ids.liquid(e.from), 'liquid', e.from, {}, owner);
      m.edge(ids.liquid(e.from), to, 'renders', 'static', 1, { kind: e.kind });
    }
    for (const h of inp.liquid.hotSpots) {
      const n = m.nodes.get(ids.liquid(h.file));
      if (n) n.data.hotSpots = [...((n.data.hotSpots as unknown[]) ?? []), h];
    }
  }
  return { model: m, scripts };
}
