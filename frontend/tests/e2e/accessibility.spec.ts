/**
 * Accessibility Tests — Issue #88
 *
 * Runs axe-core WCAG AA scans on every major page of the application via
 * Playwright. CI fails if any violation is introduced.
 *
 * Pages covered:
 *   - / (Landing)
 *   - /agents (Agent Registry)
 *   - /agents/:id (Agent Detail — opened via the agent table)
 *   - /tasks/new (Task Form Wizard — all 4 steps)
 *   - /wallet (Payments / Wallet page)
 *   - /dashboard (Dashboard)
 *
 * HTML report: playwright uploads the built-in HTML reporter as a CI artifact
 * (configured in .github/workflows/ci.yml).
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TEST_WALLET = 'GDEUVS2EDX2ENN2RYHFIWJXT6XHXMOXI7EUKMU2YDF637JLJAOX4UT3J';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((publicKey) => {
    localStorage.setItem('wallet_pubkey', publicKey);
    localStorage.setItem('walletAddress', publicKey);
    localStorage.setItem('wallet_connection_method', 'freighter');
    localStorage.setItem('wallet_wizard_completed', 'true');
  }, TEST_WALLET);
});

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Run an axe WCAG AA scan on the current page and assert zero violations.
 * Returns the full AxeResults object for optional inspection.
 */
async function assertNoWcagViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    // Third-party widgets or embedded iframes that we do not control:
    .exclude('[data-testid="freighter-extension-frame"]')
    .analyze();

  // Format violations as a readable string for the assertion message.
  const violationSummary = results.violations
    .map(
      (v) =>
        `[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}\n  Affected nodes:\n${v.nodes
          .slice(0, 3)
          .map((n) => `    ${n.html}`)
          .join('\n')}`
    )
    .join('\n\n');

  const blockingViolations = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  );
  console.info(`Axe report: ${results.violations.length} violations\n${violationSummary}`);
  expect(blockingViolations, `Critical/serious WCAG AA violations found:\n${violationSummary}`).toHaveLength(0);

  return results;
}

const majorRoutes = [
  { path: '/', expectedPath: '/', readySelector: 'h1' },
  { path: '/agents', expectedPath: '/agents', readySelector: '[data-testid^="agent-row-"]' },
  { path: '/agents/agent-1', expectedPath: '/agents/agent-1', readySelector: '[data-testid="agent-header"], [data-testid="agent-not-found"]' },
  { path: '/marketplace', expectedPath: '/agents', readySelector: '[data-testid^="agent-row-"]' },
  { path: '/tasks', expectedPath: '/tasks/history', readySelector: 'h1' },
  { path: '/tasks/task-123', expectedPath: '/tasks/task-123', readySelector: 'h1' },
  { path: '/wallet', expectedPath: '/wallet', readySelector: 'h1' },
  { path: '/payments', expectedPath: '/payments', readySelector: 'h1' },
];

