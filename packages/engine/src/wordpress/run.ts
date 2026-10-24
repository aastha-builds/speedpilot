/**
 * Gathers what the WordPress proposals need: the latest X-ray, a probe of each sample URL, the agent's handle maps and
 * slow WP_Query calls, autoload stats and the SAFE-05 usage scan. All read-only.
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSite, WpCli, AgentClient, FIXTURE_HMAC_SECRET, secret, paths, type Stage } from '@speedpilot/core';
import { loadXray } from '@speedpilot/xray';
import { probePage, type ProbeResult } from '../probe.js';
import { buildWpProposals, type Proposal } from './proposals.js';
import { fetchDiag } from './apply.js';

export interface WpOptimizeInputs {
  proposals: Proposal[];
  probes: ProbeResult[];
  dir: string;
}

/** SAFE-05 usage scan for the components the proposals may restrict to some pages. */
export async function usageScan(wp: WpCli): Promise<NonNullable<Parameters<typeof buildWpProposals>[0]['usage']>> {
  const scan = async (args: string[]) => JSON.parse((await wp.text(['speedpilot', 'usage-scan', ...args])).split('\n').pop()!);
  return {
    'contact-form-7': await scan(['--shortcodes=contact-form-7,contact-form', '--blocks=contact-form-7/contact-form-selector', '--needles=wpcf7']),
    elementor: await scan(['--needles=elType,elementor-widget']),
  };
}

export async function planWordPress(root: string, site: string, o: { stage?: Stage } = {}): Promise<WpOptimizeInputs> {
  const cfg = loadSite(root, site);
  const stage: Stage = o.stage ?? (cfg.local ? 'local' : 'staging');
  const base = stage === 'staging' && cfg.stagingUrl ? cfg.stagingUrl : cfg.productionUrl;
  const x = loadXray(root, site);
  const urls = [...new Set(x.captures.map((c) => c.url))];
  const probes: ProbeResult[] = [];
  for (const u of urls) probes.push(await probePage(u, { local: !!cfg.local || stage !== 'production' }));
  const diag = await fetchDiag(cfg, urls, base);
  const hmac = secret(cfg.access.wordpress?.agentHmacSecret) ?? (cfg.local ? FIXTURE_HMAC_SECRET : undefined);
  const autoloadRaw = await new AgentClient(base, hmac).rest<{ total_bytes: number; top: Array<{ name: string; bytes: number; owner: string }>; expired_transients: number }>('autoload');
  const wp = new WpCli(root, cfg, stage);
  const usage = await usageScan(wp).catch(() => undefined);
  const proposals = buildWpProposals({
    cfg,
    xray: x.ctx,
    summary: x.summary!,
    probes,
    diag,
    autoload: autoloadRaw ? { total: autoloadRaw.total_bytes, options: autoloadRaw.top } : undefined,
    expiredTransients: autoloadRaw?.expired_transients,
    usage,
  });
  const dir = join(paths.runsDir(root, site), `optimize-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposals.json'), JSON.stringify(proposals.map((p) => ({ ...p, files: p.files.map((f) => f.path) })), null, 1));
  writeFileSync(join(dir, 'probes.json'), JSON.stringify(probes.map((p) => ({ ...p, criticalCss: `${p.criticalCss.length} bytes` })), null, 1));
  return { proposals, probes, dir };
}
