import { run as defaultRun, type Runner, describeFailure, secret, type SiteConfig } from '@speedpilot/core';

export class ShopifyCliError extends Error {
  override name = 'ShopifyCliError';
}

export interface ThemeInfo {
  id: number;
  name: string;
  role: 'live' | 'unpublished' | 'development' | 'demo' | string;
}

/**
 * Shopify CLI wrapper (SPEC.md 2.3, 8.2). All theme writes go through Shopify CLI. Pushes go to the recorded work
 * theme only, never with --live or --allow-live; it refuses anything else even when called directly.
 */
export class ShopifyCli {
  constructor(
    readonly cfg: SiteConfig,
    private readonly runner: Runner = defaultRun,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private get store(): string {
    const s = this.cfg.access.shopify?.store;
    if (!s) throw new ShopifyCliError('site.yaml has no access.shopify.store');
    return s;
  }

  private cliEnv(): NodeJS.ProcessEnv {
    const pw = secret(this.cfg.access.shopify?.themeAccessPassword, this.env);
    return pw ? { ...this.env, SHOPIFY_CLI_THEME_TOKEN: pw } : this.env;
  }

  async exec(args: string[], timeoutMs = 300_000): Promise<string> {
    const flat = args.join(' ');
    if (/\s--(live|allow-live)\b|\s-[la]\b/.test(' ' + flat) && args[1] === 'push') throw new ShopifyCliError('shopify theme push --live / --allow-live is never used.');
    const r = await this.runner('shopify', args, { env: this.cliEnv(), timeoutMs });
    if (r.code !== 0) throw new ShopifyCliError(describeFailure('shopify', args, r));
    return r.stdout;
  }

  async list(): Promise<ThemeInfo[]> {
    return JSON.parse(await this.exec(['theme', 'list', '--store', this.store, '--json'])) as ThemeInfo[];
  }

  async live(): Promise<ThemeInfo | undefined> {
    return (await this.list()).find((t) => t.role === 'live');
  }

  async pull(themeId: string | number, path: string): Promise<void> {
    await this.exec(['theme', 'pull', '--store', this.store, '--theme', String(themeId), '--path', path]);
  }

  async profile(urlPath: string, themeId?: string | number): Promise<unknown> {
    const args = ['theme', 'profile', '--store', this.store, '--url', urlPath, '--json'];
    if (themeId) args.push('--theme', String(themeId));
    const pw = secret(this.cfg.access.shopify?.storefrontPassword, this.env);
    if (pw) args.push('--store-password', pw);
    return JSON.parse(await this.exec(args));
  }

  async duplicate(themeId: string | number, name: string): Promise<ThemeInfo> {
    const out = await this.exec(['theme', 'duplicate', '--store', this.store, '--theme', String(themeId), '--name', name, '--json']);
    const j = JSON.parse(out) as { theme?: ThemeInfo } & Partial<ThemeInfo>;
    return (j.theme ?? j) as ThemeInfo;
  }

  /** Pushes changed files to the WORK theme only (SPEC.md 8.2). */
  async pushToWorkTheme(workThemeId: string, recordedWorkThemeId: string | undefined, path: string, only: string[]): Promise<void> {
    if (!recordedWorkThemeId || String(workThemeId) !== String(recordedWorkThemeId)) throw new ShopifyCliError(`Refusing to push to theme ${workThemeId}: the recorded work theme is ${recordedWorkThemeId ?? 'not set'}.`);
    const live = await this.live().catch(() => undefined);
    if (live && String(live.id) === String(workThemeId)) throw new ShopifyCliError('Refusing to push: the work theme is the live theme.');
    const args = ['theme', 'push', '--store', this.store, '--theme', String(workThemeId), '--path', path, '--nodelete'];
    for (const f of only) args.push('--only', f);
    await this.exec(args);
  }

  async publish(themeId: string | number): Promise<void> {
    await this.exec(['theme', 'publish', '--store', this.store, '--theme', String(themeId), '--force']);
  }
}
