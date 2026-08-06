import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'specs/features/**/*.feature',
  steps: 'tests/e2e/steps/**/*.ts',
});
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const isCI = Boolean(process.env.CI);
const apiURL = `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
const webURL = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;

export default defineConfig({
  testDir,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: { baseURL: webURL, trace: 'on-first-retry' },
  webServer: isCI
    ? [{
        command: 'LOG_LEVEL=warn RATE_LIMIT_MAX=5000 npm run start:e2e:ci',
        url: `${webURL}/api/v1/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }]
    : [
        { command: 'RATE_LIMIT_MAX=5000 npm run dev -w @sky-bar/api', url: `${apiURL}/api/v1/health`, reuseExistingServer: true, timeout: 120_000 },
        { command: 'npm run dev -w @sky-bar/web', url: webURL, reuseExistingServer: true, timeout: 120_000 },
      ],
  projects: [
    { name: 'tablet-chromium', use: { ...devices['iPad Pro 11'], browserName: 'chromium', ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}) } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 15'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
