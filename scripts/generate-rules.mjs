#!/usr/bin/env node
// Generates rules/<area>.yaml from CHECKS.md. Every check becomes one rule with: id, platforms, detect, evidence,
// metric, tier, fix, verify. Never skips, merges or renames a check. Run after `pnpm build` (reads the evaluator list).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = readFileSync(join(root, 'CHECKS.md'), 'utf8');

let automated = new Set();
const dist = join(root, 'packages', 'core', 'dist', 'rules', 'engine.js');
if (existsSync(dist)) automated = new Set((await import(dist)).automatedIds());
else console.warn('packages/core is not built: every rule is marked not automated. Run pnpm build first.');

export function parseChecks(md) {
  const out = [];
  let area = '';
  for (const line of md.split('\n')) {
    const h = /^## ([A-Z0-9]+)( and ([A-Z0-9]+))?:/.exec(line);
    if (h) area = h[1];
    const m = /^- \*\*([A-Z0-9]+-\d+) (.+?)\*\*\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, id, titleRaw, rest] = m;
    out.push({ id, area: id.split('-')[0], section: area, title: titleRaw.replace(/\.$/, ''), text: rest.trim() });
  }
  return out;
}

const field = (text, name) => {
  const re = new RegExp(`${name}:\\s*(.+?)(?=\\s(?:Detect|Fix|Verify|Guard|Tier):|$)`, 's');
  return re.exec(text)?.[1]?.trim() ?? '';
};

function tierOf(text, area) {
  if (area === 'SAFE') return 'T2';
  if (/Tier:\s*by cause/i.test(text)) return 'by-cause';
  const all = [...text.matchAll(/\((T[123])(?:\/(T[123]))?[^)]*\)/g)];
  if (all.length) {
    const m = all[all.length - 1];
    if (m[2]) return `${m[1]}/${m[2]}`;
    return m[1];
  }
  if (/\bReport\b.*\(T3\)|report \(T3\)/i.test(text)) return 'T3';
  if (/Fix:\s*(none|report|leave|keep)/i.test(text) || /\(report\)/i.test(text) || /Fix: report/i.test(text)) return 'report';
  if (/T3/.test(text)) return 'T3';
  return 'report';
}

function platformsOf(id, area, text) {
  if (['WPB', 'WPF'].includes(area)) return 'wp';
  if (['SHT', 'SHA'].includes(area)) return 'shopify';
  if (['SAFE-17', 'SAFE-18', 'SAFE-19'].includes(id)) return 'shopify';
  if (['SAFE-09', 'SAFE-10', 'SAFE-11', 'SAFE-12', 'SAFE-32'].includes(id)) return 'wp';
  return 'both';
}

const METRIC_BY_ID = {
  'NET-02': 'LCP', 'NET-03': 'LCP', 'NET-04': 'LCP', 'NET-05': 'bytes', 'NET-06': 'LCP', 'NET-07': 'bytes', 'NET-08': 'TTFB', 'NET-09': 'TBT', 'NET-10': 'safety', 'NET-11': 'safety', 'NET-12': 'LCP', 'NET-13': 'safety', 'NET-15': 'LCP',
  'DOC-01': 'TBT', 'DOC-02': 'TBT', 'DOC-03': 'LCP', 'DOC-04': 'LCP', 'DOC-05': 'LCP', 'DOC-06': 'LCP', 'DOC-07': 'CLS', 'DOC-08': 'LCP', 'DOC-09': 'TBT', 'DOC-10': 'LCP',
  'IMG-03': 'bytes', 'IMG-04': 'bytes', 'IMG-05': 'bytes', 'IMG-06': 'CLS', 'IMG-07': 'bytes', 'IMG-08': 'bytes', 'IMG-09': 'bytes', 'IMG-11': 'bytes', 'IMG-12': 'LCP', 'IMG-13': 'bytes',
  'FONT-05': 'CLS', 'FONT-06': 'bytes', 'FONT-07': 'bytes', 'CSS-02': 'bytes', 'CSS-04': 'bytes', 'CSS-05': 'bytes', 'CSS-06': 'bytes', 'CSS-07': 'CLS', 'CSS-08': 'INP', 'CSS-09': 'bytes', 'CSS-10': 'TBT',
  'JS-02': 'bytes', 'JS-04': 'INP', 'JS-05': 'TBT', 'JS-06': 'bytes', 'JS-07': 'TBT', 'JS-10': 'bytes', 'JS-11': 'TBT', 'JS-12': 'INP', 'JS-14': 'safety', 'JS-15': 'TBT',
  '3P-01': 'TBT', '3P-03': 'safety', '3P-06': 'LCP', '3P-07': 'CLS', '3P-12': 'CLS', '3P-14': 'LCP',
  'WPB-26': 'TTFB', 'WPB-28': 'bytes', 'WPB-29': 'measurement', 'WPB-25': 'safety',
  'WPF-01': 'TBT', 'WPF-02': 'bytes', 'WPF-03': 'LCP', 'WPF-04': 'LCP', 'WPF-05': 'LCP', 'WPF-06': 'bytes', 'WPF-07': 'TBT', 'WPF-14': 'LCP', 'WPF-15': 'LCP', 'WPF-16': 'bytes', 'WPF-17': 'bytes', 'WPF-20': 'safety', 'WPF-21': 'LCP',
  'SHT-01': 'measurement', 'SHT-02': 'LCP', 'SHT-03': 'TBT', 'SHT-04': 'TBT', 'SHT-05': 'LCP', 'SHT-06': 'CLS', 'SHT-07': 'LCP', 'SHT-08': 'LCP', 'SHT-09': 'TTFB', 'SHT-10': 'TBT', 'SHT-11': 'bytes', 'SHT-12': 'LCP', 'SHT-13': 'INP', 'SHT-14': 'TBT', 'SHT-15': 'LCP', 'SHT-16': 'LCP', 'SHT-17': 'TBT', 'SHT-18': 'safety', 'SHT-19': 'LCP', 'SHT-20': 'measurement', 'SHT-21': 'TBT',
  'SHA-01': 'TBT', 'SHA-02': 'TBT', 'SHA-03': 'TBT', 'SHA-05': 'CLS', 'SHA-07': 'safety', 'SHA-09': 'TBT', 'SHA-10': 'LCP',
  'REV-01': 'safety', 'REV-02': 'LCP', 'REV-03': 'LCP', 'REV-04': 'safety', 'REV-05': 'TBT', 'REV-06': 'LCP', 'REV-07': 'INP', 'REV-08': 'safety',
};
const METRIC_BY_AREA = { MEAS: 'measurement', NET: 'TTFB', DOC: 'LCP', IMG: 'LCP', VID: 'LCP', FONT: 'LCP', CSS: 'LCP', JS: 'TBT', '3P': 'TBT', CLS: 'CLS', WPB: 'TTFB', WPF: 'TBT', SHT: 'LCP', SHA: 'TBT', REV: 'LCP', SAFE: 'safety' };

