/**
 * Library fingerprints with versions (SPEC.md 15.3, 15.6) plus Retire.js-style vulnerability signatures.
 * Signatures are identifiers and version ranges only: no vendor code.
 */
export interface LibraryHit {
  library: string;
  version: string | null;
  via: 'url' | 'banner' | 'global';
  vulnerable?: Array<{ below: string; info: string }>;
}

interface Signature {
  library: string;
  url?: RegExp;
  banner?: RegExp;
  global?: string;
  vulnerabilities?: Array<{ below: string; info: string }>;
}

/** A small embedded subset of Retire.js-style signatures (Apache-2.0 data format), covering common front-end libraries. */
export const SIGNATURES: Signature[] = [
  { library: 'jquery', url: /jquery[.-]?(\d+\.\d+\.\d+)?(\.min)?\.js/, banner: /jQuery (?:JavaScript Library )?v(\d+\.\d+\.\d+)/, global: 'jQuery', vulnerabilities: [{ below: '3.5.0', info: 'CVE-2020-11022/11023: XSS in htmlPrefilter' }, { below: '3.4.0', info: 'CVE-2019-11358: prototype pollution in extend' }] },
  { library: 'jquery-migrate', url: /jquery-migrate[.-]?(\d+\.\d+\.\d+)?(\.min)?\.js/, banner: /jQuery Migrate (?:- )?v(\d+\.\d+\.\d+)/ },
  { library: 'jquery-ui', url: /jquery-ui[.-]?(\d+\.\d+\.\d+)?(\.min)?\.js/, banner: /jQuery UI - v(\d+\.\d+\.\d+)/, vulnerabilities: [{ below: '1.13.0', info: 'CVE-2021-41182/41183/41184: XSS' }] },
  { library: 'lodash', url: /lodash(\.min)?\.js/, banner: /lodash\.com.*?(\d+\.\d+\.\d+)|@license\s+Lodash\s+(\d+\.\d+\.\d+)/, global: '_', vulnerabilities: [{ below: '4.17.21', info: 'CVE-2021-23337: command injection in template' }] },
  { library: 'underscore', url: /underscore(\.min)?\.js/, banner: /Underscore\.js (\d+\.\d+\.\d+)/ },
  { library: 'moment', url: /moment(\.min)?\.js/, banner: /moment\.js.*?version\s*:?\s*(\d+\.\d+\.\d+)|\/\/! version : (\d+\.\d+\.\d+)/, vulnerabilities: [{ below: '2.29.4', info: 'CVE-2022-31129: ReDoS in rfc2822 parsing' }] },
  { library: 'swiper', url: /swiper(-bundle)?(\.min)?\.js/, banner: /Swiper (\d+\.\d+\.\d+)/ },
  { library: 'slick', url: /slick(\.min)?\.js/, banner: /Version: (\d+\.\d+\.\d+)[\s\S]{0,200}slick/ },
  { library: 'owl-carousel', url: /owl\.carousel(\.min)?\.js/, banner: /Owl Carousel v(\d+\.\d+\.\d+)/ },
  { library: 'gsap', url: /gsap(\.min)?\.js|TweenMax/, banner: /GSAP (\d+\.\d+\.\d+)/ },
  { library: 'aos', url: /aos(\.min)?\.js/, global: 'AOS' },
  { library: 'bootstrap', url: /bootstrap(\.bundle)?(\.min)?\.js/, banner: /Bootstrap v(\d+\.\d+\.\d+)/, vulnerabilities: [{ below: '3.4.1', info: 'CVE-2019-8331: XSS in tooltip data-template' }] },
  { library: 'font-awesome', url: /font-?awesome|fontawesome/ },
  { library: 'lazysizes', url: /lazysizes(\.min)?\.js/, global: 'lazySizes' },
  { library: 'flickity', url: /flickity(\.pkgd)?(\.min)?\.js/, banner: /Flickity v(\d+\.\d+\.\d+)/ },
  { library: 'fancybox', url: /fancybox(\.umd)?(\.min)?\.js/, banner: /fancyBox v?(\d+\.\d+\.\d+)/ },
  { library: 'magnific-popup', url: /magnific-popup(\.min)?\.js/ },
  { library: 'photoswipe', url: /photoswipe(-ui-default)?(\.min)?\.js/ },
  { library: 'vue', url: /vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js/, banner: /Vue\.js v(\d+\.\d+\.\d+)/ },
  { library: 'react', url: /react(-dom)?(\.production)?(\.min)?\.js/, banner: /React v(\d+\.\d+\.\d+)|react-dom\.production\.min\.js/ },
  { library: 'alpinejs', url: /alpine(\.min)?\.js|alpinejs/ },
];

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function fingerprint(url: string, source?: string): LibraryHit[] {
  const out: LibraryHit[] = [];
  const head = source?.slice(0, 3000) ?? '';
  for (const s of SIGNATURES) {
    let version: string | null = null;
    let via: LibraryHit['via'] | null = null;
    const b = s.banner ? s.banner.exec(head) : null;
    if (b) {
      version = b.slice(1).find(Boolean) ?? null;
      via = 'banner';
    }
    const u = s.url ? s.url.exec(url) : null;
    if (u && !via) {
      via = 'url';
      version = u.slice(1).find((x) => x && /^\d/.test(x)) ?? null;
      const ver = /[?&]ver=(\d+\.\d+(\.\d+)?)/.exec(url);
      if (!version && ver) version = ver[1]!;
    }
    if (!via) continue;
    if (s.library === 'jquery' && /migrate|ui/.test(url) && via === 'url') continue;
    const vulnerable = version ? (s.vulnerabilities ?? []).filter((v) => compareVersions(version!, v.below) < 0) : undefined;
    out.push({ library: s.library, version, via, vulnerable: vulnerable?.length ? vulnerable : undefined });
  }
  return out;
}
