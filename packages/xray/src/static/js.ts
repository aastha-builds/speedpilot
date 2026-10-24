/**
 * Static analysis of JavaScript (SPEC.md 15.3) with acorn: globals defined and read (scope-aware), jQuery plugin
 * registrations and uses, DOM selectors, event types, network endpoints, timers, document.write, ready/load waits,
 * and every pattern that makes a script's behaviour unknowable statically (eval, new Function, with, dynamic global
 * access, string timers). Those set `dynamic`, which forces an `unknown` verdict: never a false "safe".
 */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export interface JsFacts {
  parsed: boolean;
  parseError?: string;
  bytes: number;
  /** Globals the script creates (top-level var/function/class, window.X =, undeclared assignment). */
  definesGlobals: string[];
  /** Globals the script reads that it does not define itself. */
  readsGlobals: string[];
  /** Globals read at top level (run immediately when the script executes), not inside functions. */
  readsGlobalsImmediately: string[];
  /** jQuery plugins the script registers ($.fn.x = ..., jQuery.fn.extend({x})). */
  registersJqPlugins: string[];
  /** jQuery plugins or statics the script calls ($(..).x(), $.x()). */
  usesJqMembers: string[];
  /** Member paths read from well-known namespaces (wp.hooks, Shopify.theme ...). */
  namespaceReads: string[];
  selectors: string[];
  eventTypes: string[];
  endpoints: string[];
  timers: { setTimeout: number; setInterval: number; stringTimer: boolean; requestIdleCallback: number };
  documentWrite: boolean;
  syncXhr: boolean;
  waitsForDomReady: boolean;
  waitsForLoad: boolean;
  readsReadyState: boolean;
  usesCurrentScript: boolean;
  /** The script's behaviour depends on code SpeedPilot cannot see statically. */
  dynamic: boolean;
  dynamicReasons: string[];
  bundle?: 'webpack' | 'rollup' | 'vite' | 'parcel' | 'esbuild';
  isModule: boolean;
}

const BROWSER_GLOBALS = new Set(
  'window self globalThis document navigator location history screen console performance localStorage sessionStorage indexedDB caches crypto fetch XMLHttpRequest WebSocket EventSource Request Response Headers FormData URL URLSearchParams Blob File FileReader Image Audio Option Event CustomEvent EventTarget KeyboardEvent MouseEvent PointerEvent TouchEvent FocusEvent InputEvent ErrorEvent PromiseRejectionEvent MutationObserver IntersectionObserver ResizeObserver PerformanceObserver requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone atob btoa getComputedStyle matchMedia scrollTo scrollBy scroll alert confirm prompt open close print postMessage addEventListener removeEventListener dispatchEvent innerWidth innerHeight outerWidth outerHeight scrollX scrollY pageXOffset pageYOffset devicePixelRatio parent top frames opener name origin isSecureContext HTMLElement Element Node NodeList HTMLCollection Document DocumentFragment Text Comment ShadowRoot HTMLCanvasElement HTMLImageElement HTMLScriptElement HTMLInputElement HTMLFormElement HTMLAnchorElement SVGElement CSS CSSStyleSheet DOMParser XMLSerializer TextEncoder TextDecoder AbortController AbortSignal Worker SharedWorker ServiceWorker BroadcastChannel MessageChannel Notification Intl JSON Math Date RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError Promise Symbol Map Set WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array BigInt Object Function Array String Number Boolean NaN Infinity undefined isNaN isFinite parseInt parseFloat encodeURI encodeURIComponent decodeURI decodeURIComponent escape unescape eval arguments globalThis Atomics WebAssembly customElements visualViewport speechSynthesis gtag dataLayer'
    .split(/\s+/),
);

const NAMESPACES = ['wp', 'Shopify', 'theme', 'woocommerce_params', 'wc_add_to_cart_params', 'elementorFrontend', 'elementorFrontendConfig', 'ShopifyAnalytics', 'jQuery', '$'];

interface Scope {
  names: Set<string>;
  isFunction: boolean;
  parent?: Scope;
}

function resolveScope(scope: Scope, name: string, root: Scope): Scope {
  for (let s: Scope | undefined = scope; s; s = s.parent) if (s.names.has(name)) return s;
  return root;
}

