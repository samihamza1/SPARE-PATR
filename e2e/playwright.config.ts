import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end: real PostgreSQL (TEST_* database), real API, real back office in Chromium.
 * The API runs as the app role; global-setup provisions a fresh tenant per run.
 */
const rootEnv = new URL('../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const API_PORT = 3199;
const WEB_PORT = 5199;
const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL ?? '';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI !== undefined ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'ar',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: {
      // Use a pre-installed Chromium when provided (e.g. sandboxed environments).
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE !== undefined && {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      }),
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @autoparts/api exec tsx src/main.ts',
      url: `http://127.0.0.1:${String(API_PORT)}/health/db`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        APP_DATABASE_URL: appDatabaseUrl,
        API_HOST: '127.0.0.1',
        API_PORT: String(API_PORT),
        ALLOWED_ORIGINS: WEB_ORIGIN,
        // Plain http on localhost.
        COOKIE_SECURE: 'false',
      },
    },
    {
      command: `pnpm --filter @autoparts/backoffice exec vite --port ${String(WEB_PORT)} --strictPort`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: `http://127.0.0.1:${String(API_PORT)}` },
    },
  ],
});
