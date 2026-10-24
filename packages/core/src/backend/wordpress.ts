import { secret, type SiteConfig } from '../config/site.js';
import type { Stage } from '../store/store.js';
import type { Runner } from '../util/exec.js';
import { WpCli } from './wpcli.js';
import { AgentClient, type AgentDiag } from './agent.js';
import { log, redactString } from '../log.js';

/** Fixture-only agent secret, used when a local fixture has no env var. Never valid on a real site. */
export const FIXTURE_HMAC_SECRET = 'fixture-only-hmac-secret-not-for-production';

export interface WpBackend {
  stage: Stage;
  core?: string;
  plugins: Array<{ name: string; status: string; version: string; update: string }>;
  themes: Array<{ name: string; status: string; version: string; update: string }>;
  environment?: Record<string, unknown>;
  autoload?: { total_bytes: number; count: number; top: Array<{ name: string; bytes: number; owner: string }>; expired_transients: number };
  cron?: { events: Array<{ hook: string; next: number; overdue: boolean; schedule: string | false; interval: number | null }>; disable_wp_cron: boolean; overdue: number; tooFrequent: string[]; duplicates: string[] };
  database: {
    tables: Array<{ name: string; bytes: number; engine?: string; rows?: number }>;
    revisions?: number;
    autoDrafts?: number;
    orphanPostmeta?: number;
    orphanTermmeta?: number;
    orphanCommentmeta?: number;
    spamComments?: number;
    trashComments?: number;
    actionScheduler?: { pending: number; failed: number; pastDue: number; complete: number; bytes: number };
    wcSessions?: { rows: number; bytes: number };
    myisam: string[];
  };
  perUrl: Array<{
    url: string;
    diag?: AgentDiag;
    serverTiming: Record<string, number>;
    ttfbCachedMs?: number;
    ttfbBypassMs?: number;
    cacheHeaders: Record<string, string>;
    profileStage?: unknown;
    profileHook?: unknown;
  }>;
  builder: Record<string, unknown>;
  doctor?: unknown;
  adminTimings?: Array<{ page: string; ms: number; status: number }>;
  debugLogTail?: string[];
  existingOptimizers: string[];
  notes: string[];
}

const OPTIMIZER_PLUGINS: Record<string, string> = {
  'wp-rocket': 'WP Rocket',
  'litespeed-cache': 'LiteSpeed Cache',
  'w3-total-cache': 'W3 Total Cache',
  'wp-super-cache': 'WP Super Cache',
  'wp-fastest-cache': 'WP Fastest Cache',
  autoptimize: 'Autoptimize',
  'flying-press': 'FlyingPress',
  perfmatters: 'Perfmatters',
  'nitropack': 'NitroPack',
  'swift-performance-lite': 'Swift Performance',
  'wp-smushit': 'Smush',
  'shortpixel-image-optimiser': 'ShortPixel',
  imagify: 'Imagify',
  'ewww-image-optimizer': 'EWWW',
  'wp-asset-clean-up': 'Asset CleanUp',
  'sg-cachepress': 'SiteGround Optimizer',
  'breeze': 'Breeze',
  'optimization-detective': 'Optimization Detective',
  'image-prioritizer': 'Image Prioritizer',
};

export interface WpBackendDeps {
  run?: Runner;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

async function timeFetch(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<{ ms: number; headers: Record<string, string>; status: number }> {
  const t0 = performance.now();
  const r = await f(url, { headers, redirect: 'manual' });
  // TTFB: time until headers arrive
  const ms = performance.now() - t0;
  await r.arrayBuffer().catch(() => undefined);
  const h: Record<string, string> = {};
  for (const k of ['x-cache', 'cf-cache-status', 'age', 'x-litespeed-cache', 'x-proxy-cache', 'x-sg-cache', 'x-kinsta-cache', 'cache-control', 'server-timing']) {
    const v = r.headers.get(k);
    if (v) h[k] = v;
  }
  return { ms: Math.round(ms), headers: h, status: r.status };
}

/** WordPress backend collection (SPEC.md 3.9). Read-only on production. */
export async function collectWordPressBackend(root: string, cfg: SiteConfig, stage: Stage, urls: string[], deps: WpBackendDeps = {}): Promise<WpBackend> {
  const f = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const wp = new WpCli(root, cfg, stage, deps.run);
  const notes: string[] = [];
  const base = stage === 'staging' && cfg.stagingUrl ? cfg.stagingUrl : cfg.productionUrl;
  const out: WpBackend = { stage, plugins: [], themes: [], database: { tables: [], myisam: [] }, perUrl: [], builder: {}, existingOptimizers: [], notes };
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      notes.push(`${label}: ${redactString((e as Error).message).slice(0, 200)}`);
      return undefined;
    }
  };