/** Expressions that evaluate to the global object: window, self, globalThis, top-level `this`, or a branch of `a || b` / `c ? a : b`. */
function globalish(n: acorn.Node | null | undefined, allowThis: boolean): boolean {
  if (!n) return false;
  if (n.type === 'Identifier') return GLOBAL_OBJECTS.has((n as acorn.Identifier).name);
  if (n.type === 'ThisExpression') return allowThis;
  if (n.type === 'LogicalExpression') return globalish((n as acorn.LogicalExpression).left, allowThis) || globalish((n as acorn.LogicalExpression).right, allowThis);
  if (n.type === 'ConditionalExpression') return globalish((n as acorn.ConditionalExpression).consequent, allowThis) || globalish((n as acorn.ConditionalExpression).alternate, allowThis);
  if (n.type === 'AssignmentExpression') return globalish((n as acorn.AssignmentExpression).right, allowThis);
  return false;
}

function declared(scope: Scope, name: string): boolean {
  for (let s: Scope | undefined = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return false;
}

function patternNames(p: acorn.Pattern | null | undefined, out: string[] = []): string[] {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier':
      out.push(p.name);
      break;
    case 'ObjectPattern':
      for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : (prop.value as acorn.Pattern), out);
      break;
    case 'ArrayPattern':
      for (const e of p.elements) patternNames(e as acorn.Pattern, out);
      break;
    case 'RestElement':
      patternNames(p.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      break;
    default:
      break;
  }
  return out;
}

function memberPath(n: acorn.Node): string | null {
  if (n.type === 'Identifier') return (n as acorn.Identifier).name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression') {
    const m = n as acorn.MemberExpression;
    const obj = memberPath(m.object);
    if (!obj) return null;
    if (!m.computed && m.property.type === 'Identifier') return `${obj}.${m.property.name}`;
    if (m.computed && m.property.type === 'Literal' && typeof (m.property as acorn.Literal).value === 'string') return `${obj}.${(m.property as acorn.Literal).value}`;
    return `${obj}.[computed]`;
  }
  if (n.type === 'CallExpression') {
    const c = n as acorn.CallExpression;
    const callee = memberPath(c.callee);
    return callee ? `${callee}()` : null;
  }
  return null;
}

const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);

function parse(src: string): { ast: acorn.Program; isModule: boolean } {
  const opts: acorn.Options = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: false };
  try {
    return { ast: acorn.parse(src, { ...opts, sourceType: 'script' }), isModule: false };
  } catch {
    return { ast: acorn.parse(src, { ...opts, sourceType: 'module' }), isModule: true };
  }
}

