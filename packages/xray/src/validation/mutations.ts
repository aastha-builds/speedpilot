/**
 * Mutation suite (SPEC.md 15.10): generated tricky cases that must come out `unsafe` or `unknown`, never `safe`, plus
 * control cases that are truly safe (to measure that the engine still finds safe changes). The library under test is
 * served from a second origin so `delay` is judged like a third-party script.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MutationCase {
  id: string;
  /** What the case exercises. */
  pattern: string;
  /** HTML body pieces: `head` goes after the library tag, `body` at the end of the body. */
  head?: string;
  body?: string;
  /** The library source (defaults to one that defines window.MutLib). */
  lib?: string;
  /** How the library loads. */
  libAttrs?: string;
  extraFiles?: Record<string, string>;
  /** Changes and the verdicts that are acceptable. A mutation accepts only unsafe/unknown. */
  expect: Record<string, Array<'safe' | 'unsafe' | 'unknown'>>;
}

const NOT_SAFE: Array<'unsafe' | 'unknown'> = ['unsafe', 'unknown'];
const LIB = 'window.MutLib = { n: 0, go: function () { this.n++; } };';
const ALL = (extra: Record<string, Array<'safe' | 'unsafe' | 'unknown'>> = {}) => ({ 'defer:/lib.js': NOT_SAFE, 'async:/lib.js': NOT_SAFE, 'delay:/lib.js': NOT_SAFE, 'remove:/lib.js': NOT_SAFE, ...extra });

export const MUTATIONS: MutationCase[] = [
  { id: 'm-dynamic-global', pattern: "dynamic global access window['Mut' + 'Lib']", head: "<script>window['Mut' + 'Lib'].go();</script>", expect: ALL() },
  { id: 'm-eval', pattern: 'eval with a built string', head: "<script>eval('Mut' + 'Lib.go()');</script>", expect: ALL() },
  { id: 'm-new-function', pattern: 'new Function with a built string', head: "<script>new Function('return Mut' + 'Lib')().go();</script>", expect: ALL() },
  { id: 'm-string-timer', pattern: 'string timer', head: '<script>setTimeout("MutLib.go()", 0);</script>', expect: ALL() },
  { id: 'm-with', pattern: 'with statement', head: '<script>with (window) { MutLib.go(); }</script>', expect: ALL() },
  { id: 'm-alias', pattern: 'window alias', head: '<script>var w = window; w.MutLib.go();</script>', expect: ALL() },
  { id: 'm-globalthis', pattern: 'globalThis and self access', head: '<script>globalThis.MutLib.go(); self.MutLib.go();</script>', expect: ALL() },
  { id: 'm-onclick', pattern: 'inline onclick attribute', body: '<button id="b" onclick="MutLib.go()">Go</button>', expect: ALL() },
  { id: 'm-late-injected', pattern: 'script injected late that reads the global at once', head: "<script>var s = document.createElement('script'); s.src = 'consumer.js'; document.head.appendChild(s);</script>", extraFiles: { '/consumer.js': 'MutLib.go();' }, expect: ALL() },
  { id: 'm-document-write-consumer', pattern: 'document.write of a dependent script', head: "<script>document.write('<script src=\"consumer.js\"><\\/script>');</script>", extraFiles: { '/consumer.js': 'MutLib.go();' }, expect: ALL() },
  { id: 'm-document-write-lib', pattern: 'library that calls document.write', lib: "document.write('<p id=\"w\">written</p>'); window.MutLib = { go: function () {} };", expect: ALL() },
  { id: 'm-wp-hooks', pattern: 'wp.hooks callbacks', lib: 'window.wp = window.wp || {}; window.wp.hooks = { actions: {}, addAction: function (n, ns, f) { (this.actions[n] = this.actions[n] || []).push(f); }, doAction: function (n) { (this.actions[n] || []).forEach(function (f) { f(); }); } };', head: "<script>wp.hooks.addAction('init', 'mut', function () { document.title = 'hooked'; }); wp.hooks.doAction('init');</script>", expect: ALL() },
  { id: 'm-jquery-window-load', pattern: "jQuery(window).on('load')", lib: 'window.jQuery = window.$ = function (x) { return { on: function (ev, f) { window.addEventListener(ev, f); return this; } }; };', head: "<script>jQuery(window).on('load', function () { document.body.dataset.loaded = '1'; });</script>", expect: ALL() },
  { id: 'm-shopify-theme-global', pattern: 'Shopify theme globals', lib: 'window.Shopify = window.Shopify || {}; Shopify.theme = { name: "Horizon", role: "main" };', head: '<script>document.documentElement.dataset.theme = Shopify.theme.role;</script>', expect: ALL() },
  { id: 'm-timer-read', pattern: 'global read inside a zero timer from a blocking script', head: '<script>setTimeout(function () { MutLib.go(); }, 0);</script>', expect: ALL() },
  { id: 'm-raf-read', pattern: 'global read inside requestAnimationFrame', head: '<script>requestAnimationFrame(function () { MutLib.go(); });</script>', expect: ALL() },
  { id: 'm-dcl-listener-lib', pattern: 'library that only starts on DOMContentLoaded (async or delay misses the event)', lib: "document.addEventListener('DOMContentLoaded', function () { document.body.dataset.started = '1'; });", expect: { 'async:/lib.js': NOT_SAFE, 'delay:/lib.js': NOT_SAFE } },
  { id: 'm-listener-lib', pattern: 'library that handles a click (remove breaks it)', lib: "document.addEventListener('DOMContentLoaded', function () { document.getElementById('b').addEventListener('click', function mutClick() { document.body.dataset.clicked = '1'; }); });", body: '<button id="b">Go</button>', expect: { 'remove:/lib.js': NOT_SAFE } },
  { id: 'm-deferred-before', pattern: 'deferred dependent placed before the library', head: '', body: '', extraFiles: { '/consumer.js': 'MutLib.go();' }, libAttrs: '', expect: { 'defer:/lib.js': NOT_SAFE } },
];
// the deferred dependent sits in the head before the library tag
MUTATIONS.find((m) => m.id === 'm-deferred-before')!.head = '';

