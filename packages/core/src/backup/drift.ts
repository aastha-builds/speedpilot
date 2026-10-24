import type { WpHost } from './host.js';
import { KEY_OPTIONS, type WpManifest } from './wordpress.js';
import { sha256 } from './crypto.js';

export interface WpState {
  plugins: Array<{ name: string; status: string; version: string }>;
  themes: Array<{ name: string; status: string; version: string }>;
  options: Record<string, unknown>;
  themeFilesHash?: string;
}

export interface DriftItem {
  kind: 'plugin' | 'theme' | 'option' | 'theme-files' | 'file';
  name: string;
  before: unknown;
  after: unknown;
}

/** Current state of a WordPress stage for drift control (SPEC.md 5.4). Read-only. */
export async function wpState(host: WpHost): Promise<WpState> {
  const wp = host.wp;
  const plugins = (await wp.json<WpState['plugins']>(['plugin', 'list', '--fields=name,status,version', '--skip-update-check'])).filter((p) => p.status !== 'must-use' && p.status !== 'dropin');
  const themes = await wp.json<WpState['themes']>(['theme', 'list', '--fields=name,status,version', '--skip-update-check']);
  const options: Record<string, unknown> = {};
  for (const n of KEY_OPTIONS) options[n] = await wp.text(['option', 'get', n, '--format=json']).then((v) => JSON.parse(v) as unknown).catch(() => null);
  const stylesheet = options.stylesheet as string | undefined;
  let themeFilesHash: string | undefined;
  if (stylesheet) {
    const r = await host.shell(`cd ${host.docroot}/wp-content/themes/${stylesheet} 2>/dev/null && find . -type f -not -path './node_modules/*' | LC_ALL=C sort | xargs sha256sum 2>/dev/null`);
    if (r.code === 0 && r.stdout) themeFilesHash = sha256(r.stdout);
  }
  return { plugins, themes, options, themeFilesHash };
}

export function stateFromManifest(m: WpManifest & { themeFilesHash?: string }): WpState {
  return { plugins: m.plugins, themes: m.themes, options: m.options, themeFilesHash: m.themeFilesHash };
}

/** Differences between the snapshot the work started from and production now. */
export function wpDrift(before: WpState, after: WpState): DriftItem[] {
  const out: DriftItem[] = [];
  const pmap = (l: WpState['plugins']) => new Map(l.map((p) => [p.name, `${p.status}@${p.version}`]));
  const a = pmap(before.plugins);
  const b = pmap(after.plugins);
  for (const name of new Set([...a.keys(), ...b.keys()])) if (a.get(name) !== b.get(name)) out.push({ kind: 'plugin', name, before: a.get(name) ?? null, after: b.get(name) ?? null });
  const ta = pmap(before.themes);
  const tb = pmap(after.themes);
  for (const name of new Set([...ta.keys(), ...tb.keys()])) if (ta.get(name) !== tb.get(name)) out.push({ kind: 'theme', name, before: ta.get(name) ?? null, after: tb.get(name) ?? null });
  for (const k of new Set([...Object.keys(before.options), ...Object.keys(after.options)])) {
    if (k === 'active_plugins') continue; // covered by plugin status
    if (JSON.stringify(before.options[k]) !== JSON.stringify(after.options[k])) out.push({ kind: 'option', name: k, before: before.options[k] ?? null, after: after.options[k] ?? null });
  }
  if (before.themeFilesHash && after.themeFilesHash && before.themeFilesHash !== after.themeFilesHash) out.push({ kind: 'theme-files', name: String(after.options.stylesheet ?? 'theme'), before: before.themeFilesHash, after: after.themeFilesHash });
  return out;
}
