import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyzeCss, analyzePhpDir, liquidRenderTree, fingerprint } from '../index.js';

const fx = (p: string) => fileURLToPath(new URL(`../../../../fixtures/${p}`, import.meta.url));

describe('static analysis of the fixtures', () => {
  it('PHP: finds the planted slow query, enqueues and hooks in the fixture theme', () => {
    const f = analyzePhpDir(fx('wp/theme/speedpilot-fixture'), 'theme:speedpilot-fixture');
    expect(f.parseErrors).toEqual([]);
    expect(f.heavy.map((h) => h.pattern)).toEqual(expect.arrayContaining(['posts_per_page=-1', 'orderby=rand', 'meta_query', 'query-in-loop']));
    expect(f.heavy.find((h) => h.pattern === 'orderby=rand')?.function).toBe('spf_related_posts');
    const slider = f.enqueues.find((e) => e.handle === 'spf-legacy-slider');
    expect(slider?.deps).toEqual(['jquery']);
    expect(slider?.inFooter).toBe(false);
    expect(f.enqueues.some((e) => e.fn === 'wp_add_inline_script' && e.handle === 'spf-legacy-slider')).toBe(true);
    expect(f.hooks.some((h) => h.hook === 'wp_enqueue_scripts')).toBe(true);
  });
  it('Liquid: render tree, parser-blocking script_tag, nested loop hot spot, leftover snippet render', () => {
    const t = liquidRenderTree(fx('shopify/theme'));
    const layout = t.files['layout/theme.liquid']!;
    expect(layout.scriptTags.find((s) => s.asset === 'vendor-slider.js')?.parserBlocking).toBe(true);
    expect(layout.scriptTags.find((s) => s.asset === 'theme.js')?.parserBlocking).toBe(false);
    expect(layout.renders).toContain('oldreviews-app-widget');
    expect(layout.contentForHeader).toBe(true);
    expect(t.hotSpots.some((h) => h.file === 'sections/featured-collection.liquid' && /nested loop/.test(h.reason))).toBe(true);
    expect(t.files['sections/hero.liquid']!.deprecated).toContain('img_url');
    expect(t.edges.some((e) => e.from === 'templates/index.json' && e.to === 'sections/hero.liquid')).toBe(true);
    expect(t.edges.some((e) => e.kind === 'block' && e.to === 'blocks/group.liquid')).toBe(true);
  });
  it('CSS: font faces, imports and state selectors', () => {
    const c = analyzeCss(`@import url("a.css"); @font-face { font-family: "X"; src: url(x.woff2) format("woff2"); font-display: swap; } .main-nav.is-open ul { display:block } .a{}`);
    expect(c.imports).toEqual(['a.css']);
    expect(c.fontFaces[0]).toMatchObject({ family: 'X', display: 'swap', src: ['x.woff2'] });
    expect(c.stateSelectors).toContain('.main-nav.is-open ul');
  });
  it('fingerprints libraries and flags vulnerable versions', () => {
    expect(fingerprint('https://x/wp-includes/js/jquery/jquery.min.js?ver=3.7.1')[0]).toMatchObject({ library: 'jquery', version: '3.7.1' });
    expect(fingerprint('https://x/a.js', '/*! jQuery v1.12.4 | (c) jQuery Foundation */')[0]?.vulnerable?.length).toBeGreaterThan(0);
    expect(fingerprint('https://x/wp-includes/js/jquery/jquery-migrate.min.js?ver=3.4.1').map((h) => h.library)).toEqual(['jquery-migrate']);
  });
});
