/**
 * Read-only page probe for the optimization engines: image natural and rendered sizes, fonts in use, first-screen
 * elements hidden by entrance animations (DOC-04), elements inserted after load that push content down (CLS-03), and
 * the CSS rules the first screen uses (critical CSS, generated on staging or locally).
 */
import { launchBrowser, releaseBrowser, openSession, type Device } from '@speedpilot/core';

export interface ProbeImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  hasDimensions: boolean;
  loading: string | null;
  fetchpriority: string | null;
  inFirstViewport: boolean;
  index: number;
}

export interface ProbeFont {
  family: string;
  weight: string;
  style: string;
  status: string;
}

export interface ProbeResult {
  url: string;
  device: Device;
  viewport: { width: number; height: number };
  images: ProbeImage[];
  iframes: Array<{ src: string; title: string | null }>;
  fontsLoaded: ProbeFont[];
  fontFaceRules: Array<{ family: string; weight: string; style: string; src: string; display: string; sheet: string }>;
  /** First-screen elements that were invisible (opacity 0 or offset) at DOMContentLoaded and became visible later. */
  hiddenAtStart: Array<{ selector: string; reason: string }>;
  /** Elements inserted after load at the top of the page with their height (CLS-03). */
  lateInserted: Array<{ selector: string; height: number; position: 'top' | 'other' }>;
  /** Full-screen overlays removed on load (DOC-03). */
  preloaders: string[];
  criticalCss: string;
  consoleMessages: string[];
}

const PROBE_INIT = String.raw`
(function(){
  var st = window.__spProbe = { hidden: [], inserted: [] };
  function sel(el){ if(!el||!el.tagName) return null; if(el.id) return '#'+el.id; var c = (el.getAttribute('class')||'').trim().split(/\s+/).filter(Boolean).slice(0,2); return el.tagName.toLowerCase()+(c.length?'.'+c.join('.'):''); }
  document.addEventListener('DOMContentLoaded', function(){
    var vh = innerHeight;
    document.querySelectorAll('body *').forEach(function(el){
      var r = el.getBoundingClientRect(); if (r.top > vh || r.bottom < 0 || r.width === 0) return;
      var cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) === 0 || (cs.transform && cs.transform !== 'none' && /translate|matrix/.test(cs.transform) && el.className && /anim|fade|aos|wow|reveal/i.test(el.className))) st.hidden.push({ el: el, reason: parseFloat(cs.opacity) === 0 ? 'opacity 0 until a script runs' : 'offset until a script runs' });
    });
  });
  addEventListener('load', function(){
    new MutationObserver(function(list){ list.forEach(function(m){ m.addedNodes.forEach(function(n){ if (n.nodeType === 1 && n.getBoundingClientRect) st.inserted.push(n); }); }); }).observe(document.body, { childList: true, subtree: false });
  });
  st.sel = sel;
})();`;

/** Rules used by elements in the first viewport (and @font-face, :root variables), from every same-origin sheet. */
function criticalCssInPage(): string {
  const vh = innerHeight * 1.2;
  const firstScreen = (sel: string): boolean => {
    try {
      const els = document.querySelectorAll(sel.replace(/::?(before|after|placeholder|selection|marker|-webkit-[\w-]+)/g, ''));
      for (let i = 0; i < els.length && i < 50; i++) {
        const r = els[i]!.getBoundingClientRect();
        if (r.top < vh && r.bottom >= 0) return true;
      }
    } catch {
      return false;
    }
    return false;
  };
  const out: string[] = [];
  const walk = (rules: CSSRuleList, into: string[]) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) {
        const sels = r.selectorText.split(',').map((s) => s.trim());
        if (sels.some((s) => s === ':root' || s === 'html' || s === 'body' || s === '*' || firstScreen(s))) into.push(r.cssText);
      } else if (r instanceof CSSMediaRule) {
        if (!window.matchMedia(r.conditionText).matches) continue;
        const inner: string[] = [];
        walk(r.cssRules, inner);
        if (inner.length) into.push(`@media ${r.conditionText}{${inner.join('')}}`);
      } else if (r instanceof CSSFontFaceRule) into.push(r.cssText);
      else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) {
        const inner: string[] = [];
        walk(r.cssRules, inner);
        if (inner.length) into.push(`@supports ${r.conditionText}{${inner.join('')}}`);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href && new URL(sheet.href).origin !== location.origin) continue;
      walk(sheet.cssRules, out);
    } catch {
      /* cross-origin */
    }
  }
  return out.join('\n');
}

export async function probePage(url: string, o: { device?: Device; local?: boolean } = {}): Promise<ProbeResult> {
  const browser = await launchBrowser();
  const session = await openSession(browser, { device: o.device ?? 'mobile', local: o.local ?? false, initScripts: [PROBE_INIT] });
  try {
    const page = await session.newPage();
    const consoleMessages: string[] = [];
    page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text().slice(0, 300)}`));
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => {
      const st = (window as unknown as { __spProbe: { hidden: Array<{ el: Element; reason: string }>; inserted: Element[]; sel(e: Element): string | null } }).__spProbe;
      const vh = innerHeight;
      const images = Array.from(document.images).map((img, index) => {
        const rect = img.getBoundingClientRect();
        return { src: img.currentSrc || img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, renderedWidth: Math.round(rect.width), hasDimensions: img.hasAttribute('width') && img.hasAttribute('height'), loading: img.getAttribute('loading'), fetchpriority: img.getAttribute('fetchpriority'), inFirstViewport: rect.top < vh && rect.bottom > 0, index };
      });
      const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({ src: f.getAttribute('data-speedpilot-src') || f.src, title: f.getAttribute('title') }));
      const fontsLoaded = Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status }));
      const fontFaceRules: Array<{ family: string; weight: string; style: string; src: string; display: string; sheet: string }> = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) if (rule instanceof CSSFontFaceRule) fontFaceRules.push({ family: rule.style.getPropertyValue('font-family').replace(/["']/g, ''), weight: rule.style.getPropertyValue('font-weight') || '400', style: rule.style.getPropertyValue('font-style') || 'normal', src: rule.style.getPropertyValue('src'), display: rule.style.getPropertyValue('font-display') || 'auto', sheet: sheet.href ?? 'inline' });
        } catch {
          /* cross-origin sheet without CORS */
        }
      }
      const hiddenAtStart = st.hidden.filter((h) => parseFloat(getComputedStyle(h.el).opacity) > 0).map((h) => ({ selector: st.sel(h.el) ?? '', reason: h.reason }));
      const lateInserted = st.inserted.map((el) => ({ selector: st.sel(el) ?? '', height: Math.round(el.getBoundingClientRect().height), position: (el.getBoundingClientRect().top < 5 ? 'top' : 'other') as 'top' | 'other' })).filter((x) => x.height > 0);
      const preloaders = Array.from(document.querySelectorAll('[id*="preload" i], [class*="preload" i], [id*="loader" i]')).filter((el) => getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden').map((el) => st.sel(el) ?? '');
      return { images, iframes, fontsLoaded, fontFaceRules, hiddenAtStart, lateInserted, preloaders, vw: innerWidth, vh };
    });
    const criticalCss = await page.evaluate(criticalCssInPage);
    return { url, device: o.device ?? 'mobile', viewport: { width: r.vw, height: r.vh }, images: r.images, iframes: r.iframes, fontsLoaded: r.fontsLoaded, fontFaceRules: r.fontFaceRules, hiddenAtStart: r.hiddenAtStart, lateInserted: r.lateInserted, preloaders: r.preloaders, criticalCss, consoleMessages };
  } finally {
    await session.close();
    await releaseBrowser();
  }
}
