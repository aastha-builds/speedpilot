/**
 * Runtime capture through the Chrome DevTools Protocol (SPEC.md 15.2): parsed scripts with sources and source maps,
 * requests with initiator stacks, CPU profile, Long Animation Frames and layout shifts, function-level JS coverage with
 * call counts and rule-level CSS usage per interaction state, behaviour hooks, attached listeners and a scrubbed HAR.
 * Read-only: exploration follows the safe list on production.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Browser, CDPSession } from 'playwright';
import { openSession, ownerOf, redact, type OwnerContext, type Owner, type Device } from '@speedpilot/core';
import { explore, type ExploreStep } from './explore.js';

export interface CapturedScript {
  scriptId: string;
  url: string;
  inline: boolean;
  /** Inline scripts: index among the page's inline scripts, and the element id when it has one. */
  inlineIndex?: number;
  elementId?: string;
  hash: string;
  bytes: number;
  sourcePath: string;
  sourceMapURL?: string;
  sourceMapPath?: string;
  isModule: boolean;
  startLine: number;
  owner: Owner;
  /** Stack of the code that injected this script, when it was not in the HTML. */
  injectedBy?: string[];
  /** Order in which the script was parsed. */
  order: number;
  /** Position in the document: parser-blocking head script, defer, async, module, injected. */
  loading?: 'blocking' | 'defer' | 'async' | 'module' | 'injected' | 'inline';
}

export interface CapturedRequest {
  id: string;
  url: string;
  type: string;
  initiator: { type: string; url?: string; scriptId?: string; frames: string[] };
  owner: Owner;
  status: number | null;
  bytes: number;
  startMs: number;
  endMs: number;
  priority?: string;
  renderBlocking?: string;
}

export interface FunctionCoverage {
  scriptId: string;
  url: string;
  functions: Array<{ name: string; start: number; end: number; count: number }>;
}

export interface CoverageState {
  state: string;
  js: FunctionCoverage[];
  css: Array<{ styleSheetId: string; url: string; used: number; unused: number }>;
}

export interface CapturedListener {
  selector: string;
  type: string;
  scriptId: string;
  url: string;
  line: number;
  column: number;
  handler: string;
  owner: Owner;
}

export interface XrayCapture {
  url: string;
  device: Device;
  state: { consent: 'denied' | 'granted'; loggedIn: boolean };
  stage: 'local' | 'staging' | 'production';
  scripts: CapturedScript[];
  stylesheets: Array<{ styleSheetId: string; url: string; bytes: number; owner: Owner; inline: boolean; sourcePath?: string }>;
  requests: CapturedRequest[];
  cpu: Array<{ url: string; selfMs: number; owner: Owner }>;
  loaf: Array<{ startTime: number; duration: number; blockingDuration: number; scripts: Array<{ sourceURL: string; sourceFunctionName: string; invoker: string; invokerType: string; duration: number }> }>;
  shifts: Array<{ value: number; startTime: number; sources: Array<{ selector: string | null }> }>;
  coverage: CoverageState[];
  listeners: CapturedListener[];
  behaviour: {
    globalsAdded: string[];
    globalsTimeline: Array<{ before: string; added: string[] }>;
    listenerRegistrations: Array<{ type: string; target: string | null; caller: string | null }>;
    timers: Array<{ kind: string; delay: number; caller: string | null }>;
    mutationObservers: Array<{ caller: string | null }>;
    docWrite: number;
    syncXhr: number;
    domMutationsBeforeLoad: number;
  };
  exploration: ExploreStep[];
  /** Per explored interaction (4x CPU slowdown): event timing entries and Long Animation Frames with script attribution. */
  interactions: Array<{ selector: string; kind: string; label: string; t0: number; t1: number; events: Array<{ name: string; startTime: number; duration: number; processingStart: number; processingEnd: number; target: string | null }>; loaf: XrayCapture['loaf'] }>;
  harPath?: string;
  /** The rendered DOM after load and exploration (for per-template markers). */
  domPath?: string;
  dcl: number;
  load: number;
  fcp: number | null;
  lcp: { startTime: number; url: string | null; selector: string | null } | null;
  htmlInlineScripts: Array<{ index: number; id: string | null; text: string; position: 'head' | 'body'; afterSrc: string | null }>;
  documentScripts: Array<{ src: string; attrs: { defer: boolean; async: boolean; module: boolean }; position: 'head' | 'body'; index: number }>;
  inlineHandlers: Array<{ selector: string; attr: string; code: string }>;
}

