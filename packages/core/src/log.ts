import pino, { type Logger, type DestinationStream } from 'pino';

/** Keys whose values are always redacted, at any depth (SPEC.md 12). */
export const SECRET_KEYS = [
  'password',
  'pass',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'key',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'appPassword',
  'app_password',
  'accessToken',
  'access_token',
  'hmac',
  'storefrontPassword',
];

const SECRET_NAME = /(PASS(WORD)?|SECRET|TOKEN|API_?KEY|_KEY|HMAC|COOKIE|AUTH)/i;

/** Values of environment variables that look like secrets, so they can be scrubbed from free text. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 6 && SECRET_NAME.test(k)) out.push(v);
  }
  return out.sort((a, b) => b.length - a.length);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization:\s*)(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1$2 [REDACTED]'],
  [/\b(shpat|shpca|shppa|shpss|shptka)_[A-Za-z0-9]{16,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/([?&](?:key|token|access_token|password|api_key)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(cookie:\s*)[^\n]+/gi, '$1[REDACTED]'],
  [/(wordpress_logged_in_[a-f0-9]+=)[^;\s]+/gi, '$1[REDACTED]'],
  [/((?:[A-Za-z0-9]{4} ){5}[A-Za-z0-9]{4})/g, '[REDACTED]'], // WordPress Application Password format
];

/** Removes secrets from a string: known env secret values and common token shapes. */
export function redactString(input: string, extra: string[] = secretValues()): string {
  let s = input;
  for (const v of extra) if (v) s = s.split(v).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Deep-redacts an object for logs, reports and saved evidence. */
export function redact<T>(value: T, extra: string[] = secretValues()): T {
  const keys = new Set(SECRET_KEYS.map((k) => k.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v, extra);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = keys.has(k.toLowerCase()) ? '[REDACTED]' : walk(val);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

export function createLogger(opts: { level?: string; name?: string; destination?: DestinationStream } = {}): Logger {
  const extra = secretValues();
  return pino(
    {
      name: opts.name ?? 'speedpilot',
      level: opts.level ?? process.env.SPEEDPILOT_LOG_LEVEL ?? 'info',
      redact: { paths: SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]), censor: '[REDACTED]' },
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((a) => (typeof a === 'string' ? redactString(a, extra) : redact(a, extra)));
          return method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
    },
    opts.destination ?? pino.destination(2),
  );
}

export const log = createLogger();
