import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules, EVALUATORS, guardsFor, performanceScore, logNormalScore, gradeTemplate, gradeSite } from '@speedpilot/core';
import { REPO } from './helpers.js';

const checkIds = [...readFileSync(join(REPO, 'CHECKS.md'), 'utf8').matchAll(/^- \*\*([A-Z0-9]+-\d+) /gm)].map((m) => m[1]!);
const rules = loadRules(join(REPO, 'rules'));

describe('rules generated from CHECKS.md', () => {
  it('has exactly one rule for every CHECKS.md ID (no skipping, merging or renaming)', () => {
    expect(checkIds.length).toBe(237);
    const ruleIds = rules.map((r) => r.id);
    const missing = checkIds.filter((id) => !ruleIds.includes(id));
    expect(missing, `CHECKS.md IDs without a rule: ${missing.join(', ')}`).toEqual([]);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds.filter((id) => !checkIds.includes(id))).toEqual([]);
  });
  it('every rule has the CHECKS.md fields', () => {
    for (const r of rules) {
      expect(r.platforms, r.id).toMatch(/^(wp|shopify|both)$/);
      expect(r.metric, r.id).toBeTruthy();
      expect(r.tier, r.id).toMatch(/^(T1|T2|T3|report|T1\/T2|T2\/T3|by-cause)$/);
      expect(r.fix.length, r.id).toBeGreaterThan(3);
      expect(r.detect.condition.length, r.id).toBeGreaterThan(3);
      expect(r.verify.length, r.id).toBeGreaterThan(3);
    }
  });
  it('automated rules have an evaluator and every evaluator has a rule', () => {
    for (const r of rules.filter((x) => x.detect.automated)) expect(EVALUATORS[r.id], r.id).toBeTypeOf('function');
    for (const id of Object.keys(EVALUATORS)) expect(rules.find((r) => r.id === id)?.detect.automated, id).toBe(true);
  });
  it('SAFE checks are guards; T3 items keep T3', () => {
    expect(rules.filter((r) => r.area === 'SAFE').every((r) => r.kind === 'guard')).toBe(true);
    expect(rules.find((r) => r.id === 'WPB-01')!.tier).toBe('T3');
    expect(rules.find((r) => r.id === 'IMG-06')!.tier).toBe('T1');
    expect(rules.find((r) => r.id === 'NET-01')!.tier).toBe('by-cause');
  });
  it('attaches SAFE guards by fix type', () => {
    expect(guardsFor('JS-01', 'defer after checking inline code', 'wordpress')).toContain('SAFE-01');
    expect(guardsFor('WPF-06', 'load only on pages with forms', 'wordpress')).toContain('SAFE-05');
    expect(guardsFor('SHA-03', 'quarantine leftover snippet', 'shopify')).toEqual(expect.arrayContaining(['SAFE-17', 'SAFE-18']));
  });
});

describe('scoring and grades', () => {
  it('matches Lighthouse log-normal scoring', () => {
    expect(logNormalScore({ p10: 2500, median: 4000 }, 2500)).toBeCloseTo(0.9, 2);
    expect(logNormalScore({ p10: 2500, median: 4000 }, 4000)).toBeCloseTo(0.5, 2);
    expect(performanceScore({ fcp: 900, si: 1000, lcp: 1200, tbt: 0, cls: 0 }, 'mobile')).toBe(100);
    const s = performanceScore({ fcp: 2830, si: 4911, lcp: 8261, tbt: 25, cls: 0.306 }, 'mobile')!;
    expect(Math.abs(s - 52)).toBeLessThanOrEqual(3);
  });
  it('grades exactly as SPEC 9.4 and caps by safety', () => {
    const t = { template: 'home', mobileScore: 96, desktopScore: 99, lcp: 1700, tbt: 90, cls: 0.04, worstInteraction: 150 };
    expect(gradeTemplate(t, { allGood: null })).toBe('AAA+++');
    expect(gradeTemplate(t, { allGood: false })).toBe('AA');
    expect(gradeTemplate({ ...t, mobileScore: 91, desktopScore: 95, lcp: 2400, tbt: 190 }, { allGood: true })).toBe('AA');
    expect(gradeTemplate({ ...t, mobileScore: 91, desktopScore: 94 }, { allGood: true })).toBe('A');
    expect(gradeTemplate({ ...t, mobileScore: 60 }, { allGood: true })).toBe('B');
    expect(gradeTemplate({ ...t, mobileScore: 40 }, { allGood: true })).toBe('C');
    const site = gradeSite([t, { ...t, template: 'product', mobileScore: 80 }], { allGood: null }, 'FAIL');
    expect(site.grade).toBe('A');
    expect(site.counts).toBe(false);
  });
});
