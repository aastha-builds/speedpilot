import { describe, it, expect } from 'vitest';
import { analyzeJs, analyzeInlineHandler } from './js.js';

describe('static JS analysis', () => {
  it('finds globals defined and read, scope-aware', () => {
    const f = analyzeJs(`var A = 1; function B(){ var local = C; return local + D.x; } window.E = 2; F = 3; (function(){ var G = 4; H(); })(); let I = 5;`);
    expect(f.definesGlobals).toEqual(['A', 'B', 'E', 'F', 'I']);
    expect(f.readsGlobals).toEqual(['C', 'D', 'H']);
    expect(f.readsGlobalsImmediately).toEqual(['H']);
  });
  it('jQuery plugins and dependencies', () => {
    const lib = analyzeJs(`(function($){ $.fn.spfSlider = function(){}; $.fn.extend({ other: function(){} }); })(window.jQuery);`);
    expect(lib.registersJqPlugins).toEqual(['other', 'spfSlider']);
    expect(lib.readsGlobals).toContain('jQuery');
    const inline = analyzeJs(`jQuery(function($){ $('.hero').addClass('x'); window.ok = typeof $.fn.spfSlider === 'function'; $('.x').spfSlider(); });`);
    expect(inline.readsGlobalsImmediately).toContain('jQuery');
    expect(inline.usesJqMembers).toContain('spfSlider');
    expect(inline.waitsForDomReady).toBe(true);
  });
  it('flags everything it cannot see as dynamic', () => {
    expect(analyzeJs(`window['jQ' + 'uery'].x()`).dynamic).toBe(true);
    expect(analyzeJs(`eval('x')`).dynamic).toBe(true);
    expect(analyzeJs(`setTimeout("doIt()", 10)`).dynamic).toBe(true);
    expect(analyzeJs(`new Function('a', 'return a')`).dynamic).toBe(true);
    expect(analyzeJs(`with (obj) { x = 1 }`).dynamic).toBe(true);
    expect(analyzeJs(`import('./x.js')`).dynamic).toBe(true);
    expect(analyzeJs(`this is not js`).dynamic).toBe(true);
    expect(analyzeJs(`document.addEventListener('DOMContentLoaded', function(){ document.getElementById('a').textContent = 'x'; });`).dynamic).toBe(false);
  });
  it('collects selectors, events, endpoints, timers and document.write', () => {
    const f = analyzeJs(`document.querySelector('.menu'); document.getElementById('x'); el.addEventListener('click', h); $(document).on('click touchstart', '.b', h); fetch('/wp-json/x'); setInterval(poll, 5000); document.write('<p>'); var r = new XMLHttpRequest(); r.open('GET', '/a', false);`);
    expect(f.selectors).toEqual(expect.arrayContaining(['.menu', '#x']));
    expect(f.eventTypes).toEqual(expect.arrayContaining(['click', 'touchstart']));
    expect(f.endpoints).toEqual(expect.arrayContaining(['/wp-json/x', '/a']));
    expect(f.timers.setInterval).toBe(1);
    expect(f.documentWrite).toBe(true);
    expect(f.syncXhr).toBe(true);
  });
  it('analyzes inline handlers', () => {
    expect(analyzeInlineHandler('openChat(event)').reads).toEqual(['openChat']);
  });
});

describe('global object aliases', () => {
  it('treats reads through window aliases as global reads', () => {
    expect(analyzeJs('var w = window; w.MutLib.go();').readsGlobals).toContain('MutLib');
    expect(analyzeJs('(function (root) { root.Foo.bar(); })(window);').readsGlobals).toContain('Foo');
    expect(analyzeJs('(function (e) { e.Bar = 1; })(this);').definesGlobals).toContain('Bar');
    expect(analyzeJs('var g = typeof globalThis !== "undefined" ? globalThis : self; g.Baz();').readsGlobals).toContain('Baz');
  });
  it('does not confuse a shadowing inner variable with the alias', () => {
    const f = analyzeJs('(function (e, t) { e.Cookies = t(); })(this, function () { function x(e, k) { return e[k]; } return { x: x }; });');
    expect(f.definesGlobals).toContain('Cookies');
    expect(f.dynamicReasons).not.toContain('dynamic global access (window[expr])');
  });
  it('flags computed access through an alias as dynamic', () => {
    expect(analyzeJs("var w = window; w['Mut' + 'Lib'].go();").dynamicReasons).toContain('dynamic global access (window[expr])');
  });
});
