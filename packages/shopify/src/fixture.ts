import { join } from 'node:path';
import type { SiteConfig } from '@speedpilot/core';
import { startPreview, type PreviewServer } from './preview.js';

let running: PreviewServer | undefined;

/** Starts the local fixture preview on the site's port when it is not already serving (local fixture only). */
export async function ensureFixturePreview(root: string, cfg: SiteConfig, themeDir = join(root, 'fixtures', 'shopify', 'theme')): Promise<PreviewServer | undefined> {
  if (!cfg.local || cfg.platform !== 'shopify') return undefined;
  const tpUp = await fetch('http://127.0.0.1:8890/chat/widget.js', { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (!tpUp) {
    const mod = (await import(join(root, 'fixtures', 'thirdparty', 'server.mjs'))) as { startThirdParty(port?: number): Promise<unknown> };
    await mod.startThirdParty(8890).catch(() => undefined);
  }
  const url = new URL(cfg.productionUrl);
  const up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (up) return undefined;
  running = await startPreview({ themeDir, port: Number(url.port || 80), host: '127.0.0.1' });
  return running;
}

export async function stopFixturePreview(): Promise<void> {
  if (running) await running.close();
  running = undefined;
}
