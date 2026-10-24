/**
 * Visual Regression Tests — All Key UI Surfaces
 *
 * Captures Playwright screenshots for every listed page / component in both
 * light and dark themes. A 1% pixel-diff threshold is enforced (set via
 * `playwright.visual.config.ts`).
 *
 * Surfaces covered:
 *  - Homepage / landing page
 *  - /agents  (agent list page)
 *  - /agents/:id  (agent detail — rendered via AgentDetailModal on the list page)
 *  - Task submission wizard — step 1, 2, 3  (/tasks/new)
 *  - Task progress tracker  (/tasks/:id)
 *  - Payment history table  (/wallet)
 *  - Admin dashboard  (/dashboard)
 *
 * Each surface is captured in both `light` and `dark` themes.
 *
 * Baseline update flow:
 *   cd frontend && npm run test:visual:update
 * See docs/visual-regression-testing.md for the full baseline update procedure.
 */

import { test, expect } from '@playwright/test';
import type { WebSocketServer } from 'ws';
import {
  MOCK_TASK_ID,
  MOCK_WALLET_PUBKEY,
  mockWalletConnection,
  preparePage,
  setTheme,
  skipWalletWizard,
  waitForMotionToSettle,
  type ThemeMode,
} from './utils';
import { startMockTaskSocket, stopMockTaskSocket } from './mockTaskSocket';

const THEMES: ThemeMode[] = ['light', 'dark'];

/**
 * First navigation can be slow while Vite cold-optimizes its dependency graph.
 * A generous initial timeout absorbs that without weakening later assertions.
 */
const INITIAL_LOAD_TIMEOUT = 20_000;

// ─── 1. Homepage / Landing Page ───────────────────────────────────────────────