/** Truly safe changes (recall controls). */
export const CONTROLS: MutationCase[] = [
  { id: 'c-dcl-dependent', pattern: 'dependent waits for DOMContentLoaded in a later deferred script', extraFiles: { '/consumer.js': "document.addEventListener('DOMContentLoaded', function () { MutLib.go(); });" }, body: '<script src="consumer.js" defer></script>', expect: { 'defer:/lib.js': ['safe'] } },
  { id: 'c-independent', pattern: 'independent script, no globals, waits for DOMContentLoaded', lib: "document.addEventListener('DOMContentLoaded', function () { var e = document.getElementById('y'); if (e) e.textContent = '2026'; });", body: '<span id="y"></span>', expect: { 'defer:/lib.js': ['safe'] } },
  { id: 'c-unused', pattern: 'unused library', lib: '(function (r) { r.MutUnused = { a: 1 }; })(window);', expect: { 'remove:/lib.js': ['safe'], 'defer:/lib.js': ['safe'], 'async:/lib.js': ['safe'] } },
  { id: 'c-widget', pattern: 'third-party widget with its own UI', lib: "(function () { var b = document.createElement('div'); b.id = 'mut-bubble'; b.textContent = 'Chat'; document.body.appendChild(b); })();", libAttrs: '', expect: { 'delay:/lib.js': ['safe'] } },
];

function page(c: MutationCase, libOrigin: string): string {
  const lib = `<script src="${libOrigin}/lib.js"${c.libAttrs ? ` ${c.libAttrs}` : ''}></script>`;
  const before = c.id === 'm-deferred-before' ? '<script src="consumer.js" defer></script>' : '';
  const widgetAtEnd = c.id === 'c-widget';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${c.id}</title>${before}${widgetAtEnd ? '' : lib}${c.head ?? ''}</head><body><h1>${c.pattern}</h1>${c.body ?? ''}${widgetAtEnd ? lib : ''}</body></html>`;
}

export interface MutationServer {
  origin: string;
  libOrigin: string;
  urlFor(id: string): string;
  close(): Promise<void>;
}

/** Serves every case at /<id>/ on localhost and the libraries on 127.0.0.1 (another origin). */
export async function startMutationServer(cases: MutationCase[] = [...MUTATIONS, ...CONTROLS]): Promise<MutationServer> {
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const [, id, ...rest] = u.pathname.split('/');
    const c = cases.find((x) => x.id === id);
    const file = '/' + rest.join('/');
    const send = (type: string, body: string) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (!c) {
      res.writeHead(404).end();
      return;
    }
    if (file === '/' || file === '') return send('text/html; charset=utf-8', page(c, `http://127.0.0.1:${port}/${c.id}`));
    if (file === '/lib.js') return send('application/javascript', c.lib ?? LIB);
    const extra = c.extraFiles?.[file];
    if (extra !== undefined) return send('application/javascript', extra);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', () => r()));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://localhost:${port}`,
    libOrigin: `http://127.0.0.1:${port}`,
    urlFor: (id) => `http://localhost:${port}/${id}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
