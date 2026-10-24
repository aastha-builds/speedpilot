import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, auditSite, WpCli } from '@speedpilot/core';
import { afterReport } from '@speedpilot/report';
import { ensureFixturePreview, stopFixturePreview, shopifyAuditBackend } from '@speedpilot/shopify';
import { swapLivePreview, closeLivePreview, workingCopy, deferScript, writeTransform } from '@speedpilot/engine';
import { REPO, tempRoot, wpUp } from './helpers.js';

afterAll(async () => {
  await closeLivePreview();
  await stopFixturePreview();
});

function noLeaks(file: string, banned: string[]) {
  const t = readFileSync(file, 'utf8');
  for (const b of banned) expect(t.toLowerCase(), `${file} contains ${b}`).not.toContain(b.toLowerCase());
}

describe.skipIf(!wpUp)('after report: fixture-wp', () => {
  it('has before and after with deltas, change log and rollback kit; the anonymized version leaks nothing', async () => {
    const root = tempRoot(['fixture-wp']);
    cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
    const wp = new WpCli(REPO, loadSite(REPO, 'fixture-wp'), 'local', undefined, true);
    const urls = ['http://localhost:8888/'];
    await wp.text(['speedpilot', 'disable-all']);
    const before = await auditSite(root, 'fixture-wp', { urls, lighthouseRuns: 1, devices: ['mobile'], skipInteractions: true });
    await wp.text(['speedpilot', 'enable', 'lcp', `--settings=${JSON.stringify({ match: 'hero.jpg', preload: true, href: 'http://localhost:8888/wp-content/themes/speedpilot-fixture/assets/img/hero.jpg' })}`]);
    try {
      await auditSite(root, 'fixture-wp', { urls, lighthouseRuns: 1, devices: ['mobile'], skipInteractions: true });
    } finally {
      await wp.text(['speedpilot', 'disable', 'lcp']);
    }
    const { written, after } = await afterReport(root, 'fixture-wp', { beforeRunId: before.runId, anonymized: true, pdf: false });
    expect(after.deltas.some((d) => d.metric === 'Score')).toBe(true);
    expect(after.rollbackKit.join(' ')).toMatch(/SPEEDPILOT_DISABLE/);
    expect(after.recheck.day28).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const html = readFileSync(written[0]!.html, 'utf8');
    expect(html).toContain('Before and after');
    expect(html).toContain('Rollback');
    noLeaks(written[1]!.html, ['localhost:8888', 'SpeedPilot Fixture', 'fixture-wp']);
    noLeaks(written[1]!.json, ['localhost:8888', 'fixture-wp', 'logo']);
    noLeaks(written[1]!.markdown, ['localhost:8888', 'fixture-wp']);
  }, 900_000);
});

describe('after report: fixture-shopify', () => {
  it('has before and after for the work theme; the anonymized version leaks nothing', async () => {
    const root = tempRoot(['fixture-shopify']);
    cpSync(join(REPO, 'fixtures/shopify'), join(root, 'fixtures/shopify'), { recursive: true });
    cpSync(join(REPO, 'fixtures/thirdparty'), join(root, 'fixtures/thirdparty'), { recursive: true });
    const cfg = loadSite(root, 'fixture-shopify');
    await ensureFixturePreview(root, cfg);
    const urls = ['http://localhost:9292/'];
    const opts = { urls, lighthouseRuns: 1, devices: ['mobile' as const], skipInteractions: true, backend: shopifyAuditBackend };
    const before = await auditSite(root, 'fixture-shopify', opts);
    const work = workingCopy(root, 'fixture-shopify', join(root, 'fixtures/shopify/theme'));
    writeTransform(work, deferScript(work, 'footer-tools.js')!);
    await swapLivePreview(root, 'fixture-shopify', work);
    await auditSite(root, 'fixture-shopify', opts);
    const { written, after } = await afterReport(root, 'fixture-shopify', { beforeRunId: before.runId, anonymized: true, pdf: false });
    expect(after.deltas.length).toBeGreaterThan(0);
    expect(after.rollbackKit.join(' ')).toMatch(/previous live theme/);
    noLeaks(written[1]!.html, ['localhost:9292', 'SpeedPilot Fixture Store', 'fixture-shopify']);
    noLeaks(written[1]!.json, ['localhost:9292', 'fixture-shopify', 'logo']);
  }, 900_000);
});
