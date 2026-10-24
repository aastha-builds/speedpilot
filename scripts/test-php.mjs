#!/usr/bin/env node
// Runs the SpeedPilot agent PHP tests inside the local WordPress fixture on PHP 7.4, 8.3 and 8.4 (compose engine).
// On wp-env: npx wp-env run cli wp eval-file wp-content/mu-plugins/../../agent-tests/agent-tests.php (see packages/wp-agent/README.md).
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '-f', join(root, 'fixtures', 'wp', 'compose.yaml'), '--profile', 'php-matrix'];
spawnSync('docker', [...compose, 'up', '-d', 'cli74', 'cli84'], { stdio: 'inherit' });
let failed = 0;
for (const svc of ['cli74', 'cli', 'cli84']) {
  const run = (args) => spawnSync('docker', [...compose, 'exec', '-T', svc, ...args], { encoding: 'utf8' });
  const r = run(['wp', 'eval-file', '/var/www/agent-tests/agent-tests.php']);
  const k = run(['wp', '--exec=define("SPEEDPILOT_DISABLE", true);', 'eval-file', '/var/www/agent-tests/kill-switch-test.php']);
  const out = (r.stdout + r.stderr + k.stdout + k.stderr).trim();
  console.log(`== ${svc}\n${out}`);
  if (r.status !== 0 || k.status !== 0 || /not ok/.test(out) || /^1\.\.0$/m.test(out) || !/^ok 1 agent does nothing/m.test(out)) failed++;
}
process.exit(failed ? 1 : 0);
