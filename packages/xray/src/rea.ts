/**
 * Optional REA cross-check (SPEC.md 15.11). Runs Reverse Engineer Anything through its CLI with a pinned version on
 * downloaded bundles of the client's own site. Its findings are stored as extra evidence (`rea`) and never override the
 * runtime X-ray; the verdict engine ignores them. The X-ray works fully without REA.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteModel } from './model.js';

export const REA_VERSION = '6.3.0';

export interface ReaResult {
  available: boolean;
  version: string;
  reason?: string;
  findings: Array<{ file?: string; kind: string; detail: string }>;
  outputPath?: string;
}

export type ReaRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: ReaRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout, stderr: (e as Error).message });
      return;
    }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });

export async function runRea(bundleDir: string, outDir: string, o: { runner?: ReaRunner; timeoutMs?: number; command?: string } = {}): Promise<ReaResult> {
  const runner = o.runner ?? defaultRunner;
  const r = await runner(o.command ?? 'npx', ['-y', `rea-agents@${REA_VERSION}`, 'analyze-javascript-application', bundleDir, '--json'], o.timeoutMs ?? 300_000);
  if (r.code !== 0) return { available: false, version: REA_VERSION, reason: `REA did not run (${r.code === null ? 'not installed or no network' : `exit ${r.code}`}): ${r.stderr.trim().slice(0, 300)}`, findings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  } catch {
    return { available: false, version: REA_VERSION, reason: 'REA output was not JSON', findings: [] };
  }
  const outputPath = join(outDir, 'rea.json');
  writeFileSync(outputPath, JSON.stringify(parsed, null, 2));
  const findings = (((parsed as { findings?: unknown[] }).findings ?? []) as Array<Record<string, unknown>>).map((f) => ({ file: typeof f.file === 'string' ? f.file : undefined, kind: String(f.type ?? f.kind ?? 'finding'), detail: String(f.description ?? f.detail ?? JSON.stringify(f)).slice(0, 300) }));
  return { available: true, version: REA_VERSION, findings, outputPath };
}

/** Stores REA findings as low-confidence `rea` evidence on the matching script nodes. */
export function attachRea(model: SiteModel, rea: ReaResult): number {
  let n = 0;
  if (!rea.available) return 0;
  for (const f of rea.findings) {
    const s = f.file ? model.byType('script').find((x) => String(x.data.url ?? '').split('?')[0]!.endsWith(f.file!)) : undefined;
    if (!s) continue;
    s.data.rea = [...((s.data.rea as unknown[]) ?? []), { kind: f.kind, detail: f.detail }];
    n++;
  }
  return n;
}