  out.core = await safe('core version', () => wp.text(['core', 'version']));
  out.plugins = (await safe('plugin list', () => wp.json<WpBackend['plugins']>(['plugin', 'list', '--fields=name,status,version,update']))) ?? [];
  out.themes = (await safe('theme list', () => wp.json<WpBackend['themes']>(['theme', 'list', '--fields=name,status,version,update']))) ?? [];
  out.existingOptimizers = out.plugins.filter((p) => p.status === 'active' && OPTIMIZER_PLUGINS[p.name]).map((p) => OPTIMIZER_PLUGINS[p.name]!);

  // Agent diagnostics (environment, autoload, cron, per-URL handle map, queries on staging)
  const hmac = secret(cfg.access.wordpress?.agentHmacSecret, env) ?? (cfg.local ? FIXTURE_HMAC_SECRET : undefined);
  const user = secret(cfg.access.wordpress?.restUser, env);
  const pass = secret(cfg.access.wordpress?.restAppPassword, env);
  const agent = new AgentClient(base, hmac, user && pass ? { user, pass } : undefined, f);
  out.environment = await safe('agent env', async () => (await agent.rest<Record<string, unknown>>('env')) ?? Promise.reject(new Error('agent not reachable; install packages/wp-agent as an mu-plugin')));
  out.autoload = await safe('agent autoload', async () => (await agent.rest<NonNullable<WpBackend['autoload']>>('autoload')) ?? Promise.reject(new Error('no autoload data')));
  const cron = await safe('agent cron', async () => (await agent.rest<{ events: NonNullable<WpBackend['cron']>['events']; disable_wp_cron: boolean }>('cron')) ?? Promise.reject(new Error('no cron data')));
  if (cron) {
    const counts = new Map<string, number>();
    for (const e of cron.events) counts.set(e.hook, (counts.get(e.hook) ?? 0) + 1);
    out.cron = {
      ...cron,
      overdue: cron.events.filter((e) => e.overdue).length,
      tooFrequent: [...new Set(cron.events.filter((e) => e.interval !== null && e.interval < 300).map((e) => e.hook))],
      duplicates: [...counts.entries()].filter(([, n]) => n > 1).map(([h]) => h),
    };
  }

  // Database (read-only SQL)
  const prefixRow = await safe('db prefix', () => wp.sql("SHOW TABLES LIKE '%options'"));
  const prefix = prefixRow?.[0]?.[0]?.replace(/options$/, '') ?? 'wp_';
  const tables = await safe('table sizes', () => wp.sql(`SELECT table_name, data_length + index_length, engine, table_rows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 2 DESC`));
  out.database.tables = (tables ?? []).map((r) => ({ name: r[0]!, bytes: Number(r[1]), engine: r[2], rows: Number(r[3]) }));
  out.database.myisam = out.database.tables.filter((t) => t.engine === 'MyISAM').map((t) => t.name);
  const count = async (label: string, q: string) => Number((await safe(label, () => wp.sql(q)))?.[0]?.[0] ?? NaN);
  out.database.revisions = await count('revisions', `SELECT COUNT(*) FROM ${prefix}posts WHERE post_type = 'revision'`);
  out.database.autoDrafts = await count('auto drafts', `SELECT COUNT(*) FROM ${prefix}posts WHERE post_status = 'auto-draft'`);
  out.database.orphanPostmeta = await count('orphan postmeta', `SELECT COUNT(*) FROM ${prefix}postmeta pm LEFT JOIN ${prefix}posts p ON p.ID = pm.post_id WHERE p.ID IS NULL`);
  out.database.orphanTermmeta = await count('orphan termmeta', `SELECT COUNT(*) FROM ${prefix}termmeta tm LEFT JOIN ${prefix}terms t ON t.term_id = tm.term_id WHERE t.term_id IS NULL`);
  out.database.orphanCommentmeta = await count('orphan commentmeta', `SELECT COUNT(*) FROM ${prefix}commentmeta cm LEFT JOIN ${prefix}comments c ON c.comment_ID = cm.comment_id WHERE c.comment_ID IS NULL`);
  out.database.spamComments = await count('spam comments', `SELECT COUNT(*) FROM ${prefix}comments WHERE comment_approved = 'spam'`);
  out.database.trashComments = await count('trash comments', `SELECT COUNT(*) FROM ${prefix}comments WHERE comment_approved = 'trash'`);
  if (out.database.tables.some((t) => t.name === `${prefix}actionscheduler_actions`)) {
    const as = await safe('action scheduler', () => wp.sql(`SELECT status, COUNT(*), SUM(scheduled_date_gmt < UTC_TIMESTAMP()) FROM ${prefix}actionscheduler_actions GROUP BY status`));
    const by = Object.fromEntries((as ?? []).map((r) => [r[0], { n: Number(r[1]), due: Number(r[2]) }]));
    out.database.actionScheduler = {
      pending: by.pending?.n ?? 0,
      failed: by.failed?.n ?? 0,
      pastDue: by.pending?.due ?? 0,
      complete: by.complete?.n ?? 0,
      bytes: out.database.tables.filter((t) => t.name.includes('actionscheduler')).reduce((a, t) => a + t.bytes, 0),
    };
  }
  const sess = out.database.tables.find((t) => t.name === `${prefix}woocommerce_sessions`);
  if (sess) out.database.wcSessions = { rows: sess.rows ?? 0, bytes: sess.bytes };

