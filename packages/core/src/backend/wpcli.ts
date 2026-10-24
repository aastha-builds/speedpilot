import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as defaultRun, type Runner, type ExecResult, describeFailure } from '../util/exec.js';
import type { SiteConfig } from '../config/site.js';
import type { Stage } from '../store/store.js';
import { readState } from '../state.js';

/** WP-CLI commands that are read-only (mirror of the guard allowlist, SPEC.md 14.1). */
const READONLY: string[][] = [
  ['core', 'version'],
  ['core', 'check-update'],
  ['plugin', 'list'],
  ['plugin', 'get'],
  ['theme', 'list'],
  ['theme', 'get'],
  ['option', 'get'],
  ['option', 'list'],
  ['cron', 'event', 'list'],
  ['cron', 'schedule', 'list'],
  ['db', 'size'],
  ['db', 'tables'],
  ['doctor', 'check'],
  ['doctor', 'list'],
  ['profile', 'stage'],
  ['profile', 'hook'],
  ['transient', 'list'],
  ['cli', 'version'],
  ['package', 'list'],
  ['speedpilot', 'export'],
  ['speedpilot', 'list'],
];

export function isReadOnlySql(sql: string): boolean {
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((s) => /^(select|show|explain|describe|desc|checksum)\b/i.test(s) && !/\b(insert|update|delete|replace|drop|alter|create|truncate|rename|grant|lock|set|into\s+outfile)\b/i.test(s.replace(/'[^']*'/g, "''")));
}

export function wpCommandIsReadOnly(args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith('--') && !a.startsWith('@'));
  if (args.some((a) => a.startsWith('--exec') || a.startsWith('--require'))) return false;
  if (pos[0] === 'eval' || pos[0] === 'eval-file' || pos[0] === 'shell') return false;
  if (pos[0] === 'db' && pos[1] === 'query') return isReadOnlySql(pos.slice(2).join(' '));
  if (pos[0] === 'search-replace') return args.includes('--dry-run');
  return READONLY.some((p) => p.every((x, i) => pos[i] === x));
}

/** The WordPress fixture folder: the project's own, or the one shipped next to the SpeedPilot code. */
export function fixturesWpDir(root: string): string {
  const own = join(root, 'fixtures', 'wp');
  if (existsSync(join(own, 'compose.yaml'))) return own;
  return fileURLToPath(new URL('../../../../fixtures/wp', import.meta.url));
}

export class WpCliError extends Error {
  override name = 'WpCliError';
}

/** Runs WP-CLI on the right stage: local fixture (compose or wp-env) or a remote alias. */
export class WpCli {
  constructor(
    readonly root: string,
    readonly cfg: SiteConfig,
    readonly stage: Stage,
    private readonly runner: Runner = defaultRun,
    /** Executor-only: allows write commands after the approval check (SPEC.md 7.2). */
    private readonly allowWrites = false,
  ) {}

  get mode(): 'compose' | 'wp-env' | 'alias' {
    if (this.cfg.local || this.stage === 'local') {
      const engine = (readState(this.root, this.cfg.name) as { engine?: string }).engine;
      if (engine === 'wp-env') return 'wp-env';
      return 'compose';
    }
    return 'alias';
  }

  argv(args: string[]): { cmd: string; args: string[]; cwd?: string } {
    const fx = fixturesWpDir(this.root);
    if (this.mode === 'compose') return { cmd: 'docker', args: ['compose', '-f', join(fx, 'compose.yaml'), 'exec', '-T', 'cli', 'wp', ...args] };
    if (this.mode === 'wp-env') return { cmd: 'npx', args: ['-y', '@wordpress/env@10.32.0', 'run', 'cli', 'wp', ...args], cwd: existsSync(fx) ? fx : undefined };
    const wp = this.cfg.access.wordpress;
    const alias = this.stage === 'staging' ? wp?.wpCliAliasStaging ?? '@staging' : wp?.wpCliAliasProduction ?? '@production';
    return { cmd: 'wp', args: [alias, ...args] };
  }

  async raw(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const local = this.mode !== 'alias';
    if (!local && !this.allowWrites && !wpCommandIsReadOnly(args)) throw new WpCliError(`Refusing write command on ${this.stage}: wp ${args.join(' ')} (writes go through the executor after approval).`);
    const a = this.argv(args);
    return this.runner(a.cmd, a.args, { cwd: a.cwd, timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input });
  }

  async text(args: string[]): Promise<string> {
    const r = await this.raw(args);
    if (r.code !== 0) throw new WpCliError(describeFailure('wp', args, r));
    return r.stdout.trim();
  }

  async json<T = unknown>(args: string[]): Promise<T> {
    const t = await this.text([...args, '--format=json']);
    const start = t.search(/[[{]/);
    return JSON.parse(start > 0 ? t.slice(start) : t) as T;
  }

  /** Read-only SQL, tab-separated rows. */
  async sql(query: string): Promise<string[][]> {
    if (!isReadOnlySql(query)) throw new WpCliError(`Not read-only SQL: ${query}`);
    const t = await this.text(['db', 'query', query, '--skip-column-names']);
    return t ? t.split('\n').map((l) => l.split('\t')) : [];
  }

  async has(command: string): Promise<boolean> {
    const r = await this.raw(['help', ...command.split(' ')]).catch(() => undefined);
    return !!r && r.code === 0;
  }
}
