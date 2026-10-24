import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir, paths } from './util/paths.js';
import type { Stage } from './store/store.js';

/** runs/<site>/state.json: what the guard hook reads to place commands (SPEC.md 14.1). */
export interface SiteState {
  hosts?: Partial<Record<Stage, string[]>>;
  store?: string;
  workThemeId?: string;
  backupThemeId?: string;
  liveThemeId?: string;
  currentTarget?: { stage: Stage; url?: string };
  lastBaseline?: Partial<Record<Stage, string>>;
  snapshot?: Record<string, unknown>;
  updatedAt?: string;
}

export function readState(root: string, site: string): SiteState {
  const p = paths.state(root, site);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SiteState;
  } catch {
    return {};
  }
}

export function writeState(root: string, site: string, patch: Partial<SiteState>): SiteState {
  const p = paths.state(root, site);
  ensureDir(dirname(p));
  const next = { ...readState(root, site), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export function setActiveSite(root: string, site: string) {
  ensureDir(join(root, 'runs'));
  writeFileSync(join(root, 'runs', '.active-site'), site);
}
