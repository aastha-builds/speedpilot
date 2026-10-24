import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMutationServer, xrayPages, isSafe, loadRecipes, MUTATIONS, CONTROLS, type MutationServer, type VerdictContext } from '@speedpilot/xray';

// SPEC.md 15.10: every mutation must come out unsafe or unknown, never safe; controls measure that safe changes are still found.
describe('X-ray mutation suite', () => {
  let srv: MutationServer;
  const ctxs = new Map<string, VerdictContext>();
  beforeAll(async () => {
    srv = await startMutationServer();
    const dir = mkdtempSync(join(tmpdir(), 'sp-mut-'));
    for (const c of [...MUTATIONS, ...CONTROLS]) ctxs.set(c.id, { platform: 'wordpress', ...(await xrayPages([srv.urlFor(c.id)], { outDir: dir, siteOrigin: srv.origin })), recipes: loadRecipes() });
  }, 900_000);
  afterAll(() => srv?.close());

  it.each(MUTATIONS.map((m) => [m.id, m] as const))('%s is never safe', (_id, m) => {
    for (const [change, ok] of Object.entries(m.expect)) {
      const v = isSafe(ctxs.get(m.id)!, change);
      expect(ok, `${m.pattern} / ${change}: ${v.explanation}`).toContain(v.verdict);
      expect(v.verdict).not.toBe('safe');
    }
  });

  it('finds at least 80% of the truly safe control changes', () => {
    let total = 0;
    let found = 0;
    for (const c of CONTROLS) for (const [change] of Object.entries(c.expect)) {
      total++;
      if (isSafe(ctxs.get(c.id)!, change).verdict === 'safe') found++;
    }
    expect(found / total).toBeGreaterThanOrEqual(0.8);
  });
});
