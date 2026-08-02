import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'specs/features/**/*.feature',
  steps: 'tests/e2e/steps/**/*.ts',
});
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'on-first-retry' },
  webServer: [
    { command: 'RATE_LIMIT_MAX=5000 npm run dev -w @sky-bar/api', url: 'http://127.0.0.1:3001/api/v1/health', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'npm run dev -w @sky-bar/web', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
  projects: [
    { name: 'tablet-chromium', use: { ...devices['iPad Pro 11'], browserName: 'chromium', ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}) } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 15'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
