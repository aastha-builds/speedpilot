/**
 * Exploration (SPEC.md 15.2): find interactive elements and exercise them so coverage reflects real use.
 * On staging and local copies the full list runs; on production only the safe list runs, and never anything that
 * submits a form, logs out, buys, pays, deletes or subscribes (CLAUDE.md rule 12).
 */
import type { Page } from 'playwright';

export interface Candidate {
  index: number;
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  kind: 'menu-toggle' | 'tab' | 'accordion' | 'carousel' | 'details' | 'expander' | 'button' | 'link' | 'form-control' | 'other';
  insideForm: boolean;
  isSubmit: boolean;
  href: string | null;
}

export interface ExploreStep {
  selector: string;
  kind: Candidate['kind'];
  label: string;
  allowed: boolean;
  reason: string;
  ran: boolean;
  error?: string;
  /** performance.now() just before the click and after the settle wait (for handler timing). */
  t0?: number;
  t1?: number;
}

/** Words that mark an action as one SpeedPilot must never trigger on production. */
export const TRAP = /\b(buy|pay|payment|checkout|purchase|order|place order|delete|remove|trash|destroy|log ?out|sign ?out|subscribe|unsubscribe|submit|send|book|donate|cancel|confirm|register|sign ?up|join|apply|contact us|request|reset|clear cart|empty cart)\b/i;

export function classify(c: Candidate, stage: 'local' | 'staging' | 'production'): { allowed: boolean; reason: string } {
  const text = `${c.label} ${c.href ?? ''}`;
  if (stage === 'production') {
    if (c.isSubmit || (c.insideForm && c.tag !== 'summary' && c.kind !== 'tab' && c.kind !== 'accordion')) return { allowed: false, reason: 'inside a form or submits one' };
    if (TRAP.test(text)) return { allowed: false, reason: `trap word in "${text.trim().slice(0, 40)}"` };
    if (c.href && !/^#/.test(c.href) && c.tag === 'a') return { allowed: false, reason: 'navigates away' };
    if (['menu-toggle', 'tab', 'accordion', 'carousel', 'details', 'expander'].includes(c.kind)) return { allowed: true, reason: `safe list: ${c.kind}` };
    return { allowed: false, reason: 'not on the safe list' };
  }
  // staging and local copies: full exploration, but never log out (it would end the session) or leave the page
  if (/log ?out|sign ?out/i.test(text)) return { allowed: false, reason: 'logs out' };
  if (c.href && !/^#/.test(c.href) && c.tag === 'a') return { allowed: false, reason: 'navigates away' };
  if (c.isSubmit) return { allowed: false, reason: 'submits a form (flows cover forms on staging)' };
  return { allowed: true, reason: 'staging: full exploration' };
}

/** Lists interactive elements, in document order, from the DOM and ARIA attributes. */
export async function candidates(page: Page, max = 60): Promise<Candidate[]> {
  return page.evaluate((max) => {
    const out: Candidate[] = [];
    const sel = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      for (let i = 0; cur && i < 4 && cur !== document.body; i++) {
        let p = cur.tagName.toLowerCase();
        if (cur.id) {
          parts.unshift(`#${CSS.escape(cur.id)}`);
          break;
        }
        const cls = Array.from(cur.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        p += cls;
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(p);
        cur = parent;
      }
      return parts.join(' > ');
    };
    const els = Array.from(document.querySelectorAll('button, a[href], summary, [role="button"], [role="tab"], [aria-expanded], [aria-controls], [onclick], input[type="submit"], input[type="button"], select'));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const label = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || '').trim().slice(0, 80);
      const cls = `${el.className} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
      const role = el.getAttribute('role');
      let kind: Candidate['kind'] = 'other';
      if (el.tagName === 'SUMMARY') kind = 'details';
      else if (role === 'tab') kind = 'tab';
      else if (/menu|nav|hamburger|burger|drawer-toggle/.test(cls) || /menu/i.test(el.getAttribute('aria-controls') ?? '')) kind = 'menu-toggle';
      else if (/next|prev|arrow|swiper-button|slick-(next|prev)|carousel|slide/.test(cls)) kind = 'carousel';
      else if (/accordion|collapse|toggle/.test(cls)) kind = 'accordion';
      else if (el.hasAttribute('aria-expanded')) kind = 'expander';
      else if (el.tagName === 'A') kind = 'link';
      else if (el.tagName === 'SELECT' || el.tagName === 'INPUT') kind = 'form-control';
      else if (el.tagName === 'BUTTON' || role === 'button') kind = 'button';
      const form = el.closest('form');
      const type = (el.getAttribute('type') ?? (el.tagName === 'BUTTON' && form ? 'submit' : '')).toLowerCase();
      out.push({ index: out.length, selector: sel(el), tag: el.tagName.toLowerCase(), role, label, kind, insideForm: !!form, isSubmit: type === 'submit', href: el.getAttribute('href') });
      if (out.length >= max) break;
    }
    return out;
  }, max);
}

/** Runs the allowed candidates one by one; `afterEach` takes coverage deltas per interaction state. */
export async function explore(page: Page, stage: 'local' | 'staging' | 'production', afterEach?: (step: ExploreStep) => Promise<void>, max = 25): Promise<ExploreStep[]> {
  const list = await candidates(page);
  const steps: ExploreStep[] = [];
  const startUrl = page.url();
  for (const c of list) {
    const { allowed, reason } = classify(c, stage);
    const step: ExploreStep = { selector: c.selector, kind: c.kind, label: c.label, allowed, reason, ran: false };
    steps.push(step);
    if (!allowed || steps.filter((s) => s.ran).length >= max) continue;
    try {
      step.t0 = await page.evaluate(() => performance.now()).catch(() => undefined);
      await page.locator(c.selector).first().click({ timeout: 2000, noWaitAfter: true, trial: false });
      step.ran = true;
      await page.waitForTimeout(250);
      step.t1 = await page.evaluate(() => performance.now()).catch(() => undefined);
      if (page.url().split('#')[0] !== startUrl.split('#')[0]) {
        await page.goBack({ waitUntil: 'load' }).catch(() => page.goto(startUrl, { waitUntil: 'load' }));
      }
      await page.keyboard.press('Escape').catch(() => {});
    } catch (e) {
      step.error = (e as Error).message.split('\n')[0];
    }
    if (afterEach) await afterEach(step);
  }
  return steps;
}