export function analyzeJs(src: string): JsFacts {
  const facts: JsFacts = {
    parsed: false,
    bytes: Buffer.byteLength(src),
    definesGlobals: [],
    readsGlobals: [],
    readsGlobalsImmediately: [],
    registersJqPlugins: [],
    usesJqMembers: [],
    namespaceReads: [],
    selectors: [],
    eventTypes: [],
    endpoints: [],
    timers: { setTimeout: 0, setInterval: 0, stringTimer: false, requestIdleCallback: 0 },
    documentWrite: false,
    syncXhr: false,
    waitsForDomReady: false,
    waitsForLoad: false,
    readsReadyState: false,
    usesCurrentScript: false,
    dynamic: false,
    dynamicReasons: [],
    isModule: false,
  };
  const dyn = (reason: string) => {
    facts.dynamic = true;
    if (!facts.dynamicReasons.includes(reason)) facts.dynamicReasons.push(reason);
  };
  if (/__webpack_require__|webpackChunk|webpackJsonp/.test(src)) facts.bundle = 'webpack';
  else if (/parcelRequire/.test(src)) facts.bundle = 'parcel';
  else if (/\/\*\s*vite|import\.meta\.env|__vitePreload/.test(src)) facts.bundle = 'vite';
  let ast: acorn.Program;
  try {
    const p = parse(src);
    ast = p.ast;
    facts.isModule = p.isModule;
    facts.parsed = true;
  } catch (e) {
    facts.parseError = (e as Error).message;
    dyn('unparseable');
    return facts;
  }

  const defines = new Set<string>();
  const reads = new Set<string>();
  const readsTop = new Set<string>();
  const jqReg = new Set<string>();
  const jqUse = new Set<string>();
  const ns = new Set<string>();
  const selectors = new Set<string>();
  const events = new Set<string>();
  const endpoints = new Set<string>();

  // Pass 1: hoisted declarations per function scope (var, function) and block declarations.
  const root: Scope = { names: new Set(), isFunction: true };
  const scopeOf = new Map<acorn.Node, Scope>();
  const topLevelNames = new Set<string>();

  const declareIn = (scope: Scope, names: string[]) => names.forEach((n) => scope.names.add(n));
  // Aliases of the global object, bound to the scope that declares them: `var w = window`, `w = self`, and IIFE
  // parameters bound to window, `(function (root) {})(window)` or UMD `(function (e, t) {})(this, ...)`.
  const aliasScopes = new Map<string, Set<Scope>>();
  const addAlias = (name: string, scope: Scope) => {
    if (GLOBAL_OBJECTS.has(name)) return;
    if (!aliasScopes.has(name)) aliasScopes.set(name, new Set());
    aliasScopes.get(name)!.add(scope);
  };
  const iifeAliasParams = new Map<acorn.Node, string[]>();
  const pendingAssign: Array<{ name: string; scope: Scope }> = [];
  walk.simple(ast, {
    CallExpression(n) {
      const c = n as acorn.CallExpression;
      let callee = c.callee as acorn.Node;
      let args = c.arguments as acorn.Node[];
      if (callee.type === 'MemberExpression' && (callee as acorn.MemberExpression).property.type === 'Identifier' && ['call', 'apply'].includes(((callee as acorn.MemberExpression).property as acorn.Identifier).name)) {
        callee = (callee as acorn.MemberExpression).object;
        args = args.slice(1);
      }
      if (callee.type !== 'FunctionExpression' && callee.type !== 'ArrowFunctionExpression') return;
      const names = (callee as acorn.FunctionExpression).params.map((p, i) => (p.type === 'Identifier' && globalish(args[i], true) ? p.name : '')).filter(Boolean);
      if (names.length) iifeAliasParams.set(callee, names);
    },
  });
  const nearestFunction = (s: Scope) => {
    let x: Scope | undefined = s;
    while (x && !x.isFunction) x = x.parent;
    return x ?? root;
  };

  function build(node: acorn.Node, scope: Scope) {
    scopeOf.set(node, scope);
    switch (node.type) {
      case 'FunctionDeclaration': {
        const f = node as acorn.FunctionDeclaration;
        if (f.id) declareIn(scope === root || !scope.isFunction ? nearestFunction(scope) : scope, [f.id.name]);
        if (f.id && nearestFunction(scope) === root && scope === root) topLevelNames.add(f.id.name);
        const fs: Scope = { names: new Set(f.params.flatMap((p) => patternNames(p))), isFunction: true, parent: scope };
        fs.names.add('arguments');
        scopeOf.set(f.body, fs);
        for (const st of f.body.body) build(st, fs);
        return;
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const f = node as acorn.FunctionExpression | acorn.ArrowFunctionExpression;
        const fs: Scope = { names: new Set(f.params.flatMap((p) => patternNames(p))), isFunction: true, parent: scope };
        for (const a of iifeAliasParams.get(node) ?? []) addAlias(a, fs);
        if (node.type === 'FunctionExpression') {
          fs.names.add('arguments');
          if ((f as acorn.FunctionExpression).id) fs.names.add((f as acorn.FunctionExpression).id!.name);
        }
        if (f.body.type === 'BlockStatement') {
          scopeOf.set(f.body, fs);
          for (const st of f.body.body) build(st, fs);
        } else build(f.body, fs);
        f.params.forEach((p) => build(p, fs));
        return;
      }
      case 'ClassDeclaration': {
        const c = node as acorn.ClassDeclaration;
        if (c.id) {
          scope.names.add(c.id.name);
          if (scope === root) topLevelNames.add(c.id.name);
        }
        break;
      }
      case 'VariableDeclaration': {
        const v = node as acorn.VariableDeclaration;
        const target = v.kind === 'var' ? nearestFunction(scope) : scope;
        for (const d of v.declarations) {
          const names = patternNames(d.id);
          declareIn(target, names);
          if (d.id.type === 'Identifier' && globalish(d.init, false)) addAlias(d.id.name, target);
          if (target === root && (v.kind === 'var' || scope === root)) names.forEach((n) => topLevelNames.add(n));
        }
        break;
      }
      case 'BlockStatement': {
        const bs: Scope = { names: new Set(), isFunction: false, parent: scope };
        scopeOf.set(node, bs);
        for (const st of (node as acorn.BlockStatement).body) build(st, bs);
        return;
      }
      case 'CatchClause': {
        const c = node as acorn.CatchClause;
        const cs: Scope = { names: new Set(patternNames(c.param ?? undefined)), isFunction: false, parent: scope };
        scopeOf.set(c.body, cs);
        for (const st of c.body.body) build(st, cs);
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const fs: Scope = { names: new Set(), isFunction: false, parent: scope };
        scopeOf.set(node, fs);
        for (const key of ['init', 'left', 'test', 'update', 'right', 'body'] as const) {
          const child = (node as unknown as Record<string, acorn.Node | null>)[key];
          if (child) build(child, fs);
        }
        return;
      }
      case 'WithStatement':
        dyn('with statement');
        break;
      case 'AssignmentExpression': {
        const a = node as acorn.AssignmentExpression;
        if (a.left.type === 'Identifier' && globalish(a.right, false)) pendingAssign.push({ name: a.left.name, scope });
        break;
      }
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) for (const c of child) if (c && typeof (c as acorn.Node).type === 'string') build(c as acorn.Node, scope);
      if (child && typeof child === 'object' && typeof (child as acorn.Node).type === 'string') build(child as acorn.Node, scope);
    }
  }
  for (const st of ast.body) build(st, root);
  for (const n of topLevelNames) defines.add(n);
  for (const p of pendingAssign) addAlias(p.name, resolveScope(p.scope, p.name, root));
  const isAlias = (name: string, scope: Scope) => !!aliasScopes.get(name)?.has(resolveScope(scope, name, root));

  // Pass 2: references, with ancestors to know whether an Identifier is a reference and whether it runs at top level.
  const isFunctionNode = (n: acorn.Node) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const anc = ancestors as acorn.Node[];
    const parent = anc[anc.length - 2];
    // code inside a function runs later, except immediately-invoked function expressions
    const inFunction = anc.slice(0, -1).some((a, i) => {
      if (!isFunctionNode(a)) return false;
      const p = anc[i - 1];
      if (p && (p.type === 'CallExpression' || p.type === 'NewExpression') && (p as acorn.CallExpression).callee === a) return false;
      if (p && p.type === 'MemberExpression' && (p as acorn.MemberExpression).object === a) {
        const pp = anc[i - 2];
        const prop = (p as acorn.MemberExpression).property;
        if (pp?.type === 'CallExpression' && prop.type === 'Identifier' && (prop.name === 'call' || prop.name === 'apply')) return false;
      }
      if (p && p.type === 'UnaryExpression' && anc[i - 2]?.type === 'CallExpression') return false;
      return true;
    });
    let scope: Scope = root;
    for (let i = anc.length - 1; i >= 0; i--) {
      const s = scopeOf.get(anc[i]!);
      if (s) {
        scope = s;
        break;
      }
    }

    if (node.type === 'Identifier') {
      const id = node as acorn.Identifier;
      if (!parent) return;
      // not references
      if (parent.type === 'MemberExpression' && (parent as acorn.MemberExpression).property === node && !(parent as acorn.MemberExpression).computed) return;
      if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && (parent as acorn.Property).key === node && !(parent as acorn.Property).computed && !(parent as acorn.Property).shorthand) return;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && (parent as acorn.FunctionDeclaration).id === node) return;
      if (parent.type === 'VariableDeclarator' && (parent as acorn.VariableDeclarator).id === node) return;
      if (isFunctionNode(parent) && (parent as acorn.FunctionExpression).params.includes(node as acorn.Pattern)) return;
      if (parent.type === 'CatchClause') return;
      if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return;
      const name = id.name;
      if (declared(scope, name)) return;
      // undeclared assignment creates a global (sloppy mode)
      if (parent.type === 'AssignmentExpression' && (parent as acorn.AssignmentExpression).left === node) {
        defines.add(name);
        return;
      }
      if (name === 'eval' && parent.type === 'CallExpression' && (parent as acorn.CallExpression).callee === node) dyn('eval');
      if (GLOBAL_OBJECTS.has(name) || BROWSER_GLOBALS.has(name)) return;
      reads.add(name);
      if (!inFunction) readsTop.add(name);
      return;
    }

    if (node.type === 'MemberExpression') {
      const m = node as acorn.MemberExpression;
      const objName = m.object.type === 'Identifier' ? (m.object as acorn.Identifier).name : null;
      // window[expr] / self[expr] dynamic global access
      if (objName && ((GLOBAL_OBJECTS.has(objName) && !declared(scope, objName)) || isAlias(objName, scope))) {
        if (m.computed && !(m.property.type === 'Literal' && typeof (m.property as acorn.Literal).value === 'string')) dyn('dynamic global access (window[expr])');
        const prop = !m.computed && m.property.type === 'Identifier' ? m.property.name : m.property.type === 'Literal' ? String((m.property as acorn.Literal).value) : null;
        if (prop && !BROWSER_GLOBALS.has(prop) && !GLOBAL_OBJECTS.has(prop)) {
          const isWrite = parent?.type === 'AssignmentExpression' && (parent as acorn.AssignmentExpression).left === node;
          if (isWrite) defines.add(prop);
          else {
            reads.add(prop);
            if (!inFunction) readsTop.add(prop);
          }
        }
      }
      const path = memberPath(m);
      if (path) {
        for (const n of NAMESPACES) if (path === n || path.startsWith(`${n}.`)) ns.add(path.split('.').slice(0, 3).join('.'));
        const fn = /^(\$|jQuery)\.fn\.([A-Za-z_$][\w$]*)$/.exec(path);
        if (fn && parent?.type === 'AssignmentExpression' && (parent as acorn.AssignmentExpression).left === node) jqReg.add(fn[2]!);
        if (path === 'document.write' || path === 'document.writeln') facts.documentWrite = true;
        if (path === 'document.readyState') facts.readsReadyState = true;
        if (path === 'document.currentScript') facts.usesCurrentScript = true;
      }
      return;
    }

    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const c = node as acorn.CallExpression;
      const callee = memberPath(c.callee) ?? '';
      const arg0 = c.arguments[0];
      const str0 = arg0 && arg0.type === 'Literal' && typeof (arg0 as acorn.Literal).value === 'string' ? ((arg0 as acorn.Literal).value as string) : arg0 && arg0.type === 'TemplateLiteral' && (arg0 as acorn.TemplateLiteral).expressions.length === 0 ? (arg0 as acorn.TemplateLiteral).quasis[0]!.value.cooked ?? '' : null;
      if (node.type === 'NewExpression' && callee === 'Function') dyn('new Function');
      if (/(^|\.)(setTimeout|setInterval)$/.test(callee)) {
        if (callee.endsWith('setInterval')) facts.timers.setInterval++;
        else facts.timers.setTimeout++;
        if (str0 !== null) {
          facts.timers.stringTimer = true;
          dyn('string timer (eval)');
        }
      }
      if (/(^|\.)requestIdleCallback$/.test(callee)) facts.timers.requestIdleCallback++;
      if (/(^|\.)(querySelector|querySelectorAll|closest|matches)$/.test(callee) && str0) selectors.add(str0);
      if (/(^|\.)getElementById$/.test(callee) && str0) selectors.add(`#${str0}`);
      if (/(^|\.)getElementsByClassName$/.test(callee) && str0) selectors.add(`.${str0.split(' ')[0]}`);
      if ((callee === '$' || callee === 'jQuery') && str0 && !/^\s*</.test(str0)) selectors.add(str0);
      if (/(^|\.)addEventListener$/.test(callee) && str0) {
        events.add(str0);
        if (str0 === 'DOMContentLoaded') facts.waitsForDomReady = true;
        if (str0 === 'load' && /^(window|self)\.addEventListener$|^addEventListener$/.test(callee)) facts.waitsForLoad = true;
      }
      if (/\.(on|one|bind|delegate)$/.test(callee) && str0) {
        str0.split(/\s+/).forEach((e) => events.add(e.split('.')[0]!));
        if (/^(\$|jQuery)\(window\)\./.test(callee) && /\bload\b/.test(str0)) facts.waitsForLoad = true;
        if (/^(\$|jQuery)\(document\)\./.test(callee) && /\bready\b/.test(str0)) facts.waitsForDomReady = true;
      }
      if (/^(\$|jQuery)\(document\)\.ready\(\)$/.test(callee + '()') || /\.ready$/.test(callee)) facts.waitsForDomReady = true;
      if ((callee === '$' || callee === 'jQuery') && arg0 && isFunctionNode(arg0)) facts.waitsForDomReady = true;
      if (/^(window\.)?fetch$/.test(callee) && str0) endpoints.add(str0);
      if (/\.open$/.test(callee) && c.arguments.length >= 2) {
        const u = c.arguments[1];
        if (u?.type === 'Literal') endpoints.add(String((u as acorn.Literal).value));
        const asyncArg = c.arguments[2];
        if (asyncArg?.type === 'Literal' && (asyncArg as acorn.Literal).value === false) facts.syncXhr = true;
      }
      if (/(^|\.)(ajax|get|post|getJSON)$/.test(callee) && /^(\$|jQuery)\./.test(callee) && str0) endpoints.add(str0);
      // jQuery member uses: $(..).plugin() and $.plugin()
      const jq = /^(\$|jQuery)(\(\))?\.([A-Za-z_$][\w$]*)$/.exec(callee) ?? /\)\.([A-Za-z_$][\w$]*)$/.exec(callee);
      if (jq) {
        const name = jq[3] ?? jq[1]!;
        if (!['fn', 'ready', 'on', 'off', 'one', 'each', 'extend', 'ajax', 'get', 'post', 'when', 'Deferred', 'proxy', 'noConflict', 'trigger', 'find', 'addClass', 'removeClass', 'toggleClass', 'attr', 'prop', 'css', 'html', 'text', 'val', 'data', 'append', 'prepend', 'hide', 'show', 'parent', 'parents', 'closest', 'children', 'click', 'is', 'hasClass', 'remove', 'map', 'filter', 'first', 'last', 'eq', 'length', 'height', 'width', 'offset', 'scrollTop', 'animate', 'fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'stop', 'focus', 'blur', 'submit', 'serialize', 'clone', 'after', 'before', 'replaceWith', 'wrap', 'empty', 'not', 'next', 'prev', 'siblings', 'index', 'add', 'end', 'removeAttr', 'appendTo', 'insertAfter', 'insertBefore', 'outerHeight', 'outerWidth', 'position', 'toggle', 'getJSON', 'param', 'trim', 'isArray', 'isFunction', 'type', 'inArray', 'grep', 'merge', 'contains', 'parseJSON', 'Event', 'holdReady', 'cssHooks', 'easing', 'expr', 'support', 'browser', 'ajaxSetup', 'ajaxPrefilter', 'getScript', 'load', 'hover', 'change', 'keyup', 'keydown', 'scroll', 'resize', 'unbind', 'live', 'die', 'undelegate', 'triggerHandler', 'promise', 'done', 'fail', 'always', 'then'].includes(name)) jqUse.add(name);
      }
      // jQuery.fn.extend({ a: fn, b: fn })
      if (/^(\$|jQuery)\.fn\.extend$/.test(callee) && arg0?.type === 'ObjectExpression') {
        for (const p of (arg0 as acorn.ObjectExpression).properties) if (p.type === 'Property' && p.key.type === 'Identifier') jqReg.add(p.key.name);
      }
      return;
    }

    if (node.type === 'ImportExpression') dyn('dynamic import');
  });

  facts.definesGlobals = [...defines].sort();
  facts.readsGlobals = [...reads].filter((r) => !defines.has(r)).sort();
  facts.readsGlobalsImmediately = [...readsTop].filter((r) => !defines.has(r)).sort();
  facts.registersJqPlugins = [...jqReg].sort();
  facts.usesJqMembers = [...jqUse].filter((u) => !jqReg.has(u)).sort();
  facts.namespaceReads = [...ns].sort();
  facts.selectors = [...selectors].slice(0, 200);
  facts.eventTypes = [...events].sort();
  facts.endpoints = [...endpoints].slice(0, 50);
  return facts;
}

/** Inline event handler attributes (onclick="foo()") reference globals at interaction time. */
export function analyzeInlineHandler(code: string): { reads: string[]; dynamic: boolean } {
  const f = analyzeJs(`(function(event){${code}\n})`);
  return { reads: f.readsGlobals, dynamic: f.dynamic };
}
