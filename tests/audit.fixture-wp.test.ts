import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditSite } from '@speedpilot/core';
import { tempRoot, wpUp } from './helpers.js';

describe.skipIf(!wpUp)('audit fixture-wp (needs pnpm fixtures:wp up)', () => {
  it('saves evidence and finds the planted LCP and CLS problems', async () => {
    const root = tempRoot(['fixture-wp']);
    const r = await auditSite(root, 'fixture-wp', { lighthouseRuns: 1, urls: ['http://localhost:8888/', 'http://localhost:8888/contact/'], devices: ['mobile'] });
    for (const sub of ['lighthouse', 'traces', 'screenshots', 'logs']) expect(readdirSync(join(r.dir, sub)).length, sub).toBeGreaterThan(0);
    expect(readdirSync(join(r.dir, 'lighthouse')).some((f) => f.endsWith('.html'))).toBe(true);
    const home = r.pages.find((p) => p.url === 'http://localhost:8888/')!;
    expect(home.lighthouse?.median.lcp).toBeGreaterThan(0);
    expect(home.evidence.coverage.length).toBeGreaterThan(5);
    expect(home.evidence.tracePath && existsSync(home.evidence.tracePath)).toBeTruthy();
    // planted lazy hero is the LCP element, found late
    expect(home.evidence.lcp?.url).toMatch(/hero\.jpg/);
    expect(home.evidence.lcp?.lazy).toBe(true);
    expect(home.evidence.lcp?.phases?.loadDelay).toBeGreaterThan(0);
    // unsized images and the injected banner are CLS culprits
    const causes = home.evidence.cls.culprits.map((c) => c.cause);
    expect(home.evidence.cls.total).toBeGreaterThan(0.05);
    expect(causes.some((c) => c === 'image-without-size' || c === 'injected-content')).toBe(true);
    expect(home.evidence.images.filter((i) => !i.hasWidthAttr && i.tag === 'img').length).toBeGreaterThan(3);
    // planted render-blocking scripts, preloader, entrance animation, YouTube embed, beacons recorded
    expect(home.evidence.document.headBlocking.some((h) => h.url?.includes('legacy-slider.js'))).toBe(true);
    expect(home.evidence.document.preloader?.coversViewport).toBe(true);
    expect(home.evidence.media.some((m) => m.provider === 'youtube')).toBe(true);
    expect(home.evidence.beacons.some((b) => b.vendor === 'ga4' && b.event === 'page_view')).toBe(true);
    // the slow click handler shows up in the scripted INP
    const heavy = home.inp?.interactions.find((i) => i.name === 'click primary page button');
    expect(heavy?.inp).toBeGreaterThan(200);
    expect(heavy?.scripts.some((s) => s.sourceURL.includes('heavy-click.js'))).toBe(true);
    // owners
    expect(home.evidence.requests.find((q) => q.url.includes('contact-form-7'))?.owner.id).toBe('plugin:contact-form-7');
    expect(home.evidence.requests.find((q) => q.url.includes('127.0.0.1:8890/chat'))?.owner.kind).toBe('third-party');
  }, 300_000);
});
