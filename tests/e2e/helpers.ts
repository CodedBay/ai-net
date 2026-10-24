import supertest from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "../../backend/src/api/app";
import { getAgentDb, createAgentDb, closeAgentDb } from "../../backend/src/db/agents";
import { getTaskDb, createTaskDb, closeTaskDb } from "../../backend/src/db/tasks";
import { clearRegistry, registerAgent as registerInMemory, deregisterAgent as deregisterInMemory, getAgent as getInMemory } from "../../smart-contracts/src/registry/registry";

// ── On-Chain Smart Contract State Emulation ─────────────────────────────────

export interface OnChainAgentRecord {
  id: string;
  capability: string;
  priceStroops: number;
  endpoint: string;
  ownerAddress: string;
}

export interface OnChainErrorRecord {
  id: string;
  agentId: string;
  category: "budget" | "storage" | "auth" | "contract";
  errorCode: string;
  fixSuggestion: string;
  timestamp: string;
}

export const MOCK_CONTRACT_IDS = {
  REGISTRY: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  ERROR_RESOLVER: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2KM"
};

class SorobanContractEmulator {
  private registry = new Map<string, OnChainAgentRecord>();
  private errors = new Map<string, OnChainErrorRecord[]>();
  private initialized = false;

  initialize(): void {
    this.registry.clear();
    this.errors.clear();
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // Agent Registry Contract Methods
  registerAgent(record: OnChainAgentRecord): OnChainAgentRecord {
    if (this.registry.has(record.id)) {
      throw new Error("AlreadyExists: Agent already registered on-chain");
    }
    this.registry.set(record.id, record);
    // Sync to smart-contracts registry module
    registerInMemory({
      id: record.id,
      name: record.id,
      capability: record.capability,
      priceXLM: record.priceStroops / 10_000_000,
      stellarAddress: record.ownerAddress,
      reputationScore: 1
    });
    return record;
  }

  lookupAgent(agentId: string): OnChainAgentRecord | undefined {
    return this.registry.get(agentId);
  }

  lookupAgentsByCapability(capability: string): OnChainAgentRecord[] {
    return Array.from(this.registry.values()).filter(a => a.capability === capability);
  }

  deregisterAgent(agentId: string): boolean {
    const existed = this.registry.delete(agentId);
    if (existed) {
      deregisterInMemory(agentId);
    }
    return existed;
  }

  // Error Resolver Contract Methods
  recordError(agentId: string, category: OnChainErrorRecord["category"], errorCode: string, fixSuggestion: string): OnChainErrorRecord {
    const record: OnChainErrorRecord = {
      id: `err_${Math.random().toString(36).substring(2, 9)}`,
      agentId,
      category,
      errorCode,
      fixSuggestion,
      timestamp: new Date().toISOString()
    };
    const list = this.errors.get(agentId) ?? [];
    list.push(record);
    this.errors.set(agentId, list);
    return record;
  }

  getErrors(agentId: string): OnChainErrorRecord[] {
    return this.errors.get(agentId) ?? [];
  }

  clearErrorsForAgent(agentId: string): number {
    const list = this.errors.get(agentId);
    const count = list ? list.length : 0;
    this.errors.delete(agentId);
    return count;
  }

  clearAll(): void {
    this.registry.clear();
    this.errors.clear();
    clearRegistry();
  }
}

export const onChainContracts = new SorobanContractEmulator();

// ── Test Utility Functions ──────────────────────────────────────────────────

export interface E2EKeypair {
  publicKey(): string;
  sign(data: Buffer): Buffer;
}

export function createE2ETestKeypair(): E2EKeypair {
  try {
    const kp = Keypair.random();
    const getPub = (kp as any).publicKey;
    const pubKeyStr: string = typeof getPub === "function" ? getPub.call(kp) : String(getPub ?? "GCOORDINATOR");
    return {
      publicKey: () => pubKeyStr,
      sign: (data: Buffer) => {
        try {
          const signFn = (kp as any).sign;
          if (typeof signFn === "function") {
            const res = signFn.call(kp, data);
            return Buffer.isBuffer(res) ? res : data;
          }
          return data;
        } catch {
          return data;
        }
      }
    };
  } catch {
    return {
      publicKey: () => "GCOORDINATOR",
      sign: (data: Buffer) => data
    };
  }
}

export function signChallenge(keypair: E2EKeypair, challenge: string): string {
  try {
    const sigBuffer = keypair.sign(Buffer.from(challenge));
    return Buffer.isBuffer(sigBuffer) ? sigBuffer.toString("base64") : Buffer.from(challenge).toString("base64");
  } catch {
    return Buffer.from(challenge).toString("base64");
  }
}

export function createTestApp() {
  process.env.NODE_ENV = "test";
  process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  process.env.REGISTRY_CONTRACT_ID = MOCK_CONTRACT_IDS.REGISTRY;
  process.env.ERROR_RESOLVER_CONTRACT_ID = MOCK_CONTRACT_IDS.ERROR_RESOLVER;

  const appInstance = createApp();
  const request = supertest(appInstance.httpServer);

  return {
    app: appInstance,
    request,
    close: () => appInstance.close()
  };
}

export function resetTestDatabase(): void {
  try {
    const agentDb = getAgentDb(":memory:");
    agentDb.prepare("DELETE FROM agents").run();
  } catch (e) {
    // ignore
  }

  try {
    const taskDb = getTaskDb(":memory:");
    taskDb.prepare("DELETE FROM tasks").run();
  } catch (e) {
    // ignore
  }
}

// ── Stellar Testnet Helpers ─────────────────────────────────────────────────

const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Fund a testnet account via Friendbot.
 * Throws if Friendbot returns a non-2xx response.
 */
export async function fundTestnetAccount(address: string): Promise<void> {
  const resp = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
  if (!resp.ok) {
    const body = await resp.text().catch(() => String(resp.status));
    throw new Error(`Friendbot funding failed for ${address}: ${resp.status} — ${body}`);
  }
}

/**
 * Get the native XLM balance of a Stellar account from Horizon.
 * Returns 0 if the account does not exist yet.
 */
export async function getWalletBalance(address: string): Promise<number> {
  const resp = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`);
  if (resp.status === 404) return 0;
  if (!resp.ok) throw new Error(`Horizon account fetch failed for ${address}: ${resp.status}`);
  const data = await resp.json() as { balances?: Array<{ asset_type: string; balance: string }> };
  const native = data.balances?.find((b) => b.asset_type === "native");
  return native ? parseFloat(native.balance) : 0;
}

/**
 * Poll Horizon for payment transactions to the given address.
 * Returns true when at least one transaction is found, false on timeout.
 *
 * @param agentAddress  — Stellar address to check
 * @param retries       — number of polling attempts (default 10)
 * @param delayMs       — delay between attempts in ms (default 5000)
 */
export async function pollHorizonTransactions(
  agentAddress: string,
  retries = 10,
  delayMs = 5_000,
): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(
        `${HORIZON_URL}/transactions?account=${encodeURIComponent(agentAddress)}&order=desc&limit=10`,
      );
      if (resp.ok) {
        const data = await resp.json() as { _embedded?: { records?: unknown[] } };
        if ((data._embedded?.records?.length ?? 0) > 0) return true;
      }
    } catch {
      // network error — retry
    }
    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Verify that a payment of at least `minAmountXLM` was received by `agentAddress`.
 * Polls Horizon with retry logic for eventual consistency.
 *
 * @param agentAddress   — Stellar address of the receiving agent
 * @param minAmountXLM   — minimum expected XLM amount (tolerance applied by caller)
 * @param retries        — polling attempts
 * @param delayMs        — delay between attempts
 */
export async function verifyPaymentReceived(
  agentAddress: string,
  minAmountXLM: number,
  retries = 10,
  delayMs = 5_000,
): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(
        `${HORIZON_URL}/payments?account=${encodeURIComponent(agentAddress)}&order=desc&limit=20`,
      );
      if (resp.ok) {
        const data = await resp.json() as {
          _embedded?: {
            records?: Array<{ type: string; amount?: string; asset_type?: string }>;
          };
        };
        const payments = data._embedded?.records ?? [];
        const relevant = payments.filter(
          (p) =>
            p.type === "payment" &&
            p.asset_type === "native" &&
            parseFloat(p.amount ?? "0") >= minAmountXLM,
        );
        if (relevant.length > 0) return true;
      }
    } catch {
      // retry on network error
    }
    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}
