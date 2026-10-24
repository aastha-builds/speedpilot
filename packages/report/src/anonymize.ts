/**
 * Anonymized mode (SPEC.md 9.3): removes client name, domain and logos for portfolio use.
 * Works on the report model before rendering, so every format gets the same scrubbing.
 */
export interface AnonymizeOptions {
  domains: string[];
  names: string[];
}

export function anonymizeModel<T>(model: T, opts: AnonymizeOptions): T {
  const domains = [...new Set(opts.domains.filter(Boolean))].sort((a, b) => b.length - a.length);
  const names = [...new Set(opts.names.filter((n) => n && n.length >= 3))].sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && /logo/i.test(key)) return undefined;
      let s = v;
      for (const d of domains) {
        s = s.replace(new RegExp(`(https?://)?(www\\.)?${esc(d)}`, 'gi'), (m, proto: string | undefined) => `${proto ?? ''}client-site.example`);
      }
      for (const n of names) s = s.replace(new RegExp(esc(n), 'gi'), 'Client');
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (/logo/i.test(k)) continue;
        if (/screenshot|filmstrip/i.test(k)) continue; // screenshots show the client's site
        o[k] = walk(val, k);
      }
      return o;
    }
    return v;
  };
  return walk(model) as T;
}
