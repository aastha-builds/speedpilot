import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditSite, loadSite } from '@speedpilot/core';
import { beforeReport } from '@speedpilot/report';
import { ensureFixturePreview, shopifyAuditBackend, stopFixturePreview } from '@speedpilot/shopify';
import { REPO, tempRoot, wpUp } from './helpers.js';

/** Rows of fixtures/PLANTED.md: id -> CHECKS.md IDs, per platform. */
export function plantedRows(platform: 'wp' | 'shopify'): Array<{ id: string; checks: string[] }> {
  const md = readFileSync(join(REPO, 'fixtures/PLANTED.md'), 'utf8');
  const section = platform === 'wp' ? md.split('## Shopify')[0]! : md.split('## Shopify')[1]!;
  return [...section.matchAll(/^\| ([WS]\d+) \|.*\| ([A-Z0-9, -]+?(?:\(.*?\))?) \|$/gm)].map((m) => ({ id: m[1]!, checks: [...m[2]!.matchAll(/[A-Z0-9]+-\d+/g)].map((x) => x[0]) }));
}

afterAll(() => stopFixturePreview());

describe.skipIf(!wpUp)('before report: fixture-wp', () => {
  it('lists every planted problem with evidence, estimated gain and tier', async () => {
    const root = tempRoot(['fixture-wp']);
    await auditSite(root, 'fixture-wp', { lighthouseRuns: 1, devices: ['mobile', 'desktop'], urls: ['http://localhost:8888/', 'http://localhost:8888/contact/', 'http://localhost:8888/about/'] });
    const { written, analysis } = await beforeReport(root, 'fixture-wp', { anonymized: true });
    const found = new Set(analysis.findings.map((f) => f.checkId));
    const rows = plantedRows('wp');
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const guards = new Set(analysis.findings.flatMap((f) => f.guards));
    const missing = rows.filter((r) => !r.checks.some((c) => found.has(c) || (c.startsWith('SAFE') && guards.has(c))));
    expect(missing, `planted problems missing from the report: ${JSON.stringify(missing)}`).toEqual([]);
    for (const f of analysis.findings.filter((x) => x.tier !== 'report')) {
      expect(f.evidence, f.id).toBeTruthy();
      expect(['T1', 'T2', 'T3']).toContain(f.tier);
    }
    expect(analysis.findings.find((f) => f.checkId === 'IMG-01')?.estimatedGain.lcpMs).toBeGreaterThan(0);
    const html = readFileSync(written[0]!.html, 'utf8');
    expect(html).toContain('The 5 biggest problems');
    expect(existsSync(written[0]!.pdf!)).toBe(true);
    expect(readFileSync(written[0]!.markdown, 'utf8')).toMatch(/Biggest problems/);
    const anon = readFileSync(written[1]!.html, 'utf8') + readFileSync(written[1]!.json, 'utf8') + readFileSync(written[1]!.markdown, 'utf8');
    expect(anon).not.toMatch(/localhost:8888|SpeedPilot Fixture|fixture-wp/);
  }, 600_000);
});

describe('before report: fixture-shopify', () => {
  it('lists every planted problem', async () => {
    const root = tempRoot(['fixture-shopify']);
    const cfg = loadSite(root, 'fixture-shopify');
    await ensureFixturePreview(REPO, cfg);
    await auditSite(root, 'fixture-shopify', { lighthouseRuns: 1, devices: ['mobile'], urls: ['http://localhost:9292/', 'http://localhost:9292/products/product-1'], backend: (c) => shopifyAuditBackend({ ...c, root: REPO }) });
    const { analysis } = await beforeReport(root, 'fixture-shopify', { pdf: false });
    const found = new Set(analysis.findings.map((f) => f.checkId));
    const guards = new Set(analysis.findings.flatMap((f) => f.guards));
    const missing = plantedRows('shopify').filter((r) => !r.checks.some((c) => found.has(c) || (c.startsWith('SAFE') && guards.has(c))));
    expect(missing, JSON.stringify(missing)).toEqual([]);
    expect(analysis.ceiling.blockers.some((b) => /Shopify platform scripts/.test(b.name))).toBe(true);
  }, 600_000);
});
