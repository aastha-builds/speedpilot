/**
 * Self-hosted Google Fonts for the agent's fonts module (FONT-01 to FONT-04): keep only the weights and styles the
 * rendered pages load, latin and latin-ext subsets, woff2, font-display: swap, at most 2 preloads, and fallback metric
 * overrides computed from the font files themselves (size-adjust, ascent-override, descent-override, line-gap-override).
 * SpeedPilot downloads the files; the agent never makes outgoing calls.
 */
import { brotliDecompressSync } from 'node:zlib';
import postcss from 'postcss';
import type { ProbeFont } from '../probe.js';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

export interface FontFile {
  family: string;
  weight: string;
  style: string;
  subset: string;
  remote: string;
  name: string;
  unicodeRange?: string;
  data?: Buffer;
}

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  xAvgCharWidth: number;
}

const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** Reads head, hhea and OS/2 metrics from a WOFF2 file (those tables are never transformed). */
export function woff2Metrics(buf: Buffer): FontMetrics {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = buf.readUInt16BE(12);
  let off = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[off++]!;
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const tables: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[off++]!;
    const idx = flags & 0x3f;
    const tag = idx === 63 ? buf.toString('latin1', off, (off += 4)) : KNOWN_TAGS[idx]!;
    const version = (flags >> 6) & 3;
    const orig = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128() : orig;
    tables.push({ tag, length });
  }
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error('font collections are not supported');
  const data = brotliDecompressSync(buf.subarray(off, off + buf.readUInt32BE(20)));
  let pos = 0;
  const at: Record<string, number> = {};
  for (const t of tables) {
    at[t.tag] = pos;
    pos += t.length;
  }
  if (at.head === undefined || at.hhea === undefined || at['OS/2'] === undefined) throw new Error('missing head, hhea or OS/2');
  return { unitsPerEm: data.readUInt16BE(at.head + 18), ascender: data.readInt16BE(at.hhea + 4), descender: data.readInt16BE(at.hhea + 6), lineGap: data.readInt16BE(at.hhea + 8), xAvgCharWidth: data.readInt16BE(at['OS/2'] + 2) };
}

// Arial (the usual local fallback): xAvgCharWidth 904 over 2048 units per em
const ARIAL_AVG = 904 / 2048;

/** A fallback @font-face on local Arial sized to the web font, so the swap moves almost nothing (CLS). */
export function fallbackFace(family: string, m: FontMetrics): string {
  const sizeAdjust = m.xAvgCharWidth / m.unitsPerEm / ARIAL_AVG;
  const pct = (v: number) => `${((v / (m.unitsPerEm * sizeAdjust)) * 100).toFixed(2)}%`;
  return `@font-face{font-family:"${family} Fallback";src:local("Arial"),local("Helvetica"),local("Liberation Sans");size-adjust:${(sizeAdjust * 100).toFixed(2)}%;ascent-override:${pct(m.ascender)};descent-override:${pct(Math.abs(m.descender))};line-gap-override:${pct(m.lineGap)}}`;
}

