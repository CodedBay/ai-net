import type { Locator, Page } from '@playwright/test'

export class AgentRegistryPage {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.goto('/agents')
    await this.cards().first().waitFor()
  }

  cards(): Locator {
    return this.page.locator('[data-testid^="agent-row-"]')
  }

  card(agentId: string): Locator {
    return this.page.getByTestId(`agent-row-${agentId}`)
  }
}