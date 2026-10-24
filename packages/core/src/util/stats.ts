/** Median, min, max of numbers (CLAUDE.md rule 15: medians of repeated runs with their range). */
export function summarize(values: Array<number | null | undefined>): { median: number | null; min: number | null; max: number | null; n: number } {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: null, min: null, max: null, n: 0 };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { median, min: v[0]!, max: v[v.length - 1]!, n: v.length };
}

/** Index of the run whose value is the median (odd counts), used to keep "the median run". */
export function medianIndex(values: number[]): number {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  return idx[Math.floor((idx.length - 1) / 2)]![1];
}

export function round(n: number | null | undefined, digits = 0): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