const SOURCE_BY_AREA = {
  MEAS: 'audit run metadata (Lighthouse runs, tool versions, response headers, consent detection)',
  NET: 'Lighthouse document-latency/modern-http/use-cache insights, request log headers, WordPress backend TTFB',
  DOC: 'Playwright document stats (DOM, inline data, head, preloads, animations, document.write) and Lighthouse insights',
  IMG: 'Playwright image collector (intrinsic vs rendered, attributes, bytes) and LCP phases',
  VID: 'Playwright media collector (video and iframes)',
  FONT: 'Playwright font collector (@font-face, font requests, preloads) and CLS culprits',
  CSS: 'request log, CSS coverage after interactions, render-blocking head entries',
  JS: 'request log, JS coverage, Long Animation Frames, scripted INP with attribution',
  '3P': 'request owners (third-party-web), Long Animation Frames, beacons',
  CLS: 'layout-shift entries with sources and causes',
  WPB: 'WordPress backend: WP-CLI (read-only), agent diagnostics, database stats',
  WPF: 'WordPress agent handle map per URL, coverage, plugin list',
  SHT: 'theme snapshot, Theme Check, theme profile, storefront evidence',
  SHA: 'storefront request owners, app embeds in settings_data.json, leftover app code scan',
  REV: 'X-ray Engine Site Model, safe-change verdicts, waterfall, simulator, recipes',
  SAFE: 'verification harness (guard attached to changes)',
};

const MANUAL_SOURCE = {
  'MEAS-09': 'visual diff variance across runs (needs masks from the client)',
  'NET-08': 'client intake: audience location, CDN',
  'NET-15': 'CDN or host 103 Early Hints support (curl --http2 -v on the client\'s CDN)',
  'DOC-10': 'raw HTML vs rendered DOM comparison of first-screen content',
  'CSS-08': 'trace analysis of scroll frames and style recalculation during interactions',
  'WPB-21': 'client intake: peak hours vs scheduled job times',
  'WPB-22': 'slow query log for LIKE searches on large posts tables (staging)',
  'WPB-28': 'registered image sizes (wp media image-size) vs used sizes',
  'SHT-13': 'scripted INP while typing in predictive search and filtering',
  'SHT-20': 'diff against the theme\'s original version (requires the vendor version)',
};

const rules = parseChecks(checks).map((c) => {
  const detect = field(c.text, 'Detect');
  const fix = field(c.text, 'Fix') || field(c.text, 'Guard');
  const verify = field(c.text, 'Verify');
  const isGuard = c.area === 'SAFE';
  return {
    id: c.id,
    area: c.area,
    title: c.title,
    platforms: platformsOf(c.id, c.area, c.text),
    kind: isGuard ? 'guard' : 'check',
    detect: {
      source: MANUAL_SOURCE[c.id] ?? SOURCE_BY_AREA[c.area],
      condition: detect || (isGuard ? c.title : c.text.split('. ')[0]),
      automated: !isGuard && automated.has(c.id),
    },
    evidence: 'URLs, files, bytes, ms, elements and owners as recorded in runs/<site>/<run-id>/ (see the finding evidence object)',
    metric: METRIC_BY_ID[c.id] ?? METRIC_BY_AREA[c.area],
    tier: tierOf(c.text, c.area),
    fix: fix || c.text,
    verify: verify || (isGuard ? `Guard: ${c.text}` : 'full verification (SPEC.md 6) on the affected URLs'),
    source: 'CHECKS.md',
  };
});

const byArea = new Map();
for (const r of rules) byArea.set(r.area, [...(byArea.get(r.area) ?? []), r]);
const dir = join(root, 'rules');
mkdirSync(dir, { recursive: true });
for (const [area, rs] of byArea) {
  const doc = new YAML.Document({ area, generatedFrom: 'CHECKS.md', rules: rs });
  doc.commentBefore = ` Generated by scripts/generate-rules.mjs from CHECKS.md. Do not edit by hand: change CHECKS.md and regenerate.`;
  writeFileSync(join(dir, `${area.toLowerCase()}.yaml`), doc.toString({ lineWidth: 0 }));
}
const auto = rules.filter((r) => r.detect.automated).length;
console.log(`${rules.length} rules in ${byArea.size} files (${auto} automated checks, ${rules.filter((r) => r.kind === 'guard').length} guards).`);