/** Behaviour hooks that run before any page script (SPEC.md 15.2 "Behaviour"). They observe and never change behaviour. */
export const BEHAVIOUR_INIT = String.raw`
(function(){
  if (window.__spx) return;
  var x = window.__spx = { base: null, timeline: [], regs: [], timers: [], mos: [], docWrite: 0, syncXhr: 0, mutations: 0 };
  function caller(){ try { var s = new Error().stack.split('\n').slice(3); for (var i=0;i<s.length;i++){ var m = s[i].match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/); if (m) return m[1]+':'+m[2]; } } catch(e){} return null; }
  x.base = Object.getOwnPropertyNames(window);
  var known = {}; x.base.forEach(function(k){ known[k]=1; });
  function snapshot(label){ var now = Object.getOwnPropertyNames(window); var added = []; for (var i=0;i<now.length;i++){ if (!known[now[i]]) { known[now[i]]=1; added.push(now[i]); } } x.timeline.push({ before: label, added: added }); }
  x.snapshot = snapshot;
  // a microtask checkpoint runs before each parser-inserted script executes, so this sees every script element first
  try {
    new MutationObserver(function(list){
      list.forEach(function(m){ x.mutations += m.addedNodes.length; m.addedNodes.forEach(function(n){ if (n.nodeName === 'SCRIPT') snapshot(n.src || ('inline#' + (n.id || Array.prototype.indexOf.call(document.scripts, n)))); }); });
    }).observe(document, { childList: true, subtree: true });
  } catch(e) {}
  addEventListener('load', function(){ snapshot('load'); }, { once: true });
  try {
    var ael = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type){ try { x.regs.push({ type: type, target: this === window ? 'window' : this === document ? 'document' : (this.id ? '#' + this.id : (this.nodeName || '').toLowerCase()), caller: caller() }); } catch(e){} return ael.apply(this, arguments); };
  } catch(e) {}
  ['setTimeout','setInterval'].forEach(function(k){ var o = window[k]; window[k] = function(fn, d){ x.timers.push({ kind: k + (typeof fn === 'string' ? ':string' : ''), delay: +d || 0, caller: caller() }); return o.apply(this, arguments); }; });
  try { var MO = window.MutationObserver; window.MutationObserver = function(cb){ x.mos.push({ caller: caller() }); return new MO(cb); }; window.MutationObserver.prototype = MO.prototype; } catch(e) {}
  try { var dw = document.write; document.write = function(){ x.docWrite++; return dw.apply(document, arguments); }; } catch(e) {}
  try { var op = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m,u,a){ if (a === false) x.syncXhr++; return op.apply(this, arguments); }; } catch(e) {}
})();
`;

function sha(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 20);
}

export interface XrayCaptureOptions {
  url: string;
  device: Device;
  stage: 'local' | 'staging' | 'production';
  outDir: string;
  ownerCtx: OwnerContext;
  explore?: boolean;
  consent?: 'denied' | 'granted';
  har?: boolean;
  cookies?: Array<{ name: string; value: string; url: string }>;
}

