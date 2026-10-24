import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain ESM hook without types
import { decide, parseShell, isReadOnlySql } from '../.claude/hooks/guard.mjs';

const GUARD = new URL('../.claude/hooks/guard.mjs', import.meta.url).pathname;

let root: string;

function bash(command: string, cwd?: string) {
  return decide({ tool_name: 'Bash', tool_input: { command }, cwd: cwd ?? root }, root);
}

function approve(site: string, stage: string, operation: string, hoursAgo = 1) {
  const dir = join(root, 'runs', site, 'approvals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${operation}.${stage}.json`),
    JSON.stringify({ site, stage, operation, items: ['*'], approvedBy: 'Test Human', approvedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString() }),
  );
}

function state(site: string, s: Record<string, unknown>) {
  mkdirSync(join(root, 'runs', site), { recursive: true });
  writeFileSync(join(root, 'runs', site, 'state.json'), JSON.stringify(s));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-guard-'));
  mkdirSync(join(root, 'sites', 'demo'), { recursive: true });
  writeFileSync(join(root, 'sites', 'demo', 'site.yaml'), 'platform: wordpress\n');
  writeFileSync(join(root, '.env.example'), 'GOOGLE_API_KEY=\nWP_DEMO_REST_APP_PASSWORD=\n');
  state('demo', {
    hosts: { staging: ['staging.example.com'], production: ['www.example.com'] },
    store: 'demo.myshopify.com',
    workThemeId: '111',
    liveThemeId: '999',
    currentTarget: { stage: 'production', url: 'https://www.example.com/' },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('shell parsing', () => {
  it('splits segments and finds subshells', () => {
    const r = parseShell(`ls -la && echo "a b" | wc -l; x=$(wp @production option update a b)`);
    expect(r.segments.map((s: string[]) => s[0])).toEqual(['ls', 'echo', 'wc', 'x=$(wp @production option update a b)']);
    expect(r.subshells).toEqual(['wp @production option update a b']);
  });
  it('recognizes read-only SQL', () => {
    expect(isReadOnlySql('SELECT * FROM wp_options')).toBe(true);
    expect(isReadOnlySql('SHOW TABLES; EXPLAIN SELECT 1')).toBe(true);
    expect(isReadOnlySql('DROP TABLE x')).toBe(false);
    expect(isReadOnlySql('SELECT 1; DELETE FROM wp_posts')).toBe(false);
    expect(isReadOnlySql('SELECT * INTO OUTFILE "/tmp/x" FROM wp_users')).toBe(false);
  });
});

describe('read-only allowlist on remote stages passes without approval', () => {
  const ok = [
    'wp @production core version',
    'wp @production plugin list --format=json',
    'wp @staging theme list',
    'wp @production option get siteurl',
    'wp @production option list --autoload=on --format=json',
    'wp @production cron event list',
    'wp @production db size --tables',
    'wp @production db tables',
    'wp @staging doctor check --all',
    'wp @staging profile stage --url=https://staging.example.com/',
    'wp @staging profile hook --all --spotlight --url=https://staging.example.com/',
    'wp @production db query "SELECT option_name FROM wp_options LIMIT 5"',
    'wp @staging search-replace https://www.example.com https://staging.example.com --all-tables --precise --dry-run',
    'shopify theme list --store demo.myshopify.com',
    'shopify theme pull --theme 999 --path runs/demo/theme',
    'shopify theme check --output json',
    'shopify theme profile --url / --json',
    'shopify theme info',
    'ssh deploy@www.example.com df -h',
    'ssh deploy@www.example.com "tail -n 200 /var/log/nginx/error.log"',
    'ssh deploy@www.example.com php -v',
    'ssh deploy@www.example.com wp plugin list',
    'speedpilot audit demo --stage production',
    'speedpilot backup demo --stage production',
    'curl -sS https://www.example.com/robots.txt',
    'ls -la && pnpm test',
  ];
  for (const cmd of ok) it(cmd, () => expect(bash(cmd)).toEqual({ allow: true }));
});

describe('writes are blocked without an approval file and allowed with one', () => {
  const writes: Array<[string, string, string]> = [
    ['wp @production option update blogname x', 'demo', 'production'],
    ['wp @staging db query "DROP TABLE x"', 'demo', 'staging'],
    ['wp @staging search-replace a b', 'demo', 'staging'],
    ['wp @production plugin deactivate hello', 'demo', 'production'],
    ['wp @production transient delete --expired', 'demo', 'production'],
    ["ssh deploy@www.example.com \"sed -i 's/a/b/' /var/www/wp-config.php\"", 'demo', 'production'],
    ['ssh deploy@staging.example.com "echo x > /var/www/html/.htaccess"', 'demo', 'staging'],
    ['shopify theme publish --theme 111', 'demo', 'production'],
    ['shopify theme push --theme 111 --nodelete --only layout/theme.liquid', 'demo', 'staging'],
    ['scp wp-config.php deploy@www.example.com:/var/www/', 'demo', 'production'],
    ['curl -X POST https://www.example.com/wp-json/wp/v2/posts -d x=1', 'demo', 'production'],
    ['mysql -h www.example.com -e "UPDATE wp_options SET option_value=1"', 'demo', 'production'],
  ];
  for (const [cmd, site, stage] of writes) {
    it(`blocks: ${cmd}`, () => {
      const r = bash(cmd);
      expect(r.allow).toBe(false);
      expect(r.reason).toMatch(/approval/i);
    });
    it(`allows with approval: ${cmd}`, () => {
      approve(site, stage, 'plan-1');
      expect(bash(cmd)).toEqual({ allow: true });
    });
  }

  it('an approval older than 24 hours does not count', () => {
    approve('demo', 'production', 'plan-1', 25);
    expect(bash('wp @production option update blogname x').allow).toBe(false);
  });
  it('an approval for the other stage does not count', () => {
    approve('demo', 'staging', 'plan-1');
    expect(bash('wp @production option update blogname x').allow).toBe(false);
  });
  it('an approval for another site does not count', () => {
    approve('other', 'production', 'plan-1');
    expect(bash('wp @production option update blogname x').allow).toBe(false);
  });
  it('a push without the work theme ID is blocked even with approval', () => {
    approve('demo', 'staging', 'plan-1');
    const r = bash('shopify theme push --nodelete');
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/work theme/);
  });
  it('a push to a theme other than the work theme is blocked even with approval', () => {
    approve('demo', 'staging', 'plan-1');
    expect(bash('shopify theme push --theme 999').allow).toBe(false);
  });
  it('speedpilot apply needs the plan approval for that stage', () => {
    expect(bash('speedpilot apply plan-7 --stage staging').allow).toBe(false);
    approve('demo', 'staging', 'plan-7');
    expect(bash('speedpilot apply plan-7 --stage staging')).toEqual({ allow: true });
    expect(bash('speedpilot deploy plan-7').allow).toBe(false);
  });
});

describe('never allowlisted', () => {
  it('wp eval and eval-file are blocked even with approval', () => {
    approve('demo', 'production', 'plan-1');
    expect(bash('wp @production eval "echo 1;"').allow).toBe(false);
    expect(bash('wp @production eval-file x.php').allow).toBe(false);
    expect(bash('wp @production plugin list --exec="system(1);"').allow).toBe(false);
  });
  it('wp db export outside speedpilot backup is blocked', () => {
    expect(bash('wp @production db export - --single-transaction').allow).toBe(false);
  });
});

describe('always blocked, even with approval', () => {
  beforeEach(() => {
    approve('demo', 'production', 'plan-1');
    approve('demo', 'staging', 'plan-1');
  });
  const always = [
    'shopify theme push --theme 111 --live',
    'shopify theme push --theme 111 --allow-live',
    'shopify theme push -t 111 -a',
    'cat .env',
    'grep KEY .env',
    'head -n 3 ./.env.local',
    'node -e "1" < .env',
    'printenv',
    'env',
    'echo $GOOGLE_API_KEY',
    'echo "${WP_DEMO_REST_APP_PASSWORD}"',
    'speedpilot approve plan-1 --stage production --items all --by "Claude"',
    'pnpm speedpilot approve plan-1 --stage staging --items a --by x',
    'node packages/cli/dist/index.js approve staging-prep --site demo --stage staging --by x',
    'git push --force origin main',
    'git push -f origin main',
    'git push origin +main',
    'rm -rf /var/www',
    'rm -rf packages',
    'rm -fr ~/',
    'bash -c "rm -rf /"',
    'echo $(cat .env)',
    'ls && speedpilot approve x --stage staging --by y',
  ];
  for (const cmd of always) it(cmd, () => expect(bash(cmd).allow).toBe(false));

  it('rm -rf inside runs/ is allowed', () => {
    expect(bash('rm -rf runs/demo/tmp')).toEqual({ allow: true });
  });
  it('cat .env.example is allowed', () => {
    expect(bash('cat .env.example')).toEqual({ allow: true });
  });
});

describe('stage detection', () => {
  it('an unknown stage counts as production', () => {
    const r = bash('wp option update blogname x');
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/production/);
    approve('demo', 'staging', 'plan-1');
    expect(bash('wp option update blogname x').allow).toBe(false);
    expect(bash('ssh root@unknown-host.example.org "touch /x"').reason).toMatch(/production/);
  });
  it('local wp-env fixture commands pass', () => {
    expect(bash('npx wp-env run cli wp option update blogname x')).toEqual({ allow: true });
    expect(bash('wp-env run cli wp eval "echo 1;"')).toEqual({ allow: true });
    expect(bash('pnpm fixtures:wp reset')).toEqual({ allow: true });
  });
  it('site-qualified aliases are placed by site', () => {
    expect(bash('wp @shop.staging option update a b').allow).toBe(false);
    approve('shop', 'staging', 'p');
    expect(bash('wp @shop.staging option update a b')).toEqual({ allow: true });
  });
});

describe('Chrome DevTools MCP input tools', () => {
  it('are blocked unless the state says local or staging', () => {
    expect(decide({ tool_name: 'mcp__chrome-devtools__click', tool_input: {} }, root).allow).toBe(false);
    expect(decide({ tool_name: 'mcp__chrome-devtools__fill_form', tool_input: {} }, root).allow).toBe(false);
    expect(decide({ tool_name: 'mcp__chrome-devtools__performance_start_trace', tool_input: {} }, root)).toEqual({ allow: true });
    state('demo', { currentTarget: { stage: 'staging' } });
    expect(decide({ tool_name: 'mcp__chrome-devtools__click', tool_input: {} }, root)).toEqual({ allow: true });
    state('demo', { currentTarget: { stage: 'local' } });
    expect(decide({ tool_name: 'mcp__chrome-devtools__type_text', tool_input: {} }, root)).toEqual({ allow: true });
  });
  it('are blocked when there is no state at all', () => {
    rmSync(join(root, 'runs'), { recursive: true, force: true });
    expect(decide({ tool_name: 'mcp__chrome-devtools__click', tool_input: {} }, root).allow).toBe(false);
  });
});

describe('hook process contract', () => {
  it('exits 2 with a reason on stderr when blocked, 0 when allowed', () => {
    const env = { ...process.env, SPEEDPILOT_ROOT: root };
    const blocked = spawnSync('node', [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat .env' } }), env, encoding: 'utf8' });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/blocked/);
    const allowed = spawnSync('node', [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), env, encoding: 'utf8' });
    expect(allowed.status).toBe(0);
    const garbage = spawnSync('node', [GUARD], { input: 'not json', env, encoding: 'utf8' });
    expect(garbage.status).toBe(2);
  });
  it('blocks Read of .env', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: '/x/.env' } }, root).allow).toBe(false);
    expect(decide({ tool_name: 'Read', tool_input: { file_path: '/x/.env.example' } }, root)).toEqual({ allow: true });
  });
});