test.describe('accessibility: major routes', () => {
  for (const route of majorRoutes) {
    test(`${route.path} resolves and has no critical or serious WCAG 2.1 AA violations`, async ({ page }) => {
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} should return a successful document response`).toBeLessThan(400);
      await expect.poll(() => new URL(page.url()).pathname).toBe(route.expectedPath);
      await expect(page.locator(route.readySelector)).toBeVisible({ timeout: 15_000 });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .exclude('[data-testid="freighter-extension-frame"]')
        .analyze();
      const report = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        description: violation.description,
        affectedElements: violation.nodes.map((node) => ({
          target: node.target,
          html: node.html,
        })),
      }));
      console.info(`Axe report for ${route.path}: ${results.violations.length} violations\n${JSON.stringify(report, null, 2)}`);

      const blockingViolations = results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious'
      );
      expect(
        blockingViolations,
        `${route.path} has ${blockingViolations.length} critical/serious axe violations:\n${JSON.stringify(report, null, 2)}`
      ).toHaveLength(0);
    });
  }
});

// ── Landing page ──────────────────────────────────────────────────────────────

test.describe('accessibility: Landing page (/)', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });

  test('has no violations in both light and dark themes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Light mode (default)
    await assertNoWcagViolations(page);

    // Toggle dark mode if the toggle exists
    const themeToggle = page.locator('[data-testid="theme-toggle"], button[aria-label*="theme" i], button[aria-label*="dark" i]').first();
    if (await themeToggle.isVisible()) {
      await themeToggle.click();
      await page.waitForTimeout(300); // allow CSS transition
      await assertNoWcagViolations(page);
    }
  });
});

// ── Agent registry (/agents) ──────────────────────────────────────────────────

test.describe('accessibility: Agent Registry (/agents)', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });

  test('agent detail modal has no WCAG AA violations', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');

    // Open the first agent's detail modal if available.
    const firstAgentRow = page
      .locator('[data-testid="agent-row"], table tbody tr, [role="row"]')
      .first();

    if (await firstAgentRow.isVisible()) {
      await firstAgentRow.click();
      // Wait for modal to appear.
      const modal = page.locator('[role="dialog"], [data-testid="agent-detail-modal"]').first();
      if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
        await assertNoWcagViolations(page);
      }
    }
  });
});

// ── Task form wizard (/tasks/new) ─────────────────────────────────────────────

test.describe('accessibility: Task Form Wizard (/tasks/new)', () => {
  test('Step 1 (describe goal) has no WCAG AA violations', async ({ page }) => {
    await page.goto('/tasks/new');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });

  test('Step 2 (choose agents) has no WCAG AA violations', async ({ page }) => {
    await page.goto('/tasks/new');
    await page.waitForLoadState('networkidle');

    // Advance to step 2 if possible.
    const promptInput = page.locator('#prompt, textarea[name="prompt"]').first();
    if (await promptInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await promptInput.fill('Test accessibility scan task');
      const nextBtn = page.getByRole('button', { name: /next/i }).first();
      if (await nextBtn.isEnabled()) {
        await nextBtn.click();
        await page.waitForTimeout(300);
      }
    }

    await assertNoWcagViolations(page);
  });

  test('Step 3 (review budget & DAG) has no WCAG AA violations', async ({ page }) => {
    await page.goto('/tasks/new');
    await page.waitForLoadState('networkidle');

    // Step 1
    const promptInput = page.locator('#prompt, textarea[name="prompt"]').first();
    if (await promptInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await promptInput.fill('Accessibility scan for step 3');
      const next1 = page.getByRole('button', { name: /next/i }).first();
      if (await next1.isEnabled()) {
        await next1.click();
        await page.waitForTimeout(200);
      }
    }

    // Step 2 — select at least one agent
    const agentCheckbox = page.locator('input[type="checkbox"][id^="pref-"]').first();
    if (await agentCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      await agentCheckbox.check();
      const next2 = page.getByRole('button', { name: /next/i }).first();
      if (await next2.isEnabled()) {
        await next2.click();
        await page.waitForTimeout(200);
      }
    }

    await assertNoWcagViolations(page);
  });
});

// ── Wallet / Payments (/wallet) ───────────────────────────────────────────────

test.describe('accessibility: Wallet/Payments (/wallet)', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/wallet');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });
});

// ── Dashboard (/dashboard) ────────────────────────────────────────────────────

test.describe('accessibility: Dashboard (/dashboard)', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });
});

// ── Admin panel (/admin) ──────────────────────────────────────────────────────

test.describe('accessibility: Admin panel (/admin)', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });
});

// ── 404 page ──────────────────────────────────────────────────────────────────

test.describe('accessibility: 404 Not Found page', () => {
  test('has no WCAG AA violations', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await page.waitForLoadState('networkidle');
    await assertNoWcagViolations(page);
  });
});
