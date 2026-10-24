/** Captures arbitrary local pages and builds a Site Model without a site.yaml (validation suites, simulator checks). */
import { join } from 'node:path';
import { launchBrowser, releaseBrowser, type Device } from '@speedpilot/core';
import { captureUrl, type XrayCapture } from '../capture/cdp.js';
import { buildModel, openCache, type ScriptInfo } from '../build.js';
import type { SiteModel } from '../model.js';

export async function xrayPages(urls: string[], o: { outDir: string; siteOrigin: string; platform?: 'wordpress' | 'shopify'; device?: Device; explore?: boolean }): Promise<{ model: SiteModel; scripts: ScriptInfo[]; captures: XrayCapture[] }> {
  const browser = await launchBrowser();
  const captures: XrayCapture[] = [];
  try {
    for (const url of urls) captures.push(await captureUrl(browser, { url, device: o.device ?? 'mobile', stage: 'local', outDir: o.outDir, ownerCtx: { siteOrigin: o.siteOrigin, platform: o.platform ?? 'wordpress', rules: [] }, explore: o.explore ?? true }));
  } finally {
    await releaseBrowser();
  }
  const { model, scripts } = buildModel({ platform: o.platform ?? 'wordpress', captures, cache: openCache(join(o.outDir, 'cache')) });
  return { model, scripts, captures };
}
