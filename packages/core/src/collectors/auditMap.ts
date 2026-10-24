/**
 * Lighthouse 13 audit-ID map (SPEC.md 3.2), resolved against the INSTALLED Lighthouse at startup.
 * Never hardcode old IDs elsewhere: look them up here. A missing mapped ID fails loudly.
 *
 * Each logical key lists candidate IDs in order of preference. The first is the SPEC.md 3.2 name; later entries are
 * the names shipped by newer 13.x releases (checked against lighthouse 13.5.0: `cache-insight`,
 * `inp-breakdown-insight`, `lcp-breakdown-insight`).
 */
export const AUDIT_CANDIDATES = {
  clsCulprits: ['cls-culprits-insight'],
  documentLatency: ['document-latency-insight'],
  domSize: ['dom-size-insight'],
  duplicatedJavascript: ['duplicated-javascript-insight'],
  fontDisplay: ['font-display-insight'],
  imageDelivery: ['image-delivery-insight'],
  interactionToNextPaint: ['interaction-to-next-paint-insight', 'inp-breakdown-insight'],
  lcpDiscovery: ['lcp-discovery-insight'],
  lcpPhases: ['lcp-phases-insight', 'lcp-breakdown-insight'],
  legacyJavascript: ['legacy-javascript-insight'],
  modernHttp: ['modern-http-insight'],
  networkDependencyTree: ['network-dependency-tree-insight'],
  renderBlocking: ['render-blocking-insight'],
  thirdParties: ['third-parties-insight'],
  useCache: ['use-cache-insight', 'cache-insight'],
  viewport: ['viewport-insight'],
  // still separate audits in 13
  unusedJavascript: ['unused-javascript'],
  unusedCssRules: ['unused-css-rules'],
  unsizedImages: ['unsized-images'],
  nonCompositedAnimations: ['non-composited-animations'],
  bootupTime: ['bootup-time'],
  mainthreadWorkBreakdown: ['mainthread-work-breakdown'],
  longTasks: ['long-tasks'],
  totalByteWeight: ['total-byte-weight'],
  bfCache: ['bf-cache'],
  // metrics
  fcp: ['first-contentful-paint'],
  lcp: ['largest-contentful-paint'],
  tbt: ['total-blocking-time'],
  cls: ['cumulative-layout-shift'],
  speedIndex: ['speed-index'],
  serverResponse: ['server-response-time', 'document-latency-insight'],
} as const;

export type AuditKey = keyof typeof AUDIT_CANDIDATES;
export type AuditMap = Record<AuditKey, string>;

/** Audits Lighthouse 13 removed with no replacement; SpeedPilot detects these problems itself (CHECKS.md). */
export const REMOVED_IN_13 = ['first-meaningful-paint', 'font-size', 'no-document-write', 'offscreen-images', 'preload-fonts', 'third-party-facades', 'uses-passive-event-listeners', 'uses-rel-preload'];

/** Old (pre-13) IDs that must never be used directly. */
export const OLD_IDS: Record<string, AuditKey> = {
  'layout-shifts': 'clsCulprits',
  redirects: 'documentLatency',
  'uses-text-compression': 'documentLatency',
  'dom-size': 'domSize',
  'duplicated-javascript': 'duplicatedJavascript',
  'font-display': 'fontDisplay',
  'modern-image-formats': 'imageDelivery',
  'uses-optimized-images': 'imageDelivery',
  'efficient-animated-content': 'imageDelivery',
  'uses-responsive-images': 'imageDelivery',
  'work-during-interaction': 'interactionToNextPaint',
  'prioritize-lcp-image': 'lcpDiscovery',
  'lcp-lazy-loaded': 'lcpDiscovery',
  'largest-contentful-paint-element': 'lcpPhases',
  'legacy-javascript': 'legacyJavascript',
  'uses-http2': 'modernHttp',
  'critical-request-chains': 'networkDependencyTree',
  'uses-rel-preconnect': 'networkDependencyTree',
  'render-blocking-resources': 'renderBlocking',
  'third-party-summary': 'thirdParties',
  'uses-long-cache-ttl': 'useCache',
  viewport: 'viewport',
};

export class AuditMapError extends Error {
  override name = 'AuditMapError';
}

/** Builds the map from the list of audit IDs the installed Lighthouse ships. Throws if any key cannot be resolved. */
export function buildAuditMap(installedIds: Iterable<string>): AuditMap {
  const have = new Set(installedIds);
  const map = {} as AuditMap;
  const missing: string[] = [];
  for (const [key, candidates] of Object.entries(AUDIT_CANDIDATES) as Array<[AuditKey, readonly string[]]>) {
    const hit = candidates.find((c) => have.has(c));
    if (!hit) missing.push(`${key} (${candidates.join(' | ')})`);
    else map[key] = hit;
  }
  if (missing.length) throw new AuditMapError(`Installed Lighthouse is missing mapped audits: ${missing.join(', ')}. Update AUDIT_CANDIDATES after checking the Lighthouse changelog.`);
  return map;
}

let cached: { version: string; map: AuditMap } | undefined;

/** Reads the installed Lighthouse default config and its version. */
export async function installedLighthouse(): Promise<{ version: string; auditIds: string[] }> {
  const cfgMod = (await import('lighthouse/core/config/default-config.js')) as { default: { audits: Array<string | { path: string }> } };
  const auditIds = cfgMod.default.audits.map((a) => (typeof a === 'string' ? a : a.path).split('/').pop()!);
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const version = (req('lighthouse/package.json') as { version: string }).version;
  return { version, auditIds };
}

export async function getAuditMap(): Promise<{ version: string; map: AuditMap }> {
  if (cached) return cached;
  const { version, auditIds } = await installedLighthouse();
  if (!/^13\./.test(version)) throw new AuditMapError(`SpeedPilot pins Lighthouse 13.x; found ${version}.`);
  cached = { version, map: buildAuditMap(auditIds) };
  return cached;
}
