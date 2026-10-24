import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, paths } from './util/paths.js';
import type { Stage } from './store/store.js';

/** Approval files: runs/<site>/approvals/<plan-id or operation>.<stage>.json (SPEC.md 14.1). Shared with .claude/hooks/guard.mjs. */
export interface ApprovalFile {
  site: string;
  stage: Exclude<Stage, 'local'>;
  operation: string;
  items: string[];
  approvedBy: string;
  approvedAt: string;
  text: string;
}

export const APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ApprovalError extends Error {
  override name = 'ApprovalError';
}

export function approvalPath(root: string, site: string, operation: string, stage: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation)) throw new ApprovalError(`Invalid plan ID or operation: ${operation}`);
  return join(paths.approvals(root, site), `${operation}.${stage}.json`);
}

/**
 * Writes an approval. Called only by `speedpilot approve`, which refuses to run inside Claude Code
 * (the guard hook also blocks it). The human types it in their own terminal.
 */
export function writeApproval(root: string, a: Omit<ApprovalFile, 'approvedAt' | 'text'> & { approvedAt?: string; text?: string }): { file: string; approval: ApprovalFile } {
  if (!a.approvedBy.trim()) throw new ApprovalError('--by "<name>" is required.');
  if (!a.items.length) throw new ApprovalError('At least one item is required.');
  const approvedAt = a.approvedAt ?? new Date().toISOString();
  const text = a.text ?? `I, ${a.approvedBy}, approve ${a.items.join(', ')} of ${a.operation} for ${a.site} on ${a.stage} at ${approvedAt}.`;
  const approval: ApprovalFile = { site: a.site, stage: a.stage, operation: a.operation, items: a.items, approvedBy: a.approvedBy, approvedAt, text };
  ensureDir(paths.approvals(root, a.site));
  const file = approvalPath(root, a.site, a.operation, a.stage);
  writeFileSync(file, JSON.stringify(approval, null, 2));
  return { file, approval };
}

export function readApproval(root: string, site: string, operation: string, stage: string): ApprovalFile | undefined {
  const file = approvalPath(root, site, operation, stage);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApprovalFile;
  } catch {
    return undefined;
  }
}

/**
 * The executor's own approval check (defense in depth, SPEC.md 14.1). Throws unless a matching,
 * fresh approval names the item for this site and stage.
 */
export function requireApproval(root: string, opts: { site: string; operation: string; stage: Stage; item?: string; now?: number }): ApprovalFile {
  if (opts.stage === 'local') {
    return { site: opts.site, stage: 'staging', operation: opts.operation, items: ['*'], approvedBy: 'local fixture', approvedAt: new Date().toISOString(), text: 'local fixtures are exempt' };
  }
  const a = readApproval(root, opts.site, opts.operation, opts.stage);
  const where = `runs/${opts.site}/approvals/${opts.operation}.${opts.stage}.json`;
  if (!a) throw new ApprovalError(`No approval file ${where}. The human must run: speedpilot approve ${opts.operation} --stage ${opts.stage} --items <ids> --by "<name>"`);
  if (a.site !== opts.site || a.stage !== opts.stage || a.operation !== opts.operation) throw new ApprovalError(`Approval file ${where} does not match site, stage and operation.`);
  const at = Date.parse(a.approvedAt);
  const age = (opts.now ?? Date.now()) - at;
  if (!Number.isFinite(at) || age < 0 || age > APPROVAL_MAX_AGE_MS) throw new ApprovalError(`Approval ${where} is older than 24 hours or has an invalid time. Ask for a new approval.`);
  if (!a.approvedBy) throw new ApprovalError(`Approval ${where} has no approver.`);
  if (opts.item && !a.items.includes(opts.item) && !a.items.includes('*') && !a.items.includes('all')) {
    throw new ApprovalError(`Item ${opts.item} is not approved for ${opts.stage} in ${where} (approved: ${a.items.join(', ')}).`);
  }
  return a;
}

/**
 * The approval token: a short hash of the approval file the human wrote. MCP write tools need the plan ID plus this
 * token, so a tool call only goes through while that exact approval exists (SPEC.md 10.2).
 */
export function approvalToken(a: ApprovalFile): string {
  return createHash('sha256').update(JSON.stringify([a.site, a.stage, a.operation, a.items, a.approvedBy, a.approvedAt])).digest('hex').slice(0, 16);
}

/** Checks a token against the current approval file for the operation and stage. */
export function requireApprovalToken(root: string, opts: { site: string; operation: string; stage: Stage; item?: string; token: string }): ApprovalFile {
  const a = requireApproval(root, opts);
  if (opts.stage !== 'local' && approvalToken(a) !== opts.token) throw new ApprovalError(`The approval token does not match runs/${opts.site}/approvals/${opts.operation}.${opts.stage}.json. Ask the human for the token \`speedpilot approve\` printed.`);
  return a;
}

export function listApprovals(root: string, site: string): ApprovalFile[] {
  const dir = paths.approvals(root, site);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8')) as ApprovalFile;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is ApprovalFile => !!x);
}

/** True when this process looks like it runs inside Claude Code (approvals are human-only). */
export function insideClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDECODE || env.CLAUDE_PROJECT_DIR || env.AI_AGENT) return true;
  return Object.keys(env).some((k) => k.startsWith('CLAUDE_CODE_'));
}