/** Parses Google Fonts CSS into files, keeping only used faces and the latin subsets. */
export function parseGoogleCss(css: string, used: ProbeFont[]): FontFile[] {
  const out: FontFile[] = [];
  let subset = 'latin';
  const root = postcss.parse(css);
  root.walk((node) => {
    if (node.type === 'comment') subset = node.text.trim();
    if (node.type !== 'atrule' || node.name !== 'font-face') return;
    const get = (p: string) => {
      let v = '';
      node.walkDecls(p, (d) => {
        v = d.value;
      });
      return v;
    };
    const family = get('font-family').replace(/["']/g, '');
    const weight = get('font-weight') || '400';
    const style = get('font-style') || 'normal';
    const remote = /url\(([^)]+)\)/.exec(get('src'))?.[1]?.replace(/["']/g, '');
    if (!remote || !KEEP_SUBSETS.has(subset)) return;
    const isUsed = used.some((u) => u.family === family && (u.weight === weight || (u.weight === 'normal' && weight === '400') || (u.weight === 'bold' && weight === '700')) && (u.style === style || (u.style === 'normal' && style === 'normal')));
    if (!isUsed) return;
    out.push({ family, weight, style, subset, remote, unicodeRange: get('unicode-range') || undefined, name: `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${weight}-${style}-${subset}.woff2` });
  });
  return out;
}

export async function fetchGoogleCss(url: string, f: typeof fetch = fetch): Promise<string> {
  const r = await f(url, { headers: { 'user-agent': CHROME_UA } });
  if (!r.ok) throw new Error(`Google Fonts CSS ${r.status}`);
  return r.text();
}

export interface SelfHostedFonts {
  files: FontFile[];
  css: string;
  preload: string[];
  fallbackCss: string;
}

/**
 * Builds the self-hosted set. `uploadBase` is the public URL of uploads/speedpilot/fonts/. `criticalCss` gives the
 * rules whose font-family stacks get the "<Family> Fallback" face inserted.
 */
export async function buildSelfHostedFonts(cssUrls: string[], used: ProbeFont[], uploadBase: string, criticalCss = '', f: typeof fetch = fetch): Promise<SelfHostedFonts> {
  const files: FontFile[] = [];
  for (const u of cssUrls) files.push(...parseGoogleCss(await fetchGoogleCss(u, f), used));
  for (const file of files) {
    const r = await f(file.remote, { headers: { 'user-agent': CHROME_UA } });
    if (!r.ok) throw new Error(`font file ${r.status}: ${file.remote}`);
    file.data = Buffer.from(await r.arrayBuffer());
  }
  const css = files.map((x) => `@font-face{font-family:"${x.family}";font-style:${x.style};font-weight:${x.weight};font-display:swap;src:url(${uploadBase}${x.name}) format("woff2")${x.unicodeRange ? `;unicode-range:${x.unicodeRange}` : ''}}`).join('\n');
  // preload the latin files of the first two faces the pages load (body text and headings)
  const order = used.map((u) => files.find((x) => x.family === u.family && x.subset === 'latin' && (x.weight === u.weight || (u.weight === 'normal' && x.weight === '400') || (u.weight === 'bold' && x.weight === '700')) && x.style === (u.style === 'italic' ? 'italic' : 'normal'))).filter((x): x is FontFile => !!x);
  const preload = [...new Set(order.map((x) => `${uploadBase}${x.name}`))].slice(0, 2);
  const families = [...new Set(files.map((x) => x.family))];
  const faces: string[] = [];
  for (const fam of families) {
    const regular = files.find((x) => x.family === fam && x.subset === 'latin' && x.weight === '400' && x.style === 'normal') ?? files.find((x) => x.family === fam);
    if (regular?.data) {
      try {
        faces.push(fallbackFace(fam, woff2Metrics(regular.data)));
      } catch {
        /* metrics are an optimization; skip when the file cannot be read */
      }
    }
  }
  const stacks: string[] = [];
  if (criticalCss && faces.length) {
    postcss.parse(criticalCss).walkDecls('font-family', (d) => {
      const fam = families.find((x) => new RegExp(`(^|,)\\s*["']?${x}["']?\\s*(,|$)`).test(d.value));
      if (!fam || d.value.includes(`${fam} Fallback`)) return;
      const rule = d.parent as postcss.Rule;
      if (rule?.type !== 'rule' || rule.parent?.type !== 'root') return;
      // `html ` raises specificity so the stack wins over the theme rule that prints later
      stacks.push(`${rule.selectors.map((x) => (x.startsWith('html') ? x : `html ${x}`)).join(',')}{font-family:${d.value.replace(new RegExp(`(["']?${fam}["']?)`), `$1,"${fam} Fallback"`)}}`);
    });
  }
  return { files, css, preload, fallbackCss: [...faces, ...new Set(stacks)].join('\n') };
}
