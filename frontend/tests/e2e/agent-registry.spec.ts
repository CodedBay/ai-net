import { test, expect } from '@playwright/test';
import { AgentRegistryPage } from './pages/AgentRegistryPage';

test.describe('Agent Registry Browser', () => {
  test('navigates to /agents and renders registry cards', async ({ page }) => {
    const registry = new AgentRegistryPage(page);
    await registry.open();

    await expect(registry.cards()).toHaveCount(3);

    await expect(registry.card('agent-1')).toContainText('Research Specialist');
    await expect(registry.card('agent-2')).toContainText('Smart Contract Dev');
    await expect(registry.card('agent-3')).toContainText('QA Audit Agent');
  });
});
