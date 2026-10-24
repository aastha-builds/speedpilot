import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Finds the SpeedPilot project root: SPEEDPILOT_ROOT, or the nearest folder with pnpm-workspace.yaml and CLAUDE.md. */
export function projectRoot(start: string = process.cwd()): string {
  if (process.env.SPEEDPILOT_ROOT) return resolve(process.env.SPEEDPILOT_ROOT);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, 'SPEC.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export const paths = {
  sites: (root: string) => join(root, 'sites'),
  siteYaml: (root: string, site: string) => join(root, 'sites', site, 'site.yaml'),
  runsDir: (root: string, site: string) => join(root, 'runs', site),
  runDir: (root: string, site: string, runId: string) => join(root, 'runs', site, runId),
  state: (root: string, site: string) => join(root, 'runs', site, 'state.json'),
  approvals: (root: string, site: string) => join(root, 'runs', site, 'approvals'),
  db: (root: string) => join(root, 'runs', 'speedpilot.sqlite'),
  rules: (root: string) => join(root, 'rules'),
  recipes: (root: string) => join(root, 'recipes'),
};

/** Sub-folders of every run's evidence directory (SPEC.md 1.1). */
export const RUN_SUBDIRS = ['lighthouse', 'traces', 'screenshots', 'har', 'coverage', 'logs', 'theme', 'reports', 'xray'] as const;

export function newRunId(type: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${type}-${Math.random().toString(36).slice(2, 6)}`;
}
