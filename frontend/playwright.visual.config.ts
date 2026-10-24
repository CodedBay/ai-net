import { defineConfig, devices } from '@playwright/test';
import '@percy/playwright/dropin';

/**
 * Visual-regression config, kept separate from `playwright.config.ts`
 * (functional e2e) because screenshot baselines are pixel-tied to a single
 * browser engine, viewport, and OS. Mixing them into the functional suite's
 * multi-browser matrix would double the number of baselines to maintain for
 * no correctness benefit — a CSS regression shows up the same way in
 * Chromium as it does in Firefox.
 *
 * Baselines are generated/verified with the `mcr.microsoft.com/playwright`
 * Docker image pinned to the `@playwright/test` version in package.json, so
 * local updates match what CI renders. See `tests/visual/README.md`.
 */
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report-visual', open: 'never' }],
    ['list'],
    ['@percy/playwright/dropin/reporter', { gate: 'fail-on-changes' }],
  ],
  expect: {
    // Global threshold: 1% pixel-diff ceiling for all surfaces.
    // Anti-aliasing / sub-pixel jitter is typically < 0.2%; 1% gives enough
    // headroom without masking real layout regressions.
    // Each screenshot assertion also declares this threshold explicitly.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'visual-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
