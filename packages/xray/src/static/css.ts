/** Static analysis of CSS with postcss (SPEC.md 15.3): selectors, @font-face, @import chains, rule groups. */
import postcss, { type Root } from 'postcss';

export interface CssFacts {
  parsed: boolean;
  bytes: number;
  rules: number;
  selectors: string[];
  fontFaces: Array<{ family: string; weight: string; style: string; display: string | null; src: string[] }>;
  imports: string[];
  mediaQueries: string[];
  keyframes: string[];
  /** Selectors that look like state classes JavaScript toggles (open, active, visible...). Never purge these (SAFE-04). */
  stateSelectors: string[];
  hasCustomProperties: boolean;
}

const STATE = /\.(is-|has-)?(open|opened|active|visible|show|shown|expanded|collapsed|selected|current|toggled|loading|loaded|error|invalid|valid|focus|focused|hover|sticky|fixed|scrolled|menu-open|nav-open|modal-open|in|out|on|off|hidden|disabled|checked|added|added_to_cart)\b/;

export function analyzeCss(src: string): CssFacts {
  const facts: CssFacts = { parsed: false, bytes: Buffer.byteLength(src), rules: 0, selectors: [], fontFaces: [], imports: [], mediaQueries: [], keyframes: [], stateSelectors: [], hasCustomProperties: false };
  let root: Root;
  try {
    root = postcss.parse(src);
    facts.parsed = true;
  } catch {
    return facts;
  }
  const sel = new Set<string>();
  root.walkRules((r) => {
    if (r.parent && r.parent.type === 'atrule' && /keyframes/.test((r.parent as postcss.AtRule).name)) return;
    facts.rules++;
    for (const s of r.selectors ?? []) sel.add(s.trim());
  });
  root.walkAtRules((a) => {
    if (a.name === 'import') facts.imports.push(a.params.replace(/^url\(|\)$|["']/g, '').split(/\s/)[0]!);
    else if (a.name === 'media') facts.mediaQueries.push(a.params);
    else if (/keyframes$/.test(a.name)) facts.keyframes.push(a.params);
    else if (a.name === 'font-face') {
      const get = (p: string) => {
        let v: string | null = null;
        a.walkDecls(p, (d) => {
          v = d.value;
        });
        return v as string | null;
      };
      facts.fontFaces.push({
        family: (get('font-family') ?? '').replace(/["']/g, ''),
        weight: get('font-weight') ?? '400',
        style: get('font-style') ?? 'normal',
        display: get('font-display'),
        src: [...(get('src') ?? '').matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]!),
      });
    }
  });
  root.walkDecls((d) => {
    if (d.prop.startsWith('--')) facts.hasCustomProperties = true;
  });
  facts.selectors = [...sel];
  facts.stateSelectors = facts.selectors.filter((s) => STATE.test(s));
  return facts;
}