  // Builder and plugin settings that affect speed, read from options (never assumed)
  const builderOpts = await safe('builder options', () => wp.json<Array<{ option_name: string; option_value: string }>>(['option', 'list', '--search=elementor_*', '--fields=option_name,option_value']));
  for (const o of builderOpts ?? []) if (o.option_value.length < 500) out.builder[o.option_name] = o.option_value;
  for (const name of ['et_divi', 'woocommerce_ajax_variation_threshold', 'woocommerce_custom_orders_table_enabled']) {
    const v = await safe(`option ${name}`, () => wp.text(['option', 'get', name, '--format=json']));
    if (v !== undefined && v.length < 4000) out.builder[name] = v;
  }

  // Per sample URL: handle map, Server-Timing, queries (staging), TTFB cached and bypassed
  for (const url of urls) {
    const d = await safe(`agent diag ${url}`, () => agent.diag(url));
    const cached = await safe(`ttfb ${url}`, () => timeFetch(f, url));
    const bust = new URL(url);
    bust.searchParams.set('sp_nocache', String(Date.now()));
    const bypass = await safe(`ttfb bypass ${url}`, () => timeFetch(f, bust.href, { Cookie: 'wp-settings-time-0=1; wordpress_test_cookie=WP%20Cookie%20check' }));
    const row: WpBackend['perUrl'][number] = { url, diag: d?.diag, serverTiming: d?.serverTiming ?? {}, ttfbCachedMs: cached?.ms, ttfbBypassMs: bypass?.ms, cacheHeaders: cached?.headers ?? {} };
    if (stage !== 'production' || cfg.local) {
      if (await wp.has('profile stage')) {
        row.profileStage = await safe('wp profile stage', () => wp.json(['profile', 'stage', `--url=${url}`]));
        row.profileHook = await safe('wp profile hook', () => wp.json(['profile', 'hook', '--all', '--spotlight', `--url=${url}`]));
      }
    }
    out.perUrl.push(row);
  }
  if (!(await wp.has('profile stage'))) notes.push('wp profile is not installed (wp package install wp-cli/profile-command); hook timings come from the agent Server-Timing instead.');
  if (await wp.has('doctor check')) out.doctor = await safe('wp doctor', () => wp.json(['doctor', 'check', '--all']));
  else notes.push('wp doctor is not installed (wp package install wp-cli/doctor-command).');

  // Admin timings: local fixtures and staging only (never log in to production wp-admin, CLAUDE.md rule 12)
  if (cfg.local) out.adminTimings = await safe('admin timings', () => adminTimings(base, f));

  // debug.log tail when present (never turn display on)
  if (cfg.local) {
    const tail = await safe('debug.log', async () => {
      const r = await wp.raw(['eval', 'echo file_exists(WP_CONTENT_DIR."/debug.log") ? implode("\\n", array_slice(file(WP_CONTENT_DIR."/debug.log"), -50)) : "";']);
      return r.stdout.split('\n').filter(Boolean);
    });
    out.debugLogTail = tail;
  }
  log.debug({ notes: notes.length }, 'wordpress backend collected');
  return out;
}

/** Logs in to a LOCAL fixture with its known fixture credentials and times admin pages (SPEC.md 3.9). */
async function adminTimings(base: string, f: typeof fetch): Promise<Array<{ page: string; ms: number; status: number }>> {
  const login = await f(new URL('wp-login.php', base), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
    body: 'log=admin&pwd=password&wp-submit=Log+In&testcookie=1',
  });
  const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const pages = ['wp-admin/', 'wp-admin/edit.php', 'wp-admin/post-new.php', 'wp-admin/admin.php?page=wc-orders'];
  const out: Array<{ page: string; ms: number; status: number }> = [];
  for (const p of pages) {
    const t0 = performance.now();
    const r = await f(new URL(p, base), { headers: { Cookie: cookies }, redirect: 'manual' });
    await r.arrayBuffer();
    out.push({ page: p, ms: Math.round(performance.now() - t0), status: r.status });
  }
  return out;
}
