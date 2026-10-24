/**
 * Lighthouse performance scoring (log-normal curves), used to convert metric gains into score points for the
 * ceiling estimate and the what-if simulator. Curves and weights match Lighthouse 13 (weights unchanged in 13).
 */
import type { Device } from '../collectors/browser.js';

export const CURVES: Record<Device, Record<'fcp' | 'si' | 'lcp' | 'tbt' | 'cls', { p10: number; median: number; weight: number }>> = {
  mobile: {
    fcp: { p10: 1800, median: 3000, weight: 0.1 },
    si: { p10: 3387, median: 5800, weight: 0.1 },
    lcp: { p10: 2500, median: 4000, weight: 0.25 },
    tbt: { p10: 200, median: 600, weight: 0.3 },
    cls: { p10: 0.1, median: 0.25, weight: 0.25 },
  },
  desktop: {
    fcp: { p10: 934, median: 1600, weight: 0.1 },
    si: { p10: 1311, median: 2300, weight: 0.1 },
    lcp: { p10: 1200, median: 2400, weight: 0.25 },
    tbt: { p10: 150, median: 350, weight: 0.3 },
    cls: { p10: 0.1, median: 0.25, weight: 0.25 },
  },
};

const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;

function erf(x: number): number {
  const sign = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return sign * (1 - y * Math.exp(-x * x));
}

export function logNormalScore({ p10, median }: { p10: number; median: number }, value: number): number {
  if (value <= 0) return 1;
  const xLogRatio = Math.log(value / median);
  const p10LogRatio = -Math.log(p10 / median);
  const standardizedX = (xLogRatio * INVERSE_ERFC_ONE_FIFTH) / p10LogRatio;
  const complementaryPercentile = (1 - erf(standardizedX)) / 2;
  if (value <= p10) return Math.max(0.9, Math.min(1, complementaryPercentile));
  if (value <= median) return Math.max(0.5, Math.min(0.8999999999999999, complementaryPercentile));
  return Math.max(0, Math.min(0.49999999999999994, complementaryPercentile));
}

export interface ScoreInput {
  fcp: number | null;
  si: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
}

export function performanceScore(m: ScoreInput, device: Device): number | null {
  const c = CURVES[device];
  let total = 0;
  for (const k of ['fcp', 'si', 'lcp', 'tbt', 'cls'] as const) {
    const v = m[k];
    if (v === null || v === undefined) return null;
    total += c[k].weight * logNormalScore(c[k], v);
  }
  return Math.round(total * 100);
}
