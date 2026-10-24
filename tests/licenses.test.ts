import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.js';

const SCRIPT = join(REPO, 'scripts/check-licenses.mjs');

function tree(deps: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'sp-lic-'));
  mkdirSync(join(root, 'packages', 'core'), { recursive: true });
  writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ name: '@speedpilot/core', dependencies: Object.fromEntries(Object.keys(deps).map((d) => [d, '1.0.0'])) }));
  for (const [name, license] of Object.entries(deps)) {
    mkdirSync(join(root, 'packages/core/node_modules', name), { recursive: true });
    writeFileSync(join(root, 'packages/core/node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }));
  }
  return root;
}

describe('licence check (CI gate)', () => {
  it('passes for the real dependency tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(r.status, r.stdout).toBe(0);
  });
  it('fails the build when a GPL dependency is added', () => {
    const r = spawnSync('node', [SCRIPT, '--root', tree({ 'ok-lib': 'MIT', 'gpl-lib': 'GPL-3.0-only' })], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL gpl-lib@1\.0\.0: copyleft/);
  });
  it('accepts permissive SPDX expressions and rejects unknown licences', () => {
    expect(spawnSync('node', [SCRIPT, '--root', tree({ a: '(MIT OR Apache-2.0)', b: 'BSD-3-Clause', c: 'ISC' })]).status).toBe(0);
    expect(spawnSync('node', [SCRIPT, '--root', tree({ d: 'SSPL-1.0' })]).status).toBe(1);
    expect(spawnSync('node', [SCRIPT, '--root', tree({ e: 'LGPL-2.1 OR MIT' })]).status).toBe(0);
  });
});
