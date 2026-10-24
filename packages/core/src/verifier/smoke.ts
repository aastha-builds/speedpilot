import type { Page } from 'playwright';
import type { SiteConfig, Flow, FlowStep } from '../config/site.js';
import { launchBrowser, releaseBrowser, openSession, type Device } from '../collectors/browser.js';

export interface FlowResult {
  name: string;
  pass: boolean;
  device: Device | 'tablet';
  detail: string;
  skipped?: boolean;
}

export interface SmokeResult {
  pass: boolean;
  pages: Array<{ url: string; status: number | null; pass: boolean; detail: string }>;
  flows: FlowResult[];
}

/** Rebases a production URL or a path onto another base (staging, a restore clone). */
export function rebase(url: string, base: string): string {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return new URL(u.pathname + u.search + u.hash, b).href;
  } catch {
    return new URL(url, base).href;
  }
}

const FATAL = /There has been a critical error|Fatal error<\/b>|Parse error<\/b>|Error establishing a database connection|Liquid (syntax )?error/i;

/** Runs one site.yaml flow (SPEC.md 6). Submitting steps run only on staging (CLAUDE.md rule 12). */
export async function runFlow(page: Page, flow: Flow, base: string, stage: 'local' | 'staging' | 'production'): Promise<{ pass: boolean; detail: string; skipped?: boolean }> {
  if ((flow.stagingOnly || flow.steps.some((s) => 'submit' in s)) && stage === 'production') return { pass: true, skipped: true, detail: 'staging-only flow skipped on production' };
  for (const [i, step] of flow.steps.entries()) {
    const at = `step ${i + 1} ${JSON.stringify(step)}`;
    try {
      await runStep(page, step, base);
    } catch (e) {
      return { pass: false, detail: `${at}: ${(e as Error).message.split('\n')[0]}` };
    }
  }
  return { pass: true, detail: `${flow.steps.length} steps` };
}

export async function runStep(page: Page, step: FlowStep, base: string): Promise<void> {
  const t = 10_000;
  if ('goto' in step) {
    const r = await page.goto(rebase(step.goto, base), { waitUntil: 'load', timeout: 60_000 });
    if (r && r.status() >= 400) throw new Error(`HTTP ${r.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } else if ('click' in step) {
    const el = page.locator(step.click).first();
    if (step.optional && !(await el.count())) return;
    await el.click({ timeout: t });
    await page.waitForTimeout(300);
  } else if ('fill' in step) await page.locator(step.fill).first().fill(step.value, { timeout: t });
  else if ('press' in step) await page.locator(step.press).first().press(step.key, { timeout: t });
  else if ('select' in step) await page.locator(step.select).first().selectOption(step.value, { timeout: t });
  else if ('hover' in step) await page.locator(step.hover).first().hover({ timeout: t });
  else if ('waitFor' in step) await page.locator(step.waitFor).first().waitFor({ state: step.state ?? 'visible', timeout: t });
  else if ('expectVisible' in step) await page.locator(step.expectVisible).first().waitFor({ state: 'visible', timeout: t });
  else if ('expectHidden' in step) await page.locator(step.expectHidden).first().waitFor({ state: 'hidden', timeout: t });
  else if ('expectText' in step) {
    const el = page.locator(step.expectText).first();
    await el.waitFor({ timeout: t });
    const end = Date.now() + t;
    for (;;) {
      const txt = (await el.textContent()) ?? '';
      if (txt.includes(step.text)) break;
      if (Date.now() > end) throw new Error(`expected "${step.text}", got "${txt.trim().slice(0, 80)}"`);
      await page.waitForTimeout(250);
    }
  } else if ('expectUrl' in step) {
    if (!page.url().includes(step.expectUrl)) throw new Error(`expected URL containing ${step.expectUrl}, got ${page.url()}`);
  } else if ('expectCount' in step) {
    const n = await page.locator(step.expectCount).count();
    if ((step.min !== undefined && n < step.min) || (step.max !== undefined && n > step.max)) throw new Error(`count ${n} outside [${step.min ?? '-'}, ${step.max ?? '-'}]`);
  } else if ('wait' in step) await page.waitForTimeout(step.wait);
  else if ('submit' in step) await page.locator(step.submit).first().click({ timeout: t });
}

function viewportsFor(flow: Flow): Array<Device | 'tablet'> {
  if (flow.viewport === 'mobile') return ['mobile'];
  if (flow.viewport === 'desktop') return ['desktop'];
  if (flow.viewport === 'tablet') return ['tablet'];
  return ['mobile', 'desktop'];
}

/** Smoke test after a restore or before staging work: sample pages load without fatal errors, and the read-only flows pass. */
export async function smoke(cfg: SiteConfig, base: string, opts: { stage: 'local' | 'staging' | 'production'; urls?: string[]; flows?: boolean; httpCredentials?: { username: string; password: string } } = { stage: 'staging' }): Promise<SmokeResult> {
  const browser = await launchBrowser();
  const out: SmokeResult = { pass: true, pages: [], flows: [] };
  try {
    const session = await openSession(browser, { device: 'desktop', local: opts.stage !== 'production', mutationAllowlist: opts.stage === 'production' ? [] : [/.*/], httpCredentials: opts.httpCredentials });
    const page = await session.newPage();
    const urls = (opts.urls ?? (cfg.sampleUrls.length ? cfg.sampleUrls : [cfg.productionUrl])).map((u) => rebase(u, base));
    for (const u of urls) {
      const r = await page.goto(u, { waitUntil: 'load', timeout: 60_000 }).catch((e: Error) => e);
      if (r instanceof Error) {
        out.pages.push({ url: u, status: null, pass: false, detail: r.message.split('\n')[0]! });
        continue;
      }
      const html = await page.content();
      const fatal = FATAL.exec(html)?.[0];
      const ok = !!r && r.status() < 400 && !fatal && (await page.title()).length > 0;
      out.pages.push({ url: u, status: r?.status() ?? null, pass: ok, detail: fatal ?? (ok ? 'ok' : 'empty title or error status') });
    }
    await session.close();
    if (opts.flows !== false) {
      for (const flow of cfg.flows) {
        for (const vp of viewportsFor(flow)) {
          const s = await openSession(browser, { device: vp, local: opts.stage !== 'production', mutationAllowlist: opts.stage === 'production' ? [/\/cart\/add|add-to-cart|wc-ajax=add_to_cart|\/cart\/change/] : [/.*/], httpCredentials: opts.httpCredentials });
          const p = await s.newPage();
          const r = await runFlow(p, flow, base, opts.stage);
          out.flows.push({ name: flow.name, device: vp, ...r });
          await s.close();
        }
      }
    }
  } finally {
    await releaseBrowser();
  }
  out.pass = out.pages.every((p) => p.pass) && out.flows.every((f) => f.pass);
  return out;
}
