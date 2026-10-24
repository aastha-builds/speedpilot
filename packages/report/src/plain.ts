/** Plain-language text from templates (no paid API calls, SPEC.md 9.3). */
import type { Finding } from '@speedpilot/core';

const PLAIN: Record<string, string> = {
  'IMG-01': 'The main picture at the top of the page is told to load late, so phones wait for it.',
  'SHT-07': 'The main picture at the top of the page is told to load late, so phones wait for it.',
  'WPF-15': 'WordPress marks the main picture as "load later", which delays what visitors see first.',
  'IMG-03': 'Pictures are much bigger than the space they are shown in, so phones download extra data.',
  'IMG-06': 'Pictures have no reserved space, so the page jumps around while they load.',
  'IMG-07': 'Pictures far down the page load immediately instead of when the visitor scrolls to them.',
  'IMG-10': 'The slider loads every slide up front, even the ones nobody sees yet.',
  'DOC-03': 'A loading screen hides the whole page until everything has finished loading.',
  'DOC-04': 'The headline and main picture fade in with an animation, so they appear later than they could.',
  'DOC-05': 'Files in the page header block the page from showing anything until they arrive.',
  'JS-01': 'Scripts in the page header stop the browser from showing the page until they run.',
  'SHT-02': 'Scripts in the theme header stop the browser from showing the page until they run.',
  'JS-02': 'Much of the JavaScript the page downloads is never used on that page.',
  'JS-03': 'Scripts keep the phone busy while the page loads, so taps feel slow.',
  'JS-04': 'Some buttons take too long to respond when tapped on a phone.',
  'CSS-02': 'Most of the style rules downloaded are not used on the page.',
  'FONT-01': 'The site loads more font weights than the pages actually use.',
  'FONT-02': 'Fonts are fetched from Google’s servers instead of the site itself.',
  'VID-02': 'The embedded video loads its full player before anyone presses play.',
  '3P-04': 'The chat widget loads on every page before anyone opens it.',
  '3P-01': 'Outside services (chat, analytics, embeds) take a measurable share of loading time.',
  'WPF-06': 'The contact form’s files load on every page, not just the page with the form.',
  'WPF-07': 'Shop files (cart, add to cart) load on pages that have nothing to do with the shop.',
  'WPF-11': 'The slider plugin’s files load on every page, even pages without a slider.',
  'WPB-04': 'The database loads a large pile of settings on every single page view, slowing the server.',
  'WPB-12': 'A slow database query runs while the page is being built.',
  'WPB-13': 'The theme asks the database for far more than it needs (all posts, in random order).',
  'WPB-16': 'The page makes extra background requests to the server on every visit.',
  'SHT-09': 'Part of the theme code does a lot of work for every visitor before the page is sent.',
  'SHA-03': 'Code from an app that is no longer installed is still in the theme.',
  'SHA-02': 'An app that is not used anymore is still switched on in the theme settings.',
  'SHA-09': 'Shopify adds its own scripts to every store page; these cannot be changed and set part of the ceiling.',
  'CLS-03': 'A banner appears after the page has loaded and pushes the content down.',
  'NET-01': 'The server takes too long to start sending the page.',
  'NET-04': 'Text files are sent without compression.',
};

export function plainTitle(f: Pick<Finding, 'checkId' | 'title'>): string {
  return PLAIN[f.checkId] ?? f.title;
}

export function costPhrase(g: Finding['estimatedGain']): string {
  const parts: string[] = [];
  if (g.lcpMs && g.lcpMs >= 50) parts.push(`about ${(g.lcpMs / 1000).toFixed(1)} s on the main content`);
  if (g.inpMs && g.inpMs >= 20) parts.push(`about ${Math.round(g.inpMs)} ms on tap responses`);
  if (g.tbtMs && g.tbtMs >= 20) parts.push(`about ${Math.round(g.tbtMs)} ms of blocked time`);
  if (g.cls && g.cls >= 0.01) parts.push(`${g.cls.toFixed(2)} of layout shift`);
  if (g.ttfbMs && g.ttfbMs >= 20) parts.push(`about ${Math.round(g.ttfbMs)} ms of server time`);
  if (g.bytes && g.bytes >= 20 * 1024) parts.push(`about ${Math.round(g.bytes / 1024)} KB of downloads`);
  return parts.length ? parts.join(', ') : 'a small but measurable cost';
}

export const TIER_TEXT: Record<string, string> = {
  T1: 'low risk, reversible',
  T2: 'medium risk: tested on staging with full verification',
  T3: 'needs your written approval',
  report: 'information only',
};

export function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function num(v: number | null | undefined, d = 0): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d);
}
