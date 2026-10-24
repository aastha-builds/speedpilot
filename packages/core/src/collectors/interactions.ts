import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import type { Session } from './browser.js';
import { ownerOf, type Owner, type OwnerContext } from './owners.js';
import type { Template } from './inventory.js';

const require = createRequire(import.meta.url);

export interface InteractionStep {
  name: string;
  /** Safe on production: never submits, logs out, buys, pays, deletes or subscribes (CLAUDE.md rule 12). */
  safeOnProduction: boolean;
  run(page: Page): Promise<boolean>;
}

export interface InpResult {
  name: string;
  ran: boolean;
  inp: number | null;
  inputDelay: number | null;
  processing: number | null;
  presentation: number | null;
  target: string | null;
  scripts: Array<{ sourceURL: string; sourceFunctionName: string; invoker: string; duration: number; owner: Owner }>;
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const s of selectors) {
    const el = page.locator(s).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      return el.click({ timeout: 5000, noWaitAfter: true }).then(
        () => true,
        () => false,
      );
    }
  }
  return false;
}

async function typeFirst(page: Page, selectors: string[], text: string): Promise<boolean> {
  for (const s of selectors) {
    const el = page.locator(s).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 2000 }).catch(() => {});
      await el.pressSequentially(text, { delay: 60 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** The scripted interaction library (SPEC.md 3.4). */
export const INTERACTIONS: Record<string, InteractionStep> = {
  mobileMenu: { name: 'open mobile menu', safeOnProduction: true, run: (p) => clickFirst(p, ['.menu-toggle', '.header__menu-toggle', 'button[aria-controls*="menu" i]', '.mobile-menu-toggle', '.hamburger', 'button[aria-label*="menu" i]', 'summary[aria-label*="menu" i]']) },
  accordion: { name: 'open accordion or tab', safeOnProduction: true, run: (p) => clickFirst(p, ['details summary', '[role="tab"]', '.accordion button', '.elementor-tab-title', '.wc-tabs a']) },
  heavyButton: { name: 'click primary page button', safeOnProduction: true, run: (p) => clickFirst(p, ['#heavy-button', 'main button[type="button"]:not([aria-controls*="menu" i])']) },
  variant: {
    name: 'select a variant',
    safeOnProduction: true,
    run: async (p) => {
      const sel = p.locator('select[name="id"], select[data-variant-select], table.variations select, variant-selects select').first();
      if (!(await sel.count())) return clickFirst(p, ['variant-selects input[type="radio"] + label', '.swatch label']);
      const opts = await sel.locator('option').all();
      const val = opts.length > 1 ? await opts[opts.length - 1]!.getAttribute('value') : null;
      if (val) await sel.selectOption(val).catch(() => {});
      return !!val;
    },
  },
  quantity: { name: 'change quantity', safeOnProduction: true, run: (p) => clickFirst(p, ['button[name="plus"]', '.quantity__button[name="plus"]', '.qty-plus', '.plus']) },
  addToCart: { name: 'add to cart', safeOnProduction: true, run: (p) => clickFirst(p, ['[data-add-to-cart]', 'button[name="add"]', '.single_add_to_cart_button', '.add_to_cart_button']) },
  cartDrawer: { name: 'open cart drawer', safeOnProduction: true, run: (p) => clickFirst(p, ['#cart-icon-bubble', '.header__cart', '.cart-link', 'a[href$="/cart"]']) },
  search: { name: 'type in search', safeOnProduction: true, run: (p) => typeFirst(p, ['input[type="search"]', 'input[name="s"]', 'input[name="q"]', '[data-predictive-search]'], 'shirt') },
  filter: { name: 'apply a filter', safeOnProduction: true, run: (p) => clickFirst(p, ['.facets input[type="checkbox"]', '.wc-block-components-checkbox input', '.widget_layered_nav a']) },
  chatFacade: { name: 'open chat or popup facade', safeOnProduction: true, run: (p) => clickFirst(p, ['#chat-bubble', '.chat-bubble', '[data-chat-facade]']) },
  sliderNext: { name: 'next slide', safeOnProduction: true, run: (p) => clickFirst(p, ['.n2-next', '.swiper-button-next', '.slick-next', '.flickity-button.next', 'button[aria-label*="next" i]']) },
  submitForm: { name: 'submit a form (staging only)', safeOnProduction: false, run: (p) => clickFirst(p, ['form.wpcf7-form input[type="submit"]', 'form button[type="submit"]']) },
};

export function interactionsFor(template: Template, stage: 'local' | 'staging' | 'production'): InteractionStep[] {
  const base = ['mobileMenu', 'accordion', 'heavyButton', 'search', 'chatFacade', 'sliderNext'];
  const byTemplate: Partial<Record<Template, string[]>> = {
    product: ['variant', 'quantity', 'addToCart', 'cartDrawer'],
    collection: ['filter'],
    shop: ['filter', 'addToCart'],
    contact: stage === 'production' ? [] : ['submitForm'],
  };
  const names = [...base, ...(byTemplate[template] ?? [])];
  return names.map((n) => INTERACTIONS[n]!).filter((s) => stage !== 'production' || s.safeOnProduction);
}

let webVitalsSrc: string | undefined;
function webVitalsAttribution(): string {
  webVitalsSrc ??= readFileSync(join(dirname(require.resolve('web-vitals')), 'web-vitals.attribution.iife.js'), 'utf8');
  return webVitalsSrc;
}

/**
 * Runs scripted interactions with 4x CPU slowdown on a mobile viewport and records INP per interaction with its
 * attribution (SPEC.md 3.4): input delay, processing, presentation and the scripts responsible (LoAF).
 * Uses the web-vitals attribution build for the page-level INP and Event Timing for each interaction.
 */
export async function measureInteractions(session: Session, url: string, steps: InteractionStep[], ownerCtx: OwnerContext, cpuSlowdown = 4): Promise<{ pageInp: number | null; pageInpAttribution: unknown; interactions: InpResult[] }> {
  const page = await session.newPage();
  await page.addInitScript(webVitalsAttribution());
  await page.addInitScript(`window.__spInp=[];addEventListener('DOMContentLoaded',function(){ if(window.webVitals){ webVitals.onINP(function(m){ window.__spInp.push({value:m.value, attribution:{ interactionTarget:m.attribution.interactionTarget, inputDelay:m.attribution.inputDelay, processingDuration:m.attribution.processingDuration, presentationDelay:m.attribution.presentationDelay, longAnimationFrameEntries:(m.attribution.longAnimationFrameEntries||[]).length }}); }, { reportAllChanges: true }); } });`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
  const settle = async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    // wait for late images and injected content so targets stop moving
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  };
  await settle();
  const results: InpResult[] = [];
  let first = true;
  for (const step of steps) {
    // every interaction starts from a freshly loaded page, so one step's open menu cannot block the next
    if (!first) await settle();
    first = false;
    const before = await page.evaluate(() => performance.now());
    const ran = await step.run(page).catch(() => false);
    await page.waitForTimeout(ran ? 800 : 50);
    if (!ran) {
      results.push({ name: step.name, ran: false, inp: null, inputDelay: null, processing: null, presentation: null, target: null, scripts: [] });
      continue;
    }
    const data = await page.evaluate((since: number) => {
      const sp = (window as unknown as { __sp?: { events: Array<{ name: string; interactionId: number; startTime: number; duration: number; processingStart: number; processingEnd: number; target: string | null }>; loaf: Array<{ startTime: number; duration: number; scripts: Array<{ sourceURL: string; sourceFunctionName: string; invoker: string; duration: number }> }> } }).__sp;
      const evs = (sp?.events ?? []).filter((e) => e.interactionId && e.startTime >= since - 5);
      if (!evs.length) return null;
      const worst = evs.reduce((a, b) => (b.duration > a.duration ? b : a));
      const end = worst.startTime + worst.duration;
      const frames = (sp?.loaf ?? []).filter((f) => f.startTime < end && f.startTime + f.duration > worst.startTime);
      return { worst, scripts: frames.flatMap((f) => f.scripts) };
    }, before);
    if (!data) {
      // no event timing entry above 16 ms: a fast interaction
      results.push({ name: step.name, ran: true, inp: 16, inputDelay: null, processing: null, presentation: null, target: null, scripts: [] });
    } else {
      const w = data.worst;
      results.push({
        name: step.name,
        ran: true,
        inp: Math.round(w.duration),
        inputDelay: Math.round(w.processingStart - w.startTime),
        processing: Math.round(w.processingEnd - w.processingStart),
        presentation: Math.round(w.startTime + w.duration - w.processingEnd),
        target: w.target,
        scripts: data.scripts.map((s) => ({ ...s, duration: Math.round(s.duration), owner: ownerOf(s.sourceURL || url, ownerCtx) })),
      });
    }
  }
  // web-vitals reports INP when the page is hidden
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  const wv = (await page.evaluate(() => (window as unknown as { __spInp: Array<{ value: number; attribution: unknown }> }).__spInp)) ?? [];
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.close();
  const lastWv = wv[wv.length - 1];
  const measured = results.filter((r) => r.inp !== null).map((r) => r.inp!);
  return { pageInp: lastWv?.value ?? (measured.length ? Math.max(...measured) : null), pageInpAttribution: lastWv?.attribution ?? null, interactions: results };
}
