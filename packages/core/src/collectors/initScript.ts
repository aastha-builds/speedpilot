/**
 * Runs in the page before any page script (Playwright addInitScript). Records what Lighthouse 13 no longer reports
 * and what the traces need: LCP entries, layout shifts with sources, Long Animation Frames with script attribution,
 * Event Timing entries, document.write, non-passive scroll/touch listeners, CSP violations.
 * Plain ES2017, no dependencies. Never changes page behaviour.
 */
export const COLLECTOR_INIT_SCRIPT = String.raw`
(function () {
  if (window.__sp) return;
  var sp = window.__sp = { lcp: [], shifts: [], loaf: [], events: [], longtasks: [], docWrite: [], listeners: [], csp: [], t0: Date.now() };
  function sel(n) {
    try {
      if (!n || n.nodeType !== 1) return n && n.nodeName ? n.nodeName.toLowerCase() : null;
      if (n.id) return '#' + n.id;
      var parts = [];
      var cur = n;
      for (var i = 0; cur && cur.nodeType === 1 && i < 4; i++) {
        var p = cur.nodeName.toLowerCase();
        if (cur.id) { parts.unshift('#' + cur.id); break; }
        var cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) p += '.' + cls.join('.');
        parts.unshift(p);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return null; }
  }
  sp.sel = sel;
  function callerUrl() {
    try {
      var st = new Error().stack || '';
      var lines = st.split('\n').slice(2);
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
        if (m) return { url: m[1], line: +m[2], col: +m[3] };
      }
    } catch (e) {}
    return null;
  }
  sp.callerUrl = callerUrl;
  function obs(type, cb, extra) {
    try {
      var o = new PerformanceObserver(function (list) { list.getEntries().forEach(cb); });
      var opts = { type: type, buffered: true };
      for (var k in extra || {}) opts[k] = extra[k];
      o.observe(opts);
    } catch (e) {}
  }
  obs('largest-contentful-paint', function (e) {
    sp.lcp.push({ startTime: e.startTime, renderTime: e.renderTime, loadTime: e.loadTime, size: e.size, url: e.url || null, selector: sel(e.element), tag: e.element ? e.element.nodeName.toLowerCase() : null });
  });
  obs('layout-shift', function (e) {
    if (e.hadRecentInput) return;
    sp.shifts.push({ value: e.value, startTime: e.startTime, sources: (e.sources || []).map(function (s) {
      return { selector: sel(s.node), tag: s.node && s.node.nodeName ? s.node.nodeName.toLowerCase() : null, previousRect: s.previousRect && { y: s.previousRect.y, h: s.previousRect.height }, currentRect: s.currentRect && { y: s.currentRect.y, h: s.currentRect.height } };
    }) });
  });
  obs('long-animation-frame', function (e) {
    sp.loaf.push({ startTime: e.startTime, duration: e.duration, blockingDuration: e.blockingDuration, renderStart: e.renderStart, styleAndLayoutStart: e.styleAndLayoutStart, scripts: (e.scripts || []).map(function (s) {
      return { sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName, sourceCharPosition: s.sourceCharPosition, invoker: s.invoker, invokerType: s.invokerType, duration: s.duration, startTime: s.startTime, forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration };
    }) });
  });
  obs('longtask', function (e) { sp.longtasks.push({ startTime: e.startTime, duration: e.duration }); });
  obs('event', function (e) {
    sp.events.push({ name: e.name, interactionId: e.interactionId || 0, startTime: e.startTime, duration: e.duration, processingStart: e.processingStart, processingEnd: e.processingEnd, target: sel(e.target) });
  }, { durationThreshold: 16 });
  try {
    var dw = document.write, dwl = document.writeln;
    document.write = function () { sp.docWrite.push({ caller: callerUrl(), bytes: String(arguments[0] || '').length }); return dw.apply(document, arguments); };
    document.writeln = function () { sp.docWrite.push({ caller: callerUrl(), bytes: String(arguments[0] || '').length }); return dwl.apply(document, arguments); };
  } catch (e) {}
  try {
    var ael = EventTarget.prototype.addEventListener;
    var watch = { scroll: 1, wheel: 1, mousewheel: 1, touchstart: 1, touchmove: 1 };
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (watch[type]) {
        var passive = typeof opts === 'object' && opts !== null && opts.passive === true;
        var src = '';
        try { src = String(fn).slice(0, 400); } catch (e) {}
        var prevents = /preventDefault/.test(src);
        sp.listeners.push({ type: type, passive: passive, preventsDefault: prevents, target: this === window ? 'window' : this === document ? 'document' : sel(this), caller: callerUrl() });
      }
      return ael.apply(this, arguments);
    };
  } catch (e) {}
  // DOC-03: full-screen overlays present at DOMContentLoaded (preloaders are usually gone by load)
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var c = document.querySelectorAll('body *');
      for (var i = 0; i < c.length && i < 400; i++) {
        var el = c[i];
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        var r = el.getBoundingClientRect();
        if (r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) { sp.overlayAtDcl = { selector: sel(el), z: cs.zIndex }; break; }
      }
    } catch (e) {}
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    sp.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
  });
})();
`;
