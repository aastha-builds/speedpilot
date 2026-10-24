import { cpSync, mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Runner } from '@speedpilot/core';

/**
 * In-memory Shopify store for tests: a theme library backed by folders, driven through the same `shopify theme ...`
 * commands SpeedPilot sends. Lets backup, drift, work-theme pushes and publishes be tested without a real store.
 */
export class FakeShopifyStore {
  readonly root = mkdtempSync(join(tmpdir(), 'sp-fakestore-'));
  themes: Array<{ id: number; name: string; role: string }> = [];
  calls: string[][] = [];
  private next = 100;

  constructor(liveThemeDir: string, extraThemes = 0) {
    this.add('Live theme', 'live', liveThemeDir);
    for (let i = 0; i < extraThemes; i++) this.add(`Old theme ${i + 1}`, 'unpublished', liveThemeDir);
  }

  dir(id: number | string) {
    return join(this.root, String(id));
  }

  add(name: string, role: string, from: string): number {
    const id = this.next++;
    mkdirSync(this.dir(id), { recursive: true });
    cpSync(from, this.dir(id), { recursive: true, filter: (src) => !src.includes('/.git') });
    this.themes.push({ id, name, role });
    return id;
  }

  live() {
    return this.themes.find((t) => t.role === 'live')!;
  }

  runner: Runner = async (cmd, args) => {
    this.calls.push(args);
    if (cmd !== 'shopify' || args[0] !== 'theme') return { code: 1, stdout: '', stderr: 'unsupported' };
    const flag = (n: string) => {
      const i = args.indexOf(n);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const sub = args[1];
    if (sub === 'list') return { code: 0, stdout: JSON.stringify(this.themes), stderr: '' };
    if (sub === 'pull') {
      const id = flag('--theme')!;
      const path = flag('--path')!;
      if (!existsSync(this.dir(id))) return { code: 1, stdout: '', stderr: 'no such theme' };
      mkdirSync(path, { recursive: true });
      cpSync(this.dir(id), path, { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'duplicate') {
      const id = this.add(flag('--name') ?? 'Copy', 'unpublished', this.dir(flag('--theme')!));
      return { code: 0, stdout: JSON.stringify({ theme: { id, name: flag('--name'), role: 'unpublished' } }), stderr: '' };
    }
    if (sub === 'push') {
      if (args.includes('--live') || args.includes('--allow-live')) return { code: 1, stdout: '', stderr: 'refused' };
      const id = flag('--theme')!;
      const path = flag('--path')!;
      const only: string[] = [];
      args.forEach((a, i) => a === '--only' && only.push(args[i + 1]!));
      for (const f of only.length ? only : readdirSync(path)) cpSync(join(path, f), join(this.dir(id), f), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'publish') {
      const id = Number(flag('--theme'));
      for (const t of this.themes) if (t.role === 'live') t.role = 'unpublished';
      const t = this.themes.find((x) => x.id === id);
      if (!t) return { code: 1, stdout: '', stderr: 'no such theme' };
      t.role = 'live';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'delete') return { code: 1, stdout: '', stderr: 'tests never delete themes' };
    return { code: 1, stdout: '', stderr: `unsupported ${sub}` };
  };

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
