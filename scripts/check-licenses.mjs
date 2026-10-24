#!/usr/bin/env node
// Licence check for every production dependency of the SpeedPilot packages (SPEC.md 11 and 15.1): only MIT,
// Apache-2.0, BSD or ISC. GPL, AGPL and LGPL always fail. Any other licence fails unless licenses.allow.json names
// the package with a reason a human approved. Usage: node scripts/check-licenses.mjs [--json] [--root <dir>]
import { readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BSD', 'MIT-0']);
const COPYLEFT = /\b(A?GPL|LGPL)\b/i;

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

export function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return 'UNKNOWN';
}

/** Evaluates an SPDX expression: OR needs one allowed branch, AND needs all. */
export function allowedExpression(expr) {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some((x) => allowedExpression(x));
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every((x) => allowedExpression(x));
  return ALLOWED.has(e.replace(/\+$/, '').replace(/ WITH .*/i, '').trim());
}

function depDir(fromDir, name) {
  const candidates = [join(fromDir, 'node_modules', name)];
  // pnpm virtual store: dependencies are siblings of the package folder
  const nm = name.startsWith('@') ? dirname(dirname(fromDir)) : dirname(fromDir);
  if (nm.endsWith('node_modules')) candidates.push(join(nm, name));
  candidates.push(join(root, 'node_modules', name));
  for (const c of candidates) if (existsSync(join(c, 'package.json'))) return realpathSync(c);
  return undefined;
}

export function collect() {
  const seen = new Map();
  const queue = [];
  for (const p of readdirSync(join(root, 'packages'))) {
    const dir = join(root, 'packages', p);
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg) continue;
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ from: dir, name: d, via: `@speedpilot/${p}` });
  }
  while (queue.length) {
    const { from, name, via } = queue.shift();
    const dir = depDir(from, name);
    if (!dir) continue;
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    if (pkg.name?.startsWith('@speedpilot/')) {
      seen.set(key, { name: pkg.name, version: pkg.version, license: 'workspace', via });
    } else seen.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), via });
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ from: dir, name: d, via: pkg.name });
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ from: dir, name: d, via: pkg.name });
  }
  return [...seen.values()];
}

export function check(deps, allow) {
  const failures = [];
  for (const d of deps) {
    if (d.license === 'workspace') continue;
    if (COPYLEFT.test(d.license) && !allowedExpression(d.license)) {
      failures.push({ ...d, reason: 'copyleft licence (never allowed)' });
      continue;
    }
    if (allowedExpression(d.license)) continue;
    const ex = allow[d.name];
    if (ex && (!ex.licence || ex.licence === d.license)) continue;
    failures.push({ ...d, reason: `licence ${d.license} is not MIT, Apache-2.0, BSD or ISC (add to licenses.allow.json only with a human-approved reason)` });
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allow = readJson(join(root, 'licenses.allow.json'))?.packages ?? {};
  const deps = collect();
  const failures = check(deps, allow);
  if (args.includes('--json')) console.log(JSON.stringify({ checked: deps.length, failures }, null, 2));
  else {
    console.log(`${deps.length} production dependencies checked.`);
    for (const f of failures) console.log(`FAIL ${f.name}@${f.version}: ${f.reason} (via ${f.via})`);
    for (const [name, ex] of Object.entries(allow)) if (deps.some((d) => d.name === name)) console.log(`NOTICE exception ${name} (${ex.licence}): ${ex.approvedBy ?? 'no approver recorded'}`);
  }
  process.exit(failures.length ? 1 : 0);
}
