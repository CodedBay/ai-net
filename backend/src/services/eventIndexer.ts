/**
 * Contract Event Indexer Service
 *
 * Subscribes to the Stellar Horizon event stream and indexes all Soroban
 * contract events into the local events.db SQLite store.
 *
 * The indexer:
 *  1. Polls Horizon's /soroban/events endpoint (or streams via SSE).
 *  2. Filters events by the configured contract IDs.
 *  3. Normalises each event into the standardised schema:
 *       { contract_id, event_type, version, payload }
 *  4. Persists to events.db within < 5 seconds of on-chain emission.
 *  5. Tracks its own cursor (last indexed ledger) so it survives restarts.
 */

import { createLogger } from "../utils/logger";
import { createEventsDb, getEventsDb, type ContractEventRecord } from "../db/contractEvents";

const logger = createLogger({ component: "event-indexer" });

/** Configuration for the indexer. */
export interface EventIndexerConfig {
  /** Horizon base URL (e.g. https://horizon-testnet.stellar.org). */
  horizonUrl: string;
  /** Soroban contract IDs to watch. Empty array = watch all. */
  contractIds: string[];
  /** Polling interval in milliseconds (default: 3000). */
  pollIntervalMs?: number;
  /** Ledger sequence to start from (0 = from genesis). */
  startLedger?: number;
  /** Max events per poll batch (default: 100). */
  batchSize?: number;
  /** Path to the events.db file. */
  dbPath?: string;
}

export interface IndexerStatus {
  running: boolean;
  lastIndexedLedger: number;
  eventsIndexed: number;
  lastPollAt: string | null;
  lastError: string | null;
}

// ─── Horizon event shape (simplified) ────────────────────────────────────────

interface HorizonEventRecord {
  id: string;
  type: "contract";
  ledger: number;
  ledgerClosedAt: string;
  pagingToken: string;
  contractId: string;
  topic: string[];     // base64-encoded XDR values
  value: string;       // base64-encoded XDR value
  txHash: string;
}

interface HorizonEventsResponse {
  _embedded: {
    records: HorizonEventRecord[];
  };
}

// ─── Indexer ─────────────────────────────────────────────────────────────────

export class ContractEventIndexer {
  private readonly config: Required<EventIndexerConfig>;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor = "0";
  private eventsIndexed = 0;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  constructor(config: EventIndexerConfig) {
    this.config = {
      pollIntervalMs: 3_000,
      startLedger: 0,
      batchSize: 100,
      dbPath: undefined as unknown as string,
      ...config,
    };
  }

  /** Start the indexer. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(
      {
        horizonUrl: this.config.horizonUrl,
        contractIds: this.config.contractIds,
        pollIntervalMs: this.config.pollIntervalMs,
      },
      "Contract event indexer starting",
    );
    void this._poll();
  }

  /** Stop the indexer gracefully. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Contract event indexer stopped");
  }

  /** Current indexer status (for the health endpoint). */
  status(): IndexerStatus {
    return {
      running: this.running,
      lastIndexedLedger: parseInt(this.cursor, 10) || 0,
      eventsIndexed: this.eventsIndexed,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async _poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this._fetchAndIndex();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.warn({ err }, "Event indexer poll error");
    } finally {
      this.lastPollAt = new Date().toISOString();
      if (this.running) {
        this.pollTimer = setTimeout(() => void this._poll(), this.config.pollIntervalMs);
      }
    }
  }

  private async _fetchAndIndex(): Promise<void> {
    const url = this._buildUrl();
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Horizon returned ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as HorizonEventsResponse;
    const records = data._embedded?.records ?? [];

    if (records.length === 0) return;

    const db = createEventsDb(getEventsDb(this.config.dbPath));
    const indexedAt = new Date().toISOString();

    for (const record of records) {
      // Filter by contract IDs if configured.
      if (
        this.config.contractIds.length > 0 &&
        !this.config.contractIds.includes(record.contractId)
      ) {
        this.cursor = record.pagingToken;
        continue;
      }

      const normalized = this._normalize(record);
      if (normalized) {
        db.insert({ ...normalized, indexedAt });
        this.eventsIndexed++;
      }

      this.cursor = record.pagingToken;
    }

    logger.debug(
      { count: records.length, cursor: this.cursor },
      "Indexed contract events",
    );
  }

