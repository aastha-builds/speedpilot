import { createHmac } from 'node:crypto';

/** Client for the SpeedPilot WordPress agent's authenticated diagnostics (SPEC.md 8.1). */
export function agentToken(secret: string, scope: 'diag' | 'timing' | 'all' = 'all', ttlSeconds = 120, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + Math.min(ttlSeconds, 300);
  const mac = createHmac('sha256', secret).update(`${expires}.${scope}`).digest('hex');
  return `${expires}.${scope}.${mac}`;
}

export interface AgentHandle {
  handle: string;
  src: string | null;
  ver: string | false | null;
  deps: string[];
  owner: string;
  strategy?: string | null;
  footer?: boolean;
  inline?: { before?: string[]; after?: string[]; data?: string | null; data_bytes?: number };
  media?: string;
}

export interface AgentDiag {
  agent: string;
  template: string;
  scripts: AgentHandle[];
  styles: AgentHandle[];
  queries: Array<{ ms: number; sql: string; caller: { function: string; owner: string }; stack: string[] }>;
  http: Array<{ url: string; ms?: number; caller: string }>;
  /** Secondary WP_Query calls over 5 ms with their original arguments and caller (staging diagnostics only). */
  wp_queries?: Array<{ args: Record<string, string | number | boolean>; caller: string; ms: number; count: number }>;
  query_count?: number;
  query_total_ms?: number;
  flags: string[];
}

export function parseDiagComment(html: string): AgentDiag | undefined {
  const m = /<!-- speedpilot-diag:([A-Za-z0-9+/=]+) -->/.exec(html);
  if (!m) return undefined;
  try {
    return JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as AgentDiag;
  } catch {
    return undefined;
  }
}

export function parseServerTiming(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (header ?? '').split(',')) {
    const m = /^\s*([\w-]+)\s*;.*dur=([\d.]+)/.exec(part);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

export class AgentClient {
  constructor(
    readonly baseUrl: string,
    private readonly secret: string | undefined,
    private readonly basic?: { user: string; pass: string },
    private readonly f: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.secret) h['X-SpeedPilot-Token'] = agentToken(this.secret);
    else if (this.basic) h.Authorization = 'Basic ' + Buffer.from(`${this.basic.user}:${this.basic.pass}`).toString('base64');
    return h;
  }

  async rest<T>(route: string): Promise<T | undefined> {
    const u = new URL(`wp-json/speedpilot/v1/${route}`, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/');
    const r = await this.f(u, { headers: this.headers() }).catch(() => undefined);
    if (!r?.ok) return undefined;
    return (await r.json()) as T;
  }

  /** Renders a front-end URL as a token request and returns the handle map, slow queries, HTTP calls and Server-Timing. */
  async diag(url: string): Promise<{ diag?: AgentDiag; serverTiming: Record<string, number>; status: number } | undefined> {
    if (!this.secret) return undefined;
    const r = await this.f(url, { headers: this.headers() }).catch(() => undefined);
    if (!r) return undefined;
    const html = await r.text();
    return { diag: parseDiagComment(html), serverTiming: parseServerTiming(r.headers.get('server-timing')), status: r.status };
  }
}
