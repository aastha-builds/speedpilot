import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config/site.js';
import type { Store } from '../store/store.js';
import { createLocalClone } from './clone.js';
import { smoke, type SmokeResult } from '../verifier/smoke.js';

export interface RestoreTestResult {
  backupId: string;
  runId: string;
  verified: boolean;
  url: string;
  smoke: SmokeResult;
}

/**
 * Restore test (SPEC.md 5.1): restore into a fresh local WordPress, run the smoke flows, and only then mark the backup
 * verified. Required for production backups (CLAUDE.md rule 1).
 */
export async function restoreTest(root: string, cfg: SiteConfig, store: Store, backupId: string, opts: { port?: number; keep?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<RestoreTestResult> {
  const b = store.backups(cfg.name).find((x) => x.id === backupId);
  if (!b) throw new Error(`Unknown backup ${backupId}`);
  const run = store.startRun(cfg.name, 'restore', 'local');
  const clone = await createLocalClone(root, cfg, b.location, { name: `restore-${backupId.slice(-10)}`, port: opts.port ?? 8899, env: opts.env });
  try {
    const result = await smoke(cfg, clone.url, { stage: 'staging' });
    writeFileSync(join(run.dir, 'logs', 'restore-smoke.json'), JSON.stringify(result, null, 1));
    if (result.pass) store.markBackupVerified(backupId, run.id);
    store.endRun(run.id, result.pass ? 'ok' : 'failed');
    return { backupId, runId: run.id, verified: result.pass, url: clone.url, smoke: result };
  } catch (e) {
    store.endRun(run.id, 'failed');
    throw e;
  } finally {
    if (!opts.keep) await clone.down(true);
  }
}

/** Is there a verified backup of this stage taken today (CLAUDE.md rule 1)? */
export function verifiedBackupToday(store: Store, site: string, stage: 'staging' | 'production' | 'local', now = new Date()): { id: string } | undefined {
  const day = now.toISOString().slice(0, 10);
  const b = store.backups(site).find((x) => x.stage === stage && x.createdAt.slice(0, 10) === day && x.restoreTested);
  return b ? { id: b.id } : undefined;
}

export function snapshotToday(store: Store, site: string, stage: 'staging' | 'production' | 'local', now = new Date()): { id: string } | undefined {
  const day = now.toISOString().slice(0, 10);
  const b = store.backups(site).find((x) => x.stage === stage && x.createdAt.slice(0, 10) === day);
  return b ? { id: b.id } : undefined;
}
