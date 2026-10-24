import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadSite, loadAudit, runAnalysis, type Analysis } from '@speedpilot/core';
import { buildModel, type ReportModel, type AfterSection } from './model.js';
import { renderHtml } from './html.js';
import { anonymizeModel } from './anonymize.js';
import { plainTitle, costPhrase, ms, num } from './plain.js';

export * from './model.js';
export * from './html.js';
export * from './anonymize.js';
export * from './plain.js';

/** Short Markdown summary that can be pasted into a client message (SPEC.md 9.3). */
export function renderMarkdown(m: ReportModel): string {
  const lines: string[] = [];
  lines.push(`**${m.kind === 'before' ? 'Speed report' : 'After report'}: ${m.siteName}** (${m.domain})`);
  lines.push('');
  lines.push(`Grade: **${m.grade.grade ?? '–'}**${m.grade.counts ? '' : ' (does not count: safety failed)'} · Phone score now ${num(m.achievable.current)}, reachable about ${num(m.achievable.reachable)}.`);
  lines.push(`Core Web Vitals (lab): LCP ${m.cwv.lab.LCP}, INP ${m.cwv.lab.INP}, TBT ${m.cwv.lab.TBT}, CLS ${m.cwv.lab.CLS}. Real users: ${m.cwv.field}.`);
  if (m.after) {
    lines.push(`Safety: **${m.after.safety}**. ${m.after.changeLog.filter((c) => c.status === 'kept').length} changes kept, ${m.after.changeLog.filter((c) => c.status === 'rolled_back').length} rolled back.`);
    const home = m.after.deltas.filter((d) => d.device === 'mobile' && (d.metric === 'Score' || d.metric === 'LCP'));
    for (const d of home.slice(0, 4)) lines.push(`- ${new URL(d.url).pathname} ${d.metric}: ${d.metric === 'Score' ? num(d.before) : ms(d.before)} → ${d.metric === 'Score' ? num(d.after) : ms(d.after)}`);
    lines.push(`Field data re-check: ${m.after.recheck.day7} and ${m.after.recheck.day28}.`);
  } else {
    lines.push('');
    lines.push('Biggest problems:');
    m.top5.forEach((t, i) => lines.push(`${i + 1}. ${t.title} (costs ${t.cost})`));
  }
  lines.push('');
  lines.push('_Medians of 5 runs; lab and field data reported separately. Field data needs up to 28 days to show changes._');
  return lines.join('\n') + '\n';
}

export async function renderPdf(html: string, out: string): Promise<void> {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ colorScheme: 'light', media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: out, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally {
    await browser.close();
  }
}

export interface WrittenReport {
  dir: string;
  html: string;
  pdf?: string;
  json: string;
  markdown: string;
  model: ReportModel;
}

/** Writes HTML, PDF, JSON and Markdown (SPEC.md 9.3). Anonymized mode writes a separate set. */
export async function writeReport(model: ReportModel, outDir: string, opts: { pdf?: boolean; anonymized?: boolean; extraNames?: string[] } = {}): Promise<WrittenReport> {
  const m = opts.anonymized ? anonymizeModel(model, { domains: [model.domain, model.domain.replace(/^www\./, '')], names: [model.siteName, model.site, ...(opts.extraNames ?? [])] }) : model;
  if (opts.anonymized) {
    m.siteName = 'Client';
    m.site = 'client';
    m.domain = 'client-site.example';
    m.branding = { primary: '#444444', accent: '#888888' };
    m.screenshot = undefined;
  }
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${model.kind}${opts.anonymized ? '.anonymized' : ''}`);
  const html = renderHtml(m);
  writeFileSync(`${base}.html`, html);
  writeFileSync(`${base}.json`, JSON.stringify(m, null, 1));
  writeFileSync(`${base}.md`, renderMarkdown(m));
  let pdf: string | undefined;
  if (opts.pdf !== false) {
    pdf = `${base}.pdf`;
    await renderPdf(html, pdf);
  }
  return { dir: outDir, html: `${base}.html`, pdf, json: `${base}.json`, markdown: `${base}.md`, model: m };
}

/** `speedpilot report before <site>`: analysis of the latest audit, then every format. */
export async function beforeReport(root: string, site: string, opts: { runId?: string; pdf?: boolean; anonymized?: boolean } = {}): Promise<{ written: WrittenReport[]; analysis: Analysis }> {
  const cfg = loadSite(root, site);
  const audit = loadAudit(root, site, opts.runId);
  const analysis = runAnalysis(root, site, { runId: audit.runId });
  const model = buildModel('before', cfg, audit, analysis);
  const out = join(audit.dir, 'reports');
  const written = [await writeReport(model, out, { pdf: opts.pdf })];
  if (opts.anonymized) written.push(await writeReport(model, out, { pdf: opts.pdf, anonymized: true }));
  return { written, analysis };
}

export type { AfterSection };
export { plainTitle, costPhrase };
export * from './after.js';
