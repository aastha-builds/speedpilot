import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ensureDir, paths } from '../util/paths.js';

const envVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'access values are environment variable NAMES (for example WP_SHOP_REST_APP_PASSWORD), never secrets');

/** A Playwright flow step (SPEC.md 6, 10.3). */
export const flowStepSchema = z.union([
  z.object({ goto: z.string() }),
  z.object({ click: z.string(), optional: z.boolean().optional() }),
  z.object({ fill: z.string(), value: z.string() }),
  z.object({ press: z.string(), key: z.string() }),
  z.object({ select: z.string(), value: z.string() }),
  z.object({ hover: z.string() }),
  z.object({ waitFor: z.string(), state: z.enum(['visible', 'hidden', 'attached']).optional() }),
  z.object({ expectVisible: z.string() }),
  z.object({ expectHidden: z.string() }),
  z.object({ expectText: z.string(), text: z.string() }),
  z.object({ expectUrl: z.string() }),
  z.object({ expectCount: z.string(), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.object({ wait: z.number().int().max(30_000) }),
  z.object({ submit: z.string(), stagingOnly: z.literal(true) }),
]);

export const flowSchema = z.object({
  name: z.string(),
  kind: z
    .enum(['navigation', 'search', 'form', 'cart', 'checkout', 'account', 'switcher', 'component', 'custom'])
    .default('custom'),
  /** Flows that submit data run on staging only (CLAUDE.md rule 12). */
  stagingOnly: z.boolean().default(false),
  viewport: z.enum(['mobile', 'tablet', 'desktop', 'all']).default('all'),
  steps: z.array(flowStepSchema).min(1),
});

const thresholdsSchema = z
  .object({
    visualPixelRatio: z.number().min(0).max(1).default(0.001),
    lcpPct: z.number().default(10),
    tbtMs: z.number().default(50),
    cls: z.number().default(0.02),
    score: z.number().default(3),
  })
  .default({ visualPixelRatio: 0.001, lcpPct: 10, tbtMs: 50, cls: 0.02, score: 3 });

export const siteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    platform: z.enum(['wordpress', 'shopify']),
    productionUrl: z.string().url(),
    stagingUrl: z.string().url().optional(),
    /** Fixture sites are local (wp-env, or a dev store copy) and exempt from the remote guard. */
    local: z.boolean().default(false),
    permission: z
      .object({
        writtenPermission: z.boolean().default(false),
        stages: z.array(z.enum(['staging', 'production'])).default([]),
        signOff: z.string().optional(),
        reverseEngineering: z.boolean().default(false),
      })
      .default({ writtenPermission: false, stages: [], reverseEngineering: false }),
    access: z
      .object({
        wordpress: z
          .object({
            sshStaging: z.string().optional().describe('SSH host alias or user@host (not secret)'),
            sshProduction: z.string().optional(),
            wpCliAliasStaging: z.string().default('@staging'),
            wpCliAliasProduction: z.string().default('@production'),
            restUser: envVarName.optional(),
            restAppPassword: envVarName.optional(),
            agentHmacSecret: envVarName.optional(),
            dbReadOnlyUser: envVarName.optional(),
            dbReadOnlyPassword: envVarName.optional(),
            wpEnv: z.boolean().default(false),
          })
          .optional(),
        shopify: z
          .object({
            store: z.string().regex(/\.myshopify\.com$/),
            themeAccessPassword: envVarName.optional(),
            adminToken: envVarName.optional(),
            storefrontPassword: envVarName.optional(),
          })
          .optional(),
        googleApiKey: envVarName.optional(),
        cloudflareToken: envVarName.optional(),
      })
      .default({}),
    sampleUrls: z.array(z.string()).default([]),
    sampleSize: z.number().int().min(1).max(100).default(12),
    flows: z.array(flowSchema).default([]),
    masks: z.array(z.string()).default([]),
    neverDelay: z.array(z.string()).default([]),
    keepThirdParties: z.array(z.string()).default([]),
    thresholds: thresholdsSchema,
    deployWindow: z
      .object({
        days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).default(['tue', 'wed', 'thu']),
        start: z.string().regex(/^\d{2}:\d{2}$/).default('06:00'),
        end: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
      })
      .default({ days: ['tue', 'wed', 'thu'], start: '06:00', end: '09:00' }),
    timezone: z.string().default('UTC'),
    campaigns: z
      .array(z.object({ name: z.string(), start: z.string(), end: z.string() }))
      .default([]),
    peakHours: z.array(z.string()).default([]),
    consent: z
      .object({ tool: z.string().optional(), regions: z.array(z.string()).default([]) })
      .default({ regions: [] }),
    competitors: z.array(z.string().url()).max(5).default([]),
    branding: z
      .object({
        name: z.string().optional(),
        logo: z.string().optional(),
        primary: z.string().default('#1f6feb'),
        accent: z.string().default('#0f9d58'),
      })
      .default({ primary: '#1f6feb', accent: '#0f9d58' }),
    reportLanguage: z.string().default('en'),
    approvers: z.array(z.string()).default([]),
    existingOptimizers: z.array(z.string()).default([]),
    hosting: z.object({ provider: z.string().optional(), cdn: z.string().optional(), dnsOwner: z.string().optional() }).default({}),
  })
  .strict();

