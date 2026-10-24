/**
 * Analytics and ad beacon endpoints. In every automated run these requests are RECORDED, then ABORTED,
 * so the client's analytics and ad conversion data stay clean (CLAUDE.md rule 12, CHECKS MEAS-10).
 * The tag scripts themselves still load so their cost is measured.
 */
export interface BeaconRule {
  vendor: string;
  /** Matches the full URL. */
  test: RegExp;
  /** Lighthouse blockedUrlPatterns wildcard form. */
  lighthouse: string[];
}

export const BEACON_RULES: BeaconRule[] = [
  { vendor: 'ga4', test: /\/g\/collect(\?|$)/, lighthouse: ['*/g/collect*'] },
  { vendor: 'ga-universal', test: /google-analytics\.com\/(r\/)?(j\/)?collect/, lighthouse: ['*google-analytics.com/collect*', '*google-analytics.com/j/collect*', '*google-analytics.com/r/collect*'] },
  { vendor: 'doubleclick', test: /(stats|googleads)\.g\.doubleclick\.net\/(pagead|j\/collect|g\/collect)/, lighthouse: ['*doubleclick.net/pagead/*', '*stats.g.doubleclick.net/*'] },
  { vendor: 'google-ads', test: /googleadservices\.com\/pagead\/conversion|google\.com\/pagead\/1p-(user-list|conversion)|google\.[a-z.]+\/ads\/ga-audiences/, lighthouse: ['*googleadservices.com/pagead/conversion*', '*google.com/pagead/1p-*', '*/ads/ga-audiences*'] },
  { vendor: 'meta-pixel', test: /facebook\.com\/tr(\/|\?|$)/, lighthouse: ['*facebook.com/tr*'] },
  { vendor: 'tiktok', test: /analytics\.tiktok\.com\/api\/v\d\/(pixel|monitor)/, lighthouse: ['*analytics.tiktok.com/api/*'] },
  { vendor: 'bing', test: /bat\.bing\.com\/action/, lighthouse: ['*bat.bing.com/action*'] },
  { vendor: 'linkedin', test: /px\.ads\.linkedin\.com\/collect/, lighthouse: ['*px.ads.linkedin.com/collect*'] },
  { vendor: 'pinterest', test: /ct\.pinterest\.com\/v3/, lighthouse: ['*ct.pinterest.com/v3*'] },
  { vendor: 'klaviyo', test: /a\.klaviyo\.com\/(api\/(track|identify|onsite)|client\/events)/, lighthouse: ['*a.klaviyo.com/api/track*', '*a.klaviyo.com/client/events*'] },
  { vendor: 'snapchat', test: /tr\.snapchat\.com\/p/, lighthouse: ['*tr.snapchat.com/p*'] },
  { vendor: 'clarity', test: /[a-z]\.clarity\.ms\/collect/, lighthouse: ['*.clarity.ms/collect*'] },
  { vendor: 'hotjar', test: /(in|vc)\.hotjar\.(com|io)\//, lighthouse: ['*in.hotjar.com/*', '*vc.hotjar.io/*'] },
  { vendor: 'shopify-monorail', test: /monorail-edge\.shopifysvc\.com\/|\/api\/collect$|\/\.well-known\/shopify\/monorail/, lighthouse: ['*monorail-edge.shopifysvc.com/*', '*/.well-known/shopify/monorail*'] },
  { vendor: 'wc-order-attribution', test: /\/wp-json\/wc\/store\/v\d\/order-attribution/, lighthouse: [] },
];

export function matchBeacon(url: string): BeaconRule | undefined {
  return BEACON_RULES.find((r) => r.test.test(url));
}

export const LIGHTHOUSE_BLOCKED_PATTERNS = BEACON_RULES.flatMap((r) => r.lighthouse);

export interface BeaconRecord {
  vendor: string;
  url: string;
  method: string;
  /** Event name when it can be read (GA4 `en`, Meta `ev`). */
  event?: string;
  at: number;
}

export function beaconEvent(url: string, postData?: string | null): string | undefined {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const fromBody = postData ? new URLSearchParams(postData.split('\n')[0] ?? '') : undefined;
    return p.get('en') ?? p.get('ev') ?? p.get('event') ?? fromBody?.get('en') ?? fromBody?.get('ev') ?? undefined;
  } catch {
    return undefined;
  }
}
