import { mkdtempSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = new URL('..', import.meta.url).pathname;

/** A throwaway SpeedPilot root with CLAUDE.md, SPEC.md and selected site configs. */
export function tempRoot(sites: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-root-'));
  for (const f of ['CLAUDE.md', 'SPEC.md', 'CHECKS.md']) cpSync(join(REPO, f), join(root, f));
  for (const s of sites) {
    mkdirSync(join(root, 'sites', s), { recursive: true });
    cpSync(join(REPO, 'sites', s, 'site.yaml'), join(root, 'sites', s, 'site.yaml'));
  }
  if (existsSync(join(REPO, 'rules'))) cpSync(join(REPO, 'rules'), join(root, 'rules'), { recursive: true });
  if (existsSync(join(REPO, 'recipes'))) cpSync(join(REPO, 'recipes'), join(root, 'recipes'), { recursive: true });
  return root;
}

export async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export const WP_URL = 'http://localhost:8888/';
export const wpUp = await reachable(WP_URL);