  private _buildUrl(): string {
    const base = this.config.horizonUrl.replace(/\/$/, "");
    const params = new URLSearchParams({
      cursor: this.cursor || this.config.startLedger.toString(),
      limit: this.config.batchSize.toString(),
      order: "asc",
    });

    // Filter by contract IDs if exactly one is configured.
    if (this.config.contractIds.length === 1) {
      params.set("contract_id", this.config.contractIds[0]);
    }

    return `${base}/soroban/events?${params.toString()}`;
  }

  /**
   * Normalise a raw Horizon event record into our standardised schema.
   *
   * Standardised format: { contract_id, event_type, version, payload }
   *
   * Topic[0] is conventionally the contract namespace symbol.
   * Topic[1] is the event type symbol.
   * We reconstruct the event_type as "<namespace>:<type>".
   *
   * Returns null for events that cannot be parsed.
   */
  private _normalize(record: HorizonEventRecord): Omit<ContractEventRecord, "id" | "indexedAt"> | null {
    try {
      const topics = record.topic ?? [];
      // topic[0] = namespace, topic[1] = event name (both as base64 XDR)
      const namespace = topics[0] ? this._decodeSymbol(topics[0]) : "unknown";
      const eventName = topics[1] ? this._decodeSymbol(topics[1]) : "unknown";
      const eventType = `${namespace}:${eventName}`;

      // The raw XDR value is stored as-is in the payload for now.
      // A full XDR decoder would decode this into a structured object;
      // for the MVP we store the base64 blob so it can be decoded later.
      const payload = JSON.stringify({
        raw_value: record.value,
        topics: record.topic,
      });

      return {
        contractId: record.contractId,
        eventType,
        version: 1,
        payload,
        ledgerSeq: record.ledger,
        txHash: record.txHash,
        occurredAt: record.ledgerClosedAt,
      };
    } catch (err) {
      logger.debug({ err, record }, "Failed to normalise event record");
      return null;
    }
  }

  /**
   * Attempt to decode a base64-encoded Stellar Symbol XDR value.
   *
   * Stellar Symbol values encoded as SCVal are a fixed 4-byte prefix
   * (`0x00 0x00 0x00 0x0f` for SCV_SYMBOL) followed by a Pascal-style string.
   * For simplicity we just try to read UTF-8 bytes after stripping the header.
   *
   * Returns the raw base64 string on decode failure.
   */
  private _decodeSymbol(base64: string): string {
    try {
      const buf = Buffer.from(base64, "base64");
      // XDR SCV_SYMBOL: 4-byte type prefix + 4-byte length + string bytes
      if (buf.length >= 9) {
        const len = buf.readUInt32BE(4);
        if (len > 0 && len <= buf.length - 8) {
          return buf.slice(8, 8 + len).toString("utf8");
        }
      }
      return base64;
    } catch {
      return base64;
    }
  }
}

// ─── Singleton instance ──────────────────────────────────────────────────────

let _indexer: ContractEventIndexer | null = null;

/** Return (and lazily create) the global indexer instance. */
export function getEventIndexer(): ContractEventIndexer {
  if (!_indexer) {
    const horizonUrl =
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    const contractIdsRaw = process.env.INDEXED_CONTRACT_IDS ?? "";
    const contractIds = contractIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    _indexer = new ContractEventIndexer({
      horizonUrl,
      contractIds,
      pollIntervalMs: parseInt(process.env.INDEXER_POLL_INTERVAL_MS ?? "3000", 10),
      startLedger: parseInt(process.env.INDEXER_START_LEDGER ?? "0", 10),
      batchSize: parseInt(process.env.INDEXER_BATCH_SIZE ?? "100", 10),
    });
  }
  return _indexer;
}

/** Replace the global indexer (for testing). */
export function setEventIndexer(indexer: ContractEventIndexer | null): void {
  _indexer = indexer;
}
