# Freighter Wallet Setup and Testnet Funding

Estimated setup time: **10 minutes**. These steps create and fund a Stellar
testnet account for development. Testnet XLM has no monetary value. Never enter
your recovery phrase or secret key into ai-net, a website, or a support request.

> **Compatibility:** ai-net currently connects through the Freighter browser
> extension. The frontend uses Stellar testnet for balance reads and transaction
> signing. Freighter Mobile uses WalletConnect, which this frontend does not
> currently implement; the mobile app cannot connect to ai-net yet.

## 1. Install Freighter

Install Freighter from its official listing:

- [Chrome Web Store](https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk) for Chrome and Chromium browsers such as Brave.
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/freighter/) for Firefox.

Open the extension and follow its account-creation flow. Store the recovery
phrase offline in a secure place. Freighter keeps the signing key in the wallet;
ai-net only requests access to the public address and asks Freighter to sign
transactions.

> **Screenshot note:** The annotated references below are official publisher
> images from the Firefox listing, last updated in 2022. They are historical
> illustrations, not screenshots of the current Freighter interface. Check the
> live extension before relying on button names or layout; current annotated
> setup screenshots still need to be captured and reviewed.

![Legacy Freighter public-key access prompt](https://addons.mozilla.org/user-media/previews/full/268/268924.png?modified=1651009707)

**Figure 1, annotated:** The right-side wallet prompt is the authorization
step. Verify the requesting site and account before sharing the public key;
this example's `stellar-term.xyz` origin is not ai-net and must not be
authorized for ai-net.

## 2. Create a Testnet Account

In Freighter, create a new account and finish the wallet's recovery-phrase
backup. Do not import a mainnet wallet for a first test. Then open Freighter's
network selector/settings and choose **Testnet**. The exact labels may change
between Freighter releases.

ai-net's frontend signs with the Stellar testnet passphrase and reads account
balances from the testnet Horizon service. A wallet left on Mainnet will not
match the app's network.

## 3. Fund the Account

Copy the public address from Freighter. It starts with `G`; never copy or share
the secret key, which starts with `S`.

### Stellar Laboratory

Open the [Stellar Laboratory account creator](https://laboratory.stellar.org/#account-creator),
select **Test Network**, create a test account, and use its testnet funding
action. Confirm that the address being funded is the same public address shown
in Freighter. The Laboratory flow may change; Friendbot is the direct fallback.

### Stellar CLI

With the Stellar CLI installed, create a named testnet key and fund it through
Friendbot:

```bash
stellar keys generate wallet-testnet --network testnet
stellar keys fund wallet-testnet --network testnet
stellar keys address wallet-testnet
```

This creates a separate CLI-managed account; it does not add the account to
Freighter. For the Freighter setup below, create the account in Freighter and
fund its public address with Friendbot instead. Do not expose or paste a CLI
secret key into ai-net.

### Friendbot HTTP fallback

```bash
PUBLIC_KEY='G...'
curl --fail --show-error --get \
  --data-urlencode "addr=$PUBLIC_KEY" \
  https://friendbot.stellar.org/
```

Friendbot is a public testnet faucet. It may reject an already-funded or
invalid account; read the response and retry only after checking the address
and network.

> **No ai-net funding endpoint:** This repository does not implement
> `/api/fund`. Do not send a funding request to the ai-net backend. Use
> Friendbot, the Stellar CLI, or the Stellar Laboratory instead.

## 4. Connect Freighter to ai-net

Start the frontend using the repository's [developer setup guide](DEVELOPER_SETUP.md).
The default Vite address is `http://localhost:5173`; use the URL printed by the
dev server if it selects another port.

1. Open the app in the same desktop browser where Freighter is installed.
2. Open the Wallet page or follow the onboarding prompt and choose **Connect
   with Freighter**.
3. Review the site origin in Freighter's access prompt and approve only your
   local ai-net URL or the trusted ai-net deployment you intended to use.
4. Confirm the displayed public key matches the account you funded.

![Legacy Freighter transaction-signing prompt](https://addons.mozilla.org/user-media/previews/full/268/268925.png?modified=1651009707)

**Figure 2, annotated:** The wallet asks for explicit transaction approval.
The published example displays **MAINNET** and is an outdated visual reference,
not an instruction to use Mainnet. Confirm Freighter says **Testnet** before
approving any ai-net test transaction; reject requests you did not initiate.

## 5. Verify Network and Balance

- In Freighter, confirm the selected network is **Testnet** and copy the
  account's public address.
- In ai-net's Wallet page, confirm the connected address matches. The balance
  is read from Stellar testnet Horizon and may take a moment to refresh.
- If needed, inspect the account on
  [Stellar Expert Testnet](https://stellar.expert/explorer/testnet) by replacing
  `<PUBLIC_KEY>` with the address:
  `https://stellar.expert/explorer/testnet/account/<PUBLIC_KEY>`.
- A newly generated or unfunded account may show no balance or an account-not-
  found state until Friendbot succeeds.

## Mobile Wallets

Freighter Mobile connects to compatible dapps through WalletConnect. Install it
from the official [Freighter documentation](https://docs.freighter.app/mobile-walletconnect/installation.md)
and follow its [connection guide](https://docs.freighter.app/mobile-walletconnect/connecting.md).
This is general Freighter guidance only: ai-net currently integrates the
desktop browser extension API, not WalletConnect, so use a supported desktop
browser to connect to ai-net.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Freighter is not detected | Extension is missing, disabled, or the app was opened in another browser/profile | Install or enable the official extension, reload ai-net, and use the same browser profile. |
| Connection prompt does not appear | Popup was blocked or access was previously denied | Allow the wallet popup for the ai-net origin, reopen the Wallet page, and connect again. |
| Address shows no balance | Account is unfunded, Friendbot failed, or the wrong address was copied | Check the `G...` address, fund it on Testnet with Friendbot, then refresh the Wallet page. |
| Account or balance is missing | Freighter and ai-net are on different networks | Select Testnet in Freighter; ai-net currently reads balances from Testnet. |
| Transaction signing fails | Mainnet selected, wallet locked, or request rejected | Unlock Freighter, select Testnet, and retry only if you initiated the request. |
| Mobile wallet cannot connect | ai-net has no WalletConnect integration | Use Freighter's desktop browser extension; mobile support requires a future app change. |

## Sources

- [Freighter official browser-extension installation docs](https://docs.freighter.app/extension-freighter-api/installation.md)
- [Freighter official mobile installation docs](https://docs.freighter.app/mobile-walletconnect/installation.md)
- [Stellar CLI testnet funding in the Developer Setup Guide](DEVELOPER_SETUP.md#3-stellar-soroban-smart-contract-development)
- [Freighter Firefox listing and publisher screenshots](https://addons.mozilla.org/en-US/firefox/addon/freighter/)