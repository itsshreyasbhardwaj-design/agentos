import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Tests run against `src`, not `dist`, so a failing build never hides behind a
 * stale artifact. The published packages resolve through `dist` as normal.
 */
export const alias = {
  '@agentos/core': pkg('core'),
  '@agentos/events': pkg('events'),
  '@agentos/policy': pkg('policy'),
  '@agentos/providers': pkg('providers'),
  '@agentos/tools': pkg('tools'),
  '@agentos/memory': pkg('memory'),
  '@agentos/store': pkg('store'),
  '@agentos/queue': pkg('queue'),
  '@agentos/runtime': pkg('runtime'),
  '@agentos/sdk': pkg('sdk'),
  '@agentos/mcp-server': pkg('mcp-server'),
  '@agentos/api': fileURLToPath(new URL('./apps/api/src/index.ts', import.meta.url)),
};

const base = {
  environment: 'node' as const,
  globals: false,
  restoreMocks: true,
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { ...base, name: 'unit', include: ['packages/**/src/**/*.test.ts'] },
      },
      {
        resolve: { alias },
        test: {
          ...base,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: { ...base, name: 'security', include: ['tests/security/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
