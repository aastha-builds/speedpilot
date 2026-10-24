import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config/site.js';
import type { Stage } from '../store/store.js';
import { WpCli, fixturesWpDir } from '../backend/wpcli.js';
import { run, type Runner, type ExecResult } from '../util/exec.js';

/**
 * Where a WordPress stage lives and how SpeedPilot's executor talks to it: the local fixture (docker compose), a local
 * clone (restore or staging compose project), or a remote server over SSH. Used by backup, restore, staging and the
 * executor only; Claude never runs ad-hoc scripts against a client site (CLAUDE.md rule 10).
 */
export interface WpHost {
  label: string;
  stage: Stage;
  docroot: string;
  url: string;
  /** Runs a shell command on the host and returns its output. */
  shell(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Streams a command's stdout into a local file (no temporary file on the server). */
  streamOut(cmd: string, localFile: string): Promise<number>;
  /** Streams a local file into a command's stdin. */
  streamIn(cmd: string, localFile: string): Promise<number>;
  /** Same as shell/streamOut but where WP-CLI is installed (the cli container for compose hosts). */
  cliShell(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  cliStreamOut(cmd: string, localFile: string): Promise<number>;
  cliStreamIn(cmd: string, localFile: string): Promise<number>;
  wp: WpCli;
}

function spawnStream(cmd: string, args: string[], io: { stdoutTo?: string; stdinFrom?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [io.stdinFrom ? 'pipe' : 'ignore', io.stdoutTo ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on("data", (d: Buffer) => (err += d));
    if (io.stdoutTo) child.stdout!.pipe(createWriteStream(io.stdoutTo));
    if (io.stdinFrom) createReadStream(io.stdinFrom).pipe(child.stdin!);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(0) : reject(new Error(`${cmd} ${args.slice(0, 6).join(' ')} exited ${code}: ${err.slice(0, 400)}`))));
  });
}

/** A docker compose project with a `wordpress` service (fixture, restore or local staging). */
export function composeHost(opts: { composeFile: string; project?: string; stage: Stage; url: string; root: string; cfg: SiteConfig; label: string; runner?: Runner }): WpHost {
  const base = ['compose', '-f', opts.composeFile, ...(opts.project ? ['-p', opts.project] : [])];
  const runner = opts.runner ?? run;
  const wpRunner: Runner = (cmd, args, o) => {
    // WpCli builds `docker compose -f <fixture> exec -T cli wp ...`; redirect it to this project
    if (cmd === 'docker' && args[0] === 'compose') {
      const i = args.indexOf('exec');
      return runner('docker', [...base, ...args.slice(i)], o);
    }
    return runner(cmd, args, o);
  };
  return {
    label: opts.label,
    stage: opts.stage,
    docroot: '/var/www/html',
    url: opts.url,
    shell: (cmd, o) => runner('docker', [...base, 'exec', '-T', 'wordpress', 'sh', '-c', cmd], { timeoutMs: o?.timeoutMs ?? 600_000 }),
    streamOut: (cmd, file) => spawnStream('docker', [...base, 'exec', '-T', 'wordpress', 'sh', '-c', cmd], { stdoutTo: file }),
    streamIn: (cmd, file) => spawnStream('docker', [...base, 'exec', '-T', 'wordpress', 'sh', '-c', cmd], { stdinFrom: file }),
    cliShell: (cmd, o) => runner('docker', [...base, 'exec', '-T', 'cli', 'sh', '-c', cmd], { timeoutMs: o?.timeoutMs ?? 600_000 }),
    cliStreamOut: (cmd, file) => spawnStream('docker', [...base, 'exec', '-T', 'cli', 'sh', '-c', cmd], { stdoutTo: file }),
    cliStreamIn: (cmd, file) => spawnStream('docker', [...base, 'exec', '-T', 'cli', 'sh', '-c', cmd], { stdinFrom: file }),
    wp: new WpCli(opts.root, { ...opts.cfg, local: true }, 'local', wpRunner, true),
  };
}

/** The local WordPress fixture (pnpm fixtures:wp up, compose engine). */
export function fixtureHost(root: string, cfg: SiteConfig): WpHost {
  return composeHost({ composeFile: join(fixturesWpDir(root), 'compose.yaml'), stage: 'local', url: cfg.productionUrl.replace(/\/$/, ''), root, cfg, label: 'local fixture' });
}

/** A remote server over SSH (WP-CLI through the stage alias). Writes are only issued by the executor after approval. */
export function sshHost(root: string, cfg: SiteConfig, stage: 'staging' | 'production', opts: { docroot?: string; runner?: Runner; allowWrites?: boolean } = {}): WpHost {
  const wpCfg = cfg.access.wordpress;
  const host = stage === 'staging' ? wpCfg?.sshStaging : wpCfg?.sshProduction;
  if (!host) throw new Error(`site.yaml has no access.wordpress.ssh${stage === 'staging' ? 'Staging' : 'Production'} host`);
  const docroot = opts.docroot ?? '~/public_html';
  const runner = opts.runner ?? run;
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host];
  return {
    label: `${stage} (${host})`,
    stage,
    docroot,
    url: (stage === 'staging' ? cfg.stagingUrl : cfg.productionUrl)!.replace(/\/$/, ''),
    shell: (cmd, o) => runner('ssh', [...sshArgs, cmd], { timeoutMs: o?.timeoutMs ?? 600_000 }),
    streamOut: (cmd, file) => spawnStream('ssh', [...sshArgs, cmd], { stdoutTo: file }),
    streamIn: (cmd, file) => spawnStream('ssh', [...sshArgs, cmd], { stdinFrom: file }),
    cliShell: (cmd, o) => runner('ssh', [...sshArgs, cmd], { timeoutMs: o?.timeoutMs ?? 600_000 }),
    cliStreamOut: (cmd, file) => spawnStream('ssh', [...sshArgs, cmd], { stdoutTo: file }),
    cliStreamIn: (cmd, file) => spawnStream('ssh', [...sshArgs, cmd], { stdinFrom: file }),
    wp: new WpCli(root, cfg, stage, runner, opts.allowWrites ?? false),
  };
}

export function hostFor(root: string, cfg: SiteConfig, stage: Stage, opts: { allowWrites?: boolean } = {}): WpHost {
  if (cfg.local || stage === 'local') return fixtureHost(root, cfg);
  return sshHost(root, cfg, stage as 'staging' | 'production', { allowWrites: opts.allowWrites });
}

export function composeAvailable(file: string): boolean {
  return existsSync(file);
}