export type SiteConfig = z.infer<typeof siteSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;

export function parseSite(text: string): SiteConfig {
  const doc = YAML.parse(text) ?? {};
  return siteSchema.parse(doc);
}

export function loadSite(root: string, site: string): SiteConfig {
  const p = paths.siteYaml(root, site);
  if (!existsSync(p)) throw new Error(`No site config at ${p}. Run \`speedpilot init ${site}\` first.`);
  return parseSite(readFileSync(p, 'utf8'));
}

/** Intake questions (SPEC.md 2.1), written into site.yaml as TODO comments. */
export const INTAKE_QUESTIONS = [
  'Written permission: which sites and stages may SpeedPilot test and change, and who signs off? (permission.*)',
  'Which pages and flows make the business money? Peak hours? Any sale or campaign coming up? (sampleUrls, flows, peakHours, campaigns)',
  'Which third-party tools must stay (chat, reviews, analytics, ads, heatmaps, email popups)? (keepThirdParties, neverDelay)',
  'Which consent tool, and are visitors in the EU or UK? (consent.*)',
  'Is there a staging site? What is the deploy window? Who approves changes? (stagingUrl, deployWindow, approvers)',
  'Hosting provider and plan, CDN (Cloudflare or other), and who controls DNS? (hosting.*)',
  'Which cache, image or asset optimization plugins or speed apps are already installed, and does the client want to keep them? (existingOptimizers)',
  'Tell the client test page loads come from one IP address and may show in chat dashboards or heatmaps; ask them to mark that IP as internal traffic in GA4 if they want (beacons are aborted anyway, CLAUDE.md rule 12).',
  'Which 3 to 5 competitors should the benchmark compare against? (competitors)',
];

export function initSiteYaml(name: string, platform: 'wordpress' | 'shopify' = 'wordpress', url = 'https://example.com/'): string {
  const upper = name.toUpperCase().replace(/-/g, '_');
  const base: Record<string, unknown> = {
    name,
    platform,
    productionUrl: url,
    permission: { writtenPermission: false, stages: [], reverseEngineering: false },
    access:
      platform === 'wordpress'
        ? {
            wordpress: {
              wpCliAliasStaging: '@staging',
              wpCliAliasProduction: '@production',
              restUser: `WP_${upper}_REST_USER`,
              restAppPassword: `WP_${upper}_REST_APP_PASSWORD`,
              agentHmacSecret: `WP_${upper}_AGENT_HMAC_SECRET`,
            },
            googleApiKey: 'GOOGLE_API_KEY',
          }
        : {
            shopify: {
              store: `${name}.myshopify.com`,
              themeAccessPassword: `SHOPIFY_${upper}_THEME_ACCESS_PASSWORD`,
              adminToken: `SHOPIFY_${upper}_ADMIN_TOKEN`,
              storefrontPassword: `SHOPIFY_${upper}_STOREFRONT_PASSWORD`,
            },
            googleApiKey: 'GOOGLE_API_KEY',
          },
    sampleUrls: [],
    sampleSize: 12,
    flows: [],
    masks: [],
    neverDelay: [],
    keepThirdParties: [],
    deployWindow: { days: ['tue', 'wed', 'thu'], start: '06:00', end: '09:00' },
    timezone: 'UTC',
    campaigns: [],
    peakHours: [],
    consent: { regions: [] },
    competitors: [],
    branding: { name, primary: '#1f6feb', accent: '#0f9d58' },
    reportLanguage: 'en',
    approvers: [],
    existingOptimizers: [],
    hosting: {},
  };
  const doc = new YAML.Document(base);
  doc.commentBefore =
    ` SpeedPilot site config for ${name}. Secrets never go here: access values are env var NAMES from .env.\n` +
    ' Intake questions (SPEC.md 2.1). Answer each, then delete its TODO line:\n' +
    INTAKE_QUESTIONS.map((q) => ` TODO: ${q}`).join('\n');
  // validate before writing
  siteSchema.parse(base);
  return doc.toString();
}

export function writeSiteYaml(root: string, name: string, platform: 'wordpress' | 'shopify', url?: string, force = false): string {
  const p = paths.siteYaml(root, name);
  if (existsSync(p) && !force) throw new Error(`${p} already exists (use --force to overwrite).`);
  ensureDir(dirname(p));
  writeFileSync(p, initSiteYaml(name, platform, url));
  return p;
}

/** Resolves an env var reference. Never log the result. */
export function secret(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name) return undefined;
  return env[name];
}
