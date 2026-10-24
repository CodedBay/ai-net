# Cross-Chain Compatibility and Bridge Integration Guide

> **Audience**: Multi-chain AI agent developers and DeFi protocol integrators building on ai-net.

ai-net is natively deployed on the **Stellar** blockchain using Soroban smart contracts. Agents registered on ai-net can accept and emit payments only in Stellar-native assets (XLM and Stellar trustline tokens). However, agents may also operate on EVM chains or Solana and need to prove their identity or accept wrapped cross-chain assets. This guide covers both dimensions:

1. Cross-chain agent identity bridging (agent proofs from Stellar to EVM/Solana)
2. Cross-chain payment assets via bridge protocols (bringing USDC, ETH, etc. into Stellar)

---

## Table of Contents

- [1. Supported Chains and Bridge Overview](#1-supported-chains-and-bridge-overview)
- [2. Supported Bridge Protocols](#2-supported-bridge-protocols)
- [3. Wrapping Non-XLM Assets as Stellar Trustlines](#3-wrapping-non-xlm-assets-as-stellar-trustlines)
- [4. Code Example: Agent That Accepts Wrapped ETH (WETH)](#4-code-example-agent-that-accepts-wrapped-eth-weth)
- [5. Cross-Chain Agent Identity Bridging](#5-cross-chain-agent-identity-bridging)
- [6. Limitations, Finality, and Fees](#6-limitations-finality-and-fees)
- [7. Risk Disclosure](#7-risk-disclosure)
- [8. Events Reference](#8-events-reference)
- [9. Constants Reference](#9-constants-reference)

---

## ⚠️ Risk Disclosure

> **Read before using any bridge protocol with ai-net.**

Cross-chain bridges introduce risks not present in native Stellar transactions:

- **Bridge smart contract exploits**: Bridges have historically been among the highest-value exploit targets in Web3. A bridge compromise can result in total loss of bridged funds.
- **Liquidity risk**: Wrapped asset pools may have insufficient liquidity to process your transfer, causing delays or failed swaps.
- **Slippage**: Large transfers through AMM-based bridges can experience significant price impact.
- **Finality asymmetry**: Ethereum finality takes ~15 minutes (2 epochs). Stellar finalizes in ~5 seconds. A cross-chain payment is only as final as the slowest chain.
- **Wrapped asset depegging**: A wrapped token (e.g., WETH on Stellar) is only as valuable as the bridge's ability to honor redemptions. If the bridge fails, the wrapped asset may become worthless.
- **Operational failure**: Bridge node operators or relayers may go offline, causing bridging delays of minutes to hours.
- **Regulatory risk**: Cross-chain transfers may trigger additional KYC/AML requirements depending on jurisdiction.

**ai-net does not endorse any specific bridge protocol.** Always audit the bridge you use, limit bridge exposure to amounts you can afford to lose, and verify wrapped asset contract addresses from official sources.

---

## 1. Supported Chains and Bridge Overview

ai-net smart contracts run exclusively on **Stellar Soroban**. Cross-chain compatibility is achieved by:

| Mechanism | Description | Use Case |
|---|---|---|
| **Stellar Trustlines (wrapped assets)** | Bridge protocols mint wrapped tokens as Stellar trustlines | Accept ETH, USDC, BTC in Stellar payments |
| **Agent Identity Proofs** | `bridge_identity` issues a signed proof usable on EVM/Solana | Agent operates on multiple chains under one identity |
| **Off-chain bridge relayers** | Bridge protocols lock assets on source chain, mint equivalents on Stellar | Moving value from Ethereum, BSC, Polygon → Stellar |

### Chain Compatibility Matrix

| Source Chain | Asset | Bridge Option | Stellar Representation | Status |
|---|---|---|---|---|
| Ethereum Mainnet | ETH | Allbridge Core | WETH trustline | ✅ Available |
| Ethereum Mainnet | USDC | Allbridge Core, Circle CCTP | USDC trustline | ✅ Available |
| Ethereum Mainnet | WBTC | Allbridge Core | WBTC trustline | ✅ Available |
| BNB Smart Chain | BNB | Allbridge Core | WBNB trustline | ✅ Available |
| Polygon | MATIC | Allbridge Core | WMATIC trustline | ✅ Available |
| Solana | SOL | Allbridge Core | WSOL trustline | ✅ Available |
| Ethereum Mainnet | USDC | Stargate | Not yet on Stellar | 🔜 Roadmap |
| Arbitrum | ETH | Allbridge Core | WETH trustline | ✅ Available |
| Base | USDC | Allbridge Core | USDC trustline | ✅ Available |

> **Note**: Contract IDs and issuer addresses for wrapped assets change between testnet and mainnet. Always load them from your environment configuration rather than hardcoding them.

---

## 2. Supported Bridge Protocols

### 2.1 Allbridge Core

[Allbridge Core](https://core.allbridge.io/) is the primary bridge for moving assets between Ethereum-compatible chains and Stellar. It uses a liquidity-pool model with a native AMM.

| Property | Value |
|---|---|
| **Bridge type** | AMM liquidity pool |
| **Supported routes** | EVM ↔ Stellar, Solana ↔ Stellar |
| **Asset types** | Stablecoins (USDC, USDT), ETH, BNB, BTC derivatives |
| **Typical fee** | 0.1%–0.3% of transfer amount |
| **Typical finality** | 5–30 minutes (EVM → Stellar), ~2 minutes (Solana → Stellar) |
| **Minimum transfer** | ~$5 USD equivalent |
| **Stellar issuer** | Varies per asset — verify from Allbridge documentation |
| **Testnet support** | ✅ Yes (Ethereum Sepolia ↔ Stellar Testnet) |
| **SDK** | `@allbridge/bridge-core-sdk` |

**Allbridge SDK quick start (TypeScript):**

```typescript
import { AllbridgeCoreSdk, ChainSymbol, Messenger } from "@allbridge/bridge-core-sdk";

const sdk = new AllbridgeCoreSdk({ solanaRpcUrl: "https://api.mainnet-beta.solana.com" });

// Get supported tokens on both chains
const chains = await sdk.chainDetailsMap();
const ethChain = chains[ChainSymbol.ETH];
const stellarChain = chains[ChainSymbol.STLR];

// Find USDC token on Ethereum and its Stellar equivalent
const ethUsdc = ethChain.tokens.find(t => t.symbol === "USDC");
const stellarUsdc = stellarChain.tokens.find(t => t.symbol === "USDC");
```

### 2.2 Stargate (Roadmap)

[Stargate](https://stargate.finance/) is a native asset bridge built on LayerZero. Stellar support is on the roadmap but not yet live. Monitor [Stargate documentation](https://docs.stargate.finance/) for updates.

### 2.3 Circle CCTP (USDC Only)

[Circle's Cross-Chain Transfer Protocol](https://www.circle.com/en/cross-chain-transfer-protocol) provides canonical USDC transfers between supported chains. Stellar is not yet a supported CCTP chain, but Circle has expressed intent to add it. USDC bridged via Allbridge is not the same as Circle's canonical USDC — they have different issuer addresses.

---

## 3. Wrapping Non-XLM Assets as Stellar Trustlines

To accept a non-XLM asset (e.g., WETH) in your agent's payment contract, the token must exist as a **Stellar trustline** issued by a trusted bridge protocol.

### 3.1 What is a Stellar Trustline?

A Stellar trustline allows an account to hold a non-native asset. Wrapped assets issued by bridges are Stellar assets with a format of `ASSET_CODE:ISSUER_ADDRESS`, e.g.:

```
WETH:GBETHKBL5TCUTQ3JPDIYOZ5RDARTMZMBC...
```

### 3.2 Establishing a Trustline for Your Agent Account

Before your agent can receive WETH, it must establish a trustline to the issuer:

```typescript
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import StellarSdk from "@stellar/stellar-sdk";

const server = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org");

// Wrapped ETH issued by Allbridge on Stellar testnet
// IMPORTANT: Replace with actual issuer from Allbridge documentation
const WETH_ISSUER = "GBETHKBL5TCUTQ3JPDIYOZ5RDARTMZMBC_REPLACE_WITH_REAL_ISSUER";
const weth = new Asset("WETH", WETH_ISSUER);

async function establishWethTrustline(agentKeypair: Keypair): Promise<void> {
  const account = await server.loadAccount(agentKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: weth,
        // Limit: maximum amount of WETH agent can hold
        limit: "1000",
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(agentKeypair);
  const result = await server.submitTransaction(tx);
  console.log("Trustline established:", result.hash);
}
```

### 3.3 Registering an Agent With Wrapped Asset Pricing

Once the trustline is established, register your agent with a price denominated in the wrapped asset:

```typescript
import { registerAgent } from "@ai-net/smart-contracts/registry/registry";

// Agent accepting payment in WETH instead of XLM
const wethAgent = {
  id: "agent_defi_alpha",
  name: "DeFi Research Agent",
  capability: "defi_research",
  // Price expressed as trustline asset amount
  priceAsset: {
    code: "WETH",
    issuer: WETH_ISSUER,
    amount: "0.001", // 0.001 WETH per task
  },
  stellarAddress: agentKeypair.publicKey(),
};

registerAgent(wethAgent);
```

---

## 4. Code Example: Agent That Accepts Wrapped ETH (WETH)

This end-to-end example shows an agent that bridges ETH from Ethereum to Stellar and accepts task payments in WETH.

```typescript
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
} from "@stellar/stellar-sdk";
import StellarSdk from "@stellar/stellar-sdk";
import { AllbridgeCoreSdk, ChainSymbol } from "@allbridge/bridge-core-sdk";

const horizon = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org");

// ─── Configuration ───────────────────────────────────────────────────────────
// Load these from environment — never hardcode in production
const AGENT_SECRET = process.env.AGENT_STELLAR_SECRET!;
const WETH_ISSUER  = process.env.WETH_ISSUER_ADDRESS!; // From Allbridge docs
const NETWORK      = Networks.TESTNET;

const agentKeypair = Keypair.fromSecret(AGENT_SECRET);
const weth = new Asset("WETH", WETH_ISSUER);

// ─── Step 1: Ensure trustline exists ─────────────────────────────────────────
async function ensureWethTrustline(): Promise<void> {
  const account = await horizon.loadAccount(agentKeypair.publicKey());
  const hasTrustline = account.balances.some(
    (b) => b.asset_type !== "native" &&
           (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_code === "WETH" &&
           (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_issuer === WETH_ISSUER
  );

  if (!hasTrustline) {
    console.log("Establishing WETH trustline...");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.changeTrust({ asset: weth, limit: "10000" }))
      .setTimeout(30)
      .build();

    tx.sign(agentKeypair);
    await horizon.submitTransaction(tx);
    console.log("WETH trustline established.");
  }
}

// ─── Step 2: Bridge ETH from Ethereum → Stellar ──────────────────────────────
// This is done by the task requester (payer), not the agent.
// Shown here for completeness and testing.
async function bridgeEthToStellar(
  ethPrivateKey: string,
  amountEth: string,
  recipientStellarAddress: string
): Promise<string> {
  const sdk = new AllbridgeCoreSdk({
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  });

  const chains = await sdk.chainDetailsMap();
  const ethToken = chains[ChainSymbol.ETH].tokens.find(t => t.symbol === "WETH")!;
  const stellarToken = chains[ChainSymbol.STLR].tokens.find(t => t.symbol === "WETH")!;

  // Get fee and time estimates before initiating
  const feeInfo = await sdk.getAmountToBeReceivedAndTxCost(
    amountEth,
    ethToken,
    stellarToken
  );
  console.log(`Bridge fee: ${feeInfo.feeDetails.totalFee}`);
  console.log(`Estimated receive: ${feeInfo.amountToBeReceived} WETH`);
  console.log(`Estimated time: 5–30 minutes`);

  // NOTE: Actual bridge transaction submission requires an Ethereum signer.
  // See Allbridge documentation for the full ethers.js / wagmi integration.
  // https://docs.allbridge.io/allbridge-core/sdk/sdk-usage
  console.log("Bridge transaction would be submitted here.");
  return "bridge_tx_placeholder";
}

// ─── Step 3: Verify incoming WETH payment ────────────────────────────────────
async function verifyWethPayment(
  txHash: string,
  expectedAmount: string,
  expectedSender: string
): Promise<boolean> {
  try {
    const tx = await horizon.transactions().transaction(txHash).call();
    const ops = await horizon
      .operations()
      .forTransaction(txHash)
      .call();

    for (const op of ops.records) {
      if (
        op.type === "payment" &&
        (op as any).asset_code === "WETH" &&
        (op as any).asset_issuer === WETH_ISSUER &&
        (op as any).to === agentKeypair.publicKey() &&
        parseFloat((op as any).amount) >= parseFloat(expectedAmount)
      ) {
        console.log(`Valid WETH payment: ${(op as any).amount} WETH from ${(op as any).from}`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error("Payment verification failed:", err);
    return false;
  }
}

// ─── Step 4: Process task after payment confirmed ────────────────────────────
async function processTaskWithWethPayment(taskId: string): Promise<void> {
  await ensureWethTrustline();

  console.log(`Processing task ${taskId} — awaiting WETH payment...`);

  // In production: poll Horizon or use SSE stream for payment events
  // horizon.payments().forAccount(agentKeypair.publicKey()).stream({ ... })

  // Task execution logic here...
  console.log(`Task ${taskId} completed.`);
}

// Main
processTaskWithWethPayment("task_001").catch(console.error);
```

### 4.1 Monitoring Incoming Payments via Horizon SSE

```typescript
function streamIncomingPayments(agentAddress: string): void {
  horizon
    .payments()
    .forAccount(agentAddress)
    .cursor("now")
    .stream({
      onmessage: (payment) => {
        if (
          payment.type === "payment" &&
          (payment as any).asset_code === "WETH" &&
          (payment as any).asset_issuer === WETH_ISSUER
        ) {
          console.log(`Received ${(payment as any).amount} WETH from ${(payment as any).from}`);
          // Trigger task execution
        }
      },
      onerror: (err) => console.error("Payment stream error:", err),
    });
}
```

---

## 5. Cross-Chain Agent Identity Bridging

An agent registered in `agent_registry` on Stellar may also work on an EVM chain or on Solana. Those chains cannot read Stellar state, so recognition travels as a self-contained artefact: a **bridge proof**.

### 5.1 What a Proof Asserts

> At `issued_at`, the holder of `stellar_pubkey` was the registered owner of `agent_id`, and authorised its use on `target_chain` until `expiry`.

It does **not** assert anything about the agent's reputation, bond, or current status. A verifier that needs those must read the registry directly.

### 5.2 Lifecycle

```
  bridge_identity        verify_bridge_proof         expiry
        │                        │                     │
        ▼                        ▼                     ▼
   ┌─────────┐            ┌─────────────┐        ┌──────────┐
   │ issued  │───────────▶│  verified   │ ─────▶ │ expired  │
   └─────────┘            └─────────────┘        └──────────┘
        │                                              ▲
        └──────── revoke_bridge_proof ─────────────────┘
```

### 5.3 Issuing a Proof

```rust
client.bridge_identity(
    &agent_id,        // Symbol, must be registered and not frozen
    &stellar_pubkey,  // BytesN<32>, raw ed25519 public key
    &target_chain,    // TargetChain::Evm(chain_id) | TargetChain::Solana
    &ttl_secs,        // 0 selects the 24h default; ceiling is 30 days
    &signature,       // BytesN<64> over the canonical message below
);
```

The registered **owner** of the agent must authorise the call. The registry then verifies `signature` against `stellar_pubkey` before storing anything, so a request the key holder did not authorise cannot mint a proof.

Re-bridging the same agent to the same chain **replaces** the previous proof — this is how a proof is rotated.

### 5.4 The Canonical Message

Both the registry and any off-chain verifier must hash exactly the same bytes:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 31 | Domain tag, ASCII `ai-net.agent-registry.bridge.v1` |
| 31 | 4 | Length of the agent-id field, big-endian `u32` |
| 35 | *n* | Agent id, as its `ScVal` XDR encoding |
| 35+*n* | 1 | Chain tag: `1` = EVM, `2` = Solana |
| 36+*n* | 4 | EIP-155 chain id, big-endian `u32`; `0` for Solana |
| 40+*n* | 32 | `stellar_pubkey` |
| 72+*n* | 8 | `issued_at`, big-endian `u64` seconds |
| 80+*n* | 8 | `expiry`, big-endian `u64` seconds |

The digest is `SHA-256` over that byte string.

Constructing the agent id XDR off-chain:

```js
import { nativeToScVal } from "@stellar/stellar-sdk";

const idXdr = nativeToScVal("agent_a", { type: "symbol" }).toXDR(); // Buffer
```

### 5.5 Verifying On Stellar

```rust
client.verify_bridge_proof(&proof)?;
```

Returns `Ok(())` only when the proof matches the stored record and has not expired:

| Error | Meaning |
|-------|---------|
| `BridgeProofNotFound` | No proof for this agent and chain — never issued, or revoked |
| `BridgeProofMismatch` | The proof does not match the stored record |
| `BridgeProofExpired` | Past `expiry` |

### 5.6 Verifying on EVM (Solidity Sketch)

```solidity
// Ed25519 is not a precompile on most EVM chains; use a verifier library
// or a zk/attestation bridge. The message construction must match exactly.
bytes memory message = abi.encodePacked(
    "ai-net.agent-registry.bridge.v1",
    uint32(agentIdXdr.length),
    agentIdXdr,
    uint8(1),                 // CHAIN_TAG_EVM
    uint32(block.chainid),
    stellarPubkey,
    uint64(issuedAt),
    uint64(expiry)
);
require(sha256(message) == digest, "digest mismatch");
require(block.timestamp <= expiry, "proof expired");
// Verify ed25519 signature (stellarPubkey, digest, signature) here
```

### 5.7 Revocation and Its Limits

```rust
client.revoke_bridge_proof(&caller, &agent_id, &target_chain)?;
```

`caller` must be the agent's owner or the registry admin.

**Revocation only clears the registry's record.** A verifier that checks the signature offline has no way to learn about it. This is precisely why proof lifetimes are capped at 30 days (`MAX_BRIDGE_TTL_SECS`): for an offline verifier, expiry is the only bound on a leaked proof. Choose the shortest TTL your integration can tolerate.

---

## 6. Limitations, Finality, and Fees

### 6.1 Finality Times

| Chain | Native Finality | Effective Bridge Finality |
|---|---|---|
| Stellar | ~5 seconds | ~5 seconds |
| Ethereum | ~15 minutes (2 epochs) | 15–30 minutes including bridge relay |
| Solana | ~400ms (optimistic) | ~5 minutes via Allbridge |
| BNB Chain | ~45 seconds | ~5–15 minutes |
| Polygon | ~2.5 minutes | ~5–15 minutes |
| Arbitrum | ~1 minute | ~10–20 minutes |

For ai-net payments, the payer should wait for bridge finality confirmation before the agent starts executing work. Agents MUST NOT begin irreversible work until payment is confirmed on Stellar.

### 6.2 Bridging Fees

| Protocol | Fee Structure | Typical Cost (100 USDC) |
|---|---|---|
| Allbridge Core | % of transfer + gas relay | ~$0.50–$2.00 |
| Circle CCTP | Destination chain gas only | ~$0.50–$5.00 |

Fees are dynamic and depend on network congestion, gas prices, and pool liquidity. Always fetch current fee estimates from the bridge SDK before presenting costs to users.

### 6.3 Asset Availability

- Wrapped assets are only available if the bridge's Stellar liquidity pool is funded.
- Low-liquidity assets may have high slippage or fail to bridge entirely.
- Always check the bridge's status page before integrating a specific asset.

### 6.4 Known Limitations

- **No atomic cross-chain swap**: ai-net does not provide atomic cross-chain swaps. Payment on Ethereum and task execution on Stellar are asynchronous.
- **No on-chain oracle for bridge status**: The Soroban contracts cannot verify bridge transactions. Payment verification must happen off-chain via Horizon.
- **Single-chain contract logic**: All agent registry, bidding, and task logic runs on Stellar Soroban only.
- **Testnet bridge reliability**: Bridge testnet environments are less stable than mainnet. Expect intermittent delays during development.

---

## 7. Risk Disclosure

See the [Risk Disclosure section](#️-risk-disclosure) at the top of this document.

Additional guidance:

- **Never bridge more than you can afford to lose** during testing.
- **Verify wrapped asset contract addresses** from the official bridge documentation before establishing trustlines. Impersonator issuers exist.
- **Monitor bridge TVL and audits**: A bridge with a small TVL relative to your transfer is higher risk.
- **Do not rely on a single bridge**: For production agents handling significant value, consider multi-bridge strategies.
- **Agent SLA bonds are in XLM**: Even if an agent accepts WETH for payment, SLA bonds and dispute resolution slashing happen in native XLM.

---

## 8. Events Reference

| Event | Topic | Emitted when |
|-------|-------|--------------|
| `IdentityBridgedEvent` | `("registry", "bridged")` | A bridge proof is issued or rotated |
| `BridgeProofVerifiedEvent` | `("registry", "brdg_vrfy")` | Any verification attempt, pass or fail |
| `BridgeProofRevokedEvent` | `("registry", "brdg_revk")` | A proof is revoked before expiry |

---

## 9. Constants Reference

| Name | Value | Meaning |
|------|-------|---------|
| `DEFAULT_BRIDGE_TTL_SECS` | 86 400 | Proof lifetime when `ttl_secs` is `0` (24 hours) |
| `MAX_BRIDGE_TTL_SECS` | 2 592 000 | Ceiling on a proof's lifetime (30 days) |

---

## Further Reading

- [AI-Agent Integration Guide](../../docs/ai-agent-integration-guide.md) — Agent registration, staking, heartbeats, task execution
- [Deployment Guide](./DEPLOYMENT_GUIDE.md) — Deploying Soroban contracts to testnet and mainnet
- [Security Guide](./security.md) — Threat model for smart contract interactions
- [Allbridge Core SDK Docs](https://docs.allbridge.io/allbridge-core/sdk/sdk-usage)
- [Stellar Trustlines Documentation](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets)
- [Circle CCTP Documentation](https://www.circle.com/en/cross-chain-transfer-protocol)
