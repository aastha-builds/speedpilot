import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite } from '@speedpilot/core';
import { xrayRun, checkTruth, byteAttribution, type Truth } from '@speedpilot/xray';
import { ensureFixturePreview, stopFixturePreview } from '@speedpilot/shopify';
import { REPO, tempRoot, wpUp } from './helpers.js';

const truth = JSON.parse(readFileSync(join(REPO, 'fixtures/truth.json'), 'utf8')) as { wp: Truth; shopify: Truth };
afterAll(() => stopFixturePreview());

describe.skipIf(!wpUp)('X-ray part 1 on fixture-wp', () => {
  it('builds a Site Model with every truth item and the right owners, and attributes at least 95% of bytes', async () => {
    const root = tempRoot(['fixture-wp']);
    cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
    const x = await xrayRun(root, 'fixture-wp', { urls: ['http://localhost:8888/', 'http://localhost:8888/contact/'] });
    const r = checkTruth(x.model, truth.wp);
    expect(r.missing, r.missing.join('\n')).toEqual([]);
    expect(r.wrongOwner, r.wrongOwner.join('\n')).toEqual([]);
    for (const b of byteAttribution(x.captures, truth.wp.owners)) expect(b.share, `${b.url} ${JSON.stringify(b.wrong.slice(0, 3))}`).toBeGreaterThanOrEqual(0.95);
    expect(x.model.byType('handler').some((h) => h.data.function === 'spfHeavyClickHandler')).toBe(true);
    expect(x.captures[0]!.coverage.length).toBeGreaterThan(1);
    expect(x.captures[0]!.exploration.some((s) => s.ran)).toBe(true);
  }, 600_000);
});

describe('X-ray part 1 on fixture-shopify', () => {
  it('builds a Site Model with every truth item and the right owners', async () => {
    const root = tempRoot(['fixture-shopify']);
    await ensureFixturePreview(REPO, loadSite(root, 'fixture-shopify'));
    const x = await xrayRun(root, 'fixture-shopify', { urls: ['http://localhost:9292/', 'http://localhost:9292/products/product-1'], themeDir: join(REPO, 'fixtures/shopify/theme') });
    const r = checkTruth(x.model, truth.shopify);
    expect(r.missing, r.missing.join('\n')).toEqual([]);
    expect(r.wrongOwner, r.wrongOwner.join('\n')).toEqual([]);
    for (const b of byteAttribution(x.captures, truth.shopify.owners)) expect(b.share, `${b.url} ${JSON.stringify(b.wrong.slice(0, 3))}`).toBeGreaterThanOrEqual(0.95);
  }, 600_000);
});
