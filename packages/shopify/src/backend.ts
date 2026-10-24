import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SiteConfig, Stage, RequestRow } from '@speedpilot/core';
import { themeFiles } from './preview.js';
import { ShopifyCli } from './cli.js';

export interface ThemeCheckOffense {
  check: string;
  file: string;
  message: string;
  severity: number;
  line?: number;
}

export interface AppEmbed {
  id: string;
  app: string;
  block: string;
  enabled: boolean;
}

export interface ShopifyBackend {
  stage: Stage;
  themeDir: string;
  theme: { name: string; version: string; os2: boolean; files: Array<{ path: string; bytes: number }>; totalBytes: number };
  themeCount?: number;
  themeCheck: ThemeCheckOffense[];
  profile: Array<{ url: string; totalMs: number | null; hotSpots: Array<{ file: string; ms: number; calls?: number }>; source: 'shopify-cli' | 'local-preview' }>;
  appEmbeds: AppEmbed[];
  sectionsPerTemplate: Record<string, string[]>;
  apps: Array<{ app: string; requests: number; kb: number; pages: string[] }>;
  leftovers: Array<{ file: string; app: string; reason: string; renderedIn: string[] }>;
  speculationRulesHeader: string | null;
  notes: string[];
}

export function readJsonLoose<T = Record<string, unknown>>(p: string): T | undefined {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as T;
  } catch {
    return undefined;
  }
}

export function appEmbeds(themeDir: string): AppEmbed[] {
  const sd = readJsonLoose<{ current?: { blocks?: Record<string, { type: string; disabled?: boolean }> } }>(join(themeDir, 'config', 'settings_data.json'));
  const out: AppEmbed[] = [];
  for (const [id, b] of Object.entries(sd?.current?.blocks ?? {})) {
    const m = /^shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)/.exec(b.type);
    if (m) out.push({ id, app: m[1]!, block: m[2]!, enabled: !b.disabled });
  }
  return out;
}

export function sectionsPerTemplate(themeDir: string): Record<string, string[]> {
  const dir = join(themeDir, 'templates');
  const out: Record<string, string[]> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const t = readJsonLoose<{ sections?: Record<string, { type: string }>; order?: string[] }>(join(dir, f));
    out[f.replace(/\.json$/, '')] = (t?.order ?? []).map((id) => t?.sections?.[id]?.type ?? id);
  }
  return out;
}

