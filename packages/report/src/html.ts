import type { ReportModel } from './model.js';
import { ms, num, TIER_TEXT } from './plain.js';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const short = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
};

function table(headers: string[], rows: Array<Array<unknown>>, opts: { raw?: number[] } = {}): string {
  if (!rows.length) return '<p class="muted">None found.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td>${opts.raw?.includes(i) ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const badge = (s: string) => `<span class="badge ${s.replace(/[^a-z]/gi, '').toLowerCase()}">${esc(s)}</span>`;

export function renderHtml(m: ReportModel): string {
  const title = `${m.kind === 'before' ? 'Speed report' : 'After report'}: ${m.siteName}`;
  const cwvRow = (['LCP', 'INP', 'TBT', 'CLS'] as const).map((k) => `<div class="kpi"><div class="kpi-l">${k} (lab)</div>${badge(m.cwv.lab[k])}</div>`).join('');
  const after = m.after;
  const css = `
  :root { --brand: ${esc(m.branding.primary)}; --accent: ${esc(m.branding.accent)}; --fg: #1d2327; --muted: #646970; --line: #dcdcde; --bg: #ffffff; --soft: #f6f7f7; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --fg: #e8eaed; --muted: #a7aaad; --line: #3c434a; --bg: #1d2327; --soft: #2c3338; } }
  * { box-sizing: border-box; } body { margin: 0; font: 15px/1.55 -apple-system, system-ui, Segoe UI, Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
  header.hero { border-bottom: 4px solid var(--brand); padding-bottom: 16px; margin-bottom: 24px; display: flex; gap: 16px; align-items: center; }
  header.hero img.logo { max-height: 48px; } h1 { font-size: 26px; margin: 0; } h2 { font-size: 20px; margin-top: 40px; border-bottom: 1px solid var(--line); padding-bottom: 6px; } h3 { font-size: 16px; margin-top: 24px; }
  .grade { font-size: 56px; font-weight: 800; color: var(--brand); line-height: 1; } .gradebox { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .kpis { display: flex; gap: 12px; flex-wrap: wrap; } .kpi { background: var(--soft); border-radius: 8px; padding: 10px 14px; min-width: 120px; } .kpi-l { font-size: 12px; color: var(--muted); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 700; background: var(--soft); }
  .badge.pass { background: #d1f5d3; color: #0a5d12; } .badge.fail { background: #fcd4d4; color: #8a1212; } .badge.na, .badge.notenoughdata { background: var(--soft); color: var(--muted); }
  .badge.t1 { background: #d1f5d3; color: #0a5d12; } .badge.t2 { background: #fff0c2; color: #6b4e00; } .badge.t3 { background: #fcd4d4; color: #8a1212; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13px; display: block; overflow-x: auto; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--soft); }
  td { word-break: break-word; max-width: 420px; } .muted { color: var(--muted); } ol.top li { margin-bottom: 10px; } .shot { max-width: min(100%, 360px); border: 1px solid var(--line); border-radius: 6px; }
  .pagebreak { page-break-before: always; } details { margin: 6px 0; } summary { cursor: pointer; font-weight: 600; } code { font-size: 12px; background: var(--soft); padding: 1px 4px; border-radius: 3px; }
  .sbs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .sbs img { width: 100%; border: 1px solid var(--line); }
  @media (max-width: 640px) { .grade { font-size: 40px; } .sbs { grid-template-columns: 1fr; } }
  @media print { a { color: inherit; text-decoration: none; } h2 { page-break-after: avoid; } }`;

  const page1 = `
  <section id="summary">
    <div class="gradebox">
      <div><div class="kpi-l">Grade</div><div class="grade">${esc(m.grade.grade ?? '–')}</div>${m.grade.counts ? '' : `<div class="muted">${esc(m.grade.reason ?? '')}</div>`}</div>
      <div class="kpis">${cwvRow}<div class="kpi"><div class="kpi-l">Field (real users)</div>${badge(m.cwv.field)}</div></div>
    </div>
    ${m.kind === 'before' ? `
    <h2>In short</h2>
    <p>We tested ${new Set(m.pages.map((p) => p.url)).size} key pages of <strong>${esc(m.domain)}</strong> on phones and computers, ${m.pages[0]?.runs ?? 5} time${(m.pages[0]?.runs ?? 5) === 1 ? '' : 's'} each, and recorded what slows them down.
    Today the typical phone score is <strong>${num(m.achievable.current)}</strong> out of 100. Fixing what is in our control should bring it to about <strong>${num(m.achievable.reachable)}</strong>.</p>
    <h3>The 5 biggest problems</h3>
    <ol class="top">${m.top5.map((t) => `<li><strong>${esc(t.title)}</strong><br><span class="muted">Costs ${esc(t.cost)}. ${esc(cap(TIER_TEXT[t.tier] ?? t.tier))}.</span></li>`).join('')}</ol>
    <h3>Risks and how we handle them</h3><ul>${m.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ` : `
    <h2>In short</h2>
    <p>Safety result: ${badge(after?.safety ?? 'N/A')}. ${after?.changeLog.filter((c) => c.status === 'kept').length ?? 0} changes kept, ${after?.changeLog.filter((c) => c.status === 'rolled_back').length ?? 0} rolled back.</p>
    `}
    ${m.screenshot ? `<img class="shot" alt="Home page on a phone" src="${m.screenshot}">` : ''}
  </section>`;

  const afterHtml = after
    ? `
  <section class="pagebreak"><h2>Before and after</h2>
    ${table(['Page', 'Device', 'Metric', 'Before', 'After', 'Change'], after.deltas.map((d) => [short(d.url), d.device, d.metric, d.metric === 'CLS' ? num(d.before, 3) : d.metric === 'Score' ? num(d.before) : ms(d.before), d.metric === 'CLS' ? num(d.after, 3) : d.metric === 'Score' ? num(d.after) : ms(d.after), d.delta === null ? '–' : (d.delta > 0 ? '+' : '') + (d.metric === 'CLS' ? d.delta.toFixed(3) : Math.round(d.delta))]))}
    ${after.screenshots.filter((s) => s.before || s.after).map((s) => `<h3>${esc(short(s.url))}</h3><div class="sbs"><figure>${s.before ? `<img alt="before" src="${s.before}">` : ''}<figcaption>Before</figcaption></figure><figure>${s.after ? `<img alt="after" src="${s.after}">` : ''}<figcaption>After</figcaption></figure></div>`).join('')}
    ${(after.filmstrips ?? []).map((f) => `<h3>Filmstrip ${esc(short(f.url))}</h3><div class="sbs"><div>${f.before.map((s) => `<img alt="" src="${s}" style="width:19%">`).join('')}</div><div>${f.after.map((s) => `<img alt="" src="${s}" style="width:19%">`).join('')}</div></div>`).join('')}
    <h2>Change log</h2>${table(['ID', 'What', 'Where', 'Why', 'Flag or commit', 'Status', 'Rollback'], after.changeLog.map((c) => [c.id, c.what, c.where, c.why, c.implementation, c.status + (c.reason ? ` (${c.reason})` : ''), c.rollback]))}
    <h2>Verification</h2><p>Result: ${badge(after.verification.result)} ${after.verification.evidenceDir ? `<span class="muted">evidence: <code>${esc(after.verification.evidenceDir)}</code></span>` : ''}</p>${table(['Check', 'Result', 'Detail'], after.verification.checks.map((c) => [c.name, c.pass ? 'PASS' : 'FAIL', c.detail]))}
    <h2>Remaining blockers and your options</h2>${table(['Blocker', 'Measured cost', 'Options'], after.blockers.map((b) => [b.name, b.cost, b.options]))}
    <h2>Field data</h2><p>${esc(m.fieldNote)} Re-check dates: day 7 <strong>${esc(after.recheck.day7)}</strong>, day 28 <strong>${esc(after.recheck.day28)}</strong>.</p>
    <h2>Backups and rollback kit</h2>${table(['Backup', 'Stage', 'Verified', 'Taken'], after.backups.map((b) => [b.id, b.stage, b.verified ? 'yes' : 'no', b.createdAt]))}
    <ul>${after.rollbackKit.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  </section>`
    : '';

  const details = `
  <section class="pagebreak"><h2>Per-page metrics (median of ${esc(m.pages[0]?.runs ?? 5)} runs, with range)</h2>
  ${table(['Page', 'Template', 'Device', 'Score', 'LCP', 'TBT', 'CLS', 'FCP', 'TTFB', 'A11y'], m.pages.map((p) => [short(p.url), p.template, p.device, `${num(p.median?.score)} <span class="muted">(${num(p.range?.score?.min)}–${num(p.range?.score?.max)})</span>`, `${ms(p.median?.lcp)} <span class="muted">(${ms(p.range?.lcp?.min)}–${ms(p.range?.lcp?.max)})</span>`, ms(p.median?.tbt), num(p.median?.cls, 3), ms(p.median?.fcp), ms(p.median?.ttfb), num(p.accessibility)]), { raw: [3, 4] })}
  <h2>Largest Contentful Paint: element and phases</h2>
  ${table(['Page', 'Element', 'TTFB', 'Load delay', 'Load time', 'Render delay'], m.lcp.map((l) => [short(l.url), `${l.element ?? '–'}${l.src ? ` (${short(l.src)})` : ''}`, ms(l.phases?.ttfb), ms(l.phases?.loadDelay), ms(l.phases?.loadDuration), ms(l.phases?.renderDelay)]))}
  <h2>Layout shift culprits</h2>
  ${table(['Page', 'CLS', 'Culprits'], m.cls.map((c) => [short(c.url), num(c.total, 3), c.culprits.map((x) => `${x.selector ?? '?'} ${x.value.toFixed(3)} (${x.cause})`).join('; ')]))}
  <h2>Slowest interactions (4x CPU slowdown)</h2>
  ${table(['Page', 'Interaction', 'INP', 'Input delay', 'Processing', 'Presentation', 'Script (owner)'], m.interactions.map((i) => [short(i.url), i.name, ms(i.inp), ms(i.inputDelay), ms(i.processing), ms(i.presentation), i.script ? `${short(i.script)} (${i.owner})` : '–']))}
  <h2>Top scripts by main-thread time</h2>${table(['Owner', 'Main thread', 'KB'], m.topScripts.map((s) => [s.owner, ms(s.mainThreadMs), s.kb]))}
  <h2>Third-party and app cost</h2>${table(['Owner', 'Requests', 'KB', 'Main thread', 'Pages'], m.thirdParties.map((t) => [t.owner, t.requests, t.kb, ms(t.mainThreadMs), t.pages]))}
  <h2>Unused CSS and JavaScript</h2>${table(['File', 'Type', 'Unused KB', 'Owner'], m.unused.map((u) => [short(u.file), u.type, u.unusedKb, u.owner]))}
  <h2>Images</h2>${table(['Image', 'Issue'], m.images.map((i) => [short(i.src), i.issue]))}
  <h2>Fonts</h2>${table(['Family', 'Weight', 'Source', 'font-display'], m.fonts.map((f) => [f.family, f.weight, f.source, f.display ?? '–']))}
  <h2>Backend</h2>${table(['Item', 'Value'], m.backend.map((b) => [b.label, b.value]))}
  <h2>Errors found</h2>${table(['Page', 'Kind', 'Detail'], m.errors.map((e) => [short(e.url), e.kind, e.text]))}
  ${m.waterfall ? `<h2>Ideal versus actual loading</h2><div class="sbs"><div><h3>Ideal (first screen only)</h3>${table(['Resource', 'Type'], m.waterfall.ideal.map((r) => [short(r.url), r.type]))}</div><div><h3>Actual</h3>${table(['Resource', 'Type', 'Start', 'End'], m.waterfall.actual.slice(0, 40).map((r) => [short(r.url), r.type, ms(r.startMs), ms(r.endMs)]))}</div></div>` : ''}
  ${m.competitors?.length ? `<h2>Competitors (public data)</h2>${table(['Site', 'Field LCP', 'Field INP', 'What they do'], m.competitors.map((c) => [c.url, ms(c.lcp), ms(c.inp), c.notes.join('; ')]))}` : ''}
  <h2>Field data (real users)</h2>
  ${table(['Scope', 'Device', 'Status', 'LCP p75', 'INP p75', 'CLS p75'], m.field.map((f) => [f.scope, f.formFactor, f.status, ms(f.metrics.lcp), ms(f.metrics.inp), num(f.metrics.cls, 2)]))}<p class="muted">${esc(m.fieldNote)}</p>
  <h2>Ceiling estimate and blockers</h2><p>Phone score now ${num(m.ceiling.current)}, reachable within your constraints about <strong>${num(m.ceiling.reachable)}</strong>. <span class="muted">${esc(m.ceiling.note)}</span></p>
  ${table(['Blocker', 'Measured cost', 'Options'], m.ceiling.blockers.map((b) => [b.name, b.cost, b.options]))}
  ${m.kind === 'before' ? `<h2>Draft plan</h2>${table(['Item', 'Check', 'What', 'Tier', 'Expected gain', 'Guards'], m.plan.slice(0, 40).map((p) => [p.id, p.checkId, p.title, badge(p.tier), Object.entries(p.expectedGain).map(([k, v]) => `${k} ${Math.round(v as number)}`).join(', '), p.guards.join(' ')]), { raw: [3] })}` : ''}
  <h2>All findings</h2>
  ${m.findings.map((f) => `<details><summary>${esc(f.checkId)} ${esc(f.title)} ${badge(f.tier)} <span class="muted">priority ${f.priority}${f.rootCause ? `, cause ${esc(f.rootCause)}` : ''}</span></summary><p><strong>Fix:</strong> ${esc(f.fix)}</p><p><strong>Verify:</strong> ${esc(f.verify)}</p><p><strong>Pages:</strong> ${f.urls.slice(0, 8).map((u) => `<code>${esc(short(u))}</code>`).join(' ')}</p><pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(f.evidence, null, 1).slice(0, 3000))}</pre></details>`).join('')}
  <h2>Checks that need information we do not have yet</h2>${table(['Check', 'Title', 'Needs'], m.notAutomated.slice(0, 60).map((n) => [n.id, n.title, n.source]))}
  <h2>How this was measured</h2><p class="muted">Tools: ${Object.entries(m.versions).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')}. Run ${esc(m.runId)} on ${esc(m.stage)}. Analytics and ad beacons were recorded then blocked, so your data stays clean. Lighthouse scores move by about 5 points between runs, which is why every number is a median of 5 with its range. 100 is the aim, not a promise.</p>
  ${m.notes.length ? `<ul class="muted">${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main>
  <header class="hero">${m.branding.logo ? `<img class="logo" alt="" src="${esc(m.branding.logo)}">` : ''}<div><h1>${esc(title)}</h1><div class="muted">${esc(m.domain)} · ${esc(m.platform)} · ${esc(new Date(m.generatedAt).toISOString().slice(0, 10))}</div></div></header>
  ${page1}${afterHtml}${details}
  </main></body></html>`;
}
