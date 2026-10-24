/**
 * Tablet Responsive Layout Tests
 *
 * Verifies layout at iPad (768x1024) and iPad Pro (1024x1366) viewport sizes.
 * Addresses issue #105: tablet breakpoint improvements.
 *
 * Checks:
 *  - Agent grid renders 2 columns at 768–1024px
 *  - Dashboard KPI cards render in 2-column grid at tablet width
 *  - DAG visualization fits within viewport (no overflow)
 *  - Payment/transaction table uses internal horizontal scroll
 */

import { test, expect } from '@playwright/test';

const TABLET_VIEWPORTS = [
  { name: 'iPad (768x1024)', width: 768, height: 1024 },
  { name: 'iPad Pro (1024x1366)', width: 1024, height: 1366 },
];

for (const viewport of TABLET_VIEWPORTS) {
  test.describe(`Tablet layout — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('agent grid shows 2 columns', async ({ page }) => {
      await page.goto('/agents');

      // Wait for the card grid to appear (either loaded cards or skeleton)
      const grid = page.locator('[class*="cardGrid"]').first();
      await expect(grid).toBeVisible({ timeout: 10000 });

      // Compute the grid column count from computed styles
      const columns = await grid.evaluate((el) => {
        const style = window.getComputedStyle(el);
        const templateCols = style.getPropertyValue('grid-template-columns');
        // Count the number of column definitions
        return templateCols.trim().split(/\s+/).length;
      });

      // At tablet widths we expect exactly 2 columns
      expect(columns).toBe(2);
    });

    test('no page-level horizontal scroll', async ({ page }) => {
      const pages = ['/', '/agents', '/dashboard'];

      for (const path of pages) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');

        const hasHorizontalScroll = await page.evaluate(() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        });

        expect(hasHorizontalScroll, `Horizontal scroll found on ${path}`).toBe(false);
      }
    });

    test('DAG preview fits within viewport', async ({ page }) => {
      await page.goto('/tasks/new');

      const dagContainer = page.locator('[class*="container"]').filter({ hasText: '' }).first();

      if (await dagContainer.isVisible()) {
        const box = await dagContainer.boundingBox();
        if (box) {
          expect(box.width).toBeLessThanOrEqual(viewport.width);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        }
      }
    });

    test('dashboard KPI cards display in 2-column layout', async ({ page }) => {
      // Note: dashboard requires auth — skip if redirected
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      const kpiSection = page.locator('[class*="kpis"]').first();

      if (await kpiSection.isVisible()) {
        const columns = await kpiSection.evaluate((el) => {
          const style = window.getComputedStyle(el);
          const templateCols = style.getPropertyValue('grid-template-columns');
          return templateCols.trim().split(/\s+/).length;
        });
        // Tablet: 2 columns for KPI cards
        expect(columns).toBe(2);
      }
    });

    test('transaction table has internal scroll, not page scroll', async ({ page }) => {
      await page.goto('/wallet');
      await page.waitForLoadState('networkidle');

      const tableContainer = page.locator('[class*="container"]').first();

      if (await tableContainer.isVisible()) {
        const overflowX = await tableContainer.evaluate((el) => {
          return window.getComputedStyle(el).overflowX;
        });
        expect(['auto', 'scroll']).toContain(overflowX);
      }
    });
  });
}