export async function runThemeCheck(themeDir: string): Promise<ThemeCheckOffense[]> {
  const tc = (await import('@shopify/theme-check-node')) as unknown as { themeCheckRun(root: string, config?: string, log?: (m: string) => void): Promise<{ offenses: Array<{ check: string; uri: string; message: string; severity: number; start?: { line: number } }> }> };
  const r = await tc.themeCheckRun(themeDir, undefined, () => {});
  return r.offenses.map((o) => ({ check: o.check, file: decodeURIComponent(o.uri.replace(/^file:\/\//, '')).replace(themeDir + '/', '').replace(/^.*?\/(layout|sections|blocks|snippets|templates|config|locales|assets)\//, '$1/'), message: o.message, severity: o.severity, line: o.start ? o.start.line + 1 : undefined }));
}

/** Snippets and includes from apps that no longer load anything (SHA-03), and enabled embeds of unused apps (SHA-02). */
export function findLeftovers(themeDir: string, storefrontRequests: RequestRow[], embeds: AppEmbed[]): ShopifyBackend['leftovers'] {
  const out: ShopifyBackend['leftovers'] = [];
  const snippetsDir = join(themeDir, 'snippets');
  const loadedHosts = new Set(storefrontRequests.filter((r) => !r.failed && (r.status ?? 0) < 400).map((r) => new URL(r.url).host));
  const failedHosts = new Set(storefrontRequests.filter((r) => r.failed || (r.status ?? 0) >= 400).map((r) => new URL(r.url).host));
  const allLiquid = ['layout', 'sections', 'blocks', 'snippets', 'templates']
    .filter((d) => existsSync(join(themeDir, d)))
    .flatMap((d) => readdirSync(join(themeDir, d)).map((f) => ({ path: `${d}/${f}`, text: readFileSync(join(themeDir, d, f), 'utf8') })));
  if (existsSync(snippetsDir)) {
    for (const f of readdirSync(snippetsDir)) {
      const text = readFileSync(join(snippetsDir, f), 'utf8');
      const name = f.replace(/\.liquid$/, '');
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)\//gi)].map((m) => m[1]!.toLowerCase());
      const appHosts = hosts.filter((h) => !/shopify|googleapis|gstatic/.test(h));
      const renderedIn = allLiquid.filter((x) => new RegExp(`(render|include)\\s+['"]${name}['"]`).test(x.text)).map((x) => x.path);
      const appish = /app|review|widget|upsell|popup|klaviyo|judge|yotpo|loox|privy/i.test(name);
      const dead = appHosts.length > 0 && appHosts.every((h) => !loadedHosts.has(h) || failedHosts.has(h));
      if (appish && dead && renderedIn.length) {
        const app = name.replace(/-?(app|widget|snippet).*$/, '') || name;
        out.push({ file: `snippets/${f}`, app, reason: `references ${appHosts.join(', ')}, which the storefront no longer loads`, renderedIn });
      }
    }
  }
  for (const e of embeds.filter((x) => x.enabled)) {
    const loads = storefrontRequests.some((r) => r.owner.id === `app:${e.app}` && !r.failed);
    const leftover = out.find((l) => e.app.includes(l.app) || l.app.includes(e.app));
    if (!loads && leftover) out.push({ file: `config/settings_data.json#blocks.${e.id}`, app: e.app, reason: 'app embed enabled but the app loads nothing on the storefront', renderedIn: [] });
  }
  return out;
}

export interface ShopifyBackendOptions {
  /** Local fixture theme or an already pulled copy. */
  themeDir?: string;
  /** Local preview server URL for profiling (fixture). */
  previewUrl?: string;
  runDir: string;
  requests?: RequestRow[];
  responseHeaders?: Record<string, string>;
  cli?: ShopifyCli;
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'SpeedPilot', GIT_AUTHOR_EMAIL: 'speedpilot@localhost', GIT_COMMITTER_NAME: 'SpeedPilot', GIT_COMMITTER_EMAIL: 'speedpilot@localhost' } });
}

/** Copies (fixture) or pulls (store) the theme into runs/<site>/<run>/theme as a git repo. */
export async function snapshotTheme(cfg: SiteConfig, opts: { runDir: string; themeDir?: string; cli?: ShopifyCli; themeId?: string | number }): Promise<string> {
  const dest = join(opts.runDir, 'theme');
  mkdirSync(dest, { recursive: true });
  if (opts.themeDir) cpSync(opts.themeDir, dest, { recursive: true });
  else {
    const cli = opts.cli ?? new ShopifyCli(cfg);
    const id = opts.themeId ?? (await cli.live())?.id;
    if (!id) throw new Error('No live theme found');
    await cli.pull(id, dest);
  }
  if (!existsSync(join(dest, '.git'))) git(dest, ['init', '-q']);
  git(dest, ['add', '-A']);
  git(dest, ['commit', '-q', '-m', 'snapshot', '--allow-empty']);
  return dest;
}

/** Shopify backend collection (SPEC.md 3.10). Read-only. */
export async function collectShopifyBackend(cfg: SiteConfig, stage: Stage, urls: string[], opts: ShopifyBackendOptions): Promise<ShopifyBackend> {
  const notes: string[] = [];
  const themeDir = await snapshotTheme(cfg, { runDir: opts.runDir, themeDir: opts.themeDir, cli: opts.cli });
  const schema = readJsonLoose<Array<{ name: string; theme_name?: string; theme_version?: string }>>(join(themeDir, 'config', 'settings_schema.json')) ?? [];
  const info = schema.find((s) => s.name === 'theme_info');
  const files = themeFiles(themeDir);
  const os2 = existsSync(join(themeDir, 'templates')) && readdirSync(join(themeDir, 'templates')).some((f) => f.endsWith('.json'));
  let themeCount: number | undefined;
  if (!cfg.local) {
    const cli = opts.cli ?? new ShopifyCli(cfg);
    themeCount = await cli.list().then((t) => t.length).catch((e: Error) => {
      notes.push(`theme list: ${e.message}`);
      return undefined;
    });
  }
  const themeCheck = await runThemeCheck(themeDir).catch((e: Error) => {
    notes.push(`theme check: ${e.message}`);
    return [] as ThemeCheckOffense[];
  });
  const profile: ShopifyBackend['profile'] = [];
  for (const u of urls) {
    const path = new URL(u).pathname + new URL(u).search;
    if (opts.previewUrl) {
      await fetch(new URL(path, opts.previewUrl)).then((r) => r.arrayBuffer()).catch(() => undefined);
      const p = (await fetch(new URL('/__profile', opts.previewUrl)).then((r) => r.json()).catch(() => [])) as Array<{ file: string; ms: number; calls: number }>;
      const total = p.find((x) => x.file === 'layout/theme.liquid')?.ms ?? null;
      profile.push({ url: u, totalMs: total, hotSpots: p.filter((x) => x.file !== 'layout/theme.liquid').slice(0, 10), source: 'local-preview' });
    } else if (!cfg.local) {
      const cli = opts.cli ?? new ShopifyCli(cfg);
      const j = (await cli.profile(path).catch((e: Error) => {
        notes.push(`theme profile ${path}: ${e.message}`);
        return undefined;
      })) as { total?: number; nodes?: Array<{ name: string; time: number; count?: number }> } | undefined;
      if (j) profile.push({ url: u, totalMs: j.total ?? null, hotSpots: (j.nodes ?? []).sort((a, b) => b.time - a.time).slice(0, 10).map((n) => ({ file: n.name, ms: n.time, calls: n.count })), source: 'shopify-cli' });
    }
  }
  const embeds = appEmbeds(themeDir);
  const reqs = opts.requests ?? [];
  const appMap = new Map<string, { requests: number; bytes: number; pages: Set<string> }>();
  for (const r of reqs) {
    if (r.owner.kind !== 'app') continue;
    const e = appMap.get(r.owner.id) ?? { requests: 0, bytes: 0, pages: new Set<string>() };
    e.requests++;
    e.bytes += r.transferBytes;
    appMap.set(r.owner.id, e);
  }
  const header = opts.responseHeaders ? Object.entries(opts.responseHeaders).find(([k]) => k.toLowerCase() === 'speculation-rules')?.[1] ?? null : null;
  return {
    stage,
    themeDir,
    theme: { name: info?.theme_name ?? 'unknown', version: info?.theme_version ?? 'unknown', os2, files, totalBytes: files.reduce((a, f) => a + f.bytes, 0) },
    themeCount,
    themeCheck,
    profile,
    appEmbeds: embeds,
    sectionsPerTemplate: sectionsPerTemplate(themeDir),
    apps: [...appMap.entries()].map(([app, v]) => ({ app, requests: v.requests, kb: Math.round(v.bytes / 102.4) / 10, pages: [...v.pages] })),
    leftovers: findLeftovers(themeDir, reqs, embeds),
    speculationRulesHeader: header,
    notes,
  };
}
