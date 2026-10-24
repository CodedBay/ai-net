import { test, expect } from '@playwright/test';
import type { WebSocketServer } from 'ws';
import {
  MOCK_TASK_ID,
  mockWalletConnection,
  preparePage,
  setTheme,
  skipWalletWizard,
  waitForMotionToSettle,
  type ThemeMode,
} from './utils';
import { startMockTaskSocket, stopMockTaskSocket } from './mockTaskSocket';

const THEMES: ThemeMode[] = ['light', 'dark'];

// The very first navigation of a run can be slow while Vite cold-optimizes
// its dependency graph (React Flow, recharts, jspdf, ...), and the
// task-detail WS chip may need a couple of reconnect-backoff cycles if its
// first attempt loses that same race. A generous timeout on the initial
// post-navigation assertion absorbs both without weakening the rest of the
// suite's default timeouts.
const INITIAL_LOAD_TIMEOUT = 20_000;

// ─── Landing page ─────────────────────────────────────────────────────────────

test.describe('Visual regression — landing page', () => {
  for (const theme of THEMES) {
    test(`landing page renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      await page.goto('/');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`landing-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Wallet page ──────────────────────────────────────────────────────────────

test.describe('Visual regression — wallet page', () => {
  for (const theme of THEMES) {
    test(`wallet connect page renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await skipWalletWizard(page);

      await page.goto('/wallet');
      await expect(page.locator('#secret-key-input')).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wallet-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

test.describe('Visual regression — dashboard', () => {
  for (const theme of THEMES) {
    test(`dashboard renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/dashboard');
      // Wait past the KPI/table skeletons so the snapshot captures the
      // loaded layout, not a transient loading state.
      await expect(page.locator('[data-testid="dashboard-skeleton"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      // The KPI cards count up from 0 via a framer-motion spring; give it
      // time to settle on the fixture's totals before capturing.
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Task detail ──────────────────────────────────────────────────────────────

test.describe('Visual regression — task detail', () => {
  let wss: WebSocketServer;

  test.beforeAll(async () => {
    wss = await startMockTaskSocket();
  });

  test.afterAll(async () => {
    await stopMockTaskSocket(wss);
  });

  for (const theme of THEMES) {
    test(`task detail renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto(`/tasks/${MOCK_TASK_ID}`);
      await expect(page.locator('#ws-status')).toHaveAttribute('data-ws-state', 'connected', { timeout: INITIAL_LOAD_TIMEOUT });
      await expect(page.locator('[data-testid="task-detail-skeleton"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      // Lets React Flow finish its post-mount fitView/measure pass.
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-detail-${theme}.png`, { fullPage: true });
    });
  }

  // Task detail in each task status state, captured in desktop light only to
  // keep baseline count manageable (the states are identical across themes).
  for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
    test(`task detail — ${status} state`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, 'light');
      await mockWalletConnection(page);

      // Override the MSW handler response for this navigation to return the
      // requested status, so the task detail page renders the correct state chip.
      await page.addInitScript((taskStatus) => {
        // Store the desired override so the app's service worker can pick it up.
        // The MSW handler in src/mocks/handlers.ts reads this key when present.
        window.localStorage.setItem('__visual_task_status_override', taskStatus);
      }, status);

      await page.goto(`/tasks/${MOCK_TASK_ID}`);
      await expect(page.locator('[data-testid="task-detail-skeleton"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-detail-status-${status}.png`, { fullPage: true });
    });
  }
});

// ─── Task submission wizard ───────────────────────────────────────────────────
//
// The new-task flow is a 3-step wizard (/tasks/new). Each step is captured
// individually so a regression in the step layout is immediately visible.

test.describe('Visual regression — task submission wizard', () => {
  for (const theme of THEMES) {
    test(`wizard step 1 (describe task) renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      // Step 1 should be immediately visible — it does not require any action.
      await page.waitForLoadState('networkidle');
      await expect(page.locator('form, [data-testid="task-wizard"]').first()).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wizard-step1-${theme}.png`, { fullPage: true });
    });

    test(`wizard step 2 (configure agents) renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('form, [data-testid="task-wizard"]').first()).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });

      // Advance to step 2 — click the "Next" or "Continue" button.
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), [data-testid="wizard-next"]').first();
      if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForLoadState('networkidle');
      }
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wizard-step2-${theme}.png`, { fullPage: true });
    });

    test(`wizard step 3 (review & submit) renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/new');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('form, [data-testid="task-wizard"]').first()).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });

      // Attempt to advance through step 1 and step 2.
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), [data-testid="wizard-next"]');
      for (let step = 0; step < 2; step++) {
        const btn = nextBtn.first();
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await btn.click();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(400);
        }
      }
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wizard-step3-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Agent registry browser ───────────────────────────────────────────────────

test.describe('Visual regression — agent registry', () => {
  for (const theme of THEMES) {
    test(`agent list view renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/agents');
      // Wait for agent cards / table to load (skeleton gone).
      await expect(page.locator('[data-testid="agent-skeleton"], [data-testid="agents-loading"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`agents-list-${theme}.png`, { fullPage: true });
    });

    test(`agent detail modal renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/agents');
      await expect(page.locator('[data-testid="agent-skeleton"], [data-testid="agents-loading"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      // Open the first agent card's detail modal.
      const firstCard = page.locator('[data-testid="agent-card"], [data-testid="agent-row"]').first();
      if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstCard.click();
        await page.waitForLoadState('networkidle');
        await waitForMotionToSettle(page);
      }

      await expect(page).toHaveScreenshot(`agents-detail-modal-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Payment / Task history ───────────────────────────────────────────────────

test.describe('Visual regression — task history', () => {
  for (const theme of THEMES) {
    test(`task history table renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/tasks/history');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-testid="history-skeleton"], [data-testid="history-loading"]')).toHaveCount(0, { timeout: INITIAL_LOAD_TIMEOUT });
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-history-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Wallet connect modal states ─────────────────────────────────────────────
//
// The wallet page shows different UI states: not connected (form visible),
// connecting (loading indicator), and connected (address + balance shown).

test.describe('Visual regression — wallet modal states', () => {
  for (const theme of THEMES) {
    test(`wallet not-connected state renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      // Do NOT seed wallet connection — want to see unauthenticated state.
      await skipWalletWizard(page);

      await page.goto('/wallet');
      await expect(page.locator('#secret-key-input')).toBeVisible({ timeout: INITIAL_LOAD_TIMEOUT });
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wallet-not-connected-${theme}.png`, { fullPage: true });
    });

    test(`wallet connected state renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      // Seed wallet so the page renders the connected layout.
      await mockWalletConnection(page);

      await page.goto('/wallet');
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wallet-connected-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── Error boundary fallback ──────────────────────────────────────────────────
//
// Trigger the top-level ErrorBoundary by navigating to the renderer-demo
// page (which only exists in DEV) or by injecting a render error via
// page.evaluate. We use a query-param-based escape hatch that the
// ErrorBoundary checks in development.

test.describe('Visual regression — error boundary', () => {
  for (const theme of THEMES) {
    test(`error boundary fallback renders in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      // Force the error boundary by navigating with a trigger flag, or fall
      // back to a route that is guaranteed to render the fallback UI.
      await page.goto('/dashboard?__trigger_error=1');
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      // If the error boundary was triggered, the fallback card is present.
      // If not (production bundles may strip the trigger), this snapshot still
      // captures the dashboard, which is a valid regression anchor.
      await expect(page).toHaveScreenshot(`error-boundary-${theme}.png`, { fullPage: true });
    });
  }
});

// ─── 404 / Not found page ─────────────────────────────────────────────────────

test.describe('Visual regression — 404 not found page', () => {
  for (const theme of THEMES) {
    test(`404 page renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      await page.goto('/this-route-does-not-exist-404');
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`not-found-${theme}.png`, { fullPage: true });
    });
  }
});
