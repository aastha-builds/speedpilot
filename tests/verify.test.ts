import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { cpSync } from 'node:fs';
import { recordBaseline, verify, consoleSignature, visualDiff, Store, type ResponseTransform } from '@speedpilot/core';
import { REPO, tempRoot, wpUp } from './helpers.js';

describe('verification units', () => {
  it('normalizes console signatures', () => {
    expect(consoleSignature('Uncaught ReferenceError: jQuery is not defined at http://localhost:8888/?x=1:12:5')).toBe(consoleSignature('Uncaught ReferenceError: jQuery is not defined at http://localhost:8889/?y=2:99:1'));
  });
});

const URLS = ['http://localhost:8888/', 'http://localhost:8888/contact/'];

describe.skipIf(!wpUp)('verification harness on fixture-wp', () => {
  let root: string;
  beforeAll(async () => {
    root = tempRoot(['fixture-wp']);
    cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
    await recordBaseline(root, 'fixture-wp', { urls: URLS, lighthouseRuns: 3 });
  }, 600_000);

  it('a baseline passes against itself', async () => {
    const r = await verify(root, 'fixture-wp', { lighthouseRuns: 3 });
    expect(r.checks.filter((c) => !c.pass), JSON.stringify(r.checks.filter((c) => !c.pass), null, 1)).toEqual([]);
    expect(r.result).toBe('PASS');
    const store = new Store(root);
    expect(store.latestVerification('fixture-wp', 'local', 'quick')?.result).toBe('PASS');
    store.close();
  }, 600_000);

  const broken: Array<[string, ResponseTransform, string]> = [
    ['defer jQuery with an inline dependent', (url, body, ct) => (ct.includes('html') ? body.replace(/<script id="jquery-core-js" /, '<script defer id="jquery-core-js" ') : undefined), 'console'],
    ['purge the menu-open class', (url, body) => (url.includes('theme.css') ? body.replace(/\.main-nav\.is-open ul \{[^}]*\}/g, '') : undefined), 'flows'],
    ['remove the canonical', (url, body, ct) => (ct.includes('html') ? body.replace(/<link rel="canonical"[^>]*>/g, '') : undefined), 'seo'],
    ['block the GA4 beacon', (url, body, ct) => (ct.includes('html') ? body.replace(/<script[^>]*id="spf-analytics-js"[^>]*><\/script>/g, '') : undefined), 'tracking'],
    ['add an unsized banner', (url, body, ct) => (ct.includes('html') ? body.replace(/(<body[^>]*>)/, '$1<img src="/wp-content/themes/speedpilot-fixture/assets/img/banner.jpg" alt="Sale">') : undefined), 'visual'],
  ];
  for (const [name, transform, expected] of broken) {
    it(`catches: ${name} (${expected})`, async () => {
      const r = await verify(root, 'fixture-wp', { transform, lighthouseRuns: 0, viewports: ['mobile', 'desktop'] });
      expect(r.result).toBe('FAIL');
      const failed = r.checks.filter((c) => !c.pass).map((c) => c.name);
      expect(failed, JSON.stringify(r.checks.filter((c) => !c.pass), null, 1)).toContain(expected);
      if (name === 'add an unsized banner') expect(failed).toContain('performance');
    }, 600_000);
  }
});

describe('verification harness on fixture-shopify (local preview)', () => {
  it('a baseline passes against itself and a removed canonical is caught', async () => {
    const { loadSite } = await import('@speedpilot/core');
    const { ensureFixturePreview } = await import('@speedpilot/shopify');
    const root = tempRoot(['fixture-shopify']);
    await ensureFixturePreview(REPO, loadSite(root, 'fixture-shopify'));
    const urls = ['http://localhost:9292/', 'http://localhost:9292/products/product-1'];
    await recordBaseline(root, 'fixture-shopify', { urls, lighthouseRuns: 5 });
    const ok = await verify(root, 'fixture-shopify', { lighthouseRuns: 5 });
    expect(ok.checks.filter((c) => !c.pass), JSON.stringify(ok.checks.filter((c) => !c.pass), null, 1)).toEqual([]);
    const bad = await verify(root, 'fixture-shopify', { lighthouseRuns: 0, transform: (u, b, ct) => (ct.includes('html') ? b.replace(/<link rel="canonical"[^>]*>/, '') : undefined) });
    expect(bad.checks.find((c) => c.name === 'seo')?.pass).toBe(false);
  }, 900_000);
});
