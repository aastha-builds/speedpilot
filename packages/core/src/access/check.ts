import { secret, type SiteConfig } from '../config/site.js';
import { run as defaultRun, type Runner } from '../util/exec.js';
import { redactString } from '../log.js';

export interface ProbeResult {
  probe: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
  /** When least-privilege access can be revoked (SPEC.md 12). */
  revoke?: string;
}

export interface AccessDeps {
  run?: Runner;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function basicAuth(user: string, pass: string) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function probeWpCli(cfg: SiteConfig, stage: 'staging' | 'production', d: Required<AccessDeps>): Promise<ProbeResult[]> {
  const wp = cfg.access.wordpress;
  if (!wp) return [];
  const out: ProbeResult[] = [];
  const alias = stage === 'staging' ? wp.wpCliAliasStaging : wp.wpCliAliasProduction;
  const sshHost = stage === 'staging' ? wp.sshStaging : wp.sshProduction;
  if (wp.wpEnv) {
    const r = await d.run('npx', ['wp-env', 'run', 'cli', 'wp', 'core', 'version'], { cwd: 'fixtures/wp', timeoutMs: 120_000 });
    out.push({ probe: 'wp-env WP-CLI', ok: r.code === 0, detail: r.code === 0 ? `WordPress ${r.stdout.trim()}` : redactString(r.stderr.slice(0, 300)) });
    return out;
  }
  if (sshHost) {
    const r = await d.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, 'uptime'], { timeoutMs: 30_000 });
    out.push({ probe: `SSH ${stage}`, ok: r.code === 0, detail: r.code === 0 ? 'reachable (read-only uptime)' : redactString(r.stderr.trim().slice(0, 300)) });
  } else out.push({ probe: `SSH ${stage}`, ok: false, skipped: true, detail: 'no SSH host in site.yaml' });
  const r = await d.run('wp', [alias, 'core', 'version', '--extra'], { timeoutMs: 60_000 });
  out.push({
    probe: `WP-CLI ${alias}`,
    ok: r.code === 0,
    detail: r.code === 0 ? r.stdout.trim().split('\n').slice(0, 3).join('; ') : `failed: ${redactString(r.stderr.trim().slice(0, 300))} (define ${alias} in wp-cli.yml)`,
  });
  return out;
}

async function probeWpRest(cfg: SiteConfig, stage: 'staging' | 'production', d: Required<AccessDeps>): Promise<ProbeResult[]> {
  const wp = cfg.access.wordpress;
  const base = stage === 'staging' ? cfg.stagingUrl : cfg.productionUrl;
  if (!wp || !base) return [];
  const user = secret(wp.restUser, d.env);
  const pass = secret(wp.restAppPassword, d.env);
  if (!user || !pass) return [{ probe: `REST ${stage}`, ok: false, skipped: true, detail: `set ${wp.restUser ?? 'restUser'} and ${wp.restAppPassword ?? 'restAppPassword'} in .env` }];
  const results: ProbeResult[] = [];
  try {
    const res = await d.fetch(new URL('wp-json/wp/v2/users/me?context=edit', base.endsWith('/') ? base : base + '/'), {
      method: 'GET',
      headers: { Authorization: basicAuth(user, pass), Accept: 'application/json' },
    });
    if (!res.ok) results.push({ probe: `REST ${stage}`, ok: false, detail: `HTTP ${res.status}` });
    else {
      const me = (await res.json()) as { slug?: string; capabilities?: Record<string, boolean> };
      const admin = Boolean(me.capabilities?.manage_options);
      results.push({
        probe: `REST ${stage}`,
        ok: admin,
        detail: admin ? `authenticated as ${me.slug ?? 'user'} with manage_options` : 'authenticated but the user lacks manage_options (the agent diagnostics need it)',
        revoke: 'Revoke the Application Password in Users > Profile after the job.',
      });
    }
    const agent = await d.fetch(new URL('wp-json/speedpilot/v1/ping', base.endsWith('/') ? base : base + '/'), { method: 'GET', headers: { Authorization: basicAuth(user, pass) } });
    results.push({ probe: `SpeedPilot agent ${stage}`, ok: agent.ok, detail: agent.ok ? 'agent mu-plugin answers' : `agent not reachable (HTTP ${agent.status}); install packages/wp-agent as an mu-plugin` });
  } catch (e) {
    results.push({ probe: `REST ${stage}`, ok: false, detail: redactString(String((e as Error).message)) });
  }
  return results;
}

