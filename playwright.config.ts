import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the dashboard in a real browser against a real API.
 *
 * `tests/e2e/global-setup.ts` starts both servers: an API seeded with demo
 * agents — which run on the deterministic local provider, so nothing is spent —
 * and the dashboard pointed at it. It owns both because the dashboard needs the
 * API's key in its environment before it starts, and the API only prints that
 * key once seeding finishes.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