test.describe('Visual regression — homepage / landing page', () => {
  for (const theme of THEMES) {
    test(`homepage renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      await page.goto('/');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`homepage-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 2. /agents — Agent List Page ─────────────────────────────────────────────

test.describe('Visual regression — /agents list page', () => {
  for (const theme of THEMES) {
    test(`agents list page renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/agents');
      // Wait for the skeleton to disappear (agents loaded or empty state shown)
      await expect(page.locator('[data-testid="agents-skeleton"]')).toHaveCount(0, {
        timeout: INITIAL_LOAD_TIMEOUT,
      });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`agents-list-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 3. /agents/:id — Agent Detail Page ───────────────────────────────────────

test.describe('Visual regression — /agents/:id agent detail page', () => {
  for (const theme of THEMES) {
    test(`agent detail modal renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      // Navigate to agents list and open the first agent's detail modal
      await page.goto('/agents');
      await expect(page.locator('[data-testid="agents-skeleton"]')).toHaveCount(0, {
        timeout: INITIAL_LOAD_TIMEOUT,
      });
      await page.waitForLoadState('networkidle');

      // Click the first agent card / row to open detail modal
      const firstAgent =
        page.locator('[data-testid="agent-card"]').first().or(
          page.locator('[data-testid="agent-row"]').first()
        );

      const agentCount = await firstAgent.count();
      if (agentCount > 0) {
        await firstAgent.click();
        // Wait for modal to appear
        await expect(
          page.locator('[role="dialog"], [data-testid="agent-detail-modal"]').first()
        ).toBeVisible({ timeout: 8_000 });
        await waitForMotionToSettle(page);
      }

      await expect(page).toHaveScreenshot(`agent-detail-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 4. Task Submission Wizard (3 steps) — /tasks/new ─────────────────────────

test.describe('Visual regression — task submission wizard', () => {
  for (const theme of THEMES) {
    test(`task wizard step 1 (describe task) renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      await page.waitForLoadState('networkidle');
      // Ensure the form / first step is visible
      await expect(
        page.locator('form, [data-testid="task-wizard"], [data-testid="task-form"]').first()
      ).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-wizard-step1-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });

    test(`task wizard step 2 (configure budget & agents) renders correctly in ${theme} mode`, async ({
      page,
    }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      await page.waitForLoadState('networkidle');

      // Fill in step 1 and advance to step 2
      const promptInput = page.locator(
        'textarea[name="prompt"], textarea[placeholder*="prompt" i], textarea[placeholder*="task" i], textarea'
      ).first();
      if ((await promptInput.count()) > 0) {
        await promptInput.fill('Generate a comprehensive market-entry report for solar energy in Southeast Asia');
        // Click next / continue button to advance to step 2
        const nextBtn = page
          .locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]')
          .first();
        if ((await nextBtn.count()) > 0) {
          await nextBtn.click();
          await page.waitForLoadState('networkidle');
          await waitForMotionToSettle(page);
        }
      }

      await expect(page).toHaveScreenshot(`task-wizard-step2-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });

    test(`task wizard step 3 (review & submit) renders correctly in ${theme} mode`, async ({
      page,
    }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      await page.waitForLoadState('networkidle');

      // Advance through step 1
      const promptInput = page.locator('textarea').first();
      if ((await promptInput.count()) > 0) {
        await promptInput.fill(
          'Analyze Stellar DEX liquidity trends and generate a summary report'
        );
        const step1Next = page
          .locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]')
          .first();
        if ((await step1Next.count()) > 0) {
          await step1Next.click();
          await page.waitForLoadState('networkidle');
          await waitForMotionToSettle(page, 600);
        }

        // Advance through step 2
        const budgetInput = page
          .locator('input[name="maxBudgetXLM"], input[type="number"]')
          .first();
        if ((await budgetInput.count()) > 0) {
          await budgetInput.fill('5');
        }
        const step2Next = page
          .locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Review")')
          .first();
        if ((await step2Next.count()) > 0) {
          await step2Next.click();
          await page.waitForLoadState('networkidle');
          await waitForMotionToSettle(page, 600);
        }
      }

      await expect(page).toHaveScreenshot(`task-wizard-step3-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 5. Task Progress Tracker — /tasks/:id ────────────────────────────────────

test.describe('Visual regression — task progress tracker', () => {
  let wss: WebSocketServer;

  test.beforeAll(async () => {
    wss = await startMockTaskSocket();
  });

  test.afterAll(async () => {
    await stopMockTaskSocket(wss);
  });

  for (const theme of THEMES) {
    test(`task progress tracker renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto(`/tasks/${MOCK_TASK_ID}`);
      await expect(page.locator('#ws-status')).toHaveAttribute('data-ws-state', 'connected', {
        timeout: INITIAL_LOAD_TIMEOUT,
      });
      await expect(page.locator('[data-testid="task-detail-skeleton"]')).toHaveCount(0, {
        timeout: INITIAL_LOAD_TIMEOUT,
      });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-progress-tracker-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 6. Payment History Table — /wallet ───────────────────────────────────────

test.describe('Visual regression — payment history table', () => {
  for (const theme of THEMES) {
    test(`payment history table renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      // The wallet connect form (not the wizard welcome step) is what we want
      await skipWalletWizard(page);

      // To render the payment table we need a connected wallet
      await mockWalletConnection(page);

      await page.goto('/wallet');
      await page.waitForLoadState('networkidle');
      await expect(
        page.locator(
          '#secret-key-input, [data-testid="wallet-page"], [data-testid="transaction-table"]'
        ).first()
      ).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`payment-history-table-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

// ─── 7. Admin Dashboard — /dashboard ─────────────────────────────────────────

test.describe('Visual regression — admin dashboard', () => {
  for (const theme of THEMES) {
    test(`admin dashboard renders correctly in ${theme} mode`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/dashboard');
      await expect(page.locator('[data-testid="dashboard-skeleton"]')).toHaveCount(0, {
        timeout: INITIAL_LOAD_TIMEOUT,
      });
      await page.waitForLoadState('networkidle');
      // Dashboard KPI cards count up via a framer-motion spring; let them settle
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`admin-dashboard-${theme}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