async function probeShopify(cfg: SiteConfig, d: Required<AccessDeps>): Promise<ProbeResult[]> {
  const sh = cfg.access.shopify;
  if (!sh) return [];
  const out: ProbeResult[] = [];
  const pw = secret(sh.themeAccessPassword, d.env);
  if (!pw) out.push({ probe: 'Shopify CLI theme list', ok: false, skipped: true, detail: `set ${sh.themeAccessPassword ?? 'themeAccessPassword'} in .env` });
  else {
    const r = await d.run('shopify', ['theme', 'list', '--store', sh.store, '--json'], { env: { ...d.env, SHOPIFY_CLI_THEME_TOKEN: pw }, timeoutMs: 120_000 });
    let detail = redactString((r.stderr || r.stdout).trim().slice(0, 300));
    if (r.code === 0) {
      try {
        const themes = JSON.parse(r.stdout) as Array<{ role: string }>;
        detail = `${themes.length} themes (${themes.filter((t) => t.role === 'live').length} live); library limit is 20`;
      } catch {
        detail = 'theme list ok';
      }
    }
    out.push({ probe: 'Shopify CLI theme list', ok: r.code === 0, detail, revoke: 'Delete the Theme Access password in the Theme Access app after the job.' });
  }
  const token = secret(sh.adminToken, d.env);
  if (!token) out.push({ probe: 'Shopify Admin GraphQL', ok: true, skipped: true, detail: 'optional: no admin token configured' });
  else {
    try {
      const res = await d.fetch(`https://${sh.store}/admin/api/2025-10/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ shop { name primaryDomain { url } } }' }),
      });
      const body = (await res.json()) as { data?: { shop?: { name: string } }; errors?: unknown };
      out.push({ probe: 'Shopify Admin GraphQL', ok: res.ok && !!body.data?.shop, detail: body.data?.shop ? `shop ${body.data.shop.name} (read-only query)` : `HTTP ${res.status}` });
    } catch (e) {
      out.push({ probe: 'Shopify Admin GraphQL', ok: false, detail: redactString(String((e as Error).message)) });
    }
  }
  return out;
}

async function probeGoogle(cfg: SiteConfig, d: Required<AccessDeps>): Promise<ProbeResult[]> {
  const key = secret(cfg.access.googleApiKey, d.env);
  if (!key) return [{ probe: 'Google API key (PSI, CrUX)', ok: true, skipped: true, detail: 'optional: no GOOGLE_API_KEY; PSI and CrUX are skipped' }];
  if (cfg.local) return [{ probe: 'Google API key (PSI, CrUX)', ok: true, skipped: true, detail: 'local site: PSI and CrUX only receive public URLs' }];
  try {
    const res = await d.fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: new URL(cfg.productionUrl).origin }),
    });
    return [{ probe: 'Google API key (PSI, CrUX)', ok: res.ok || res.status === 404, detail: res.ok ? 'CrUX data available' : res.status === 404 ? 'key works; origin has not enough CrUX data' : `HTTP ${res.status}` }];
  } catch (e) {
    return [{ probe: 'Google API key (PSI, CrUX)', ok: false, detail: redactString(String((e as Error).message)) }];
  }
}

/** Read-only probe of every credential (`speedpilot access check`). Never prints secrets. */
export async function accessCheck(cfg: SiteConfig, deps: AccessDeps = {}): Promise<ProbeResult[]> {
  const d: Required<AccessDeps> = { run: deps.run ?? defaultRun, fetch: deps.fetch ?? fetch, env: deps.env ?? process.env };
  const results: ProbeResult[] = [];
  if (cfg.platform === 'wordpress') {
    for (const stage of ['staging', 'production'] as const) {
      if (stage === 'staging' && !cfg.stagingUrl && !cfg.access.wordpress?.sshStaging) continue;
      if (stage === 'staging' && cfg.access.wordpress?.wpEnv) continue;
      results.push(...(await probeWpCli(cfg, stage, d)));
      results.push(...(await probeWpRest(cfg, stage, d)));
    }
  } else results.push(...(await probeShopify(cfg, d)));
  results.push(...(await probeGoogle(cfg, d)));
  return results.map((r) => ({ ...r, detail: redactString(r.detail, Object.values(d.env).filter((v): v is string => !!v && v.length >= 8 && Object.keys(d.env).some((k) => /PASS|TOKEN|KEY|SECRET/.test(k) && d.env[k] === v))) }));
}
