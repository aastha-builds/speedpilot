import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO, tempRoot, wpUp } from './helpers.js';

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

async function connect(root: string): Promise<Client> {
  const client = new Client({ name: 'speedpilot-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(REPO, 'packages/mcp-server/dist/index.js')], env: { ...process.env, SPEEDPILOT_ROOT: root } as Record<string, string> }));
  return client;
}

describe('SpeedPilot MCP server', () => {
  const clients: Client[] = [];
  afterAll(async () => {
    for (const c of clients) await c.close();
  });

  it('lists the read-only and write tools from SPEC.md 10.2 and the X-ray tools', async () => {
    const c = await connect(tempRoot(['fixture-wp']));
    clients.push(c);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['audit', 'get_findings', 'get_metrics', 'compare_runs', 'get_report', 'list_backups', 'backup', 'prepare_staging', 'apply_change', 'rollback', 'deploy', 'xray_summary', 'xray_is_safe']) expect(names).toContain(n);
  });

  it('refuses a write tool without an approval, even outside dry run', async () => {
    const root = tempRoot(['fixture-wp']);
    const f = join(root, 'sites/fixture-wp/site.yaml');
    const y = YAML.parse(readFileSync(f, 'utf8'));
    y.local = false;
    writeFileSync(f, YAML.stringify(y));
    const c = await connect(root);
    clients.push(c);
    for (const name of ['backup', 'rollback', 'deploy']) {
      const r = await c.callTool({ name, arguments: { site: 'fixture-wp', plan_id: 'plan-x', approval_token: 'nope', dry_run: false, all: true } });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/approval|No plan/i);
    }
  });

  it.skipIf(!wpUp)('audits fixture-wp and shows the top 10 findings through the tools', async () => {
    const root = tempRoot(['fixture-wp']);
    const c = await connect(root);
    clients.push(c);
    const a = JSON.parse(text(await c.callTool({ name: 'audit', arguments: { site: 'fixture-wp', urls: ['http://localhost:8888/'], runs: 1 } }, undefined, { timeout: 900_000 })));
    expect(a.top10.length).toBeGreaterThan(0);
    expect(a.evidence.length).toBeGreaterThan(0);
    const f = JSON.parse(text(await c.callTool({ name: 'get_findings', arguments: { site: 'fixture-wp', limit: 10 } }, undefined, { timeout: 300_000 })));
    expect(f.findings).toHaveLength(10);
    expect(f.findings.map((x: { id: string }) => x.id)).toContain('IMG-01');
  }, 1_200_000);
});
