/**
 * Lightweight replacements (SPEC.md 15.8, REV-05). When a heavy widget (slider, review carousel, feed, popup, tabs)
 * costs more than 100 ms of main-thread time or 100 KB, record what it actually outputs and propose a replacement
 * written from scratch with native HTML and CSS and minimal JS. Never vendor code; client approval required (T3).
 */
import { readFileSync, existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import type { XrayCapture } from './capture/cdp.js';
import type { OwnerCost } from './analysis/costs.js';
import type { Recipe } from './recipes.js';

export interface ReplacementProposal {
  owner: string;
  mainThreadMs: number;
  bytes: number;
  output: string;
  widget: 'slider' | 'reviews' | 'tabs' | 'popup' | 'feed';
  proposal: string;
  snippet: string;
  tier: 'T3';
  conditions: string[];
}

const DETECT: Array<{ widget: ReplacementProposal['widget']; item: string; container: string; categories: string[] }> = [
  { widget: 'slider', item: '.swiper-slide, .slick-slide, .n2-ss-slide, .owl-item, rs-slide, .carousel-item, .slide', container: '.swiper, .slick-slider, .n2-ss-slider, .owl-carousel, rs-module, .carousel', categories: ['slider'] },
  { widget: 'reviews', item: '.jdgm-rev, .yotpo-review, .loox-review, .review, [itemprop="review"]', container: '.jdgm-widget, .yotpo, #looxReviews, .reviews', categories: ['reviews'] },
  { widget: 'tabs', item: '[role="tab"], .tab-title, .accordion-title', container: '[role="tablist"], .tabs, .accordion', categories: ['tabs'] },
  { widget: 'popup', item: '.popup, .modal, [role="dialog"]', container: '.popup, .modal, [role="dialog"]', categories: ['popup'] },
  { widget: 'feed', item: '.instagram-item, .sbi_item, .feed-item', container: '#sb_instagram, .instagram-feed, .feed', categories: ['social-feed'] },
];

const SNIPPETS: Record<ReplacementProposal['widget'], string> = {
  slider: `<div class="sp-carousel" role="region" aria-label="Slides" tabindex="0">\n  <!-- one <figure> per slide; the first image eager with fetchpriority="high", the rest loading="lazy" -->\n</div>\n<style>.sp-carousel{display:grid;grid-auto-flow:column;grid-auto-columns:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}.sp-carousel>*{scroll-snap-align:start}</style>`,
  reviews: `<!-- stars rendered on the server from the vendor's official API or the page's existing JSON-LD aggregateRating -->\n<p class="sp-stars" aria-label="Rated 4.8 out of 5">★★★★★ <span>4.8 (120 reviews)</span></p>`,
  tabs: `<details class="sp-tab" open><summary>Description</summary><div>…</div></details>\n<details class="sp-tab"><summary>Shipping</summary><div>…</div></details>`,
  popup: `<dialog id="sp-popup"><form method="dialog"><button aria-label="Close">×</button></form>…</dialog>\n<script>/* open after a real user action or on exit intent, never on load */</script>`,
  feed: `<ul class="sp-feed"><!-- images from the platform's official API, cached server-side, loading="lazy" with width and height --></ul>`,
};

export function proposeReplacements(captures: XrayCapture[], costs: OwnerCost[], recipes: Array<{ owner: string; recipe?: Recipe }> = []): ReplacementProposal[] {
  const out: ReplacementProposal[] = [];
  for (const c of costs.filter((x) => (x.mainThreadMs > 100 || x.bytes > 100 * 1024) && /^(plugin|app|third-party|theme):/.test(x.owner))) {
    const recipe = recipes.find((r) => r.owner === c.owner)?.recipe;
    for (const d of DETECT) {
      let count = 0;
      let images = 0;
      for (const cap of captures) {
        if (!cap.domPath || !existsSync(cap.domPath)) continue;
        const $ = cheerio.load(readFileSync(cap.domPath, 'utf8'));
        const cont = $(d.container).first();
        if (!cont.length) continue;
        count = Math.max(count, cont.find(d.item).length || $(d.item).length);
        images = Math.max(images, cont.find('img').length);
      }
      const byRecipe = recipe && d.categories.includes(recipe.category);
      const ownerHint = new RegExp(d.widget === 'slider' ? 'slider|carousel|swiper|slick|owl' : d.widget === 'reviews' ? 'review|judge|yotpo|loox|stamped' : d.widget, 'i').test(c.owner);
      if (!count || (!byRecipe && !ownerHint)) continue;
      out.push({
        owner: c.owner,
        mainThreadMs: c.mainThreadMs,
        bytes: c.bytes,
        output: `${d.widget}: ${count} item(s)${images ? `, ${images} image(s)` : ''}`,
        widget: d.widget,
        proposal: d.widget === 'slider' ? 'A CSS scroll-snap carousel with native buttons (a few lines of JS for prev/next), first slide eager, others lazy.' : d.widget === 'reviews' ? 'Server-rendered stars and review text from the vendor\'s official API or existing JSON-LD; the full widget loads on interaction.' : d.widget === 'tabs' ? '<details> and <summary> elements, no JavaScript.' : d.widget === 'popup' ? 'A native <dialog> opened after a real user action.' : 'Static images from the official API, lazy-loaded with dimensions.',
        snippet: SNIPPETS[d.widget],
        tier: 'T3',
        conditions: ['Written from scratch: no vendor code, images or text copied (CLAUDE.md rule 16)', 'Respect the vendor\'s display terms and licence', 'Client approval required', 'Flows must prove the same features still work; visual diff'],
      });
      break;
    }
  }
  return out;
}
