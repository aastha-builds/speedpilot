import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSite, recordBaseline, type SiteConfig } from '@speedpilot/core';
import { xrayRun, loadXray } from '@speedpilot/xray';
import { ensureFixturePreview, stopFixturePreview, startPreview, ShopifyCli, ShopifyCliError } from '@speedpilot/shopify';
import { buildShopifyProposals, applyShopify, workingCopy, probeShopify, git, applyEdits, ProtectedEditError, delayThirdParty, writeTransform, allNodes } from '@speedpilot/engine';
import { REPO, tempRoot } from './helpers.js';

afterAll(() => stopFixturePreview());

async function profileMs(port: number, path = '/'): Promise<number> {
  await fetch(`http://127.0.0.1:${port}${path}`);
  const p = (await (await fetch(`http://127.0.0.1:${port}/__profile`)).json()) as Array<{ file: string; ms: number }>;
  return p.filter((x) => x.file.includes('featured-collection')).reduce((a, x) => a + x.ms, 0);
}

describe('Shopify engine on fixture-shopify', () => {
  it('fixes every planted problem, one commit each, with verification passing after each', async () => {
    const root = tempRoot(['fixture-shopify']);
    cpSync(join(REPO, 'fixtures/shopify'), join(root, 'fixtures/shopify'), { recursive: true });
    cpSync(join(REPO, 'fixtures/thirdparty'), join(root, 'fixtures/thirdparty'), { recursive: true });
    const cfg = loadSite(root, 'fixture-shopify');
    await ensureFixturePreview(root, cfg);
    const urls = ['http://localhost:9292/', 'http://localhost:9292/products/product-1'];
    await xrayRun(root, 'fixture-shopify', { urls, themeDir: join(root, 'fixtures/shopify/theme') });
    await recordBaseline(root, 'fixture-shopify', { urls });
    const x = loadXray(root, 'fixture-shopify').ctx;
    const probes = await probeShopify(urls);
    const work = workingCopy(root, 'fixture-shopify', join(root, 'fixtures/shopify/theme'));
    const proposals = buildShopifyProposals(x, probes, { themeDir: work });
    const ids = proposals.map((p) => p.id);
    // the X-ray refuses a plain defer of vendor-slider.js; the engine moves it with its inline dependent instead
    expect(ids).not.toContain('sh-defer-vendor-slider.js');
    for (const id of ['sh-defer-footer-tools.js', 'sh-defer-vendor-slider.js-with-inline', 'sh-lcp-image', 'sh-fonts', 'sh-leftover-oldreviews-app-widget', 'sh-flatten-groups', 'sh-speculation']) expect(ids, id).toContain(id);
    expect(ids.some((i) => i.startsWith('sh-liquid-'))).toBe(true);
    expect(ids.some((i) => i.startsWith('sh-delay-') && i.includes('chat'))).toBe(true);
    expect(ids.some((i) => i.startsWith('sh-delay-') && i.includes('analytics'))).toBe(false);

    const before = await (async () => {
      const p = await startPreview({ themeDir: work, port: 9294, host: '127.0.0.1' });
      try {
        return await profileMs(9294);
      } finally {
        await p.close();
      }
    })();
    const steps = await applyShopify(root, 'fixture-shopify', { proposals, workDir: work, workPort: 9293, simulationRuns: 2 });
    const failed = steps.filter((s) => s.status !== 'kept');
    expect(failed.map((s) => `${s.proposal}: ${s.reason}`)).toEqual([]);
    // one commit per change on the work theme
    const log = git(work, 'log', '--oneline').split('\n');
    expect(log.length).toBe(steps.length + 1);
    const layout = readFileSync(join(work, 'layout/theme.liquid'), 'utf8');
    expect(layout).toContain('{{ content_for_header }}');
    expect(layout).not.toContain('fonts.googleapis.com');
    expect(layout).not.toContain("render 'oldreviews-app-widget'");
    expect(existsSync(join(work, 'snippets/oldreviews-app-widget.liquid'))).toBe(true); // quarantined, not deleted
    const hero = readFileSync(join(work, 'sections/hero.liquid'), 'utf8');
    expect(hero).not.toMatch(/\|\s*img_url/);
    // the srcset holds copies of the hero itself, never of another page's LCP image
    expect(hero).not.toMatch(/srcset="[^"]*thumb-/);
    // Liquid render time for the planted loop drops
    const p = await startPreview({ themeDir: work, port: 9294, host: '127.0.0.1' });
    try {
      const after = await profileMs(9294);
      expect(after, `featured-collection ${before} ms -> ${after} ms`).toBeLessThan(before * 0.5);
    } finally {
      await p.close();
    }
  }, 2_400_000);

  it('refuses to push to the live theme and refuses to edit content_for_header', async () => {
    const cfg = { ...loadSite(REPO, 'fixture-shopify'), access: { shopify: { store: 'fixture.myshopify.com' } } } as SiteConfig;
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes('list')) return { code: 0, stdout: JSON.stringify([{ id: 1, name: 'Live', role: 'live' }, { id: 2, name: 'Work', role: 'unpublished' }]), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const cli = new ShopifyCli(cfg, runner);
    await expect(cli.pushToWorkTheme('1', '1', '/tmp/x', ['layout/theme.liquid'])).rejects.toThrow(/live theme/);
    await expect(cli.pushToWorkTheme('3', '2', '/tmp/x', ['layout/theme.liquid'])).rejects.toThrow(ShopifyCliError);
    await expect(cli.exec(['theme', 'push', '--live'])).rejects.toThrow(/never used/);
    expect(calls.some((a) => a.includes('push'))).toBe(false);
    const src = '<head>{{ content_for_header }}<script src="a.js"></script></head>';
    expect(() => applyEdits(src, 'layout/theme.liquid', [{ start: 6, end: 30, text: '' }])).toThrow(ProtectedEditError);
    expect(() => applyEdits('<p>checkout</p>', 'templates/checkout.liquid', [{ start: 0, end: 3, text: '' }])).toThrow(/checkout/);
  });

  it('delays a third-party script once, and the loader snippet it adds parses as Liquid', () => {
    const dir = join(tempRoot(), 'theme');
    cpSync(join(REPO, 'fixtures/shopify/theme'), dir, { recursive: true });
    const t = delayThirdParty(dir, '/chat/widget.js');
    expect(t).toBeDefined();
    writeTransform(dir, t!);
    expect(() => allNodes(readFileSync(join(dir, 'snippets/speedpilot-delay.liquid'), 'utf8'))).not.toThrow();
    expect(delayThirdParty(dir, '/chat/widget.js')).toBeUndefined();
  });
});
