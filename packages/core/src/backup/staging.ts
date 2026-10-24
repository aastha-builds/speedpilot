import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SiteConfig } from '../config/site.js';
import type { Store } from '../store/store.js';
import { requireApproval } from '../approvals.js';
import { writeState } from '../state.js';
import { createLocalClone, STAGING_GUARD_FILE } from './clone.js';
import { sshHost, type WpHost } from './host.js';

export interface NeutralizationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface StagingResult {
  mode: 'local-clone' | 'remote';
  url: string;
  checks: NeutralizationCheck[];
  pass: boolean;
  project?: string;
}

const EVAL_CHECKS: Array<{ name: string; php: string; expect: RegExp }> = [
  { name: 'email never leaves staging', php: 'var_export( wp_mail( "customer@example.com", "SpeedPilot staging test", "x" ) );', expect: /^false$/ },
  { name: 'webhooks and outgoing HTTP are blocked', php: '$r = wp_remote_post( "https://hooks.example.com/webhook", array( "body" => "x" ) ); echo is_wp_error( $r ) ? $r->get_error_code() : "SENT";', expect: /^speedpilot_staging_blocked$/ },
  { name: 'only test-mode or offline payment gateways remain', php: '$live = new class { public function get_option( $k ) { return "no"; } }; $test = new class { public function get_option( $k ) { return "testmode" === $k ? "yes" : "no"; } }; echo implode( ",", array_keys( apply_filters( "woocommerce_available_payment_gateways", array( "stripe_live" => $live, "stripe_test" => $test, "bacs" => $live ) ) ) );', expect: /^stripe_test,bacs$/ },
  { name: 'WooCommerce webhooks paused', php: 'var_export( apply_filters( "woocommerce_webhook_should_deliver", true, null, null ) );', expect: /^false$/ },
  { name: 'cron jobs paused', php: 'var_export( apply_filters( "pre_get_ready_cron_jobs", null ) );', expect: /^array \(\s*\)$/ },
  { name: 'Action Scheduler paused', php: 'echo (int) apply_filters( "action_scheduler_queue_runner_concurrent_batches", 5 );', expect: /^0$/ },
  { name: 'search engines discouraged', php: 'echo get_option( "blog_public" );', expect: /^0$/ },
];

/** Proves the neutralization works on a staging host (SPEC.md 5.2). */
export async function verifyNeutralization(host: WpHost): Promise<NeutralizationCheck[]> {
  const out: NeutralizationCheck[] = [];
  for (const c of EVAL_CHECKS) {
    const r = await host.wp.raw(['eval', c.php]);
    const got = r.stdout.trim();
    out.push({ name: c.name, pass: r.code === 0 && c.expect.test(got), detail: got.slice(0, 200) || r.stderr.slice(0, 200) });
  }
  const res = await fetch(host.url + '/', { redirect: 'manual' }).catch(() => undefined);
  const robots = res?.headers.get('x-robots-tag') ?? '';
  out.push({ name: 'noindex header', pass: /noindex/.test(robots), detail: robots || `HTTP ${res?.status ?? 'unreachable'}` });
  const log = await host.shell('cat /var/www/html/wp-content/uploads/speedpilot/staging-guard.log 2>/dev/null || cat wp-content/uploads/speedpilot/staging-guard.log 2>/dev/null');
  out.push({ name: 'blocked email and HTTP are logged', pass: /mail/.test(log.stdout) && /http/.test(log.stdout), detail: log.stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 300) });
  return out;
}

/**
 * `speedpilot staging prepare` for WordPress (SPEC.md 5.2). Needs the staging-prep approval.
 * Without a host staging site, SpeedPilot clones the latest verified backup into a local Docker staging copy.
 */
export async function prepareWordPressStaging(root: string, cfg: SiteConfig, store: Store, opts: { port?: number; backupId?: string; stagingAuth?: string; env?: NodeJS.ProcessEnv } = {}): Promise<StagingResult> {
  requireApproval(root, { site: cfg.name, operation: 'staging-prep', stage: cfg.local ? 'local' : 'staging' });
  const remote = !!(cfg.stagingUrl && cfg.access.wordpress?.sshStaging);
  if (remote) {
    const host = sshHost(root, cfg, 'staging', { allowWrites: true });
    // search-replace production URL -> staging URL: dry run first, apply only when the dry run finds replacements
    const from = cfg.productionUrl.replace(/\/$/, '');
    const to = cfg.stagingUrl!.replace(/\/$/, '');
    const dry = await host.wp.text(['search-replace', from, to, '--all-tables', '--precise', '--dry-run', '--format=count']).catch(() => '0');
    if (Number(dry) > 0) await host.wp.text(['search-replace', from, to, '--all-tables', '--precise']);
    const tmp = join(mkdtempSync(join(tmpdir(), 'sp-guard-')), 'guard.php');
    writeFileSync(tmp, readFileSync(STAGING_GUARD_FILE));
    await host.streamIn(`mkdir -p ${host.docroot}/wp-content/mu-plugins && cat > ${host.docroot}/wp-content/mu-plugins/speedpilot-staging-guard.php`, tmp);
    await host.wp.raw(['option', 'update', 'blog_public', '0']);
    const checks = await verifyNeutralization(host);
    writeState(root, cfg.name, { hosts: { staging: [new URL(cfg.stagingUrl!).hostname], production: [new URL(cfg.productionUrl).hostname] } });
    return { mode: 'remote', url: to, checks, pass: checks.every((c) => c.pass) };
  }
  const backup = opts.backupId ? store.backups(cfg.name).find((b) => b.id === opts.backupId) : store.backups(cfg.name).find((b) => b.restoreTested && (b.stage === 'production' || b.stage === 'local'));
  if (!backup) throw new Error('No verified backup to build staging from. Run `speedpilot backup` and `speedpilot backup verify` first.');
  const clone = await createLocalClone(root, cfg, backup.location, { name: `staging-${cfg.name}`, port: opts.port ?? 8897, env: opts.env, stagingAuth: opts.stagingAuth });
  const checks = await verifyNeutralization(clone.host);
  writeState(root, cfg.name, { currentTarget: { stage: 'staging', url: clone.url }, snapshot: { stagingProject: clone.project, stagingCompose: clone.composeFile, stagingUrl: clone.url, fromBackup: backup.id } });
  return { mode: 'local-clone', url: clone.url, checks, pass: checks.every((c) => c.pass), project: clone.project };
}
