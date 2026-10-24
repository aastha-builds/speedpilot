/**
 * Static analysis of PHP for WordPress (SPEC.md 15.3) with php-parser, on the active theme and active plugins only:
 * enqueue calls with handles, dependencies and conditions; callbacks on wp_head, wp_footer, init and
 * template_redirect; heavy patterns (posts_per_page => -1, orderby => rand, large meta_query, queries inside loops,
 * wp_remote_get on front-end hooks, session_start(), cookies for every visitor, no-cache headers, output buffering).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine } = require('php-parser') as { Engine: new (opts: unknown) => { parseCode(code: string, file: string): PhpNode } };

interface PhpNode {
  kind: string;
  loc?: { start: { line: number } };
  [k: string]: unknown;
}

export interface EnqueueCall {
  fn: string;
  handle: string | null;
  src: string | null;
  deps: string[];
  inFooter: boolean | null;
  strategy: string | null;
  file: string;
  line: number;
  conditional: boolean;
}

export interface HookCallback {
  hook: string;
  callback: string;
  priority: number | null;
  file: string;
  line: number;
}

export interface HeavyPattern {
  pattern: 'posts_per_page=-1' | 'orderby=rand' | 'meta_query' | 'query-in-loop' | 'remote-call-on-frontend' | 'session_start' | 'setcookie' | 'no-cache-header' | 'ob_start' | 'sleep';
  file: string;
  line: number;
  function: string | null;
}

export interface PhpFacts {
  owner: string;
  files: number;
  parseErrors: Array<{ file: string; error: string }>;
  enqueues: EnqueueCall[];
  hooks: HookCallback[];
  heavy: HeavyPattern[];
  functions: Array<{ name: string; file: string; line: number }>;
}

const ENQUEUE = new Set(['wp_enqueue_script', 'wp_register_script', 'wp_enqueue_style', 'wp_register_style', 'wp_add_inline_script', 'wp_localize_script', 'wp_script_add_data']);
const FRONT_HOOKS = new Set(['wp_head', 'wp_footer', 'init', 'template_redirect', 'wp', 'wp_enqueue_scripts', 'the_content', 'wp_body_open', 'get_header', 'send_headers', 'parse_request']);
const LOOPS = new Set(['for', 'foreach', 'while', 'do']);
const QUERY_FNS = new Set(['get_posts', 'get_post_meta', 'get_term_meta', 'get_user_meta', 'get_option', 'wc_get_product', 'get_the_terms', 'wp_get_post_terms']);

function str(n: PhpNode | undefined): string | null {
  if (!n) return null;
  if (n.kind === 'string') return String(n.value);
  if (n.kind === 'encapsed') return '(dynamic)';
  if (n.kind === 'bin' && n.type === '.') return [str(n.left as PhpNode), str(n.right as PhpNode)].map((x) => x ?? '…').join('');
  if (n.kind === 'call') return '(call)';
  return null;
}

function arrStrings(n: PhpNode | undefined): string[] {
  if (!n || n.kind !== 'array') return [];
  return ((n.items as PhpNode[]) ?? []).map((i) => str((i.value as PhpNode) ?? i)).filter((x): x is string => !!x);
}

function callName(n: PhpNode): string | null {
  const what = n.what as PhpNode | undefined;
  if (!what) return null;
  if (what.kind === 'name') return String(what.name).replace(/^\\/, '');
  return null;
}

function arrayEntries(n: PhpNode | undefined): Array<{ key: string | null; value: PhpNode }> {
  if (!n || n.kind !== 'array') return [];
  return ((n.items as PhpNode[]) ?? []).map((e) => ({ key: str(e.key as PhpNode | undefined), value: e.value as PhpNode }));
}

function walk(node: unknown, visit: (n: PhpNode, ancestors: PhpNode[]) => void, ancestors: PhpNode[] = []): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit, ancestors);
    return;
  }
  const n = node as PhpNode;
  if (typeof n.kind !== 'string') return;
  visit(n, ancestors);
  const next = [...ancestors, n];
  for (const [k, v] of Object.entries(n)) {
    if (k === 'loc' || k === 'kind' || k === 'leadingComments' || k === 'trailingComments') continue;
    if (v && typeof v === 'object') walk(v, visit, next);
  }
}

function phpFiles(dir: string, max = 400, maxBytes = 300_000): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number) => {
    if (depth > 6 || out.length >= max) return;
    for (const f of readdirSync(d)) {
      if (['vendor', 'node_modules', 'tests', 'test', 'languages', 'assets', 'build', 'dist', 'lib', 'packages'].includes(f) && depth > 0) continue;
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) rec(p, depth + 1);
      else if (f.endsWith('.php') && st.size <= maxBytes) out.push(p);
      if (out.length >= max) return;
    }
  };
  if (existsSync(dir)) rec(dir, 0);
  return out;
}

/** Analyzes one theme or plugin folder. `owner` is theme:<slug> or plugin:<slug>. */
export function analyzePhpDir(dir: string, owner: string, opts: { maxFiles?: number } = {}): PhpFacts {
  const parser = new Engine({ parser: { php8: true, suppressErrors: true, extractDoc: false }, ast: { withPositions: true } });
  const facts: PhpFacts = { owner, files: 0, parseErrors: [], enqueues: [], hooks: [], heavy: [], functions: [] };
  for (const file of phpFiles(dir, opts.maxFiles ?? 400)) {
    const rel = relative(dir, file);
    let ast: PhpNode;
    try {
      ast = parser.parseCode(readFileSync(file, 'utf8'), rel);
      facts.files++;
    } catch (e) {
      facts.parseErrors.push({ file: rel, error: (e as Error).message.slice(0, 200) });
      continue;
    }
    walk(ast, (n, anc) => {
      const line = n.loc?.start.line ?? 0;
      const fnName = (() => {
        for (let i = anc.length - 1; i >= 0; i--) {
          const a = anc[i]!;
          if ((a.kind === 'function' || a.kind === 'method') && a.name) return typeof a.name === 'string' ? a.name : String((a.name as PhpNode).name);
          if (a.kind === 'closure' || a.kind === 'arrowfunc') return '{closure}';
        }
        return null;
      })();
      if (n.kind === 'function' && n.name) facts.functions.push({ name: typeof n.name === 'string' ? n.name : String((n.name as PhpNode).name), file: rel, line });
      if (n.kind === 'call') {
        const name = callName(n);
        const args = (n.arguments as PhpNode[]) ?? [];
        if (!name) return;
        const conditional = anc.some((a) => a.kind === 'if' || a.kind === 'retif' || a.kind === 'switch');
        if (ENQUEUE.has(name)) {
          const last = args[4];
          let inFooter: boolean | null = null;
          let strategy: string | null = null;
          if (last?.kind === 'boolean') inFooter = Boolean(last.value);
          if (last?.kind === 'array') for (const e of arrayEntries(last)) {
            if (e.key === 'in_footer' && e.value.kind === 'boolean') inFooter = Boolean(e.value.value);
            if (e.key === 'strategy') strategy = str(e.value);
          }
          if (name === 'wp_script_add_data' && str(args[1]) === 'strategy') strategy = str(args[2]);
          facts.enqueues.push({ fn: name, handle: str(args[0]), src: str(args[1]), deps: arrStrings(args[2]), inFooter, strategy, file: rel, line, conditional });
        }
        if ((name === 'add_action' || name === 'add_filter') && args[0]) {
          const hook = str(args[0]) ?? '(dynamic)';
          const cb = args[1];
          const callback = cb?.kind === 'string' ? String(cb.value) : cb?.kind === 'closure' || cb?.kind === 'arrowfunc' ? '{closure}' : cb?.kind === 'array' ? arrStrings(cb).join('::') || '{method}' : '(dynamic)';
          const pr = args[2];
          facts.hooks.push({ hook, callback, priority: pr?.kind === 'number' ? Number(pr.value) : null, file: rel, line });
        }
        if (name === 'session_start') facts.heavy.push({ pattern: 'session_start', file: rel, line, function: fnName });
        if (name === 'setcookie' || name === 'setrawcookie') facts.heavy.push({ pattern: 'setcookie', file: rel, line, function: fnName });
        if (name === 'ob_start') facts.heavy.push({ pattern: 'ob_start', file: rel, line, function: fnName });
        if (name === 'sleep' || name === 'usleep') facts.heavy.push({ pattern: 'sleep', file: rel, line, function: fnName });
        if (name === 'header' && /no-cache|no-store/i.test(str(args[0]) ?? '')) facts.heavy.push({ pattern: 'no-cache-header', file: rel, line, function: fnName });
        if (/^wp_(safe_)?remote_(get|post|request|head)$/.test(name) || name === 'file_get_contents' && /^https?:/.test(str(args[0]) ?? '')) {
          const inHookedFront = facts.hooks.some((h) => FRONT_HOOKS.has(h.hook) && (h.callback === fnName || h.callback === '{closure}'));
          if (inHookedFront || !fnName) facts.heavy.push({ pattern: 'remote-call-on-frontend', file: rel, line, function: fnName });
        }
        if ((QUERY_FNS.has(name) || name === 'get_posts') && anc.some((a) => LOOPS.has(a.kind))) facts.heavy.push({ pattern: 'query-in-loop', file: rel, line, function: fnName });
      }
      if (n.kind === 'new' && (n.what as PhpNode)?.kind === 'name' && /WP_Query$/.test(String((n.what as PhpNode).name))) {
        const a = ((n.arguments as PhpNode[]) ?? [])[0];
        for (const e of arrayEntries(a)) {
          if ((e.key === 'posts_per_page' || e.key === 'numberposts') && e.value.kind === 'unary' && (e.value.what as PhpNode)?.value === '1') facts.heavy.push({ pattern: 'posts_per_page=-1', file: rel, line, function: fnName });
          if ((e.key === 'posts_per_page' || e.key === 'numberposts') && e.value.kind === 'number' && Number(e.value.value) === -1) facts.heavy.push({ pattern: 'posts_per_page=-1', file: rel, line, function: fnName });
          if (e.key === 'orderby' && str(e.value) === 'rand') facts.heavy.push({ pattern: 'orderby=rand', file: rel, line, function: fnName });
          if (e.key === 'meta_query') facts.heavy.push({ pattern: 'meta_query', file: rel, line, function: fnName });
        }
        if (anc.some((x) => LOOPS.has(x.kind))) facts.heavy.push({ pattern: 'query-in-loop', file: rel, line, function: fnName });
      }
    });
  }
  return facts;
}
