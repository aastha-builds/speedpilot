import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@speedpilot/core': pkg('core'),
      '@speedpilot/xray': pkg('xray'),
      '@speedpilot/report': pkg('report'),
      '@speedpilot/shopify': pkg('shopify'),
      '@speedpilot/engine': pkg('engine'),
      '@speedpilot/cli': pkg('cli'),
      '@speedpilot/mcp-server': pkg('mcp-server'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
