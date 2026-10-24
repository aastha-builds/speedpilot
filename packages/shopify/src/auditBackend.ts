import { join } from 'node:path';
import type { AuditOptions } from '@speedpilot/core';
import { collectShopifyBackend } from './backend.js';

/** Shopify backend for `speedpilot audit` (SPEC.md 3.10). */
export const shopifyAuditBackend: NonNullable<AuditOptions['backend']> = async ({ root, cfg, stage, runDir, urls, pages }) =>
  collectShopifyBackend(cfg, stage, urls, {
    runDir,
    themeDir: cfg.local ? join(root, 'fixtures', 'shopify', 'theme') : undefined,
    previewUrl: cfg.local ? cfg.productionUrl : undefined,
    requests: pages.flatMap((p) => p.evidence.requests),
    responseHeaders: pages[0]?.evidence.responseHeaders,
  });
