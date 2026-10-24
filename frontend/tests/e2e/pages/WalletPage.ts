import type { Locator, Page } from '@playwright/test'

export class WalletPage {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.goto('/wallet')
  }

  async connectWithFreighter() {
    await this.page.getByRole('button', { name: /connect with freighter/i }).click()
  }

  publicKey(): Locator {
    return this.page.locator('#wallet-pubkey-display')
  }
}