export async function captureUrl(browser: Browser, o: XrayCaptureOptions): Promise<XrayCapture> {
  const srcDir = join(o.outDir, 'sources');
  mkdirSync(srcDir, { recursive: true });
  const local = o.stage !== 'production';
  const session = await openSession(browser, { device: o.device, local, mutationAllowlist: local ? [/.*/] : [], cookies: o.cookies, initScripts: [BEHAVIOUR_INIT] });
  const harPath = o.har ? join(o.outDir, `${sha(o.url + o.device)}.har`) : undefined;
  const page = await session.newPage();
  const cdp: CDPSession = await page.context().newCDPSession(page);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = <T>(event: string, fn: (e: T) => void) => (cdp as unknown as { on(e: string, f: (x: T) => void): void }).on(event, fn);
  const scripts = new Map<string, CapturedScript>();
  const stylesheets = new Map<string, XrayCapture['stylesheets'][number]>();
  const requests = new Map<string, CapturedRequest>();
  let order = 0;
  let inlineCounter = 0;
  const t0 = Date.now();
  const pending: Array<Promise<void>> = [];

  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Debugger.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false, allowTriggeredUpdates: false });
  await cdp.send('CSS.startRuleUsageTracking');
  await cdp.send('Profiler.start');

  on('Debugger.scriptParsed', (e: { scriptId: string; url: string; length: number; sourceMapURL?: string; isModule?: boolean; startLine: number; executionContextId: number; stackTrace?: { callFrames: Array<{ url: string; functionName: string; lineNumber: number }> }; hash: string }) => {
    if (e.url.startsWith('chrome-extension:') || e.url.startsWith('pptr:')) return;
    // isolated worlds (automation utilities) are never page scripts
    if ((e as { executionContextAuxData?: { isDefault?: boolean } }).executionContextAuxData?.isDefault === false) return;
    const pageUrl = page.url();
    // eval'd code and new Function() bodies have no URL: they are not document scripts (static analysis flags them)
    if (!e.url) return;
    // Chrome names inline scripts after the page URL, or after the element id when the <script> has one
    const urlLike = /^(https?|file|blob):/.test(e.url);
    const inline = !urlLike || e.url === pageUrl || e.url === o.url;
    if (e.url && /__playwright|__puppeteer|^chrome:|^devtools:/.test(e.url)) return;
    const s: CapturedScript = {
      scriptId: e.scriptId,
      url: inline ? o.url : e.url,
      elementId: inline && !urlLike ? e.url : undefined,
      inline,
      hash: '',
      bytes: e.length,
      sourcePath: '',
      sourceMapURL: e.sourceMapURL || undefined,
      isModule: !!e.isModule,
      startLine: e.startLine,
      owner: ownerOf(inline ? o.url : e.url, o.ownerCtx),
      injectedBy: e.stackTrace?.callFrames.slice(0, 4).map((f) => `${f.functionName || '(anonymous)'}@${f.url}:${f.lineNumber + 1}`),
      order: order++,
      inlineIndex: inline ? inlineCounter++ : undefined,
    };
    scripts.set(e.scriptId, s);
    pending.push(
      (async () => {
        const r = (await cdp.send('Debugger.getScriptSource', { scriptId: e.scriptId }).catch(() => ({ scriptSource: '' }))) as { scriptSource: string };
        const src = r.scriptSource ?? '';
        // SpeedPilot's own init scripts are not page scripts
        if (!e.url && (/window\.__spx?\b|__spInp|webVitals/.test(src.slice(0, 400)) || src.includes('if (window.__sp) return;'))) {
          scripts.delete(e.scriptId);
          return;
        }
        s.hash = sha(src);
        s.bytes = Buffer.byteLength(src);
        s.sourcePath = join(srcDir, `${s.hash}.js`);
        if (!existsSync(s.sourcePath)) writeFileSync(s.sourcePath, src);
        if (s.sourceMapURL) {
          try {
            let mapText: string | undefined;
            if (s.sourceMapURL.startsWith('data:')) mapText = Buffer.from(s.sourceMapURL.split(',')[1] ?? '', s.sourceMapURL.includes(';base64') ? 'base64' : 'utf8').toString('utf8');
            else {
              const mapUrl = new URL(s.sourceMapURL, s.url).href;
              if (new URL(mapUrl).origin === new URL(o.url).origin) mapText = await (await fetch(mapUrl)).text();
            }
            if (mapText) {
              s.sourceMapPath = join(srcDir, `${s.hash}.map`);
              writeFileSync(s.sourceMapPath, mapText);
            }
          } catch {
            /* source map optional */
          }
        }
      })(),
    );
  });
  on('CSS.styleSheetAdded', (e: { header: { styleSheetId: string; sourceURL: string; length: number; isInline: boolean } }) => {
    stylesheets.set(e.header.styleSheetId, { styleSheetId: e.header.styleSheetId, url: e.header.sourceURL || o.url, bytes: e.header.length, owner: ownerOf(e.header.sourceURL || o.url, o.ownerCtx), inline: e.header.isInline });
  });
  on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string; initialPriority?: string }; type?: string; initiator: { type: string; url?: string; stack?: { callFrames: Array<{ url: string; functionName: string; lineNumber: number; scriptId: string }> } }; timestamp: number; renderBlockingBehavior?: string }) => {
    const frames = e.initiator.stack?.callFrames ?? [];
    requests.set(e.requestId, {
      id: e.requestId,
      url: e.request.url,
      type: (e.type ?? 'Other').toLowerCase(),
      initiator: { type: e.initiator.type, url: e.initiator.url ?? frames[0]?.url, scriptId: frames[0]?.scriptId, frames: frames.slice(0, 6).map((f) => `${f.functionName || '(anonymous)'}@${f.url}:${f.lineNumber + 1}`) },
      owner: ownerOf(e.request.url, o.ownerCtx),
      status: null,
      bytes: 0,
      startMs: Date.now() - t0,
      endMs: 0,
      priority: e.request.initialPriority,
      renderBlocking: e.renderBlockingBehavior,
    });
  });
  on('Network.responseReceived', (e: { requestId: string; response: { status: number } }) => {
    const r = requests.get(e.requestId);
    if (r) r.status = e.response.status;
  });
  on('Network.loadingFinished', (e: { requestId: string; encodedDataLength: number }) => {
    const r = requests.get(e.requestId);
    if (r) {
      r.bytes = e.encodedDataLength;
      r.endMs = Date.now() - t0;
    }
  });

  const coverage: CoverageState[] = [];
  const takeCoverage = async (state: string) => {
    const js = (await cdp.send('Profiler.takePreciseCoverage')) as { result: Array<{ scriptId: string; url: string; functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> }> };
    const css = (await cdp.send('CSS.takeCoverageDelta')) as { coverage: Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }> };
    const cssBy = new Map<string, { used: number; unused: number }>();
    for (const r of css.coverage) {
      const e = cssBy.get(r.styleSheetId) ?? { used: 0, unused: 0 };
      if (r.used) e.used += r.endOffset - r.startOffset;
      else e.unused += r.endOffset - r.startOffset;
      cssBy.set(r.styleSheetId, e);
    }
    coverage.push({
      state,
      js: js.result
        .filter((r) => scripts.has(r.scriptId))
        .map((r) => ({ scriptId: r.scriptId, url: r.url, functions: r.functions.filter((f) => f.ranges[0] && f.ranges[0].count > 0).map((f) => ({ name: f.functionName, start: f.ranges[0]!.startOffset, end: f.ranges[0]!.endOffset, count: f.ranges[0]!.count })) })),
      css: [...cssBy.entries()].map(([id, v]) => ({ styleSheetId: id, url: stylesheets.get(id)?.url ?? '', ...v })),
    });
  };

  await page.goto(o.url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await takeCoverage('load');
  const profile = (await cdp.send('Profiler.stop')) as { profile: { nodes: Array<{ id: number; callFrame: { url: string }; hitCount?: number }>; samples: number[]; timeDeltas: number[] } };
  const selfByUrl = new Map<string, number>();
  const nodeUrl = new Map(profile.profile.nodes.map((n) => [n.id, n.callFrame.url]));
  profile.profile.samples.forEach((id, i) => {
    const u = nodeUrl.get(id) || '(native)';
    selfByUrl.set(u, (selfByUrl.get(u) ?? 0) + (profile.profile.timeDeltas[i] ?? 0) / 1000);
  });

  // Document structure for the verdicts: script order, attributes and inline code positions
  const doc = await page.evaluate(() => {
    const inline: Array<{ index: number; id: string | null; text: string; position: 'head' | 'body'; afterSrc: string | null }> = [];
    const ext: Array<{ src: string; attrs: { defer: boolean; async: boolean; module: boolean }; position: 'head' | 'body'; index: number }> = [];
    let lastSrc: string | null = null;
    Array.from(document.scripts).forEach((s, i) => {
      const position = s.closest('head') ? 'head' : 'body';
      const type = s.type || 'text/javascript';
      if (!/javascript|module|^$/.test(type)) return;
      if (s.src) {
        ext.push({ src: s.src, attrs: { defer: s.defer, async: s.async, module: type === 'module' }, position, index: i });
        lastSrc = s.src;
      } else inline.push({ index: i, id: s.id || null, text: (s.textContent ?? '').slice(0, 20000), position, afterSrc: lastSrc });
    });
    const handlers: Array<{ selector: string; attr: string; code: string }> = [];
    document.querySelectorAll('*').forEach((el) => {
      for (const a of Array.from(el.attributes)) if (/^on[a-z]+$/.test(a.name)) handlers.push({ selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(), attr: a.name, code: a.value.slice(0, 500) });
    });
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    const sp = (window as unknown as { __sp?: { lcp: Array<{ startTime: number; url: string | null; selector: string | null }>; loaf: unknown[]; shifts: unknown[] }; __spx?: Record<string, unknown> }).__sp;
    const spx = (window as unknown as { __spx?: { base: string[]; timeline: Array<{ before: string; added: string[] }>; regs: unknown[]; timers: unknown[]; mos: unknown[]; docWrite: number; syncXhr: number; mutations: number } }).__spx;
    const added = spx ? Object.getOwnPropertyNames(window).filter((k) => !spx.base.includes(k) && !k.startsWith('__sp')) : [];
    return { inline, ext, handlers, dcl: nav?.domContentLoadedEventEnd ?? 0, load: nav?.loadEventEnd ?? 0, fcp, lcp: sp?.lcp[sp.lcp.length - 1] ?? null, loaf: sp?.loaf ?? [], shifts: sp?.shifts ?? [], behaviour: spx ? { globalsAdded: added, globalsTimeline: spx.timeline, listenerRegistrations: spx.regs, timers: spx.timers, mutationObservers: spx.mos, docWrite: spx.docWrite, syncXhr: spx.syncXhr, domMutationsBeforeLoad: spx.mutations } : null };
  });

  // Inline scripts are matched to document <script> elements by content (handler attributes and injected code also
  // parse with the document URL, so parse order alone is not reliable).
  await Promise.all(pending);
  const usedDoc = new Set<number>();
  for (const s of [...scripts.values()].filter((x) => x.inline).sort((a, b) => a.order - b.order)) {
    const src = existsSync(s.sourcePath) ? readFileSync(s.sourcePath, 'utf8').trim() : '';
    const k = doc.inline.findIndex((d, i) => !usedDoc.has(i) && src.length > 0 && (d.text.trim() === src || (src.length > 200 && d.text.trim().startsWith(src.slice(0, 200)))));
    if (k >= 0) {
      usedDoc.add(k);
      s.inlineIndex = k;
      if (doc.inline[k]!.id) s.elementId = doc.inline[k]!.id!;
    } else s.inlineIndex = 10_000 + s.order;
  }
  // Loading mode per script
  for (const s of scripts.values()) {
    if (s.inline) {
      s.loading = 'inline';
      continue;
    }
    const d = doc.ext.find((x) => x.src === s.url);
    s.loading = !d ? 'injected' : d.attrs.module ? 'module' : d.attrs.async ? 'async' : d.attrs.defer ? 'defer' : 'blocking';
  }

  // Attached listeners on interactive elements, window and document (DOMDebugger)
  const listeners: CapturedListener[] = [];
  const targets = await page.evaluate(() => {
    const out: string[] = ['window', 'document'];
    document.querySelectorAll('button, a[href], summary, [role="button"], [role="tab"], [aria-expanded], [onclick], input, select, form, details').forEach((el, i) => {
      if (i < 150) {
        (el as HTMLElement).dataset.spxTarget = String(i);
        out.push(el.id ? `#${el.id}` : `[data-spx-target="${i}"]`);
      }
    });
    return out;
  });
  for (const t of targets) {
    const expr = t === 'window' ? 'window' : t === 'document' ? 'document' : `document.querySelector(${JSON.stringify(t)})`;
    const obj = (await cdp.send('Runtime.evaluate', { expression: expr }).catch(() => undefined)) as { result?: { objectId?: string } } | undefined;
    if (!obj?.result?.objectId) continue;
    const ls = (await cdp.send('DOMDebugger.getEventListeners', { objectId: obj.result.objectId, depth: 0 }).catch(() => ({ listeners: [] }))) as { listeners: Array<{ type: string; scriptId: string; lineNumber: number; columnNumber: number; handler?: { description?: string } }> };
    const label = t.startsWith('[data-spx-target') ? await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return sel;
      return el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : ''}`;
    }, t) : t;
    for (const l of ls.listeners) {
      const s = scripts.get(l.scriptId);
      let fn = /function\s+([\w$]+)/.exec(l.handler?.description ?? '')?.[1];
      if (!fn && s?.sourcePath) {
        // read the name from the source at the listener position
        await Promise.all(pending);
        const lines = existsSync(s.sourcePath) ? readFileSync(s.sourcePath, 'utf8').split('\n') : [];
        const lineText = lines[l.lineNumber - (s.inline ? s.startLine : 0)] ?? '';
        const win = lineText.slice(Math.max(0, l.columnNumber - 80), l.columnNumber + 60);
        const named = [...win.matchAll(/function\s*\*?\s*([\w$]+)\s*\(/g)].pop()?.[1];
        fn = named ?? /([\w$]+)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/.exec(win)?.[1];
      }
      fn = fn ?? '(anonymous)';
      listeners.push({ selector: label, type: l.type, scriptId: l.scriptId, url: s?.url ?? '', line: l.lineNumber + 1, column: l.columnNumber, handler: fn, owner: ownerOf(s?.url ?? o.url, o.ownerCtx) });
    }
  }

  // Exploration with a coverage delta per interaction state
  let exploration: ExploreStep[] = [];
  const interactions: XrayCapture['interactions'] = [];
  if (o.explore !== false) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }).catch(() => {});
    exploration = await explore(page, o.stage, async (step) => {
      if (step.ran) await takeCoverage(`interaction:${step.kind}:${step.selector}`);
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const sp = (window as unknown as { __sp?: { loaf: unknown[]; events: unknown[] } }).__sp;
      return { loaf: sp?.loaf ?? [], events: sp?.events ?? [] };
    }).catch(() => ({ loaf: [], events: [] }));
    for (const st of exploration.filter((x) => x.ran && x.t0 !== undefined && x.t1 !== undefined)) {
      const lo = st.t0! - 5;
      const hi = st.t1! + 50;
      interactions.push({
        selector: st.selector,
        kind: st.kind,
        label: st.label,
        t0: st.t0!,
        t1: st.t1!,
        events: (after.events as XrayCapture['interactions'][number]['events']).filter((e) => e.startTime >= lo && e.startTime <= hi),
        loaf: (after.loaf as XrayCapture['loaf']).filter((f) => f.startTime + f.duration >= lo && f.startTime <= hi),
      });
    }
  }
  await Promise.all(pending);
  for (const st of stylesheets.values()) {
    const r = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: st.styleSheetId }).catch(() => undefined)) as { text?: string } | undefined;
    if (!r?.text) continue;
    st.sourcePath = join(srcDir, `${sha(r.text)}.css`);
    st.bytes = Buffer.byteLength(r.text);
    if (!existsSync(st.sourcePath)) writeFileSync(st.sourcePath, r.text);
  }
  const domPath = join(o.outDir, `${sha(o.url + o.device + (o.consent ?? 'denied'))}.dom.html`);
  writeFileSync(domPath, await page.content().catch(() => ''));
  await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});
  await cdp.send('CSS.stopRuleUsageTracking').catch(() => {});
  if (o.har) {
    // HAR from the CDP request log, with cookies, Authorization headers and tokens stripped (SPEC.md 12)
    const har = { log: { version: '1.2', creator: { name: 'SpeedPilot X-ray', version: '0.1.0' }, entries: [...requests.values()].map((r) => redact({ startedDateTime: new Date(t0 + r.startMs).toISOString(), time: r.endMs - r.startMs, request: { method: 'GET', url: r.url.replace(/([?&](token|key|password|access_token|signature)=)[^&]+/gi, '$1[REDACTED]'), headers: [] }, response: { status: r.status ?? 0, headers: [], content: { size: r.bytes } }, _initiator: r.initiator, _owner: r.owner.id })) } };
    writeFileSync(harPath!, JSON.stringify(har));
  }
  await session.close();

  return {
    url: o.url,
    device: o.device,
    state: { consent: o.consent ?? 'denied', loggedIn: !!o.cookies?.length },
    stage: o.stage,
    scripts: [...scripts.values()],
    stylesheets: [...stylesheets.values()],
    requests: [...requests.values()],
    cpu: [...selfByUrl.entries()].filter(([u]) => /^https?:/.test(u)).map(([url, selfMs]) => ({ url, selfMs: Math.round(selfMs * 10) / 10, owner: ownerOf(url, o.ownerCtx) })).sort((a, b) => b.selfMs - a.selfMs),
    loaf: doc.loaf as XrayCapture['loaf'],
    shifts: doc.shifts as XrayCapture['shifts'],
    coverage,
    listeners,
    behaviour: (doc.behaviour as XrayCapture['behaviour'] | null) ?? { globalsAdded: [], globalsTimeline: [], listenerRegistrations: [], timers: [], mutationObservers: [], docWrite: 0, syncXhr: 0, domMutationsBeforeLoad: 0 },
    exploration,
    interactions,
    harPath,
    domPath,
    dcl: doc.dcl,
    load: doc.load,
    fcp: doc.fcp,
    lcp: doc.lcp,
    htmlInlineScripts: doc.inline,
    documentScripts: doc.ext,
    inlineHandlers: doc.handlers,
  };
}

export function readSource(s: CapturedScript): string {
  try {
    return readFileSync(s.sourcePath, 'utf8');
  } catch {
    return '';
  }
}
