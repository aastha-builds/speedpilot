import { spawn } from 'node:child_process';
import { redactString } from '../log.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export type Runner = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Runs a command without a shell. Output is returned raw; callers redact before logging. */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e.message) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

/** A short, redacted description of a failed command for logs and reports. */
export function describeFailure(cmd: string, args: string[], r: ExecResult): string {
  return redactString(`${cmd} ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
}

/** Simple rate limiter: at most one call per `intervalMs` (CLAUDE.md rule 12: 1 request per second on real sites). */
export class RateLimiter {
  private next = 0;
  constructor(private readonly intervalMs = 1000) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}
